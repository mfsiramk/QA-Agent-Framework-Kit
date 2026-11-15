/**
 * Task adapter - Linear (GraphQL API).
 * See ../CONTRACT.md for the function contract and normalized shapes.
 */
const { request } = require('../../core/http.js');
const B = require('./_bug.js');

const SERVICE = 'Linear';
const ENDPOINT = 'https://api.linear.app/graphql';
const id = 'linear';
const label = 'Linear';

const secrets = [
  { env: 'LINEAR_API_KEY', label: 'Linear personal API key',
    help: 'In Linear open Settings → Account → Security & access → Personal API keys → New API key. '
      + 'Give it Read and Write access (write is needed to post comments, create sub-issues and set labels/assignees) '
      + 'and allow it on the team that holds your stories. Copy the key - it starts with "lin_api_".' },
];

const fields = [
  { key: 'teamKey', label: 'Team key', placeholder: 'ENG', required: true,
    help: 'The short code in front of every issue number, e.g. ENG for issue ENG-123.' },
];

// ---------- helpers ----------
function cfg(ctx) {
  const c = ctx.config || {};
  if (!c.teamKey) throw new Error('Linear is not configured: set the Team key.');
  if (!ctx.env || !ctx.env.LINEAR_API_KEY) throw new Error('LINEAR_API_KEY is missing from .env.');
  return { key: ctx.env.LINEAR_API_KEY, team: c.teamKey, f: c.fields || {}, c, ctx };
}

async function gql(c, query, variables = {}) {
  const res = await request({ url: ENDPOINT, method: 'POST', service: SERVICE, headers: { Authorization: c.key }, body: { query, variables } });
  if (res.errors && res.errors.length) throw new Error(`Linear rejected the request: ${res.errors.map((e) => e.message).join('; ')}`);
  return res.data || {};
}

/** Where severity/priority/... live when bugFields does not say otherwise. */
const BUG_DEFAULTS = { severity: 'description', priority: 'priority', environment: 'description', foundIn: 'description' };

const ISSUE = `id identifier title description url estimate priority priorityLabel createdAt updatedAt completedAt canceledAt
  state { name } labels { nodes { id name } } team { key name } project { name } cycle { name number }
  assignee { name email } creator { name email } parent { identifier }
  children { nodes { identifier } }
  relations { nodes { type relatedIssue { identifier } } }
  inverseRelations { nodes { type issue { identifier } } }`;

const person = (u) => (u ? { name: u.name, id: u.email || u.name } : null);

