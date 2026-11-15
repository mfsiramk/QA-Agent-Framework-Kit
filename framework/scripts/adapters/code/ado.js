/**
 * Code adapter - Azure Repos (READ-ONLY).
 * Finds commits and pull requests linked to a work item through its
 * "ArtifactLink" relations (Development section), then lists changed files.
 * See ../CONTRACT.md.
 */
const { request, basicAuth } = require('../../core/http.js');

const SERVICE = 'Azure Repos';
const API = 'api-version=7.0';
const MAX_FILES = 50;

const id = 'ado';
const label = 'Azure Repos (Azure DevOps)';

const secrets = [
  { env: 'ADO_PAT', label: 'Azure DevOps Personal Access Token',
    help: 'The same token used for Azure Boards. It needs Code: "Read" in addition to Work Items access - '
      + 'edit the token under your profile picture → Personal access tokens and tick Code → Read if it is missing. '
      + 'This adapter only reads code; it never changes anything.' },
];

const fields = [
  { key: 'orgUrl', label: 'Organization URL (optional)', placeholder: 'https://dev.azure.com/your-org', required: false,
    help: 'Leave empty to reuse the Organization URL from the Azure Boards settings.' },
  { key: 'project', label: 'Project name (optional)', placeholder: 'My Project', required: false,
    help: 'Leave empty to reuse the Project name from the Azure Boards settings.' },
];

function cfg(ctx) {
  const t = (ctx.task && (ctx.task.config || ctx.task)) || {};
  const c = ctx.config || {};
  const orgUrl = String(c.orgUrl || t.orgUrl || '').replace(/\/+$/, '');
  const project = c.project || t.project;
  if (!orgUrl || !project) throw new Error('Azure Repos is not configured: set the Azure DevOps Organization URL and Project name.');
  if (!ctx.env || !ctx.env.ADO_PAT) throw new Error('ADO_PAT is missing from .env.');
  return { orgUrl, project, proj: encodeURIComponent(project), auth: basicAuth('', ctx.env.ADO_PAT) };
}

const call = (c, url) => request({ url, service: SERVICE, headers: { Authorization: c.auth } });

/** vstfs:///Git/Commit/{project}%2F{repo}%2F{sha} → { kind, projectId, repoId, ref } */
function parseArtifact(rel) {
  const url = decodeURIComponent(String(rel.url || ''));
  const m = url.match(/vstfs:\/\/\/Git\/(Commit|PullRequestId)\/([^/]+)\/([^/]+)\/([^/]+)$/i);
  if (!m) return null;
  return { kind: /commit/i.test(m[1]) ? 'commit' : 'pull-request', projectId: m[2], repoId: m[3], ref: m[4] };
}

async function commitChange(c, a, repoCache) {
  const base = `${c.orgUrl}/${a.projectId}/_apis/git/repositories/${a.repoId}`;
  if (!repoCache[a.repoId]) repoCache[a.repoId] = await call(c, `${base}?${API}`).catch(() => ({ name: a.repoId, webUrl: '' }));
  const repo = repoCache[a.repoId];
  const cm = await call(c, `${base}/commits/${a.ref}?${API}`);
  let files = [];
  try {
    const ch = await call(c, `${base}/commits/${a.ref}/changes?$top=${MAX_FILES}&${API}`);
    files = (ch.changes || []).filter((x) => x.item && !x.item.isFolder).map((x) => x.item.path).slice(0, MAX_FILES);
  } catch { /* file list unavailable */ }
  return {
    kind: 'commit', id: cm.commitId || a.ref, title: String(cm.comment || '').split('\n')[0],
    url: repo.webUrl ? `${repo.webUrl}/commit/${a.ref}` : (cm.remoteUrl || ''), repo: repo.name,
    author: cm.author?.name || '', date: cm.author?.date || cm.committer?.date || '', files,
  };
}

async function prChange(c, a) {
  const base = `${c.orgUrl}/${a.projectId}/_apis/git/repositories/${a.repoId}/pullrequests/${a.ref}`;
  const pr = await call(c, `${base}?${API}`);
  let files = [];
  try {
    const iters = (await call(c, `${base}/iterations?${API}`)).value || [];
    if (iters.length) {
      const last = iters[iters.length - 1].id;
      const ch = await call(c, `${base}/iterations/${last}/changes?$top=${MAX_FILES}&${API}`);
      files = (ch.changeEntries || []).filter((x) => x.item && x.item.path && !x.item.isFolder).map((x) => x.item.path).slice(0, MAX_FILES);
    }
  } catch { /* file list unavailable */ }
  return {
    kind: 'pull-request', id: String(pr.pullRequestId), title: pr.title || '',
    url: pr.repository?.webUrl ? `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}` : '',
    repo: pr.repository?.name || '', author: pr.createdBy?.displayName || '', date: pr.creationDate || '', files,
  };
}

async function testConnection(ctx) {
  try {
    const c = cfg(ctx);
    const repos = await call(c, `${c.orgUrl}/${c.proj}/_apis/git/repositories?${API}`);
    return { ok: true, message: `Connected to Azure Repos - ${(repos.value || []).length} repositor${(repos.value || []).length === 1 ? 'y' : 'ies'} visible in "${c.project}".` };
  } catch (e) {
    const s = e.status;
    const fix = s === 401 ? 'Create a new Personal Access Token in Azure DevOps and paste it into ADO_PAT in .env.'
      : s === 403 ? 'Edit the token and tick Code → "Read", or ask an admin for read access to the project\'s repositories.'
      : s === 404 ? 'Check the Organization URL and the exact Project name.'
      : /not configured|missing/.test(e.message) ? 'Fill in the Azure Boards Organization URL, Project name and ADO_PAT, then test again.'
      : 'Check the Organization URL and your network/VPN connection, then test again.';
    return { ok: false, message: e.message, fix };
  }
}

async function findChanges(ctx, workItem) {
  const c = cfg(ctx);
  const wid = typeof workItem === 'object' ? workItem.id : workItem;
  const wi = await call(c, `${c.orgUrl}/${c.proj}/_apis/wit/workitems/${encodeURIComponent(wid)}?$expand=relations&${API}`);
  const arts = (wi.relations || []).filter((r) => r.rel === 'ArtifactLink').map(parseArtifact).filter(Boolean);
  const out = []; const seen = new Set(); const repoCache = {};
  for (const a of arts) {
    const k = `${a.kind}:${a.repoId}:${a.ref}`;
    if (seen.has(k)) continue;
    seen.add(k);
    try { out.push(a.kind === 'commit' ? await commitChange(c, a, repoCache) : await prChange(c, a)); } catch { /* deleted repo / no access - skip this link */ }
  }
  return out;
}

module.exports = { id, label, secrets, fields, testConnection, findChanges };
