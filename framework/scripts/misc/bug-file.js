#!/usr/bin/env node
/**
 * BUG FILING - draft a well-formed bug, check for duplicates, then file it after approval.
 *
 * Triggers: "File a bug", "Log a bug for <story>", "Raise a defect".
 *
 *   node scripts/misc/bug-file.js preview --input=output/bugs/<slug>.json
 *        → validates, checks for open duplicates, writes output/bugs/<slug>.html (the draft)
 *   node scripts/misc/bug-file.js file --input=output/bugs/<slug>.json --confirm [--ignore-duplicates]
 *        → creates the bug, attaches screenshots, comments on the linked story
 *
 * Input JSON (written by the assistant from what the QA described):
 *   { "title", "type"?, "severity", "priority"?, "environment"?, "foundIn"?, "component"?,
 *     "summary", "steps": ["..."], "expected", "actual", "testData"?, "frequency"?, "impact"?,
 *     "linkTo"?: { "id": "<story id>", "rel": "related|parent|tested-by" },
 *     "attachments"?: ["path/to/screenshot.png"], "tags"?: [] }
 *
 * Exit: 0 ok | 1 error | 2 needs the QA (MISSING_FIELDS, INVALID_VALUE, POSSIBLE_DUPLICATES,
 *       CONFIRM_REQUIRED, ALREADY_FILED) | 4 CREDENTIALS_INVALID
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, taskAdapter, outDir } = require('../core/config');
const { preflight } = require('../core/preflight');
const { escapeHtml, similarity, exitWith } = require('../core/util');

const cfg = loadConfig();
const bf = cfg.bugFiling;
if (!bf || !cfg.modules.bugFiling) exitWith(1, 'ℹ️  Bug Filing is not enabled for this installation. Re-run the setup wizard to add it.');

const SECTION_LABEL = { summary: 'Summary', steps: 'Steps to reproduce', expected: 'Expected result', actual: 'Actual result', environment: 'Environment', testData: 'Test data', attachments: 'Screenshots / logs', frequency: 'Frequency', impact: 'Business impact' };
const REQUIRED = { summary: (b) => b.summary, steps: (b) => (b.steps || []).length, expected: (b) => b.expected, actual: (b) => b.actual, environment: (b) => b.environment, testData: (b) => b.testData, attachments: () => true, frequency: (b) => b.frequency, impact: (b) => b.impact };
const STOP = new Set('the a an and or of to in on for with is are be when after before then not no from at by as it this that user page screen button error issue bug'.split(' '));

function arg(n) { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : process.argv.includes(`--${n}`); }

function load() {
  const file = arg('input');
  if (!file || file === true || !fs.existsSync(file)) exitWith(1, 'Usage: --input=output/bugs/<slug>.json (file not found)');
  return { file, bug: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function validate(bug) {
  const sections = bf.sections || Object.keys(SECTION_LABEL);
  const missing = [];
  if (!bug.title || String(bug.title).trim().length < 10) missing.push('title (a specific one-line summary, 10+ characters)');
  sections.forEach((s) => { if (REQUIRED[s] && !REQUIRED[s](bug)) missing.push(SECTION_LABEL[s]); });
  if (bf.fields?.severity?.field && !bug.severity) missing.push('severity');
  if (missing.length) exitWith(2, 'MISSING_FIELDS', [`Ask the QA for: ${missing.join(', ')}.`]);
  for (const k of ['severity', 'priority', 'environment']) {
    const allowed = bf.fields?.[k]?.values || [];
    if (bug[k] && allowed.length && !allowed.some((v) => v.toLowerCase() === String(bug[k]).toLowerCase())) {
      exitWith(2, 'INVALID_VALUE', [`${k} "${bug[k]}" is not one of: ${allowed.join(', ')}. Ask the QA which one applies.`]);
    }
    if (bug[k] && allowed.length) bug[k] = allowed.find((v) => v.toLowerCase() === String(bug[k]).toLowerCase());
  }
  for (const p of bug.attachments || []) if (!fs.existsSync(path.resolve(cfg.root, p))) exitWith(2, 'MISSING_FIELDS', [`Attachment not found: ${p}`]);
  bug.type = bug.type || bf.types?.[0] || 'Bug';
}

function markdown(bug) {
  const out = [];
  for (const s of bf.sections || Object.keys(SECTION_LABEL)) {
    if (s === 'summary' && bug.summary) out.push(`## Summary\n${bug.summary}`);
    if (s === 'steps' && bug.steps?.length) out.push(`## Steps to reproduce\n${bug.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}`);
    if (s === 'expected' && bug.expected) out.push(`## Expected result\n${bug.expected}`);
    if (s === 'actual' && bug.actual) out.push(`## Actual result\n${bug.actual}`);
    if (s === 'environment' && (bug.environment || bug.foundIn)) out.push(`## Environment\n${[bug.environment && `Environment: ${bug.environment}`, bug.foundIn && `Build / release: ${bug.foundIn}`].filter(Boolean).join('\n')}`);
    if (s === 'testData' && bug.testData) out.push(`## Test data\n${bug.testData}`);
    if (s === 'frequency' && bug.frequency) out.push(`## Frequency\n${bug.frequency}`);
    if (s === 'impact' && bug.impact) out.push(`## Business impact\n${bug.impact}`);
    if (s === 'attachments' && bug.attachments?.length) out.push(`## Screenshots / logs\n${bug.attachments.map((a) => `- ${path.basename(a)}`).join('\n')}`);
  }
  if (bug.linkTo?.id) out.push(`Found while testing: ${bug.linkTo.id}`);
  out.push('_Filed with QA Agent Bug Filing._');
  return out.join('\n\n');
}

async function duplicates(task, bug) {
  if (bf.duplicateCheck === false || typeof task.adapter.searchItems !== 'function') return [];
  const words = String(bug.title).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  const key = words.sort((a, b) => b.length - a.length).slice(0, 2);
  const seen = new Map();
  for (const w of key) {
    try {
      for (const it of await task.adapter.searchItems(task.ctx, { types: bf.types || ['Bug'], notStates: bf.closedStates || [], text: w, max: 200 })) seen.set(String(it.id), it);
    } catch (e) { console.log(`   ⚠️ duplicate check skipped: ${e.message}`); return []; }
  }
  return [...seen.values()].map((it) => ({ id: it.id, title: it.title, state: it.state, url: it.url, score: similarity(bug.title, it.title) })).filter((x) => x.score >= 0.45).sort((a, b) => b.score - a.score).slice(0, 5);
}

function draftHtml(bug, md, dups) {
  const meta = [['Type', bug.type], ['Severity', bug.severity], ['Priority', bug.priority], ['Environment', bug.environment], ['Found in', bug.foundIn], ['Component', bug.component || bf.defaults?.component], ['Assign to', bf.defaults?.assignee?.name], ['Linked to', bug.linkTo?.id], ['Tags', [...(bf.defaults?.tags || []), ...(bug.tags || [])].join(', ')]].filter(([, v]) => v);
  const body = escapeHtml(md).replace(/^## (.+)$/gm, '<h3>$1</h3>').replace(/^(\d+)\. (.+)$/gm, '<div class="s">$1. $2</div>').replace(/^- (.+)$/gm, '<div class="s">• $1</div>').replace(/\n/g, '<br>');
  return `<!doctype html><meta charset="utf-8"><title>Bug draft - ${escapeHtml(bug.title)}</title><style>body{font:14px/1.5 system-ui;margin:24px;max-width:900px;color:#1f2937}table{border-collapse:collapse}td{padding:3px 12px 3px 0}td:first-child{color:#6b7280}.d{background:#fffbeb;border:1px solid #fde68a;padding:10px 14px;border-radius:8px}.box{border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;margin-top:14px}h3{margin:14px 0 4px}</style>
<p><b>DRAFT - not filed yet.</b> Review, then tell the assistant "file it".</p><h1>${escapeHtml(bug.title)}</h1><table>${meta.map(([k, v]) => `<tr><td>${k}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
${dups.length ? `<div class="d"><b>Possible duplicates (open):</b><ul>${dups.map((d) => `<li><a href="${escapeHtml(d.url)}" target="_blank">${escapeHtml(d.id)}</a> ${escapeHtml(d.title)} - ${escapeHtml(d.state)} (${Math.round(d.score * 100)}% similar)</li>`).join('')}</ul></div>` : ''}
<div class="box">${body}</div>`;
}

async function main() {
  const cmd = process.argv[2];
  const { file, bug } = load();
  validate(bug);
  const md = markdown(bug);
  await preflight(cfg, ['task'], { quiet: true });
  const task = taskAdapter(cfg);

  if (cmd === 'preview') {
    const dups = await duplicates(task, bug);
    const html = path.join(outDir('bugs'), `${path.basename(file, '.json')}.html`);
    fs.writeFileSync(html, draftHtml(bug, md, dups));
    fs.writeFileSync(file, JSON.stringify({ ...bug, possibleDuplicates: dups }, null, 2));
    console.log(`📝 Draft ready: ${path.relative(cfg.root, html)}`);
    console.log(`   ${bug.type} · severity ${bug.severity || '-'} · ${bug.steps?.length || 0} steps · ${(bug.attachments || []).length} attachment(s)`);
    if (dups.length) exitWith(2, 'POSSIBLE_DUPLICATES', dups.map((d) => `   • ${d.id} ${d.title} (${d.state}, ${Math.round(d.score * 100)}% similar) ${d.url || ''}`).concat(['Ask the QA: is this one of these (add a comment there instead), or a new bug?']));
    console.log('➡️  Show the QA the draft, then file it only after they say yes.');
    return;
  }

  if (cmd === 'file') {
    if (bug.filed?.id && !arg('force')) exitWith(2, 'ALREADY_FILED', [`This draft was already filed as ${bug.filed.id} ${bug.filed.url || ''}.`]);
    if (!arg('confirm')) exitWith(2, 'CONFIRM_REQUIRED', ['Show the draft to the QA and re-run with --confirm after they approve.']);
    if (bug.possibleDuplicates?.length && !arg('ignore-duplicates')) exitWith(2, 'POSSIBLE_DUPLICATES', ['The draft has possible duplicates. If the QA confirmed it is new, re-run with --ignore-duplicates.']);
    const r = await task.adapter.createBug(task.ctx, {
      type: bug.type, title: bug.title, description: md,
      fields: { severity: bug.severity, priority: bug.priority, environment: bug.environment, foundIn: bug.foundIn, component: bug.component || bf.defaults?.component, assignee: bf.defaults?.assignee?.name ? bf.defaults.assignee : undefined },
      tags: [...(bf.defaults?.tags || []), ...(bug.tags || [])],
      linkTo: bug.linkTo?.id && bf.linkToStory !== false ? { id: bug.linkTo.id, rel: bug.linkTo.rel || bf.linkRel || 'related' } : undefined,
    });
    const notes = [...(r.warnings || [])];
    for (const a of bug.attachments || []) {
      try { await task.adapter.attachFile(task.ctx, r.id, path.resolve(cfg.root, a)); } catch (e) { notes.push(`Attachment ${path.basename(a)} not uploaded: ${e.message}`); }
    }
    if (bug.linkTo?.id && bf.commentOnStory !== false) {
      try { await task.adapter.addComment(task.ctx, bug.linkTo.id, `Bug filed: ${r.id} - ${bug.title}${r.url ? `\n${r.url}` : ''}`); } catch (e) { notes.push(`Comment on ${bug.linkTo.id} not posted: ${e.message}`); }
    }
    fs.writeFileSync(file, JSON.stringify({ ...bug, filed: { id: r.id, url: r.url, at: new Date().toISOString(), notes } }, null, 2));
    console.log(`✅ Filed ${bug.type} ${r.id}: ${bug.title}\n   ${r.url || ''}`);
    notes.forEach((n) => console.log(`   ⚠️ ${n}`));
    return;
  }
  exitWith(1, 'Usage: node scripts/misc/bug-file.js preview|file --input=<json> [--confirm]');
}

main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
