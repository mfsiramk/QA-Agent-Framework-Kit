/**
 * Wizard catalog: every choice the installer offers, its compatibility rules and
 * vocabulary. Secrets/fields for each tool come from the adapter files themselves
 * (framework/scripts/adapters/<kind>/<id>.js) so the two can never drift.
 */

const path = require('path');
const fs = require('fs');

const ADAPTERS = path.resolve(__dirname, '..', '..', 'framework', 'scripts', 'adapters');

function adapterMeta(kind, id) {
  const p = path.join(ADAPTERS, kind, `${id}.js`);
  if (!fs.existsSync(p)) return { secrets: [], fields: [], missing: true };
  try {
    delete require.cache[require.resolve(p)];
    const a = require(p);
    return { secrets: a.secrets || [], fields: a.fields || [] };
  } catch (e) {
    return { secrets: [], fields: [], error: e.message };
  }
}

const TASK_TOOLS = [
  {
    id: 'ado', label: 'Azure Boards (Azure DevOps)', icon: '🟦',
    vocab: { item: 'work item', parent: 'User Story / PBI', child: 'Task / child work item', release: 'Iteration Path' },
    releaseTypes: [{ id: 'iterationPath', label: 'Iteration Path', example: 'MyProject\\Release_{release}' }],
    qaAssigneeHint: 'A custom identity field, e.g. Custom.QAAssigned (Organization settings → Process → field reference name)',
    acDefault: 'Microsoft.VSTS.Common.AcceptanceCriteria', storyPointsDefault: 'Microsoft.VSTS.Scheduling.StoryPoints',
    excludedTypes: ['Test Case', 'Test Plan', 'Test Suite', 'Task', 'Epic'], excludedStates: ['Removed'], bugTypes: ['Bug'],
    requirementTypes: ['User Story', 'Product Backlog Item', 'Bug', 'Feature'],
  },
  {
    id: 'jira', label: 'Jira (Cloud or Data Center)', icon: '🔷',
    vocab: { item: 'issue', parent: 'Story', child: 'Sub-task', release: 'Fix Version / Sprint' },
    releaseTypes: [{ id: 'fixVersion', label: 'Fix Version', example: 'Release {release}' }, { id: 'sprint', label: 'Sprint', example: 'Sprint {release}' }, { id: 'label', label: 'Label', example: 'release-{release}' }],
    qaAssigneeHint: 'A user custom field id (e.g. customfield_10070), "label:qa-" to use labels, or "assignee"',
    acDefault: '', storyPointsDefault: 'customfield_10016',
    excludedTypes: ['Sub-task', 'Epic', 'Test', 'Test Plan', 'Test Set', 'Test Execution'], excludedStates: [], bugTypes: ['Bug'],
    requirementTypes: ['Story', 'Bug', 'Task'],
  },
  {
    id: 'github', label: 'GitHub Issues / Projects', icon: '🐙',
    vocab: { item: 'issue', parent: 'issue', child: 'sub-issue', release: 'Milestone' },
    releaseTypes: [{ id: 'milestone', label: 'Milestone', example: 'v{release}' }, { id: 'label', label: 'Label', example: 'release-{release}' }],
    qaAssigneeHint: '"label:qa:" (adds label qa:<username>) or "assignee"',
    acDefault: '', storyPointsDefault: '', excludedTypes: [], excludedStates: [], bugTypes: ['bug'], requirementTypes: [],
  },
  {
    id: 'gitlab', label: 'GitLab Issues', icon: '🦊',
    vocab: { item: 'issue', parent: 'issue', child: 'task / linked issue', release: 'Milestone' },
    releaseTypes: [{ id: 'milestone', label: 'Milestone', example: '{release}' }, { id: 'label', label: 'Label', example: 'release::{release}' }],
    qaAssigneeHint: '"label:qa::" or "assignee"',
    acDefault: '', storyPointsDefault: '', excludedTypes: [], excludedStates: [], bugTypes: ['bug'], requirementTypes: [],
  },
  {
    id: 'linear', label: 'Linear', icon: '📐',
    vocab: { item: 'issue', parent: 'issue', child: 'sub-issue', release: 'Cycle' },
    releaseTypes: [{ id: 'cycle', label: 'Cycle', example: '{release}' }, { id: 'label', label: 'Label', example: 'release-{release}' }],
    qaAssigneeHint: '"label:qa-" or "assignee"',
    acDefault: '', storyPointsDefault: '', excludedTypes: [], excludedStates: ['Canceled', 'Duplicate'], bugTypes: ['Bug'], requirementTypes: [],
  },
  {
    id: 'manual', label: 'Other tool (ServiceNow, Rally, Asana, ClickUp, Monday, Trello…)', icon: '🗂️',
    desc: 'No connector needed: QAs save each ticket as a file (template provided) or a Word export.',
    vocab: { item: 'ticket', parent: 'ticket', child: 'child ticket', release: 'release field in the ticket file' },
    releaseTypes: [{ id: 'label', label: 'Release field in the ticket file', example: 'Release {release}' }],
    qaAssigneeHint: 'Stored in the qaAssignee line of each ticket file - enter "qaAssignee".',
    acDefault: '', storyPointsDefault: '', excludedTypes: [], excludedStates: [], bugTypes: ['Bug'], requirementTypes: [],
  },
];

