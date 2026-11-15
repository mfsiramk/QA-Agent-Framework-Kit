/**
 * TestRail adapter (API v2).
 *
 * How the generic "plan / suite / test case" model maps onto TestRail:
 *   Plan       = a top-level SECTION named "<requirementId> <title>" (it holds the cases)
 *                plus a MILESTONE with the same name; every case is attached to the
 *                milestone (milestone_id) so the work shows up on release dashboards.
 *                The plan id returned is the section id. TestRail "test plans/runs" are
 *                execution objects, so they are deliberately NOT created here.
 *   Suite      = child section under the plan section (reused by name).
 *   Test case  = add_case with custom_steps_separated (Steps (separated) template).
 *                If the project's template rejects that field, the case is re-sent with
 *                custom_steps / custom_expected as numbered text.
 *   Requirement= stored in `refs` (TestRail's References field).
 *   Priority   = matched by name against get_priorities (Critical/High/Medium/Low),
 *                falling back to the priority ranking.
 *   Tags       = if config.tagsField is set (a TEXT custom field system name such as
 *                "custom_tags") tags are written there comma-separated; otherwise a first
 *                line "[tags: Automation, Smoke]" is added to custom_preconds and parsed
 *                back on read, so a QA can edit tags in the Preconditions box.
 *   findPlans  = top-level sections whose name contains the requirement id.
 */

const { request, basicAuth } = require('../../core/http.js');

const SERVICE = 'TestRail';
const TAG_LINE = /^\s*\[tags:\s*([^\]]*)\]\s*\n?/i;

function conn(ctx) {
  const c = ctx.config || {};
  const e = ctx.env || {};
  const baseUrl = String(c.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !c.projectId) throw new Error('TestRail: base URL and project ID are not configured. Fill them in the installer.');
  if (!e.TESTRAIL_USER || !e.TESTRAIL_API_KEY) throw new Error('TestRail: TESTRAIL_USER / TESTRAIL_API_KEY are missing from .env.');
  return { baseUrl, projectId: c.projectId, suiteId: c.suiteId || '', auth: basicAuth(e.TESTRAIL_USER, e.TESTRAIL_API_KEY) };
}

function api(ctx, path, body) {
  const c = conn(ctx);
  return request({
    url: `${c.baseUrl}/index.php?/api/v2/${path}`,
    method: body ? 'POST' : 'GET',
    body,
    service: SERVICE,
    headers: { Authorization: c.auth, 'Content-Type': 'application/json' },
  });
}

