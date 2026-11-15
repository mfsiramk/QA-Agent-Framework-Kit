/**
 * Turns wizard answers into the client's installation:
 *   - copies the runtime (QA-Agent-Framework-Kit/framework/*)
 *   - writes qa-framework.config.json, .env, instruction files, steering, docs
 *
 * answers = { config: <qa-framework.config.json shape>, secrets: { ENV_NAME: value }, target, options: { mcp } }
 */

const fs = require('fs');
const path = require('path');
const T = require('./templates');
const { TASK_TOOLS, TEST_TOOLS, DOC_TOOLS, DESIGN_TOOLS, CODE_TOOLS, FRAMEWORKS, ASSISTANTS, MODULES, MCP, DB_ENGINES, BUG_DEFAULTS } = require('./catalog');

const FRAMEWORK_DIR = path.resolve(__dirname, '..', '..', 'framework');
const byId = (arr, id) => arr.find((x) => x.id === id) || { id: id || 'none', label: id || 'None', vocab: {} };

/**
 * Wizard shape  { picked: ['confluence','sharepoint'], settings: { confluence: {...} } }
 * (or the older { tool: 'confluence', ... }) → { picked, sources: [{ tool: <adapter>, ...settings }] }.
 * Several picked items can share one connector (SharePoint, Word and Google Docs all use "local").
 */
function toSources(section, list) {
  const s = section || {};
  const picked = (s.picked || (s.tool ? [s.tool] : [])).filter((id) => id !== 'none' && list.some((t) => t.id === id || t.adapter === id));
  const sources = [];
  for (const id of picked) {
    const t = list.find((x) => x.id === id) || list.find((x) => x.adapter === id);
    if (sources.some((x) => x.tool === t.adapter)) continue;
    const legacy = s.tool ? Object.fromEntries(Object.entries(s).filter(([k]) => !['tool', 'picked', 'settings', 'sources'].includes(k))) : {};
    sources.push({ tool: t.adapter, ...legacy, ...((s.settings || {})[t.adapter] || {}) });
  }
  return { picked: picked.map((id) => (list.find((x) => x.id === id) || list.find((x) => x.adapter === id)).id), sources };
}

function describeSources(picked, list, noun) {
  const items = picked.map((id) => list.find((x) => x.id === id)).filter(Boolean);
  return {
    id: items.length ? 'multi' : 'none',
    items,
    label: items.length ? items.map((x) => x.label).join(' + ') : `None (${noun})`,
    api: items.filter((x) => x.mode === 'api'),
    files: items.filter((x) => x.mode === 'file'),
  };
}

