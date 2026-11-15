/**
 * Task adapter - GitHub Issues (github.com or GitHub Enterprise Server).
 * See ../CONTRACT.md for the function contract and normalized shapes.
 */
const { request, bearer } = require('../../core/http.js');
const B = require('./_bug.js');

/** Issue trackers without custom fields: severity etc. go to labels (label:<prefix>) or the description. */
const BUG_DEFAULTS = { severity: 'description', priority: 'description', environment: 'description', foundIn: 'description' };

const SERVICE = 'GitHub';
const id = 'github';
const label = 'GitHub Issues';

const secrets = [
  { env: 'GITHUB_TOKEN', label: 'GitHub access token',
    help: 'On GitHub click your avatar → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. '
      + 'Select the repository, then under Repository permissions set Issues: "Read and write" (to read issues, comment, create sub-tasks and set labels/assignees) '
      + 'and Contents + Pull requests: "Read-only" (so the code-changes step can see linked commits and PRs). '
      + 'A classic token with the "repo" scope also works. The same token is reused for GitHub code changes.' },
];

const fields = [
  { key: 'owner', label: 'Repository owner', placeholder: 'my-company', required: true,
    help: 'The user or organization name in the repository address: github.com/<owner>/<repo>.' },
  { key: 'repo', label: 'Repository name', placeholder: 'my-app', required: true,
    help: 'The repository whose Issues hold your stories: github.com/<owner>/<repo>.' },
  { key: 'apiUrl', label: 'API URL (Enterprise only)', placeholder: 'https://api.github.com', required: false,
    help: 'Leave empty for github.com. For GitHub Enterprise Server use https://<your-server>/api/v3.' },
];

// ---------- helpers ----------
function cfg(ctx) {
  const c = ctx.config || {};
  if (!c.owner || !c.repo) throw new Error('GitHub is not configured: set the Repository owner and name.');
  if (!ctx.env || !ctx.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is missing from .env.');
  const api = String(c.apiUrl || 'https://api.github.com').replace(/\/+$/, '');
  return { api, repoPath: `${api}/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`, token: ctx.env.GITHUB_TOKEN, f: c.fields || {}, c, ctx };
}

const call = (c, url, opts = {}) => request({ ...opts, url: url.startsWith('http') ? url : c.repoPath + url, service: SERVICE,
  headers: { Authorization: bearer(c.token), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) } });

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

const person = (u) => (u ? { name: u.name || u.login, id: u.login } : null);

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

