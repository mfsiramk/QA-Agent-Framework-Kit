/**
 * Azure DevOps Test Plans adapter.
 *
 *   Plan       = ADO Test Plan (area + iteration copied from the requirement work item);
 *                root suite renamed to the requirement title.
 *   Suite      = static suite directly under the plan's root suite (reused by name).
 *   Test case  = "Test Case" work item: Microsoft.VSTS.TCM.Steps XML, Priority 1-4,
 *                System.Tags, and a "Tested By" link to the requirement
 *                (Microsoft.VSTS.Common.TestedBy-Reverse), then added to its suite.
 *
 * Reads organisation + project from the task-management section (ctx.task.orgUrl /
 * ctx.task.project) - ctx.config.orgUrl / ctx.config.project override them if set.
 */

const { request, basicAuth, htmlToText } = require('../../core/http.js');

const SERVICE = 'Azure DevOps Test Plans';
const API = 'api-version=7.1';
const PRIORITY = { Critical: 1, High: 2, Medium: 3, Low: 4 };
const PRIORITY_NAME = { 1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low' };

function conn(ctx) {
  const c = ctx.config || {};
  const t = ctx.task || {};
  const orgUrl = String(c.orgUrl || t.orgUrl || '').replace(/\/+$/, '');
  const project = c.project || t.project || '';
  const pat = (ctx.env || {}).ADO_PAT;
  if (!orgUrl || !project) throw new Error(`${SERVICE}: organisation URL and project are not configured. Fill them in the Task management section of the installer.`);
  if (!pat) throw new Error(`${SERVICE}: ADO_PAT is missing from .env. Create a Personal Access Token and add it in the installer.`);
  return { orgUrl, project, base: `${orgUrl}/${encodeURIComponent(project)}`, auth: basicAuth('', pat) };
}

function call(ctx, path, opts = {}) {
  const c = conn(ctx);
  const url = /^https?:/.test(path) ? path : `${c.base}/_apis/${path}${path.includes('?') ? '&' : '?'}${API}`;
  return request({ url, service: SERVICE, ...opts, headers: { Authorization: c.auth, ...(opts.headers || {}) } });
}

const planUrl = (ctx, id) => `${conn(ctx).base}/_testPlans/define?planId=${id}`;
const wiUrl = (ctx, id) => `${conn(ctx).base}/_workitems/edit/${id}`;

// ---------- steps XML ----------
const xmlEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const xmlUnesc = (s) => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&');

/** Step text → HTML (escaped) → XML-escaped again, exactly as ADO stores it. */
const richText = (text) => xmlEsc(`<DIV><P>${xmlEsc(text).replace(/\r?\n/g, '<BR/>')}</P></DIV>`);

function buildStepsXml(steps) {
  const list = (steps || []).length ? steps : [{ action: '', expected: '' }];
  const body = list.map((s, i) =>
    `<step id="${i + 1}" type="${s.expected ? 'ValidateStep' : 'ActionStep'}">` +
    `<parameterizedString isformatted="true">${richText(s.action)}</parameterizedString>` +
    `<parameterizedString isformatted="true">${richText(s.expected)}</parameterizedString>` +
    '<description/></step>').join('');
  return `<steps id="0" last="${list.length}">${body}</steps>`;
}

function parseStepsXml(xml) {
  if (!xml) return [];
  const out = [];
  for (const m of String(xml).matchAll(/<step\b[^>]*>([\s\S]*?)<\/step>/gi)) {
    const parts = [...m[1].matchAll(/<parameterizedString[^>]*>([\s\S]*?)<\/parameterizedString>|<parameterizedString[^>]*\/>/gi)]
      .map((p) => htmlToText(xmlUnesc(p[1] || '')));
    out.push({ action: parts[0] || '', expected: parts[1] || '' });
  }
  return out;
}

const splitTags = (s) => String(s || '').split(';').map((t) => t.trim()).filter(Boolean);

// ---------- contract ----------
async function testConnection(ctx) {
  try {
    await call(ctx, 'testplan/plans?filterActivePlans=true');
    const c = conn(ctx);
    return { ok: true, message: `Connected to Azure DevOps Test Plans in project "${c.project}".` };
  } catch (e) {
    return { ok: false, message: e.message, fix: 'Check the organisation URL/project, and that ADO_PAT is valid with "Test Management (Read & write)" and "Work Items (Read & write)" scopes.' };
  }
}

async function listPlans(ctx) {
  const all = [];
  let token = '';
  for (let i = 0; i < 20; i++) {
    const r = await call(ctx, `testplan/plans?includePlanDetails=false${token ? `&continuationToken=${encodeURIComponent(token)}` : ''}`);
    all.push(...(r.value || []));
    token = r.continuationToken || '';
    if (!token) break;
  }
  return all;
}

async function findPlans(ctx, requirementId) {
  const id = String(requirementId);
  const re = new RegExp(`(^|[^\\w-])#?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`);
  return (await listPlans(ctx))
    .filter((p) => re.test(p.name || ''))
    .map((p) => ({ id: String(p.id), name: p.name, url: planUrl(ctx, p.id) }));
}

async function createPlan(ctx, { name, requirement, release }) {
  let area = '', iteration = '';
  if (/^\d+$/.test(String(requirement.id))) {
    try {
      const wi = await call(ctx, `wit/workitems/${requirement.id}?fields=System.AreaPath,System.IterationPath`);
      area = wi.fields['System.AreaPath'] || '';
      iteration = wi.fields['System.IterationPath'] || '';
    } catch { /* fall back to normalized fields */ }
  }
  area = area || requirement.component || conn(ctx).project;
  iteration = iteration || release || requirement.release || conn(ctx).project;
  const plan = await call(ctx, 'testplan/plans', {
    method: 'POST',
    body: { name: name || `Test Plan - ${requirement.title} (#${requirement.id})`, areaPath: area, iteration, state: 'Active' },
  });
  const rootSuiteId = plan.rootSuite && plan.rootSuite.id;
  if (rootSuiteId && requirement.title) {
    try {
      await call(ctx, `testplan/Plans/${plan.id}/suites/${rootSuiteId}`, { method: 'PATCH', body: { name: requirement.title } });
    } catch { /* cosmetic only */ }
  }
  // Newer ADO represents plans as work items too - link it to the requirement (best effort).
  if (/^\d+$/.test(String(requirement.id))) {
    try { await addTestedByLink(ctx, plan.id, requirement.id); } catch { /* not fatal */ }
  }
  return { id: String(plan.id), url: planUrl(ctx, plan.id), rootSuiteId: String(rootSuiteId), areaPath: area, iteration };
}

async function addTestedByLink(ctx, fromId, requirementId) {
  const c = conn(ctx);
  await call(ctx, `wit/workitems/${fromId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json-patch+json' },
    body: [{ op: 'add', path: '/relations/-', value: { rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: `${c.orgUrl}/_apis/wit/workItems/${requirementId}`, attributes: { comment: 'Linked by QA agent' } } }],
  });
}

async function allSuites(ctx, plan) {
  const r = await call(ctx, `testplan/Plans/${plan.id}/suites`);
  return r.value || [];
}

async function planDetails(ctx, plan) {
  if (plan.rootSuiteId && plan.areaPath && plan.iteration) return plan;
  const p = await call(ctx, `testplan/plans/${plan.id}`);
  return { ...plan, rootSuiteId: String(p.rootSuite.id), areaPath: p.areaPath, iteration: p.iteration };
}

async function listSuites(ctx, plan) {
  return (await allSuites(ctx, plan)).filter((s) => s.parentSuite).map((s) => ({ id: String(s.id), name: s.name }));
}

async function ensureSuite(ctx, plan, name) {
  const p = await planDetails(ctx, plan);
  const existing = (await allSuites(ctx, p)).find((s) =>
    s.parentSuite && String(s.parentSuite.id) === String(p.rootSuiteId) && (s.name || '').toLowerCase() === String(name).toLowerCase());
  if (existing) return { id: String(existing.id) };
  const s = await call(ctx, `testplan/Plans/${p.id}/suites`, {
    method: 'POST', body: { name, suiteType: 'staticTestSuite', parentSuite: { id: Number(p.rootSuiteId) } },
  });
  return { id: String(s.id) };
}

async function createTestCase(ctx, { plan, suite, tc, requirement }) {
  const c = conn(ctx);
  const p = await planDetails(ctx, plan);
  const description = [
    tc.preconditions ? `<p><b>Preconditions:</b> ${xmlEsc(tc.preconditions)}</p>` : '',
    tc.testData ? `<p><b>Test data:</b> ${xmlEsc(tc.testData)}</p>` : '',
    tc.acRef ? `<p><b>Acceptance criteria:</b> ${xmlEsc(tc.acRef)}</p>` : '',
  ].join('');
  const ops = [
    { op: 'add', path: '/fields/System.Title', value: String(tc.title).slice(0, 255) },
    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: buildStepsXml(tc.steps) },
    { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: PRIORITY[tc.priority] || 3 },
    { op: 'add', path: '/fields/System.AreaPath', value: p.areaPath },
    { op: 'add', path: '/fields/System.IterationPath', value: p.iteration },
  ];
  if (description) ops.push({ op: 'add', path: '/fields/System.Description', value: description });
  if ((tc.tags || []).length) ops.push({ op: 'add', path: '/fields/System.Tags', value: tc.tags.join('; ') });
  if (requirement && /^\d+$/.test(String(requirement.id))) {
    ops.push({ op: 'add', path: '/relations/-', value: { rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: `${c.orgUrl}/_apis/wit/workItems/${requirement.id}`, attributes: { comment: 'Linked by QA agent' } } });
  }
  const wi = await call(ctx, 'wit/workitems/$Test%20Case', {
    method: 'POST', headers: { 'Content-Type': 'application/json-patch+json' }, body: ops,
  });
  const suiteId = (suite && suite.id) || p.rootSuiteId;
  await call(ctx, `testplan/Plans/${p.id}/Suites/${suiteId}/TestCase`, { method: 'POST', body: [{ workItem: { id: wi.id } }] });
  return { id: String(wi.id), url: wiUrl(ctx, wi.id) };
}

async function listTestCases(ctx, plan) {
  const suites = await allSuites(ctx, plan);
  const suiteOf = new Map();
  for (const s of suites) {
    const r = await call(ctx, `testplan/Plans/${plan.id}/Suites/${s.id}/TestCase`);
    for (const e of r.value || []) {
      const id = String(e.workItem && e.workItem.id);
      if (id && !suiteOf.has(id)) suiteOf.set(id, s.parentSuite ? s.name : '');
    }
  }
  const ids = [...suiteOf.keys()];
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await call(ctx, 'wit/workitemsbatch', {
      method: 'POST',
      body: { ids: ids.slice(i, i + 200).map(Number), fields: ['System.Title', 'System.Tags', 'Microsoft.VSTS.TCM.Steps', 'Microsoft.VSTS.Common.Priority'] },
    });
    for (const w of r.value || []) {
      const f = w.fields || {};
      out.push({
        id: String(w.id),
        title: f['System.Title'] || '',
        priority: PRIORITY_NAME[f['Microsoft.VSTS.Common.Priority']] || 'Medium',
        steps: parseStepsXml(f['Microsoft.VSTS.TCM.Steps']),
        tags: splitTags(f['System.Tags']),
        suite: suiteOf.get(String(w.id)) || '',
        url: wiUrl(ctx, w.id),
      });
    }
  }
  return out;
}

async function finalize() { return {}; }

module.exports = {
  id: 'ado-test-plans',
  label: 'Azure DevOps Test Plans',
  secrets: [{
    env: 'ADO_PAT',
    label: 'Azure DevOps Personal Access Token',
    help: 'In Azure DevOps click your profile picture (top right) → Personal access tokens → New Token. Scopes: "Work Items: Read & write" and "Test Management: Read & write". Your account also needs a Basic + Test Plans licence. The same token as Task management can be reused.',
  }],
  fields: [],
  testConnection, findPlans, createPlan, ensureSuite, listSuites, createTestCase, listTestCases, finalize,
  _internal: { buildStepsXml, parseStepsXml },
};
