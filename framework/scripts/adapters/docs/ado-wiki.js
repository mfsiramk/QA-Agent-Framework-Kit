/**
 * Azure DevOps Wiki docs adapter. Reads a wiki page (Markdown) by its browser URL:
 *   https://dev.azure.com/{org}/{project}/_wiki/wikis/{wiki}/{pageId}/{Page-Title}
 *   https://{org}.visualstudio.com/{project}/_wiki/wikis/{wiki}/{pageId}/...
 * Org/project come from the URL; testConnection uses config (or the Azure Boards settings).
 * Secret: ADO_PAT (shared with Azure Boards / Test Plans) - needs "Wiki: Read".
 */

const { request, basicAuth } = require('../../core/http.js');

const SERVICE = 'Azure DevOps Wiki';
const API = 'api-version=7.1';

function auth(ctx) {
  const pat = (ctx.env || {}).ADO_PAT;
  if (!pat) throw new Error('Azure DevOps Wiki: ADO_PAT is missing from .env.');
  return basicAuth('', pat);
}

function parseUrl(input) {
  const s = String(input || '').trim();
  let m = s.match(/^(https:\/\/dev\.azure\.com\/[^/]+)\/([^/]+)\/_wiki\/wikis\/([^/]+)\/(\d+)/i)
    || s.match(/^(https:\/\/[^/]+\.visualstudio\.com)\/([^/]+)\/_wiki\/wikis\/([^/]+)\/(\d+)/i);
  if (m) return { orgUrl: m[1], project: decodeURIComponent(m[2]), wiki: decodeURIComponent(m[3]), pageId: m[4] };
  m = s.match(/^(https:\/\/dev\.azure\.com\/[^/]+|https:\/\/[^/]+\.visualstudio\.com)\/([^/]+)\/_wiki\/wikis\/([^/?#]+)[^?#]*\?.*pagePath=([^&]+)/i);
  if (m) return { orgUrl: m[1], project: decodeURIComponent(m[2]), wiki: decodeURIComponent(m[3]), pagePath: decodeURIComponent(m[4]) };
  throw new Error(`Azure DevOps Wiki: "${s}" is not a wiki page address. Open the page in the browser and copy the address (it contains /_wiki/wikis/).`);
}

function sections(md, title) {
  const out = [];
  let cur = { heading: title, lines: [] };
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^\s{0,3}#{1,4}\s+(.*?)\s*#*\s*$/);
    if (h) { out.push(cur); cur = { heading: h[1], lines: [] }; } else cur.lines.push(line);
  }
  out.push(cur);
  return out.map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() })).filter((s, i) => s.text || i > 0);
}

function matches(ctx, input) {
  return /\/_wiki\/wikis\//i.test(String(input || ''));
}

async function testConnection(ctx) {
  const c = { ...(ctx.task || {}), ...(ctx.config || {}) };
  const orgUrl = String(c.orgUrl || '').replace(/\/+$/, '');
  if (!orgUrl || !c.project) return { ok: false, message: 'Azure DevOps Wiki: organization URL and project are not set.', fix: 'Fill in the Organization URL and Project (or choose Azure Boards as your task tool), then test again.' };
  try {
    const r = await request({ url: `${orgUrl}/${encodeURIComponent(c.project)}/_apis/wiki/wikis?${API}`, service: SERVICE, headers: { Authorization: auth(ctx) } });
    const n = (r.value || []).length;
    return { ok: true, message: `Connected to Azure DevOps Wiki - ${n} wiki${n === 1 ? '' : 's'} in "${c.project}".` };
  } catch (e) {
    return { ok: false, message: e.message, fix: 'Check ADO_PAT has the "Wiki (Read)" scope and the organization URL / project are right.' };
  }
}

async function fetchDocument(ctx, input) {
  const p = parseUrl(input);
  const base = `${p.orgUrl}/${encodeURIComponent(p.project)}/_apis/wiki/wikis/${encodeURIComponent(p.wiki)}/pages`;
  const url = p.pageId ? `${base}/${p.pageId}?includeContent=true&${API}` : `${base}?path=${encodeURIComponent(p.pagePath)}&includeContent=true&${API}`;
  const page = await request({ url, service: SERVICE, headers: { Authorization: auth(ctx) } });
  const title = String(page.path || '').split('/').pop().replace(/-/g, ' ') || 'Wiki page';
  const md = String(page.content || '');
  return { title, url: page.remoteUrl || String(input), text: md, sections: sections(md, title) };
}

module.exports = {
  id: 'ado-wiki',
  label: 'Azure DevOps Wiki',
  secrets: [{ env: 'ADO_PAT', label: 'Azure DevOps Personal Access Token', help: 'The same token as Azure Boards. In Azure DevOps: User settings → Personal access tokens → New token, with "Wiki: Read" (plus Work Items scopes if you also use Azure Boards).' }],
  fields: [
    { key: 'orgUrl', label: 'Organization URL', placeholder: 'https://dev.azure.com/your-org', help: 'Only needed if your task tool is not Azure Boards.', required: false },
    { key: 'project', label: 'Project', placeholder: 'YourProject', help: 'Only needed if your task tool is not Azure Boards.', required: false },
  ],
  testConnection,
  matches,
  fetchDocument,
};
