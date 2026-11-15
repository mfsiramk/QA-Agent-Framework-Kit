/**
 * Task adapter - Jira Cloud (REST v3) and Jira Data Center / Server (REST v2).
 * See ../CONTRACT.md for the function contract and normalized shapes.
 */
const fs = require('fs');
const path = require('path');
const { request, basicAuth, bearer, adfToText } = require('../../core/http.js');
const B = require('./_bug.js');

const SERVICE = 'Jira';
const id = 'jira';
const label = 'Jira (Cloud or Data Center)';

const secrets = [
  { env: 'JIRA_EMAIL', label: 'Jira login email (Cloud only)',
    help: 'Jira Cloud only: the email address you use to sign in to Atlassian. Leave empty for Jira Data Center / Server.' },
  { env: 'JIRA_API_TOKEN', label: 'Jira API token (Cloud only)',
    help: 'Jira Cloud only: go to https://id.atlassian.com/manage-profile/security/api-tokens → Create API token, then copy it. '
      + 'The token acts as you, so your Jira account needs permission to browse the project, add comments, create sub-tasks and edit issues (plus create attachments and link issues to file bugs with screenshots).' },
  { env: 'JIRA_PAT', label: 'Jira Personal Access Token (Data Center / Server only)',
    help: 'Jira Data Center / Server only: click your avatar → Profile → Personal Access Tokens → Create token. '
      + 'Your account needs Browse, Add Comments, Create Issues and Edit Issues permission in the project (plus Create Attachments and Link Issues to file bugs with screenshots).' },
];

const fields = [
  { key: 'baseUrl', label: 'Jira site URL', placeholder: 'https://your-company.atlassian.net', required: true,
    help: 'The address of your Jira site, without anything after the domain (no /browse/...).' },
  { key: 'deployment', label: 'Jira type', placeholder: 'cloud', required: true,
    help: 'Type "cloud" if your Jira address ends in atlassian.net, otherwise "server" (Data Center / self-hosted).' },
  { key: 'projectKey', label: 'Project key', placeholder: 'ABC', required: true,
    help: 'The short code in front of every issue number, e.g. ABC for issue ABC-123.' },
];

// ---------- helpers ----------
function cfg(ctx) {
  const c = ctx.config || {};
  const env = ctx.env || {};
  const base = String(c.baseUrl || '').replace(/\/+$/, '');
  if (!base || !c.projectKey) throw new Error('Jira is not configured: set the Jira site URL and Project key.');
  const cloud = String(c.deployment || 'cloud').toLowerCase() !== 'server';
  let auth;
  if (cloud) {
    if (!env.JIRA_EMAIL || !env.JIRA_API_TOKEN) throw new Error('JIRA_EMAIL or JIRA_API_TOKEN is missing from .env.');
    auth = basicAuth(env.JIRA_EMAIL, env.JIRA_API_TOKEN);
  } else {
    if (!env.JIRA_PAT) throw new Error('JIRA_PAT is missing from .env.');
    auth = bearer(env.JIRA_PAT);
  }
  return { base, api: `${base}/rest/api/${cloud ? 3 : 2}`, cloud, auth, key: c.projectKey, f: c.fields || {}, c, ctx };
}

const call = (c, path, opts = {}) => request({ ...opts, url: c.api + path, service: SERVICE, headers: { Authorization: c.auth, ...(opts.headers || {}) } });
const toText = (v) => (v && typeof v === 'object' && v.type === 'doc' ? adfToText(v).trim() : v == null ? '' : String(v));
const person = (c, u) => (u ? { name: u.displayName || u.name || '', id: u.emailAddress || (c.cloud ? u.accountId : u.name || u.key) || '' } : null);
const jq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Where severity/priority/... live when bugFields does not say otherwise. */
const BUG_DEFAULTS = { severity: 'description', priority: 'priority', environment: 'environment', foundIn: 'description' };
/** A custom/system field value as plain text (select options, ADF, arrays). */
const fieldText = (v) => (v && typeof v === 'object' && v.type === 'doc' ? adfToText(v).trim()
  : Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? x.value || x.name || '' : x)).filter(Boolean).join(', ') || null : v);

