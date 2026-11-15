/**
 * Task adapter - GitLab Issues (gitlab.com or self-managed).
 * See ../CONTRACT.md for the function contract and normalized shapes.
 */
const fs = require('fs');
const path = require('path');
const { request } = require('../../core/http.js');
const B = require('./_bug.js');

/** Issue trackers without custom fields: severity etc. go to labels (label:<prefix>) or the description. */
const BUG_DEFAULTS = { severity: 'description', priority: 'description', environment: 'description', foundIn: 'description' };

const SERVICE = 'GitLab';
const id = 'gitlab';
const label = 'GitLab Issues';

const secrets = [
  { env: 'GITLAB_TOKEN', label: 'GitLab access token',
    help: 'In GitLab click your avatar → Edit profile → Access tokens → Add new token (or use a Project access token with the Reporter/Developer role). '
      + 'Tick the "api" scope - it is needed to read issues, add comments (notes), create tasks and change labels/assignees. '
      + '"read_api" alone is enough only for the code-changes step. The same token is reused for GitLab code changes.' },
];

const fields = [
  { key: 'baseUrl', label: 'GitLab URL', placeholder: 'https://gitlab.com', required: true,
    help: 'https://gitlab.com, or the address of your company\'s own GitLab server.' },
  { key: 'projectPath', label: 'Project path', placeholder: 'my-group/my-project', required: true,
    help: 'The part of the project address after the GitLab URL, e.g. my-group/my-project.' },
];

// ---------- helpers ----------
function cfg(ctx) {
  const c = ctx.config || {};
  const base = String(c.baseUrl || 'https://gitlab.com').replace(/\/+$/, '');
  if (!c.projectPath) throw new Error('GitLab is not configured: set the Project path.');
  if (!ctx.env || !ctx.env.GITLAB_TOKEN) throw new Error('GITLAB_TOKEN is missing from .env.');
  return { base, api: `${base}/api/v4`, proj: `${base}/api/v4/projects/${encodeURIComponent(c.projectPath)}`, token: ctx.env.GITLAB_TOKEN, f: c.fields || {}, c, ctx };
}

const call = (c, url, opts = {}) => request({ ...opts, url: url.startsWith('http') ? url : c.proj + url, service: SERVICE,
  headers: { 'PRIVATE-TOKEN': c.token, ...(opts.headers || {}) } });

