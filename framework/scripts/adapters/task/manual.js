/**
 * "Other tool" task adapter - for trackers without a connector (ServiceNow, Rally, Asana,
 * ClickUp, Monday.com, Trello, YouTrack, Wrike, spreadsheets…). Tickets live as files in a
 * folder (default: requirements/), one per ticket, exported or pasted by the QA:
 *
 *   requirements/REQ-12.md          ← front matter + "## Description" / "## Acceptance Criteria"
 *   requirements/REQ-12.docx        ← or a Word export of the ticket (read as description)
 *   requirements/REQ-12.comments.md ← agent audit comments are appended here
 *   requirements/_tasks.md          ← automation tracking tasks are appended here
 *
 * Front matter keys: id, type, title, state, release, tags, assignee, qaAssignee,
 * createdBy, storyPoints, parent, url.  See requirements/_TEMPLATE.md (written on first use).
 * Bug keys (optional): severity, priority, environment, foundIn, component, related,
 * created, changed, closed (ISO dates).
 * createBug writes requirements/BUG-<timestamp>.md; attachFile copies into requirements/attachments/<id>/.
 */

const fs = require('fs');
const path = require('path');
const local = require('../docs/local.js');
const B = require('./_bug.js');

const TEMPLATE = `---
id: REQ-12
type: Story
title: Customer can apply a discount code at checkout
state: Active
release: Release 12
tags: Checkout, Payments
assignee: Dev Name
qaAssignee:
createdBy: Product Owner Name
storyPoints: 5
parent:
url: https://your-tool/link-to-the-ticket
---

## Description
Paste the ticket description here.

## Acceptance Criteria
- Paste each acceptance criterion on its own line.
`;

function dir(ctx) {
  const d = path.resolve(ctx.root || process.cwd(), (ctx.config || {}).folder || 'requirements');
  fs.mkdirSync(d, { recursive: true });
  const t = path.join(d, '_TEMPLATE.md');
  if (!fs.existsSync(t)) fs.writeFileSync(t, TEMPLATE);
  return d;
}

function parseFrontMatter(raw) {
  const m = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) { const kv = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*)$/); if (kv) meta[kv[1]] = kv[2].trim(); }
  return { meta, body: m[2] };
}

function section(body, name) {
  const re = new RegExp(`^#{1,4}\\s*${name}\\s*$([\\s\\S]*?)(?=^#{1,4}\\s|$(?![\\s\\S]))`, 'im');
  const m = body.match(re);
  return m ? m[1].trim() : '';
}

const isTicketFile = (f) => !f.startsWith('_') && !f.endsWith('.comments.md') && !/^readme\.md$/i.test(f);
const person = (v) => (v ? { name: v, id: v } : null);
const stat = (f) => { try { return fs.statSync(f); } catch { return null; } };
const oneLine = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();

