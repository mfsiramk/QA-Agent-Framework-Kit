/**
 * Shared, tool-neutral helpers for the bug / search functions of the task adapters.
 * Not an adapter itself (the leading underscore keeps it out of the tool list).
 * Pure functions only - no network, no file system - so they can be unit-tested.
 *
 * bugFields config (ctx.config.bugFields), one entry per logical field:
 *   { severity: { field, values[] }, priority: { field, values[] },
 *     environment: { field, values[] }, foundIn: { field } }
 * where `field` is one of:
 *   - a field reference      (ADO "Microsoft.VSTS.Common.Severity", Jira "customfield_10050")
 *   - "priority"             the tool's built-in priority
 *   - "label:<prefix>"       add the label <prefix><value> (lowercased, spaces -> '-')
 *   - "description" or ""    only written into the description as "**Severity:** High"
 */

const BUG_KEYS = ['severity', 'priority', 'environment', 'foundIn'];
const TITLES = { severity: 'Severity', priority: 'Priority', environment: 'Environment', foundIn: 'Found in', component: 'Component' };
const PRIORITY_NUM = { critical: 1, urgent: 1, highest: 1, blocker: 1, high: 2, major: 2, medium: 3, normal: 3, low: 4, lowest: 4, minor: 4, trivial: 4 };

/** Resolve the configured form of one logical field. `defaults` = adapter-specific fallbacks. */
function fieldSpec(ctx, key, defaults = {}) {
  const all = (ctx && ctx.config && ctx.config.bugFields) || {};
  const s = all[key] || {};
  const field = s.field !== undefined && s.field !== null ? String(s.field).trim() : String(defaults[key] || '').trim();
  const values = Array.isArray(s.values) ? s.values.map(String) : [];
  if (field === 'priority') return { key, form: 'priority', field, values };
  if (/^label:/i.test(field)) return { key, form: 'label', field, prefix: field.slice(6), values };
  if (!field || field.toLowerCase() === 'description') return { key, form: 'description', field: 'description', values };
  return { key, form: 'ref', field, values };
}

/** Map a human value onto the allowed list: exact (case-insensitive) or "2 - High" style suffix match. */
function matchValue(value, values) {
  const v = String(value == null ? '' : value).trim();
  if (!values || !values.length || !v) return { value: v, matched: true };
  const lv = v.toLowerCase();
  const exact = values.find((x) => String(x).toLowerCase() === lv);
  if (exact) return { value: exact, matched: true };
  const loose = values.find((x) => {
    const lx = String(x).toLowerCase();
    return lx.endsWith(' ' + lv) || lx.startsWith(lv + ' ') || lx.replace(/^\d+\s*-\s*/, '') === lv;
  });
  if (loose) return { value: loose, matched: true };
  return { value: v, matched: false };
}

const labelName = (prefix, value) => `${prefix || ''}${value}`.trim().toLowerCase().replace(/\s+/g, '-');

/** "Critical" -> 1 ... "Low" -> 4; numeric strings pass through; unknown -> null. */
function priorityNumber(value) {
  const v = String(value == null ? '' : value).trim();
  const n = v.match(/^(\d+)/);
  if (n) return Number(n[1]);
  return PRIORITY_NUM[v.toLowerCase()] || null;
}

const descriptionLine = (key, value) => `**${TITLES[key] || key}:** ${value}`;

/** Read "**Severity:** High" back out of a description. */
function readFromDescription(text, key) {
  const t = TITLES[key] || key;
  const m = String(text || '').match(new RegExp(`\\*\\*${t.replace(/\s+/g, '\\s+')}:\\*\\*\\s*([^\\r\\n]+)`, 'i'));
  return m ? m[1].trim() : null;
}

function readFromLabels(labels, prefix) {
  const p = String(prefix || '').toLowerCase();
  const l = (labels || []).map(String).find((x) => x.toLowerCase().startsWith(p) && x.length > p.length);
  return l ? l.slice(p.length) : null;
}