/** "- [ ] #123" / "- [x] https://github.com/o/r/issues/123" task-list references. */
function taskListRefs(body) {
  const ids = new Set();
  const re = /^\s*[-*]\s+\[[ xX]\]\s+(?:#(\d+)|https?:\/\/\S+\/issues\/(\d+))/gm; let m;
  while ((m = re.exec(String(body || '')))) ids.add(m[1] || m[2]);
  return [...ids];
}

function qaFrom(c, issue) {
  const q = c.f.qaAssignee;
  if (q === 'assignee') return person((issue.assignees || [])[0] || issue.assignee);
  if (q && String(q).startsWith('label:')) {
    const pre = String(q).slice(6);
    const l = (issue.labels || []).map((x) => x.name || x).find((n) => n.startsWith(pre));
    return l ? { name: l.slice(pre.length), id: l.slice(pre.length) } : null;
  }
  return null;
}

function normalize(c, issue, parentId = null) {
  const body = issue.body || '';
  const labelNames = (issue.labels || []).map((l) => l.name || l);
  const src = { labels: labelNames, description: body };
  if (!parentId) { const m = body.match(/^\s*Parent:\s*#(\d+)/im); if (m) parentId = m[1]; }
  const links = [];
  if (parentId) links.push({ rel: 'parent', id: String(parentId) });
  for (const ch of taskListRefs(body)) links.push({ rel: 'child', id: ch });
  return {
    id: String(issue.number),
    type: issue.type?.name || 'Issue',
    title: issue.title || '',
    state: issue.state || '',
    description: body,
    acceptanceCriteria: acFromBody(body),
    tags: (issue.labels || []).map((l) => l.name || l),
    component: `${c.c.owner}/${c.c.repo}`,
    release: issue.milestone?.title || '',
    assignee: person((issue.assignees || [])[0] || issue.assignee),
    qaAssignee: qaFrom(c, issue),
    createdBy: person(issue.user),
    storyPoints: null,
    parentId: parentId ? String(parentId) : null,
    url: issue.html_url,
    links,
    severity: B.readField(c.ctx, 'severity', BUG_DEFAULTS, src),
    priority: B.readField(c.ctx, 'priority', BUG_DEFAULTS, src),
    environment: B.readField(c.ctx, 'environment', BUG_DEFAULTS, src),
    createdDate: B.iso(issue.created_at),
    changedDate: B.iso(issue.updated_at),
    closedDate: B.iso(issue.closed_at),
  };
}

const excluded = (c, w) => (c.c.excludedTypes || []).includes(w.type) || (c.c.excludedStates || []).map((s) => String(s).toLowerCase()).includes(String(w.state).toLowerCase());

// ---------- contract ----------
async function testConnection(ctx) {
  try {
    const c = cfg(ctx);
    const r = await call(c, '');
    if (r.has_issues === false) return { ok: false, message: `Repository ${r.full_name} has Issues turned off.`, fix: 'Turn on Issues in the repository Settings → General → Features.' };
    return { ok: true, message: `Connected to GitHub repository ${r.full_name}.` };
  } catch (e) {
    const s = e.status;
    const fix = s === 401 ? 'Generate a new GitHub token and paste it into GITHUB_TOKEN in .env.'
      : s === 403 ? 'Give the token Issues "Read and write" access to this repository (or approve it for your organization\'s SSO).'
      : s === 404 ? 'Check the owner and repository name, and that the token was granted access to this repository.'
      : /not configured|missing/.test(e.message) ? 'Fill in the repository owner, name and GITHUB_TOKEN, then test again.'
      : 'Check the API URL and your network connection, then test again.';
    return { ok: false, message: e.message, fix };
  }
}

async function getWorkItem(ctx, n) {
  const c = cfg(ctx);
  const issue = await call(c, `/issues/${encodeURIComponent(n)}`);
  let parentId = null;
  try { const p = await call(c, `/issues/${encodeURIComponent(n)}/parent`); parentId = p && p.number ? p.number : null; } catch { /* no parent or sub-issues unavailable */ }
  return normalize(c, issue, parentId);
}

async function getChildren(ctx, n) {
  const c = cfg(ctx);
  const seen = new Map();
  try { for (const s of await paged(c, `/issues/${encodeURIComponent(n)}/sub_issues`)) seen.set(String(s.number), normalize(c, s, n)); } catch { /* sub-issues not enabled */ }
  const parent = await call(c, `/issues/${encodeURIComponent(n)}`);
  for (const ref of taskListRefs(parent.body)) {
    if (seen.has(ref)) continue;
    try { seen.set(ref, normalize(c, await call(c, `/issues/${ref}`), n)); } catch { /* referenced issue not accessible */ }
  }
  return [...seen.values()];
}

async function getComments(ctx, n) {
  const c = cfg(ctx);
  const list = await paged(c, `/issues/${encodeURIComponent(n)}/comments`);
  return list.map((cm) => ({ id: String(cm.id), author: person(cm.user) || { name: '', id: '' }, date: cm.created_at, text: cm.body || '' }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

async function addComment(ctx, n, markdown) {
  const c = cfg(ctx);
  const res = await call(c, `/issues/${encodeURIComponent(n)}/comments`, { method: 'POST', body: { body: String(markdown || '') } });
  return { id: String(res.id), url: res.html_url };
}

async function createTask(ctx, { parentId, title, description, assignee }) {
  const c = cfg(ctx);
  const body = [description || '', parentId ? `\nParent: #${parentId}` : ''].join('\n').trim();
  const payload = { title, body };
  if (assignee && (assignee.id || assignee.name)) payload.assignees = [assignee.id || assignee.name];
  const res = await call(c, '/issues', { method: 'POST', body: payload });
  if (parentId) {
    try { await call(c, `/issues/${encodeURIComponent(parentId)}/sub_issues`, { method: 'POST', body: { sub_issue_id: res.id } }); } catch { /* sub-issues not available; "Parent: #n" reference remains */ }
  }
  return { id: String(res.number), url: res.html_url };
}

function releaseSpec(c, release) {
  const rc = c.f.release || { type: 'milestone', pattern: '{release}' };
  const type = rc.type || 'milestone';
  if (type !== 'milestone' && type !== 'label') throw new Error(`GitHub does not support release type "${rc.type}": use "milestone" or "label".`);
  return { type, value: B.releaseValue(rc, release) };
}

async function listReleaseItems(ctx, release) {
  const c = cfg(ctx);
  const rc = releaseSpec(c, release);
  const v = rc.value;
  let query;
  if (rc.type === 'milestone') {
    const ms = (await paged(c, '/milestones?state=all')).find((m) => m.title === v);
    if (!ms) throw new Error(`GitHub has no milestone named "${v}" in ${c.c.owner}/${c.c.repo}.`);
    query = `milestone=${ms.number}`;
  } else query = `labels=${encodeURIComponent(v)}`;
  const issues = (await paged(c, `/issues?state=all&${query}`)).filter((i) => !i.pull_request);
  return issues.map((i) => normalize(c, i)).filter((w) => !excluded(c, w));
}

async function setQaAssignee(ctx, n, p) {
  const c = cfg(ctx);
  const q = c.f.qaAssignee;
  const who = p ? (p.id || p.name) : '';
  if (q === 'assignee') {
    await call(c, `/issues/${encodeURIComponent(n)}`, { method: 'PATCH', body: { assignees: who ? [who] : [] } });
  } else if (q && String(q).startsWith('label:')) {
    const pre = String(q).slice(6);
    const issue = await call(c, `/issues/${encodeURIComponent(n)}`);
    for (const l of (issue.labels || []).map((x) => x.name).filter((x) => x.startsWith(pre))) {
      await call(c, `/issues/${encodeURIComponent(n)}/labels/${encodeURIComponent(l)}`, { method: 'DELETE' });
    }
    if (who) await call(c, `/issues/${encodeURIComponent(n)}/labels`, { method: 'POST', body: { labels: [pre + who] } });
  } else {
    throw new Error('GitHub Issues does not support custom QA fields: set fields.qaAssignee to "label:qa-" or "assignee".');
  }
  return { ok: true };
}

/** Quote a search qualifier value when it contains spaces or commas. */
const sq = (v) => (/[\s,"]/.test(String(v)) ? `"${String(v).replace(/"/g, '')}"` : String(v));

async function searchItems(ctx, query = {}) {
  const c = cfg(ctx);
  const q = query || {};
  const max = Number(q.max) > 0 ? Number(q.max) : 500;
  const parts = [`repo:${c.c.owner}/${c.c.repo}`, 'is:issue'];
  // GitHub has no item types: each type is a label; "label:a,b" means a OR b.
  if ((q.types || []).length) parts.push(`label:${q.types.map(sq).join(',')}`);
  const st = (q.states || []).map((s) => String(s).toLowerCase());
  const nst = (q.notStates || []).map((s) => String(s).toLowerCase());
  if ((st.length === 1 && st[0] === 'open') || nst.includes('closed')) parts.push('is:open');
  else if ((st.length === 1 && st[0] === 'closed') || nst.includes('open')) parts.push('is:closed');
  if (q.release) { const rc = releaseSpec(c, q.release); parts.push(`${rc.type}:${sq(rc.value)}`); }
  const from = q.createdFrom ? String(q.createdFrom).slice(0, 10) : '';
  const to = q.createdTo ? String(q.createdTo).slice(0, 10) : '';
  if (from && to) parts.push(`created:${from}..${to}`);
  else if (from) parts.push(`created:>=${from}`);
  else if (to) parts.push(`created:<=${to}`);
  const words = B.titleWords(q.text);
  if (words.length) parts.push(...words, 'in:title');
  const out = [];
  // The search API returns at most 1000 results (10 pages of 100).
  for (let page = 1; page <= 10 && out.length < max; page++) {
    const res = await call(c, `${c.api}/search/issues?q=${encodeURIComponent(parts.join(' '))}&sort=created&order=desc&per_page=100&page=${page}`);
    const items = (res.items || []).filter((i) => !i.pull_request);
    out.push(...items.map((i) => normalize(c, i)));
    if ((res.items || []).length < 100) break;
  }
  return B.postFilter(out, { states: q.states, notStates: q.notStates }).slice(0, max);
}

/** Use the repository's existing label spelling when one matches case-insensitively. */
async function canonicalLabels(c, names) {
  let existing = [];
  try { existing = (await paged(c, '/labels')).map((l) => l.name); } catch { /* keep names as given */ }
  const byLower = new Map(existing.map((n) => [n.toLowerCase(), n]));
  return [...new Set(names.map((n) => String(n).trim()).filter(Boolean).map((n) => byLower.get(n.toLowerCase()) || n))];
}

async function createBug(ctx, bug = {}) {
  const c = cfg(ctx);
  const f = bug.fields || {};
  const plan = B.planBugFields(ctx, bug, BUG_DEFAULTS, ['label'], 'GitHub Issues');
  const warnings = [...plan.warnings];
  const lines = [...plan.descLines];
  if (f.component) { lines.push(B.descriptionLine('component', f.component)); warnings.push('GitHub Issues has no components; the component was added to the description.'); }
  const link = bug.linkTo && bug.linkTo.id ? bug.linkTo : null;
  if (link) lines.push(`Related: #${String(link.id).replace(/^#/, '')}`);
  const labels = await canonicalLabels(c, [String(bug.type || 'bug').toLowerCase(), ...(bug.tags || []), ...plan.labels]);
  const payload = { title: bug.title || '(untitled bug)', body: B.composeDescription(bug.description, lines), labels };
  if (f.assignee && (f.assignee.id || f.assignee.name)) payload.assignees = [f.assignee.id || f.assignee.name];
  let res;
  try {
    res = await call(c, '/issues', { method: 'POST', body: payload });
  } catch (e) {
    if (e.status !== 422 || !payload.assignees) throw e;
    warnings.push(`GitHub rejected the assignee "${payload.assignees[0]}" (use their GitHub username); the issue was created unassigned.`);
    delete payload.assignees;
    res = await call(c, '/issues', { method: 'POST', body: payload });
  }
  if (link && link.rel === 'parent') {
    try { await call(c, `/issues/${encodeURIComponent(link.id)}/sub_issues`, { method: 'POST', body: { sub_issue_id: res.id } }); } catch { /* sub-issues not available; "Related: #n" line remains */ }
  }
  return { id: String(res.number), url: res.html_url, warnings };
}

async function attachFile(ctx, n) {
  throw new Error(`GitHub does not support attachments through the API: add the screenshot by dragging it into issue #${n} in the browser.`);
}

module.exports = {
  id, label, secrets, fields, testConnection, getWorkItem, getChildren, getComments, addComment, createTask, listReleaseItems, setQaAssignee,
  searchItems, createBug, attachFile,
};