const TEST_TOOLS = [
  { id: 'ado-test-plans', label: 'Azure Test Plans', icon: '🧪', requires: ['ado'], vocab: { plan: 'Test Plan', suite: 'Test Suite', case: 'Test Case' } },
  { id: 'xray', label: 'Xray (Jira Cloud)', icon: '🩻', requires: ['jira'], vocab: { plan: 'Xray Test Plan', suite: 'Test Set', case: 'Test issue' } },
  { id: 'zephyr-scale', label: 'Zephyr Scale (Jira Cloud)', icon: '⚡', requires: ['jira'], vocab: { plan: 'folder', suite: 'sub-folder', case: 'test case' } },
  { id: 'testrail', label: 'TestRail', icon: '🛤️', requires: null, vocab: { plan: 'section (+ milestone)', suite: 'sub-section', case: 'case' } },
  { id: 'qase', label: 'Qase', icon: '✅', requires: null, vocab: { plan: 'suite', suite: 'child suite', case: 'case' } },
  { id: 'csv', label: 'No tool / Excel & CSV import (qTest, PractiTest, others)', icon: '📄', requires: null, vocab: { plan: 'import file', suite: 'section column', case: 'row' },
    formats: [{ id: 'generic', label: 'Generic CSV' }, { id: 'xray', label: 'Xray CSV importer' }, { id: 'zephyr-scale', label: 'Zephyr Scale CSV' }, { id: 'testrail', label: 'TestRail CSV' }, { id: 'qtest', label: 'qTest Excel/CSV' }, { id: 'azure-test-plans', label: 'Azure Test Plans CSV' }] },
];

/**
 * Where detailed requirements (SRS / BRD / functional spec) live. Several can be picked.
 * `adapter` = the connector that reads it; `mode` = 'api' (reads links directly) or
 * 'file' (QA downloads/exports the document and gives the file path - `prepare` says how).
 */