/**
 * Read one logical field for the normalized WorkItem.
 * src = { field(ref) -> value, priority() -> built-in priority, labels: [], description: '' }
 */
function readField(ctx, key, defaults, src) {
  const s = fieldSpec(ctx, key, defaults);
  let v = null;
  if (s.form === 'ref') v = src.field ? src.field(s.field) : null;
  else if (s.form === 'priority') v = src.priority ? src.priority() : null;
  else if (s.form === 'label') v = readFromLabels(src.labels, s.prefix);
  else v = readFromDescription(src.description, key);
  if (v && typeof v === 'object') v = v.value || v.name || v.displayName || null;
  return v === undefined || v === null || v === '' ? null : String(v);
}

/**
 * Split bug.fields into what the adapter must do. `supports` = forms the tool can write
 * directly (e.g. ['ref','priority','label']); anything else falls back to the description
 * with a warning. Returns { writes: [spec + value], labels: [], descLines: [], warnings: [] }.
 */
function planBugFields(ctx, bug, defaults = {}, supports = ['ref', 'priority', 'label'], tool = 'This tool') {
  const out = { writes: [], labels: [], descLines: [], warnings: [] };
  const f = (bug && bug.fields) || {};
  for (const key of BUG_KEYS) {
    const raw = f[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const s = fieldSpec(ctx, key, defaults);
    const m = matchValue(raw, s.values);
    if (!m.matched) out.warnings.push(`${TITLES[key]} "${raw}" is not one of the configured values (${s.values.join(', ')}); written as given.`);
    if (s.form !== 'description' && !supports.includes(s.form)) {
      out.warnings.push(`${tool} cannot write ${TITLES[key]} to "${s.field}"; it was added to the description instead.`);
      out.descLines.push(descriptionLine(key, m.value));
      continue;
    }
    if (s.form === 'label') out.labels.push(labelName(s.prefix, m.value));
    else if (s.form === 'description') out.descLines.push(descriptionLine(key, m.value));
    else out.writes.push({ ...s, value: m.value, raw: String(raw).trim() });
  }
  return out;
}

function composeDescription(md, lines) {
  const body = String(md || '').trim();
  if (!lines || !lines.length) return body;
  return `${body}${body ? '\n\n' : ''}${lines.join('  \n')}`;
}

// ---------- markdown block parser + renderers ----------

/** Very small markdown parser: headings, bullet lists, numbered lists, paragraphs. */
function parseBlocks(md) {
  const blocks = [];
  let para = null; let list = null;
  const close = () => { para = null; list = null; };
  for (const line of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
    let m;
    if (!line.trim()) { close(); continue; }
    if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) { close(); blocks.push({ type: 'heading', level: m[1].length, text: m[2] }); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/)) || (m = line.match(/^\s*(?:\d+)[.)]\s+(.*)$/))) {
      const kind = /^\s*[-*+]\s/.test(line) ? 'ul' : 'ol';
      if (!list || list.type !== kind) { para = null; list = { type: kind, items: [] }; blocks.push(list); }
      list.items.push(m[1]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
    list = null;
    if (!para) { para = { type: 'p', lines: [] }; blocks.push(para); }
    para.lines.push(line.trim());
  }
  return blocks;
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inlineHtml(text) {
  return escHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, '$1<i>$2</i>');
}

/** Markdown -> simple HTML (Azure DevOps rich-text fields). */
function markdownToHtml(md) {
  return parseBlocks(md).map((b) => {
    if (b.type === 'heading') return `<h${b.level}>${inlineHtml(b.text)}</h${b.level}>`;
    if (b.type === 'ul' || b.type === 'ol') return `<${b.type}>${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</${b.type}>`;
    return `<p>${b.lines.map(inlineHtml).join('<br/>')}</p>`;
  }).join('');
}

