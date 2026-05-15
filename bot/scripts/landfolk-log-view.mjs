#!/usr/bin/env node
/**
 * HermesCraft — TUI log viewer (blessed): landfolk bots, agents, Hermes, watchdog, mc, progress.
 *
 *   cd bot && npm install && npm run log-view
 *   LOG_DIR=/tmp/hermescraft BASE_API_PORT=3001 node scripts/landfolk-log-view.mjs
 *
 * Keys: ↑↓ j/k move list · Enter follow file · Tab focus log (scroll PgUp/PgDn) · r refresh status
 *       a follow all bot-*.log · q quit
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import blessed from 'blessed';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const LOG_DIR = process.env.LOG_DIR || '/tmp/hermescraft';
const BASE_API_PORT = parseInt(process.env.BASE_API_PORT || '3001', 10);

/** Ports to poll for /health — matches resolve-agent-model.py api-port (explicit api_port or base + index). */
function landfolkApiPortsList() {
  const cfgPath = process.env.AGENT_MODELS_JSON || path.join(REPO_ROOT, 'data', 'agent-models.json');
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const d = JSON.parse(raw);
    const envBase = process.env.BASE_API_PORT;
    const jsonBase =
      d.landfolk && typeof d.landfolk === 'object' && typeof d.landfolk.base_api_port === 'number'
        ? d.landfolk.base_api_port
        : 3001;
    const base = envBase != null && String(envBase).trim() !== '' ? parseInt(String(envBase), 10) : jsonBase;
    const agents = d.agents && typeof d.agents === 'object' ? d.agents : {};
    const names = Object.keys(agents);
    const seen = new Set();
    const out = [];
    let i = 0;
    for (const n of names) {
      const row = agents[n];
      let p = base + i;
      if (row && typeof row.api_port === 'number' && Number.isFinite(row.api_port)) {
        p = Math.trunc(row.api_port);
      }
      i += 1;
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out.length ? out : [base];
  } catch {
    return [BASE_API_PORT];
  }
}
const MAX_LINES = 800;
const POLL_MS = 900;
const HEALTH_MS = 3500;

