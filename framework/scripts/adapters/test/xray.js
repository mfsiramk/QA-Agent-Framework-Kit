/**
 * Xray Cloud adapter (Xray GraphQL API v2 + Jira Cloud REST v3).
 *
 *   Plan       = Xray "Test Plan" issue created with GraphQL createTestPlan,
 *                summary "<requirementId> <title>". Plan id = Jira key.
 *   Suite      = Xray "Test Set" issue, summary "[<planKey>] <suite name>" (Test Sets are
 *                project-wide, so the plan key prefix keeps suites of different plans apart).
 *                ensureSuite finds an existing one by that summary.
 *   Test case  = GraphQL createTest (Manual, steps action/data/result) with Jira fields
 *                summary, labels (= tags), priority, description; then added to the plan
 *                and the test set, then a Jira issue link of type config.linkType
 *                (default "Test": test "tests" requirement).
 *   Tags       = Jira labels (spaces are replaced by "_" because Jira labels cannot contain spaces).
 *
 * Jira access (search + issue links) uses the task-management section: ctx.task.baseUrl
 * with JIRA_EMAIL / JIRA_API_TOKEN from .env.
 */

const { request, basicAuth, bearer } = require('../../core/http.js');

const SERVICE = 'Xray';
const DEFAULT_PRIORITY = { Critical: 'Highest', High: 'High', Medium: 'Medium', Low: 'Low' };

function cfg(ctx) {
  const c = ctx.config || {};
  const e = ctx.env || {};
  if (!e.XRAY_CLIENT_ID || !e.XRAY_CLIENT_SECRET) throw new Error('Xray: XRAY_CLIENT_ID / XRAY_CLIENT_SECRET are missing from .env.');
  return { apiUrl: String(c.apiUrl || 'https://xray.cloud.getxray.app').replace(/\/+$/, ''), projectKey: c.projectKey, id: e.XRAY_CLIENT_ID, secret: e.XRAY_CLIENT_SECRET };
}

function jira(ctx) {
  const base = String((ctx.task || {}).baseUrl || (ctx.config || {}).jiraUrl || '').replace(/\/+$/, '');
  const e = ctx.env || {};
  if (!base || !e.JIRA_EMAIL || !e.JIRA_API_TOKEN) return null;
  return { base, auth: basicAuth(e.JIRA_EMAIL, e.JIRA_API_TOKEN) };
}

function jiraCall(ctx, path, opts = {}) {
  const j = jira(ctx);
  if (!j) throw new Error('Xray: Jira URL / JIRA_EMAIL / JIRA_API_TOKEN are not configured (needed to search and link issues). Fill the Task management section.');
  return request({ url: `${j.base}${path}`, service: 'Jira', ...opts, headers: { Authorization: j.auth, ...(opts.headers || {}) } });
}

const tokens = new Map();
async function token(ctx) {
  const c = cfg(ctx);
  if (!tokens.has(c.id)) {
    const t = await request({ url: `${c.apiUrl}/api/v2/authenticate`, method: 'POST', body: { client_id: c.id, client_secret: c.secret }, service: SERVICE });
    tokens.set(c.id, typeof t === 'string' ? t.replace(/^"|"$/g, '') : String(t));
  }
  return tokens.get(c.id);
}

async function gql(ctx, query, variables) {
  const r = await request({ url: `${cfg(ctx).apiUrl}/api/v2/graphql`, method: 'POST', body: { query, variables }, service: SERVICE, headers: { Authorization: bearer(await token(ctx)) } });
  if (r.errors && r.errors.length) throw new Error(`Xray GraphQL error: ${r.errors.map((e) => e.message).join('; ')}`);
  return r.data;
}

const browse = (ctx, key) => (jira(ctx) ? `${jira(ctx).base}/browse/${key}` : key);
const label = (t) => String(t).trim().replace(/\s+/g, '_');
const jqlStr = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

async function searchIssues(ctx, jql) {
  const r = await jiraCall(ctx, `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=100`);
  return r.issues || [];
}

function requireProject(ctx) {
  const k = (ctx.config || {}).projectKey;
  if (!k) throw new Error('Xray: Jira project key is not configured. Fill it in the installer.');
  return k;
}

