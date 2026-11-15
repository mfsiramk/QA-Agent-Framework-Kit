/**
 * Code adapter - GitLab (READ-ONLY).
 * Finds merge requests and commits that mention the work item id/key in each
 * project listed in config.projects. See ../CONTRACT.md.
 */
const { request } = require('../../core/http.js');

const SERVICE = 'GitLab';
const MAX_FILES = 50;
const MAX_RESULTS = 30;

const id = 'gitlab';
const label = 'GitLab';

const secrets = [
  { env: 'GITLAB_TOKEN', label: 'GitLab access token',
    help: 'In GitLab: avatar → Edit profile → Access tokens → Add new token, tick "read_api" (or "api" if the same token is used for GitLab Issues). '
      + 'Your account needs at least Reporter access to each project below. This adapter never changes code.' },
];

const fields = [
  { key: 'baseUrl', label: 'GitLab URL', placeholder: 'https://gitlab.com', required: false,
    help: 'https://gitlab.com, or your company\'s own GitLab server. Leave empty to reuse the GitLab Issues URL.' },
  { key: 'projects', label: 'Projects', placeholder: 'my-group/web-app, my-group/api', required: true,
    help: 'The code projects developers push to, as group/project, separated by commas.' },
];

function cfg(ctx) {
  const c = ctx.config || {};
  const t = (ctx.task && (ctx.task.config || ctx.task)) || {};
  const projects = (Array.isArray(c.projects) ? c.projects : String(c.projects || '').split(',')).map((p) => String(p).trim()).filter(Boolean);
  if (!projects.length) throw new Error('GitLab code changes are not configured: list at least one project as group/project.');
  if (!ctx.env || !ctx.env.GITLAB_TOKEN) throw new Error('GITLAB_TOKEN is missing from .env.');
  return { api: `${String(c.baseUrl || t.baseUrl || 'https://gitlab.com').replace(/\/+$/, '')}/api/v4`, projects, token: ctx.env.GITLAB_TOKEN };
}

const call = (c, path) => request({ url: c.api + path, service: SERVICE, headers: { 'PRIVATE-TOKEN': c.token } });
const P = (p) => `/projects/${encodeURIComponent(p)}`;

function mentionRe(wid) {
  const s = String(wid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /^\d+$/.test(String(wid)) ? new RegExp(`(#|/issues/)${s}(?!\\d)`) : new RegExp(`(^|[^A-Za-z0-9])${s}(?![0-9])`, 'i');
}

async function mrFiles(c, proj, iid) {
  try { return (await call(c, `${P(proj)}/merge_requests/${iid}/diffs?per_page=${MAX_FILES}`)).map((d) => d.new_path || d.old_path).slice(0, MAX_FILES); } catch { /* older GitLab */ }
  try { return ((await call(c, `${P(proj)}/merge_requests/${iid}/changes`)).changes || []).map((d) => d.new_path || d.old_path).slice(0, MAX_FILES); } catch { return []; }
}

async function testConnection(ctx) {
  try {
    const c = cfg(ctx);
    for (const p of c.projects) await call(c, P(p));
    return { ok: true, message: `Connected to GitLab - ${c.projects.length} project${c.projects.length === 1 ? '' : 's'} readable.` };
  } catch (e) {
    const s = e.status;
    const fix = s === 401 ? 'Create a new GitLab access token with "read_api" scope and paste it into GITLAB_TOKEN in .env.'
      : s === 403 ? 'Ask a project maintainer to give your account at least the Reporter role on each project.'
      : s === 404 ? 'Check each project is written as group/project and that your account can see it.'
      : /not configured|missing/.test(e.message) ? 'List the projects and add GITLAB_TOKEN to .env, then test again.'
      : 'Check the GitLab URL and your network/VPN connection, then test again.';
    return { ok: false, message: e.message, fix };
  }
}

async function findChanges(ctx, workItem) {
  const c = cfg(ctx);
  const wid = typeof workItem === 'object' ? workItem.id : workItem;
  const re = mentionRe(wid);
  const out = [];
  for (const proj of c.projects) {
    let mrs = [];
    try { mrs = await call(c, `${P(proj)}/merge_requests?state=all&search=${encodeURIComponent(wid)}&in=title,description&per_page=${MAX_RESULTS}`); } catch { /* skip */ }
    // Branch names are not searchable server-side; also scan recent MRs by source branch.
    try {
      const recent = await call(c, `${P(proj)}/merge_requests?state=all&order_by=updated_at&per_page=100`);
      for (const m of recent) if (re.test(m.source_branch || '') && !mrs.some((x) => x.iid === m.iid)) mrs.push(m);
    } catch { /* skip */ }
    for (const mr of mrs) {
      if (!re.test(`${mr.title}\n${mr.description || ''}\n${mr.source_branch || ''}`)) continue;
      out.push({ kind: 'pull-request', id: String(mr.iid), title: mr.title, url: mr.web_url, repo: proj,
        author: mr.author?.username || '', date: mr.created_at, files: await mrFiles(c, proj, mr.iid) });
    }
    let commits = [];
    try { commits = await call(c, `${P(proj)}/search?scope=commits&search=${encodeURIComponent(wid)}&per_page=${MAX_RESULTS}`); } catch { /* commit search needs advanced search on some tiers */ }
    for (const cm of Array.isArray(commits) ? commits : []) {
      if (!re.test(cm.message || cm.title || '')) continue;
      let files = [];
      try { files = (await call(c, `${P(proj)}/repository/commits/${cm.id}/diff?per_page=${MAX_FILES}`)).map((d) => d.new_path || d.old_path).slice(0, MAX_FILES); } catch { /* no files */ }
      out.push({ kind: 'commit', id: cm.id, title: cm.title || String(cm.message).split('\n')[0], url: cm.web_url || '', repo: proj,
        author: cm.author_name || '', date: cm.authored_date || cm.created_at || '', files });
    }
  }
  return out;
}

module.exports = { id, label, secrets, fields, testConnection, findChanges };