const ansi = {
  reset: '\x1b[0m',
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[91m${s}\x1b[0m`,
  green: (s) => `\x1b[92m${s}\x1b[0m`,
  yellow: (s) => `\x1b[93m${s}\x1b[0m`,
  blue: (s) => `\x1b[94m${s}\x1b[0m`,
  cyan: (s) => `\x1b[96m${s}\x1b[0m`,
  magenta: (s) => `\x1b[95m${s}\x1b[0m`,
};

function colorizeLine(line) {
  let s = line;
  if (/\b(ERROR|Error|failed|FAILED|exit_code=[1-9]|ECONNREFUSED)\b/.test(s)) s = ansi.red(s);
  else if (/\b(warn|WARN|Warning)\b/.test(s)) s = ansi.yellow(s);
  else if (/\b(connected|CONNECTED|ok.?true|complete \(exit=0\))\b/i.test(s)) s = ansi.green(s);
  else if (/LLM model:|Hermes -m|AGENT_MODEL=|profile=/.test(s)) s = ansi.cyan(s);
  else if (/round=\d+|Plan:|top_goal=/.test(s)) s = ansi.magenta(s);
  else if (/^\[[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(s) && s.length > 22) {
    s = ansi.dim(s.slice(0, 22)) + s.slice(22);
  }
  return s;
}

function listLogFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const flat = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.log') && !f.includes('.backup'));

  // Also surface per-pytest-run files at <LOG_DIR>/tests/<run-id>/*.log
  // so the viewer can tail an active test run.
  const testRunDir = path.join(dir, 'tests');
  const testRuns = [];
  if (fs.existsSync(testRunDir)) {
    for (const runId of fs.readdirSync(testRunDir).sort().reverse().slice(0, 5)) {
      const runPath = path.join(testRunDir, runId);
      if (!fs.statSync(runPath).isDirectory()) continue;
      for (const f of fs.readdirSync(runPath)) {
        if (f.endsWith('.log') && !f.includes('.backup')) {
          testRuns.push(path.join('tests', runId, f));
        }
      }
    }
  }

  return [...flat, ...testRuns].sort((a, b) => {
    const rank = (n) => {
      if (n.startsWith('bot-')) return 0;
      if (n.startsWith('agent-')) return 1;
      if (n.startsWith('watchdog-')) return 2;
      if (n.startsWith('hermes-')) return 3;
      if (n.startsWith('progress-')) return 4;
      if (n.startsWith('mc-')) return 5;
      if (n.startsWith('tests/')) return 8;
      return 9;
    };
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.localeCompare(b);
  });
}

async function fetchHealth(port) {
  const url = `http://127.0.0.1:${port}/health`;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1200);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return { port, ok: false, text: `HTTP ${r.status}` };
    const j = await r.json();
    return {
      port,
      ok: true,
      connected: !!j.connected,
      username: j.username || '?',
      profile: j.profile || j.username,
      model: j.model || '—',
      provider: j.provider || '—',
      server: j.server || '—',
    };
  } catch (e) {
    return { port, ok: false, text: 'down' };
  }
}

async function pollAllHealth() {
  const ports = landfolkApiPortsList();
  const uniq = [...new Set(ports)];
  const results = await Promise.all(uniq.map((p) => fetchHealth(p)));
  return results;
}

function formatHealthBar(results) {
  const parts = results.map((h) => {
    if (!h.ok) return ansi.dim(`:${h.port} —`);
    const conn = h.connected ? ansi.green('mc') : ansi.yellow('wait');
    const m = h.model && h.model !== '—' ? ansi.cyan(String(h.model).slice(0, 28)) : ansi.dim('no model');
    return `${ansi.blue(`:${h.port}`)} ${conn} ${h.profile} ${m}`;
  });
  return parts.join('  │  ');
}

class TailSource {
  constructor(filePath, prefix) {
    this.filePath = filePath;
    this.prefix = prefix;
    this.pos = 0;
    this.watcher = null;
  }

  seedExistingLines(onLine, maxBytes = 48_000) {
    try {
      const st = fs.statSync(this.filePath);
      const start = Math.max(0, st.size - maxBytes);
      const fd = fs.openSync(this.filePath, 'r');
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      fs.closeSync(fd);
      this.pos = st.size;
      const text = buf.toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      const tail = lines.slice(-120);
      for (const ln of tail) onLine(this.prefix + ln);
    } catch {
      onLine(this.prefix + ansi.red(`(cannot read ${this.filePath})`));
      this.pos = 0;
    }
  }

  follow(onLine) {
    try {
      if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '');
    } catch { /* ignore */ }
    const tick = () => {
      try {
        const st = fs.statSync(this.filePath);
        if (st.size < this.pos) this.pos = 0;
        if (st.size > this.pos) {
          const fd = fs.openSync(this.filePath, 'r');
          const len = st.size - this.pos;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, this.pos);
          fs.closeSync(fd);
          this.pos = st.size;
          const chunk = buf.toString('utf8');
          for (const ln of chunk.split('\n')) {
            if (ln) onLine(this.prefix + ln);
          }
        }
      } catch { /* race */ }
    };
    tick();
    try {
      this.watcher = fs.watch(this.filePath, tick);
    } catch {
      setInterval(tick, POLL_MS);
    }
  }

  stop() {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch { /* ignore */ }
      this.watcher = null;
    }
  }
}

function main() {
  const files = listLogFiles(LOG_DIR);
  const botFiles = files.filter((f) => f.startsWith('bot-'));

  const listItems = [];
  const listMeta = [];
  listItems.push(`* ALL bot logs (${botFiles.length})`);
  listMeta.push({ type: 'all_bots', files: botFiles.map((f) => path.join(LOG_DIR, f)) });
  for (const f of files) {
    listItems.push(`  ${f}`);
    listMeta.push({ type: 'single', files: [path.join(LOG_DIR, f)] });
  }

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: 'HermesCraft log viewer',
  });

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: false,
    style: { fg: 'white', bg: 'blue', bold: true },
    content:
      ` HermesCraft  ${LOG_DIR}  |  port ${BASE_API_PORT}+  |  q quit  Tab focus  r health  a all bots `,
  });

  const list = blessed.list({
    parent: screen,
    top: 3,
    left: 0,
    width: 34,
    height: '100%-6',
    keys: true,
    vi: true,
    mouse: true,
    label: ' sources ',
    border: 'line',
    style: {
      fg: 'white',
      bg: 'black',
      border: { fg: 'cyan' },
      selected: { bg: 'blue', fg: 'white' },
    },
    items: listItems,
  });

  const logBox = blessed.box({
    parent: screen,
    top: 3,
    left: 34,
    width: '100%-34',
    height: '100%-6',
    tags: false,
    keys: true,
    vi: true,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: ' ', track: { bg: 'cyan' }, style: { inverse: true } },
    label: ' output ',
    border: 'line',
    style: { fg: 'gray', bg: 'black', border: { fg: 'green' } },
    content: '',
  });

  const status = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: false,
    border: 'line',
    style: { fg: 'white', bg: 'black', border: { fg: 'yellow' } },
    content: ' polling /health …',
  });

  const lines = [];
  let tailers = [];

  function pushLine(raw) {
    const colored = colorizeLine(raw);
    lines.push(colored);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    logBox.setContent(lines.join('\n'));
    logBox.setScrollPerc(100);
    screen.render();
  }

  function clearTails() {
    for (const t of tailers) t.stop();
    tailers = [];
  }

  function startTails(meta) {
    clearTails();
    lines.length = 0;
    logBox.setContent('');
    const paths = meta.files;
    if (paths.length === 0) {
      pushLine(ansi.red('No log files in ' + LOG_DIR));
      return;
    }
    for (const fp of paths) {
      const base = path.basename(fp);
      const prefix = paths.length > 1 ? ansi.blue(`[${base}] `) : '';
      const src = new TailSource(fp, prefix);
      src.seedExistingLines(pushLine);
      src.follow(pushLine);
      tailers.push(src);
    }
    logBox.setLabel(` ${paths.map((p) => path.basename(p)).join(' + ')} `);
    screen.render();
  }

  async function refreshStatus() {
    const h = await pollAllHealth();
    status.setContent(` ${formatHealthBar(h)} `);
    screen.render();
  }

  function onPick(i) {
    const meta = listMeta[i];
    if (meta) startTails(meta);
  }

  list.on('select', (_item, i) => {
    onPick(i);
  });
  list.on('action', (_el, i) => {
    onPick(i);
  });

  list.select(0);
  onPick(0);

  screen.key(['q', 'C-c'], () => process.exit(0));
  screen.key(['r'], () => {
    refreshStatus();
  });
  screen.key(['a'], () => {
    list.select(0);
    list.emit('select', listItems[0], 0);
    screen.render();
  });

  logBox.key(['up', 'down', 'pageup', 'pagedown'], () => {
    screen.render();
  });

  screen.key(['tab'], () => {
    if (screen.focused === list) logBox.focus();
    else list.focus();
    screen.render();
  });

  setInterval(refreshStatus, HEALTH_MS);
  refreshStatus();

  list.focus();
  screen.render();
}

main();
