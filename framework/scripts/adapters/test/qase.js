/**
 * Qase adapter (API v1).
 *
 *   Plan       = top-level suite "<requirementId> <title>" (plan id = suite id). Qase "test
 *                plans" are execution groupings, so cases live in suites instead.
 *   Suite      = child suite under the plan suite (reused by title).
 *   Test case  = POST /case/{code} with steps (action / expected_result / data), tags,
 *                priority and a description that contains the requirement link.
 *   Priority   = Qase priority 1 high / 2 medium / 3 low; "Critical" is stored as
 *                priority high + severity critical and read back that way.
 *   findPlans  = suites searched by title containing the requirement id.
 */

const { request } = require('../../core/http.js');

const SERVICE = 'Qase';
const PRIORITY = { Critical: 1, High: 1, Medium: 2, Low: 3 };
const SEVERITY_CRITICAL = 2;

function conn(ctx) {
  const c = ctx.config || {};
  const tok = (ctx.env || {}).QASE_API_TOKEN;
  if (!c.projectCode) throw new Error('Qase: project code is not configured. Fill it in the installer.');
  if (!tok) throw new Error('Qase: QASE_API_TOKEN is missing from .env.');
  return { apiUrl: String(c.apiUrl || 'https://api.qase.io/v1').replace(/\/+$/, ''), appUrl: String(c.appUrl || 'https://app.qase.io').replace(/\/+$/, ''), code: c.projectCode, token: tok };
}

async function api(ctx, path, opts = {}) {
  const c = conn(ctx);
  const r = await request({ url: `${c.apiUrl}${path}`, service: SERVICE, ...opts, headers: { Token: c.token, ...(opts.headers || {}) } });
  if (r && r.status === false) throw new Error(`Qase rejected the request: ${r.errorMessage || JSON.stringify(r.errorFields || r)}`);
  return r.result;
}

async function paged(ctx, path) {
  const out = [];
  for (let offset = 0; offset < 50000; offset += 100) {
    const r = await api(ctx, `${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${offset}`);
    const ents = (r && r.entities) || [];
    out.push(...ents);
    if (ents.length < 100 || out.length >= (r.total || r.filtered || 0)) break;
  }
  return out;
}

const suiteUrl = (ctx, id) => `${conn(ctx).appUrl}/project/${conn(ctx).code}?suite=${id}`;
const caseUrl = (ctx, id) => `${conn(ctx).appUrl}/case/${conn(ctx).code}-${id}`;
const allSuites = (ctx, search) => paged(ctx, `/suite/${conn(ctx).code}${search ? `?search=${encodeURIComponent(search)}` : ''}`);

// ---------- contract ----------
async function testConnection(ctx) {
  try {
    const p = await api(ctx, `/project/${encodeURIComponent(conn(ctx).code)}`);
    return { ok: true, message: `Connected to Qase project "${(p && p.title) || conn(ctx).code}".` };
  } catch (e) {
    return { ok: false, message: e.message, fix: 'Check the project code (letters shown before case numbers) and create a new token in Qase → your avatar → API tokens.' };
  }
}

async function findPlans(ctx, requirementId) {
  const re = new RegExp(`(^|[^\\w-])#?${String(requirementId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`);
  return (await allSuites(ctx, String(requirementId)))
    .filter((s) => !s.parent_id && re.test(s.title || ''))
    .map((s) => ({ id: String(s.id), name: s.title, url: suiteUrl(ctx, s.id) }));
}

async function createPlan(ctx, { name, requirement }) {
  const r = await api(ctx, `/suite/${conn(ctx).code}`, {
    method: 'POST',
    body: { title: (name || `${requirement.id} ${requirement.title}`).slice(0, 255), description: requirement.url ? `Requirement: ${requirement.url}` : '', parent_id: null },
  });
  return { id: String(r.id), url: suiteUrl(ctx, r.id) };
}

