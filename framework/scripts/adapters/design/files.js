/**
 * Design files adapter - for any design tool without an API connector (Adobe XD, Sketch,
 * Zeplin, Miro, Balsamiq, Axure, Canva, Penpot, PowerPoint mockups, screenshots…).
 * The designer exports screens as PNG / JPG / PDF / SVG into a folder (or a single file);
 * fetchDesign lists them as "frames" (frame name = file name) so Agent 1 can open each
 * image with the assistant's file reader and cite it in a test case's figmaRef/designRef.
 */

const fs = require('fs');
const path = require('path');

const EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf'];

async function testConnection() {
  return { ok: true, message: 'Exported design files need no account - give the folder or file path when Agent 1 asks.' };
}

function matches(ctx, input) {
  return !/^https?:\/\//i.test(String(input || '').trim());
}

async function fetchDesign(ctx, input) {
  const s = String(input || '').trim().replace(/^file:\/\/\/?/i, '').replace(/^["']|["']$/g, '');
  const p = path.isAbsolute(s) ? s : path.resolve(ctx.root || process.cwd(), s);
  if (!fs.existsSync(p)) throw new Error(`Design files: not found: ${p}`);
  const files = fs.statSync(p).isDirectory()
    ? fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isFile() && EXT.includes(path.extname(e.name).toLowerCase())).map((e) => path.join(p, e.name))
    : [p];
  if (!files.length) throw new Error(`Design files: no images or PDFs in ${p}. Export the screens as PNG, JPG or PDF into that folder.`);
  const frames = files.sort().slice(0, 200).map((f) => ({ id: path.basename(f), name: path.basename(f, path.extname(f)), page: path.basename(path.dirname(f)), file: f, texts: [] }));
  return { name: path.basename(p), source: 'files', needsDirectRead: true, frames };
}

module.exports = {
  id: 'files',
  label: 'Exported design files (PNG / JPG / PDF)',
  secrets: [],
  fields: [],
  testConnection,
  matches,
  fetchDesign,
};