/** Enforce the dependency rules; returns { cfg, warnings, decisions }. */
function normalize(input) {
  const cfg = JSON.parse(JSON.stringify(input));
  const warnings = [];
  const decisions = [];
  cfg.schemaVersion = 1;
  cfg.modules = cfg.modules || {};
  cfg.automation = cfg.automation || { status: 'none' };
  const m = cfg.modules;
  const a = cfg.automation;

  if (a.status === 'none' && !a.planned) {
    if (m.agent3) warnings.push('Agent 3 was turned off: there is no automation today and none is planned.');
    m.agent3 = false;
    decisions.push('No automation in scope → Agent 3 off, Agent 2 skips the automation-tag check, Agent 1 skips the step-reuse scan, QA Audit checks Agent 2 only.');
  }
  if (a.status === 'none' && a.planned) {
    a.status = 'planned';
  }
  if (m.agent3 && !m.agent2) { m.agent2 = true; warnings.push('Agent 2 was turned on because Agent 3 reads test cases from the test plans Agent 2 creates.'); }
  if (m.agent2 && !m.agent1) decisions.push('Agent 2 without Agent 1: your QAs supply their own Excel in the Agent 1 column layout (Title, Subject, Priority, Test Steps, Expected Result, Tags …).');
  if (m.qaAudit && !m.agent2) { warnings.push('QA Audit checks for Agent 2/3 activity, so it has nothing to audit without Agent 2. It was turned off.'); m.qaAudit = false; }

  if (a.status === 'existing') {
    const fw = byId(FRAMEWORKS, a.framework);
    a.bdd = !!fw.bdd;
    a.language = fw.language;
    decisions.push(fw.bdd
      ? `Existing ${fw.label} automation → Agent 1 must reuse canonical step text from your .feature files (steering/step-library.md, rebuilt with "npm run step-library"); Agent 3 marks only genuinely new steps as [NEW].`
      : `Existing ${fw.label} automation (not BDD) → no step text to reuse; the library becomes an index of existing test titles, and Agent 3's .feature file is the spec your engineers implement.`);
    a.repo = { localPath: 'automation-repo', ...(a.repo || {}) };
    a.delivery = { mode: 'pull-request', targetFolder: 'PendingFeatures', ...(a.delivery || {}) };
    decisions.push(`Approved feature files are delivered by ${({ 'pull-request': 'opening a pull request', 'push-branch': 'pushing a branch', local: 'copying into the local repo' })[a.delivery.mode]}.`);
  } else if (a.status === 'planned') {
    const fw = byId(FRAMEWORKS, a.framework);
    a.bdd = !!fw.bdd;
    a.language = fw.language;
    a.delivery = { mode: 'local' };
    decisions.push(`Automation planned (${fw.label || 'framework TBD'}) → Agent 3 writes approved feature files to automation-handoff/<ID>/ until a repo exists. Re-run the installer when it does.`);
  }
  if (m.agent3 && a.owner?.name && a.createTrackingTask !== false) decisions.push(`Agent 3 creates an automation task for ${a.owner.name} in ${byId(TASK_TOOLS, cfg.taskManagement?.tool).label}.`);

  const tt = byId(TEST_TOOLS, cfg.testManagement?.tool);
  if (tt.requires && !tt.requires.includes(cfg.taskManagement?.tool)) warnings.push(`${tt.label} normally needs ${tt.requires.join('/')} as the task tool.`);
  if (cfg.testManagement?.tool === 'csv') decisions.push('No test management API → Agent 2 writes an import file per requirement; Agent 3 reads it back from output/.');
  if (cfg.testManagement?.tool === 'confluence') decisions.push(`Test plans live in Confluence (space ${cfg.testManagement.spaceKey || '?'}): Agent 2 creates one page per requirement with a section per suite and a test-case table; QAs add the automation tag in the Tags column and Agent 3 reads the page back.`);

  // Requirement docs + designs: multi-source
  cfg.requirementDocs = toSources(cfg.requirementDocs, DOC_TOOLS);
  cfg.design = toSources(cfg.design, DESIGN_TOOLS);
  if (m.agent1) {
    const docs = describeSources(cfg.requirementDocs.picked, DOC_TOOLS, 'ticket only');
    const des = describeSources(cfg.design.picked, DESIGN_TOOLS, 'no designs');
    decisions.push(docs.items.length
      ? `Agent 1 combines the ticket with requirement documents from ${docs.label}. ${docs.api.length ? `${docs.api.map((x) => x.label).join(' / ')} links are read directly - including links found inside the ticket.` : ''} ${docs.files.length ? `${docs.files.map((x) => x.label).join(' / ')}: QAs download the document and give the file path (Word and PDF are read directly).` : ''}`.trim()
      : 'Agent 1 works from the ticket only (description, acceptance criteria, child items, comments).');
    if (des.items.length) decisions.push(`UI test cases are traced to design screens from ${des.label}${des.files.length ? ' (exported screens are opened as images)' : ''}.`);
  }
  if (cfg.taskManagement?.tool === 'manual') decisions.push('Tickets come from files: QAs save each ticket as requirements/<ID>.md (template provided) or <ID>.docx; agent comments and automation tasks are written next to them.');

  cfg.testManagement = { automationTag: 'Automation', ...(cfg.testManagement || {}) };
  const task = byId(TASK_TOOLS, cfg.taskManagement?.tool);
  cfg.taskManagement.fields = cfg.taskManagement.fields || {};
  cfg.taskManagement.fields.release = cfg.taskManagement.fields.release || { type: task.releaseTypes?.[0]?.id, pattern: task.releaseTypes?.[0]?.example };
  cfg.audit = { checkAgent2: true, checkAgent3: !!m.agent3, requirementTypes: task.requirementTypes || [], ...(cfg.audit || {}) };
  cfg.qaLead = { roster: [], bugAuthorRouting: true, bugTypes: task.bugTypes || ['Bug'], commentInvolvement: false, ...(cfg.qaLead || {}) };
  if ((m.qaAssignment) && !cfg.qaLead.roster.length) warnings.push('QA Assignment is on but the roster is empty - add people before running it.');
  if (m.qaAssignment && !cfg.taskManagement.fields.qaAssignee) warnings.push('QA Assignment needs a QA field (or "assignee" / "label:qa-").');

  // ── Misc tools + Bug Report ──────────────────────────────────────────────
  const bd = BUG_DEFAULTS[cfg.taskManagement?.tool] || BUG_DEFAULTS.manual;
  if (m.queryRunner) {
    const eng = byId(DB_ENGINES, cfg.queryRunner?.engine);
    cfg.queryRunner = { auth: 'sql', environments: [], sharedCredentials: true, vpnRequired: false, querySource: { type: 'examples' }, timeoutSeconds: 120, ...(cfg.queryRunner || {}) };
    cfg.queryRunner.environments = (cfg.queryRunner.environments || []).filter((e) => e && e.name && e.host)
      .map((e) => ({ ...e, port: Number(e.port) || eng.port, writeAllowed: !!e.writeAllowed && !/prod|live/i.test(e.name) }));
    if (!cfg.queryRunner.environments.length) warnings.push('Query Runner has no environments - add at least one database before running queries.');
    if ((cfg.queryRunner.environments || []).some((e) => /prod|live/i.test(e.name))) warnings.push('A production-like environment was added to Query Runner: data changes are always blocked there.');
    decisions.push(`Query Runner connects to ${eng.label} (${cfg.queryRunner.environments.map((e) => e.name).join(', ') || 'no environments yet'}). Read queries always roll back; data-changing queries need the environment name typed to confirm${cfg.queryRunner.environments.some((e) => !e.writeAllowed) ? ` and are blocked on ${cfg.queryRunner.environments.filter((e) => !e.writeAllowed).map((e) => e.name).join(', ')}` : ''}.`);
  } else delete cfg.queryRunner;
  if (m.bugFiling) {
    cfg.bugFiling = { types: bd.types, closedStates: bd.closedStates, linkToStory: true, linkRel: 'related', commentOnStory: true, duplicateCheck: true, sections: ['summary', 'steps', 'expected', 'actual', 'environment', 'testData', 'attachments'], defaults: {}, ...(cfg.bugFiling || {}) };
    cfg.bugFiling.fields = { severity: bd.severity, priority: bd.priority, environment: bd.environment, ...(cfg.bugFiling.fields || {}) };
    decisions.push(`Bug Filing drafts every bug for review, ${cfg.bugFiling.duplicateCheck ? 'checks for similar open bugs, ' : ''}then files it as "${cfg.bugFiling.types[0]}" in ${byId(TASK_TOOLS, cfg.taskManagement.tool).label}${cfg.bugFiling.linkToStory ? ' linked to the story it was found on' : ''}.`);
  } else delete cfg.bugFiling;
  if (m.bugReport) {
    cfg.bugReport = { types: cfg.bugFiling?.types || bd.types, closedStates: cfg.bugFiling?.closedStates || bd.closedStates, dimensions: ['severity', 'state', 'module', 'assignee', 'age'], defaultScope: 'release', days: 30, moduleSource: 'component', ...(cfg.bugReport || {}) };
    if (!cfg.bugReport.severityValues?.length) cfg.bugReport.severityValues = (cfg.bugFiling?.fields?.severity || cfg.bugReport.severity || bd.severity).values || [];
    if (cfg.bugReport.publish?.enabled && !cfg.requirementDocs.sources.some((s) => s.tool === 'confluence')) { warnings.push('Bug Report publishing needs Confluence as a requirement-document source - publishing was turned off.'); cfg.bugReport.publish.enabled = false; }
    decisions.push(`Bug Report covers ${cfg.bugReport.types.join(', ')} (closed = ${cfg.bugReport.closedStates.join(', ')}), grouped by ${cfg.bugReport.dimensions.join(', ')}${cfg.bugReport.publish?.enabled ? ', and can refresh a Confluence page' : ''}.`);
  } else delete cfg.bugReport;
  // Connectors read severity/priority/environment through taskManagement.bugFields.
  if (m.bugFiling || m.bugReport) cfg.taskManagement.bugFields = cfg.bugFiling?.fields || { severity: cfg.bugReport.severity || bd.severity, environment: bd.environment };
  return { cfg, warnings, decisions };
}

