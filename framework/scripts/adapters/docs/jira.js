/**
 * Jira requirement-docs adapter - for teams that keep the SRS / BRD in Jira:
 * an Epic, a dedicated "Requirement" / "SRS" issue type, or Word/PDF files attached to an issue.
 *
 * fetchDocument(ctx, <issue URL or KEY-123>) returns the issue as a document:
 *   title     "<KEY> <summary>"
 *   sections  description split on its headings, plus key fields (type, status, components,
 *             labels, fix versions), plus every readable attachment:
 *               .docx / .md / .txt / .html  -> downloaded and read
 *               .pdf                        -> downloaded; needsDirectRead (the assistant opens it)
 *
 * discover(ctx, workItem, texts) finds requirement issues for a ticket automatically:
 *   - when the task tool is this same Jira: the ticket's parent and its linked issues
 *   - Jira issue links (/browse/KEY-1) found in the ticket text / comments
 *   - SRS project(s) set: issues in those projects that mention the ticket key (JQL text search)
 *   An issue counts as a requirement when its type is in config.issueTypes (default: Epic,
 *   Requirement, SRS) OR it lives in one of config.requirementProjects - so a separate SRS
 *   project can use ordinary types (Story, Task...) and still be recognised.
 *
 * Works across projects: user stories in one project, the SRS in another (same Jira site).
 *
 * config: baseUrl, deployment (cloud|server), issueTypes ("Epic, Requirement"), requirementProjects ("SRS, SPEC")
 * secrets: cloud JIRA_EMAIL + JIRA_API_TOKEN · server JIRA_PAT (shared with the Jira task tool)
 */

const fs = require('fs');
const path = require('path');
const { request, basicAuth, bearer, htmlToText, atlassianUrl } = require('../../core/http.js');
const local = require('./local.js');

const SERVICE = 'Jira';
const READABLE = ['.docx', '.pdf', '.md', '.markdown', '.txt', '.html', '.htm'];
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function conn(ctx) {
  const c = { ...((ctx.task && ctx.task.tool === 'jira') ? ctx.task : {}), ...(ctx.config || {}) };
  const e = ctx.env || {};
  const base = atlassianUrl(c.baseUrl, 'jira');
  if (!base) throw new Error('Jira: the Jira site URL is not configured.');
  const cloud = String(c.deployment || 'cloud').toLowerCase() !== 'server';
  let auth;
  if (cloud) {
    if (!e.JIRA_EMAIL || !e.JIRA_API_TOKEN) throw new Error('Jira: JIRA_EMAIL / JIRA_API_TOKEN are missing from .env.');
    auth = basicAuth(e.JIRA_EMAIL, e.JIRA_API_TOKEN);
  } else {
    if (!e.JIRA_PAT) throw new Error('Jira: JIRA_PAT is missing from .env.');
    auth = bearer(e.JIRA_PAT);
  }
  const list = (v, d) => String(Array.isArray(v) ? v.join(',') : (v ?? d)).split(',').map((s) => s.trim()).filter(Boolean);
  const types = list(c.issueTypes, 'Epic, Requirement, SRS').map((s) => s.toLowerCase());
  const projects = list(c.requirementProjects, '').map((s) => s.toUpperCase());
  return { base, api: `${base}/rest/api/${cloud ? 3 : 2}`, cloud, auth, types, projects };
}
const projectOf = (key) => String(key || '').split('-')[0].toUpperCase();
/** Is this issue a requirement? Its type is a requirement type, or it lives in an SRS project. */
// A project key typed into "issue types" by mistake (e.g. "SRS") still works as a project.
const isRequirement = (c, key, type) => (type && c.types.includes(String(type).toLowerCase())) || c.projects.includes(projectOf(key)) || c.types.includes(projectOf(key).toLowerCase());

/** JQL search (Cloud: /search/jql, Data Center: /search). */
async function jql(c, query, max = 10) {
  const q = `jql=${encodeURIComponent(query)}&maxResults=${max}&fields=issuetype`;
  const r = await call(c, c.cloud ? `/search/jql?${q}` : `/search?${q}`);
  return r.issues || [];
}
const call = (c, p, opts = {}) => request({ ...opts, url: c.api + p, service: SERVICE, headers: { Authorization: c.auth, ...(opts.headers || {}) } });

