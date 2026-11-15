/**
 * Zephyr Scale Cloud adapter (REST API v2).
 *
 *   Plan       = a top-level TEST_CASE folder named "<requirementId> <title>" (plan id = folder id).
 *                Zephyr "test cycles/plans" are execution objects and are not created here.
 *   Suite      = sub-folder under the plan folder (reused by name).
 *   Test case  = POST /testcases (name, objective, precondition, priorityName, labels, folderId),
 *                then POST /testcases/{key}/teststeps with inline steps, then a coverage link to
 *                the Jira requirement (POST /testcases/{key}/links/issues). That endpoint needs the
 *                numeric Jira issue id, which is looked up with the task-management Jira
 *                credentials (ctx.task.baseUrl + JIRA_EMAIL / JIRA_API_TOKEN). Without them the
 *                link is skipped and reported in the returned `warnings`.
 *   Priority   = Zephyr defaults High / Normal / Low (Critical→High, Medium→Normal);
 *                override with config.priorityMap if the project has custom priorities.
 *   Tags       = Zephyr labels (spaces replaced by "_").
 */

const { request, bearer, basicAuth } = require('../../core/http.js');

const SERVICE = 'Zephyr Scale';
const DEFAULT_PRIORITY = { Critical: 'High', High: 'High', Medium: 'Normal', Low: 'Low' };

function conn(ctx) {
  const c = ctx.config || {};
  const tok = (ctx.env || {}).ZEPHYR_API_TOKEN;
  if (!c.projectKey) throw new Error('Zephyr Scale: Jira project key is not configured. Fill it in the installer.');
  if (!tok) throw new Error('Zephyr Scale: ZEPHYR_API_TOKEN is missing from .env.');
  return { apiUrl: String(c.apiUrl || 'https://api.zephyrscale.smartbear.com/v2').replace(/\/+$/, ''), projectKey: c.projectKey, auth: bearer(tok) };
}

function api(ctx, path, opts = {}) {
  const c = conn(ctx);
  return request({ url: `${c.apiUrl}${path}`, service: SERVICE, ...opts, headers: { Authorization: c.auth, ...(opts.headers || {}) } });
}

async function paged(ctx, path) {
  const out = [];
  for (let startAt = 0; startAt < 20000;) {
    const r = await api(ctx, `${path}${path.includes('?') ? '&' : '?'}maxResults=1000&startAt=${startAt}`);
    out.push(...(r.values || []));
    if (r.isLast !== false || !(r.values || []).length) break;
    startAt += r.values.length;
  }
  return out;
}

function jiraConn(ctx) {
  const base = String((ctx.task || {}).baseUrl || '').replace(/\/+$/, '');
  const e = ctx.env || {};
  return base && e.JIRA_EMAIL && e.JIRA_API_TOKEN ? { base, auth: basicAuth(e.JIRA_EMAIL, e.JIRA_API_TOKEN) } : null;
}

const appUrl = (ctx, frag) => {
  const j = jiraConn(ctx);
  return j ? `${j.base}/projects/${conn(ctx).projectKey}?selectedItem=com.atlassian.plugins.atlassian-connect-plugin:com.kanoah.test-manager__main-project-page#!/${frag}` : '';
};
const folders = (ctx) => paged(ctx, `/folders?projectKey=${encodeURIComponent(conn(ctx).projectKey)}&folderType=TEST_CASE`);
const label = (t) => String(t).trim().replace(/\s+/g, '_');

// ---------- contract ----------
async function testConnection(ctx) {
  try {
    const p = await api(ctx, `/projects/${encodeURIComponent(conn(ctx).projectKey)}`);
    return { ok: true, message: `Connected to Zephyr Scale project ${p.key || conn(ctx).projectKey}.` };
  } catch (e) {
    return { ok: false, message: e.message, fix: 'Check the Jira project key and generate a new token in Jira → your profile picture → Zephyr API Access Tokens.' };
  }
}

async function findPlans(ctx, requirementId) {
  const re = new RegExp(`(^|[^\\w-])${String(requirementId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`);
  return (await folders(ctx))
    .filter((f) => !f.parentId && re.test(f.name || ''))
    .map((f) => ({ id: String(f.id), name: f.name, url: appUrl(ctx, `v2/testCases?folderId=${f.id}`) }));
}

async function createPlan(ctx, { name, requirement }) {
  const f = await api(ctx, '/folders', {
    method: 'POST',
    body: { parentId: null, name: (name || `${requirement.id} ${requirement.title}`).slice(0, 255), projectKey: conn(ctx).projectKey, folderType: 'TEST_CASE' },
  });
  return { id: String(f.id), url: appUrl(ctx, `v2/testCases?folderId=${f.id}`) };
}

async function listSuites(ctx, plan) {
  return (await folders(ctx)).filter((f) => String(f.parentId) === String(plan.id)).map((f) => ({ id: String(f.id), name: f.name }));
}

async function ensureSuite(ctx, plan, name) {
  const found = (await listSuites(ctx, plan)).find((s) => s.name.toLowerCase() === String(name).toLowerCase());
  if (found) return { id: found.id };
  const f = await api(ctx, '/folders', { method: 'POST', body: { parentId: Number(plan.id), name, projectKey: conn(ctx).projectKey, folderType: 'TEST_CASE' } });
  return { id: String(f.id) };
}