/** Example queries for the chosen engine (diagnostic + lookup), written into queries/. */
function exampleQueries(engine) {
  const ver = { sqlserver: 'SELECT @@VERSION AS Version, DB_NAME() AS DatabaseName, SYSDATETIME() AS ServerTime;', postgres: 'SELECT version() AS version, current_database() AS database_name, now() AS server_time;', mysql: 'SELECT VERSION() AS version, DATABASE() AS database_name, NOW() AS server_time;', oracle: "SELECT banner AS version, SYS_CONTEXT('USERENV','DB_NAME') AS database_name, SYSTIMESTAMP AS server_time FROM v$version WHERE ROWNUM = 1" }[engine];
  const big = {
    sqlserver: 'SELECT TOP 25 s.name AS SchemaName, t.name AS TableName, SUM(p.rows) AS [Rows]\nFROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id\nJOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)\nGROUP BY s.name, t.name ORDER BY [Rows] DESC;',
    postgres: 'SELECT schemaname, relname AS table_name, n_live_tup AS rows\nFROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 25;',
    mysql: 'SELECT table_schema, table_name, table_rows\nFROM information_schema.tables WHERE table_schema = DATABASE()\nORDER BY table_rows DESC LIMIT 25;',
    oracle: 'SELECT table_name, num_rows FROM user_tables ORDER BY num_rows DESC NULLS LAST FETCH FIRST 25 ROWS ONLY',
  }[engine];
  const find = {
    sqlserver: "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE\nFROM INFORMATION_SCHEMA.COLUMNS\nWHERE TABLE_NAME LIKE '%' + '{{SearchText}}' + '%' OR COLUMN_NAME LIKE '%' + '{{SearchText}}' + '%'\nORDER BY TABLE_NAME, ORDINAL_POSITION;",
    postgres: "SELECT table_schema, table_name, column_name, data_type\nFROM information_schema.columns\nWHERE table_schema NOT IN ('pg_catalog','information_schema')\n  AND (table_name ILIKE '%' || '{{SearchText}}' || '%' OR column_name ILIKE '%' || '{{SearchText}}' || '%')\nORDER BY table_name, ordinal_position;",
    mysql: "SELECT table_name, column_name, data_type\nFROM information_schema.columns\nWHERE table_schema = DATABASE() AND (table_name LIKE CONCAT('%', '{{SearchText}}', '%') OR column_name LIKE CONCAT('%', '{{SearchText}}', '%'))\nORDER BY table_name, ordinal_position;",
    oracle: "SELECT table_name, column_name, data_type FROM user_tab_columns\nWHERE UPPER(table_name) LIKE '%' || UPPER('{{SearchText}}') || '%' OR UPPER(column_name) LIKE '%' || UPPER('{{SearchText}}') || '%'\nORDER BY table_name, column_id",
  }[engine];
  return {
    'queries/diagnostic/01_Database_version.sql': `-- @name: Database version and server time\n-- @category: diagnostic\n-- @mode: read\n-- @description: Quick connectivity check - which server and database you are connected to.\n${ver}\n`,
    'queries/diagnostic/02_Largest_tables.sql': `-- @name: Largest tables (row counts)\n-- @category: diagnostic\n-- @mode: read\n-- @description: Top 25 tables by row count - useful to spot runaway test data.\n${big}\n`,
    'queries/lookup/01_Find_tables_and_columns.sql': `-- @name: Find tables / columns by name\n-- @category: lookup\n-- @mode: read\n-- @params: SearchText\n-- @description: Which table holds a field? Searches table and column names.\n${find}\n`,
  };
}

