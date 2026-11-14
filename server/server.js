'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3001);
const MAX_BODY = 1024;
const MAX_CMD_LEN = 32;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const MiB = 1024 * 1024;
const startedAt = Date.now();
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// Fixed, loopback-only targets; no request can supply a URL to this monitor.
const WATCH_INTERVAL_MS = 60_000;
const WATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
const WATCH_MAX_SAMPLES = 24 * 60;
const WATCH_TIMEOUT_MS = 5000;
const WATCH_FILE = process.env.SIGNAL_WATCH_FILE || '/var/lib/beta/signal-watch.json';
const WATCH_TARGETS = [
  { id: 'site', name: 'Website origin', url: 'http://127.0.0.1:8081/', method: 'HEAD' },
  { id: 'api', name: 'Beta API', url: 'http://127.0.0.1:3001/api/health', method: 'GET' },
];
const watchHistory = new Map(WATCH_TARGETS.map((target) => [target.id, []]));
let watchEvents = [];
let watchRunning = false;

function restoreWatchHistory() {
  try {
    const saved = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'));
    for (const target of WATCH_TARGETS) {
      const raw = saved && saved.history && saved.history[target.id];
      if (!Array.isArray(raw)) continue;
      const valid = raw.filter((sample) => sample && Number.isFinite(Date.parse(sample.at)) && typeof sample.ok === 'boolean')
        .map((sample) => ({ at: new Date(sample.at).toISOString(), ok: sample.ok, latencyMs: Number.isFinite(Number(sample.latencyMs)) ? Math.max(0, Math.round(Number(sample.latencyMs))) : null }));
      watchHistory.set(target.id, valid.slice(-WATCH_MAX_SAMPLES));
    }
    const known = new Map(WATCH_TARGETS.map((target) => [target.id, target.name]));
    watchEvents = (Array.isArray(saved && saved.events) ? saved.events : []).filter((event) => event && known.has(event.serviceId) && Number.isFinite(Date.parse(event.at)) && (event.state === 'outage' || event.state === 'recovered'))
      .map((event) => ({ at: new Date(event.at).toISOString(), serviceId: event.serviceId, serviceName: known.get(event.serviceId), state: event.state })).slice(-100);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Signal Watch history could not be read:', error.code || 'invalid data');
  }
}
restoreWatchHistory();

function saveWatchHistory() {
  const data = { version: 1, savedAt: new Date().toISOString(), history: Object.fromEntries(watchHistory), events: watchEvents };
  const temp = WATCH_FILE + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(temp, WATCH_FILE);
  } catch (error) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
    console.error('Signal Watch history could not be saved:', error.code || 'write error');
  }
}

async function probeTarget(target) {
  const began = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WATCH_TIMEOUT_MS);
  let ok = false;
  try {
    const response = await fetch(target.url, { method: target.method, cache: 'no-store', redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'SignalWatch/1.0' } });
    if (target.id === 'api') {
      const body = await response.json().catch(() => null);
      ok = response.ok && body && body.status === 'ok';
    } else {
      ok = response.ok;
      if (response.body) await response.body.cancel().catch(() => {});
    }
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  const sample = { at: new Date().toISOString(), ok: Boolean(ok), latencyMs: Math.max(0, Date.now() - began) };
  const samples = watchHistory.get(target.id);
  const previous = samples[samples.length - 1];
  samples.push(sample);
  if (samples.length > WATCH_MAX_SAMPLES) samples.splice(0, samples.length - WATCH_MAX_SAMPLES);
  if (previous && previous.ok !== sample.ok) {
    watchEvents.push({ at: sample.at, serviceId: target.id, serviceName: target.name, state: sample.ok ? 'recovered' : 'outage' });
    if (watchEvents.length > 100) watchEvents.splice(0, watchEvents.length - 100);
  }
}
async function runWatchChecks() {
  if (watchRunning) return;
  watchRunning = true;
  try { await Promise.all(WATCH_TARGETS.map(probeTarget)); saveWatchHistory(); }
  finally { watchRunning = false; }
}
function watchStatus() {
  const now = Date.now();
  const cutoff = now - WATCH_WINDOW_MS;
  const services = WATCH_TARGETS.map((target) => {
    const samples = watchHistory.get(target.id).filter((sample) => Date.parse(sample.at) >= cutoff);
    const latest = samples[samples.length - 1] || null;
    const successful = samples.filter((sample) => sample.ok);
    const uptimePercent = samples.length ? Math.round(successful.length / samples.length * 1000) / 10 : null;
    return { id: target.id, name: target.name, status: !latest ? 'checking' : (latest.ok ? 'operational' : 'outage'), uptimePercent, latestLatencyMs: latest ? latest.latencyMs : null, checkedAt: latest ? latest.at : null, history: samples.map((sample) => ({ at: sample.at, ok: sample.ok, latencyMs: sample.latencyMs })) };
  });
  const events = watchEvents.filter((event) => Date.parse(event.at) >= cutoff).slice().reverse();
  return { generatedAt: new Date(now).toISOString(), intervalSeconds: WATCH_INTERVAL_MS / 1000, windowHours: 24, services, events };
}

