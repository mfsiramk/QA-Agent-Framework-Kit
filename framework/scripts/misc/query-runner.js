#!/usr/bin/env node
/**
 * QUERY RUNNER - run the team's saved SQL against a test database; Excel + HTML report.
 *
 * Triggers: "Help me run query", "Run query", "Run diagnostic queries on <env>".
 *
 *   node scripts/misc/query-runner.js list                       numbered catalog
 *   node scripts/misc/query-runner.js envs                       numbered environments
 *   node scripts/misc/query-runner.js run --queries=all --env=QA
 *   node scripts/misc/query-runner.js run --queries=1,3,7-9 --env=QA --param OrderId=1234
 *   node scripts/misc/query-runner.js run --queries=diagnostic --env=2
 *   node scripts/misc/query-runner.js run --queries=12 --env=QA --allow-write --confirm-write=QA
 *
 * Queries: queries/<category>/<NN_Name>.sql, each starting with a header:
 *   -- @name: Orders stuck in payment
 *   -- @category: diagnostic | lookup | setup
 *   -- @mode: read | write
 *   -- @params: OrderId, StoreNumber            (optional)
 *   -- @description: ...
 * Placeholders: {{Name}} -> value (quotes escaped; unquoted placeholders must be numeric),
 *               {{list:Name}} -> 'a','b','c' from "a,b,c".
 *
 * Safety: read queries run in a transaction that is ALWAYS rolled back. Write queries
 * (declared @mode: write, or detected) are never part of "all", need --allow-write AND
 * --confirm-write=<EnvName>, and are blocked on environments where writes are not allowed.
 *
 * Exit: 0 ok | 1 error | 2 needs input (MISSING_PARAMS, WRITE_CONFIRMATION_REQUIRED,
 *       WRITE_BLOCKED_ENV, UNKNOWN_ENV, NO_QUERIES_SELECTED) | 3 CONNECTION_FAILED
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, outDir } = require('../core/config');
const { escapeHtml, exitWith } = require('../core/util');
const { ENGINES, runQuery, isWrite } = require('./lib/db');

const cfg = loadConfig();
const qr = cfg.queryRunner;
if (!qr || !cfg.modules.queryRunner) exitWith(1, 'ℹ️  Query Runner is not enabled for this installation. Re-run the setup wizard to add it.');
const QUERIES = path.join(cfg.root, 'queries');
const CATS = ['diagnostic', 'lookup', 'setup'];

/** Query folders: queries/ in the installation, plus (optionally) a folder inside the automation repo - read live. */
function roots() {
  const r = [{ dir: QUERIES, category: null }];
  const src = qr.querySource || {};
  if (src.type === 'automation-repo' && cfg.automation?.repo) {
    r.push({ dir: path.resolve(cfg.root, cfg.automation.repo.localPath || 'automation-repo', src.path || ''), category: 'automation-repo' });
  }
  return r.filter((x) => fs.existsSync(x.dir));
}

function loadQueries() {
  const list = [];
  const walk = (d, fallbackCat) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory() && !['node_modules', '.git', 'bin', 'obj'].includes(e.name)) walk(p, fallbackCat);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.sql')) {
      const sql = fs.readFileSync(p, 'utf8');
      const h = (k) => ((sql.match(new RegExp(`^--\\s*@${k}:\\s*(.+)$`, 'mi')) || [])[1] || '').trim();
      const mode = (h('mode') || '').toLowerCase() === 'write' || isWrite(sql) ? 'write' : 'read';
      list.push({ file: path.relative(cfg.root, p), name: h('name') || path.basename(e.name, '.sql').replace(/^\d+_/, '').replace(/[_-]+/g, ' '),
        category: (h('category') || (mode === 'write' ? 'setup' : fallbackCat) || path.basename(path.dirname(p))).toLowerCase(), mode, params: [...new Set([...h('params').split(','), ...[...sql.matchAll(/\{\{(?:list:)?(\w+)\}\}/g)].map((x) => x[1])].map((s) => s.trim()).filter(Boolean))], description: h('description'), sql });
    }
  });
  roots().forEach((r) => walk(r.dir, r.category));
  return list.sort((a, b) => (CATS.indexOf(a.category) + 1 || 99) - (CATS.indexOf(b.category) + 1 || 99) || a.file.localeCompare(b.file)).map((q, i) => ({ ...q, n: i + 1 }));
}

