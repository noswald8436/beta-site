'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3001);

const MAX_BODY = 1024;          // bytes accepted in a POST body
const MAX_CMD_LEN = 32;         // characters in a command name
const RATE_WINDOW_MS = 60_000;  // rate-limit window
const RATE_MAX = 30;            // commands per window, per client
const MiB = 1024 * 1024;
const startedAt = Date.now();

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// ---- rate limiting -------------------------------------------------------
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (now - b.start > RATE_WINDOW_MS) buckets.delete(key);
  }
}, RATE_WINDOW_MS).unref();

function clientKey(req) {
  // cloudflared sets this header. The origin only listens on localhost,
  // so nothing else can set it.
  return req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
}

function overLimit(key) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.start > RATE_WINDOW_MS) {
    buckets.set(key, { start: now, count: 1 });
    return false;
  }
  b.count += 1;
  return b.count > RATE_MAX;
}

// ---- helpers for real commands -------------------------------------------
function runBinary(bin, args) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: 2000, maxBuffer: 16 * 1024, env: { LANG: 'C', PATH: '/usr/bin:/bin' } },
      (err, stdout) => {
        // stderr is never returned: it can contain paths and system details.
        if (err) return resolve('command failed');
        resolve(stdout.trim());
      }
    );
  });
}

const QUOTES = [
  'Any sufficiently advanced configuration is indistinguishable from magic.',
  'It works on my machine.',
  'There are two hard things in computing: cache invalidation and naming things.',
  'Trust, but verify the firewall rules.',
];

// ---- the whitelist ---------------------------------------------------------
// Every command takes no arguments and returns read-only, low-detail output.
// To add one, add an entry here and nowhere else. Don't add commands that
// read files, list processes, show network config, or accept input.
const COMMANDS = {
  help: {
    desc: 'list available commands',
    run: () => Object.entries(COMMANDS)
      .map(([name, c]) => `${name.padEnd(9)}${c.desc}`)
      .join('\n'),
  },
  about: {
    desc: 'what this site is',
    run: () => [
      'nicholas-oswald.com / beta',
      'node.js API behind caddy, served through a cloudflare tunnel',
      'type "help" for commands',
    ].join('\n'),
  },
  time: {
    desc: 'server time (UTC)',
    run: () => new Date().toISOString(),
  },
  uptime: {
    desc: 'how long the host has been up',
    run: () => runBinary('/usr/bin/uptime', ['-p']),
  },
  load: {
    desc: '1, 5 and 15 minute load averages',
    run: () => os.loadavg().map((n) => n.toFixed(2)).join('  '),
  },
  mem: {
    desc: 'memory in use',
    run: () => {
      const total = os.totalmem();
      const used = total - os.freemem();
      return `${(used / MiB).toFixed(0)} MiB used of ${(total / MiB).toFixed(0)} MiB`;
    },
  },
  disk: {
    desc: 'root filesystem usage',
    run: () => runBinary('/usr/bin/df', ['-h', '/']),
  },
  cores: {
    desc: 'number of CPU cores',
    run: () => String(os.cpus().length),
  },
  node: {
    desc: 'node.js runtime version',
    run: () => process.version,
  },
  version: {
    desc: 'site version',
    run: () => pkg.version,
  },
  quote: {
    desc: 'a random quote',
    run: () => QUOTES[Math.floor(Math.random() * QUOTES.length)],
  },
};

// ---- HTTP ------------------------------------------------------------------
function send(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function status() {
  const total = os.totalmem();
  return {
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(os.uptime()),
    processSeconds: Math.round((Date.now() - startedAt) / 1000),
    loadavg: os.loadavg(),
    memUsedMiB: Math.round((total - os.freemem()) / MiB),
    memTotalMiB: Math.round(total / MiB),
    cores: os.cpus().length,
    node: process.version,
  };
}

// Reads the request body with a size cap. Returns null if it's too large.
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleRun(req, res) {
  if (overLimit(clientKey(req))) return send(res, 429, { error: 'slow down' });

  const raw = await readBody(req);
  if (raw === null) return send(res, 413, { error: 'payload too large' });

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: 'invalid JSON' });
  }

  const cmd = input && typeof input.cmd === 'string' ? input.cmd.trim().toLowerCase() : '';
  if (!cmd || cmd.length > MAX_CMD_LEN || !/^[a-z]+$/.test(cmd)) {
    return send(res, 400, { error: 'invalid command' });
  }
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) {
    return send(res, 404, { error: `unknown command: ${cmd}. try "help"` });
  }

  const output = await COMMANDS[cmd].run();
  return send(res, 200, { cmd, output: String(output) });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return send(res, 200, { status: 'ok' });
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      return send(res, 200, status());
    }
    if (req.method === 'POST' && pathname === '/api/run') {
      return await handleRun(req, res);
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('request failed:', err.message);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, HOST, () => console.log(`beta listening on ${HOST}:${PORT}`));