/** Pull the text under an "Acceptance Criteria" heading, up to the next heading. */
function acFromDescription(text) {
  const lines = String(text || '').split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*(h\d\.|#{1,6})?\s*\**\s*acceptance criteria\b/i.test(l));
  if (i < 0) return '';
  const rest = lines[i].replace(/^.*?acceptance criteria\s*\**\s*:?\s*\**/i, '').trim();
  const out = rest ? [rest] : [];
  for (const l of lines.slice(i + 1)) {
    if (/^\s*(h\d\.|#{1,6}\s)/.test(l) || /^\s*\**[A-Z][\w /&-]{2,40}\**\s*:\s*$/.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

function sprintName(fieldsObj) {
  for (const v of Object.values(fieldsObj)) {
    if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && 'boardId' in v[0] && v[0].name) return v[v.length - 1].name;
  }
  return '';
}

function normalize(c, issue) {
  const F = issue.fields || {};
  const description = toText(F.description);
  const acField = c.f.acceptanceCriteria;
  const labels = F.labels || [];
  let qaAssignee = null;
  const q = c.f.qaAssignee;
  if (q === 'assignee') qaAssignee = person(c, F.assignee);
  else if (q && String(q).startsWith('label:')) {
    const pre = String(q).slice(6); const l = labels.find((x) => x.startsWith(pre));
    qaAssignee = l ? { name: l.slice(pre.length), id: l.slice(pre.length) } : null;
  } else if (q) qaAssignee = person(c, F[q]);
  const links = [];
  if (F.parent) links.push({ rel: 'parent', id: F.parent.key });
  for (const s of F.subtasks || []) links.push({ rel: 'child', id: s.key });
  for (const l of F.issuelinks || []) {
    const blocks = /block|depend/i.test(l.type?.name || '');
    if (l.outwardIssue) links.push({ rel: blocks ? 'successor' : 'related', id: l.outwardIssue.key });
    if (l.inwardIssue) links.push({ rel: blocks ? 'predecessor' : 'related', id: l.inwardIssue.key });
  }
  const sp = c.f.storyPoints ? F[c.f.storyPoints] : null;
  const src = { field: (r) => fieldText(F[r]), priority: () => F.priority?.name, labels, description };
  return {
    id: issue.key,
    type: F.issuetype?.name || '',
    title: F.summary || '',
    state: F.status?.name || '',
    description,
    acceptanceCriteria: acField ? toText(F[acField]) : acFromDescription(description),
    tags: labels,
    component: (F.components || []).map((x) => x.name).join(', ') || F.project?.name || '',
    release: (F.fixVersions || []).map((v) => v.name).join(', ') || sprintName(F),
    assignee: person(c, F.assignee),
    qaAssignee,
    createdBy: person(c, F.creator || F.reporter),
    storyPoints: sp === null || sp === undefined || sp === '' ? null : Number(sp),
    parentId: F.parent?.key || null,
    url: `${c.base}/browse/${issue.key}`,
    links,
    severity: B.readField(c.ctx, 'severity', BUG_DEFAULTS, src),
    priority: B.readField(c.ctx, 'priority', BUG_DEFAULTS, src),
    environment: B.readField(c.ctx, 'environment', BUG_DEFAULTS, src),
    createdDate: B.iso(F.created),
    changedDate: B.iso(F.updated),
    closedDate: B.iso(F.resolutiondate),
  };
}

async function search(c, jql, max = Infinity) {
  const out = [];
  if (c.cloud) {
    let token;
    do {
      const res = await call(c, '/search/jql', { method: 'POST', body: { jql, fields: ['*all'], maxResults: 100, ...(token ? { nextPageToken: token } : {}) } });
      out.push(...(res.issues || []));
      token = res.isLast ? undefined : res.nextPageToken;
    } while (token && out.length < max);
  } else {
    let startAt = 0; let total = 0;
    do {
      const res = await call(c, '/search', { method: 'POST', body: { jql, fields: ['*all'], maxResults: 100, startAt } });
      out.push(...(res.issues || []));
      total = res.total || 0; startAt += (res.issues || []).length;
      if (!(res.issues || []).length) break;
    } while (startAt < total && out.length < max);
  }
  return out.slice(0, max).map((i) => normalize(c, i));
}

async function accountFor(c, p) {
  const who = p && (p.id || p.name);
  if (!who) return null;
  if (!c.cloud) return { name: who };
  if (/^[0-9a-f:-]{20,}$/i.test(who) && !who.includes('@')) return { accountId: who };
  const users = await call(c, `/user/search?query=${encodeURIComponent(who)}`);
  if (!users.length) throw new Error(`Jira could not find a user matching "${who}": use their Atlassian email address.`);
  return { accountId: users[0].accountId };
}

function inline(text) {
  const nodes = []; const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:[^)\s]+)\)/g; let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1]) nodes.push({ type: 'text', text: m[1], marks: [{ type: 'strong' }] });
    else nodes.push({ type: 'text', text: m[2], marks: [{ type: 'link', attrs: { href: m[3] } }] });
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes;
}
function mdToAdf(md) {
  const paras = String(md || '').split(/\r?\n\s*\r?\n/).filter((p) => p.trim());
  return { type: 'doc', version: 1, content: paras.map((p) => ({ type: 'paragraph',
    content: p.split(/\r?\n/).flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...inline(line)]) })) };
}
const mdToWiki = (md) => String(md || '').replace(/\*\*([^*]+)\*\*/g, '*$1*').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '[$1|$2]');
const body = (c, md) => (c.cloud ? mdToAdf(md) : mdToWiki(md));

