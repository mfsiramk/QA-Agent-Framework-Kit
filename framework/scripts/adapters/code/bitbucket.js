/**
 * Code adapter - Bitbucket Cloud (READ-ONLY).
 * Finds pull requests whose title / description / source branch contains the
 * work item key, then their commits; changed files come from diffstat.
 * See ../CONTRACT.md.
 */
const { request, basicAuth } = require('../../core/http.js');

const SERVICE = 'Bitbucket';
const API = 'https://api.bitbucket.org/2.0';
const MAX_FILES = 50;
const MAX_COMMITS_PER_PR = 20;

const id = 'bitbucket';
const label = 'Bitbucket Cloud';

const secrets = [
  { env: 'BITBUCKET_USER', label: 'Bitbucket username',
    help: 'Your Bitbucket username (Personal settings → Account settings → "Username"). If you use an Atlassian API token instead of an app password, put your Atlassian email here.' },
  { env: 'BITBUCKET_APP_PASSWORD', label: 'Bitbucket app password / API token',
    help: 'In Bitbucket: Personal settings → App passwords → Create app password (or Atlassian account → Security → API tokens, with Bitbucket scopes). '
      + 'Grant only Repositories: Read and Pull requests: Read. This adapter never changes code.' },
];

const fields = [
  { key: 'workspace', label: 'Workspace', placeholder: 'my-company', required: true,
    help: 'The workspace name in your repository address: bitbucket.org/<workspace>/<repo>.' },
  { key: 'repos', label: 'Repositories', placeholder: 'web-app, api', required: true,
    help: 'The repository names (slugs) developers push to, separated by commas: bitbucket.org/<workspace>/<repo>.' },
];

function cfg(ctx) {
  const c = ctx.config || {};
  const env = ctx.env || {};
  const repos = (Array.isArray(c.repos) ? c.repos : String(c.repos || '').split(',')).map((r) => String(r).trim()).filter(Boolean);
  if (!c.workspace || !repos.length) throw new Error('Bitbucket is not configured: set the Workspace and at least one repository.');
  if (!env.BITBUCKET_USER || !env.BITBUCKET_APP_PASSWORD) throw new Error('BITBUCKET_USER or BITBUCKET_APP_PASSWORD is missing from .env.');
  return { ws: encodeURIComponent(c.workspace), repos, auth: basicAuth(env.BITBUCKET_USER, env.BITBUCKET_APP_PASSWORD) };
}

const call = (c, url) => request({ url: url.startsWith('http') ? url : API + url, service: SERVICE, headers: { Authorization: c.auth } });

async function diffFiles(c, url) {
  try {
    const res = await call(c, url);
    return (res.values || []).map((d) => d.new?.path || d.old?.path).filter(Boolean).slice(0, MAX_FILES);
  } catch { return []; }
}

async function testConnection(ctx) {
  try {
    const c = cfg(ctx);
    for (const r of c.repos) await call(c, `/repositories/${c.ws}/${encodeURIComponent(r)}`);
    return { ok: true, message: `Connected to Bitbucket - ${c.repos.length} repositor${c.repos.length === 1 ? 'y' : 'ies'} readable.` };
  } catch (e) {
    const s = e.status;
    const fix = s === 401 ? 'Create a new Bitbucket app password (Repositories: Read, Pull requests: Read) and update .env.'
      : s === 403 ? 'Ask a workspace admin to give your account read access to these repositories.'
      : s === 404 ? 'Check the Workspace and repository names exactly as they appear in the Bitbucket URL.'
      : /not configured|missing/.test(e.message) ? 'Fill in the Workspace, repositories, BITBUCKET_USER and BITBUCKET_APP_PASSWORD, then test again.'
      : 'Check your network connection, then test again.';
    return { ok: false, message: e.message, fix };
  }
}

async function findChanges(ctx, workItem) {
  const c = cfg(ctx);
  const wid = String(typeof workItem === 'object' ? workItem.id : workItem).replace(/"/g, '');
  const q = `title ~ "${wid}" OR description ~ "${wid}" OR source.branch.name ~ "${wid}"`;
  const out = []; const seenCommits = new Set();
  for (const slug of c.repos) {
    const base = `/repositories/${c.ws}/${encodeURIComponent(slug)}`;
    let prs = [];
    try {
      let url = `${base}/pullrequests?q=${encodeURIComponent(q)}&state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&pagelen=50`;
      while (url && prs.length < 200) { const res = await call(c, url); prs.push(...(res.values || [])); url = res.next; }
    } catch { /* skip repo */ }
    for (const pr of prs) {
      out.push({ kind: 'pull-request', id: String(pr.id), title: pr.title, url: pr.links?.html?.href || '', repo: slug,
        author: pr.author?.display_name || '', date: pr.created_on, files: await diffFiles(c, `${base}/pullrequests/${pr.id}/diffstat?pagelen=${MAX_FILES}`) });
      let commits = [];
      try { commits = ((await call(c, `${base}/pullrequests/${pr.id}/commits?pagelen=${MAX_COMMITS_PER_PR}`)).values || []).slice(0, MAX_COMMITS_PER_PR); } catch { /* no commits */ }
      for (const cm of commits) {
        if (seenCommits.has(cm.hash)) continue;
        seenCommits.add(cm.hash);
        out.push({ kind: 'commit', id: cm.hash, title: String(cm.message || '').split('\n')[0], url: cm.links?.html?.href || '', repo: slug,
          author: cm.author?.user?.display_name || String(cm.author?.raw || '').replace(/\s*<.*>$/, ''), date: cm.date,
          files: await diffFiles(c, `${base}/diffstat/${cm.hash}?pagelen=${MAX_FILES}`) });
      }
    }
  }
  return out;
}

module.exports = { id, label, secrets, fields, testConnection, findChanges };