/** Atlassian Document Format -> markdown-like text that keeps headings and lists. */
function adf(node, depth = 0) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const kids = (node.content || []).map((n) => adf(n, depth + 1)).join('');
  switch (node.type) {
    case 'text': return node.text || '';
    case 'hardBreak': return '\n';
    case 'heading': return `\n${'#'.repeat(Math.min((node.attrs && node.attrs.level) || 2, 4))} ${kids.trim()}\n`;
    case 'paragraph': return `${kids}\n`;
    case 'listItem': return `• ${kids.trim()}\n`;
    case 'bulletList': case 'orderedList': return `${kids}\n`;
    case 'tableRow': return `${(node.content || []).map((cell) => adf(cell).replace(/\n+/g, ' ').trim()).join(' | ')}\n`;
    case 'codeBlock': return `\n${kids}\n`;
    case 'mention': return (node.attrs && node.attrs.text) || '';
    case 'inlineCard': case 'blockCard': return (node.attrs && node.attrs.url) || '';
    default: return kids;
  }
}

/** Jira wiki markup (Data Center) -> the same markdown-like form. */
const wiki = (s) => String(s || '').replace(/^h([1-6])\.\s*(.+)$/gm, (_, n, t) => `${'#'.repeat(Math.min(Number(n), 4))} ${t}`).replace(/^\s*[*#]+\s+/gm, '• ').replace(/\{\{([^}]+)\}\}/g, '$1');

function sections(text, title) {
  const out = [];
  let cur = { heading: title, lines: [] };
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s{0,3}#{1,4}\s+(.*)$/);
    if (m) { out.push(cur); cur = { heading: m[1].trim(), lines: [] }; } else cur.lines.push(line);
  }
  out.push(cur);
  return out.map((s) => ({ heading: s.heading, text: s.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() })).filter((s) => s.text);
}

function keyOf(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/i) || s.match(/[?&]selectedIssue=([A-Z][A-Z0-9_]+-\d+)/i) || s.match(/^([A-Z][A-Z0-9_]+-\d+)$/i);
  if (!m) throw new Error(`Jira: "${s}" is not an issue link or key. Copy the issue address (…/browse/KEY-123) or type the key.`);
  return m[1].toUpperCase();
}

/** An issue link on a Jira site, or a bare issue key. */
function matches(ctx, input) {
  const s = String(input || '').trim();
  if (/^[A-Z][A-Z0-9_]+-\d+$/.test(s)) return true;
  if (!/\/browse\/[A-Z][A-Z0-9_]+-\d+|[?&]selectedIssue=/i.test(s)) return false;
  const base = String(((ctx.config || {}).baseUrl) || ((ctx.task || {}).baseUrl) || '');
  try { return !base || new URL(s).host === new URL(base).host || /atlassian\.net$/.test(new URL(s).host); } catch { return false; }
}

async function testConnection(ctx) {
  let c;
  let me;
  try {
    c = conn(ctx);
    me = await call(c, '/myself'); // step 1: site + login
  } catch (e) {
    const fix = e.status === 401
      ? (c && !c.cloud ? 'Create a new Personal Access Token in Jira and paste it into .env.' : 'Check the email is your Atlassian login, and that the token was made with "Create API token" (not "with scopes") and copied whole. Then test again.')
      : e.status === 404 ? 'The site address looks wrong - copy the part up to .atlassian.net from your browser.'
        : 'Check the Jira site URL and the Jira token in .env (the same login as the Jira task tool).';
    return { ok: false, message: e.message, fix };
  }
  const who = me.displayName || me.name || 'you';
  const problems = [];
  // step 2: SRS projects are visible
  for (const p of c.projects) { try { await call(c, `/project/${encodeURIComponent(p)}`); } catch { problems.push(`SRS project "${p}" is not visible to this account (check the key or ask for "Browse projects")`); } }
  // step 3: each "issue type" really is an issue type - and spot project keys typed there by mistake
  try {
    const all = await call(c, '/issuetype');
    const names = new Set((Array.isArray(all) ? all : []).map((t) => String(t.name).toLowerCase()));
    for (const t of c.types.filter((x) => !names.has(x))) {
      let isProject = false;
      try { await call(c, `/project/${encodeURIComponent(t.toUpperCase())}`); isProject = true; } catch { /* not a project */ }
      problems.push(isProject
        ? `"${t.toUpperCase()}" is a project key, not an issue type - move it to "SRS project key(s)" (it is treated as a project meanwhile)`
        : `issue type "${t}" does not exist in this Jira - check the spelling (Jira → Settings → Issues → Issue types)`);
    }
  } catch { /* issue type list not available to this account - skip the check */ }
  if (problems.length) return { ok: false, message: `Signed in to Jira as ${who}, but: ${problems.join('; ')}.`, fix: 'Fix the fields above and test again.' };
  return { ok: true, message: `Connected to Jira as ${who}. Requirements = issue types ${c.types.join(', ')}${c.projects.length ? ` + everything in project(s) ${c.projects.join(', ')}` : ''}.` };
}

