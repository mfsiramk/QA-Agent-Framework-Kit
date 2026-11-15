#!/usr/bin/env node
/**
 * Scan the client's automation repo and write steering/step-library.md - the
 * binding index of reusable step text that Agent 1 (step wording + linter) and
 * Agent 3 (feature generation) reuse before inventing anything new.
 *
 *   npm run step-library
 *
 * BDD frameworks: every distinct step line in *.feature files (grouped by folder,
 *   most-used first) + step-definition binding patterns (C#, Java, JS/TS, Python, Ruby).
 * Non-BDD frameworks: an index of existing test titles per spec file, so Agent 1 can
 *   align naming and Agent 2's feasibility advisory can spot existing coverage.
 * Regenerate after the automation team merges new steps (weekly is typical).
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../core/config');

const cfg = loadConfig();
const a = cfg.automation || {};
const repo = path.resolve(cfg.root, a.repo?.localPath || 'automation-repo');
if (a.status !== 'existing') { console.log('ℹ️  No existing automation configured - step library not needed.'); process.exit(0); }
if (!fs.existsSync(repo)) { console.error(`❌ Automation repo not found at ${repo}. Run: npm run sync-automation`); process.exit(1); }

const SKIP = new Set(['node_modules', '.git', 'bin', 'obj', 'target', 'build', 'dist', '.venv', 'venv', '__pycache__', 'test-results', 'playwright-report']);
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(repo);
const rel = (p) => path.relative(repo, p).replace(/\\/g, '/');
const lines = [`# Step Library - ${cfg.organization?.product || ''}`, '', `> Generated ${new Date().toISOString().slice(0, 10)} from \`${a.repo?.cloneUrl || repo}\` (${a.repo?.branch || ''}). Do not edit by hand - run \`npm run step-library\`.`, '> Agent 1 and Agent 3 MUST reuse this step text before writing any new step.', ''];

if (a.bdd) {
  const featureRoot = a.repo?.featuresPath ? path.resolve(repo, a.repo.featuresPath) : repo;
  const features = files.filter((f) => f.endsWith('.feature') && f.startsWith(featureRoot));
  const byFolder = new Map();
  let total = 0;
  for (const f of features) {
    const folder = path.dirname(rel(f)) || '.';
    const counts = byFolder.get(folder) || new Map();
    let last = 'Given';
    for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = raw.trim().match(/^(Given|When|Then|And|But|\*)\s+(.+)$/);
      if (!m) continue;
      const kw = ['And', 'But', '*'].includes(m[1]) ? last : m[1];
      last = kw;
      const step = m[2].trim();
      counts.set(step, (counts.get(step) || 0) + 1);
      total++;
    }
    byFolder.set(folder, counts);
  }
  lines.push(`## Feature-file steps (${features.length} files, ${total} step usages)`, '');
  for (const [folder, counts] of [...byFolder.entries()].sort()) {
    if (!counts.size) continue;
    lines.push(`### ${folder}`, '', '```gherkin');
    [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 150).forEach(([s]) => lines.push(/^I\s/.test(s) ? s : `Given ${s}`));
    lines.push('```', '');
  }
  lines.push('### Feature files (read the matching one end-to-end before writing steps)', '');
  features.forEach((f) => lines.push(`- \`${rel(f)}\``));
  lines.push('');

  const BINDING = [
    /\[(Given|When|Then|StepDefinition)\(@?"((?:[^"\\]|\\.|"")+)"\)\]/g, // C# SpecFlow/Reqnroll
    /@(Given|When|Then|And)\(\s*"((?:[^"\\]|\\.)+)"\s*\)/g, // Java cucumber
    /\b(Given|When|Then)\(\s*['"`/]((?:[^'"`\\]|\\.)+)['"`/]/g, // JS/TS cucumber, playwright-bdd
    /@(given|when|then|step)\(\s*(?:parsers\.\w+\()?u?['"]((?:[^'"\\]|\\.)+)['"]/g, // Python behave/pytest-bdd
  ];
  const stepRoot = a.repo?.stepDefinitionsPath ? path.resolve(repo, a.repo.stepDefinitionsPath) : repo;
  const bindings = [];
  for (const f of files.filter((x) => /\.(cs|java|kt|js|ts|py|rb)$/.test(x) && x.startsWith(stepRoot))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of BINDING) { re.lastIndex = 0; let m; while ((m = re.exec(src))) bindings.push({ kw: m[1], pattern: m[2], file: rel(f) }); }
  }
  lines.push(`## Step-definition bindings (${bindings.length})`, '', 'These are the patterns the automation code actually implements. A step that matches one of these needs no new code.', '');
  const byFile = new Map();
  bindings.forEach((b) => byFile.set(b.file, [...(byFile.get(b.file) || []), b]));
  for (const [file, list] of byFile) {
    lines.push(`### ${file}`, '', '```text');
    list.forEach((b) => lines.push(`${b.kw[0].toUpperCase()}${b.kw.slice(1)} ${b.pattern}`));
    lines.push('```', '');
  }
  console.log(`✅ Step library: ${features.length} feature file(s), ${byFolder.size} folder(s), ${bindings.length} binding(s)`);
} else {
  const TEST = [/\b(?:test|it)\(\s*['"`]([^'"`]+)['"`]/g, /@Test[\s\S]{0,200}?void\s+(\w+)/g, /def\s+(test_\w+)/g, /\[(?:Test|Fact|TestMethod)\][\s\S]{0,200}?void\s+(\w+)/g];
  const specs = files.filter((f) => /\.(spec|test|cy)\.(js|ts|jsx|tsx)$|Test\.(java|kt|cs)$|Tests?\.cs$|test_.*\.py$|\.robot$/.test(f));
  let count = 0;
  lines.push(`## Existing automated tests (${specs.length} files)`, '');
  for (const f of specs) {
    const src = fs.readFileSync(f, 'utf8');
    const titles = [];
    for (const re of TEST) { re.lastIndex = 0; let m; while ((m = re.exec(src))) titles.push(m[1]); }
    if (f.endsWith('.robot')) src.split(/\r?\n/).forEach((l, i, arr) => { if (/^\*\*\*\s*Test Cases/i.test(l)) arr.slice(i + 1).forEach((t) => { if (/^\S/.test(t) && !t.startsWith('***')) titles.push(t.trim()); }); });
    if (!titles.length) continue;
    count += titles.length;
    lines.push(`### ${rel(f)}`, '');
    titles.forEach((t) => lines.push(`- ${t}`));
    lines.push('');
  }
  console.log(`✅ Automation index: ${specs.length} spec file(s), ${count} test(s)`);
}

const out = path.join(cfg.root, 'steering', 'step-library.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n'));
console.log(`   Written: ${path.relative(cfg.root, out)}`);