/** TestRail 6.7+ paginates ({ sections: [], _links: { next } }); older versions return arrays. */
async function getAll(ctx, path, key) {
  const out = [];
  let next = path;
  for (let i = 0; next && i < 100; i++) {
    const r = await api(ctx, next);
    if (Array.isArray(r)) { out.push(...r); break; }
    out.push(...(r[key] || []));
    next = r._links && r._links.next ? r._links.next.replace(/^\/api\/v2\//, '') : null;
  }
  return out;
}

const suiteParam = (ctx) => (conn(ctx).suiteId ? `&suite_id=${conn(ctx).suiteId}` : '');
const sections = (ctx) => getAll(ctx, `get_sections/${conn(ctx).projectId}${suiteParam(ctx)}`, 'sections');
const sectionUrl = (ctx, id) => `${conn(ctx).baseUrl}/index.php?/suites/view/${conn(ctx).suiteId || ''}&group_by=cases:section_id&group_id=${id}`;
const caseUrl = (ctx, id) => `${conn(ctx).baseUrl}/index.php?/cases/view/${id}`;

let _priorities = null;
async function priorities(ctx) {
  if (!_priorities) _priorities = await api(ctx, 'get_priorities');
  return _priorities;
}
async function priorityId(ctx, name) {
  const list = await priorities(ctx);
  const n = String(name || 'Medium').toLowerCase();
  const byName = list.find((p) => (p.name || '').toLowerCase() === n || (p.short_name || '').toLowerCase() === n);
  if (byName) return byName.id;
  const ranked = [...list].sort((a, b) => b.priority - a.priority); // highest first
  const idx = { critical: 0, high: 1, medium: 2, low: 3 }[n] ?? 2;
  return (ranked[Math.round(idx * (ranked.length - 1) / 3)] || {}).id;
}
async function priorityName(ctx, id) {
  const list = await priorities(ctx);
  const p = list.find((x) => x.id === id);
  if (!p) return 'Medium';
  for (const n of ['Critical', 'High', 'Medium', 'Low']) if ((p.name || '').toLowerCase().includes(n.toLowerCase())) return n;
  const ranked = [...list].sort((a, b) => b.priority - a.priority);
  const pos = ranked.indexOf(p) / Math.max(1, ranked.length - 1);
  return ['Critical', 'High', 'Medium', 'Low'][Math.round(pos * 3)];
}

// ---------- contract ----------
async function testConnection(ctx) {
  try {
    const p = await api(ctx, `get_project/${conn(ctx).projectId}`);
    return { ok: true, message: `Connected to TestRail project "${p.name}".` };
  } catch (e) {
    return { ok: false, message: e.message, fix: 'Check the TestRail URL and project ID, and that TESTRAIL_USER/TESTRAIL_API_KEY are correct and the API is enabled (Administration → Site Settings → API).' };
  }
}

async function findPlans(ctx, requirementId) {
  const re = new RegExp(`(^|[^\\w-])#?${String(requirementId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`);
  return (await sections(ctx))
    .filter((s) => !s.parent_id && re.test(s.name || ''))
    .map((s) => ({ id: String(s.id), name: s.name, url: sectionUrl(ctx, s.id) }));
}

async function createPlan(ctx, { name, requirement }) {
  const c = conn(ctx);
  const title = name || `${requirement.id} ${requirement.title}`;
  const milestones = await getAll(ctx, `get_milestones/${c.projectId}`, 'milestones');
  let ms = milestones.find((m) => m.name === title);
  if (!ms) ms = await api(ctx, `add_milestone/${c.projectId}`, { name: title, description: requirement.url || '' });
  const body = { name: title, description: requirement.url || '' };
  if (c.suiteId) body.suite_id = Number(c.suiteId);
  const sec = await api(ctx, `add_section/${c.projectId}`, body);
  return { id: String(sec.id), url: sectionUrl(ctx, sec.id), milestoneId: String(ms.id) };
}

async function listSuites(ctx, plan) {
  return (await sections(ctx)).filter((s) => String(s.parent_id) === String(plan.id)).map((s) => ({ id: String(s.id), name: s.name }));
}

async function ensureSuite(ctx, plan, name) {
  const found = (await listSuites(ctx, plan)).find((s) => s.name.toLowerCase() === String(name).toLowerCase());
  if (found) return { id: found.id };
  const c = conn(ctx);
  const body = { name, parent_id: Number(plan.id) };
  if (c.suiteId) body.suite_id = Number(c.suiteId);
  const sec = await api(ctx, `add_section/${c.projectId}`, body);
  return { id: String(sec.id) };
}

async function milestoneFor(ctx, plan) {
  if (plan.milestoneId) return plan.milestoneId;
  const sec = (await sections(ctx)).find((s) => String(s.id) === String(plan.id));
  if (!sec) return null;
  const ms = (await getAll(ctx, `get_milestones/${conn(ctx).projectId}`, 'milestones')).find((m) => m.name === sec.name);
  return ms ? String(ms.id) : null;
}

async function createTestCase(ctx, { plan, suite, tc, requirement }) {
  const tagsField = (ctx.config || {}).tagsField;
  const tags = tc.tags || [];
  let pre = [tc.preconditions, tc.testData ? `Test data: ${tc.testData}` : ''].filter(Boolean).join('\n');
  if (!tagsField && tags.length) pre = `[tags: ${tags.join(', ')}]\n${pre}`;
  const base = {
    title: String(tc.title).slice(0, 250),
    priority_id: await priorityId(ctx, tc.priority),
    refs: requirement ? String(requirement.id) : '',
    custom_preconds: pre,
  };
  const ms = await milestoneFor(ctx, plan);
  if (ms) base.milestone_id = Number(ms);
  if (tagsField) base[tagsField] = tags.join(', ');
  const steps = tc.steps || [];
  const sectionId = (suite && suite.id) || plan.id;
  let created;
  try {
    created = await api(ctx, `add_case/${sectionId}`, { ...base, custom_steps_separated: steps.map((s) => ({ content: s.action, expected: s.expected })) });
  } catch (e) {
    if (e.status !== 400) throw e;
    created = await api(ctx, `add_case/${sectionId}`, {
      ...base,
      custom_steps: steps.map((s, i) => `${i + 1}. ${s.action}`).join('\n'),
      custom_expected: steps.map((s, i) => `${i + 1}. ${s.expected}`).join('\n'),
    });
  }
  return { id: String(created.id), url: caseUrl(ctx, created.id) };
}

function numbered(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
}

async function listTestCases(ctx, plan) {
  const c = conn(ctx);
  const tagsField = (ctx.config || {}).tagsField;
  const all = await sections(ctx);
  const names = new Map();
  const want = new Set([String(plan.id)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of all) {
      if (s.parent_id && want.has(String(s.parent_id)) && !want.has(String(s.id))) { want.add(String(s.id)); grew = true; }
    }
  }
  for (const s of all) names.set(String(s.id), String(s.id) === String(plan.id) ? '' : s.name);
  const out = [];
  for (const sid of want) {
    const cases = await getAll(ctx, `get_cases/${c.projectId}${suiteParam(ctx)}&section_id=${sid}`, 'cases');
    for (const k of cases) {
      let tags = [];
      if (tagsField) tags = String(k[tagsField] || '').split(',');
      else { const m = String(k.custom_preconds || '').match(TAG_LINE); if (m) tags = m[1].split(','); }
      let steps = (k.custom_steps_separated || []).map((s) => ({ action: s.content || '', expected: s.expected || '' }));
      if (!steps.length && (k.custom_steps || k.custom_expected)) {
        const a = numbered(k.custom_steps); const x = numbered(k.custom_expected);
        steps = a.map((action, i) => ({ action, expected: x[i] || '' }));
      }
      out.push({
        id: String(k.id), title: k.title, priority: await priorityName(ctx, k.priority_id), steps,
        tags: tags.map((t) => t.trim()).filter(Boolean), suite: names.get(String(k.section_id)) || '', url: caseUrl(ctx, k.id),
      });
    }
  }
  return out;
}

async function finalize() { return {}; }

module.exports = {
  id: 'testrail',
  label: 'TestRail',
  secrets: [
    { env: 'TESTRAIL_USER', label: 'TestRail login email', help: 'The email address you sign in to TestRail with.' },
    { env: 'TESTRAIL_API_KEY', label: 'TestRail API key', help: 'In TestRail click your name (top right) → My Settings → API Keys → Add Key. The API must be enabled by an admin (Administration → Site Settings → API). Your role needs "Add/edit test cases" and "Add/edit milestones".' },
  ],
  fields: [
    { key: 'baseUrl', label: 'TestRail URL', placeholder: 'https://yourcompany.testrail.io', help: 'The address you open TestRail at, without any page path.', required: true },
    { key: 'projectId', label: 'Project ID', placeholder: '1', help: 'Open the project in TestRail - the number after "projects/overview/" in the address bar.', required: true },
    { key: 'suiteId', label: 'Test suite ID (multi-suite projects only)', placeholder: '3', help: 'Only if your project uses multiple test suites: open the suite, the number after "suites/view/" in the address bar. Leave empty for single-suite projects.', required: false },
    { key: 'tagsField', label: 'Tags custom field (optional)', placeholder: 'custom_tags', help: 'System name of a TEXT custom field to hold tags. Leave empty to keep tags as a "[tags: …]" first line in Preconditions.', required: false },
  ],
  testConnection, findPlans, createPlan, ensureSuite, listSuites, createTestCase, listTestCases, finalize,
};