async function downloadAttachment(c, att, dir) {
  const ext = path.extname(att.filename || '').toLowerCase();
  if (!READABLE.includes(ext) || Number(att.size || 0) > MAX_ATTACHMENT_BYTES) return null;
  const res = await fetch(att.content, { headers: { Authorization: c.auth, Accept: '*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(att.filename).replace(/[\\/:*?"<>|]+/g, '_'));
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

async function fetchDocument(ctx, input) {
  const c = conn(ctx);
  const key = keyOf(input);
  const issue = await call(c, `/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype,status,components,labels,fixVersions,attachment,parent`);
  const F = issue.fields || {};
  const title = `${key} ${F.summary || ''}`.trim();
  const body = c.cloud ? adf(F.description) : wiki(F.description);
  const secs = sections(body, F.summary || key);
  const facts = [
    F.issuetype && `Type: ${F.issuetype.name}`, F.status && `Status: ${F.status.name}`,
    (F.components || []).length && `Components: ${F.components.map((x) => x.name).join(', ')}`,
    (F.labels || []).length && `Labels: ${F.labels.join(', ')}`,
    (F.fixVersions || []).length && `Fix versions: ${F.fixVersions.map((x) => x.name).join(', ')}`,
    F.parent && `Parent: ${F.parent.key} ${(F.parent.fields && F.parent.fields.summary) || ''}`.trim(),
  ].filter(Boolean);
  if (facts.length) secs.unshift({ heading: 'Issue details', text: facts.join('\n') });

  const attachments = [];
  const dir = path.join(ctx.root || process.cwd(), 'output', 'temp', 'jira-attachments', key);
  for (const att of F.attachment || []) {
    try {
      const file = await downloadAttachment(c, att, dir);
      if (!file) { attachments.push({ name: att.filename, skipped: 'not a readable document type (Word, PDF, text) or too large' }); continue; }
      const doc = await local.fetchDocument({ root: ctx.root }, file);
      attachments.push({ name: att.filename, path: file, needsDirectRead: !!doc.needsDirectRead });
      if (doc.needsDirectRead) secs.push({ heading: `Attachment: ${att.filename}`, text: `PDF saved at ${file} - open it with your file reader.` });
      else (doc.sections || []).forEach((s) => secs.push({ heading: `Attachment ${att.filename} › ${s.heading}`, text: s.text }));
    } catch (e) { attachments.push({ name: att.filename, error: e.message }); }
  }
  const text = [body.trim(), ...secs.filter((s) => s.heading.startsWith('Attachment')).map((s) => `## ${s.heading}\n${s.text}`)].filter(Boolean).join('\n\n');
  return { title, url: `${c.base}/browse/${key}`, text, sections: secs, attachments, needsDirectRead: attachments.some((a) => a.needsDirectRead) };
}

/**
 * Requirement issues for a ticket, from any project on this Jira site:
 * parent + linked issues (same Jira), Jira links in the text, and - when SRS projects are set -
 * issues in those projects that mention the ticket key. Kept if isRequirement().
 */
async function discover(ctx, workItem, texts = []) {
  const c = conn(ctx);
  const found = new Map(); // key -> type
  const ticket = String((workItem && workItem.id) || '');
  const consider = (k, type) => { if (k && k !== ticket && isRequirement(c, k, type)) found.set(k, type || ''); };
  const isKey = /^[A-Z][A-Z0-9_]+-\d+$/.test(ticket);
  const sameJira = ctx.task && ctx.task.tool === 'jira' && isKey;
  if (sameJira) {
    try {
      const it = await call(c, `/issue/${encodeURIComponent(workItem.id)}?fields=parent,issuelinks`);
      const F = it.fields || {};
      if (F.parent) consider(F.parent.key, F.parent.fields && F.parent.fields.issuetype && F.parent.fields.issuetype.name);
      for (const l of F.issuelinks || []) { const o = l.outwardIssue || l.inwardIssue; if (o) consider(o.key, o.fields && o.fields.issuetype && o.fields.issuetype.name); }
    } catch { /* discovery is best effort */ }
  }
  const keys = new Set();
  for (const t of texts) for (const m of String(t || '').matchAll(/https?:\/\/[^\s"'<>)]+\/browse\/([A-Z][A-Z0-9_]+-\d+)/gi)) if (matches(ctx, m[0])) keys.add(m[1].toUpperCase());
  for (const k of [...keys].filter((x) => !found.has(x) && x !== ticket).slice(0, 10)) {
    if (c.projects.includes(projectOf(k))) { consider(k, null); continue; } // SRS project: no need to look up the type
    try { const it = await call(c, `/issue/${encodeURIComponent(k)}?fields=issuetype`); consider(k, it.fields && it.fields.issuetype && it.fields.issuetype.name); } catch { /* skip */ }
  }
  // SRS kept in separate project(s) but not linked: find issues there that mention the ticket key.
  if (c.projects.length && isKey) {
    try {
      const q = `project in (${c.projects.map((p) => `"${p}"`).join(',')}) AND text ~ "\\"${ticket}\\"" ORDER BY updated DESC`;
      for (const it of await jql(c, q, 10)) consider(it.key, it.fields && it.fields.issuetype && it.fields.issuetype.name);
    } catch { /* search is best effort */ }
  }
  return [...found.keys()].map((k) => `${c.base}/browse/${k}`);
}

module.exports = {
  id: 'jira',
  label: 'Jira (requirement issues)',
  secrets: [
    { env: 'JIRA_EMAIL', label: 'Jira login email (Cloud only)', help: 'Jira Cloud only: the email you sign in to Atlassian with. The same as the Jira task tool, if you use it.' },
    { env: 'JIRA_API_TOKEN', label: 'Jira API token (Cloud only)', help: 'Jira Cloud only: id.atlassian.com → Security → Create and manage API tokens → Create API token. Your account needs "Browse projects" on the projects that hold the requirement issues.' },
    { env: 'JIRA_PAT', label: 'Jira Personal Access Token (Data Center / Server only)', help: 'Data Center / Server only: avatar → Profile → Personal Access Tokens → Create token. Read access to the requirement projects is enough.' },
  ],
  fields: [
    { key: 'baseUrl', label: 'Jira site URL', placeholder: 'https://your-company.atlassian.net', help: 'The address of your Jira site, without anything after the domain.', required: true },
    { key: 'deployment', label: 'Jira type', placeholder: 'cloud', help: 'Cloud for *.atlassian.net, Server for Data Center / self-hosted.', required: true },
    { key: 'issueTypes', label: 'Requirement issue types', placeholder: 'Epic, Requirement, SRS', help: 'The issue types that hold your SRS / BRD, comma-separated, exactly as named in Jira. A ticket\'s parent and linked issues of these types are read automatically.', required: true, default: 'Epic, Requirement, SRS' },
    { key: 'requirementProjects', label: 'SRS project key(s) (optional)', placeholder: 'SRS, SPEC', help: 'If the SRS lives in its own Jira project(s), enter their keys. Every issue there counts as a requirement (whatever its type), and Agent 1 also searches them for issues that mention the story\'s key - even when nothing is linked.', required: false },
  ],
  testConnection, matches, fetchDocument, discover,
  _internal: { adf, wiki, sections, keyOf },
};
