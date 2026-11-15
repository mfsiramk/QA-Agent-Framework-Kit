/**
 * Local file docs adapter - no credentials. Reads a requirement document saved on disk:
 *   .docx (Microsoft Word - also SharePoint/OneDrive/Google Docs downloads), .md, .txt, .html
 *   .pdf  → not parsed here: returned with needsDirectRead=true so the AI assistant opens the
 *           PDF itself (Claude reads PDFs natively). If your assistant can't, save it as .docx.
 * Relative paths resolve against the installation root. Sections split on headings.
 */

const fs = require('fs');
const path = require('path');
const { htmlToText } = require('../../core/http.js');
const { readZipEntry } = require('../../core/zip.js');

const TEXT_EXT = ['.md', '.markdown', '.txt'];
const HTML_EXT = ['.html', '.htm'];
const ALL_EXT = [...TEXT_EXT, ...HTML_EXT, '.docx', '.pdf'];

function resolvePath(ctx, p) {
  const s = String(p || '').trim().replace(/^file:\/\/\/?/i, '').replace(/^["']|["']$/g, '');
  if (!s) throw new Error('Local document: no file path given.');
  return path.isAbsolute(s) ? s : path.resolve(ctx.root || process.cwd(), s);
}

function markdownSections(text, title) {
  const sections = [];
  let cur = { heading: title, lines: [] };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s{0,3}(#{1,4})\s+(.*?)\s*#*\s*$/);
    if (m) { sections.push(cur); cur = { heading: m[2], lines: [] }; } else cur.lines.push(line);
  }
  sections.push(cur);
  return sections.map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() })).filter((s, i) => s.text || i > 0);
}

function htmlSections(html, title) {
  const sections = [];
  let heading = title;
  for (const part of html.split(/(<h[1-4][^>]*>[\s\S]*?<\/h[1-4]>)/i)) {
    if (/^<h[1-4]/i.test(part)) heading = htmlToText(part);
    else { const t = htmlToText(part); if (t) sections.push({ heading, text: t }); }
  }
  return sections;
}

const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Word document.xml → paragraphs with heading detection (Title / Heading1-4 styles), tables as rows. */
function readDocx(file) {
  const buf = fs.readFileSync(file);
  const xmlBuf = readZipEntry(buf, 'word/document.xml');
  if (!xmlBuf) throw new Error('Local document: this .docx has no document body (word/document.xml). Re-save it from Word.');
  const xml = xmlBuf.toString('utf8');
  const body = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => tbl
    .split(/<\/w:tr>/).map((row) => (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map((c) => (c.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => xmlText(t.replace(/<[^>]+>/g, ''))).join('')).join(' | '))
    .filter((r) => r.replace(/[|\s]/g, '')).map((r) => `<w:p><w:r><w:t>${r.replace(/[<&]/g, ' ')}</w:t></w:r></w:p>`).join(''));
  const paras = [];
  for (const p of body.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []) {
    const style = (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || '';
    const list = /<w:numPr>/.test(p);
    const text = (p.match(/<w:t[^>]*>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g) || [])
      .map((t) => (t.startsWith('<w:tab') ? '\t' : t.startsWith('<w:br') ? '\n' : xmlText(t.replace(/<[^>]+>/g, '')))).join('').trim();
    if (!text) continue;
    const lvl = /^Title$/i.test(style) ? 1 : (style.match(/^Heading([1-4])$/i) || [])[1];
    paras.push({ text: list ? `• ${text}` : text, heading: !!lvl });
  }
  const title = (paras.find((p) => p.heading) || paras[0] || { text: path.basename(file, '.docx') }).text;
  const sections = [];
  let cur = { heading: title, lines: [] };
  for (const p of paras) {
    if (p.heading) { if (cur.lines.length || sections.length) sections.push(cur); cur = { heading: p.text, lines: [] }; } else cur.lines.push(p.text);
  }
  sections.push(cur);
  return { title, url: file, text: paras.map((p) => p.text).join('\n'), sections: sections.map((s) => ({ heading: s.heading, text: s.lines.join('\n') })).filter((s) => s.text || s.heading) };
}

async function testConnection() {
  return { ok: true, message: 'Files need no account - give the file path (Word .docx, PDF, .md, .txt, .html) when Agent 1 asks.' };
}

/** True when the input looks like a file path (not a web address). */
function matches(ctx, input) {
  return !/^https?:\/\//i.test(String(input || '').trim());
}

async function fetchDocument(ctx, filePath) {
  const file = resolvePath(ctx, filePath);
  const ext = path.extname(file).toLowerCase();
  if (!ALL_EXT.includes(ext)) {
    throw new Error(`Local document: "${ext || 'no extension'}" files are not supported. Use Word (.docx), PDF, .md, .txt or .html. (For .doc files: open in Word → Save As → .docx.)`);
  }
  if (!fs.existsSync(file)) throw new Error(`Local document: file not found: ${file}`);
  if (ext === '.docx') return readDocx(file);
  if (ext === '.pdf') {
    return { title: path.basename(file, ext), url: file, text: '', sections: [], needsDirectRead: true,
      note: 'PDF: open this file directly with your assistant\'s file reader to read it. If it cannot read PDFs, save the document as Word (.docx) and re-run.' };
  }
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (HTML_EXT.includes(ext)) {
    const t = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const title = t ? htmlToText(t[1]) : path.basename(file, ext);
    const body = raw.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '');
    return { title, url: file, text: htmlToText(body), sections: htmlSections(body, title) };
  }
  const h1 = raw.match(/^\s{0,3}#\s+(.+)$/m);
  const title = h1 ? h1[1].trim() : path.basename(file, ext);
  return { title, url: file, text: raw.trim(), sections: ext === '.txt' && !h1 ? [{ heading: title, text: raw.trim() }] : markdownSections(raw, title) };
}

module.exports = {
  id: 'local',
  label: 'Word / PDF / text files',
  secrets: [],
  fields: [],
  testConnection,
  matches,
  fetchDocument,
};
