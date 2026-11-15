#!/usr/bin/env node
/**
 * AGENT 1 - STEP 8: build the human-review Excel from output/temp/<id>-testcases.json.
 * Only run after agent1-validate-and-lint.js exits 0 and the persona review is appended.
 *
 *   node scripts/agents/agent1-build-excel.js --inputFile=output/temp/<id>-testcases.json
 *
 * Sheets: Test Cases (QA edits Tags here - add the automation tag), Summary,
 * Traceability, Lint Findings, Persona Review.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { loadConfig, outDir } = require('../core/config');
const { arg } = require('../core/util');

const cfg = loadConfig();
const inputFile = arg('inputFile');
if (!inputFile || !fs.existsSync(inputFile)) { console.error('Usage: --inputFile=output/temp/<id>-testcases.json'); process.exit(1); }
const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const wi = input.workItem || {};
const tcs = input.testCases || [];
const tag = cfg.testManagement?.automationTag || 'Automation';

const asText = (v) => (Array.isArray(v) ? v.map((s, i) => `${i + 1}. ${typeof s === 'string' ? s : s.action || ''}`).join('\n') : String(v || ''));
const tcRows = tcs.map((tc) => ({
  'TC ID': tc.id || '',
  Title: tc.title || '',
  Subject: tc.subject || tc.module || 'General',
  Priority: tc.priority || 'Medium',
  Category: tc.category || tc.type || '',
  Preconditions: tc.preconditions || '',
  'Test Steps': asText(tc.steps),
  'Expected Result': asText(tc.expectedResult),
  'Test Data': typeof tc.testData === 'object' ? JSON.stringify(tc.testData) : (tc.testData || ''),
  'AC Ref': tc.acRef || '',
  Tags: (tc.tags || []).join('; '),
}));

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(tcRows);
ws['!cols'] = [10, 45, 18, 10, 14, 30, 60, 50, 30, 30, 18].map((w) => ({ wch: w }));
XLSX.utils.book_append_sheet(wb, ws, 'Test Cases');

const summary = [
  ['Work Item', `${wi.type || ''} ${wi.id || ''}`.trim()],
  ['Title', wi.title || ''],
  ['Generated', new Date().toISOString()],
  ['Total Test Cases', tcs.length],
  ['BRD', input.brdUrl || 'N/A'],
  ['Design', input.designUrl || input.figmaUrl || 'N/A'],
  ['Automation repo scan', input.automationRepoScanResult || `${(input.automationRepoReferences || []).length} matched file(s)`],
  [],
  ['HOW TO REVIEW'],
  ['1', 'Delete rows that are out of scope - the Excel you approve is the source of truth.'],
  ['2', `Add "${tag}" in the Tags column for every test case that should be automated.`],
  ['3', 'Save, then tell the assistant: "Create test plan for <ID>".'],
];
['Critical', 'High', 'Medium', 'Low'].forEach((p) => summary.splice(4, 0, [`  ${p}`, tcs.filter((t) => t.priority === p).length]));
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');

const acLines = String(wi.acceptanceCriteria || '').split(/\n/).map((l) => l.trim()).filter(Boolean);
const trace = acLines.map((ac, i) => {
  const covering = tcs.filter((t) => t.acRef && (ac.toLowerCase().includes(String(t.acRef).toLowerCase().slice(0, 40)) || String(t.acRef).toLowerCase().includes(ac.toLowerCase().slice(0, 40))));
  return { '#': i + 1, 'Acceptance Criterion': ac, 'Covered By': covering.map((t) => t.id).join(', '), Status: covering.length ? 'Covered' : 'NOT COVERED' };
});
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trace.length ? trace : [{ Note: 'No acceptance criteria on the work item.' }]), 'Traceability');

const lintFile = inputFile.replace(/-testcases\.json$/, '-lint.json');
const lint = fs.existsSync(lintFile) ? JSON.parse(fs.readFileSync(lintFile, 'utf8')) : null;
const lintRows = lint ? [...(lint.errors || []), ...(lint.warnings || [])].map((f) => ({ TC: f.tcId, Rule: f.rule, Field: f.field || '', Message: f.message })) : [];
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lintRows.length ? lintRows : [{ Result: 'Clean - no lint findings' }]), 'Lint Findings');

const pr = input.personaReview || {};
const prRows = [];
for (const p of pr.personas || []) {
  prRows.push({ Persona: p.name || p.role, TC: '', Severity: '', Action: '', Feedback: `VERDICT: ${p.verdict || ''} - ${p.summary || ''}` });
  for (const f of p.findings || []) {
    prRows.push({ Persona: p.role || p.name, TC: f.tcId || '', Severity: f.severity || '', Action: f.action || '', Feedback: [f.comment, f.newValue ? `→ ${f.newValue}` : '', f.note ? `(${f.note})` : ''].filter(Boolean).join(' ') });
  }
  for (const m of p.missingScenarios || []) prRows.push({ Persona: p.role || p.name, TC: '', Severity: '', Action: 'Missing scenario', Feedback: typeof m === 'string' ? m : m.title || JSON.stringify(m) });
}
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(prRows.length ? prRows : [{ Note: 'Persona review not recorded.' }]), 'Persona Review');

const dir = outDir('test-cases');
const file = path.join(dir, `test-cases-${wi.id || 'unknown'}-${new Date().toISOString().slice(0, 10)}.xlsx`);
XLSX.writeFile(wb, file);
console.log(`✅ Excel ready for review: ${path.relative(cfg.root, file)}`);
console.log(`   ${tcs.length} test case(s) · ${trace.filter((t) => t.Status === 'Covered').length}/${trace.length} AC covered · ${lintRows.length} lint finding(s)`);