function acFromBody(text) {
  const lines = String(text || '').split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*(#{1,6})?\s*\**\s*acceptance criteria\b/i.test(l));
  if (i < 0) return '';
  const rest = lines[i].replace(/^.*?acceptance criteria\s*\**\s*:?\s*\**/i, '').trim();
  const out = rest ? [rest] : [];
  for (const l of lines.slice(i + 1)) {
    if (/^\s*#{1,6}\s/.test(l) || /^\s*\*\*[^*]{2,40}\*\*\s*:?\s*$/.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

function normalize(c, i) {
  const labels = (i.labels?.nodes || []).map((l) => l.name);
  const q = c.f.qaAssignee;
  let qaAssignee = null;
  if (q === 'assignee') qaAssignee = person(i.assignee);
  else if (q && String(q).startsWith('label:')) {
    const pre = String(q).slice(6); const l = labels.find((x) => x.startsWith(pre));
    qaAssignee = l ? { name: l.slice(pre.length), id: l.slice(pre.length) } : null;
  }
  const src = { priority: () => (i.priority ? i.priorityLabel : null), labels, description: i.description || '' };
  const links = [];
  if (i.parent) links.push({ rel: 'parent', id: i.parent.identifier });
  for (const ch of i.children?.nodes || []) links.push({ rel: 'child', id: ch.identifier });
  for (const r of i.relations?.nodes || []) links.push({ rel: r.type === 'blocks' ? 'successor' : 'related', id: r.relatedIssue?.identifier });
  for (const r of i.inverseRelations?.nodes || []) links.push({ rel: r.type === 'blocks' ? 'predecessor' : 'related', id: r.issue?.identifier });
  return {
    id: i.identifier,
    type: 'Issue',
    title: i.title || '',
    state: i.state?.name || '',
    description: i.description || '',
    acceptanceCriteria: acFromBody(i.description),
    tags: labels,
    component: i.project?.name || i.team?.name || '',
    release: i.cycle ? (i.cycle.name || `Cycle ${i.cycle.number}`) : '',
    assignee: person(i.assignee),
    qaAssignee,
    createdBy: person(i.creator),
    storyPoints: i.estimate === null || i.estimate === undefined ? null : Number(i.estimate),
    parentId: i.parent?.identifier || null,
    url: i.url,
    links: links.filter((l) => l.id),
    severity: B.readField(c.ctx, 'severity', BUG_DEFAULTS, src),
    priority: B.readField(c.ctx, 'priority', BUG_DEFAULTS, src),
    environment: B.readField(c.ctx, 'environment', BUG_DEFAULTS, src),
    createdDate: B.iso(i.createdAt),
    changedDate: B.iso(i.updatedAt),
    closedDate: B.iso(i.completedAt || i.canceledAt),
  };
}

async function issueRaw(c, key) {
  const d = await gql(c, `query($id: String!) { issue(id: $id) { ${ISSUE} } }`, { id: key });
  if (!d.issue) throw new Error(`Linear could not find issue ${key}.`);
  return d.issue;
}

async function teamId(c) {
  const d = await gql(c, 'query($k: String!) { teams(filter: { key: { eq: $k } }) { nodes { id name key } } }', { k: c.team });
  const t = (d.teams?.nodes || [])[0];
  if (!t) throw new Error(`Linear has no team with key "${c.team}" visible to this API key.`);
  return t;
}

async function userId(c, p) {
  const who = p && (p.id || p.name);
  if (!who) return null;
  const filter = String(who).includes('@') ? { email: { eq: who } } : { or: [{ name: { eqIgnoreCase: who } }, { displayName: { eqIgnoreCase: who } }] };
  const d = await gql(c, 'query($f: UserFilter) { users(filter: $f) { nodes { id } } }', { f: filter });
  const u = (d.users?.nodes || [])[0];
  if (!u) throw new Error(`Linear could not find a user matching "${who}": use their Linear email address.`);
  return u.id;
}

// ---------- contract ----------
async function testConnection(ctx) {
  try {
    const c = cfg(ctx);
    const t = await teamId(c);
    return { ok: true, message: `Connected to Linear team ${t.key} (${t.name}).` };
  } catch (e) {
    const s = e.status;
    const fix = s === 401 || /authenticat/i.test(e.message) ? 'Create a new Linear personal API key and paste it into LINEAR_API_KEY in .env.'
      : /no team/.test(e.message) ? 'Check the Team key (the letters before the dash in an issue number) and that the API key is allowed on that team.'
      : /not configured|missing/.test(e.message) ? 'Fill in the Team key and LINEAR_API_KEY, then test again.'
      : 'Check the API key and your network connection, then test again.';
    return { ok: false, message: e.message, fix };
  }
}

async function getWorkItem(ctx, key) {
  const c = cfg(ctx);
  return normalize(c, await issueRaw(c, key));
}

async function getChildren(ctx, key) {
  const c = cfg(ctx);
  const d = await gql(c, `query($id: String!) { issue(id: $id) { children(first: 100) { nodes { ${ISSUE} } } } }`, { id: key });
  return (d.issue?.children?.nodes || []).map((i) => normalize(c, i));
}

async function getComments(ctx, key) {
  const c = cfg(ctx);
  const out = []; let after = null;
  do {
    const d = await gql(c, `query($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after) {
      nodes { id body createdAt user { name email } } pageInfo { hasNextPage endCursor } } } }`, { id: key, after });
    const page = d.issue?.comments;
    for (const cm of page?.nodes || []) out.push({ id: cm.id, author: person(cm.user) || { name: '', id: '' }, date: cm.createdAt, text: cm.body || '' });
    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

async function addComment(ctx, key, markdown) {
  const c = cfg(ctx);
  const issue = await issueRaw(c, key);
  const d = await gql(c, 'mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success comment { id url } } }',
    { i: { issueId: issue.id, body: String(markdown || '') } });
  const cm = d.commentCreate?.comment || {};
  return { id: cm.id, url: cm.url || issue.url };
}

async function createTask(ctx, { parentId, title, description, assignee }) {
  const c = cfg(ctx);
  const input = { teamId: (await teamId(c)).id, title, description: description || '' };
  if (parentId) input.parentId = (await issueRaw(c, parentId)).id;
  const uid = await userId(c, assignee);
  if (uid) input.assigneeId = uid;
  const d = await gql(c, 'mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success issue { identifier url } } }', { i: input });
  const i = d.issueCreate?.issue || {};
  return { id: i.identifier, url: i.url };
}

/** IssueFilter fragment for a release (cycle / label / project). */
function releaseFilter(c, release) {
  const rc = c.f.release || { type: 'cycle', pattern: '{release}' };
  const v = String(rc.pattern || '{release}').replace(/\{release\}/g, release);
  const type = rc.type || 'cycle';
  if (type === 'cycle') return { cycle: /^\d+$/.test(v) ? { number: { eq: Number(v) } } : { name: { eq: v } } };
  if (type === 'label') return { labels: { some: { name: { eq: v } } } };
  if (type === 'project') return { project: { name: { eq: v } } };
  throw new Error(`Linear does not support release type "${type}": use "cycle", "label" or "project".`);
}

async function listReleaseItems(ctx, release) {
  const c = cfg(ctx);
  const filter = { team: { key: { eq: c.team } }, ...releaseFilter(c, release) };
  const exS = c.c.excludedStates || [];
  if (exS.length) filter.state = { name: { nin: exS } };
  // Linear has no issue types; excludedTypes is ignored.
  const out = []; let after = null;
  do {
    const d = await gql(c, `query($f: IssueFilter, $after: String) { issues(filter: $f, first: 100, after: $after) {
      nodes { ${ISSUE} } pageInfo { hasNextPage endCursor } } }`, { f: filter, after });
    out.push(...(d.issues?.nodes || []).map((i) => normalize(c, i)));
    after = d.issues?.pageInfo?.hasNextPage ? d.issues.pageInfo.endCursor : null;
  } while (after);
  return out;
}

async function setQaAssignee(ctx, key, p) {
  const c = cfg(ctx);
  const q = c.f.qaAssignee;
  const issue = await issueRaw(c, key);
  const who = p ? (p.id || p.name) : '';
  let input;
  if (q === 'assignee') input = { assigneeId: await userId(c, p) };
  else if (q && String(q).startsWith('label:')) {
    const pre = String(q).slice(6);
    const keep = (issue.labels?.nodes || []).filter((l) => !l.name.startsWith(pre)).map((l) => l.id);
    if (who) {
      const name = pre + who;
      const t = await teamId(c);
      const d = await gql(c, 'query($n: String!) { issueLabels(filter: { name: { eq: $n } }) { nodes { id } } }', { n: name });
      let lid = (d.issueLabels?.nodes || [])[0]?.id;
      if (!lid) lid = (await gql(c, 'mutation($i: IssueLabelCreateInput!) { issueLabelCreate(input: $i) { issueLabel { id } } }', { i: { name, teamId: t.id } })).issueLabelCreate?.issueLabel?.id;
      keep.push(lid);
    }
    input = { labelIds: keep };
  } else {
    throw new Error('Linear does not support custom QA fields: set fields.qaAssignee to "label:qa-" or "assignee".');
  }
  await gql(c, 'mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }', { id: issue.id, i: input });
  return { ok: true };
}

async function searchItems(ctx, query = {}) {
  const c = cfg(ctx);
  const q = query || {};
  const max = Number(q.max) > 0 ? Number(q.max) : 500;
  const and = [];
  // Linear has no issue types: each type is a label name (any of them).
  if ((q.types || []).length) and.push({ labels: { some: { or: q.types.map((t) => ({ name: { eqIgnoreCase: String(t) } })) } } });
  if ((q.states || []).length) and.push({ state: { name: { in: q.states } } });
  if ((q.notStates || []).length) and.push({ state: { name: { nin: q.notStates } } });
  if (q.release) and.push(releaseFilter(c, q.release));
  const created = {};
  if (q.createdFrom) created.gte = new Date(q.createdFrom).toISOString();
  if (q.createdTo) created.lte = new Date(B.endOfDay(q.createdTo)).toISOString();
  if (Object.keys(created).length) and.push({ createdAt: created });
  for (const w of B.titleWords(q.text)) and.push({ title: { containsIgnoreCase: w } });
  const filter = { team: { key: { eq: c.team } }, ...(and.length ? { and } : {}) };
  const out = []; let after = null;
  do {
    const d = await gql(c, `query($f: IssueFilter, $after: String) { issues(filter: $f, first: 100, after: $after, orderBy: createdAt) {
      nodes { ${ISSUE} } pageInfo { hasNextPage endCursor } } }`, { f: filter, after });
    out.push(...(d.issues?.nodes || []).map((i) => normalize(c, i)));
    after = d.issues?.pageInfo?.hasNextPage ? d.issues.pageInfo.endCursor : null;
  } while (after && out.length < max);
  return out.slice(0, max);
}

/** Look up label ids by name (team label first, then workspace label); unknown names are reported, not created. */
async function labelIds(c, names) {
  const ids = []; const missing = [];
  for (const n of [...new Set(names.map((x) => String(x).trim()).filter(Boolean))]) {
    const d = await gql(c, 'query($n: String!) { issueLabels(filter: { name: { eqIgnoreCase: $n } }) { nodes { id team { key } } } }', { n });
    const nodes = d.issueLabels?.nodes || [];
    const hit = nodes.find((l) => l.team && l.team.key === c.team) || nodes.find((l) => !l.team);
    if (hit) ids.push(hit.id); else missing.push(n);
  }
  return { ids, missing };
}

async function createBug(ctx, bug = {}) {
  const c = cfg(ctx);
  const f = bug.fields || {};
  const plan = B.planBugFields(ctx, bug, BUG_DEFAULTS, ['priority', 'label'], 'Linear');
  const warnings = [...plan.warnings];
  const lines = [...plan.descLines];
  const input = { teamId: (await teamId(c)).id, title: bug.title || '(untitled bug)' };
  for (const w of plan.writes) {
    // Linear priority: 1 Urgent, 2 High, 3 Medium, 4 Low (0 = none).
    const n = B.priorityNumber(w.value);
    if (n >= 1 && n <= 4) input.priority = n;
    else { warnings.push(`Priority "${w.value}" does not map to Linear Urgent/High/Medium/Low; it was added to the description instead.`); lines.push(B.descriptionLine(w.key, w.value)); }
  }
  if (f.component) { lines.push(B.descriptionLine('component', f.component)); warnings.push('Linear has no components; the component was added to the description.'); }
  const { ids, missing } = await labelIds(c, [bug.type || 'Bug', ...(bug.tags || []), ...plan.labels]);
  if (missing.length) warnings.push(`Linear has no label named ${missing.map((m) => `"${m}"`).join(', ')}; create it in Linear (Settings > Labels) to have it applied next time.`);
  if (ids.length) input.labelIds = ids;
  if (f.assignee && (f.assignee.id || f.assignee.name)) {
    try { input.assigneeId = await userId(c, f.assignee); } catch (e) { warnings.push(`${e.message} The issue was created unassigned.`); }
  }
  const link = bug.linkTo && bug.linkTo.id ? bug.linkTo : null;
  let target = null;
  if (link) {
    try { target = await issueRaw(c, link.id); } catch (e) { warnings.push(`${e.message} The bug was not linked.`); lines.push(`Related: ${link.id}`); }
    if (target && link.rel === 'parent') input.parentId = target.id;
  }
  input.description = B.composeDescription(bug.description, lines);
  const d = await gql(c, 'mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success issue { id identifier url } } }', { i: input });
  const i = d.issueCreate?.issue || {};
  if (target && link.rel !== 'parent') {
    try {
      await gql(c, 'mutation($i: IssueRelationCreateInput!) { issueRelationCreate(input: $i) { success } }', { i: { issueId: i.id, relatedIssueId: target.id, type: 'related' } });
    } catch (e) { warnings.push(`Linear could not relate ${i.identifier} to ${link.id} (${e.message}); link them by hand.`); }
  }
  return { id: i.identifier, url: i.url, warnings };
}

async function attachFile(ctx, key) {
  throw new Error(`Linear does not support attachments through the API: add the screenshot by dragging it into issue ${key} in the browser.`);
}

module.exports = {
  id, label, secrets, fields, testConnection, getWorkItem, getChildren, getComments, addComment, createTask, listReleaseItems, setQaAssignee,
  searchItems, createBug, attachFile,
};