async function listSuites(ctx, plan) {
  return (await allSuites(ctx)).filter((s) => String(s.parent_id) === String(plan.id)).map((s) => ({ id: String(s.id), name: s.title }));
}

async function ensureSuite(ctx, plan, name) {
  const found = (await listSuites(ctx, plan)).find((s) => s.name.toLowerCase() === String(name).toLowerCase());
  if (found) return { id: found.id };
  const r = await api(ctx, `/suite/${conn(ctx).code}`, { method: 'POST', body: { title: name, parent_id: Number(plan.id) } });
  return { id: String(r.id) };
}

async function createTestCase(ctx, { plan, suite, tc, requirement }) {
  const body = {
    title: String(tc.title).slice(0, 255),
    description: [requirement && `Requirement: ${requirement.id}${requirement.url ? ` - ${requirement.url}` : ''}`, tc.acRef && `Acceptance criteria: ${tc.acRef}`].filter(Boolean).join('\n\n'),
    preconditions: tc.preconditions || '',
    priority: PRIORITY[tc.priority] || 2,
    suite_id: Number((suite && suite.id) || plan.id),
    tags: tc.tags || [],
    steps: (tc.steps || []).map((s, i) => ({ action: s.action || '-', expected_result: s.expected || '', data: i === 0 ? tc.testData || '' : '' })),
  };
  if (tc.priority === 'Critical') body.severity = SEVERITY_CRITICAL;
  const r = await api(ctx, `/case/${conn(ctx).code}`, { method: 'POST', body });
  return { id: String(r.id), url: caseUrl(ctx, r.id) };
}

function priorityOf(c) {
  const p = typeof c.priority === 'string' ? c.priority.toLowerCase() : Number(c.priority);
  const sev = typeof c.severity === 'string' ? c.severity.toLowerCase() : Number(c.severity);
  if ((p === 1 || p === 'high') && (sev === SEVERITY_CRITICAL || sev === 'critical' || sev === 1 || sev === 'blocker')) return 'Critical';
  if (p === 1 || p === 'high') return 'High';
  if (p === 3 || p === 'low') return 'Low';
  return 'Medium';
}

async function listTestCases(ctx, plan) {
  const all = await allSuites(ctx);
  const names = new Map(all.map((s) => [String(s.id), String(s.id) === String(plan.id) ? '' : s.title]));
  const want = new Set([String(plan.id)]);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of all) if (s.parent_id && want.has(String(s.parent_id)) && !want.has(String(s.id))) { want.add(String(s.id)); grew = true; }
  }
  const seen = new Set();
  const out = [];
  for (const sid of want) {
    for (const c of await paged(ctx, `/case/${conn(ctx).code}?suite_id=${sid}`)) {
      if (seen.has(c.id) || !want.has(String(c.suite_id))) continue;
      seen.add(c.id);
      out.push({
        id: String(c.id), title: c.title, priority: priorityOf(c),
        steps: (c.steps || []).sort((a, b) => (a.position || 0) - (b.position || 0)).map((s) => ({ action: s.action || '', expected: s.expected_result || '' })),
        tags: (c.tags || []).map((t) => (typeof t === 'string' ? t : t.title)).filter(Boolean),
        suite: names.get(String(c.suite_id)) || '', url: caseUrl(ctx, c.id),
      });
    }
  }
  return out;
}

async function finalize() { return {}; }

module.exports = {
  id: 'qase',
  label: 'Qase',
  secrets: [{
    env: 'QASE_API_TOKEN',
    label: 'Qase API token',
    help: 'In Qase click your avatar (bottom left) → API tokens → Create a new API token. It acts as you, so your role must allow creating suites and test cases in the project.',
  }],
  fields: [
    { key: 'projectCode', label: 'Project code', placeholder: 'DEMO', help: 'The short code shown before case numbers (e.g. "DEMO" in DEMO-12), also visible in the project URL.', required: true },
  ],
  testConnection, findPlans, createPlan, ensureSuite, listSuites, createTestCase, listTestCases, finalize,
};
