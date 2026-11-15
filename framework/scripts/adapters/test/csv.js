/**
 * CSV adapter - no test-management tool; writes an import file per requirement to
 *   output/test-management/<requirementId>/test-cases-<format>.csv
 *
 * Plan id = requirement id. Plans/suites/cases are kept in memory for this process and the
 * file is (re)written on finalize(ctx, plan). If a CSV already exists for the requirement it
 * is loaded first, so re-runs append instead of overwriting. listTestCases() reads the CSV
 * back (so Agent 3 can work offline and sees tag edits a QA made in Excel).
 *
 * config.format - the vendor's documented CSV import layout:
 *   generic          one row per step, every column repeated on each row
 *   xray             Xray Test Case Importer: Issue Id groups step rows (Action/Data/Result)
 *   zephyr-scale     Zephyr Scale CSV import: case fields on first row, Test Script (Step-by-Step) columns per row
 *   testrail         TestRail CSV import ("case data spans multiple rows", new case = Title present)
 *   qtest            qTest Manager test case import (Test Step Description / Expected Result per row)
 *   azure-test-plans Azure DevOps work-item CSV import: test case row, then one row per Test Step
 */

const fs = require('fs');
const path = require('path');

const ZS = 'Test Script (Step-by-Step) - ';
// t=title p=priority g=tags s=suite pre=preconditions a=action e=expected d=data n=step# id=group id
const FORMATS = {
  generic: { cols: ['Test Case ID', 'Requirement', 'Suite', 'Title', 'Priority', 'Preconditions', 'Tags', 'Step', 'Action', 'Expected Result', 'Test Data'],
    map: { id: 'Test Case ID', t: 'Title', p: 'Priority', g: 'Tags', s: 'Suite', pre: 'Preconditions', n: 'Step', a: 'Action', e: 'Expected Result', d: 'Test Data', req: 'Requirement' }, repeat: true, tagSep: ', ' },
  xray: { cols: ['Issue Id', 'Test Type', 'Summary', 'Priority', 'Labels', 'Description', 'Test Repository Path', 'Requirement', 'Action', 'Data', 'Result'],
    map: { id: 'Issue Id', t: 'Summary', p: 'Priority', g: 'Labels', s: 'Test Repository Path', pre: 'Description', a: 'Action', e: 'Result', d: 'Data', req: 'Requirement' }, fixed: { 'Test Type': 'Manual' }, repeatId: true, tagSep: ' ', label: true },
  'zephyr-scale': { cols: ['Name', 'Objective', 'Precondition', 'Folder', 'Status', 'Priority', 'Labels', 'Coverage (Issues)', `${ZS}Step`, `${ZS}Test Data`, `${ZS}Expected Result`],
    map: { t: 'Name', p: 'Priority', g: 'Labels', s: 'Folder', pre: 'Precondition', a: `${ZS}Step`, e: `${ZS}Expected Result`, d: `${ZS}Test Data`, req: 'Coverage (Issues)' }, fixed: { Status: 'Draft' }, tagSep: ',', label: true,
    prio: { Critical: 'High', High: 'High', Medium: 'Normal', Low: 'Low' } },
  testrail: { cols: ['Section', 'Title', 'Priority', 'References', 'Preconditions', 'Tags', 'Steps', 'Expected Result'],
    map: { t: 'Title', p: 'Priority', g: 'Tags', s: 'Section', pre: 'Preconditions', a: 'Steps', e: 'Expected Result', req: 'References' }, tagSep: ', ' },
  qtest: { cols: ['Module', 'Name', 'Description', 'Precondition', 'Priority', 'Type', 'Tags', 'Test Step #', 'Test Step Description', 'Test Step Expected Result'],
    map: { t: 'Name', p: 'Priority', g: 'Tags', s: 'Module', pre: 'Precondition', n: 'Test Step #', a: 'Test Step Description', e: 'Test Step Expected Result', req: 'Description' }, fixed: { Type: 'Manual' }, tagSep: ', ' },
  'azure-test-plans': { cols: ['ID', 'Work Item Type', 'Title', 'Test Step', 'Step Action', 'Step Expected', 'Area Path', 'Priority', 'Tags', 'Description'],
    map: { t: 'Title', p: 'Priority', g: 'Tags', s: 'Area Path', pre: 'Description', n: 'Test Step', a: 'Step Action', e: 'Step Expected' }, fixed: { 'Work Item Type': 'Test Case' }, separateStepRows: true, tagSep: '; ',
    prio: { Critical: '1', High: '2', Medium: '3', Low: '4' } },
};

