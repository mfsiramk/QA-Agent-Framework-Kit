#!/usr/bin/env node
/**
 * QA LEAD - Bug report: what is open, how severe, where, who, how old.
 *
 * Triggers: "Bug report for release <N>", "Open bugs report", "Bugs in the last 30 days".
 *
 *   node scripts/lead/bug-report.js --release=12        bugs in a release
 *   node scripts/lead/bug-report.js --days=30           bugs created in the last N days
 *   node scripts/lead/bug-report.js --open              every open bug
 *   ... [--types="Bug,Prod Bug"] [--publish]            --publish = also update the Confluence page
 *
 * Writes output/bug-reports/<scope>/report.html + bugs.xlsx (+ Confluence page with --publish).
 * Read-only on the task tool.
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, taskAdapter, docsAdapters, outDir } = require('../core/config');
const { preflight } = require('../core/preflight');
const { escapeHtml, exitWith } = require('../core/util');

const cfg = loadConfig();
const br = cfg.bugReport;
if (!br || !cfg.modules.bugReport) exitWith(1, 'ℹ️  Bug Report is not enabled for this installation. Re-run the setup wizard to add it.');
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : process.argv.includes(`--${n}`); };

const DIM_LABEL = { severity: 'Severity', state: 'State', module: 'Module', assignee: 'Assigned to', reporter: 'Reported by', environment: 'Environment', release: 'Release', age: 'Age (open bugs)' };
const AGE = [[7, '0-7 days'], [30, '8-30 days'], [90, '31-90 days'], [Infinity, '90+ days']];

function moduleOf(b) {
  if (br.moduleSource === 'titlePrefix') { const m = String(b.title).match(/^\s*\[([^\]]+)\]/) || String(b.title).match(/^\s*([A-Z][\w &/-]{2,30}):/); return m ? m[1].trim() : 'Not tagged'; }
  if (br.moduleSource === 'tags') return (b.tags || []).find((t) => (br.moduleTags || []).length ? br.moduleTags.includes(t) : true) || 'Not tagged';
  const c = String(b.component || '');
  return c ? c.split(/[\\/]/).filter(Boolean).slice(-1)[0] : 'Not set';
}

(async () => {
  const release = arg('release');
  const days = arg('days');
  const scope = release && release !== true ? { key: `release-${release}`, label: `Release ${release}` }
    : days && days !== true ? { key: `last-${days}-days`, label: `Created in the last ${days} days` }
      : arg('open') || br.defaultScope === 'open' ? { key: 'open', label: 'All open bugs' }
        : br.defaultScope === 'days' ? { key: `last-${br.days || 30}-days`, label: `Created in the last ${br.days || 30} days` } : null;
  if (!scope) exitWith(2, 'SCOPE_REQUIRED', ['Ask the lead: which release, how many days back, or all open bugs?']);
  const types = arg('types') && arg('types') !== true ? String(arg('types')).split(',').map((s) => s.trim()) : (br.types || ['Bug']);
  const closed = (br.closedStates || []).map((s) => s.toLowerCase());

  await preflight(cfg, ['task']);
  const task = taskAdapter(cfg);
  const q = { types, max: 5000 };
  if (scope.key.startsWith('release-')) q.release = release;
  if (scope.key.startsWith('last-')) q.createdFrom = new Date(Date.now() - Number(scope.key.split('-')[1]) * 864e5).toISOString().slice(0, 10);
  if (scope.key === 'open') q.notStates = br.closedStates || [];
  const items = await task.adapter.searchItems(task.ctx, q);

  const sevOrder = br.severityValues?.length ? br.severityValues : (cfg.bugFiling?.fields?.severity?.values || []);
  const now = Date.now();
  const bugs = items.map((b) => {
    const open = !closed.includes(String(b.state).toLowerCase());
    const ageDays = b.createdDate ? Math.floor(((open ? now : Date.parse(b.closedDate || b.changedDate || now)) - Date.parse(b.createdDate)) / 864e5) : null;
    return {
      id: b.id, title: b.title, type: b.type, url: b.url, state: b.state, open,
      severity: b.severity || 'Not set', priority: b.priority || '', module: moduleOf(b),
      assignee: b.assignee?.name || 'Unassigned', reporter: b.createdBy?.name || 'Unknown', environment: b.environment || 'Not set', release: b.release || '',
      created: (b.createdDate || '').slice(0, 10), ageDays, age: open && ageDays != null ? AGE.find(([d]) => ageDays <= d)[1] : '',
    };
  });
  const open = bugs.filter((b) => b.open);
  const sevRank = (s) => { const i = sevOrder.findIndex((v) => v.toLowerCase() === String(s).toLowerCase()); return i < 0 ? 99 : i; };
  bugs.sort((a, b) => Number(b.open) - Number(a.open) || sevRank(a.severity) - sevRank(b.severity) || (b.ageDays || 0) - (a.ageDays || 0));

  const dims = (br.dimensions || ['severity', 'state', 'module', 'assignee', 'age']).filter((d) => DIM_LABEL[d]);
  const group = (key, list) => { const m = new Map(); list.forEach((b) => { const k = b[key] || 'Not set'; m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].sort((a, b) => (key === 'severity' ? sevRank(a[0]) - sevRank(b[0]) : key === 'age' ? AGE.findIndex(([, l]) => l === a[0]) - AGE.findIndex(([, l]) => l === b[0]) : b[1] - a[1])); };
  const sevs = [...new Set(open.map((b) => b.severity))].sort((a, b) => sevRank(a) - sevRank(b));
  const mods = group('module', open).map(([k]) => k);
  const top = sevs[0];

  const dir = outDir('bug-reports', scope.key);
  const card = (n, l, cls = '') => `<div class="card ${cls}"><b>${n}</b>${l}</div>`;
  const tbl = (head, rows) => `<table><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
  const matrix = mods.length && sevs.length ? tbl(['Module', ...sevs, 'Total'], mods.map((m) => [escapeHtml(m), ...sevs.map((s) => open.filter((b) => b.module === m && b.severity === s).length || ''), `<b>${open.filter((b) => b.module === m).length}</b>`])) : '<p>No open bugs.</p>';
  const breakdowns = dims.map((d) => `<div class="dim"><h3>${DIM_LABEL[d]}</h3>${tbl([DIM_LABEL[d], 'Bugs'], group(d, d === 'age' ? open : bugs).map(([k, n]) => [escapeHtml(k), n]))}</div>`).join('');
  const listRows = bugs.map((b) => [`<a href="${escapeHtml(b.url)}" target="_blank">${escapeHtml(b.id)}</a>`, escapeHtml(b.title), escapeHtml(b.severity), escapeHtml(b.state), escapeHtml(b.module), escapeHtml(b.assignee), escapeHtml(b.reporter), b.created, b.open ? (b.ageDays ?? '') : '']);
  const style = 'body{font:14px system-ui;margin:24px;color:#1f2937}table{border-collapse:collapse;margin:8px 0 18px;font-size:13px}th,td{border:1px solid #e5e7eb;padding:4px 8px;text-align:left;vertical-align:top}th{background:#eef2ff}.cards{display:flex;gap:10px;flex-wrap:wrap}.card{border:1px solid #e5e7eb;border-radius:10px;padding:10px 16px;min-width:110px}.card b{display:block;font-size:24px}.card.red{border-color:#fecaca;background:#fef2f2}.dims{display:flex;gap:24px;flex-wrap:wrap}input{padding:6px;width:280px}';
  const html = `<!doctype html><meta charset="utf-8"><title>Bug report - ${escapeHtml(scope.label)}</title><style>${style}</style>
<h1>Bug report - ${escapeHtml(scope.label)}</h1><p>${escapeHtml(cfg.organization.product)} · ${types.map(escapeHtml).join(', ')} · generated ${new Date().toLocaleString()}</p>
<div class="cards">${card(bugs.length, 'total')}${card(open.length, 'open', open.length ? 'red' : '')}${card(bugs.length - open.length, 'closed')}${top ? card(open.filter((b) => b.severity === top).length, `open ${escapeHtml(top)}`, 'red') : ''}${card(open.filter((b) => (b.ageDays || 0) > 30).length, 'open > 30 days')}</div>
<h2>Open bugs: module × severity</h2>${matrix}
<h2>Breakdown</h2><div class="dims">${breakdowns}</div>
<h2>All bugs</h2><input id="q" placeholder="Filter…">${tbl(['ID', 'Title', 'Severity', 'State', 'Module', 'Assigned to', 'Reported by', 'Created', 'Age (days)'], listRows)}
<script>document.getElementById('q').oninput=e=>{const v=e.target.value.toLowerCase();document.querySelectorAll('table:last-of-type tr').forEach((r,i)=>{if(i)r.style.display=r.textContent.toLowerCase().includes(v)?'':'none'})}</script>`;
  fs.writeFileSync(path.join(dir, 'report.html'), html);

  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bugs.map(({ url, open: o, ...b }) => ({ ...b, open: o ? 'Yes' : 'No', url }))), 'Bugs');
  dims.forEach((d) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[DIM_LABEL[d], 'Bugs'], ...group(d, d === 'age' ? open : bugs)]), DIM_LABEL[d].slice(0, 31)));
  XLSX.writeFile(wb, path.join(dir, 'bugs.xlsx'));

  let published = null;
  if (arg('publish')) {
    const conf = docsAdapters(cfg).find((p) => p.adapter.id === 'confluence');
    if (!br.publish?.spaceKey || !conf || typeof conf.adapter.upsertPage !== 'function') console.log('⚠️  Publishing skipped: Confluence publishing is not set up (re-run the wizard: QA lead setup → Bug report → publish).');
    else {
      const storage = `<p>${escapeHtml(cfg.organization.product)} - ${escapeHtml(scope.label)} - refreshed ${new Date().toLocaleString()}</p><p><strong>${open.length}</strong> open of <strong>${bugs.length}</strong></p><h2>Open bugs: module × severity</h2>${matrix.replace(/<b>|<\/b>/g, '')}<h2>Open bugs</h2>${tbl(['ID', 'Title', 'Severity', 'State', 'Module', 'Assigned to', 'Age (days)'], open.map((b) => [`<a href="${escapeHtml(b.url)}">${escapeHtml(b.id)}</a>`, escapeHtml(b.title), escapeHtml(b.severity), escapeHtml(b.state), escapeHtml(b.module), escapeHtml(b.assignee), b.ageDays ?? '']))}`;
      published = await conf.adapter.upsertPage(conf.ctx, { spaceKey: br.publish.spaceKey, parentId: br.publish.parentPageId, title: `${br.publish.titlePrefix || 'Bug report'} - ${scope.label}`, html: storage });
    }
  }

  console.log(`✅ Bug report - ${scope.label}: ${bugs.length} bug(s), ${open.length} open${top ? `, ${open.filter((b) => b.severity === top).length} open ${top}` : ''}, ${open.filter((b) => (b.ageDays || 0) > 30).length} open > 30 days`);
  console.log(`   ${path.relative(cfg.root, path.join(dir, 'report.html'))}\n   ${path.relative(cfg.root, path.join(dir, 'bugs.xlsx'))}`);
  if (published) console.log(`   Confluence: ${published.created ? 'created' : 'updated'} ${published.url}`);
})().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