// ---------- contract ----------
async function testConnection(ctx) {
  try {
    const c = cfg(ctx);
    const p = await call(c, `/project/${encodeURIComponent(c.key)}`);
    return { ok: true, message: `Connected to Jira project ${p.key} (${p.name}).` };
  } catch (e) {
    const s = e.status;
    const fix = s === 401 ? 'Create a fresh Jira token (API token on Cloud, Personal Access Token on Data Center) and paste it into .env.'
      : s === 403 ? 'Ask a Jira admin to give your account Browse Projects permission on this project.'
      : s === 404 ? 'Check the Project key and site URL - the key is the letters before the dash in an issue number.'
      : /not configured|missing/.test(e.message) ? 'Fill in the Jira site URL, Jira type, Project key and the matching token in .env, then test again.'
      : 'Check the Jira site URL and your network/VPN connection, then test again.';
    return { ok: false, message: e.message, fix };
  }
}

async function getWorkItem(ctx, key) {
  const c = cfg(ctx);
  return normalize(c, await call(c, `/issue/${encodeURIComponent(key)}?fields=*all`));
}

async function getChildren(ctx, key) {
  const c = cfg(ctx);
  const seen = new Map();
  for (const w of await search(c, `parent = ${jq(key)}`)) seen.set(w.id, w);
  try { for (const w of await search(c, `"Epic Link" = ${jq(key)}`)) seen.set(w.id, w); } catch { /* Epic Link field not present */ }
  const parent = await getWorkItem(ctx, key);
  for (const l of parent.links.filter((x) => x.rel === 'child' && !seen.has(x.id))) seen.set(l.id, await getWorkItem(ctx, l.id));
  return [...seen.values()];
}

async function getComments(ctx, key) {
  const c = cfg(ctx);
  const out = []; let startAt = 0; let total = 0;
  do {
    const res = await call(c, `/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100&orderBy=created`);
    for (const cm of res.comments || []) out.push({ id: String(cm.id), author: person(c, cm.author) || { name: '', id: '' }, date: cm.created, text: toText(cm.body) });
    total = res.total || 0; startAt += (res.comments || []).length;
    if (!(res.comments || []).length) break;
  } while (startAt < total);
  return out.sort((a, b) => new Date(a.date) - new Date(b.date));
}

async function addComment(ctx, key, markdown) {
  const c = cfg(ctx);
  const res = await call(c, `/issue/${encodeURIComponent(key)}/comment`, { method: 'POST', body: { body: body(c, markdown) } });
  return { id: String(res.id), url: `${c.base}/browse/${key}?focusedCommentId=${res.id}` };
}

async function createTask(ctx, { parentId, title, description, assignee }) {
  const c = cfg(ctx);
  let typeName = 'Sub-task';
  try {
    const proj = await call(c, `/project/${encodeURIComponent(c.key)}`);
    const st = (proj.issueTypes || []).find((t) => t.subtask);
    if (st) typeName = st.name;
  } catch { /* fall back to Sub-task */ }
  const f = { project: { key: c.key }, summary: title, issuetype: { name: typeName }, description: body(c, description || '') };
  if (parentId) f.parent = { key: parentId };
  const acct = await accountFor(c, assignee);
  if (acct) f.assignee = acct;
  const res = await call(c, '/issue', { method: 'POST', body: { fields: f } });
  return { id: res.key, url: `${c.base}/browse/${res.key}` };
}