/** Inline markdown -> ADF text nodes (bold, links, code). */
function inlineAdf(text) {
  const nodes = []; const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:[^)\s]+)\)|`([^`]+)`/g; let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1]) nodes.push({ type: 'text', text: m[1], marks: [{ type: 'strong' }] });
    else if (m[2]) nodes.push({ type: 'text', text: m[2], marks: [{ type: 'link', attrs: { href: m[3] } }] });
    else nodes.push({ type: 'text', text: m[4], marks: [{ type: 'code' }] });
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes;
}

/** Markdown -> Atlassian Document Format (Jira Cloud): paragraphs, headings, bullet + numbered lists. */
function markdownToAdf(md) {
  const content = parseBlocks(md).map((b) => {
    if (b.type === 'heading') return { type: 'heading', attrs: { level: Math.min(b.level, 6) }, content: inlineAdf(b.text) };
    if (b.type === 'ul' || b.type === 'ol') {
      return { type: b.type === 'ul' ? 'bulletList' : 'orderedList',
        content: b.items.map((i) => ({ type: 'listItem', content: [{ type: 'paragraph', content: inlineAdf(i) }] })) };
    }
    return { type: 'paragraph', content: b.lines.flatMap((l, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...inlineAdf(l)]) };
  });
  return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph', content: [] }] };
}

/** Markdown -> Jira wiki markup (Jira Data Center / Server). */
function markdownToWiki(md) {
  const inl = (t) => String(t).replace(/\*\*([^*]+)\*\*/g, '*$1*').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '[$1|$2]').replace(/`([^`]+)`/g, '{{$1}}');
  return parseBlocks(md).map((b) => {
    if (b.type === 'heading') return `h${b.level}. ${inl(b.text)}`;
    if (b.type === 'ul') return b.items.map((i) => `* ${inl(i)}`).join('\n');
    if (b.type === 'ol') return b.items.map((i) => `# ${inl(i)}`).join('\n');
    return b.lines.map(inl).join('\n');
  }).join('\n\n');
}

// ---------- search helpers ----------

/** Words used for title matching (all must appear). */
function titleWords(text) {
  return [...new Set(String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))];
}

const titleMatches = (title, words) => { const t = String(title || '').toLowerCase(); return (words || []).every((w) => t.includes(w)); };

/** Apply the parts of a search query a tool could not filter server-side. */
function postFilter(items, q) {
  const lc = (a) => (a || []).map((s) => String(s).toLowerCase());
  const states = lc(q.states); const notStates = lc(q.notStates);
  const from = q.createdFrom ? new Date(q.createdFrom).getTime() : null;
  const to = q.createdTo ? new Date(q.createdTo).getTime() : null;
  const words = titleWords(q.text);
  return items.filter((w) => {
    const st = String(w.state || '').toLowerCase();
    if (states.length && !states.includes(st)) return false;
    if (notStates.includes(st)) return false;
    const cd = w.createdDate ? new Date(w.createdDate).getTime() : null;
    if (from !== null && cd !== null && cd < from) return false;
    if (to !== null && cd !== null && cd > endOfDay(q.createdTo)) return false;
    if (words.length && !titleMatches(w.title, words)) return false;
    return true;
  });
}

/** createdTo given as a bare date means "up to the end of that day". */
function endOfDay(iso) {
  const s = String(iso || '');
  const t = new Date(s).getTime();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? t + 86399999 : t;
}

const releaseValue = (rc, release) => String((rc && rc.pattern) || '{release}').replace(/\{release\}/g, release);

const iso = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); };

module.exports = {
  BUG_KEYS, TITLES, fieldSpec, matchValue, labelName, priorityNumber, descriptionLine, readFromDescription, readFromLabels,
  readField, planBugFields, composeDescription, parseBlocks, markdownToHtml, markdownToAdf, markdownToWiki,
  titleWords, titleMatches, postFilter, endOfDay, releaseValue, iso,
};