async function load(ctx, id) {
  const d = dir(ctx);
  const md = path.join(d, `${id}.md`);
  const docx = path.join(d, `${id}.docx`);
  if (fs.existsSync(md)) {
    const { meta, body } = parseFrontMatter(fs.readFileSync(md, 'utf8'));
    const desc = section(body, 'Description') || body.replace(/^#{1,4}\s*Acceptance Criteria[\s\S]*$/im, '').trim();
    const st = stat(md);
    const bugField = (k) => meta[k] || B.readFromDescription(body, k) || null;
    return {
      id: String(meta.id || id), type: meta.type || 'Story', title: meta.title || id, state: meta.state || '',
      description: desc, acceptanceCriteria: section(body, 'Acceptance Criteria'),
      tags: String(meta.tags || '').split(/[;,]/).map((t) => t.trim()).filter(Boolean),
      component: meta.component || '', release: meta.release || '', assignee: person(meta.assignee), qaAssignee: person(meta.qaAssignee),
      createdBy: person(meta.createdBy), storyPoints: meta.storyPoints ? Number(meta.storyPoints) : null,
      parentId: meta.parent || null, url: meta.url || md, links: meta.related ? [{ rel: 'related', id: meta.related }] : [], file: md,
      severity: bugField('severity'), priority: bugField('priority'), environment: bugField('environment'),
      createdDate: B.iso(meta.created) || (st ? B.iso(st.birthtime) : null), changedDate: B.iso(meta.changed) || (st ? B.iso(st.mtime) : null),
      closedDate: B.iso(meta.closed),
    };
  }
  if (fs.existsSync(docx)) {
    const doc = await local.fetchDocument(ctx, docx);
    const ac = (doc.sections || []).find((s) => /acceptance criteria/i.test(s.heading));
    const st = stat(docx);
    return { id: String(id), type: 'Story', title: doc.title, state: '', description: doc.text, acceptanceCriteria: ac ? ac.text : '', tags: [], component: '', release: '', assignee: null, qaAssignee: null, createdBy: null, storyPoints: null, parentId: null, url: docx, links: [], file: docx,
      severity: null, priority: null, environment: null, createdDate: st ? B.iso(st.birthtime) : null, changedDate: st ? B.iso(st.mtime) : null, closedDate: null };
  }
  throw new Error(`No ticket file for "${id}". Save it as ${path.join(d, `${id}.md`)} (copy _TEMPLATE.md in that folder) or ${id}.docx.`);
}

async function testConnection(ctx) {
  try {
    const d = dir(ctx);
    const n = fs.readdirSync(d).filter((f) => /\.(md|docx)$/i.test(f) && isTicketFile(f)).length;
    return { ok: true, message: `Ticket folder ready: ${d} (${n} ticket file${n === 1 ? '' : 's'}). A template is in _TEMPLATE.md.` };
  } catch (e) {
    return { ok: false, message: e.message, fix: 'Choose a folder you can write to.' };
  }
}

async function getWorkItem(ctx, id) { return load(ctx, id); }

async function getChildren(ctx, id) {
  const d = dir(ctx);
  const out = [];
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.md') && isTicketFile(x))) {
    const { meta } = parseFrontMatter(fs.readFileSync(path.join(d, f), 'utf8'));
    if (String(meta.parent || '') === String(id)) out.push(await load(ctx, f.replace(/\.md$/, '')));
  }
  return out;
}

async function getComments(ctx, id) {
  const f = path.join(dir(ctx), `${id}.comments.md`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/^---\s*$/m).map((b) => b.trim()).filter(Boolean).map((b, i) => {
    const h = b.match(/^\*\*(.+?)\*\* · (\S+)\s*\n([\s\S]*)$/);
    return { id: String(i + 1), author: { name: h ? h[1] : 'unknown' }, date: h ? h[2] : '', text: h ? h[3].trim() : b };
  });
}

async function addComment(ctx, id, text) {
  const f = path.join(dir(ctx), `${id}.comments.md`);
  fs.appendFileSync(f, `${fs.existsSync(f) ? '\n---\n' : ''}**QA Agent** · ${new Date().toISOString()}\n${text}\n`);
  return { id: String(Date.now()), url: f };
}

async function createTask(ctx, { parentId, title, description, assignee }) {
  const f = path.join(dir(ctx), '_tasks.md');
  const id = `TASK-${Date.now()}`;
  fs.appendFileSync(f, `\n## ${id} - ${title}\n- Parent: ${parentId}\n- Assignee: ${assignee ? `${assignee.name} (${assignee.id})` : '-'}\n- Created: ${new Date().toISOString()}\n\n${description || ''}\n`);
  return { id, url: f };
}

const releaseName = (ctx, release) => String((((ctx.config || {}).fields || {}).release || {}).pattern || 'Release {release}').replace('{release}', release).toLowerCase();

async function listReleaseItems(ctx, release) {
  const d = dir(ctx);
  const pattern = releaseName(ctx, release);
  const exTypes = (ctx.config.excludedTypes || []).map((t) => t.toLowerCase());
  const exStates = (ctx.config.excludedStates || []).map((t) => t.toLowerCase());
  const items = [];
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.md') && isTicketFile(x))) {
    const wi = await load(ctx, f.replace(/\.md$/, ''));
    if (String(wi.release).toLowerCase() === pattern && !exTypes.includes(String(wi.type).toLowerCase()) && !exStates.includes(String(wi.state).toLowerCase())) items.push(wi);
  }
  return items;
}

