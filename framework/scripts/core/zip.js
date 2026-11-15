/**
 * Minimal ZIP reader (no dependencies) - enough to read Word .docx files, which
 * are ZIP archives of XML. Supports "stored" and "deflate" entries via zlib.
 *
 *   const { readZipEntry } = require('./zip');
 *   const xml = readZipEntry(buffer, 'word/document.xml').toString('utf8');
 */

const zlib = require('zlib');

function entries(buf) {
  // End of central directory record: signature 0x06054b50, searched from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .docx/zip file (no central directory). Is the file damaged or password-protected?');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const list = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    list.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return list;
}

function readZipEntry(buf, name) {
  const e = entries(buf).find((x) => x.name === name);
  if (!e) return null;
  const lp = e.localOffset;
  if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error('Corrupt zip entry.');
  const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Unsupported compression method ${e.method} in ${name}.`);
}

module.exports = { readZipEntry, zipEntries: entries };
