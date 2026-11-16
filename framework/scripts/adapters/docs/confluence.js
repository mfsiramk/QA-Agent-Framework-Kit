/**
 * Confluence docs adapter (Cloud or Server/Data Center, REST API v1 content endpoint).
 *
 * fetchDocument accepts a page URL (…/pages/<id>/…, ?pageId=<id>, /display/<SPACE>/<Title>)
 * or a bare page id, reads body.storage and returns plain text split into sections on h1-h4.
 */

const { request, basicAuth, bearer, htmlToText } = require('../../core/http.js');

const SERVICE = 'Confluence';

function conn(ctx) {
  const c = ctx.config || {};
  const e = ctx.env || {};
  const baseUrl = String(c.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Confluence: base URL is not configured. Fill it in the installer.');
  const server = String(c.deployment || 'cloud').toLowerCase() === 'server';
  if (server) {
    if (!e.CONFLUENCE_PAT) throw new Error('Confluence: CONFLUENCE_PAT is missing from .env.');
    return { baseUrl, auth: bearer(e.CONFLUENCE_PAT) };
  }
  if (!e.CONFLUENCE_EMAIL || !e.CONFLUENCE_API_TOKEN) throw new Error('Confluence: CONFLUENCE_EMAIL / CONFLUENCE_API_TOKEN are missing from .env.');
  return { baseUrl, auth: basicAuth(e.CONFLUENCE_EMAIL, e.CONFLUENCE_API_TOKEN) };
}

const api = (ctx, path) => request({ url: `${conn(ctx).baseUrl}/rest/api/${path}`, service: SERVICE, headers: { Authorization: conn(ctx).auth } });

function parseRef(input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return { id: s };
  let m = s.match(/\/pages\/(\d+)/) || s.match(/[?&]pageId=(\d+)/);
  if (m) return { id: m[1] };
  m = s.match(/\/display\/([^/]+)\/([^?#]+)/);
  if (m) return { space: decodeURIComponent(m[1]), title: decodeURIComponent(m[2].replace(/\+/g, ' ')) };
  if (/\/x\/[\w-]+/.test(s)) throw new Error('Confluence: short links (/x/…) cannot be resolved. Open the page and copy the full address from the browser (it contains /pages/<number>/).');
  throw new Error(`Confluence: "${s}" is not a page URL or page id. Copy the page address from the browser.`);
}

function splitSections(html, title) {
  const sections = [];
  const parts = String(html || '').split(/(<h[1-4][^>]*>[\s\S]*?<\/h[1-4]>)/i);
  let heading = title || '';
  let buf = '';
  const flush = () => { const t = htmlToText(buf); if (t || sections.length === 0 && heading) sections.push({ heading, text: t }); };
  for (const p of parts) {
    if (/^<h[1-4]/i.test(p)) { flush(); heading = htmlToText(p); buf = ''; } else buf += p;
  }
  flush();
  return sections.filter((s) => s.text || s.heading);
}

/** Storage format uses ac:/ri: macros - keep their inner text, drop the markup. */
const cleanStorage = (html) => String(html || '')
  .replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/gi, '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<\/?(ac|ri):[^>]*>/gi, ' ')
  .replace(/<\/(td|th)>/gi, ' | ');

async function testConnection(ctx) {
  try {
    await api(ctx, 'space?limit=1');
    return { ok: true, message: 'Connected to Confluence.' };
  } catch (e) {
    return { ok: false, message: e.message, fix: 'Check the Confluence URL (Cloud ends with /wiki) and that the token is valid and your account can view the spaces holding requirement documents.' };
  }
}

async function fetchDocument(ctx, urlOrId) {
  const ref = parseRef(urlOrId);
  let page;
  if (ref.id) page = await api(ctx, `content/${ref.id}?expand=body.storage,space`);
  else {
    const r = await api(ctx, `content?spaceKey=${encodeURIComponent(ref.space)}&title=${encodeURIComponent(ref.title)}&expand=body.storage,space`);
    page = (r.results || [])[0];
    if (!page) throw new Error(`Confluence: no page titled "${ref.title}" in space ${ref.space}.`);
  }
  const html = cleanStorage(page.body && page.body.storage && page.body.storage.value);
  const base = conn(ctx).baseUrl;
  const url = page._links && page._links.webui ? `${base}${page._links.webui}` : `${base}/pages/viewpage.action?pageId=${page.id}`;
  return { title: page.title, url, text: htmlToText(html), sections: splitSections(html, page.title) };
}

/**
 * Create or update a page by title in a space (storage-format HTML).
 * Needs write permission: the account behind the token must be allowed to add pages in the space.
 * Returns { id, url, created }.
 */
async function upsertPage(ctx, { spaceKey, parentId, title, html } = {}) {
  if (!spaceKey || !title) throw new Error('Confluence: upsertPage needs a spaceKey and a title.');
  const { baseUrl, auth } = conn(ctx);
  const call = (path, opts = {}) => request({ ...opts, url: `${baseUrl}/rest/api/${path}`, service: SERVICE, headers: { Authorization: auth, ...(opts.headers || {}) } });
  const found = await call(`content?spaceKey=${encodeURIComponent(spaceKey)}&title=${encodeURIComponent(title)}&type=page&expand=version`);
  const existing = (found.results || [])[0];
  const body = { storage: { value: String(html || ''), representation: 'storage' } };
  let page;
  if (existing) {
    page = await call(`content/${existing.id}`, {
      method: 'PUT',
      body: { id: existing.id, type: 'page', title, space: { key: spaceKey }, version: { number: ((existing.version && existing.version.number) || 1) + 1 }, body },
    });
  } else {
    const payload = { type: 'page', title, space: { key: spaceKey }, body };
    if (parentId) payload.ancestors = [{ id: String(parentId) }];
    page = await call('content', { method: 'POST', body: payload });
  }
  const id = String(page.id || (existing && existing.id));
  return { id, url: `${baseUrl}/pages/viewpage.action?pageId=${id}`, created: !existing };
}

/** A Confluence page link: same host as the configured site, or an atlassian.net/wiki, /display/ or /pages/<id> address. */
function matches(ctx, input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return true;
  if (/\/_wiki\//.test(s)) return false; // Azure DevOps wiki
  if (/\/browse\/[A-Z][A-Z0-9_]+-\d+|\/jira\/|[?&]selectedIssue=/i.test(s)) return false; // Jira issue on the same atlassian.net site
  const base = String((ctx.config || {}).baseUrl || '');
  try { if (base && new URL(s).host === new URL(base).host && (!/\/wiki(\/|$)/.test(base) || /\/wiki\//.test(s))) return true; } catch { /* not a URL */ }
  return /atlassian\.net\/wiki\/|\/display\/|[?&]pageId=|\/pages\/\d+/.test(s);
}

module.exports = {
  id: 'confluence',
  label: 'Confluence',
  secrets: [
    { env: 'CONFLUENCE_EMAIL', label: 'Confluence login email (Cloud)', help: 'Cloud only: the email you sign in to Atlassian with.' },
    { env: 'CONFLUENCE_API_TOKEN', label: 'Atlassian API token (Cloud)', help: 'Cloud only: go to id.atlassian.com → Security → Create and manage API tokens → Create API token. Your account needs view access to the requirement spaces. To publish report pages (upsertPage) the account also needs "Add page" permission in the target space.' },
    { env: 'CONFLUENCE_PAT', label: 'Confluence Personal Access Token (Server/Data Center)', help: 'Server/Data Center only: in Confluence click your avatar → Settings → Personal Access Tokens → Create token (read access is enough). To publish report pages (upsertPage) the token\'s account also needs "Add page" permission in the target space.' },
  ],
  fields: [
    { key: 'baseUrl', label: 'Confluence URL', placeholder: 'https://yourcompany.atlassian.net/wiki', help: 'Cloud: your Atlassian site followed by /wiki. Server/Data Center: the address you open Confluence at.', required: true },
    { key: 'deployment', label: 'Deployment', placeholder: 'cloud', help: '"cloud" for *.atlassian.net, "server" for a self-hosted Server or Data Center install.', required: true },
  ],
  testConnection,
  matches,
  fetchDocument,
  upsertPage,
};