function releaseClause(c, release) {
  const rc = c.f.release || { type: 'fixVersion', pattern: '{release}' };
  const v = String(rc.pattern || '{release}').replace(/\{release\}/g, release);
  const clause = { fixVersion: `fixVersion = ${jq(v)}`, sprint: `sprint = ${jq(v)}`, label: `labels = ${jq(v)}` }[rc.type || 'fixVersion'];
  if (!clause) throw new Error(`Jira does not support release type "${rc.type}": use "fixVersion", "sprint" or "label".`);
  return clause;
}

async function listReleaseItems(ctx, release) {
  const c = cfg(ctx);
  const clause = releaseClause(c, release);
  let jql = `project = ${jq(c.key)} AND ${clause}`;
  const exT = c.c.excludedTypes || []; const exS = c.c.excludedStates || [];
  if (exT.length) jql += ` AND issuetype not in (${exT.map(jq).join(',')})`;
  if (exS.length) jql += ` AND status not in (${exS.map(jq).join(',')})`;
  return search(c, `${jql} ORDER BY key ASC`);
}

async function setQaAssignee(ctx, key, p) {
  const c = cfg(ctx);
  const q = c.f.qaAssignee;
  if (!q) throw new Error('No QA assignee field configured: set fields.qaAssignee (e.g. customfield_10070, "label:qa-" or "assignee").');
  const ik = encodeURIComponent(key);
  if (q === 'assignee') {
    await call(c, `/issue/${ik}/assignee`, { method: 'PUT', body: (await accountFor(c, p)) || (c.cloud ? { accountId: null } : { name: null }) });
  } else if (String(q).startsWith('label:')) {
    const pre = String(q).slice(6);
    const cur = (await call(c, `/issue/${ik}?fields=labels`)).fields?.labels || [];
    const ops = cur.filter((l) => l.startsWith(pre)).map((l) => ({ remove: l }));
    const who = p && (p.id || p.name);
    if (who) ops.push({ add: pre + String(who).replace(/\s+/g, '') });
    if (ops.length) await call(c, `/issue/${ik}`, { method: 'PUT', body: { update: { labels: ops } } });
  } else {
    await call(c, `/issue/${ik}`, { method: 'PUT', body: { fields: { [q]: await accountFor(c, p) } } });
  }
  return { ok: true };
}

async function searchItems(ctx, query = {}) {
  const c = cfg(ctx);
  const q = query || {};
  const max = Number(q.max) > 0 ? Number(q.max) : 500;
  let jql = `project = ${jq(c.key)}`;
  if ((q.types || []).length) jql += ` AND issuetype in (${q.types.map(jq).join(',')})`;
  if ((q.states || []).length) jql += ` AND status in (${q.states.map(jq).join(',')})`;
  if ((q.notStates || []).length) jql += ` AND status not in (${q.notStates.map(jq).join(',')})`;
  if (q.release) jql += ` AND ${releaseClause(c, q.release)}`;
  if (q.createdFrom) jql += ` AND created >= ${jq(String(q.createdFrom).slice(0, 10))}`;
  if (q.createdTo) jql += ` AND created <= ${jq(`${String(q.createdTo).slice(0, 10)} 23:59`)}`;
  const words = B.titleWords(q.text);
  if (words.length) jql += ` AND summary ~ ${jq(words.join(' '))}`;
  return search(c, `${jql} ORDER BY created DESC`, max);
}

const richBody = (c, md) => (c.cloud ? B.markdownToAdf(md) : B.markdownToWiki(md));
const jiraLabel = (t) => String(t).trim().replace(/\s+/g, '-');

