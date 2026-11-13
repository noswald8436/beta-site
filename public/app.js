(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const API_TIMEOUT_MS = 6500;
  const MAX_LOG_LINES = 160;
  const HISTORY_LIMIT = 40;

  const apiPill = $('api-pill');
  const apiLabel = $('api-label');
  const output = $('out');
  const form = $('form');
  const input = $('cmd');
  const runButton = $('run-btn');
  const spark = $('spark');
  const loadHistory = [];
  const commandHistory = [];
  let historyIndex = 0;
  let requestInFlight = false;

  function setApiState(state, label) {
    if (apiPill) apiPill.dataset.state = state;
    if (apiLabel) apiLabel.textContent = label;
  }

  async function requestJson(url, options) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(url, Object.assign({ cache: 'no-store', signal: controller.signal }, options || {}));
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
      return data;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  // Ambient matrix effect: capped for battery use and disabled for reduced-motion users.
  const matrix = $('matrix');
  const matrixContext = matrix ? matrix.getContext('2d') : null;
  const glyphs = '01<>/\\{}[]+-*=#$%&';
  let matrixWidth = 0;
  let matrixHeight = 0;
  let matrixScale = 1;
  let drops = [];
  let matrixTimer = 0;

  function resizeMatrix() {
    if (!matrix || !matrixContext) return;
    matrixWidth = window.innerWidth;
    matrixHeight = window.innerHeight;
    matrixScale = Math.min(window.devicePixelRatio || 1, 1.6);
    matrix.width = Math.max(1, Math.round(matrixWidth * matrixScale));
    matrix.height = Math.max(1, Math.round(matrixHeight * matrixScale));
    matrixContext.setTransform(matrixScale, 0, 0, matrixScale, 0, 0);
    const columns = Math.ceil(matrixWidth / 19);
    drops = Array.from({ length: columns }, () => Math.random() * -35);
  }

  function drawMatrix() {
    if (!matrixContext) return;
    matrixContext.fillStyle = 'rgba(5, 12, 8, 0.16)';
    matrixContext.fillRect(0, 0, matrixWidth, matrixHeight);
    matrixContext.fillStyle = 'rgba(143, 255, 178, 0.72)';
    matrixContext.font = '13px ui-monospace, Menlo, Consolas, monospace';
    for (let i = 0; i < drops.length; i += 1) {
      const char = glyphs[Math.floor(Math.random() * glyphs.length)];
      matrixContext.fillText(char, i * 19, drops[i] * 17);
      if (drops[i] * 17 > matrixHeight && Math.random() > 0.978) drops[i] = 0;
      drops[i] += 0.72;
    }
  }

  function syncMatrix() {
    window.clearInterval(matrixTimer);
    if (!prefersReducedMotion && !document.hidden) matrixTimer = window.setInterval(drawMatrix, 78);
  }

  resizeMatrix();
  syncMatrix();
  window.addEventListener('resize', resizeMatrix, { passive: true });
  document.addEventListener('visibilitychange', syncMatrix);

  function formatUptime(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return '—';
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    return days + 'd ' + hours + 'h ' + minutes + 'm';
  }

  function resizeSpark() {
    if (!spark) return;
    const rect = spark.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    spark.width = Math.max(1, Math.round(rect.width * ratio));
    spark.height = Math.max(1, Math.round(rect.height * ratio));
    drawSpark();
  }

  function drawSpark() {
    if (!spark) return;
    const context = spark.getContext('2d');
    if (!context) return;
    const rect = spark.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = rect.width;
    const height = rect.height;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.strokeStyle = 'rgba(155, 181, 162, 0.16)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, height - 1);
    context.lineTo(width, height - 1);
    context.stroke();
    if (loadHistory.length < 2) return;

    const pad = 8;
    const max = Math.max(0.5, ...loadHistory) * 1.2;
    const xAt = (index) => pad + (index / Math.max(1, loadHistory.length - 1)) * (width - pad * 2);
    const yAt = (value) => height - pad - (value / max) * (height - pad * 2);
    context.beginPath();
    loadHistory.forEach((value, index) => {
      const x = xAt(index);
      const y = yAt(value);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = '#8fffb2';
    context.lineWidth = 2;
    context.shadowColor = 'rgba(87, 217, 154, 0.48)';
    context.shadowBlur = 9;
    context.stroke();
    context.shadowBlur = 0;
    const lastIndex = loadHistory.length - 1;
    context.beginPath();
    context.arc(xAt(lastIndex), yAt(loadHistory[lastIndex]), 3, 0, Math.PI * 2);
    context.fillStyle = '#c7ffd5';
    context.fill();
  }

  function setMetric(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  async function refreshStats() {
    try {
      const status = await requestJson('/api/status');
      if (!Array.isArray(status.loadavg)) throw new Error('Invalid status response');
      setMetric('s-uptime', formatUptime(status.uptimeSeconds));
      setMetric('s-load', status.loadavg.map((value) => Number(value).toFixed(2)).join(' / '));
      setMetric('s-mem', Number(status.memUsedMiB).toLocaleString() + ' / ' + Number(status.memTotalMiB).toLocaleString() + ' MiB');
      setMetric('s-cores', String(status.cores));
      setMetric('s-node', String(status.node));
      setMetric('s-time', new Date(status.time).toLocaleTimeString());
      const lastUpdated = $('last-updated');
      if (lastUpdated) lastUpdated.textContent = 'Updated ' + new Date().toLocaleTimeString();
      loadHistory.push(Number(status.loadavg[0]) || 0);
      if (loadHistory.length > 60) loadHistory.shift();
      drawSpark();
      setApiState('online', 'API ONLINE');
      return true;
    } catch (error) {
      ['s-uptime', 's-load', 's-mem', 's-cores', 's-node', 's-time'].forEach((id) => setMetric(id, '—'));
      const lastUpdated = $('last-updated');
      if (lastUpdated) lastUpdated.textContent = 'Metrics unavailable';
      setApiState('offline', 'API OFFLINE');
      return false;
    }
  }

  function addLine(text, kind) {
    if (!output) return;
    const line = document.createElement('div');
    line.className = 'line' + (kind ? ' line-' + kind : '');
    line.textContent = String(text);
    output.appendChild(line);
    while (output.children.length > MAX_LOG_LINES) output.removeChild(output.firstElementChild);
    output.scrollTop = output.scrollHeight;
  }

  async function bootTerminal() {
    addLine('beta // interactive console', 'dim');
    addLine('checking API connection…', 'dim');
    try {
      const health = await requestJson('/api/health');
      if (health.status !== 'ok') throw new Error('Health check did not return ok');
      setApiState('online', 'API ONLINE');
      addLine('API link established. Type "help" to explore.', 'success');
    } catch (error) {
      setApiState('offline', 'API OFFLINE');
      addLine('The page is up, but the API did not respond. Try again in a moment.', 'error');
    }
    await refreshStats();
  }

  async function runCommand(command) {
    const normalized = command.trim();
    if (!normalized || requestInFlight) return;
    if (normalized.toLowerCase() === 'clear') {
      if (output) output.textContent = '';
      addLine('screen cleared', 'dim');
      return;
    }

    addLine('guest@beta:~$ ' + normalized, 'command');
    requestInFlight = true;
    if (form) form.setAttribute('aria-busy', 'true');
    if (runButton) runButton.disabled = true;
    if (input) input.disabled = true;

    try {
      const result = await requestJson('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: normalized })
      });
      addLine(result.output == null ? '' : result.output);
      setApiState('online', 'API ONLINE');
    } catch (error) {
      const message = error && error.message ? error.message : 'network error';
      addLine(message === 'Failed to fetch' ? 'Could not reach the API.' : message, 'error');
      setApiState('offline', 'API OFFLINE');
    } finally {
      requestInFlight = false;
      if (form) form.removeAttribute('aria-busy');
      if (runButton) runButton.disabled = false;
      if (input) {
        input.disabled = false;
        input.focus();
      }
    }
  }

  function submitCommand(command) {
    const value = String(command || '').trim();
    if (!value || requestInFlight) return;
    commandHistory.push(value);
    if (commandHistory.length > HISTORY_LIMIT) commandHistory.shift();
    historyIndex = commandHistory.length;
    if (input) input.value = '';
    runCommand(value);
  }

  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitCommand(input ? input.value : '');
    });
  }

  if (input) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp') {
        if (historyIndex > 0) {
          historyIndex -= 1;
          input.value = commandHistory[historyIndex];
        }
        event.preventDefault();
      } else if (event.key === 'ArrowDown') {
        if (historyIndex < commandHistory.length - 1) {
          historyIndex += 1;
          input.value = commandHistory[historyIndex];
        } else {
          historyIndex = commandHistory.length;
          input.value = '';
        }
        event.preventDefault();
      } else if (event.key === 'Escape') {
        input.value = '';
      }
    });
  }

  document.querySelectorAll('[data-command]').forEach((button) => {
    button.addEventListener('click', () => submitCommand(button.dataset.command));
  });

  const clearButton = $('clear-output');
  if (clearButton) clearButton.addEventListener('click', () => {
    if (output) output.textContent = '';
    if (input) input.focus();
  });

  resizeSpark();
  window.addEventListener('resize', resizeSpark, { passive: true });
  bootTerminal();
  window.setInterval(refreshStats, 15000);
})();