const DOC_TOOLS = [
  { id: 'confluence', adapter: 'confluence', mode: 'api', label: 'Confluence', icon: '📘', desc: 'Pages are read straight from the link.' },
  { id: 'ado-wiki', adapter: 'ado-wiki', mode: 'api', label: 'Azure DevOps Wiki', icon: '📗', desc: 'Wiki pages read from the link (uses your Azure DevOps token).' },
  { id: 'sharepoint', adapter: 'local', mode: 'file', label: 'SharePoint / OneDrive (Word, PDF)', icon: '🟦', desc: 'Download as Word or PDF, then give the file path.', prepare: 'Open the document → File → Save a copy / Download → Word (.docx). Save it in the installation\'s requirements-docs folder.' },
  { id: 'word', adapter: 'local', mode: 'file', label: 'Word / PDF files (shared drive, email)', icon: '📄', desc: 'Give the file path. .docx and PDF are read directly.', prepare: 'Save the latest version as .docx (best) or PDF. Old .doc files: open in Word → Save As → .docx.' },
  { id: 'google-docs', adapter: 'local', mode: 'file', label: 'Google Docs', icon: '🟨', desc: 'Download as Word, then give the file path.', prepare: 'Open the doc → File → Download → Microsoft Word (.docx).' },
  { id: 'notion', adapter: 'notion', mode: 'api', label: 'Notion', icon: '📓', desc: 'Pages are read straight from the link.' },
  { id: 'none', label: 'Only the ticket - no separate requirement documents', icon: '-', desc: 'Agent 1 works from the ticket\'s description, AC and comments only.' },
];

/** Where UI designs / mockups live. Several can be picked. */
const DESIGN_TOOLS = [
  { id: 'figma', adapter: 'figma', mode: 'api', label: 'Figma', icon: '🎨', desc: 'Frames and their text read straight from the link.' },
  { id: 'adobe-xd', adapter: 'files', mode: 'file', label: 'Adobe XD', icon: '🟪', desc: 'Export artboards as PNG.', prepare: 'File → Export → All Artboards → PNG, into one folder per story.' },
  { id: 'sketch', adapter: 'files', mode: 'file', label: 'Sketch', icon: '💎', desc: 'Export artboards as PNG.', prepare: 'File → Export → select the artboards → PNG, into one folder per story.' },
  { id: 'zeplin', adapter: 'files', mode: 'file', label: 'Zeplin', icon: '🟧', desc: 'Download screens as PNG.', prepare: 'Select the screens → Download → PNG, into one folder per story.' },
  { id: 'miro', adapter: 'files', mode: 'file', label: 'Miro / wireframes (Balsamiq, Axure)', icon: '🟡', desc: 'Export boards/wireframes as image or PDF.', prepare: 'Export the frames as PNG or PDF into one folder per story.' },
  { id: 'screens', adapter: 'files', mode: 'file', label: 'Screenshots / PDF mockups / PowerPoint', icon: '🖼️', desc: 'Any images or PDFs in a folder.', prepare: 'Save the screens as PNG/JPG (or one PDF) into one folder per story. From PowerPoint: File → Export → PNG.' },
  { id: 'none', label: 'No designs (or designs are inside the requirement doc)', icon: '-', desc: 'UI test cases are written from the ticket and requirement text only.' },
];

const CODE_TOOLS = [
  { id: 'ado', label: 'Azure Repos (linked on the work item)', icon: '🟦', requires: ['ado'] },
  { id: 'github', label: 'GitHub', icon: '🐙' },
  { id: 'gitlab', label: 'GitLab', icon: '🦊' },
  { id: 'bitbucket', label: 'Bitbucket Cloud', icon: '🪣' },
  { id: 'none', label: 'Skip code-change context', icon: '-' },
];

const FRAMEWORKS = [
  { id: 'specflow', label: 'SpecFlow (C#)', bdd: true, language: 'C#' },
  { id: 'reqnroll', label: 'Reqnroll (C#)', bdd: true, language: 'C#' },
  { id: 'cucumber-java', label: 'Cucumber-JVM (Java/Kotlin)', bdd: true, language: 'Java' },
  { id: 'cucumber-js', label: 'Cucumber.js (JS/TS)', bdd: true, language: 'TypeScript' },
  { id: 'playwright-bdd', label: 'Playwright + playwright-bdd', bdd: true, language: 'TypeScript' },
  { id: 'behave', label: 'Behave / pytest-bdd (Python)', bdd: true, language: 'Python' },
  { id: 'robot', label: 'Robot Framework', bdd: false, language: 'Robot' },
  { id: 'playwright', label: 'Playwright Test (no BDD)', bdd: false, language: 'TypeScript' },
  { id: 'cypress', label: 'Cypress', bdd: false, language: 'JavaScript' },
  { id: 'selenium-java', label: 'Selenium + TestNG/JUnit', bdd: false, language: 'Java' },
  { id: 'other', label: 'Something else', bdd: false, language: '' },
];

