#!/usr/bin/env node
/**
 * AGENT 1 - STEP 2: gather EVERYTHING about a requirement into one JSON file.
 *
 *   node scripts/agents/agent1-fetch.js <workItemId> [--brd=<url|path>]... [--design=<url|path>]...
 *
 * Three kinds of input, combined by Agent 1:
 *   1. The ticket        - description, acceptance criteria, child items, comments (task tool)
 *   2. Requirement docs  - SRS / BRD / functional spec (Confluence, ADO Wiki, Notion, Word, PDF…)
 *   3. Design artifacts  - Figma frames or exported screens (PNG/JPG/PDF from any design tool)
 *   (+ code changes linked to the ticket and its children - read-only context)
 *
 * Links to documents/designs are AUTO-DISCOVERED in the ticket, its children and comments,
 * and fetched with the matching connector. --brd / --design add more (repeatable).
 * Links no connector can read (SharePoint, Google Docs, OneDrive, Adobe XD…) are reported
 * with download instructions instead of failing.
 *
 * Writes output/temp/<id>-data.json and output/temp/<id>-figma.json (design frames, used by
 * the linter for design traceability). Exit 4 = CREDENTIALS_INVALID, 1 = other failure.
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, taskAdapter, docsAdapters, designAdapters, codeAdapter, pickFor, outDir } = require('../core/config');
const { preflight } = require('../core/preflight');
const { positional } = require('../core/util');

/** All values of a repeatable flag: --brd=a --brd b  → ['a','b'] */
function allArgs(name) {
  const argv = process.argv.slice(2);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith(`--${name}=`)) out.push(argv[i].slice(name.length + 3));
    else if (argv[i] === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[++i]);
  }
  return out.map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== 'none');
}

/** Hosts we recognise but cannot read through an API → how to hand them over instead. */
const UNREADABLE = [
  { re: /sharepoint\.com|onedrive\.live\.com|1drv\.ms|-my\.sharepoint/i, kind: 'docs', name: 'SharePoint / OneDrive', how: 'Open it → File → Save a copy / Download → Word (.docx), save it inside the installation (e.g. requirements-docs/), then give that file path.' },
  { re: /docs\.google\.com\/document|drive\.google\.com/i, kind: 'docs', name: 'Google Docs / Drive', how: 'Open it → File → Download → Microsoft Word (.docx), then give the downloaded file path.' },
  { re: /dropbox\.com|box\.com/i, kind: 'docs', name: 'Dropbox / Box', how: 'Download the file (Word or PDF) and give the file path.' },
  { re: /xd\.adobe\.com|adobe\.ly/i, kind: 'design', name: 'Adobe XD', how: 'In XD: File → Export → All Artboards → PNG into a folder, then give the folder path.' },
  { re: /zeplin\.(io|app)/i, kind: 'design', name: 'Zeplin', how: 'In Zeplin select the screens → Download as PNG into a folder, then give the folder path.' },
  { re: /miro\.com/i, kind: 'design', name: 'Miro', how: 'In Miro: ••• → Export → Save as image/PDF into a folder, then give the folder path.' },
  { re: /sketch\.(com|cloud)/i, kind: 'design', name: 'Sketch', how: 'In Sketch: File → Export → Artboards as PNG into a folder, then give the folder path.' },
  { re: /balsamiq|axure|invisionapp|framer\.com|canva\.com|penpot/i, kind: 'design', name: 'Design tool', how: 'Export the screens as PNG or PDF into a folder, then give the folder path.' },
];

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const collectLinks = (texts) => [...new Set(texts.flatMap((t) => String(t || '').match(URL_RE) || []).map((u) => u.replace(/[.,;:]+$/, '')))];

