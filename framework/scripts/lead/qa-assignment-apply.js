#!/usr/bin/env node
/**
 * QA LEAD - apply an approved plan.json. Writes ONLY the configured QA field.
 *
 *   node scripts/lead/qa-assignment-apply.js <release> --dry-run
 *   node scripts/lead/qa-assignment-apply.js <release> --confirm
 *
 * Preflight: re-queries the release. If tickets were added/removed since the plan,
 * it patches plan.json (new tickets → balanced proposal, dropped → removed),
 * re-renders plan.html and exits 3 so the lead can review again. Manual edits are kept.
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, taskAdapter, outDir } = require('../core/config');
const { preflight } = require('../core/preflight');
const { arg, positional, exitWith } = require('../core/util');
const { buildPlan, renderHtml } = require('./qa-assignment-plan');

(async () => {
  const [release] = positional();
  const confirm = !!arg('confirm');
  const dry = !!arg('dry-run');
  if (!release || (!confirm && !dry)) exitWith(1, 'Usage: node scripts/lead/qa-assignment-apply.js <release> --dry-run | --confirm');
  const cfg = loadConfig();
  const dir = outDir('qa-assignments', `release-${release}`);
  const jsonFile = path.join(dir, 'plan.json');
  if (!fs.existsSync(jsonFile)) exitWith(1, `❌ ${jsonFile} not found - run the plan first.`);
  const plan = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  await preflight(cfg, ['task']);
  const task = taskAdapter(cfg);

  if (!arg('skip-preflight')) {
    const fresh = await buildPlan(cfg, release);
    const freshIds = new Set(fresh.items.map((i) => i.id));
    const planIds = new Set(plan.items.map((i) => i.id));
    const added = fresh.items.filter((i) => !planIds.has(i.id));
    const removed = plan.items.filter((i) => !freshIds.has(i.id));
    if (added.length || removed.length) {
      plan.items = plan.items.filter((i) => freshIds.has(i.id)).concat(added);
      fs.writeFileSync(jsonFile, JSON.stringify(plan, null, 2));
      fs.writeFileSync(path.join(dir, 'plan.html'), renderHtml(plan));
      exitWith(3, '⚠️  RELEASE CHANGED SINCE THE PLAN - nothing was written.', [
        `   Added:   ${added.length} ${added.slice(0, 10).map((a) => a.id).join(', ')}`,
        `   Removed: ${removed.length} ${removed.slice(0, 10).map((a) => a.id).join(', ')}`,
        '   plan.json and plan.html were refreshed. Review plan.html, save edits, say "verify plan.json", then apply again.',
      ]);
    }
  }

  const todo = plan.items.filter((i) => i.proposedQa && i.proposedQa !== i.currentQa);
  console.log(`${dry ? '🔍 DRY RUN' : '✍️  APPLYING'} - ${todo.length} change(s), ${plan.items.length - todo.length} unchanged`);
  const results = [];
  for (const i of todo) {
    if (dry) { console.log(`   ${i.id}: ${i.currentQa || '(none)'} → ${i.proposedQa} [${i.rule}]`); continue; }
    try { await task.adapter.setQaAssignee(task.ctx, i.id, { name: i.proposedQa, id: i.proposedQaId || i.proposedQa }); results.push({ id: i.id, ok: true, qa: i.proposedQa }); process.stdout.write('.'); }
    catch (e) { results.push({ id: i.id, ok: false, error: e.message }); process.stdout.write('x'); }
  }
  if (!dry) {
    console.log('');
    fs.writeFileSync(path.join(dir, 'applied.json'), JSON.stringify({ release, appliedAt: new Date().toISOString(), results }, null, 2));
    const failed = results.filter((r) => !r.ok);
    console.log(`✅ Applied ${results.length - failed.length}/${results.length}${failed.length ? ` - ${failed.length} failed (see applied.json)` : ''}`);
    process.exit(failed.length ? 1 : 0);
  }
})().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
