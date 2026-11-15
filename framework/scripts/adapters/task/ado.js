/**
 * Task adapter - Azure Boards (Azure DevOps Services / Server).
 * See ../CONTRACT.md for the function contract and normalized shapes.
 */
const fs = require('fs');
const path = require('path');
const { request, basicAuth, htmlToText } = require('../../core/http.js');
const B = require('./_bug.js');

const SERVICE = 'Azure DevOps';
const API = 'api-version=7.0';

const id = 'ado';
const label = 'Azure Boards (Azure DevOps)';

const secrets = [
  {
    env: 'ADO_PAT',
    label: 'Azure DevOps Personal Access Token',
    help: 'In Azure DevOps click your profile picture (top right) → Personal access tokens → New Token. '
      + 'Choose your organization, set an expiry, and tick Work Items: "Read, write & manage" '
      + '(needed to read stories, post comments, create tasks and bugs, attach screenshots and set the QA field). '
      + 'If you also use Azure Repos for code changes, tick Code: "Read" too. Copy the token straight away - it is shown only once.',
  },
];

const fields = [
  { key: 'orgUrl', label: 'Organization URL', placeholder: 'https://dev.azure.com/your-org', required: true,
    help: 'The address you see in the browser when you open Azure DevOps, up to and including the organization name.' },
  { key: 'project', label: 'Project name', placeholder: 'My Project', required: true,
    help: 'The Azure DevOps project that holds your user stories (shown in the left sidebar / URL after the organization).' },
];

// ---------- helpers ----------
function cfg(ctx) {
  const c = ctx.config || {};
  const orgUrl = String(c.orgUrl || '').replace(/\/+$/, '');
  if (!orgUrl || !c.project) throw new Error('Azure DevOps is not configured: set the Organization URL and Project name.');
  if (!ctx.env || !ctx.env.ADO_PAT) throw new Error('ADO_PAT is missing from .env: create a Personal Access Token and add it.');
  return { orgUrl, project: c.project, proj: encodeURIComponent(c.project), f: c.fields || {} };
}

function call(ctx, url, opts = {}) {
  return request({ ...opts, url, service: SERVICE, headers: { Authorization: basicAuth('', ctx.env.ADO_PAT), ...(opts.headers || {}) } });
}

const person = (p) => (p && (p.uniqueName || p.displayName) ? { name: p.displayName || p.uniqueName, id: p.uniqueName || p.id || p.displayName } : null);

const REL = {
  'System.LinkTypes.Hierarchy-Reverse': 'parent',
  'System.LinkTypes.Hierarchy-Forward': 'child',
  'System.LinkTypes.Related': 'related',
  'System.LinkTypes.Dependency-Reverse': 'predecessor',
  'System.LinkTypes.Dependency-Forward': 'successor',
};
const idFromUrl = (u) => String(u || '').split('/').pop();

/** Where severity/priority/... live when bugFields does not say otherwise. */
const BUG_DEFAULTS = { severity: 'Microsoft.VSTS.Common.Severity', priority: 'priority', environment: 'description', foundIn: 'description' };
const PRIORITY_REF = 'Microsoft.VSTS.Common.Priority';
const SEVERITY_VALUES = ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'];
const LINK_TYPES = { parent: 'System.LinkTypes.Hierarchy-Reverse', related: 'System.LinkTypes.Related', 'tested-by': 'Microsoft.VSTS.Common.TestedBy-Forward' };
const wiqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

function mdToHtml(md) {
  const esc = String(md || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\r?\n/g, '<br/>');
}

function qaFieldRef(c) {
  const q = c.f.qaAssignee;
  if (!q) throw new Error('No QA assignee field configured: set fields.qaAssignee (e.g. Custom.QAAssigned or "assignee").');
  if (String(q).startsWith('label:')) return { label: String(q).slice(6) };
  return { ref: q === 'assignee' ? 'System.AssignedTo' : q };
}