function arg(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : (process.argv.includes(`--${name}`) ? true : undefined);
}
function params() {
  const out = {};
  const argv = process.argv;
  argv.forEach((a, i) => { if (a === '--param' && argv[i + 1]) { const [k, ...v] = argv[i + 1].split('='); out[k.trim()] = v.join('=').trim(); } });
  return out;
}

function pickEnv(sel) {
  const envs = qr.environments || [];
  if (!sel || sel === true) return null;
  return envs[Number(sel) - 1] || envs.find((e) => e.name.toLowerCase() === String(sel).toLowerCase()) || null;
}

function select(all, sel) {
  if (!sel || sel === true) return [];
  const s = String(sel).toLowerCase();
  if (s === 'all') return all.filter((q) => q.mode === 'read');
  if (CATS.includes(s) || all.some((q) => q.category === s)) return all.filter((q) => q.category === s && (q.mode === 'read' || s === 'setup'));
  const ids = new Set();
  s.split(',').forEach((part) => { const [a, b] = part.split('-').map(Number); for (let i = a; i <= (b || a); i++) ids.add(i); });
  return all.filter((q) => ids.has(q.n));
}

function fill(sql, values) {
  return sql
    .replace(/'?\{\{list:(\w+)\}\}'?/g, (_, k) => String(values[k] ?? '').split(',').map((v) => `'${v.trim().replace(/'/g, "''")}'`).join(','))
    .replace(/('?)\{\{(\w+)\}\}('?)/g, (m, q1, k, q2) => {
      const v = String(values[k] ?? '');
      if (q1 && q2) return `'${v.replace(/'/g, "''")}'`;
      if (!/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`Parameter ${k} must be a number here (it is not inside quotes in the SQL): "${v}"`);
      return `${q1}${v}${q2}`;
    });
}