const ASSISTANTS = [
  { id: 'claude-code', label: 'Claude Code / Claude Desktop (Code tab)', file: 'CLAUDE.md' },
  { id: 'copilot', label: 'GitHub Copilot (VS Code / Visual Studio)', file: '.github/copilot-instructions.md' },
  { id: 'cursor', label: 'Cursor', file: '.cursor/rules/qa-agents.mdc' },
];

const MODULES = [
  { id: 'agent1', label: 'Agent 1 - Test Case Generator', role: 'QA Engineer', desc: 'Reads a requirement (+ child items, comments, linked code changes, BRD, designs) and writes reviewed test cases to Excel.' },
  { id: 'agent2', label: 'Agent 2 - Test Plan Creator', role: 'QA Engineer', desc: 'Pushes the QA-approved Excel into your test management tool, with a duplicate-plan guard.' },
  { id: 'agent3', label: 'Agent 3 - Feature File Generator', role: 'QA Engineer', desc: 'Turns automation-tagged test cases into Gherkin, reusing your existing step text, and hands it to the automation owner.' },
  { id: 'qaAssignment', label: 'QA Assignment - release load balancing', role: 'QA Lead', desc: 'Proposes a QA owner for every ticket in a release (plan → review → apply).' },
  { id: 'qaAudit', label: 'QA Audit - agent compliance', role: 'QA Lead', desc: 'Checks every requirement in a release for an Agent 2 test plan and an Agent 3 feature file.' },
  { id: 'bugReport', label: 'Bug Report - open bugs by severity, module, owner and age', role: 'QA Lead', desc: 'Release, last-N-days or all-open bug reports with a module × severity matrix and aging. HTML + Excel, optional Confluence page.' },
  { id: 'queryRunner', label: 'Query Runner - run saved SQL on test databases', role: 'QA Engineer', group: 'Misc tools', desc: 'Runs the team\'s saved queries (diagnostics, data lookups) against a chosen environment safely and writes an Excel + HTML report.' },
  { id: 'bugFiling', label: 'Bug Filing - draft, de-duplicate and file bugs', role: 'QA Engineer', group: 'Misc tools', desc: 'Turns what the QA describes (plus screenshots) into a complete bug, checks for open duplicates, and files it after approval.' },
];

/** Databases the Query Runner can connect to, and how users sign in to each. */
const DB_ENGINES = [
  { id: 'sqlserver', label: 'SQL Server / Azure SQL', icon: '🟥', port: 1433, driver: 'mssql', driverVersion: '^11.0.1',
    auths: [{ id: 'sql', label: 'SQL login (username + password)' }, { id: 'entra-password', label: 'Microsoft Entra ID account (username + password, no MFA)' }, { id: 'windows', label: 'Windows authentication (your Windows login - Windows PCs only)' }] },
  { id: 'postgres', label: 'PostgreSQL', icon: '🐘', port: 5432, driver: 'pg', driverVersion: '^8.13.0', auths: [{ id: 'sql', label: 'Database user (username + password)' }] },
  { id: 'mysql', label: 'MySQL / MariaDB', icon: '🐬', port: 3306, driver: 'mysql2', driverVersion: '^3.11.0', auths: [{ id: 'sql', label: 'Database user (username + password)' }] },
  { id: 'oracle', label: 'Oracle', icon: '🔴', port: 1521, driver: 'oracledb', driverVersion: '^6.6.0', auths: [{ id: 'sql', label: 'Database user (username + password)' }] },
];