function normalize(ctx, c, wi) {
  const F = wi.fields || {};
  const acRef = c.f.acceptanceCriteria || 'Microsoft.VSTS.Common.AcceptanceCriteria';
  const spRef = c.f.storyPoints || 'Microsoft.VSTS.Scheduling.StoryPoints';
  const tags = String(F['System.Tags'] || '').split(';').map((t) => t.trim()).filter(Boolean);
  let qaAssignee = null;
  try {
    const q = qaFieldRef(c);
    if (q.ref) { const v = F[q.ref]; qaAssignee = typeof v === 'string' ? (v ? { name: v, id: v } : null) : person(v); }
    else { const t = tags.find((x) => x.startsWith(q.label)); qaAssignee = t ? { name: t.slice(q.label.length), id: t.slice(q.label.length) } : null; }
  } catch { /* qa field optional when reading */ }
  const links = [];
  let parentId = null;
  for (const r of wi.relations || []) {
    const rel = REL[r.rel];
    if (!rel) continue;
    const lid = idFromUrl(r.url);
    links.push({ rel, id: lid });
    if (rel === 'parent') parentId = lid;
  }
  const sp = F[spRef];
  const description = htmlToText(F['System.Description']);
  const src = { field: (r) => F[r], priority: () => F[PRIORITY_REF], labels: tags, description: description + '\n' + htmlToText(F['Microsoft.VSTS.TCM.ReproSteps']) };
  return {
    id: String(wi.id),
    type: F['System.WorkItemType'] || '',
    title: F['System.Title'] || '',
    state: F['System.State'] || '',
    description: description || htmlToText(F['Microsoft.VSTS.TCM.ReproSteps']),
    acceptanceCriteria: htmlToText(F[acRef]),
    tags,
    component: F['System.AreaPath'] || '',
    release: F['System.IterationPath'] || '',
    assignee: person(F['System.AssignedTo']),
    qaAssignee,
    createdBy: person(F['System.CreatedBy']),
    storyPoints: sp === undefined || sp === null || sp === '' ? null : Number(sp),
    parentId,
    url: `${c.orgUrl}/${c.proj}/_workitems/edit/${wi.id}`,
    links,
    severity: B.readField(ctx, 'severity', BUG_DEFAULTS, src),
    priority: B.readField(ctx, 'priority', BUG_DEFAULTS, src),
    environment: B.readField(ctx, 'environment', BUG_DEFAULTS, src),
    createdDate: B.iso(F['System.CreatedDate']),
    changedDate: B.iso(F['System.ChangedDate']),
    closedDate: B.iso(F['Microsoft.VSTS.Common.ClosedDate']),
  };
}

async function fetchMany(ctx, c, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const res = await call(ctx, `${c.orgUrl}/${c.proj}/_apis/wit/workitems?ids=${chunk.join(',')}&$expand=relations&errorPolicy=omit&${API}`);
    for (const wi of res.value || []) if (wi) out.push(normalize(ctx, c, wi));
  }
  return out;
}

// ---------- contract ----------
async function testConnection(ctx) {
  try {
    const c = cfg(ctx);
    const p = await call(ctx, `${c.orgUrl}/_apis/projects/${c.proj}?${API}`);
    return { ok: true, message: `Connected to Azure DevOps project "${p.name || c.project}".` };
  } catch (e) {
    const s = e.status;
    const fix = s === 401 ? 'Create a new Personal Access Token in Azure DevOps and paste it into ADO_PAT in .env.'
      : s === 403 ? 'Give the token Work Items "Read, write & manage" scope, or ask an admin to add you to the project.'
      : s === 404 ? 'Check the Organization URL and the exact Project name (spelling and spaces matter).'
      : /not configured|missing/.test(e.message) ? 'Fill in the Organization URL, Project name and ADO_PAT, then test again.'
      : 'Check the Organization URL and your network/VPN connection, then test again.';
    return { ok: false, message: e.message, fix };
  }
}

async function getWorkItem(ctx, wid) {
  const c = cfg(ctx);
  const wi = await call(ctx, `${c.orgUrl}/${c.proj}/_apis/wit/workitems/${encodeURIComponent(wid)}?$expand=relations&${API}`);
  return normalize(ctx, c, wi);
}

async function getChildren(ctx, wid) {
  const c = cfg(ctx);
  const wi = await call(ctx, `${c.orgUrl}/${c.proj}/_apis/wit/workitems/${encodeURIComponent(wid)}?$expand=relations&${API}`);
  const ids = (wi.relations || []).filter((r) => r.rel === 'System.LinkTypes.Hierarchy-Forward').map((r) => idFromUrl(r.url));
  if (!ids.length) return [];
  return fetchMany(ctx, c, ids);
}

