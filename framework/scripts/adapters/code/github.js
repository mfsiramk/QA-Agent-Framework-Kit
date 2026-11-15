/**
 * Code adapter - GitHub (READ-ONLY).
 * Finds pull requests and commits whose title / message / branch mention the
 * work item id or key, in each repository listed in config.repos.
 * See ../CONTRACT.md.
 */
const { request, bearer } = require('../../core/http.js');

const SERVICE = 'GitHub';
const MAX_FILES = 50;
const MAX_RESULTS = 30;

const id = 'github';
const label = 'GitHub';

const secrets = [
  { env: 'GITHUB_TOKEN', label: 'GitHub access token',
    help: 'On GitHub: avatar → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. '
      + 'Give it access to the code repositories below with Contents: "Read-only" and Pull requests: "Read-only" '
      + '(a classic token with the "repo" scope also works). If you use GitHub Issues too, one token can be shared. This adapter never changes code.' },
];

const fields = [
  { key: 'repos', label: 'Repositories', placeholder: 'my-company/web-app, my-company/api', required: true,
    help: 'The code repositories developers commit to, as owner/repo, separated by commas.' },
  { key: 'apiUrl', label: 'API URL (Enterprise only)', placeholder: 'https://api.github.com', required: false,
    help: 'Leave empty for github.com. For GitHub Enterprise Server use https://<your-server>/api/v3.' },
];

function cfg(ctx) {
  const c = ctx.config || {};
  const t = (ctx.task && (ctx.task.config || ctx.task)) || {};
  const repos = (Array.isArray(c.repos) ? c.repos : String(c.repos || '').split(',')).map((r) => String(r).trim()).filter(Boolean);
  if (!repos.length) throw new Error('GitHub code changes are not configured: list at least one repository as owner/repo.');
  if (!ctx.env || !ctx.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is missing from .env.');
  return { api: String(c.apiUrl || t.apiUrl || 'https://api.github.com').replace(/\/+$/, ''), repos, token: ctx.env.GITHUB_TOKEN };
}

const call = (c, path) => request({ url: c.api + path, service: SERVICE,
  headers: { Authorization: bearer(c.token), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });

/** Numeric ids must appear as #42, AB#42 or /issues/42; keys (ABC-12) as a whole word. */
function mentionRe(wid) {
  const s = String(wid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /^\d+$/.test(String(wid)) ? new RegExp(`(#|/issues/)${s}(?!\\d)`) : new RegExp(`(^|[^A-Za-z0-9])${s}(?![0-9])`, 'i');
}

async function testConnection(ctx) {
  try {
    const c = cfg(ctx);
    for (const r of c.repos) await call(c, `/repos/${r}`);
    return { ok: true, message: `Connected to GitHub - ${c.repos.length} repositor${c.repos.length === 1 ? 'y' : 'ies'} readable.` };
  } catch (e) {
    const s = e.status;
    const fix = s === 401 ? 'Generate a new GitHub token and paste it into GITHUB_TOKEN in .env.'
      : s === 403 ? 'Give the token Contents and Pull requests read access (and approve it for your organization\'s SSO if required).'
      : s === 404 ? 'Check each repository is written as owner/repo and that the token was granted access to it.'
      : /not configured|missing/.test(e.message) ? 'List the repositories and add GITHUB_TOKEN to .env, then test again.'
      : 'Check the API URL and your network connection, then test again.';
    return { ok: false, message: e.message, fix };
  }
}

async function findChanges(ctx, workItem) {
  const c = cfg(ctx);
  const wid = typeof workItem === 'object' ? workItem.id : workItem;
  const re = mentionRe(wid);
  const out = [];
  for (const repo of c.repos) {
    // Pull requests
    let prs = [];
    try { prs = (await call(c, `/search/issues?q=${encodeURIComponent(`${wid} repo:${repo} type:pr`)}&per_page=${MAX_RESULTS}`)).items || []; } catch { /* search unavailable */ }
    for (const hit of prs) {
      try {
        const pr = await call(c, `/repos/${repo}/pulls/${hit.number}`);
        if (!re.test(`${pr.title}\n${pr.body || ''}\n${pr.head?.ref || ''}`)) continue;
        const files = (await call(c, `/repos/${repo}/pulls/${hit.number}/files?per_page=${MAX_FILES}`)).map((f) => f.filename).slice(0, MAX_FILES);
        out.push({ kind: 'pull-request', id: String(pr.number), title: pr.title, url: pr.html_url, repo, author: pr.user?.login || '', date: pr.created_at, files });
      } catch { /* skip inaccessible PR */ }
    }
    // Commits
    let commits = [];
    try { commits = (await call(c, `/search/commits?q=${encodeURIComponent(`${wid} repo:${repo}`)}&per_page=${MAX_RESULTS}`)).items || []; } catch { /* commit search unavailable */ }
    for (const hit of commits) {
      if (!re.test(hit.commit?.message || '')) continue;
      let files = [];
      try { files = ((await call(c, `/repos/${repo}/commits/${hit.sha}`)).files || []).map((f) => f.filename).slice(0, MAX_FILES); } catch { /* no files */ }
      out.push({ kind: 'commit', id: hit.sha, title: String(hit.commit.message).split('\n')[0], url: hit.html_url, repo,
        author: hit.commit.author?.name || hit.author?.login || '', date: hit.commit.author?.date || '', files });
    }
  }
  return out;
}

module.exports = { id, label, secrets, fields, testConnection, findChanges };
