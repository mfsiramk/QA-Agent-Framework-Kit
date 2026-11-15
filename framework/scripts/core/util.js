/** Shared helpers: escaping, step parsing, fuzzy matching, Excel row I/O. */

const fs = require('fs');

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const normalizeTitle = (t) => String(t || '').toLowerCase().replace(/^tc[\s_-]*\d+[:.\s-]*/i, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** "1. Do x\n2. Do y" → ['Do x', 'Do y'] */
function splitNumbered(text) {
  if (Array.isArray(text)) return text.map(String).filter(Boolean);
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(step\s*)?\d+[.)\]:-]\s*/i, '').replace(/^\s*[-•*]\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Pair Excel "Steps" + "Expected Result" text into [{action, expected}].
 * If expected results are numbered with the same count, pair 1:1; otherwise the
 * whole expected result goes on the last step.
 */
function pairSteps(stepsText, expectedText) {
  const actions = splitNumbered(stepsText);
  const expected = splitNumbered(expectedText);
  if (actions.length === 0) return [{ action: '', expected: String(expectedText || '').trim() }];
  if (expected.length === actions.length) return actions.map((a, i) => ({ action: a, expected: expected[i] }));
  return actions.map((a, i) => ({ action: a, expected: i === actions.length - 1 ? String(expectedText || '').trim() : '' }));
}

const tokenize = (s) => String(s || '').toLowerCase().replace(/"[^"]*"/g, ' value ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);

/** Token-set similarity 0..1 (Dice coefficient). */
function similarity(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function bestMatch(text, patterns) {
  let best = { score: 0, pattern: null };
  for (const p of patterns) {
    const s = similarity(text, p);
    if (s > best.score) best = { score: s, pattern: p };
  }
  return best;
}

/** Read the "Test Cases" sheet of an Agent 1 Excel into normalized test cases. */
function readTestCaseExcel(file, automationTag) {
  const XLSX = require('xlsx');
  if (!fs.existsSync(file)) throw new Error(`Excel not found: ${file}`);
  const wb = XLSX.readFile(file);
  const sheetName = wb.SheetNames.find((n) => /test\s*cases?/i.test(n)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
  const pick = (row, ...names) => {
    for (const n of names) {
      const k = Object.keys(row).find((key) => key.trim().toLowerCase() === n.toLowerCase());
      if (k && String(row[k]).trim()) return String(row[k]).trim();
    }
    return '';
  };
  return rows
    .map((row, i) => {
      const tags = pick(row, 'Tags').split(/[;,]/).map((t) => t.trim()).filter(Boolean);
      return {
        row: i + 2,
        id: pick(row, 'TC ID', 'ID', 'Test Case ID'),
        title: pick(row, 'Title', 'Test Case Title'),
        subject: pick(row, 'Subject', 'Module', 'Feature') || 'General',
        priority: pick(row, 'Priority') || 'Medium',
        category: pick(row, 'Category', 'Type'),
        preconditions: pick(row, 'Preconditions', 'Pre-conditions'),
        steps: pairSteps(pick(row, 'Test Steps', 'Steps'), pick(row, 'Expected Result', 'Expected Results')),
        testData: pick(row, 'Test Data'),
        acRef: pick(row, 'AC Ref', 'Acceptance Criteria Ref', 'AC Reference'),
        tags,
        automation: tags.some((t) => t.toLowerCase() === String(automationTag || 'Automation').toLowerCase()),
      };
    })
    .filter((tc) => tc.title);
}

function exitWith(code, label, lines = []) {
  if (label) console.log(`\n${label}`);
  lines.forEach((l) => console.log(l));
  process.exit(code);
}

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) {
    const next = argv[i + 1];
    return next && !next.startsWith('--') ? next : true;
  }
  return fallback;
}
const positional = () => {
  const out = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (!argv[i].includes('=') && argv[i + 1] && !argv[i + 1].startsWith('--') && VALUE_FLAGS.has(argv[i].slice(2))) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
};
const VALUE_FLAGS = new Set(['resume', 'automation-exempt-reason', 'feasibility-report', 'brd', 'design', 'requirement', 'file', 'qa', 'plan', 'release']);

module.exports = { escapeHtml, normalizeTitle, splitNumbered, pairSteps, similarity, bestMatch, tokenize, readTestCaseExcel, exitWith, arg, positional };
