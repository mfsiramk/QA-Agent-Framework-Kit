#!/usr/bin/env node
/**
 * QA Agent Framework - interactive installer.
 *   Start-Installer.cmd (Windows) / Start-Installer.command or sh start-installer.sh (macOS, Linux) / npm start
 *   → opens http://127.0.0.1:4600
 *   npm start -- --no-open --port=4700
 *
 * Zero dependencies. Listens on 127.0.0.1 only; secrets typed into the wizard go
 * straight into the chosen folder's .env and nowhere else.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { catalog, ADAPTERS } = require('./lib/catalog');
const { buildFiles, install } = require('./lib/generator');

const PUBLIC = path.join(__dirname, 'public');

/** Fingerprint of this copy of the kit (file names, sizes, dates) - tells an old running wizard from a new one. */
const BUILD = (() => {
  const h = require('crypto').createHash('sha1');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else { const s = fs.statSync(p); h.update(`${path.relative(__dirname, p)}:${s.size}:${s.mtimeMs}\n`); }
  });
  [__dirname, path.join(__dirname, '..', 'framework', 'scripts')].forEach((d) => { if (fs.existsSync(d)) walk(d); });
  return h.digest('hex').slice(0, 12);
})();
const argv = process.argv.slice(2);
const PORT = Number((argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || Number(process.env.PORT) || 4600;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECRET_FILE = /^\.env$/;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });
}

function mask(files) {
  const out = {};
  for (const [k, v] of Object.entries(files)) out[k] = SECRET_FILE.test(k) ? v.replace(/^([A-Z0-9_]+=)(.+)$/gm, (_, a, b) => `${a}${b.length > 4 ? '•'.repeat(8) + b.slice(-4) : '••••'}`) : v;
  return out;
}

/** Tokens saved in a previous installation's .env (used when the field was left empty to keep them). */
function keptSecrets(target) {
  const out = {};
  try {
    const f = path.join(path.resolve(String(target || '')), '.env');
    if (target && fs.existsSync(f)) for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && m[2].trim()) out[m[1]] = m[2].trim(); }
  } catch { /* no previous install */ }
  return out;
}

/** Pasted values often carry spaces or line breaks - a token with a trailing space is rejected (401). */
const cleanSecrets = (s) => Object.fromEntries(Object.entries(s || {}).map(([k, v]) => [k, String(v ?? '').replace(/[\r\n\t]/g, '').trim()]).filter(([, v]) => v));

async function testConnection({ kind, tool, config, secrets, task, target }) {
  if (!/^(task|test|docs|design|code)$/.test(kind) || !/^[a-z0-9-]+$/.test(tool || '')) return { ok: false, message: 'Unknown tool.' };
  const p = path.join(ADAPTERS, kind, `${tool}.js`);
  if (!fs.existsSync(p)) return { ok: false, message: `No connector for ${tool}.` };
  delete require.cache[require.resolve(p)]; // always test with the connector code on disk
  const adapter = require(p);
  try {
    return await adapter.testConnection({ config: config || {}, env: { ...keptSecrets(target), ...cleanSecrets(secrets) }, task: task || {}, root: os.tmpdir() });
  } catch (e) {
    return { ok: false, message: e.message, fix: 'Check the values above and try again.' };
  }
}

/** Run `<cmd> --version` and return the first line, or null if not installed. */
function version(cmd, args = ['--version']) {
  return new Promise((resolve) => {
    // Fixed, hard-coded commands only (never user input), so a shell string is safe here.
    exec(`${cmd} ${args.join(' ')}`, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const line = String(stdout || stderr).trim().split(/\r?\n/)[0];
      resolve(line || null);
    });
  });
}

/** What is installed on this machine (used by the "Before you start" step). */
async function systemCheck() {
  const [npm, git, claude, code] = await Promise.all([version('npm'), version('git'), version('claude'), version('code')]);
  return {
    os: `${os.type()} ${os.release()} (${process.arch})`,
    platform: process.platform,
    node: process.versions.node,
    nodeOk: Number(process.versions.node.split('.')[0]) >= 18,
    npm, git, claude, code,
  };
}

/** Can this computer reach host:port? Opens a TCP connection only - never logs in. */
function tcpCheck({ host, port }) {
  return new Promise((resolve) => {
    const h = String(host || '').trim().replace(/\\.*$/, ''); // "server\INSTANCE" → server
    const p = Number(port);
    if (!h || !p) return resolve({ ok: false, message: 'Enter the server and port first.' });
    const sock = require('net').connect({ host: h, port: p });
    const done = (r) => { sock.destroy(); resolve(r); };
    sock.setTimeout(5000);
    sock.on('connect', () => done({ ok: true, message: `Reachable (${h}:${p})` }));
    sock.on('timeout', () => done({ ok: false, message: `No answer from ${h}:${p} within 5s - VPN / firewall?` }));
    sock.on('error', (e) => done({ ok: false, message: e.code === 'ENOTFOUND' ? `Server name "${h}" not found - check spelling / VPN.` : `${e.code || e.message} (${h}:${p})` }));
  });
}