const store = new Map(); // csv file path → { requirementId, name, suites: [names], cases: [] }

const fmtName = (ctx) => String((ctx.config || {}).format || 'generic');
function fmt(ctx) {
  const f = FORMATS[fmtName(ctx)];
  if (!f) throw new Error(`CSV: unknown format "${fmtName(ctx)}". Use one of: ${Object.keys(FORMATS).join(', ')}.`);
  return f;
}
const safe = (s) => String(s).replace(/[^\w.-]+/g, '_');
const dirFor = (ctx, reqId) => path.join(ctx.root || process.cwd(), 'output', 'test-management', safe(reqId));
const fileFor = (ctx, reqId) => path.join(dirFor(ctx, reqId), `test-cases-${fmtName(ctx)}.csv`);

// ---------- CSV text ----------
const cell = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

// ---------- rows ----------
function toRows(f, plan, st) {
  const m = f.map;
  const rows = [];
  st.cases.forEach((c, idx) => {
    const tags = (c.tags || []).map((t) => (f.label ? String(t).trim().replace(/\s+/g, '_') : t));
    const head = {
      ...(f.fixed || {}),
      [m.t]: c.title, [m.p]: (f.prio || {})[c.priority] || c.priority || 'Medium', [m.g]: tags.join(f.tagSep),
      [m.s]: c.suite || '', [m.pre]: [c.preconditions, c.testData && !m.d ? `Test data: ${c.testData}` : ''].filter(Boolean).join('\n'),
    };
    if (m.req) head[m.req] = f === FORMATS.qtest ? `Requirement: ${st.requirementId}` : st.requirementId;
    if (m.id) head[m.id] = c.id || String(idx + 1);
    const steps = c.steps && c.steps.length ? c.steps : [{ action: '', expected: '' }];
    const stepRow = (s, i) => {
      const r = { [m.a]: s.action || '', [m.e]: s.expected || '' };
      if (m.n) r[m.n] = String(i + 1);
      if (m.d) r[m.d] = i === 0 ? c.testData || '' : '';
      if (m.id && (f.repeatId || f.repeat)) r[m.id] = head[m.id];
      return r;
    };
    if (f.separateStepRows) { rows.push(head); steps.forEach((s, i) => rows.push(stepRow(s, i))); }
    else steps.forEach((s, i) => rows.push(i === 0 || f.repeat ? { ...head, ...stepRow(s, i) } : stepRow(s, i)));
  });
  return rows;
}

function fromRows(f, header, data, reqId) {
  const m = f.map;
  const ix = Object.fromEntries(header.map((h, i) => [h, i]));
  const get = (r, k) => (k && ix[k] !== undefined ? r[ix[k]] || '' : '');
  const rev = f.prio ? Object.fromEntries(Object.entries(f.prio).map(([k, v]) => [v.toLowerCase(), k])) : null; // later entry wins, so High beats Critical where both map to the same value
  const cases = [];
  let cur = null;
  for (const r of data) {
    const gid = m.id ? get(r, m.id) : '';
    const title = get(r, m.t);
    const isNew = m.id ? (gid && (!cur || cur._gid !== gid)) : !!title;
    if (isNew) {
      const p = get(r, m.p);
      cur = {
        _gid: gid, id: gid || `${reqId}-TC${cases.length + 1}`, title,
        priority: rev ? rev[p.toLowerCase()] || 'Medium' : (['Critical', 'High', 'Medium', 'Low'].includes(p) ? p : 'Medium'),
        steps: [], tags: get(r, m.g).split(f.tagSep.trim() || ' ').map((t) => t.trim()).filter(Boolean),
        suite: get(r, m.s), url: '',
        preconditions: get(r, m.pre), testData: m.d ? get(r, m.d) : '',
      };
      cases.push(cur);
    }
    if (!cur) continue;
    const a = get(r, m.a); const e = get(r, m.e);
    if (a || e) cur.steps.push({ action: a, expected: e });
  }
  return cases.map(({ _gid, ...c }) => c);
}

