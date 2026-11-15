/**
 * Figma design adapter (REST API v1, read-only).
 *
 * fetchDesign(ctx, url) parses the file key and optional node-id from
 * figma.com/file|design|proto/<key>/…?node-id=1-2 and returns the frames/components with the
 * visible text inside them:
 *   { fileKey, nodeId, name, frames: [{ id, name, page, texts: [...] }] }
 * With a node-id only that node is fetched (/v1/files/<key>/nodes?ids=); otherwise the file
 * is fetched with depth=3 (pages → top-level frames → their direct children). Capped at 200 frames.
 */

const { request } = require('../../core/http.js');

const SERVICE = 'Figma';
const MAX_FRAMES = 200;
const MAX_TEXTS = 150;
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET']);

function api(ctx, path) {
  const tok = (ctx.env || {}).FIGMA_ACCESS_TOKEN;
  if (!tok) throw new Error('Figma: FIGMA_ACCESS_TOKEN is missing from .env.');
  return request({ url: `https://api.figma.com/v1/${path}`, service: SERVICE, headers: { 'X-Figma-Token': tok }, timeoutMs: 60000 });
}

function parseUrl(url) {
  const s = String(url || '').trim();
  const m = s.match(/figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/) || s.match(/^([A-Za-z0-9]{10,})$/);
  if (!m) throw new Error(`Figma: "${s}" is not a Figma file link. In Figma use Share → Copy link.`);
  const n = s.match(/[?&]node-id=([^&#]+)/);
  return { fileKey: m[1], nodeId: n ? decodeURIComponent(n[1]).replace(/-/g, ':') : null };
}

function textsUnder(node, out) {
  if (out.length >= MAX_TEXTS || !node || node.visible === false) return out;
  if (node.type === 'TEXT' && node.characters && node.characters.trim()) {
    const t = node.characters.trim();
    if (!out.includes(t)) out.push(t);
  }
  for (const c of node.children || []) textsUnder(c, out);
  return out;
}

/** Collect outermost frames/components (nested frames' text is included in their parent). */
function collect(node, page, frames) {
  if (!node || frames.length >= MAX_FRAMES || node.visible === false) return;
  if (node.type === 'CANVAS') page = node.name;
  if (FRAME_TYPES.has(node.type)) {
    frames.push({ id: node.id, name: node.name, page: page || '', texts: textsUnder(node, []) });
    return;
  }
  for (const c of node.children || []) collect(c, page, frames);
}

async function testConnection(ctx) {
  try {
    const me = await api(ctx, 'me');
    return { ok: true, message: `Connected to Figma as ${me.email || me.handle || 'your account'}.` };
  } catch (e) {
    return { ok: false, message: e.message, fix: 'Create a new personal access token in Figma (Settings → Security → Personal access tokens) with "File content: read" scope and paste it into FIGMA_ACCESS_TOKEN.' };
  }
}

async function fetchDesign(ctx, url) {
  const { fileKey, nodeId } = parseUrl(url);
  const frames = [];
  let name = '';
  if (nodeId) {
    const r = await api(ctx, `files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`);
    name = r.name || '';
    const entry = (r.nodes || {})[nodeId];
    if (!entry || !entry.document) throw new Error(`Figma: node ${nodeId} was not found in file ${fileKey} (it may have been deleted).`);
    const doc = entry.document;
    collect(doc, doc.type === 'CANVAS' ? doc.name : '', frames);
    if (!frames.length) frames.push({ id: doc.id, name: doc.name, page: '', texts: textsUnder(doc, []) });
  } else {
    const r = await api(ctx, `files/${fileKey}?depth=3`);
    name = r.name || '';
    collect(r.document, '', frames);
  }
  return { fileKey, nodeId, name, frames };
}

function matches(ctx, input) {
  return /figma\.com\//i.test(String(input || ''));
}

module.exports = {
  id: 'figma',
  label: 'Figma',
  secrets: [{
    env: 'FIGMA_ACCESS_TOKEN',
    label: 'Figma personal access token',
    help: 'In Figma click your avatar → Settings → Security → Personal access tokens → Generate new token. Give it the "File content: Read only" scope (and "Current user: Read" so Test connection works). Tokens expire - set the longest expiry allowed. Your account must be able to view the design files.',
  }],
  fields: [],
  testConnection,
  matches,
  fetchDesign,
};