// ---------- contract ----------
async function testConnection(ctx) {
  try {
    tokens.clear();
    await token(ctx);
    return { ok: true, message: 'Xray Cloud accepted the API key.' };
  } catch (e) {
    return { ok: false, message: e.message, fix: 'Create a new Xray API key (Jira → Apps → Xray → API Keys) and copy the Client ID and Client Secret into the installer.' };
  }
}

async function findPlans(ctx, requirementId) {
  const key = requireProject(ctx);
  const issues = await searchIssues(ctx, `project = ${jqlStr(key)} AND issuetype = "Test Plan" AND summary ~ ${jqlStr(`"${requirementId}"`)}`);
  return issues
    .filter((i) => (i.fields.summary || '').includes(String(requirementId)))
    .map((i) => ({ id: i.key, name: i.fields.summary, url: browse(ctx, i.key) }));
}

async function createPlan(ctx, { name, requirement }) {
  const d = await gql(ctx, `mutation($jira: JSON!) { createTestPlan(jira: $jira) { testPlan { issueId jira(fields: ["key"]) } warnings } }`,
    { jira: { fields: { summary: name || `${requirement.id} ${requirement.title}`, project: { key: requireProject(ctx) }, description: requirement.url || '' } } });
  const tp = d.createTestPlan.testPlan;
  return { id: tp.jira.key, issueId: tp.issueId, url: browse(ctx, tp.jira.key) };
}

async function planIssueId(ctx, plan) {
  if (plan.issueId) return plan.issueId;
  const d = await gql(ctx, `query($jql: String) { getTestPlans(jql: $jql, limit: 1) { results { issueId } } }`, { jql: `key = ${plan.id}` });
  const r = d.getTestPlans.results[0];
  if (!r) throw new Error(`Xray: Test Plan ${plan.id} was not found.`);
  return r.issueId;
}

const setPrefix = (plan) => `[${plan.id}] `;

async function listSuites(ctx, plan) {
  const key = requireProject(ctx);
  const issues = await searchIssues(ctx, `project = ${jqlStr(key)} AND issuetype = "Test Set" AND summary ~ ${jqlStr(`"${plan.id}"`)}`);
  return issues
    .filter((i) => (i.fields.summary || '').startsWith(setPrefix(plan)))
    .map((i) => ({ id: i.id, key: i.key, name: i.fields.summary.slice(setPrefix(plan).length) }));
}

async function ensureSuite(ctx, plan, name) {
  const found = (await listSuites(ctx, plan)).find((s) => s.name.toLowerCase() === String(name).toLowerCase());
  if (found) return { id: found.id, key: found.key };
  const d = await gql(ctx, `mutation($jira: JSON!) { createTestSet(testIssueIds: [], jira: $jira) { testSet { issueId jira(fields: ["key"]) } warnings } }`,
    { jira: { fields: { summary: setPrefix(plan) + name, project: { key: requireProject(ctx) } } } });
  return { id: d.createTestSet.testSet.issueId, key: d.createTestSet.testSet.jira.key };
}