async function createBug(ctx, bug = {}) {
  const c = cfg(ctx);
  const type = bug.type || 'Bug';
  const f = bug.fields || {};
  const plan = B.planBugFields(ctx, bug, BUG_DEFAULTS, ['ref', 'priority', 'label'], 'Jira');
  const warnings = [...plan.warnings];
  const link = bug.linkTo && bug.linkTo.id ? bug.linkTo : null;
  let subtask = false;
  if (link && link.rel === 'parent') {
    try {
      const proj = await call(c, `/project/${encodeURIComponent(c.key)}`);
      subtask = !!(proj.issueTypes || []).find((t) => t.subtask && String(t.name).toLowerCase() === String(type).toLowerCase());
    } catch { /* fall back to an issue link */ }
  }
  // Each entry lists the value shapes to try in order (select list first, then plain text) before giving up.
  const entries = [];
  for (const w of plan.writes) {
    if (w.form === 'priority') entries.push({ key: w.key, api: 'priority', shapes: [{ name: w.value }], raw: w.raw });
    else if (w.field === 'environment') entries.push({ key: w.key, api: 'environment', shapes: [c.cloud ? B.markdownToAdf(w.value) : w.value], raw: w.raw });
    else if (/^customfield_/i.test(w.field)) entries.push({ key: w.key, api: w.field, shapes: [{ value: w.value }, w.value, [{ value: w.value }]], raw: w.raw });
    else entries.push({ key: w.key, api: w.field, shapes: [w.value, { value: w.value }], raw: w.raw });
  }
  if (f.component) entries.push({ key: 'component', api: 'components', shapes: [String(f.component).split(',').map((n) => ({ name: n.trim() })).filter((x) => x.name)], raw: f.component });
  if (f.assignee && (f.assignee.id || f.assignee.name)) {
    try { const acct = await accountFor(c, f.assignee); if (acct) entries.push({ key: 'assignee', api: 'assignee', shapes: [acct] }); } catch (e) { warnings.push(`${e.message} The bug was created unassigned.`); }
  }
  if (link && subtask) entries.push({ key: 'link', api: 'parent', shapes: [{ key: link.id }], raw: link.id });
  const labels = [...new Set([...(bug.tags || []), ...plan.labels].map(jiraLabel).filter(Boolean))];
  const dropped = [];

  const build = () => {
    const extra = dropped.map((d) => (d.key === 'link' ? `Parent: ${d.raw}` : B.TITLES[d.key] && d.raw ? B.descriptionLine(d.key, d.raw) : null)).filter(Boolean);
    const fl = { project: { key: c.key }, summary: bug.title || '(untitled bug)', issuetype: { name: type },
      description: richBody(c, B.composeDescription(bug.description, [...plan.descLines, ...extra])) };
    if (labels.length) fl.labels = labels;
    for (const e of entries) fl[e.api] = e.shapes[e.i || 0];
    return fl;
  };

  let res;
  for (let attempt = 0; attempt < 15 && !res; attempt++) {
    try {
      res = await call(c, '/issue', { method: 'POST', body: { fields: build() } });
    } catch (e) {
      if (e.status !== 400) throw e;
      let errs = {};
      try { errs = JSON.parse(e.body).errors || {}; } catch { /* not JSON */ }
      let handled = false;
      for (const k of Object.keys(errs)) {
        const en = entries.find((x) => x.api === k);
        if (!en) continue;
        handled = true;
        if ((en.i || 0) < en.shapes.length - 1) { en.i = (en.i || 0) + 1; continue; }
        entries.splice(entries.indexOf(en), 1);
        dropped.push(en);
        warnings.push(`Jira rejected ${en.api} (${errs[k]}); the bug was created without it${B.TITLES[en.key] || en.key === 'link' ? ' (the value is noted in the description)' : ''}.`);
      }
      if (!handled) {
        if (errs.issuetype) throw new Error(`Jira project ${c.key} has no issue type "${type}": ${errs.issuetype}`);
        throw e;
      }
    }
  }
  if (!res) throw new Error('Jira kept rejecting the bug fields: check bugFields in qa-framework.config.json against the project\'s create screen.');
  if (link && !subtask) {
    try {
      await call(c, '/issueLink', { method: 'POST', body: { type: { name: 'Relates' }, inwardIssue: { key: res.key }, outwardIssue: { key: link.id } } });
    } catch (e) { warnings.push(`Jira could not link ${res.key} to ${link.id} (${e.message}); link them by hand.`); }
  }
  return { id: res.key, url: `${c.base}/browse/${res.key}`, warnings };
}

async function attachFile(ctx, key, filePath) {
  const c = cfg(ctx);
  if (!fs.existsSync(filePath)) throw new Error(`Cannot attach "${filePath}": the file does not exist.`);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  const res = await call(c, `/issue/${encodeURIComponent(key)}/attachments`, {
    method: 'POST', body: form, headers: { 'X-Atlassian-Token': 'no-check' }, timeoutMs: 120000,
  });
  const a = Array.isArray(res) ? res[0] : res;
  return { ok: true, url: (a && a.content) || `${c.base}/browse/${key}` };
}

module.exports = {
  id, label, secrets, fields, testConnection, getWorkItem, getChildren, getComments, addComment, createTask, listReleaseItems, setQaAssignee,
  searchItems, createBug, attachFile,
};