async function getComments(ctx, wid) {
  const c = cfg(ctx);
  const out = [];
  let token = '';
  do {
    const res = await call(ctx, `${c.orgUrl}/${c.proj}/_apis/wit/workItems/${encodeURIComponent(wid)}/comments?api-version=7.0-preview.3&$top=200&order=asc${token ? '&continuationToken=' + encodeURIComponent(token) : ''}`);
    for (const cm of res.comments || []) {
      if (cm.isDeleted) continue;
      out.push({ id: String(cm.id), author: person(cm.createdBy) || { name: '', id: '' }, date: cm.createdDate, text: htmlToText(cm.text) });
    }
    token = res.continuationToken || '';
  } while (token);
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

async function addComment(ctx, wid, markdown) {
  const c = cfg(ctx);
  const res = await call(ctx, `${c.orgUrl}/${c.proj}/_apis/wit/workItems/${encodeURIComponent(wid)}/comments?api-version=7.0-preview.3`, {
    method: 'POST', body: { text: mdToHtml(markdown) },
  });
  return { id: String(res.id), url: `${c.orgUrl}/${c.proj}/_workitems/edit/${wid}` };
}

async function createTask(ctx, { parentId, title, description, assignee }) {
  const c = cfg(ctx);
  const ops = [
    { op: 'add', path: '/fields/System.Title', value: title },
    { op: 'add', path: '/fields/System.Description', value: mdToHtml(description || '') },
  ];
  if (assignee && (assignee.id || assignee.name)) ops.push({ op: 'add', path: '/fields/System.AssignedTo', value: assignee.id || assignee.name });
  if (parentId) {
    const parent = await call(ctx, `${c.orgUrl}/${c.proj}/_apis/wit/workitems/${encodeURIComponent(parentId)}?${API}`);
    ops.push({ op: 'add', path: '/fields/System.AreaPath', value: parent.fields['System.AreaPath'] });
    ops.push({ op: 'add', path: '/fields/System.IterationPath', value: parent.fields['System.IterationPath'] });
    ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: parent.url } });
  }
  const res = await call(ctx, `${c.orgUrl}/${c.proj}/_apis/wit/workitems/$Task?${API}`, {
    method: 'POST', body: JSON.stringify(ops), headers: { 'Content-Type': 'application/json-patch+json' },
  });
  return { id: String(res.id), url: `${c.orgUrl}/${c.proj}/_workitems/edit/${res.id}` };
}