async function run() {
  const all = loadQueries();
  const env = pickEnv(arg('env'));
  if (!env) exitWith(2, 'UNKNOWN_ENV', ['Pick an environment:', ...(qr.environments || []).map((e, i) => `   ${i + 1}. ${e.name}${e.writeAllowed ? '' : ' (read-only)'}`)]);
  const chosen = select(all, arg('queries'));
  if (!chosen.length) exitWith(2, 'NO_QUERIES_SELECTED', ['Say which queries: numbers (1,3,7-9), a category (diagnostic / lookup / setup) or "all" (read-only ones).']);

  const writes = chosen.filter((q) => q.mode === 'write');
  if (writes.length) {
    if (!env.writeAllowed) exitWith(2, 'WRITE_BLOCKED_ENV', [`${env.name} does not allow data changes. These queries change data: ${writes.map((q) => q.n).join(', ')}.`]);
    if (!arg('allow-write') || String(arg('confirm-write')).toLowerCase() !== env.name.toLowerCase()) {
      exitWith(2, 'WRITE_CONFIRMATION_REQUIRED', [`Queries ${writes.map((q) => `#${q.n} ${q.name}`).join(', ')} CHANGE DATA on ${env.name}.`, `Ask the user to type the environment name "${env.name}" to confirm, then re-run with --allow-write --confirm-write=${env.name}.`]);
    }
  }

  const values = params();
  const missing = [...new Set(chosen.flatMap((q) => q.params.filter((p) => values[p] === undefined)))];
  if (missing.length && !arg('skip-missing-params')) exitWith(2, 'MISSING_PARAMS', [`Ask the user for: ${missing.join(', ')}`, 'Re-run with --param Name=Value for each (or --skip-missing-params to skip those queries).']);

  console.log(`▶ ${chosen.length} quer${chosen.length === 1 ? 'y' : 'ies'} on ${env.name} (${ENGINES[qr.engine].label})`);
  const results = [];
  let connectionFailed = null;
  for (const q of chosen) {
    if (q.params.some((p) => values[p] === undefined)) { results.push({ ...q, status: 'skipped', error: 'missing parameters' }); continue; }
    const t0 = Date.now();
    try {
      const r = await runQuery(qr, env, fill(q.sql, values), { readOnly: q.mode === 'read' });
      results.push({ ...q, status: 'ok', ms: Date.now() - t0, ...r });
      process.stdout.write('.');
    } catch (e) {
      const msg = String(e.message || e);
      if (/driver ".+" is not installed/.test(msg)) exitWith(1, `❌ ${msg}`);
      if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|Failed to connect|getaddrinfo|Login failed|password authentication failed|Access denied/i.test(msg)) { connectionFailed = msg; break; }
      results.push({ ...q, status: 'error', ms: Date.now() - t0, error: msg });
      process.stdout.write('x');
    }
  }
  console.log('');
  if (connectionFailed) {
    exitWith(3, 'CONNECTION_FAILED', [`Could not connect to ${env.name} (${env.host}): ${connectionFailed}`,
      qr.vpnRequired ? 'These databases need the VPN - connect to the VPN and try again.' : 'Check the server name, that you are on the right network, and DB_USER / DB_PASSWORD in .env.']);
  }

  const dir = outDir('query-runner', `${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}-${env.name.replace(/\W+/g, '')}`);
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['#', 'Query', 'Category', 'Status', 'Rows', 'ms', 'Error'], ...results.map((r) => [r.n, r.name, r.category, r.status, r.rowCount ?? '', r.ms ?? '', r.error || ''])]), 'Summary');
  results.filter((r) => r.status === 'ok').forEach((r) => {
    const name = `${r.n} ${r.name}`.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([r.columns, ...r.rows.map((row) => row.map((v) => (v instanceof Date ? v.toISOString() : v)))]), name);
  });
  XLSX.writeFile(wb, path.join(dir, 'results.xlsx'));
  const lean = results.map(({ sql, rows, ...r }) => ({ ...r, rows: (rows || []).slice(0, 1000) }));
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ env: env.name, engine: qr.engine, at: new Date().toISOString(), params: values, results: lean }, null, 2));
  const table = (r) => `<table><tr>${r.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>${r.rows.slice(0, 200).map((row) => `<tr>${row.map((v) => `<td>${escapeHtml(v instanceof Date ? v.toISOString() : v)}</td>`).join('')}</tr>`).join('')}</table>${r.rows.length > 200 ? `<p class="m">First 200 of ${r.rows.length} rows - full data in results.xlsx</p>` : ''}`;
  fs.writeFileSync(path.join(dir, 'report.html'), `<!doctype html><meta charset="utf-8"><title>Query Runner - ${escapeHtml(env.name)}</title><style>body{font:14px system-ui;margin:24px;color:#1f2937}table{border-collapse:collapse;margin:8px 0 22px;font-size:13px}th,td{border:1px solid #e5e7eb;padding:4px 8px;text-align:left}th{background:#eef2ff}.m{color:#6b7280}.ok{color:#166534}.error{color:#991b1b}</style>
<h1>Query Runner - ${escapeHtml(env.name)}</h1><p class="m">${escapeHtml(cfg.organization.product)} · ${new Date().toLocaleString()} · ${results.length} quer${results.length === 1 ? 'y' : 'ies'}</p>
${results.map((r) => `<h2>#${r.n} ${escapeHtml(r.name)} <small class="${r.status}">${r.status}${r.status === 'ok' ? ` - ${r.rowCount} row(s)` : ''}</small></h2>${r.description ? `<p class="m">${escapeHtml(r.description)}</p>` : ''}${r.status === 'ok' ? (r.rowCount ? table(r) : '<p class="m">No rows.</p>') : `<p class="error">${escapeHtml(r.error)}</p>`}`).join('')}`);

  const ok = results.filter((r) => r.status === 'ok');
  console.log(`✅ ${ok.length} ok · ${results.filter((r) => r.status === 'error').length} failed · ${results.filter((r) => r.status === 'skipped').length} skipped · ${ok.filter((r) => r.rowCount).length} returned rows`);
  console.log(`   ${path.relative(cfg.root, path.join(dir, 'report.html'))}\n   ${path.relative(cfg.root, path.join(dir, 'results.xlsx'))}`);
  if (!ok.length && results.some((r) => r.status === 'error')) process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'list') {
  const all = loadQueries();
  if (!all.length) exitWith(0, `No queries yet. Add .sql files under ${path.relative(cfg.root, QUERIES)}/<category>/ (see queries/README.md).`);
  let cat = '';
  all.forEach((q) => { if (q.category !== cat) { cat = q.category; console.log(`\n${cat.toUpperCase()}${cat === 'setup' ? ' (changes data)' : ''}`); } console.log(`  ${String(q.n).padStart(3)}. ${q.mode === 'write' ? '[WRITE] ' : ''}${q.name}${q.params.length ? `  (needs: ${q.params.join(', ')})` : ''}`); });
} else if (cmd === 'envs') {
  (qr.environments || []).forEach((e, i) => console.log(`  ${i + 1}. ${e.name}  ${e.host}/${e.database}${e.writeAllowed ? '' : '  (read-only)'}`));
} else if (cmd === 'run') {
  run().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
} else {
  console.log('Usage: node scripts/misc/query-runner.js list | envs | run --queries=<sel> --env=<name|number> [--param Name=Value]');
}