/** Copy the team's own .sql files (from a folder on this computer) into queries/imported/, adding a header where missing. */
function importQueries(dir) {
  const out = {};
  if (!dir || !fs.existsSync(dir)) return out;
  const { isWrite } = require(path.join(FRAMEWORK_DIR, 'scripts', 'misc', 'lib', 'db.js'));
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory() && !['node_modules', '.git', 'bin', 'obj'].includes(e.name)) walk(p);
    else if (e.isFile() && /\.sql$/i.test(e.name) && Object.keys(out).length < 500) {
      let sql = fs.readFileSync(p, 'utf8');
      if (!/^--\s*@name:/m.test(sql)) {
        const name = path.basename(e.name, path.extname(e.name)).replace(/[_-]+/g, ' ');
        sql = `-- @name: ${name}\n-- @category: ${isWrite(sql) ? 'setup' : 'imported'}\n-- @mode: ${isWrite(sql) ? 'write' : 'read'}\n-- @source: ${path.relative(dir, p).replace(/\\/g, '/')}\n${sql}`;
      }
      out[`queries/imported/${path.relative(dir, p).replace(/\\/g, '/')}`] = sql;
    }
  });
  walk(dir);
  return out;
}

function derive(cfg, decisions) {
  const a = cfg.automation;
  const fw = byId(FRAMEWORKS, a.framework);
  const files = { agent1: 'agents/agent1-test-case-generator.md', agent2: 'agents/agent2-test-plan-creator.md', agent3: 'agents/agent3-feature-file-generator.md', qaAssignment: 'agents/lead/qa-assignment.md', qaAudit: 'agents/lead/qa-audit.md', bugReport: 'agents/lead/bug-report.md', queryRunner: 'agents/misc/query-runner.md', bugFiling: 'agents/misc/bug-filing.md' };
  const enabledModules = MODULES.filter((x) => cfg.modules[x.id]);
  const disabledNotes = MODULES.filter((x) => !cfg.modules[x.id]).map((x) => `${x.label}${x.id === 'agent3' && a.status === 'none' ? ' - no automation in scope' : ''}`);
  return {
    cfg, m: cfg.modules, files, enabledModules, disabledNotes, decisions,
    today: new Date().toISOString().slice(0, 10),
    task: byId(TASK_TOOLS, cfg.taskManagement.tool),
    test: byId(TEST_TOOLS, cfg.testManagement.tool),
    docs: describeSources(cfg.requirementDocs.picked, DOC_TOOLS, 'ticket only'),
    design: describeSources(cfg.design.picked, DESIGN_TOOLS, 'no designs'),
    code: byId(CODE_TOOLS, cfg.codeChanges?.tool || 'none'),
    framework: fw,
    tag: cfg.testManagement.automationTag,
    hasAutomation: a.status === 'existing',
    automationInScope: a.status !== 'none' && !!cfg.modules.agent3,
    automationSummary: a.status === 'existing' ? `${fw.label} - ${a.repo?.cloneUrl || ''} (${a.repo?.branch || ''})` : a.status === 'planned' ? `Planned (${fw.label || 'TBD'}) - not set up yet` : 'None',
    assistants: ASSISTANTS.filter((x) => (cfg.assistants || ['claude-code']).includes(x.id)),
    engine: cfg.queryRunner ? byId(DB_ENGINES, cfg.queryRunner.engine) : null,
  };
}

