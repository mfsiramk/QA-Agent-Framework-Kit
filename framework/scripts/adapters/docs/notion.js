/**
 * Notion docs adapter (REST API, Notion-Version 2022-06-28).
 *
 * fetchDocument accepts a page URL (notion.so/…-<32 hex>) or page id, reads the page's
 * blocks recursively (paginated, nesting depth ≤ 3) and returns plain text with
 * heading_1/2/3 blocks starting new sections.
 */

const { request, bearer } = require('../../core/http.js');

const SERVICE = 'Notion';
const MAX_DEPTH = 3;

function api(ctx, path) {
  const tok = (ctx.env || {}).NOTION_TOKEN;
  if (!tok) throw new Error('Notion: NOTION_TOKEN is missing from .env.');
  return request({ url: `https://api.notion.com/v1/${path}`, service: SERVICE, headers: { Authorization: bearer(tok), 'Notion-Version': '2022-06-28' } });
}

function pageId(input) {
  const s = String(input || '').trim().split(/[?#]/)[0].replace(/-/g, '');
  const m = s.match(/([0-9a-f]{32})$/i);
  if (!m) throw new Error(`Notion: "${input}" is not a Notion page URL or id. Open the page and use Share → Copy link.`);
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const rich = (arr) => (arr || []).map((t) => t.plain_text || '').join('');

async function children(ctx, id) {
  const out = [];
  let cursor = '';
  for (let i = 0; i < 50; i++) {
    const r = await api(ctx, `blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    out.push(...(r.results || []));
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  return out;
}

function blockText(b) {
  const v = b[b.type] || {};
  switch (b.type) {
    case 'bulleted_list_item': return `• ${rich(v.rich_text)}`;
    case 'numbered_list_item': return `- ${rich(v.rich_text)}`;
    case 'to_do': return `[${v.checked ? 'x' : ' '}] ${rich(v.rich_text)}`;
    case 'table_row': return (v.cells || []).map(rich).join(' | ');
    case 'child_page': return `(sub-page: ${v.title || ''})`;
    case 'child_database': return `(database: ${v.title || ''})`;
    case 'equation': return v.expression || '';
    default: return rich(v.rich_text || v.caption);
  }
}

async function walk(ctx, id, depth, sink) {
  for (const b of await children(ctx, id)) {
    if (/^heading_[123]$/.test(b.type)) {
      sink.heading(rich(b[b.type].rich_text));
    } else {
      const t = blockText(b);
      if (t) sink.line('  '.repeat(depth) + t);
    }
    if (b.has_children && depth + 1 < MAX_DEPTH && !['child_page', 'child_database'].includes(b.type)) {
      await walk(ctx, b.id, depth + 1, sink);
    }
  }
}

async function testConnection(ctx) {
  try {
    const me = await api(ctx, 'users/me');
    return { ok: true, message: `Connected to Notion as integration "${me.name || me.id}".` };
  } catch (e) {
    return { ok: false, message: e.message, fix: 'Create an internal integration at notion.so/my-integrations, copy its secret into NOTION_TOKEN, and share the requirement pages with it (page ••• → Connections).' };
  }
}

async function fetchDocument(ctx, urlOrId) {
  const id = pageId(urlOrId);
  const page = await api(ctx, `pages/${id}`);
  const titleProp = Object.values(page.properties || {}).find((p) => p.type === 'title');
  const title = titleProp ? rich(titleProp.title) : '';
  const sections = [{ heading: title, lines: [] }];
  await walk(ctx, id, 0, {
    heading: (h) => sections.push({ heading: h, lines: [] }),
    line: (l) => sections[sections.length - 1].lines.push(l),
  });
  const out = sections.map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() })).filter((s, i) => s.text || i > 0);
  return {
    title,
    url: page.url || String(urlOrId),
    text: out.map((s) => (s.heading ? `${s.heading}\n${s.text}` : s.text)).join('\n\n').trim(),
    sections: out,
  };
}

function matches(ctx, input) {
  return /notion\.(so|site)\//i.test(String(input || ''));
}

module.exports = {
  id: 'notion',
  label: 'Notion',
  secrets: [{
    env: 'NOTION_TOKEN',
    label: 'Notion integration secret',
    help: 'Go to notion.so/my-integrations → New integration (Internal, capability "Read content") → copy the secret. Then on each requirement page (or its parent) click ••• → Connections → add the integration, otherwise the page cannot be read.',
  }],
  fields: [],
  testConnection,
  matches,
  fetchDocument,
};