async function createTestCase(ctx, { plan, suite, tc, requirement }) {
  const map = { ...DEFAULT_PRIORITY, ...((ctx.config || {}).priorityMap || {}) };
  const steps = (tc.steps || []).map((s, i) => ({ action: s.action || '-', data: i === 0 && tc.testData ? tc.testData : '', result: s.expected || '' }));
  const description = [tc.preconditions && `Preconditions: ${tc.preconditions}`, tc.acRef && `Acceptance criteria: ${tc.acRef}`, requirement && requirement.url && `Requirement: ${requirement.url}`].filter(Boolean).join('\n\n');
  const fields = { summary: String(tc.title).slice(0, 255), project: { key: requireProject(ctx) }, labels: (tc.tags || []).map(label), description };
  if (map[tc.priority]) fields.priority = { name: map[tc.priority] };
  const d = await gql(ctx, `mutation($steps: [CreateStepInput], $jira: JSON!) { createTest(testType: { name: "Manual" }, steps: $steps, jira: $jira) { test { issueId jira(fields: ["key"]) } warnings } }`,
    { steps, jira: { fields } });
  const t = d.createTest.test;
  const warnings = [...(d.createTest.warnings || [])];
  await gql(ctx, `mutation($id: String!, $tests: [String]!) { addTestsToTestPlan(issueId: $id, testIssueIds: $tests) { addedTests warning } }`, { id: await planIssueId(ctx, plan), tests: [t.issueId] });
  if (suite && suite.id) {
    await gql(ctx, `mutation($id: String!, $tests: [String]!) { addTestsToTestSet(issueId: $id, testIssueIds: $tests) { addedTests warning } }`, { id: String(suite.id), tests: [t.issueId] });
  }
  if (requirement && /^[A-Z][A-Z0-9_]+-\d+$/.test(String(requirement.id))) {
    try {
      await jiraCall(ctx, '/rest/api/3/issueLink', { method: 'POST', body: { type: { name: (ctx.config || {}).linkType || 'Test' }, outwardIssue: { key: t.jira.key }, inwardIssue: { key: String(requirement.id) } } });
    } catch (e) { warnings.push(`Requirement link not created: ${e.message}`); }
  } else if (requirement) {
    warnings.push(`Requirement ${requirement.id} is not a Jira key - no "Tests" link created.`);
  }
  return { id: t.jira.key, url: browse(ctx, t.jira.key), warnings };
}

async function listTestCases(ctx, plan) {
  const id = await planIssueId(ctx, plan);
  const rev = Object.fromEntries(Object.entries({ ...DEFAULT_PRIORITY, ...((ctx.config || {}).priorityMap || {}) }).map(([k, v]) => [String(v).toLowerCase(), k]));
  const out = [];
  for (let start = 0; start < 5000; start += 100) {
    const d = await gql(ctx, `query($id: String!, $start: Int) { getTestPlan(issueId: $id) { tests(limit: 100, start: $start) { total results {
        issueId jira(fields: ["key", "summary", "labels", "priority"]) steps { action result }
        testSets(limit: 20) { results { jira(fields: ["summary"]) } } } } } }`, { id, start });
    const page = d.getTestPlan.tests;
    for (const t of page.results || []) {
      const j = t.jira || {};
      const set = ((t.testSets || {}).results || []).map((s) => (s.jira || {}).summary || '').find((s) => s.startsWith(setPrefix(plan)));
      const pName = (j.priority && j.priority.name) || '';
      out.push({
        id: j.key, title: j.summary || '', priority: rev[pName.toLowerCase()] || 'Medium',
        steps: (t.steps || []).map((s) => ({ action: s.action || '', expected: s.result || '' })),
        tags: j.labels || [], suite: set ? set.slice(setPrefix(plan).length) : '', url: browse(ctx, j.key),
      });
    }
    if (start + 100 >= (page.total || 0)) break;
  }
  return out;
}

async function finalize() { return {}; }

module.exports = {
  id: 'xray',
  label: 'Xray (Jira Cloud)',
  secrets: [
    { env: 'XRAY_CLIENT_ID', label: 'Xray API Client ID', help: 'Jira admin: Apps → Manage your apps → Xray → API Keys → Create API Key (choose a user who can create issues in the project). Copy the Client ID.' },
    { env: 'XRAY_CLIENT_SECRET', label: 'Xray API Client Secret', help: 'Shown together with the Client ID when the Xray API key is created - copy it straight away, it is shown only once.' },
  ],
  fields: [
    { key: 'projectKey', label: 'Jira project key', placeholder: 'QA', help: 'The short key in front of issue numbers (e.g. "QA" in QA-123). The Test, Test Set and Test Plan issue types must be enabled in this project.', required: true },
    { key: 'apiUrl', label: 'Xray API URL', placeholder: 'https://xray.cloud.getxray.app', help: 'Leave as default unless your Xray instance uses a regional endpoint (e.g. https://eu.xray.cloud.getxray.app).', required: false },
    { key: 'linkType', label: 'Requirement link type', placeholder: 'Test', help: 'Jira issue link type used to connect each test to the story. Xray\'s default is "Test" (tests / is tested by).', required: false },
  ],
  testConnection, findPlans, createPlan, ensureSuite, listSuites, createTestCase, listTestCases, finalize,
};