/** Bug-field defaults per task tool (the wizard pre-fills these; teams adjust). */
const BUG_DEFAULTS = {
  ado: { types: ['Bug'], closedStates: ['Closed', 'Done', 'Resolved', 'Removed'], severity: { field: 'Microsoft.VSTS.Common.Severity', values: ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'] }, priority: { field: 'priority', values: ['1', '2', '3', '4'] }, environment: { field: 'description', values: ['Dev', 'QA', 'UAT', 'Production'] }, linkRels: ['related', 'parent', 'tested-by'] },
  jira: { types: ['Bug'], closedStates: ['Done', 'Closed', 'Resolved'], severity: { field: 'priority', values: ['Highest', 'High', 'Medium', 'Low', 'Lowest'] }, priority: { field: '', values: [] }, environment: { field: 'description', values: ['Dev', 'QA', 'UAT', 'Production'] }, linkRels: ['related', 'parent'] },
  github: { types: ['bug'], closedStates: ['closed'], severity: { field: 'label:severity:', values: ['critical', 'high', 'medium', 'low'] }, priority: { field: '', values: [] }, environment: { field: 'label:env:', values: ['dev', 'qa', 'uat', 'prod'] }, linkRels: ['related', 'parent'] },
  gitlab: { types: ['bug'], closedStates: ['closed'], severity: { field: 'label:severity::', values: ['critical', 'high', 'medium', 'low'] }, priority: { field: '', values: [] }, environment: { field: 'label:env::', values: ['dev', 'qa', 'uat', 'prod'] }, linkRels: ['related'] },
  linear: { types: ['Bug'], closedStates: ['Done', 'Canceled', 'Duplicate'], severity: { field: 'priority', values: ['Urgent', 'High', 'Medium', 'Low'] }, priority: { field: '', values: [] }, environment: { field: 'description', values: ['Dev', 'QA', 'UAT', 'Production'] }, linkRels: ['related'] },
  manual: { types: ['Bug'], closedStates: ['Done', 'Closed'], severity: { field: 'description', values: ['Critical', 'High', 'Medium', 'Low'] }, priority: { field: '', values: [] }, environment: { field: 'description', values: ['Dev', 'QA', 'UAT', 'Production'] }, linkRels: ['related', 'parent'] },
};

/** Optional MCP servers so the assistant can also browse the tool directly. */
const MCP = {
  ado: (c) => ({ name: 'azure-devops', config: { command: 'npx', args: ['-y', '@azure-devops/mcp', (c.orgUrl || '').replace(/\/$/, '').split('/').pop() || '<org>'] } }),
  jira: () => ({ name: 'atlassian', config: { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp' } }),
  github: () => ({ name: 'github', config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } }),
  linear: () => ({ name: 'linear', config: { type: 'http', url: 'https://mcp.linear.app/mcp' } }),
  notion: () => ({ name: 'notion', config: { type: 'http', url: 'https://mcp.notion.com/mcp' } }),
  figma: () => ({ name: 'figma', config: { type: 'http', url: 'https://mcp.figma.com/mcp' } }),
};

function catalog() {
  const withMeta = (kind, list) => list.map((t) => (t.id === 'none' ? t : { ...t, ...adapterMeta(kind, t.id) }));
  return {
    modules: MODULES,
    assistants: ASSISTANTS,
    taskTools: withMeta('task', TASK_TOOLS),
    testTools: withMeta('test', TEST_TOOLS),
    docTools: DOC_TOOLS.map((t) => (t.adapter ? { ...t, ...adapterMeta('docs', t.adapter) } : t)),
    designTools: DESIGN_TOOLS.map((t) => (t.adapter ? { ...t, ...adapterMeta('design', t.adapter) } : t)),
    codeTools: withMeta('code', CODE_TOOLS),
    frameworks: FRAMEWORKS,
    dbEngines: DB_ENGINES,
    bugDefaults: BUG_DEFAULTS,
  };
}

module.exports = { catalog, DB_ENGINES, BUG_DEFAULTS, TASK_TOOLS, TEST_TOOLS, DOC_TOOLS, DESIGN_TOOLS, CODE_TOOLS, FRAMEWORKS, ASSISTANTS, MODULES, MCP, ADAPTERS };
