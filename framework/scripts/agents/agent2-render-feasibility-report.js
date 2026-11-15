/**
 * Agent 2 - Automation Feasibility Report renderer (STEP 1.5 advisory)
 *
 * When agent2-push-test-plan.js exits 2 with NO_AUTOMATION_TAG, Claude assesses
 * every test case for automation feasibility, scans the automation repo for existing
 * scenarios, and writes its findings to:
 *     <Excel folder>/automation-feasibility-<workItemId>.json
 * This script validates that JSON and renders a self-contained HTML report next to it:
 *     <Excel folder>/automation-feasibility-<workItemId>.html
 * If the user still exempts, the HTML is attached to the work item by
 * agent2-push-test-plan.js (--feasibility-report) alongside the exempt-reason comment.
 *
 * Usage:
 *   node scripts/agents/agent2-render-feasibility-report.js --inputFile=<path-to-json>
 *
 * Exit codes: 0 = rendered, 1 = invalid input (fix the JSON and re-run).
 * Prints summary counts + verdict + report path only (never TC-level detail).
 *
 * JSON contract:
 * {
 *   "workItemId": 46505, "workItemTitle": "...", "iteration": "Release 12",
 *   "qaAssigned": "Name", "testPlanId": null,            // optional
 *   "excelFile": "path", "generatedAt": "ISO date",        // optional
 *   "automationRepoScan": {
 *     "status": "matched" | "no-match" | "skipped",
 *     "reason": "why no-match / skipped",                  // required unless matched
 *     "references": [{ "filePath": "...", "scenarioTags": ["@TC_x_001"], "notes": "..." }]
 *   },
 *   "testCases": [{
 *     "ref": "Row 3" | 47346, "title": "...", "subject": "...",
 *     "classification": "already-covered" | "automatable" | "automatable-with-effort" | "not-feasible",
 *     "coverage": "existing scenario / reusable steps", "notes": "blockers / effort"
 *   }],
 *   "recommendation": {
 *     "verdict": "recommend-automating" | "recommend-partial" | "exemption-justified",
 *     "summary": "one paragraph",
 *     "suggestedForTagging": ["ref or title", ...],
 *     "regressionRisk": "optional",
 *     "suggestedExemptReason": "optional draft reason"
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');
const { escapeHtml } = require('../core/util');

const CLASSES = {
  'already-covered':         { label: 'Already covered',         color: '#2563eb', bg: '#dbeafe' },
  'automatable':             { label: 'Automatable now',         color: '#15803d', bg: '#dcfce7' },
  'automatable-with-effort': { label: 'Automatable with effort', color: '#b45309', bg: '#fef3c7' },
  'not-feasible':            { label: 'Not feasible / worthwhile', color: '#b91c1c', bg: '#fee2e2' },
};
const VERDICTS = {
  'recommend-automating': { label: 'Recommend automating', color: '#15803d', bg: '#dcfce7' },
  'recommend-partial':    { label: 'Recommend partial automation', color: '#b45309', bg: '#fef3c7' },
  'exemption-justified':  { label: 'Exemption looks justified', color: '#475569', bg: '#e2e8f0' },
};
const SCAN_STATUSES = ['matched', 'no-match', 'skipped'];

function validate(d) {
  const errors = [];
  const warnings = [];
  if (!d || typeof d !== 'object') return { errors: ['Input is not a JSON object'], warnings };
  if (!/^\d+$/.test(String(d.workItemId || ''))) errors.push('workItemId must be a numeric work item ID');
  if (!d.workItemTitle) errors.push('workItemTitle is required');

  const scan = d.automationRepoScan;
  if (!scan || !SCAN_STATUSES.includes(scan.status)) {
    errors.push(`automationRepoScan.status must be one of: ${SCAN_STATUSES.join(', ')}`);
  } else {
    if (scan.status !== 'matched' && !scan.reason) errors.push(`automationRepoScan.reason is required when status is "${scan.status}"`);
    if (scan.status === 'matched' && !(Array.isArray(scan.references) && scan.references.length)) errors.push('automationRepoScan.references[] must list the matched .feature files when status is "matched"');
  }

  if (!Array.isArray(d.testCases) || d.testCases.length === 0) {
    errors.push('testCases[] must contain every test case from the Excel');
  } else {
    d.testCases.forEach((tc, i) => {
      if (!tc.title) errors.push(`testCases[${i}].title is required`);
      if (!CLASSES[tc.classification]) errors.push(`testCases[${i}].classification must be one of: ${Object.keys(CLASSES).join(', ')}`);
      if (tc.classification === 'already-covered' && !tc.coverage) errors.push(`testCases[${i}] is "already-covered" but has no coverage (cite the existing scenario)`);
      if (tc.classification === 'not-feasible' && !tc.notes) errors.push(`testCases[${i}] is "not-feasible" but has no notes explaining why`);
    });
  }

  const rec = d.recommendation;
  if (!rec || !VERDICTS[rec.verdict]) {
    errors.push(`recommendation.verdict must be one of: ${Object.keys(VERDICTS).join(', ')}`);
  } else {
    if (!rec.summary) errors.push('recommendation.summary is required');
    const counts = countBy(d.testCases || []);
    const feasible = counts['automatable'] + counts['automatable-with-effort'];
    if (rec.verdict === 'exemption-justified' && feasible > 0) warnings.push(`verdict is "exemption-justified" but ${feasible} TC(s) are classified automatable - double-check the verdict`);
    if (rec.verdict !== 'exemption-justified' && feasible === 0) warnings.push(`verdict is "${rec.verdict}" but no TC is classified automatable - double-check the verdict`);
    if (rec.verdict !== 'exemption-justified' && !(Array.isArray(rec.suggestedForTagging) && rec.suggestedForTagging.length)) errors.push('recommendation.suggestedForTagging[] is required when recommending automation');
  }
  return { errors, warnings };
}

function countBy(testCases) {
  const counts = Object.fromEntries(Object.keys(CLASSES).map(k => [k, 0]));
  for (const tc of testCases) if (counts[tc.classification] !== undefined) counts[tc.classification]++;
  return counts;
}

const badge = (meta) => `<span class="badge" style="color:${meta.color};background:${meta.bg}">${escapeHtml(meta.label)}</span>`;

function render(d) {
  const counts = countBy(d.testCases);
  const total = d.testCases.length;
  const verdict = VERDICTS[d.recommendation.verdict];
  const scan = d.automationRepoScan;
  const rec = d.recommendation;
  const generatedAt = d.generatedAt || new Date().toISOString();

  const cards = Object.entries(CLASSES).map(([k, m]) =>
    `<div class="card" style="border-top-color:${m.color}"><div class="num" style="color:${m.color}">${counts[k]}</div><div class="lbl">${escapeHtml(m.label)}</div></div>`
  ).join('') + `<div class="card" style="border-top-color:#0f172a"><div class="num">${total}</div><div class="lbl">Total test cases</div></div>`;

  const refs = (scan.references || []).map(r => `<li><code>${escapeHtml(r.filePath)}</code>${(r.scenarioTags || []).length ? ` - ${(r.scenarioTags).map(t => `<code>${escapeHtml(t)}</code>`).join(' ')}` : ''}${r.notes ? `<div class="muted">${escapeHtml(r.notes)}</div>` : ''}</li>`).join('');
  const scanBody = scan.status === 'matched'
    ? `<ul>${refs}</ul>${scan.reason ? `<p class="muted">${escapeHtml(scan.reason)}</p>` : ''}`
    : `<p><strong>${scan.status === 'skipped' ? 'Scan skipped' : 'No matching scenarios'}:</strong> ${escapeHtml(scan.reason)}</p>`;

  const order = Object.keys(CLASSES);
  const rows = [...d.testCases]
    .sort((a, b) => order.indexOf(a.classification) - order.indexOf(b.classification))
    .map(tc => `<tr data-class="${escapeHtml(tc.classification)}">
      <td class="nowrap">${escapeHtml(tc.ref ?? '')}</td>
      <td>${escapeHtml(tc.subject || '')}</td>
      <td>${escapeHtml(tc.title)}</td>
      <td class="nowrap">${badge(CLASSES[tc.classification])}</td>
      <td>${escapeHtml(tc.coverage || '-')}</td>
      <td>${escapeHtml(tc.notes || '')}</td>
    </tr>`).join('');

  const filterBtns = [`<button class="flt active" data-f="all">All (${total})</button>`]
    .concat(Object.entries(CLASSES).map(([k, m]) => `<button class="flt" data-f="${k}">${escapeHtml(m.label)} (${counts[k]})</button>`)).join('');

  const tagList = (rec.suggestedForTagging || []).map(t => `<code>${escapeHtml(t)}</code>`).join(' ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="feasibility-verdict" content="${escapeHtml(rec.verdict)}">
<meta name="feasibility-counts" content="${escapeHtml(JSON.stringify({ ...counts, total }))}">
<title>Automation Feasibility - #${escapeHtml(d.workItemId)}</title>
<style>
  body { font-family: Segoe UI, Arial, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 10px; }
  .muted { color: #64748b; font-size: 13px; }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px 24px; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 18px; margin-top: 14px; font-size: 14px; }
  .meta b { color: #475569; font-weight: 600; }
  .verdict { margin-top: 18px; border-radius: 8px; padding: 16px 18px; font-size: 15px; }
  .verdict .v { font-size: 19px; font-weight: 700; margin-bottom: 6px; }
  .cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-top: 18px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-top: 4px solid; border-radius: 8px; padding: 12px 14px; }
  .card .num { font-size: 26px; font-weight: 700; } .card .lbl { font-size: 13px; color: #475569; }
  .box { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 18px; font-size: 14px; }
  .box ul { margin: 6px 0; padding-left: 20px; } .box li { margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; background: #fff; font-size: 13px; border: 1px solid #e2e8f0; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th { background: #f1f5f9; position: sticky; top: 0; }
  .nowrap { white-space: nowrap; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
  code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .flt { border: 1px solid #cbd5e1; background: #fff; border-radius: 14px; padding: 4px 12px; margin: 0 6px 10px 0; cursor: pointer; font-size: 13px; }
  .flt.active { background: #0f172a; color: #fff; border-color: #0f172a; }
  .warn { border-left: 4px solid #b45309; }
  footer { margin-top: 28px; }
</style>
</head>
<body><div class="wrap">
  <h1>Automation Feasibility Advisory - #${escapeHtml(d.workItemId)}</h1>
  <div class="muted">Agent 2 · STEP 1.5 · generated when no test case carried the Automation tag. Advisory only - the QA decides.</div>

  <div class="meta">
    <div><b>Work item:</b> #${escapeHtml(d.workItemId)} - ${escapeHtml(d.workItemTitle)}</div>
    ${d.iteration ? `<div><b>Iteration:</b> ${escapeHtml(d.iteration)}</div>` : ''}
    ${d.qaAssigned ? `<div><b>QA:</b> ${escapeHtml(d.qaAssigned)}</div>` : ''}
    ${d.testPlanId ? `<div><b>Test Plan:</b> #${escapeHtml(d.testPlanId)}</div>` : ''}
    ${d.excelFile ? `<div><b>Excel:</b> ${escapeHtml(path.basename(d.excelFile))}</div>` : ''}
    <div><b>Generated:</b> ${escapeHtml(generatedAt)}</div>
  </div>

  <div class="verdict" style="background:${verdict.bg};color:${verdict.color}">
    <div class="v">${escapeHtml(verdict.label)}</div>
    <div style="color:#0f172a">${escapeHtml(rec.summary)}</div>
  </div>

  <div class="cards">${cards}</div>

  ${tagList ? `<h2>Suggested for the Automation tag (${(rec.suggestedForTagging || []).length})</h2><div class="box">${tagList}</div>` : ''}
  ${rec.regressionRisk ? `<h2>Regression risk</h2><div class="box warn">${escapeHtml(rec.regressionRisk)}</div>` : ''}
  ${rec.suggestedExemptReason ? `<h2>Suggested exempt reason</h2><div class="box">${escapeHtml(rec.suggestedExemptReason)}</div>` : ''}

  <h2>Existing automation scan</h2>
  <div class="box">${scanBody}</div>

  <h2>Per test case</h2>
  <div>${filterBtns}</div>
  <table>
    <thead><tr><th>Ref</th><th>Subject</th><th>Title</th><th>Classification</th><th>Existing coverage / reuse</th><th>Notes</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <footer class="muted">🤖 Generated by Agent 2 (Automation Feasibility Advisory). Source: ${escapeHtml(path.basename(d.__source || ''))}</footer>
</div>
<script>
  document.querySelectorAll('.flt').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.flt').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      var f = b.getAttribute('data-f');
      document.querySelectorAll('tbody tr').forEach(function (r) {
        r.style.display = (f === 'all' || r.getAttribute('data-class') === f) ? '' : 'none';
      });
    });
  });
</script>
</body></html>
`;
}

function main() {
  const arg = process.argv.slice(2).find(a => a.startsWith('--inputFile='));
  const inputFile = arg ? arg.slice('--inputFile='.length).replace(/^"|"$/g, '') : null;
  if (!inputFile) {
    console.error('Usage: node scripts/agents/agent2-render-feasibility-report.js --inputFile=<automation-feasibility-<id>.json>');
    process.exit(1);
  }
  if (!fs.existsSync(inputFile)) { console.error(`❌ Input not found: ${inputFile}`); process.exit(1); }

  let data;
  try { data = JSON.parse(fs.readFileSync(inputFile, 'utf8')); }
  catch (e) { console.error(`❌ Invalid JSON: ${e.message}`); process.exit(1); }

  const { errors, warnings } = validate(data);
  if (errors.length) {
    console.error('❌ FEASIBILITY_REPORT_INVALID');
    errors.forEach(e => console.error(`   - ${e}`));
    process.exit(1);
  }
  warnings.forEach(w => console.log(`⚠️  ${w}`));

  data.__source = inputFile;
  const outFile = path.join(path.dirname(inputFile), `automation-feasibility-${data.workItemId}.html`);
  fs.writeFileSync(outFile, render(data), 'utf8');

  const c = countBy(data.testCases);
  console.log('✅ Automation Feasibility Report rendered');
  console.log(`   ${c['automatable']} automatable, ${c['automatable-with-effort']} automatable with effort, ${c['not-feasible']} not feasible, ${c['already-covered']} already covered (of ${data.testCases.length})`);
  console.log(`   Existing scenarios: ${data.automationRepoScan.status === 'matched' ? `${data.automationRepoScan.references.length} file(s) matched` : data.automationRepoScan.status}`);
  console.log(`   Verdict: ${VERDICTS[data.recommendation.verdict].label}`);
  console.log(`   Report: ${outFile}`);
}

if (require.main === module) main();

module.exports = { validate, render, VERDICTS, CLASSES };