function envFile(secrets, cfg) {
  const lines = [`# ${cfg.organization.product} QA Agents - secrets (generated ${new Date().toISOString().slice(0, 10)})`, '# Never commit this file. Replace a value here when a token expires, then run: npm run verify', ''];
  for (const [k, v] of Object.entries(secrets || {})) if (k) lines.push(`${k}=${String(v ?? '').replace(/\r?\n/g, '')}`);
  return lines.join('\n') + '\n';
}

function buildFiles(answers) {
  const { cfg, warnings, decisions } = normalize(answers.config);
  const d = derive(cfg, decisions);
  const out = {};
  const instr = T.assistantInstructions(d);
  for (const as of d.assistants) {
    if (as.id === 'cursor') out[as.file] = `---\ndescription: ${cfg.organization.product} QA agents\nalwaysApply: true\n---\n\n${instr}`;
    else out[as.file] = instr;
  }
  out['steering/common-principles.md'] = T.commonPrinciples(d);
  if (cfg.modules.agent1) out[d.files.agent1] = T.agent1(d);
  if (cfg.modules.agent2) out[d.files.agent2] = T.agent2(d);
  if (cfg.modules.agent3) out[d.files.agent3] = T.agent3(d);
  if (cfg.modules.qaAssignment) out[d.files.qaAssignment] = T.qaAssignment(d);
  if (cfg.modules.qaAudit) out[d.files.qaAudit] = T.qaAudit(d);
  if (cfg.modules.bugReport) out[d.files.bugReport] = T.bugReport(d);
  if (cfg.modules.bugFiling) { out[d.files.bugFiling] = T.bugFiling(d); out['bug-evidence/README.md'] = T.bugEvidenceReadme(d); }
  if (cfg.modules.queryRunner) {
    out[d.files.queryRunner] = T.queryRunner(d);
    out['queries/README.md'] = T.queriesReadme(d);
    const src = cfg.queryRunner.querySource || {};
    const srcDir = src.type === 'automation-repo' ? null : src.type === 'folder' ? src.path : null;
    Object.assign(out, srcDir ? importQueries(srcDir) : {}, exampleQueries(cfg.queryRunner.engine));
  }
  out['docs/GETTING-STARTED.md'] = T.gettingStarted(d);
  out['qa-framework.config.json'] = JSON.stringify(cfg, null, 2) + '\n';
  out['installer-answers.json'] = JSON.stringify({ savedAt: new Date().toISOString(), config: answers.config, secretNames: Object.keys(answers.secrets || {}), options: answers.options || {} }, null, 2) + '\n';
  out['.env'] = envFile(answers.secrets, cfg);
  out['.env.example'] = envFile(Object.fromEntries(Object.keys(answers.secrets || {}).map((k) => [k, ''])), cfg);
  out['.gitignore'] = ['.env', 'node_modules/', 'output/', 'automation-repo/', ''].join('\n');
  if (cfg.modules.agent1 && d.docs.files.length) out['requirements-docs/README.md'] = T.filesFolderReadme(d, 'docs');
  if (cfg.modules.agent1 && d.design.files.length) out['design-exports/README.md'] = T.filesFolderReadme(d, 'design');
  if (cfg.taskManagement.tool === 'manual') out['requirements/README.md'] = T.ticketFolderReadme(d);

  if (answers.options?.mcp && d.assistants.some((x) => x.id === 'claude-code')) {
    const servers = {};
    const add = (key, c) => { if (MCP[key]) { const s = MCP[key](c || {}); servers[s.name] = s.config; } };
    add(cfg.taskManagement.tool, cfg.taskManagement);
    const docTools = cfg.requirementDocs.sources.map((s) => s.tool);
    if (docTools.includes('confluence') && cfg.taskManagement.tool !== 'jira') add('jira');
    if (docTools.includes('ado-wiki') && cfg.taskManagement.tool !== 'ado') add('ado', cfg.requirementDocs.sources.find((s) => s.tool === 'ado-wiki'));
    if (docTools.includes('notion')) add('notion');
    if (cfg.design.sources.some((s) => s.tool === 'figma')) add('figma');
    if (cfg.codeChanges?.tool === 'github' && cfg.taskManagement.tool !== 'github') add('github');
    out['.mcp.json'] = JSON.stringify({ mcpServers: servers }, null, 2) + '\n';
  }
  return { files: out, warnings, decisions, cfg };
}