(async () => {
  const [id] = positional();
  if (!id) { console.error('Usage: node scripts/agents/agent1-fetch.js <workItemId> [--brd=<url|path>]... [--design=<url|path>]...'); process.exit(1); }
  const cfg = loadConfig();
  const docs = docsAdapters(cfg);
  const designs = designAdapters(cfg);

  const kinds = ['task'];
  if (docs.length) kinds.push('docs');
  if (designs.length) kinds.push('design');
  if (cfg.codeChanges?.tool && cfg.codeChanges.tool !== 'none') kinds.push('code');
  await preflight(cfg, kinds);

  // ── 1. Ticket ────────────────────────────────────────────────────────────
  const task = taskAdapter(cfg);
  console.log(`\n📥 Fetching ${id} from ${task.adapter.label}…`);
  const workItem = await task.adapter.getWorkItem(task.ctx, id);
  const [children, comments] = await Promise.all([
    task.adapter.getChildren(task.ctx, id).catch((e) => { console.log(`   ⚠️ children: ${e.message}`); return []; }),
    task.adapter.getComments(task.ctx, id).catch((e) => { console.log(`   ⚠️ comments: ${e.message}`); return []; }),
  ]);

  // ── 2. Code changes (parent + every child) ───────────────────────────────
  let codeChanges = [];
  const code = codeAdapter(cfg);
  if (code) {
    for (const wi of [workItem, ...children]) {
      try { (await code.adapter.findChanges(code.ctx, wi)).forEach((c) => codeChanges.push({ ...c, workItemId: wi.id })); }
      catch (e) { console.log(`   ⚠️ code changes for ${wi.id}: ${e.message}`); }
    }
    const seen = new Set();
    codeChanges = codeChanges.filter((c) => { const k = `${c.kind}:${c.repo}:${c.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // ── 3. Discover document / design links in the ticket ────────────────────
  const discovered = collectLinks([
    workItem.description, workItem.acceptanceCriteria, ...(workItem.links || []).map((l) => l.url),
    ...children.flatMap((c) => [c.description, c.acceptanceCriteria]), ...comments.map((c) => c.text),
  ]);
  const docInputs = [...allArgs('brd')];
  const designInputs = [...allArgs('design')];
  const unreadable = [];
  const ignoredHosts = /dev\.azure\.com\/[^/]+\/[^/]+\/_(workitems|git|build|release)|\/browse\/[A-Z]+-\d+|github\.com\/[^/]+\/[^/]+\/(pull|issues|commit)/i;
  for (const u of discovered) {
    if (ignoredHosts.test(u) || u === workItem.url) continue;
    if (pickFor(designs, u)) { if (!designInputs.includes(u)) designInputs.push(u); continue; }
    if (pickFor(docs, u)) { if (!docInputs.includes(u)) docInputs.push(u); continue; }
    const known = UNREADABLE.find((x) => x.re.test(u));
    if (known) unreadable.push({ url: u, source: known.name, kind: known.kind, howToProvide: known.how, foundIn: 'ticket' });
  }

  // ── 4. Requirement documents ─────────────────────────────────────────────
  const requirementDocs = [];
  for (const input of docInputs) {
    const known = UNREADABLE.find((x) => x.re.test(input));
    const pair = pickFor(docs, input) || (!/^https?:/i.test(input) ? { adapter: require('../adapters/docs/local'), ctx: { config: {}, env: process.env, root: cfg.root } } : null);
    if (!pair) {
      unreadable.push({ url: input, source: known?.name || 'Unknown site', kind: 'docs', howToProvide: known?.how || 'Download it as Word (.docx) or PDF and give the file path.', foundIn: 'argument' });
      continue;
    }
    try {
      const d = await pair.adapter.fetchDocument(pair.ctx, input);
      requirementDocs.push({ input, source: pair.adapter.id, discovered: !allArgs('brd').includes(input), ...d });
      console.log(`   📄 Requirement doc (${pair.adapter.label}): ${d.title}${d.needsDirectRead ? ' - PDF, open it directly' : ` (${d.sections?.length || 0} sections)`}`);
    } catch (e) { console.log(`   ⚠️ Requirement doc not loaded (${input}): ${e.message}`); requirementDocs.push({ input, source: pair.adapter.id, error: e.message }); }
  }

  // ── 5. Design artifacts ──────────────────────────────────────────────────
  const dir = outDir('temp');
  const designResults = [];
  const frames = [];
  for (const input of designInputs) {
    const known = UNREADABLE.find((x) => x.re.test(input));
    const pair = pickFor(designs, input) || (!/^https?:/i.test(input) ? { adapter: require('../adapters/design/files'), ctx: { config: {}, env: process.env, root: cfg.root } } : null);
    if (!pair) { unreadable.push({ url: input, source: known?.name || 'Unknown site', kind: 'design', howToProvide: known?.how || 'Export the screens as PNG/PDF into a folder and give the folder path.', foundIn: 'argument' }); continue; }
    try {
      const d = await pair.adapter.fetchDesign(pair.ctx, input);
      designResults.push({ input, source: pair.adapter.id, name: d.name, frameCount: d.frames.length, needsDirectRead: !!d.needsDirectRead });
      d.frames.forEach((f) => frames.push({ ...f, source: pair.adapter.id }));
      console.log(`   🎨 Design (${pair.adapter.label}): ${d.name} - ${d.frames.length} screen(s)${d.needsDirectRead ? ', open each image directly' : ''}`);
    } catch (e) { console.log(`   ⚠️ Design not loaded (${input}): ${e.message}`); designResults.push({ input, source: pair.adapter.id, error: e.message }); }
  }
  fs.writeFileSync(path.join(dir, `${id}-figma.json`), JSON.stringify({ found: frames.length > 0, sources: designResults, frames }, null, 2));

  const data = {
    fetchedAt: new Date().toISOString(),
    tool: task.adapter.id,
    workItem, children, comments, codeChanges,
    requirementDocs,
    design: designResults,
    unreadableLinks: unreadable,
    configuredSources: { docs: docs.map((p) => p.adapter.id), design: designs.map((p) => p.adapter.id) },
    automation: { status: cfg.automation?.status || 'none', bdd: !!cfg.automation?.bdd },
  };
  const file = path.join(dir, `${id}-data.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

  const acCount = (workItem.acceptanceCriteria || '').split(/\n/).filter((l) => l.trim()).length;
  const okDocs = requirementDocs.filter((d) => !d.error);
  console.log('\n✅ Fetch complete');
  console.log(`   Ticket:            ${workItem.type} ${workItem.id} - ${workItem.title}`);
  console.log(`   AC lines:          ${acCount}${acCount ? '' : '  ⚠️ none on the ticket - derive from description/requirement docs and add a clarification question'}`);
  console.log(`   Children/comments: ${children.length} / ${comments.length}`);
  console.log(`   Code changes:      ${codeChanges.length}`);
  console.log(`   Requirement docs:  ${okDocs.length}${okDocs.some((d) => d.discovered) ? ' (some auto-found in the ticket)' : ''}`);
  console.log(`   Design screens:    ${frames.length}`);
  // Links found in the ticket that can't be read are covered once the user supplied a file of that kind.
  const gaveDoc = requirementDocs.some((d) => !d.error && !d.discovered);
  const gaveDesign = designResults.some((d) => !d.error && allArgs('design').includes(d.input));
  const covered = (u) => u.foundIn === 'ticket' && ((u.kind === 'docs' && gaveDoc) || (u.kind === 'design' && gaveDesign));
  const pending = unreadable.filter((u) => !covered(u));
  data.unreadableLinks = unreadable.map((u) => ({ ...u, coveredByProvidedFile: covered(u) }));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  if (unreadable.length > pending.length) console.log(`   Linked in ticket:  ${unreadable.length - pending.length} link(s) assumed covered by the file(s) you provided`);
  if (pending.length) {
    console.log(`\nNEEDS_FILES - ${pending.length} link(s) in the ticket can't be read directly. Ask the user to provide them as files:`);
    pending.forEach((u) => console.log(`   • ${u.source}: ${u.url}\n     → ${u.howToProvide}`));
  }
  if (!okDocs.length && docs.length) console.log('\nNO_REQUIREMENT_DOC - none found in the ticket. Ask the user once for the SRS/BRD link or file (or "none").');
  if (!frames.length && designs.length) console.log('NO_DESIGN - none found in the ticket. Ask the user once for the design link or exported screens folder (or "none").');
  console.log(`\n   Data file: ${path.relative(cfg.root, file)}`);
})().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