async function setQaAssignee(ctx, id, p) {
  const f = path.join(dir(ctx), `${id}.md`);
  if (!fs.existsSync(f)) throw new Error(`Other tool: ${id} is not a .md ticket file - cannot store the QA owner.`);
  let raw = fs.readFileSync(f, 'utf8');
  raw = /^qaAssignee:.*$/m.test(raw) ? raw.replace(/^qaAssignee:.*$/m, `qaAssignee: ${p.name}`) : raw.replace(/^---\r?\n/, `---\nqaAssignee: ${p.name}\n`);
  fs.writeFileSync(f, raw);
  return { ok: true };
}

async function searchItems(ctx, query = {}) {
  const q = query || {};
  const max = Number(q.max) > 0 ? Number(q.max) : 500;
  const d = dir(ctx);
  const types = (q.types || []).map((t) => String(t).toLowerCase());
  const rel = q.release ? releaseName(ctx, q.release) : null;
  const items = [];
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.md') && isTicketFile(x))) {
    const wi = await load(ctx, f.replace(/\.md$/, ''));
    if (types.length && !types.includes(String(wi.type).toLowerCase())) continue;
    if (rel && String(wi.release).toLowerCase() !== rel) continue;
    items.push(wi);
  }
  return B.postFilter(items, q).sort((a, b) => String(b.createdDate || '').localeCompare(String(a.createdDate || ''))).slice(0, max);
}

async function createBug(ctx, bug = {}) {
  const d = dir(ctx);
  const f = bug.fields || {};
  // Values always go to front matter; "label:" forms also add a tag and
  // "description" forms also add a "**Severity:** High" line to the body.
  const fm = { severity: 'frontmatter', priority: 'frontmatter', environment: 'frontmatter', foundIn: 'frontmatter' };
  const plan = B.planBugFields(ctx, bug, fm, ['ref', 'priority', 'label'], 'Other tool');
  // Headings inside the body would end the "## Description" section when the file is read back.
  const desc = String(bug.description || '').replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/gm, '**$1**');
  let n = Date.now();
  while (fs.existsSync(path.join(d, `BUG-${n}.md`))) n += 1;
  const id = `BUG-${n}`;
  const link = bug.linkTo && bug.linkTo.id ? bug.linkTo : null;
  const tags = [...new Set([...(bug.tags || []), ...plan.labels].map(oneLine).filter(Boolean))];
  const meta = {
    id, type: bug.type || 'Bug', title: bug.title || '(untitled bug)', state: 'New',
    severity: f.severity, priority: f.priority, environment: f.environment, foundIn: f.foundIn, component: f.component,
    tags: tags.join(', '), assignee: f.assignee ? f.assignee.id || f.assignee.name : '',
    parent: link && link.rel === 'parent' ? link.id : '', related: link && link.rel !== 'parent' ? link.id : '',
    created: new Date().toISOString(),
  };
  const lines = [...plan.descLines];
  if (link && link.rel !== 'parent') lines.push(`Related: ${link.id}${link.rel === 'tested-by' ? ' (tested by)' : ''}`);
  const front = Object.entries(meta).filter(([, v]) => oneLine(v) !== '').map(([k, v]) => `${k}: ${oneLine(v)}`).join('\n');
  const file = path.join(d, `${id}.md`);
  fs.writeFileSync(file, `---\n${front}\n---\n\n## Description\n${B.composeDescription(desc, lines)}\n`);
  return { id, url: file, warnings: plan.warnings };
}

async function attachFile(ctx, id, filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Cannot attach "${filePath}": the file does not exist.`);
  const target = path.join(dir(ctx), 'attachments', String(id));
  fs.mkdirSync(target, { recursive: true });
  const dest = path.join(target, path.basename(filePath));
  fs.copyFileSync(filePath, dest);
  return { ok: true, url: dest };
}

module.exports = {
  id: 'manual',
  label: 'Other tool (exported ticket files)',
  secrets: [],
  fields: [{ key: 'folder', label: 'Ticket files folder', placeholder: 'requirements', help: 'Folder inside the installation where QAs save each ticket as <ID>.md (template provided) or <ID>.docx.', required: false }],
  testConnection, getWorkItem, getChildren, getComments, addComment, createTask, listReleaseItems, setQaAssignee,
  searchItems, createBug, attachFile,
};
