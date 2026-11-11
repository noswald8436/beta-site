(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- matrix background ----
  const canvas = $('matrix');
  const ctx = canvas.getContext('2d');
  const glyphs = '01<>/\\{}[]+-*=#$%&';
  let cols = 0;
  let drops = [];

  function resizeMatrix() {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    cols = Math.ceil(canvas.width / 16);
    drops = Array.from({ length: cols }, () => Math.random() * -60);
  }

  function drawMatrix() {
    ctx.fillStyle = 'rgba(4, 7, 5, 0.12)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#39ff88';
    ctx.font = '14px ui-monospace, Menlo, Consolas, monospace';
    for (let i = 0; i < cols; i++) {
      const ch = glyphs[Math.floor(Math.random() * glyphs.length)];
      ctx.fillText(ch, i * 16, drops[i] * 16);
      if (drops[i] * 16 > canvas.height && Math.random() > 0.975) drops[i] = 0;
      drops[i] += 1;
    }
  }

  addEventListener('resize', resizeMatrix);
  resizeMatrix();
  if (!reduce) setInterval(drawMatrix, 60);

  // ---- system panel ----
  const HISTORY = 60;          // points kept for the load graph
  const loadHistory = [];
  const spark = $('spark');
  const sctx = spark.getContext('2d');

  function drawSpark() {
    const w = spark.width;
    const h = spark.height;
    sctx.clearRect(0, 0, w, h);
    if (loadHistory.length < 2) return;
    const max = Math.max(0.5, ...loadHistory) * 1.2;
    const n = loadHistory.length;
    sctx.beginPath();
    loadHistory.forEach((v, i) => {
      // newest point sits on the right edge
      const x = w - ((n - 1 - i) / (HISTORY - 1)) * w;
      const y = h - (v / max) * (h - 4) - 2;
      if (i === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y);
    });
    sctx.strokeStyle = '#39ff88';
    sctx.lineWidth = 2;
    sctx.shadowColor = '#39ff88';
    sctx.shadowBlur = 8;
    sctx.stroke();
  }

  function fmtSeconds(s) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  }

  async function refreshStats() {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const s = await r.json();
      $('s-uptime').textContent = fmtSeconds(s.uptimeSeconds);
      $('s-load').textContent = s.loadavg.map((n) => n.toFixed(2)).join('  ');
      $('s-mem').textContent = `${s.memUsedMiB} / ${s.memTotalMiB} MiB`;
      $('s-cores').textContent = s.cores;
      $('s-node').textContent = s.node;
      $('s-time').textContent = new Date(s.time).toLocaleTimeString();
      loadHistory.push(s.loadavg[0]);
      if (loadHistory.length > HISTORY) loadHistory.shift();
      drawSpark();
    } catch {
      $('s-uptime').textContent = 'offline';
    }
  }
  refreshStats();
  setInterval(refreshStats, 5000);

  // ---- terminal ----
  const out = $('out');
  const form = $('form');
  const input = $('cmd');
  const past = [];
  let pIdx = 0;

  function print(text, cls = '') {
    const line = document.createElement('div');
    line.className = cls;
    line.textContent = text; // textContent only: output is never parsed as HTML
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
  }

  async function boot() {
    const lines = [
      'beta // booting ...',
      'attaching tunnel ............ ok',
      'starting api on loopback .... ok',
      'type "help" to see what you can run.',
    ];
    for (const l of lines) {
      print(l, 'dim');
      if (!reduce) await sleep(220);
    }
  }
  boot();

  async function runCommand(cmd) {
    if (cmd === 'clear') {       // client-side only: wipes the screen
      out.textContent = '';
      return;
    }
    print(`guest@beta:~$ ${cmd}`, 'cmd');
    try {
      const r = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd }),
      });
      const data = await r.json();
      if (r.ok) print(data.output);
      else print(data.error || `request failed (${r.status})`, 'err');
    } catch {
      print('network error', 'err');
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const cmd = input.value.trim();
    input.value = '';
    if (!cmd) return;
    past.push(cmd);
    pIdx = past.length;
    runCommand(cmd);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      if (pIdx > 0) { pIdx -= 1; input.value = past[pIdx]; }
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      if (pIdx < past.length) { pIdx += 1; input.value = past[pIdx] || ''; }
      e.preventDefault();
    }
  });

  out.addEventListener('click', () => input.focus());
})();
