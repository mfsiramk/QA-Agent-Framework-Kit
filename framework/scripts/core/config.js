/**
 * Loads qa-framework.config.json (written by the installer) + .env secrets,
 * and resolves the adapter modules for the tools the client picked.
 *
 *   const { loadConfig, taskAdapter, testAdapter } = require('./core/config');
 *   const cfg = loadConfig();
 *   const task = taskAdapter(cfg);           // { adapter, ctx }
 *   const wi = await task.adapter.getWorkItem(task.ctx, '1234');
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

let _cfg = null;
function loadConfig() {
  if (_cfg) return _cfg;
  loadEnvFile(path.join(ROOT, '.env'));
  const file = path.join(ROOT, 'qa-framework.config.json');
  if (!fs.existsSync(file)) {
    console.error('❌ qa-framework.config.json not found. Run the setup wizard (Start-Installer.cmd in QA-Agent-Framework-Kit) first.');
    process.exit(1);
  }
  _cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  _cfg.root = ROOT;
  return _cfg;
}

function ctxFor(section) {
  return { config: section || {}, env: process.env, root: ROOT };
}

function resolve(kind, id) {
  const p = path.join(__dirname, '..', 'adapters', kind, `${id}.js`);
  if (!fs.existsSync(p)) throw new Error(`No ${kind} adapter for "${id}" (expected ${p}).`);
  return require(p);
}

const taskAdapter = (cfg) => ({ adapter: resolve('task', cfg.taskManagement.tool), ctx: ctxFor(cfg.taskManagement) });
const testAdapter = (cfg) => ({ adapter: resolve('test', cfg.testManagement.tool), ctx: { ...ctxFor(cfg.testManagement), task: cfg.taskManagement } });
/**
 * Requirement docs and designs can come from SEVERAL sources at once
 * (e.g. Confluence + Word files, Figma + exported screenshots):
 *   requirementDocs: { sources: [{ tool: 'confluence', baseUrl, deployment }, { tool: 'local' }] }
 *   design:          { sources: [{ tool: 'figma' }, { tool: 'files' }] }
 * The older single-tool shape ({ tool: 'confluence', ... }) is still accepted.
 */
function sourcesOf(section) {
  if (!section) return [];
  const list = Array.isArray(section.sources) ? section.sources : (section.tool ? [section] : []);
  return list.filter((s) => s && s.tool && s.tool !== 'none');
}
const pairs = (cfg, kind, section) => sourcesOf(section).map((s) => ({ adapter: resolve(kind, s.tool), ctx: { ...ctxFor(s), task: cfg.taskManagement } }));
const docsAdapters = (cfg) => pairs(cfg, 'docs', cfg.requirementDocs);
const designAdapters = (cfg) => pairs(cfg, 'design', cfg.design);

/**
 * Pick the connector for a link or path the user gave (or one found in the ticket).
 * Returns null when no configured source can read it (e.g. a SharePoint link).
 */
function pickFor(list, input) {
  return list.find((p) => typeof p.adapter.matches === 'function' && p.adapter.matches(p.ctx, input)) || null;
}

// Back-compat single-source helpers (first configured source).
const docsAdapter = (cfg) => docsAdapters(cfg)[0] || null;
const designAdapter = (cfg) => designAdapters(cfg)[0] || null;
const codeAdapter = (cfg) => (cfg.codeChanges && cfg.codeChanges.tool && cfg.codeChanges.tool !== 'none')
  ? { adapter: resolve('code', cfg.codeChanges.tool), ctx: { ...ctxFor(cfg.codeChanges), task: cfg.taskManagement } } : null;

function outDir(...parts) {
  const d = path.join(ROOT, 'output', ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Comment markers let QA Audit work on ANY task tool: it only reads comments. */
const MARKERS = {
  agent2: '[QA-AGENT:TEST-PLAN]',
  agent3: '[QA-AGENT:FEATURE-FILE]',
  exempt: '[QA-AGENT:AUTOMATION-EXEMPT]',
};

module.exports = { loadConfig, taskAdapter, testAdapter, docsAdapter, designAdapter, docsAdapters, designAdapters, pickFor, sourcesOf, codeAdapter, outDir, MARKERS, ROOT, loadEnvFile };
