#!/usr/bin/env node
/**
 * QA LEAD - Agent compliance audit for a release. Tool-agnostic: it reads only the
 * marker comments that Agent 2 / Agent 3 post on each requirement.
 *
 *   node scripts/lead/qa-audit.js <release> [--qa="Name"]
 *
 * Per requirement:
 *   PASS     Agent 2 marker + (Agent 3 marker, or automation-exempt marker, or automation not in scope)
 *   PARTIAL  Agent 2 marker but Agent 3 missing (automation in scope, not exempt)
 *   FAIL     no Agent 2 marker
 * Writes output/qa-audit/release-<N>/audit.html + audit.json (FAIL first, open work by QA).
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, taskAdapter, outDir, MARKERS } = require('../core/config');
const { preflight } = require('../core/preflight');
const { arg, positional, escapeHtml, exitWith } = require('../core/util');

(async () => {
  const [release] = positional();
  if (!release) exitWith(1, 'Usage: node scripts/lead/qa-audit.js <release> [--qa="Name"]');
  const cfg = loadConfig();
  const audit = cfg.audit || {};
  const checkA3 = audit.checkAgent3 !== false && cfg.modules.agent3 && cfg.automation?.status !== 'none';
  const types = (audit.requirementTypes || []).map((t) => t.toLowerCase());
  const qaFilter = arg('qa');
  await preflight(cfg, ['task']);
  const task = taskAdapter(cfg);

  let items = await task.adapter.listReleaseItems(task.ctx, release);
  if (types.length) items = items.filter((i) => types.includes(String(i.type).toLowerCase()));
  if (qaFilter && qaFilter !== true) items = items.filter((i) => String(i.qaAssignee?.name || '').toLowerCase().includes(String(qaFilter).toLowerCase()));

  const rows = [];
  for (const wi of items) {
    const comments = await task.adapter.getComments(task.ctx, wi.id).catch(() => []);
    const has = (m) => comments.find((c) => c.text.includes(m));
    const a2 = has(MARKERS.agent2);
    const ex = has(MARKERS.exempt);
    const a3 = has(MARKERS.agent3);
    let status = 'PASS';
    let note = '';
    if (!a2) { status = 'FAIL'; note = 'No test plan created by Agent 2'; }
    else if (checkA3 && !ex && !a3) { status = 'PARTIAL'; note = 'Test plan exists, feature file not delivered by Agent 3'; }
    else if (ex) note = 'Automation exempt';
    rows.push({ id: wi.id, type: wi.type, title: wi.title, state: wi.state, url: wi.url, qa: wi.qaAssignee?.name || '(unassigned)', status, note, agent2At: a2?.date || null, agent3At: a3?.date || null, exempt: !!ex });
    process.stdout.write(status === 'PASS' ? '.' : status === 'PARTIAL' ? 'p' : 'F');
  }
  console.log('');
  const order = { FAIL: 0, PARTIAL: 1, PASS: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status] || a.qa.localeCompare(b.qa));
  const count = (s) => rows.filter((r) => r.status === s).length;
  const byQa = {};
  rows.forEach((r) => { byQa[r.qa] = byQa[r.qa] || { PASS: 0, PARTIAL: 0, FAIL: 0 }; byQa[r.qa][r.status]++; });

  const dir = outDir('qa-audit', `release-${release}`);
  fs.writeFileSync(path.join(dir, 'audit.json'), JSON.stringify({ release, generatedAt: new Date().toISOString(), checkAgent3: checkA3, rows }, null, 2));
  const pct = rows.length ? Math.round((count('PASS') / rows.length) * 100) : 0;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>QA Audit - Release ${escapeHtml(release)}</title><style>
body{font:14px system-ui,sans-serif;margin:24px;color:#1f2937}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left}th{background:#f3f4f6}
.s{padding:2px 8px;border-radius:10px;font-weight:600;font-size:12px}.FAIL{background:#fee2e2;color:#991b1b}.PARTIAL{background:#fef3c7;color:#92400e}.PASS{background:#dcfce7;color:#166534}
.cards{display:flex;gap:10px}.card{border:1px solid #e5e7eb;border-radius:8px;padding:10px 16px}.card b{display:block;font-size:22px}</style></head><body>
<h1>QA Agent Compliance - Release ${escapeHtml(release)}</h1><p>${escapeHtml(cfg.organization?.product || '')} · ${new Date().toISOString().slice(0, 10)} · Agent 3 ${checkA3 ? 'checked' : 'not in scope'}${qaFilter && qaFilter !== true ? ` · QA filter: ${escapeHtml(qaFilter)}` : ''}</p>
<div class="cards"><div class="card"><b>${pct}%</b>compliant</div><div class="card"><b>${count('FAIL')}</b>FAIL</div><div class="card"><b>${count('PARTIAL')}</b>PARTIAL</div><div class="card"><b>${count('PASS')}</b>PASS</div></div>
<h2>Open work by QA</h2><table><tr><th>QA</th><th>FAIL</th><th>PARTIAL</th><th>PASS</th></tr>${Object.entries(byQa).sort((a, b) => (b[1].FAIL + b[1].PARTIAL) - (a[1].FAIL + a[1].PARTIAL)).map(([q, c]) => `<tr><td>${escapeHtml(q)}</td><td>${c.FAIL}</td><td>${c.PARTIAL}</td><td>${c.PASS}</td></tr>`).join('')}</table>
<h2>Requirements</h2><table><tr><th>Status</th><th>ID</th><th>Type</th><th>Title</th><th>QA</th><th>State</th><th>Note</th></tr>${rows.map((r) => `<tr><td><span class="s ${r.status}">${r.status}</span></td><td><a href="${escapeHtml(r.url || '#')}" target="_blank">${escapeHtml(r.id)}</a></td><td>${escapeHtml(r.type)}</td><td>${escapeHtml(r.title)}</td><td>${escapeHtml(r.qa)}</td><td>${escapeHtml(r.state)}</td><td>${escapeHtml(r.note)}</td></tr>`).join('')}</table></body></html>`;
  fs.writeFileSync(path.join(dir, 'audit.html'), html);
  console.log(`✅ Audit - ${rows.length} requirement(s): ${count('FAIL')} FAIL · ${count('PARTIAL')} PARTIAL · ${count('PASS')} PASS (${pct}% compliant)`);
  console.log(`   ${path.relative(cfg.root, path.join(dir, 'audit.html'))}`);
})().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