function copyDir(src, dst, written) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const s = path.join(src, e.name);
    const t = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, t, written);
    else { fs.copyFileSync(s, t); written.push(t); }
  }
}

/** Writes everything into answers.target. Refuses to overwrite a non-empty folder that isn't a previous install. */
function install(answers) {
  const target = path.resolve(answers.target);
  if (fs.existsSync(target) && fs.readdirSync(target).length && !fs.existsSync(path.join(target, 'qa-framework.config.json'))) {
    throw new Error(`"${target}" is not empty and is not a previous installation. Pick an empty or new folder.`);
  }
  // Keep tokens from a previous install that were not re-entered this time.
  const oldEnv = path.join(target, '.env');
  if (fs.existsSync(oldEnv)) {
    const kept = {};
    for (const line of fs.readFileSync(oldEnv, 'utf8').split(/\r?\n/)) {
      const mm = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (mm && mm[2]) kept[mm[1]] = mm[2];
    }
    answers = { ...answers, secrets: { ...kept, ...(answers.secrets || {}) } };
  }
  const built = buildFiles(answers);
  const written = [];
  copyDir(path.join(FRAMEWORK_DIR, 'scripts'), path.join(target, 'scripts'), written);
  const pkg = JSON.parse(fs.readFileSync(path.join(FRAMEWORK_DIR, 'package.json'), 'utf8'));
  if (built.cfg.queryRunner) {
    const eng = byId(DB_ENGINES, built.cfg.queryRunner.engine);
    pkg.dependencies[eng.driver] = eng.driverVersion;
    if (built.cfg.queryRunner.auth === 'windows') pkg.optionalDependencies = { msnodesqlv8: '^4.2.1' };
  }
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  for (const [rel, content] of Object.entries(built.files)) {
    const p = path.join(target, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    written.push(p);
  }
  return { target, count: written.length, warnings: built.warnings, decisions: built.decisions, generated: Object.keys(built.files) };
}

module.exports = { normalize, buildFiles, install };