const routes = {
  'GET /api/system-check': () => systemCheck(),
  'POST /api/tcp-check': (b) => tcpCheck(b),
  'GET /api/catalog': () => catalog(),
  'GET /api/defaults': () => ({ target: path.join(os.homedir(), 'qa-agents'), platform: process.platform, build: BUILD }),
  // A newer copy of the wizard asks an older one to step aside (see "server.on('error')" below).
  'POST /api/shutdown': (b) => {
    if (!b || !b.build || b.build === BUILD) return { ok: false, reason: 'same build' };
    console.log('\n🔁 Another version of the setup wizard was started - this window closes now.\n');
    setTimeout(() => process.exit(0), 300);
    return { ok: true };
  },
  'POST /api/test-connection': (b) => testConnection(b),
  'POST /api/preview': (b) => { const r = buildFiles(b); return { files: mask(r.files), warnings: r.warnings, decisions: r.decisions }; },
  'POST /api/install': (b) => {
    if (!b.target || !path.isAbsolute(b.target)) throw new Error('Please enter a full folder path, e.g. C:\\QA\\my-qa-agents');
    return install(b);
  },
  'POST /api/load': (b) => {
    const f = path.join(path.resolve(String(b.target || '')), 'installer-answers.json');
    if (!fs.existsSync(f)) throw new Error(`No installer-answers.json in ${b.target}`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  },
};

const server = http.createServer(async (req, res) => {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: 'Forbidden host' });
  const url = new URL(req.url, `http://${host}`);
  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    if (req.method === 'POST' && !/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON only' });
    try { return send(res, 200, await route(req.method === 'POST' ? await readBody(req) : {})); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (url.pathname === '/' && !server.opened) { server.opened = true; console.log('   ✔ The wizard is open in your browser.\n'); }
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
  send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
});

/** Open the default browser. Windows: `start`, falling back to rundll32 (works when `start` is blocked). */
function openBrowser(url) {
  if (argv.includes('--no-open')) return;
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`, (err) => { if (err) exec(`rundll32 url.dll,FileProtocolHandler "${url}"`, () => {}); });
  } else {
    exec(`${process.platform === 'darwin' ? 'open' : 'xdg-open'} "${url}"`, () => {});
  }
}

/** What is answering on this port? null = not our wizard; { build } = our wizard (build undefined = a very old copy). */
function probeWizard(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/defaults', timeout: 1500 }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { const j = JSON.parse(d); resolve(j.target ? { build: j.build } : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function askToShutdown(port) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ build: BUILD });
    const req = http.request({ host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 2000 }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

let port = PORT;
const MAX_TRIES = 20;
let tookOver = false;
server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') { console.error(`\n❌ ${e.message}\n`); process.exit(1); }
  const running = await probeWizard(port);
  if (running && running.build === BUILD) { // same version already open: just show it
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n🧭 The setup wizard is already running at ${url} - opening it in your browser.\n   (You can close this window.)\n`);
    openBrowser(url);
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  if (running && !tookOver) { // an OLDER (or different) copy is running: ask it to close, then take its place
    tookOver = true;
    console.log(`\n🔁 Another version of the setup wizard is running on port ${port} - replacing it with this one…`);
    await askToShutdown(port);
    for (let i = 0; i < 15; i++) { await new Promise((r) => setTimeout(r, 200)); if (!(await probeWizard(port))) return server.listen(port, '127.0.0.1'); }
    console.log(`   The old copy did not close by itself (it is from before this feature). Close its window, or use the new address below.`);
  }
  if (port - PORT >= MAX_TRIES) { console.error(`\n❌ Ports ${PORT}-${port} are all busy. Close other programs or run: npm start -- --port=5600\n`); process.exit(1); }
  port++;
  server.listen(port, '127.0.0.1');
});

server.on('listening', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`\n🧭 QA Agent Framework setup wizard is running.\n`);
  console.log(`   ➜ Open in your browser:  ${url}`);
  console.log(`     (it should open automatically - if not, copy the address above into Chrome or Edge)\n`);
  console.log('   Keep this window open while you use the wizard. Press Ctrl+C or close the window to stop.\n');
  openBrowser(url);
});

server.listen(port, '127.0.0.1');