async function paged(c, path) {
  const out = [];
  for (let page = 1; page < 100; page++) {
    const res = await call(c, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const arr = Array.isArray(res) ? res : [];
    out.push(...arr);
    if (arr.length < 100) break;
  }
  return out;
}

const person = (u) => (u ? { name: u.name || u.username, id: u.username } : null);

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

function taskListRefs(body) {
  const ids = new Set();
  const re = /^\s*[-*]\s+\[[ xX]\]\s+(?:#(\d+)|https?:\/\/\S+\/-\/(?:issues|work_items)\/(\d+))/gm; let m;
  while ((m = re.exec(String(body || '')))) ids.add(m[1] || m[2]);
  return [...ids];
}

function qaFrom(c, issue) {
  const q = c.f.qaAssignee;
  if (q === 'assignee') return person((issue.assignees || [])[0] || issue.assignee);
  if (q && String(q).startsWith('label:')) {
    const pre = String(q).slice(6);
    const l = (issue.labels || []).find((n) => n.startsWith(pre));
    return l ? { name: l.slice(pre.length), id: l.slice(pre.length) } : null;
  }
  return null;
}

function normalize(c, issue, extraLinks = []) {
  const body = issue.description || '';
  const src = { labels: issue.labels || [], description: body };
  const pm = body.match(/^\s*Parent:\s*#(\d+)/im);
  const parentId = pm ? pm[1] : null;
  const links = [...(parentId ? [{ rel: 'parent', id: parentId }] : []), ...taskListRefs(body).map((x) => ({ rel: 'child', id: x })), ...extraLinks];
  return {
    id: String(issue.iid),
    type: issue.issue_type || issue.type || 'issue',
    title: issue.title || '',
    state: issue.state || '',
    description: body,
    acceptanceCriteria: acFromBody(body),
    tags: issue.labels || [],
    component: c.c.projectPath,
    release: issue.milestone?.title || '',
    assignee: person((issue.assignees || [])[0] || issue.assignee),
    qaAssignee: qaFrom(c, issue),
    createdBy: person(issue.author),
    storyPoints: issue.weight === null || issue.weight === undefined ? null : Number(issue.weight),
    parentId,
    url: issue.web_url,
    links,
    severity: B.readField(c.ctx, 'severity', BUG_DEFAULTS, src),
    priority: B.readField(c.ctx, 'priority', BUG_DEFAULTS, src),
    environment: B.readField(c.ctx, 'environment', BUG_DEFAULTS, src),
    createdDate: B.iso(issue.created_at),
    changedDate: B.iso(issue.updated_at),
    closedDate: B.iso(issue.closed_at),
  };
}

const LINK_REL = { relates_to: 'related', blocks: 'successor', is_blocked_by: 'predecessor' };

async function userId(c, p) {
  const who = p && (p.id || p.name);
  if (!who) return null;
  const q = String(who).includes('@') ? `search=${encodeURIComponent(who)}` : `username=${encodeURIComponent(who)}`;
  const users = await call(c, `${c.api}/users?${q}`);
  if (!users.length) throw new Error(`GitLab could not find a user matching "${who}": use their GitLab username.`);
  return users[0].id;
}

const excluded = (c, w) => (c.c.excludedTypes || []).map((s) => String(s).toLowerCase()).includes(String(w.type).toLowerCase())
  || (c.c.excludedStates || []).map((s) => String(s).toLowerCase()).includes(String(w.state).toLowerCase());

// ---------- contract ----------
async function testConnection(ctx) {
  try {
    const c = cfg(ctx);
    const p = await call(c, '');
    if (p.issues_enabled === false) return { ok: false, message: `Project ${p.path_with_namespace} has Issues turned off.`, fix: 'Turn on Issues in the project Settings → General → Visibility, project features, permissions.' };
    return { ok: true, message: `Connected to GitLab project ${p.path_with_namespace}.` };
  } catch (e) {
    const s = e.status;
    const fix = s === 401 ? 'Create a new GitLab access token with the "api" scope and paste it into GITLAB_TOKEN in .env.'
      : s === 403 ? 'Ask a project maintainer to give your account (or the project token) at least the Reporter role.'
      : s === 404 ? 'Check the Project path (group/project) and that your account can see the project.'
      : /not configured|missing/.test(e.message) ? 'Fill in the GitLab URL, Project path and GITLAB_TOKEN, then test again.'
      : 'Check the GitLab URL and your network/VPN connection, then test again.';
    return { ok: false, message: e.message, fix };
  }
}

async function getWorkItem(ctx, iid) {
  const c = cfg(ctx);
  const issue = await call(c, `/issues/${encodeURIComponent(iid)}`);
  let extra = [];
  try { extra = (await call(c, `/issues/${encodeURIComponent(iid)}/links`)).map((l) => ({ rel: LINK_REL[l.link_type] || 'related', id: String(l.iid) })); } catch { /* links unavailable */ }
  return normalize(c, issue, extra);
}

async function getChildren(ctx, iid) {
  const c = cfg(ctx);
  const seen = new Map();
  const parent = await call(c, `/issues/${encodeURIComponent(iid)}`);
  try {
    // Linked issues from this project only (iids are per-project).
    for (const l of await call(c, `/issues/${encodeURIComponent(iid)}/links`)) {
      if (String(l.project_id) === String(parent.project_id)) seen.set(String(l.iid), normalize(c, l));
    }
  } catch { /* links unavailable on this tier */ }
  for (const ref of taskListRefs(parent.description)) {
    if (seen.has(ref)) continue;
    try { seen.set(ref, normalize(c, await call(c, `/issues/${ref}`))); } catch { /* not accessible */ }
  }
  return [...seen.values()];
}

async function getComments(ctx, iid) {
  const c = cfg(ctx);
  const notes = await paged(c, `/issues/${encodeURIComponent(iid)}/notes?sort=asc&order_by=created_at`);
  return notes.filter((n) => !n.system)
    .map((n) => ({ id: String(n.id), author: person(n.author) || { name: '', id: '' }, date: n.created_at, text: n.body || '' }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

async function addComment(ctx, iid, markdown) {
  const c = cfg(ctx);
  const res = await call(c, `/issues/${encodeURIComponent(iid)}/notes`, { method: 'POST', body: { body: String(markdown || '') } });
  const issue = await call(c, `/issues/${encodeURIComponent(iid)}`);
  return { id: String(res.id), url: `${issue.web_url}#note_${res.id}` };
}

async function createTask(ctx, { parentId, title, description, assignee }) {
  const c = cfg(ctx);
  const payload = { title, description: [description || '', parentId ? `\nParent: #${parentId}` : ''].join('\n').trim() };
  const uid = await userId(c, assignee);
  if (uid) payload.assignee_ids = [uid];
  const res = await call(c, '/issues', { method: 'POST', body: payload });
  if (parentId) {
    try { await call(c, `/issues/${res.iid}/links`, { method: 'POST', body: { target_project_id: res.project_id, target_issue_iid: parentId } }); } catch { /* "Parent: #n" reference remains */ }
  }
  return { id: String(res.iid), url: res.web_url };
}

function releaseSpec(c, release) {
  const rc = c.f.release || { type: 'milestone', pattern: '{release}' };
  const type = rc.type || 'milestone';
  if (type !== 'milestone' && type !== 'label') throw new Error(`GitLab does not support release type "${type}": use "milestone" or "label".`);
  return { type, value: B.releaseValue(rc, release) };
}

async function listReleaseItems(ctx, release) {
  const c = cfg(ctx);
  const rc = releaseSpec(c, release);
  const q = rc.type === 'milestone' ? `milestone=${encodeURIComponent(rc.value)}` : `labels=${encodeURIComponent(rc.value)}`;
  return (await paged(c, `/issues?scope=all&${q}`)).map((i) => normalize(c, i)).filter((w) => !excluded(c, w));
}

async function setQaAssignee(ctx, iid, p) {
  const c = cfg(ctx);
  const q = c.f.qaAssignee;
  const who = p ? (p.id || p.name) : '';
  if (q === 'assignee') {
    const uid = await userId(c, p);
    await call(c, `/issues/${encodeURIComponent(iid)}`, { method: 'PUT', body: { assignee_ids: uid ? [uid] : [0] } });
  } else if (q && String(q).startsWith('label:')) {
    const pre = String(q).slice(6);
    const issue = await call(c, `/issues/${encodeURIComponent(iid)}`);
    const remove = (issue.labels || []).filter((l) => l.startsWith(pre));
    const body = {};
    if (remove.length) body.remove_labels = remove.join(',');
    if (who) body.add_labels = pre + who;
    if (Object.keys(body).length) await call(c, `/issues/${encodeURIComponent(iid)}`, { method: 'PUT', body });
  } else {
    throw new Error('GitLab Issues does not support custom QA fields: set fields.qaAssignee to "label:qa::" or "assignee".');
  }
  return { ok: true };
}

/** GitLab issue states are "opened" / "closed"; accept "open" as well. */
const glState = (s) => (String(s).toLowerCase() === 'open' ? 'opened' : String(s).toLowerCase());

async function searchItems(ctx, query = {}) {
  const c = cfg(ctx);
  const q = query || {};
  const max = Number(q.max) > 0 ? Number(q.max) : 500;
  const base = ['scope=all', 'order_by=created_at', 'sort=desc'];
  const st = (q.states || []).map(glState); const nst = (q.notStates || []).map(glState);
  if ((st.length === 1 && st[0] === 'opened') || nst.includes('closed')) base.push('state=opened');
  else if ((st.length === 1 && st[0] === 'closed') || nst.includes('opened')) base.push('state=closed');
  let relLabel = '';
  if (q.release) {
    const rc = releaseSpec(c, q.release);
    if (rc.type === 'milestone') base.push(`milestone=${encodeURIComponent(rc.value)}`); else relLabel = rc.value;
  }
  if (q.createdFrom) base.push(`created_after=${encodeURIComponent(new Date(q.createdFrom).toISOString())}`);
  if (q.createdTo) base.push(`created_before=${encodeURIComponent(new Date(B.endOfDay(q.createdTo)).toISOString())}`);
  const words = B.titleWords(q.text);
  if (words.length) base.push(`search=${encodeURIComponent(words.join(' '))}`, 'in=title');
  // GitLab has no item types: each type is a label. "labels=a,b" means a AND b, so query once per type.
  const typeSets = (q.types || []).length ? q.types.map((t) => [t]) : [[]];
  const seen = new Map();
  for (const ts of typeSets) {
    const labels = [...ts, ...(relLabel ? [relLabel] : [])];
    const qs = [...base, ...(labels.length ? [`labels=${encodeURIComponent(labels.join(','))}`] : [])].join('&');
    for (let page = 1; page < 100 && seen.size < max; page++) {
      const res = await call(c, `/issues?${qs}&per_page=100&page=${page}`);
      const arr = Array.isArray(res) ? res : [];
      for (const i of arr) if (!seen.has(String(i.iid))) seen.set(String(i.iid), normalize(c, i));
      if (arr.length < 100) break;
    }
  }
  const items = [...seen.values()].sort((a, b) => String(b.createdDate).localeCompare(String(a.createdDate)));
  return B.postFilter(items, { states: st, notStates: nst }).slice(0, max);
}

/** Use the project's existing label spelling when one matches case-insensitively (GitLab labels are case-sensitive). */
async function canonicalLabels(c, names) {
  let existing = [];
  try { existing = (await paged(c, '/labels?include_ancestor_groups=true')).map((l) => l.name); } catch { /* keep names as given */ }
  const byLower = new Map(existing.map((n) => [n.toLowerCase(), n]));
  return [...new Set(names.map((n) => String(n).trim()).filter(Boolean).map((n) => byLower.get(n.toLowerCase()) || n))];
}

async function createBug(ctx, bug = {}) {
  const c = cfg(ctx);
  const f = bug.fields || {};
  const plan = B.planBugFields(ctx, bug, BUG_DEFAULTS, ['label'], 'GitLab Issues');
  const warnings = [...plan.warnings];
  const lines = [...plan.descLines];
  if (f.component) { lines.push(B.descriptionLine('component', f.component)); warnings.push('GitLab Issues has no components; the component was added to the description.'); }
  const link = bug.linkTo && bug.linkTo.id ? bug.linkTo : null;
  if (link) lines.push(`Related: #${String(link.id).replace(/^#/, '')}`);
  const labels = await canonicalLabels(c, [String(bug.type || 'bug').toLowerCase(), ...(bug.tags || []), ...plan.labels]);
  const payload = { title: bug.title || '(untitled bug)', description: B.composeDescription(bug.description, lines), labels: labels.join(',') };
  if (f.assignee && (f.assignee.id || f.assignee.name)) {
    try { payload.assignee_ids = [await userId(c, f.assignee)]; } catch (e) { warnings.push(`${e.message} The issue was created unassigned.`); }
  }
  const res = await call(c, '/issues', { method: 'POST', body: payload });
  if (link) {
    try {
      await call(c, `/issues/${res.iid}/links`, { method: 'POST', body: { target_project_id: res.project_id, target_issue_iid: String(link.id).replace(/^#/, ''), link_type: 'relates_to' } });
    } catch { /* "Related: #n" line remains */ }
  }
  return { id: String(res.iid), url: res.web_url, warnings };
}

async function attachFile(ctx, iid, filePath) {
  const c = cfg(ctx);
  if (!fs.existsSync(filePath)) throw new Error(`Cannot attach "${filePath}": the file does not exist.`);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  const up = await call(c, '/uploads', { method: 'POST', body: form, timeoutMs: 120000 });
  await call(c, `/issues/${encodeURIComponent(iid)}/notes`, { method: 'POST', body: { body: `Attachment: ${up.markdown || up.url}` } });
  const rel = up.full_path || `/${c.c.projectPath}${up.url || ''}`;
  return { ok: true, url: /^https?:/.test(rel) ? rel : `${c.base}${rel}` };
}

module.exports = {
  id, label, secrets, fields, testConnection, getWorkItem, getChildren, getComments, addComment, createTask, listReleaseItems, setQaAssignee,
  searchItems, createBug, attachFile,
};