async function jiraIssueId(ctx, key) {
  const j = jiraConn(ctx);
  if (!j) return null;
  const r = await request({ url: `${j.base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`, service: 'Jira', headers: { Authorization: j.auth } });
  return r.id ? Number(r.id) : null;
}

async function createTestCase(ctx, { plan, suite, tc, requirement }) {
  const map = { ...DEFAULT_PRIORITY, ...((ctx.config || {}).priorityMap || {}) };
  const created = await api(ctx, '/testcases', {
    method: 'POST',
    body: {
      projectKey: conn(ctx).projectKey,
      name: String(tc.title).slice(0, 255),
      objective: [tc.acRef && `Acceptance criteria: ${tc.acRef}`, requirement && requirement.url && `Requirement: ${requirement.url}`].filter(Boolean).join('<br>'),
      precondition: tc.preconditions || '',
      priorityName: map[tc.priority] || 'Normal',
      labels: (tc.tags || []).map(label),
      folderId: Number((suite && suite.id) || plan.id),
    },
  });
  const key = created.key;
  const steps = tc.steps || [];
  if (steps.length) {
    await api(ctx, `/testcases/${key}/teststeps`, {
      method: 'POST',
      body: { mode: 'OVERWRITE', items: steps.map((s, i) => ({ inline: { description: s.action || '-', testData: i === 0 ? tc.testData || '' : '', expectedResult: s.expected || '' } })) },
    });
  }
  const warnings = [];
  if (requirement) {
    try {
      const issueId = await jiraIssueId(ctx, requirement.id);
      if (issueId) await api(ctx, `/testcases/${key}/links/issues`, { method: 'POST', body: { issueId } });
      else warnings.push(`Requirement link skipped for ${key}: Jira URL / JIRA_EMAIL / JIRA_API_TOKEN are not configured, so the Jira issue id of ${requirement.id} could not be looked up.`);
    } catch (e) { warnings.push(`Requirement link skipped for ${key}: ${e.message}`); }
  }
  return { id: key, url: appUrl(ctx, `v2/testCase/${key}`), warnings };
}

async function listTestCases(ctx, plan) {
  const all = await folders(ctx);
  const names = new Map(all.map((f) => [String(f.id), String(f.id) === String(plan.id) ? '' : f.name]));
  const want = new Set([String(plan.id)]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of all) if (f.parentId && want.has(String(f.parentId)) && !want.has(String(f.id))) { want.add(String(f.id)); grew = true; }
  }
  const prios = await paged(ctx, `/priorities?projectKey=${encodeURIComponent(conn(ctx).projectKey)}`).catch(() => []);
  const prioName = new Map(prios.map((p) => [p.id, p.name]));
  const rev = {};
  for (const [k, v] of Object.entries({ ...DEFAULT_PRIORITY, ...((ctx.config || {}).priorityMap || {}) })) if (!rev[v.toLowerCase()]) rev[v.toLowerCase()] = k;
  const out = [];
  for (const fid of want) {
    const cases = await paged(ctx, `/testcases?projectKey=${encodeURIComponent(conn(ctx).projectKey)}&folderId=${fid}`);
    for (const k of cases) {
      if (k.folder && String(k.folder.id) !== fid) continue; // folderId filter may include sub-folders
      const st = await paged(ctx, `/testcases/${k.key}/teststeps`).catch(() => []);
      const pName = String(prioName.get(k.priority && k.priority.id) || '').toLowerCase();
      out.push({
        id: k.key, title: k.name,
        priority: rev[pName] || 'Medium',
        steps: st.filter((s) => s.inline).map((s) => ({ action: stripHtml(s.inline.description), expected: stripHtml(s.inline.expectedResult) })),
        tags: k.labels || [], suite: names.get(fid) || '', url: appUrl(ctx, `v2/testCase/${k.key}`),
      });
    }
  }
  return out;
}

const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();

async function finalize() { return {}; }

module.exports = {
  id: 'zephyr-scale',
  label: 'Zephyr Scale (Jira Cloud)',
  secrets: [{
    env: 'ZEPHYR_API_TOKEN',
    label: 'Zephyr Scale API access token',
    help: 'In Jira click your profile picture → Zephyr API Access Tokens (or Apps → Zephyr → API Access Tokens) → Create access token. The token acts as you, so your Jira account must be able to create test cases in the project. Jira email + API token (Task management) are also used to link tests to stories.',
  }],
  fields: [
    { key: 'projectKey', label: 'Jira project key', placeholder: 'QA', help: 'The short key in front of issue numbers (e.g. "QA" in QA-123). Zephyr Scale must be enabled for this project.', required: true },
    { key: 'apiUrl', label: 'Zephyr Scale API URL', placeholder: 'https://api.zephyrscale.smartbear.com/v2', help: 'Leave as default. EU-hosted instances use https://eu.api.zephyrscale.smartbear.com/v2.', required: false },
  ],
  testConnection, findPlans, createPlan, ensureSuite, listSuites, createTestCase, listTestCases, finalize,
};