function releaseCond(c, release) {
  const rc = c.f.release || { type: 'iterationPath', pattern: '{release}' };
  const value = String(rc.pattern || '{release}').replace(/\{release\}/g, release).replace(/'/g, "''");
  if (rc.type === 'label') return `[System.Tags] CONTAINS '${value}'`;
  if (rc.type === 'iterationPath' || !rc.type) return `[System.IterationPath] UNDER '${value}'`;
  throw new Error(`Azure DevOps does not support release type "${rc.type}": use "iterationPath" or "label".`);
}

async function listReleaseItems(ctx, release) {
  const c = cfg(ctx);
  const cond = releaseCond(c, release);
  const exTypes = (ctx.config.excludedTypes || []).map((t) => `'${String(t).replace(/'/g, "''")}'`);
  const exStates = (ctx.config.excludedStates || []).map((t) => `'${String(t).replace(/'/g, "''")}'`);
  let q = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND ${cond}`;
  if (exTypes.length) q += ` AND [System.WorkItemType] NOT IN (${exTypes.join(',')})`;
  if (exStates.length) q += ` AND [System.State] NOT IN (${exStates.join(',')})`;
  const res = await call(ctx, `${c.orgUrl}/${c.proj}/_apis/wit/wiql?${API}`, { method: 'POST', body: { query: q } });
  const ids = (res.workItems || []).map((w) => w.id);
  return fetchMany(ctx, c, ids);
}

async function setQaAssignee(ctx, wid, p) {
  const c = cfg(ctx);
  const q = qaFieldRef(c);
  const who = p ? (p.id || p.name) : '';
  let ops;
  if (q.ref) {
    ops = who ? [{ op: 'add', path: `/fields/${q.ref}`, value: who }] : [{ op: 'remove', path: `/fields/${q.ref}` }];
  } else {
    const wi = await call(ctx, `${c.orgUrl}/${c.proj}/_apis/wit/workitems/${encodeURIComponent(wid)}?fields=System.Tags&${API}`);
    const tags = String(wi.fields?.['System.Tags'] || '').split(';').map((t) => t.trim()).filter((t) => t && !t.startsWith(q.label));
    if (who) tags.push(q.label + who);
    ops = [{ op: 'add', path: '/fields/System.Tags', value: tags.join('; ') }];
  }
  await call(ctx, `${c.orgUrl}/${c.proj}/_apis/wit/workitems/${encodeURIComponent(wid)}?${API}`, {
    method: 'PATCH', body: JSON.stringify(ops), headers: { 'Content-Type': 'application/json-patch+json' },
  });
  return { ok: true };
}

async function searchItems(ctx, query = {}) {
  const c = cfg(ctx);
  const q = query || {};
  const max = Number(q.max) > 0 ? Number(q.max) : 500;
  const conds = ['[System.TeamProject] = @project'];
  if ((q.types || []).length) conds.push(`[System.WorkItemType] IN (${q.types.map(wiqlStr).join(',')})`);
  if ((q.states || []).length) conds.push(`[System.State] IN (${q.states.map(wiqlStr).join(',')})`);
  if ((q.notStates || []).length) conds.push(`[System.State] NOT IN (${q.notStates.map(wiqlStr).join(',')})`);
  if (q.release) conds.push(releaseCond(c, q.release));
  // WIQL compares dates at day precision unless timePrecision is on, so send the date part only.
  if (q.createdFrom) conds.push(`[System.CreatedDate] >= ${wiqlStr(String(q.createdFrom).slice(0, 10))}`);
  if (q.createdTo) conds.push(`[System.CreatedDate] <= ${wiqlStr(String(q.createdTo).slice(0, 10))}`);
  for (const w of B.titleWords(q.text)) conds.push(`[System.Title] CONTAINS ${wiqlStr(w)}`);
  const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${conds.join(' AND ')} ORDER BY [System.CreatedDate] DESC`;
  const res = await call(ctx, `${c.orgUrl}/${c.proj}/_apis/wit/wiql?$top=${max}&${API}`, { method: 'POST', body: { query: wiql } });
  const ids = (res.workItems || []).map((w) => w.id).slice(0, max);
  return fetchMany(ctx, c, ids);
}

/** Field names an Azure DevOps 400 message may use for a reference name ("Microsoft.VSTS.TCM.ReproSteps" -> "repro steps"). */
function refNames(ref) {
  const last = String(ref).split('.').pop();
  return [String(ref).toLowerCase(), last.toLowerCase(), last.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()];
}

async function createBug(ctx, bug = {}) {
  const c = cfg(ctx);
  const type = bug.type || 'Bug';
  const f = bug.fields || {};
  const plan = B.planBugFields(ctx, bug, BUG_DEFAULTS, ['ref', 'priority', 'label'], 'Azure DevOps');
  const warnings = [...plan.warnings];
  const optional = [];
  for (const w of plan.writes) {
    if (w.form === 'priority') {
      const n = B.priorityNumber(w.value);
      if (!n) { warnings.push(`Priority "${w.value}" is not 1-4 or Critical/High/Medium/Low; it was added to the description instead.`); plan.descLines.push(B.descriptionLine(w.key, w.value)); continue; }
      optional.push({ key: w.key, ref: PRIORITY_REF, value: n, raw: w.raw });
    } else {
      const value = w.field === 'Microsoft.VSTS.Common.Severity' && !w.values.length ? B.matchValue(w.value, SEVERITY_VALUES).value : w.value;
      optional.push({ key: w.key, ref: w.field, value, raw: w.raw });
    }
  }
  if (f.component) optional.push({ key: 'component', ref: 'System.AreaPath', value: f.component, raw: f.component });
  if (f.assignee && (f.assignee.id || f.assignee.name)) optional.push({ key: 'assignee', ref: 'System.AssignedTo', value: f.assignee.id || f.assignee.name });
  if (bug.linkTo && bug.linkTo.id) {
    const rel = LINK_TYPES[bug.linkTo.rel || 'related'];
    if (rel) optional.push({ key: 'link', rel, url: `${c.orgUrl}/_apis/wit/workItems/${encodeURIComponent(bug.linkTo.id)}`, raw: bug.linkTo.id });
    else warnings.push(`Unknown link type "${bug.linkTo.rel}" (use parent, related or tested-by); the bug was not linked to ${bug.linkTo.id}.`);
  }
  const tags = [...new Set([...(bug.tags || []), ...plan.labels].map((t) => String(t).trim()).filter(Boolean))];
  let descRef = /^bug$/i.test(type) ? 'Microsoft.VSTS.TCM.ReproSteps' : 'System.Description';
  const dropped = [];

  const build = () => {
    const extra = dropped.map((d) => (d.key === 'link' ? `Related work item: #${d.raw}` : B.TITLES[d.key] && d.raw ? B.descriptionLine(d.key, d.raw) : null)).filter(Boolean);
    const ops = [
      { op: 'add', path: '/fields/System.Title', value: bug.title || '(untitled bug)' },
      { op: 'add', path: `/fields/${descRef}`, value: B.markdownToHtml(B.composeDescription(bug.description, [...plan.descLines, ...extra])) },
    ];
    if (tags.length) ops.push({ op: 'add', path: '/fields/System.Tags', value: tags.join('; ') });
    for (const o of optional) {
      if (o.key === 'link') ops.push({ op: 'add', path: '/relations/-', value: { rel: o.rel, url: o.url } });
      else ops.push({ op: 'add', path: `/fields/${o.ref}`, value: o.value });
    }
    return ops;
  };

  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const res = await call(ctx, `${c.orgUrl}/${c.proj}/_apis/wit/workitems/$${encodeURIComponent(type)}?${API}`, {
        method: 'POST', body: JSON.stringify(build()), headers: { 'Content-Type': 'application/json-patch+json' },
      });
      return { id: String(res.id), url: `${c.orgUrl}/${c.proj}/_workitems/edit/${res.id}`, warnings };
    } catch (e) {
      if (e.status !== 400) throw e;
      const msg = String(e.body || e.message).toLowerCase();
      if (descRef !== 'System.Description' && refNames(descRef).some((n) => msg.includes(n))) {
        warnings.push(`Azure DevOps rejected ${descRef} for type "${type}"; the description was written to System.Description instead.`);
        descRef = 'System.Description';
        continue;
      }
      const culprit = optional.find((o) => (o.key === 'link' ? /relation|link/.test(msg) : refNames(o.ref).some((n) => msg.includes(n))));
      const drop = culprit ? [culprit] : optional.slice();
      if (!drop.length) throw e;
      for (const d of drop) {
        optional.splice(optional.indexOf(d), 1);
        dropped.push(d);
        warnings.push(d.key === 'link'
          ? `Azure DevOps rejected the link to ${d.raw}; the bug was created without it (the id is noted in the description).`
          : `Azure DevOps rejected ${d.ref} = "${d.value}"; the bug was created without it${B.TITLES[d.key] ? ' (the value is noted in the description)' : ''}.`);
      }
    }
  }
  throw new Error('Azure DevOps kept rejecting the bug fields: check bugFields in qa-framework.config.json against your process template.');
}

async function attachFile(ctx, wid, filePath) {
  const c = cfg(ctx);
  if (!fs.existsSync(filePath)) throw new Error(`Cannot attach "${filePath}": the file does not exist.`);
  const name = path.basename(filePath);
  const up = await call(ctx, `${c.orgUrl}/${c.proj}/_apis/wit/attachments?fileName=${encodeURIComponent(name)}&${API}`, {
    method: 'POST', body: fs.readFileSync(filePath), headers: { 'Content-Type': 'application/octet-stream' }, timeoutMs: 120000,
  });
  await call(ctx, `${c.orgUrl}/${c.proj}/_apis/wit/workitems/${encodeURIComponent(wid)}?${API}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify([{ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: up.url, attributes: { comment: 'Attached by the QA agent' } } }]),
  });
  return { ok: true, url: up.url };
}

module.exports = {
  id, label, secrets, fields, testConnection, getWorkItem, getChildren, getComments, addComment, createTask, listReleaseItems, setQaAssignee,
  searchItems, createBug, attachFile,
};
