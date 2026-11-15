#!/usr/bin/env node
/**
 * QA LEAD - Release QA assignment PLAN (never writes to the task tool).
 *
 *   node scripts/lead/qa-assignment-plan.js <release>             query tool → plan.json + plan.html
 *   node scripts/lead/qa-assignment-plan.js <release> --from-json re-render plan.html from edited plan.json
 *
 * Rules, in priority order (roster in qa-framework.config.json → qaLead):
 *   BugAuthor          bug filed by a roster QA → that QA
 *   SubjectMatter      per-QA subject keywords (title / tags / component)
 *   Reserved           reserved-pool QA keywords (they stay out of the general pool)
 *   Existing           ticket already has a roster QA in the QA field → keep
 *   CommentInvolvement most recent roster commenter (optional, slower)
 *   Cluster            same parent as an already-assigned ticket → same QA
 *   Balance            fewest tickets in the general pool, story points as tiebreak
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, taskAdapter, outDir } = require('../core/config');
const { preflight } = require('../core/preflight');
const { arg, positional, escapeHtml, exitWith } = require('../core/util');

const lc = (s) => String(s || '').toLowerCase();
const samePerson = (p, r) => p && r && (lc(p.id) === lc(r.id) || lc(p.name) === lc(r.name));

function hay(wi, fields = ['title', 'tags', 'component']) {
  return fields.map((f) => (f === 'tags' ? (wi.tags || []).join(' ') : wi[f] || '')).join(' | ').toLowerCase();
}
const hits = (text, keywords) => (keywords || []).find((k) => k && text.includes(lc(k)));

async function buildPlan(cfg, release) {
  const task = taskAdapter(cfg);
  const lead = cfg.qaLead || {};
  const roster = (lead.roster || []).filter((r) => r.pool !== 'excluded');
  if (!roster.length) exitWith(1, '❌ The QA roster is empty. Add people in qa-framework.config.json → qaLead.roster (or re-run the installer).');
  const general = roster.filter((r) => r.pool === 'general');
  const items = await task.adapter.listReleaseItems(task.ctx, release);
  const byId = new Map(items.map((i) => [String(i.id), i]));
  const load = new Map(roster.map((r) => [r.name, { count: 0, points: 0 }]));
  const assign = (wi, qa, rule, reason) => {
    const l = load.get(qa.name); if (l) { l.count++; l.points += wi.storyPoints || 0; }
    return { id: String(wi.id), type: wi.type, title: wi.title, state: wi.state, url: wi.url, parentId: wi.parentId, storyPoints: wi.storyPoints, component: wi.component, tags: wi.tags, currentQa: wi.qaAssignee?.name || '', proposedQa: qa.name, proposedQaId: qa.id, rule, reason };
  };
  const rows = new Map();
  const bugTypes = (lead.bugTypes || ['Bug']).map(lc);

  for (const wi of items) {
    const text = hay(wi);
    if (lead.bugAuthorRouting !== false && bugTypes.includes(lc(wi.type))) {
      const author = roster.find((r) => samePerson(wi.createdBy, r));
      if (author) { rows.set(String(wi.id), assign(wi, author, 'BugAuthor', `Filed by ${author.name}`)); continue; }
    }
    const sm = roster.map((r) => ({ r, k: hits(text, r.subjectKeywords) })).find((x) => x.k);
    if (sm) { rows.set(String(wi.id), assign(wi, sm.r, 'SubjectMatter', `Keyword "${sm.k}"`)); continue; }
    const rs = roster.filter((r) => r.pool === 'reserved').map((r) => ({ r, k: hits(text, r.reservedKeywords) })).find((x) => x.k);
    if (rs) { rows.set(String(wi.id), assign(wi, rs.r, 'Reserved', `Reserved keyword "${rs.k}"`)); continue; }
    const existing = roster.find((r) => samePerson(wi.qaAssignee, r));
    if (existing) { rows.set(String(wi.id), assign(wi, existing, 'Existing', 'Already assigned in the tool')); continue; }
  }

  if (lead.commentInvolvement) {
    for (const wi of items.filter((w) => !rows.has(String(w.id)))) {
      const comments = await task.adapter.getComments(task.ctx, wi.id).catch(() => []);
      const last = [...comments].reverse().find((c) => roster.some((r) => samePerson(c.author, r)));
      if (last) { const r = roster.find((x) => samePerson(last.author, x)); rows.set(String(wi.id), assign(wi, r, 'CommentInvolvement', `Last roster commenter (${last.date?.slice(0, 10)})`)); }
    }
  }

  const pool = general.length ? general : roster;
  const remaining = items.filter((w) => !rows.has(String(w.id))).sort((a, b) => (b.storyPoints || 0) - (a.storyPoints || 0));
  for (const wi of remaining) {
    const sibling = wi.parentId && [...rows.values()].find((r) => r.parentId && String(r.parentId) === String(wi.parentId));
    const parentRow = wi.parentId && rows.get(String(wi.parentId));
    const anchor = parentRow || sibling;
    if (anchor) { const r = roster.find((x) => x.name === anchor.proposedQa); if (r) { rows.set(String(wi.id), assign(wi, r, 'Cluster', `Same parent as ${anchor.id}`)); continue; } }
    const pick = [...pool].sort((a, b) => load.get(a.name).count - load.get(b.name).count || load.get(a.name).points - load.get(b.name).points)[0];
    rows.set(String(wi.id), assign(wi, pick, 'Balance', `Lowest load (${load.get(pick.name).count} tickets)`));
  }
  void byId;
  return { release: String(release), generatedAt: new Date().toISOString(), tool: task.adapter.id, roster: roster.map((r) => ({ name: r.name, id: r.id, pool: r.pool })), items: [...rows.values()] };
}

function renderHtml(plan) {
  const names = plan.roster.map((r) => r.name);
  const counts = {};
  plan.items.forEach((i) => { counts[i.proposedQa] = (counts[i.proposedQa] || 0) + 1; });
  const rows = plan.items.map((i) => `<tr data-id="${escapeHtml(i.id)}" data-rule="${escapeHtml(i.rule)}"><td><a href="${escapeHtml(i.url || '#')}" target="_blank">${escapeHtml(i.id)}</a></td><td>${escapeHtml(i.type)}</td><td>${escapeHtml(i.title)}</td><td>${escapeHtml(i.currentQa)}</td><td><select>${names.map((n) => `<option${n === i.proposedQa ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('')}</select></td><td><span class="b b-${escapeHtml(i.rule)}">${escapeHtml(i.rule)}</span></td><td>${escapeHtml(i.reason)}</td><td>${i.storyPoints ?? ''}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>QA Assignment - Release ${escapeHtml(plan.release)}</title><style>
body{font:14px system-ui,sans-serif;margin:24px;color:#1f2937}h1{margin:0 0 4px}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3f4f6;position:sticky;top:0}
.cards{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.card{border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px}.card b{font-size:18px;display:block}
.b{padding:2px 8px;border-radius:10px;font-size:12px;background:#e5e7eb}.b-BugAuthor{background:#fee2e2}.b-SubjectMatter{background:#dbeafe}.b-Reserved{background:#ede9fe}.b-Existing{background:#dcfce7}.b-CommentInvolvement{background:#fef3c7}.b-Cluster{background:#cffafe}.b-Manual{background:#fde68a}
button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer}input{padding:6px;width:260px}tr.changed td{background:#fffbeb}</style></head><body>
<h1>QA Assignment - Release ${escapeHtml(plan.release)}</h1><div>${plan.items.length} tickets · generated ${escapeHtml(plan.generatedAt)} · nothing has been written to the tool yet</div>
<div class="cards">${names.map((n) => `<div class="card"><b>${counts[n] || 0}</b>${escapeHtml(n)}</div>`).join('')}</div>
<input id="q" placeholder="Filter by text…"> <button id="save">Save edited plan.json</button>
<p>Change any dropdown, click <b>Save</b>, replace <code>output/qa-assignments/release-${escapeHtml(plan.release)}/plan.json</code> with the downloaded file, then tell the assistant <b>"verify plan.json"</b>.</p>
<table><thead><tr><th>ID</th><th>Type</th><th>Title</th><th>Current QA</th><th>Proposed QA</th><th>Rule</th><th>Why</th><th>SP</th></tr></thead><tbody>${rows}</tbody></table>
<script>const plan=${JSON.stringify(plan).replace(/</g, '\\u003c')};
document.querySelectorAll('tbody select').forEach(s=>s.addEventListener('change',e=>e.target.closest('tr').classList.add('changed')));
document.getElementById('q').addEventListener('input',e=>{const v=e.target.value.toLowerCase();document.querySelectorAll('tbody tr').forEach(r=>r.style.display=r.textContent.toLowerCase().includes(v)?'':'none')});
document.getElementById('save').onclick=()=>{document.querySelectorAll('tbody tr').forEach(r=>{const it=plan.items.find(i=>i.id===r.dataset.id);const v=r.querySelector('select').value;if(it.proposedQa!==v){it.proposedQa=v;it.proposedQaId=(plan.roster.find(x=>x.name===v)||{}).id;it.rule='Manual';it.reason='Edited by QA lead';}});
const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(plan,null,2)],{type:'application/json'}));a.download='plan.json';a.click();};</script></body></html>`;
}

module.exports = { buildPlan, renderHtml };

if (require.main === module) {
  (async () => {
    const [release] = positional();
    if (!release) exitWith(1, 'Usage: node scripts/lead/qa-assignment-plan.js <release> [--from-json]');
    const cfg = loadConfig();
    const dir = outDir('qa-assignments', `release-${release}`);
    const jsonFile = path.join(dir, 'plan.json');
    let plan;
    if (arg('from-json')) {
      if (!fs.existsSync(jsonFile)) exitWith(1, `❌ ${jsonFile} not found - run the plan first.`);
      plan = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      const names = new Set(plan.roster.map((r) => r.name));
      const bad = plan.items.filter((i) => !names.has(i.proposedQa));
      if (bad.length) exitWith(1, `❌ ${bad.length} ticket(s) have a QA not in the roster: ${bad.slice(0, 5).map((b) => b.id).join(', ')}`);
    } else {
      await preflight(cfg, ['task']);
      plan = await buildPlan(cfg, release);
      fs.writeFileSync(jsonFile, JSON.stringify(plan, null, 2));
    }
    fs.writeFileSync(path.join(dir, 'plan.html'), renderHtml(plan));
    const byRule = {};
    plan.items.forEach((i) => { byRule[i.rule] = (byRule[i.rule] || 0) + 1; });
    console.log(`✅ Plan ${arg('from-json') ? 're-rendered' : 'written'} - ${plan.items.length} ticket(s)`);
    console.log(`   Rules: ${Object.entries(byRule).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    console.log(`   ${path.relative(cfg.root, jsonFile)}\n   ${path.relative(cfg.root, path.join(dir, 'plan.html'))}`);
  })().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