function load(ctx, planId) {
  const file = fileFor(ctx, planId);
  if (store.has(file)) return store.get(file);
  const st = { requirementId: String(planId), name: String(planId), suites: [], cases: [] };
  if (fs.existsSync(file)) {
    const [header, ...data] = parseCsv(fs.readFileSync(file, 'utf8'));
    st.cases = fromRows(fmt(ctx), header || [], data, planId).map((c, i) => ({ ...c, id: String(i + 1) }));
    st.suites = [...new Set(st.cases.map((c) => c.suite).filter(Boolean))];
  }
  store.set(file, st);
  return st;
}

// ---------- contract ----------
async function testConnection(ctx) {
  try { fmt(ctx); } catch (e) { return { ok: false, message: e.message, fix: 'Pick a CSV format in the installer.' }; }
  return { ok: true, message: `CSV files will be written under output/test-management/ (format: ${fmtName(ctx)}). No account needed.` };
}

async function findPlans(ctx, requirementId) {
  const file = fileFor(ctx, requirementId);
  return fs.existsSync(file) ? [{ id: String(requirementId), name: `${requirementId} (${path.basename(file)})`, url: file }] : [];
}

async function createPlan(ctx, { name, requirement }) {
  fmt(ctx);
  const st = load(ctx, requirement.id);
  st.name = name || `${requirement.id} ${requirement.title || ''}`.trim();
  return { id: String(requirement.id), url: fileFor(ctx, requirement.id) };
}

async function ensureSuite(ctx, plan, name) {
  const st = load(ctx, plan.id);
  const found = st.suites.find((s) => s.toLowerCase() === String(name).toLowerCase());
  if (!found) st.suites.push(name);
  return { id: found || name };
}

async function listSuites(ctx, plan) {
  return load(ctx, plan.id).suites.map((s) => ({ id: s, name: s }));
}

async function createTestCase(ctx, { plan, suite, tc }) {
  const st = load(ctx, plan.id);
  const id = String(st.cases.length + 1);
  st.cases.push({ id, title: tc.title, priority: tc.priority || 'Medium', preconditions: tc.preconditions || '', testData: tc.testData || '', steps: tc.steps || [], tags: tc.tags || [], suite: (suite && (suite.name || suite.id)) || tc.subject || '' });
  return { id, url: fileFor(ctx, plan.id) };
}

async function finalize(ctx, plan) {
  const f = fmt(ctx);
  const st = load(ctx, plan.id);
  fs.mkdirSync(dirFor(ctx, plan.id), { recursive: true });
  const rows = toRows(f, plan, st);
  const text = [f.cols.map(cell).join(','), ...rows.map((r) => f.cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
  const file = fileFor(ctx, plan.id);
  fs.writeFileSync(file, '﻿' + text, 'utf8');
  return { files: [file] };
}

async function listTestCases(ctx, plan) {
  const file = fileFor(ctx, plan.id);
  if (!fs.existsSync(file)) {
    const st = store.get(file);
    if (!st) throw new Error(`CSV: no file for ${plan.id} at ${file}. Run Agent 2 (it writes the CSV) first.`);
    return st.cases.map((c) => ({ id: c.id, title: c.title, priority: c.priority, steps: c.steps, tags: c.tags, suite: c.suite, url: file }));
  }
  const [header, ...data] = parseCsv(fs.readFileSync(file, 'utf8'));
  return fromRows(fmt(ctx), header || [], data, plan.id).map(({ preconditions, testData, ...c }) => ({ ...c, url: file }));
}

module.exports = {
  id: 'csv',
  label: 'CSV file (no test tool / import later)',
  secrets: [],
  fields: [
    { key: 'format', label: 'CSV layout', placeholder: 'generic', help: 'Which tool you will import the file into: generic, xray, zephyr-scale, testrail, qtest or azure-test-plans. Use "generic" for a plain spreadsheet.', required: true },
  ],
  FORMATS: Object.keys(FORMATS),
  testConnection, findPlans, createPlan, ensureSuite, listSuites, createTestCase, listTestCases, finalize,
};