const buckets = new Map();
setInterval(() => { const now = Date.now(); for (const [key, bucket] of buckets) if (now - bucket.start > RATE_WINDOW_MS) buckets.delete(key); }, RATE_WINDOW_MS).unref();
function clientKey(req) { return req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'; }
function overLimit(key) { const now = Date.now(); const bucket = buckets.get(key); if (!bucket || now - bucket.start > RATE_WINDOW_MS) { buckets.set(key, { start: now, count: 1 }); return false; } bucket.count += 1; return bucket.count > RATE_MAX; }
function runBinary(bin, args) { return new Promise((resolve) => { execFile(bin, args, { timeout: 2000, maxBuffer: 16 * 1024, env: { LANG: 'C', PATH: '/usr/bin:/bin' } }, (err, stdout) => { if (err) return resolve('command failed'); resolve(stdout.trim()); }); }); }
const QUOTES = ['Any sufficiently advanced configuration is indistinguishable from magic.', 'It works on my machine.', 'There are two hard things in computing: cache invalidation and naming things.', 'Trust, but verify the firewall rules.'];
const COMMANDS = {
  help: { desc: 'list available commands', run: () => Object.entries(COMMANDS).map(([name, command]) => name.padEnd(9) + command.desc).join('\n') },
  about: { desc: 'what this site is', run: () => ['nicholas-oswald.com / beta', 'node.js API behind caddy, served through a cloudflare tunnel', 'type "help" for commands'].join('\n') },
  time: { desc: 'server time (UTC)', run: () => new Date().toISOString() },
  uptime: { desc: 'how long the host has been up', run: () => runBinary('/usr/bin/uptime', ['-p']) },
  load: { desc: '1, 5 and 15 minute load averages', run: () => os.loadavg().map((n) => n.toFixed(2)).join('  ') },
  mem: { desc: 'memory in use', run: () => { const total = os.totalmem(); const used = total - os.freemem(); return Math.round(used / MiB) + ' MiB used of ' + Math.round(total / MiB) + ' MiB'; } },
  disk: { desc: 'root filesystem usage', run: () => runBinary('/usr/bin/df', ['-h', '/']) },
  cores: { desc: 'number of CPU cores', run: () => String(os.cpus().length) },
  node: { desc: 'node.js runtime version', run: () => process.version },
  version: { desc: 'site version', run: () => pkg.version },
  quote: { desc: 'a random quote', run: () => QUOTES[Math.floor(Math.random() * QUOTES.length)] },
};
function send(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function status() { const total = os.totalmem(); return { time: new Date().toISOString(), uptimeSeconds: Math.round(os.uptime()), processSeconds: Math.round((Date.now() - startedAt) / 1000), loadavg: os.loadavg(), memUsedMiB: Math.round((total - os.freemem()) / MiB), memTotalMiB: Math.round(total / MiB), cores: os.cpus().length, node: process.version }; }
async function readBody(req) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) return null; chunks.push(chunk); } return Buffer.concat(chunks).toString('utf8'); }
async function handleRun(req, res) {
  if (overLimit(clientKey(req))) return send(res, 429, { error: 'slow down' });
  const raw = await readBody(req);
  if (raw === null) return send(res, 413, { error: 'payload too large' });
  let input; try { input = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
  const cmd = input && typeof input.cmd === 'string' ? input.cmd.trim().toLowerCase() : '';
  if (!cmd || cmd.length > MAX_CMD_LEN || !/^[a-z]+$/.test(cmd)) return send(res, 400, { error: 'invalid command' });
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) return send(res, 404, { error: 'unknown command: ' + cmd + '. try "help"' });
  const output = await COMMANDS[cmd].run();
  return send(res, 200, { cmd, output: String(output) });
}
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && pathname === '/api/health') return send(res, 200, { status: 'ok' });
    if (req.method === 'GET' && pathname === '/api/status') return send(res, 200, status());
    if (req.method === 'GET' && pathname === '/api/signal') return send(res, 200, watchStatus());
    if (req.method === 'POST' && pathname === '/api/run') return await handleRun(req, res);
    return send(res, 404, { error: 'not found' });
  } catch (err) { console.error('request failed:', err.message); if (!res.headersSent) send(res, 500, { error: 'internal error' }); }
});
server.listen(PORT, HOST, () => { console.log('beta listening on ' + HOST + ':' + PORT); runWatchChecks(); setInterval(runWatchChecks, WATCH_INTERVAL_MS).unref(); });
