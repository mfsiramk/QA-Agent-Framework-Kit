#!/usr/bin/env node
/**
 * Generator self-test: builds the file set for several client profiles and checks
 * that the dependency rules hold. No network, writes nothing.   npm run selftest
 */

const assert = require('assert');
const { buildFiles } = require('./lib/generator');
const { catalog } = require('./lib/catalog');

const base = (over) => ({
  config: {
    organization: { company: 'Acme', product: 'Portal', shortCode: 'AC' },
    modules: { agent1: true, agent2: true, agent3: true, qaAssignment: false, qaAudit: false },
    assistants: ['claude-code'],
    taskManagement: { tool: 'ado', orgUrl: 'https://dev.azure.com/acme', project: 'Portal', fields: {} },
    testManagement: { tool: 'ado-test-plans' },
    requirementDocs: { tool: 'none' }, design: { tool: 'none' }, codeChanges: { tool: 'none' },
    automation: { status: 'none', planned: false },
    ...over,
  },
  secrets: { ADO_PAT: 'x' },
  target: 'C:/tmp/x',
});

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };

console.log('\nCatalog');
test('every tool has a connector with metadata', () => {
  const c = catalog();
  for (const k of ['taskTools', 'testTools', 'docTools', 'codeTools', 'designTools']) for (const t of c[k]) if (t.id !== 'none') assert(!t.missing && !t.error, `${k}/${t.id} ${t.error || 'missing'}`);
});

console.log('\nProfiles');
test('ADO, no automation → Agent 3 off, no tag step, audit skips Agent 3', () => {
  const r = buildFiles(base({ modules: { agent1: true, agent2: true, agent3: true, qaAssignment: false, qaAudit: true } }));
  assert(!r.cfg.modules.agent3);
  assert(!r.files['agents/agent3-feature-file-generator.md']);
  assert(!/NO_AUTOMATION_TAG/.test(r.files['agents/agent2-test-plan-creator.md']));
  assert(/not-applicable/.test(r.files['agents/agent1-test-case-generator.md']));
  assert(/Agent 3 is not checked/.test(r.files['agents/lead/qa-audit.md']));
});

test('Jira + Xray + existing Reqnroll → canonical step rule + PR delivery + task', () => {
  const r = buildFiles(base({
    taskManagement: { tool: 'jira', baseUrl: 'https://acme.atlassian.net', projectKey: 'WEB', fields: {} },
    testManagement: { tool: 'xray', projectKey: 'WEB', automationTag: 'AutoMe' },
    automation: { status: 'existing', framework: 'reqnroll', repo: { cloneUrl: 'https://github.com/acme/t.git', branch: 'main' }, delivery: { mode: 'pull-request' }, owner: { name: 'Alex' } },
  }));
  const a1 = r.files['agents/agent1-test-case-generator.md'];
  assert(/Canonical step text \(BLOCKING\)/.test(a1));
  assert(/pull request/.test(r.files['agents/agent3-feature-file-generator.md']));
  assert(/AutoMe/.test(r.files['CLAUDE.md']));
  assert(r.cfg.automation.bdd === true);
});

test('GitHub + CSV + planned Playwright → handoff folder, spec wording', () => {
  const r = buildFiles(base({
    taskManagement: { tool: 'github', owner: 'acme', repo: 'portal', fields: {} },
    testManagement: { tool: 'csv', format: 'generic' },
    automation: { status: 'none', planned: true, framework: 'playwright' },
  }));
  assert(r.cfg.modules.agent3);
  assert.strictEqual(r.cfg.automation.status, 'planned');
  assert(/automation-handoff/.test(r.files['agents/agent3-feature-file-generator.md']));
  assert(/import file/.test(r.files['agents/agent2-test-plan-creator.md']));
});

test('Agent 3 alone switches Agent 2 on; Audit without Agent 2 is dropped', () => {
  const r1 = buildFiles(base({ modules: { agent3: true }, automation: { status: 'existing', framework: 'cypress', repo: { cloneUrl: 'u', branch: 'main' } } }));
  assert(r1.cfg.modules.agent2 && r1.warnings.some((w) => /Agent 2 was turned on/.test(w)));
  const r2 = buildFiles(base({ modules: { qaAudit: true, agent1: false, agent2: false, agent3: false } }));
  assert(!r2.cfg.modules.qaAudit);
});

test('QA lead only → roster + release pattern documented, no agent files', () => {
  const r = buildFiles(base({
    modules: { qaAssignment: true },
    taskManagement: { tool: 'ado', orgUrl: 'x', project: 'P', fields: { qaAssignee: 'Custom.QA', release: { type: 'iterationPath', pattern: 'P\\R_{release}' } } },
    qaLead: { roster: [{ name: 'Priya', id: 'p@x', pool: 'general', subjectKeywords: ['Payments'] }] },
  }));
  assert(r.files['agents/lead/qa-assignment.md'].includes('Priya'));
  assert(!r.files['agents/agent1-test-case-generator.md']);
});

test('Copilot + Cursor files, MCP only with Claude', () => {
  const r = buildFiles({ ...base({ assistants: ['copilot', 'cursor'] }), options: { mcp: true } });
  assert(r.files['.github/copilot-instructions.md'] && r.files['.cursor/rules/qa-agents.mdc']);
  assert(!r.files['.mcp.json'] && !r.files['CLAUDE.md']);
});

test('secrets never land in the answers file', () => {
  const r = buildFiles(base({}));
  assert(!r.files['installer-answers.json'].includes('"x"'));
  assert(r.files['.env'].includes('ADO_PAT=x'));
});

