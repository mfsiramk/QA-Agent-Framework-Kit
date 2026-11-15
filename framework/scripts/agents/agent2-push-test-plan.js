#!/usr/bin/env node
/**
 * AGENT 2 - push the QA-approved Excel into the client's test management tool.
 *
 *   node scripts/agents/agent2-push-test-plan.js <workItemId> "<excelPath>"
 *        [--resume <planId>] [--force-new]
 *        [--no-automation-confirmed --automation-exempt-reason "<reason>" [--feasibility-report "<html>"]]
 *
 * The approved Excel is the source of truth - fewer rows than Agent 1 generated is
 * expected QA curation, not a bug.
 *
 * Exit codes
 *   0 success
 *   1 failure
 *   2 needs user input: NO_AUTOMATION_TAG | AUTOMATION_EXEMPT_REASON_REQUIRED | MULTIPLE_PLANS_FOUND
 *   4 CREDENTIALS_INVALID
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, taskAdapter, testAdapter, outDir, MARKERS } = require('../core/config');
const { preflight } = require('../core/preflight');
const { arg, positional, readTestCaseExcel, normalizeTitle, exitWith } = require('../core/util');

(async () => {
  const [workItemId, excelPath] = positional();
  if (!workItemId || !excelPath) exitWith(1, 'Usage: node scripts/agents/agent2-push-test-plan.js <workItemId> "<excelPath>" [--resume <planId>] [--force-new]');
  const cfg = loadConfig();
  const automationTag = cfg.testManagement.automationTag || 'Automation';
  const automationInScope = cfg.automation?.status && cfg.automation.status !== 'none' && cfg.modules.agent3;

  // STEP 1 - read the approved Excel
  const tcs = readTestCaseExcel(excelPath, automationTag);
  if (!tcs.length) exitWith(1, '❌ No test cases found in the Excel "Test Cases" sheet.');
  const tagged = tcs.filter((t) => t.automation).length;
  console.log(`📄 Excel: ${tcs.length} test case(s), ${tagged} tagged "${automationTag}"`);

  // STEP 1.5 - automation tag readiness
  let exemptReason = null;
  if (automationInScope && tagged === 0) {
    if (!arg('no-automation-confirmed')) {
      exitWith(2, 'NO_AUTOMATION_TAG', [
        `No test cases have the "${automationTag}" tag in the Excel. Without it, Agent 3 will not create a feature file.`,
        'Run the Automation Feasibility Advisory, then ask the user whether to proceed without automation.',
      ]);
    }
    exemptReason = arg('automation-exempt-reason');
    if (!exemptReason || exemptReason === true || !String(exemptReason).trim()) {
      exitWith(2, 'AUTOMATION_EXEMPT_REASON_REQUIRED', ['Ask the user: "Please provide the Reason for Automation Exempt." then re-run with --automation-exempt-reason "<reason>".']);
    }
  }

  await preflight(cfg, ['task', 'test']);
  const task = taskAdapter(cfg);
  const test = testAdapter(cfg);
  const requirement = await task.adapter.getWorkItem(task.ctx, workItemId);
  console.log(`🎯 Requirement: ${requirement.type} ${requirement.id} - ${requirement.title}`);

  // STEP 2.5 - duplicate guard
  let plan = null;
  let mode = 'create';
  const resumeId = arg('resume');
  if (resumeId && resumeId !== true) {
    plan = { id: String(resumeId) };
    mode = 'resume';
  } else if (!arg('force-new')) {
    const existing = await test.adapter.findPlans(test.ctx, requirement.id);
    if (existing.length === 1) { plan = existing[0]; mode = 'resume'; console.log(`📋 AUTO-RESUME: existing test plan ${plan.id} found - adding only missing test cases.`); }
    if (existing.length > 1) {
      exitWith(2, 'MULTIPLE_PLANS_FOUND', [...existing.map((p) => `   • ${p.id} - ${p.name} ${p.url || ''}`), 'Ask the user which plan to resume, then re-run with --resume <planId>.']);
    }
  }
  if (!plan) {
    const name = `${requirement.id} - ${requirement.title}`.slice(0, 250);
    plan = await test.adapter.createPlan(test.ctx, { name, requirement, release: requirement.release });
    console.log(`🆕 Test plan created: ${plan.id} ${plan.url || ''}`);
  }

  // Skip what is already there (resume)
  const existingTitles = new Set();
  if (mode === 'resume') {
    (await test.adapter.listTestCases(test.ctx, plan)).forEach((t) => existingTitles.add(normalizeTitle(t.title)));
  }

  const suites = new Map();
  const created = [];
  const skipped = [];
  const failed = [];
  for (const tc of tcs) {
    if (existingTitles.has(normalizeTitle(tc.title))) { skipped.push(tc.title); continue; }
    try {
      if (!suites.has(tc.subject)) suites.set(tc.subject, await test.adapter.ensureSuite(test.ctx, plan, tc.subject));
      const r = await test.adapter.createTestCase(test.ctx, { plan, suite: suites.get(tc.subject), tc, requirement });
      created.push({ ...r, title: tc.title, automation: tc.automation });
      process.stdout.write('.');
    } catch (e) {
      failed.push({ title: tc.title, error: e.message });
      process.stdout.write('x');
    }
  }
  console.log('');
  const fin = (await test.adapter.finalize(test.ctx, plan)) || {};

  // Audit comment on the requirement (QA Audit reads these markers)
  const lines = [
    `${MARKERS.agent2} Test plan ${mode === 'resume' ? 'updated' : 'created'} by QA Agent 2`,
    `Plan: ${plan.url || plan.id}`,
    `Test cases added: ${created.length}${skipped.length ? ` · already present: ${skipped.length}` : ''}${failed.length ? ` · failed: ${failed.length}` : ''}`,
    `Automation-tagged: ${tagged} of ${tcs.length}`,
  ];
  if (exemptReason) {
    lines.push(`${MARKERS.exempt} This test plan is not scoped for automation.`, `Reason for Automation Exempt: ${exemptReason}`);
    const rep = arg('feasibility-report');
    if (rep && rep !== true) lines.push(`Automation feasibility report (local): ${path.basename(rep)}`);
  }
  if (fin.files?.length) lines.push(`Import file(s): ${fin.files.map((f) => path.basename(f)).join(', ')}`);
  try { await task.adapter.addComment(task.ctx, requirement.id, lines.join('\n')); } catch (e) { console.log(`⚠️ Could not post the audit comment: ${e.message}`); }

  const result = { workItemId: requirement.id, plan, mode, created, skipped, failed, exemptReason, files: fin.files || [], at: new Date().toISOString() };
  fs.writeFileSync(path.join(outDir('temp'), `${requirement.id}-agent2-result.json`), JSON.stringify(result, null, 2));

  console.log(`\n✅ Agent 2 ${failed.length ? 'finished with errors' : 'complete'}`);
  console.log(`   Plan:     ${plan.id} ${plan.url || ''}`);
  console.log(`   Suites:   ${suites.size}`);
  console.log(`   Created:  ${created.length}   Skipped (already present): ${skipped.length}   Failed: ${failed.length}`);
  if (fin.files?.length) console.log(`   Import:   ${fin.files.map((f) => path.relative(cfg.root, f)).join(', ')}  ← import this into your test tool`);
  failed.slice(0, 5).forEach((f) => console.log(`   ❌ ${f.title}: ${f.error}`));
  if (automationInScope && !exemptReason) console.log(`\n➡️  Next: "Generate feature file for ${plan.id}" (Agent 3) once the automation tags are final.`);
  console.log(`   Audit:    marker comment posted on ${requirement.id} (QA Audit counts this requirement as covered by Agent 2)`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