test('Several doc + design sources → one connector each, file guidance, source table', () => {
  const r = buildFiles(base({
    taskManagement: { tool: 'jira', baseUrl: 'https://acme.atlassian.net', projectKey: 'WEB', fields: {} },
    testManagement: { tool: 'testrail', baseUrl: 'x', projectId: '1' },
    requirementDocs: { picked: ['confluence', 'sharepoint', 'word'], settings: { confluence: { baseUrl: 'https://acme.atlassian.net/wiki', deployment: 'cloud' } } },
    design: { picked: ['figma', 'adobe-xd'], settings: {} },
  }));
  assert.deepStrictEqual(r.cfg.requirementDocs.sources.map((s) => s.tool), ['confluence', 'local']);
  assert.strictEqual(r.cfg.requirementDocs.sources[0].baseUrl, 'https://acme.atlassian.net/wiki');
  assert.deepStrictEqual(r.cfg.design.sources.map((s) => s.tool), ['figma', 'files']);
  const a1 = r.files['agents/agent1-test-case-generator.md'];
  assert(/Business rules/.test(a1) && /NO_REQUIREMENT_DOC/.test(a1) && /NEEDS_FILES/.test(a1) && /docRef/.test(a1));
  assert(/Save a copy/.test(r.files['requirements-docs/README.md']) && /Export/.test(r.files['design-exports/README.md']));
});

test('"Only the ticket" + "No designs" → no doc/design wording, no folders', () => {
  const r = buildFiles(base({ requirementDocs: { picked: ['none'] }, design: { picked: ['none'] } }));
  assert.deepStrictEqual(r.cfg.requirementDocs.sources, []);
  assert(!/NO_REQUIREMENT_DOC/.test(r.files['agents/agent1-test-case-generator.md']));
  assert(!r.files['requirements-docs/README.md'] && !r.files['design-exports/README.md']);
});

test('Confluence as test management → connector, vocabulary, decision', () => {
  const r = buildFiles(base({ taskManagement: { tool: 'jira', baseUrl: 'https://acme.atlassian.net', projectKey: 'WEB', fields: {} },
    testManagement: { tool: 'confluence', baseUrl: 'https://acme.atlassian.net/wiki', deployment: 'cloud', spaceKey: 'QA' },
    automation: { status: 'existing', framework: 'reqnroll', repo: { cloneUrl: 'u', branch: 'main' } } }));
  assert(r.decisions.some((x) => /Test plans live in Confluence \(space QA\)/.test(x)));
  assert(/test plan page/.test(r.files['agents/agent2-test-plan-creator.md']) && /Confluence pages/.test(r.files['CLAUDE.md']));
});

test('Other task tool → ticket-files README and decision', () => {
  const r = buildFiles(base({ taskManagement: { tool: 'manual', fields: {} }, testManagement: { tool: 'csv', format: 'generic' } }));
  assert(r.files['requirements/README.md'] && r.decisions.some((x) => /requirements\/<ID>\.md/.test(x)));
});

test('Query Runner → engine examples, production writes blocked, instructions', () => {
  const r = buildFiles(base({ modules: { agent1: false, agent2: false, agent3: false, queryRunner: true },
    queryRunner: { engine: 'sqlserver', auth: 'sql', environments: [{ name: 'QA', host: 'sql-qa', database: 'App', writeAllowed: true }, { name: 'Prod', host: 'sql', database: 'App', writeAllowed: true }, { name: '', host: '' }] } }));
  assert.deepStrictEqual(r.cfg.queryRunner.environments.map((e) => [e.name, e.writeAllowed, e.port]), [['QA', true, 1433], ['Prod', false, 1433]]);
  assert(/@@VERSION/.test(r.files['queries/diagnostic/01_Database_version.sql']));
  assert(/WRITE_CONFIRMATION_REQUIRED/.test(r.files['agents/misc/query-runner.md']) && /Query Runner/.test(r.files['CLAUDE.md']));
});

test('Query Runner imports a folder of .sql files with headers', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'stuck_orders.sql'), 'SELECT * FROM Orders WHERE Status = 1');
  fs.writeFileSync(path.join(dir, 'reset.sql'), 'DELETE FROM Orders WHERE IsTest = 1');
  const r = buildFiles(base({ modules: { queryRunner: true }, queryRunner: { engine: 'postgres', environments: [{ name: 'QA', host: 'h', database: 'd' }], querySource: { type: 'folder', path: dir } } }));
  assert(/@category: imported/.test(r.files['queries/imported/sub/stuck_orders.sql']));
  assert(/@mode: write/.test(r.files['queries/imported/reset.sql']));
});

test('Bug Filing + Bug Report → tool defaults, shared bug fields, instructions', () => {
  const r = buildFiles(base({ modules: { bugFiling: true, bugReport: true }, bugReport: { publish: { enabled: true, spaceKey: 'QA' } } }));
  assert.strictEqual(r.cfg.bugFiling.fields.severity.field, 'Microsoft.VSTS.Common.Severity');
  assert.deepStrictEqual(r.cfg.taskManagement.bugFields, r.cfg.bugFiling.fields);
  assert.deepStrictEqual(r.cfg.bugReport.severityValues, ['1 - Critical', '2 - High', '3 - Medium', '4 - Low']);
  assert(!r.cfg.bugReport.publish.enabled && r.warnings.some((w) => /Confluence/.test(w)), 'publishing without Confluence is switched off');
  assert(/POSSIBLE_DUPLICATES/.test(r.files['agents/misc/bug-filing.md']) && r.files['agents/lead/bug-report.md'] && r.files['bug-evidence/README.md']);
});

console.log(`\n${n} checks passed.\n`);
