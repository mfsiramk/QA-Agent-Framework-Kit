/* QA Agent Framework - setup wizard (vanilla JS, no build step). */
(() => {
  'use strict';

  // ── state ──────────────────────────────────────────────────────────────────
  const S = {
    cat: null,
    step: 0,
    visited: new Set(['prereq']),
    prevSecrets: new Set(), // token names kept in the .env of a previous install (Load previous answers)
    skipped: new Set(), // optional modules the user skipped (shown on Review)
    sys: null,
    target: '',
    options: { mcp: false },
    secrets: {},
    conn: {}, // kind → { ok, message, fix, at }
    config: {
      organization: { company: '', product: '', shortCode: '' },
      modules: { agent1: true, agent2: true, agent3: true, queryRunner: true, bugFiling: true, qaAssignment: true, qaAudit: true, bugReport: true },
      assistants: ['claude-code'],
      taskManagement: { tool: '', fields: {} },
      testManagement: { tool: '', automationTag: 'Automation' },
      requirementDocs: { picked: [], settings: {} },
      design: { picked: [], settings: {} },
      codeChanges: { tool: 'none' },
      automation: { status: '', planned: null, framework: '', repo: { branch: 'main', localPath: 'automation-repo', featuresPath: '', stepDefinitionsPath: '' }, delivery: { mode: 'pull-request', targetFolder: 'PendingFeatures', baseBranch: '' }, owner: { name: '', email: '' }, createTrackingTask: true },
      qaLead: { roster: [], bugAuthorRouting: true, bugTypes: [], commentInvolvement: false },
      audit: { requirementTypes: [] },
      queryRunner: { engine: '', auth: 'sql', environments: [
        { name: 'Dev', host: '', port: '', database: '', writeAllowed: true },
        { name: 'QA', host: '', port: '', database: '', writeAllowed: true },
        { name: 'UAT', host: '', port: '', database: '', writeAllowed: false },
      ], sharedCredentials: true, vpnRequired: false, querySource: { type: 'examples', path: '' } },
      bugFiling: null, // filled from the task tool's defaults (see bugDefaultsFor)
      bugReport: { types: [], closedStates: [], dimensions: ['severity', 'state', 'module', 'assignee', 'age'], defaultScope: 'release', days: 30, moduleSource: 'component', severityValues: [], publish: { enabled: false, spaceKey: '', parentPageId: '', titlePrefix: 'Bug report' } },
    },
    preview: null,
    result: null,
  };
  const C = S.config;
  const m = () => C.modules;
  const anyAgent = () => m().agent1 || m().agent2 || m().agent3;
  const lead = () => m().qaAssignment || m().qaAudit || m().bugReport;
  const CORE = ['agent1', 'agent2', 'agent3']; // always set up; everything else is optional and skippable
  const MODULE_LABEL = (id) => (S.cat.modules.find((x) => x.id === id) || {}).label || id;
  /** Optional modules that will not be installed (skipped or unticked). */
  const notSetUp = () => S.cat.modules.filter((x) => !CORE.includes(x.id) && !m()[x.id]).map((x) => x.id);
  /** Skip optional modules: switch them off and remember them for the Review page. */
  function skipModules(ids) { ids.forEach((id) => { m()[id] = false; S.skipped.add(id); }); }
  /** Section heading with its own Skip button (used where one step holds several optional tools). */
  function sectionHead(title, moduleId, tip) {
    return h('div', { class: 'section-head' }, h('h2', {}, title, tip ? tipIcon(tip) : null),
      h('button', { type: 'button', class: 'ghost small', title: `Don't set up ${MODULE_LABEL(moduleId)} now`, onclick: () => {
        const stepId = visible()[S.step]?.id;
        skipModules([moduleId]); $('navErr').textContent = '';
        if (visible()[S.step]?.id !== stepId) go(S.step); else render(); // last section skipped → step is gone, move on
      } }, 'Skip'));
  }
  const needsTest = () => m().agent2 || m().agent3 || m().qaAudit;
  const automationInScope = () => C.automation.status === 'existing' || (C.automation.status === 'none' && C.automation.planned === true);

  // ── tiny DOM helper ────────────────────────────────────────────────────────
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  }
  const $ = (id) => document.getElementById(id);
  const get = (obj, p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  const set = (obj, p, v) => { const ks = p.split('.'); const last = ks.pop(); const o = ks.reduce((a, k) => (a[k] = a[k] ?? {}), obj); o[last] = v; };
  const api = async (url, body) => {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };

  // ── tooltips ───────────────────────────────────────────────────────────────
  // "What is this and why do we need it" for every wizard question, keyed by the
  // config path the field writes to. Shown as an ⓘ next to the label (hover, tap or Tab).
  const TIPS = {
    'organization.company': 'The name of YOUR organization - the company whose QA team will use these agents (for example "Contoso Ltd"). It only appears as a heading in the generated instruction files, reports and the getting-started guide. It is not used to log in anywhere.',
    'organization.product': 'The application or system your QA team tests (for example "Claims Portal", "Online Store" or "Mobile Banking App"). It titles the generated files, the step library and the QA reports. If one team tests several products, use the umbrella name, or install once per product.',
    'organization.shortCode': 'A short prefix (2-6 letters/numbers) for your product, for example Claims Portal → "CP". Agent 3 uses it in scenario tags such as @TC_CP_1234_001, so automation engineers can tell your scenarios apart. Optional; defaults to "QA".',
    target: 'The folder on this computer where the ready-to-use agent installation is created (scripts, instruction files, .env with your tokens). Choose a new or empty folder, e.g. C:\\QA\\claims-portal-qa-agents. Pointing at a previous installation updates it.',
    'fields.acceptanceCriteria': 'Where acceptance criteria (AC) are written on a story. Agent 1 builds test cases from them. Azure Boards has a standard AC field; in Jira it is often a custom field (customfield_xxxxx). Leave empty if AC is written inside the description under an "Acceptance Criteria" heading.',
    'fields.storyPoints': 'The field that holds story points. QA Assignment uses it as a tie-breaker so each QA gets a fair amount of work, not just the same number of tickets.',
    'fields.release.type': 'How your team groups tickets into a release. QA Assignment and QA Audit pull "all tickets in release N" using this.',
    'fields.release.pattern': 'The exact name of a release with {release} where the number goes. If your iteration is called "Portal\\Release_52", the pattern is "Portal\\Release_{release}" and you would then say "QA assignment for release 52".',
    'fields.qaAssignee': 'Where the assigned QA is stored on each ticket. QA Assignment writes ONLY this field. Use a field reference (e.g. Custom.QAAssigned), "label:qa-" to use labels like qa-priya, or "assignee" to use the normal assignee.',
    excludedTypes: 'Ticket types that never need a QA owner or an audit (test cases, tasks, epics…). Comma-separated, spelled exactly as in your tool.',
    excludedStates: 'Ticket states to skip, e.g. Removed or Cancelled. Comma-separated.',
    'automation.repo.cloneUrl': 'The address you use with "git clone" for your automated test code. Agents read it to reuse your existing step wording; only Agent 3\'s delivery script writes to it, always on its own branch.',
    'automation.repo.branch': 'The branch your automation team works on (for example main or develop). The agents read the latest steps from it.',
    'automation.repo.localPath': 'Name of the sub-folder (inside your installation) where the automation repo is cloned. The default is fine for almost everyone.',
    'automation.repo.featuresPath': 'Folder inside the automation repo that contains the .feature files, e.g. Tests/Features. Leave empty to scan the whole repo.',
    'automation.repo.stepDefinitionsPath': 'Folder inside the automation repo with the step-definition code ([Given]/[When]/[Then] methods). Leave empty to scan the whole repo.',
    'automation.delivery.mode': 'How an approved feature file reaches the automation team. "Pull request" is recommended: it creates a branch and a PR they review. "Push a branch" skips the PR. "Local only" just copies the file.',
    'automation.delivery.targetFolder': 'Folder in the automation repo where new feature files are placed for the automation team to pick up, e.g. PendingFeatures.',
    'automation.delivery.baseBranch': 'The branch the pull request targets. Usually the same as the main branch above.',
    'automation.owner.name': 'The automation engineer who turns approved feature files into working tests. Agent 3 creates a tracking task for this person. Use the name exactly as it appears in your task tool.',
    'automation.owner.email': 'The login email or username of the automation engineer in your task tool. Needed to assign the tracking task to them.',
    'automation.createTrackingTask': 'When on, Agent 3 creates a task under the story, assigned to the automation engineer, every time a feature file is delivered. This is how the work gets tracked.',
    'automation.framework': 'The test framework you plan to use. It decides whether Agent 3 writes BDD steps you can run directly or a specification your engineers implement.',
    automationTag: 'The tag QA reviewers add to test cases that should be automated (in the Excel or in the test tool). Only tagged test cases become Gherkin scenarios in Agent 3.',
    deployment: '"Cloud" if the site address ends in atlassian.net. "Data Center / Server" if your company hosts it on its own server.',
    format: 'Which tool you will import the generated CSV file into. Pick "Generic CSV" for a plain spreadsheet.',
    'qaLead.bugAuthorRouting': 'When on, a bug is assigned to the QA who reported it, because they know how to reproduce and verify it. This rule beats every other rule.',
    'qaLead.bugTypes': 'Ticket types that count as bugs for the rule above, e.g. Bug, Test Bug, Prod Bug.',
    'qaLead.commentInvolvement': 'When on, tickets that no other rule matched go to the roster QA who commented on them most recently. More accurate, but slower: it reads every ticket\'s comments.',
    'audit.requirementTypes': 'Which ticket types should have a test plan, e.g. User Story, Bug. Leave empty to audit every ticket in the release.',
    'options.mcp': 'Optional. MCP servers let Claude open your tools (Jira, Azure DevOps, Figma…) directly while chatting, in addition to the agent scripts. Each one asks you to sign in on first use. Not needed for the agents to work.',
    'modules.agent1': 'For QA engineers. Give it a story ID; it reads the story, child items, comments, linked code changes, BRD and designs, and writes reviewed test cases to an Excel file for you to check.',
    'modules.agent2': 'For QA engineers. Takes the Excel you approved and creates the test plan, suites and test cases in your test management tool. It never creates a duplicate plan.',
    'modules.agent3': 'For QA engineers. Takes the automation-tagged test cases and writes a Gherkin .feature file reusing your existing step text, then hands it to the automation engineer.',
    'modules.qaAssignment': 'For QA leads. Proposes a QA owner for every ticket in a release (by bug author, subject expertise, workload), lets you edit it in a web page, then writes it to the tool.',
    'modules.qaAudit': 'For QA leads. Checks every story in a release: was a test plan created (Agent 2)? Was a feature file delivered (Agent 3)? Produces a FAIL / PARTIAL / PASS report per QA.',
    'modules.bugReport': 'For QA leads. Ask for "bug report for release 12" or "open bugs": counts by severity, module, developer, QA and age, with a module × severity matrix. Read-only; HTML + Excel, optionally a Confluence page.',
    'modules.queryRunner': 'For QA engineers. "Run the stuck-orders query on QA" - runs the team\'s saved SQL against a test database and returns Excel + HTML. Read queries can never change data; data-changing ones need the environment name typed to confirm.',
    'modules.bugFiling': 'For QA engineers. Describe the problem in plain words (plus screenshots) and get a complete bug in your team\'s format, with a duplicate check and a draft to approve before anything is filed.',
  };
  const ROSTER_TIPS = {
    Name: 'Full name exactly as it appears in your task tool.',
    'Email / username': 'Login email or username in the task tool. Used to assign tickets and to recognise who filed a bug.',
    Pool: 'General pool: shares the normal workload. Reserved: a specialist who only gets tickets matching their reserved keywords. Excluded: never assigned.',
    'Subject keywords': 'Topics this QA owns, e.g. Payments, Checkout. Tickets whose title, tags or component mention one go to this QA first.',
    'Reserved keywords': 'For specialists only, e.g. Performance. Matching tickets go to them, and they stay out of the general pool.',
  };

  /** Why each connector setting is needed (keys come from the adapter files). */
  const FIELD_TIPS = {
    orgUrl: (t) => `The web address of your ${t} organization, e.g. https://dev.azure.com/YourOrg. Copy it from the browser address bar when you are in Azure DevOps.`,
    project: (t) => `The ${t} project your team works in, exactly as named (case and spaces included).`,
    baseUrl: (t) => `The address of your ${t} site as you open it in the browser, without anything after the domain (no /browse/…, no /projects/…).`,
    projectKey: (t) => `The short project key shown in ticket IDs. If tickets look like WEB-123, the key is WEB.`,
    owner: () => 'The GitHub user or organization that owns the repository: the first part of github.com/<owner>/<repo>.',
    repo: () => 'The repository name: the second part of github.com/<owner>/<repo>.',
    apiUrl: () => 'Only needed for self-hosted / Enterprise servers. Leave as is for the normal cloud service.',
    projectPath: () => 'The part of the project URL after the domain, e.g. gitlab.com/my-group/my-project → my-group/my-project.',
    teamKey: () => 'The team key used in Linear issue IDs. If issues look like ENG-42, the key is ENG.',
    repos: () => 'The code repositories developers commit to. Agent 1 looks here for the commits and pull requests that mention a ticket, so it knows what actually changed (read-only).',
    projects: () => 'The code projects developers commit to. Agent 1 looks here for merge requests and commits mentioning a ticket (read-only).',
    workspace: () => 'Your Bitbucket workspace: the first part of bitbucket.org/<workspace>/<repo>.',
    projectId: (t) => `The numeric ID of your ${t} project. Open the project; the number after "P" in the address (e.g. …/projects/overview/7 → 7).`,
    suiteId: (t) => `Only for ${t} projects that use multiple test suites. Leave empty if you use a single repository.`,
    tagsField: (t) => `Optional: the system name of a text custom field in ${t} for tags. If empty, tags are stored in the preconditions text.`,
    projectCode: (t) => `The short code of your ${t} project, shown in case IDs (e.g. DEMO-12 → DEMO).`,
    linkType: () => 'The Jira link type used to link a test to its story. "Test" is the Xray default; change only if your admin renamed it.',
  };

  function tipIcon(text) {
    if (!text || !String(text).trim()) return null;
    return h('span', { class: 'tip', tabindex: '0', role: 'button', 'aria-label': `Help: ${text}`, 'data-tip': text, onclick: (e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.toggle('open'); } }, 'i');
  }
  const tipFor = (path, explicit) => explicit || TIPS[path];
  const eg = (p) => (p && !/^(e\.g\.|example|leave|paste)/i.test(p) ? `e.g. ${p}` : p);

  // ── field widgets ──────────────────────────────────────────────────────────
  function textField(label, path, { placeholder, help, required, full, type = 'text', root = C, onchange, tip } = {}) {
    return h('label', { class: `f${full ? ' full' : ''}` },
      h('span', { class: required ? 'req' : '' }, label, tipIcon(tipFor(path, tip))),
      h('input', { type, value: get(root, path) ?? '', placeholder: eg(placeholder), oninput: (e) => { set(root, path, e.target.value); onchange && onchange(); } }),
      help ? h('span', { class: 'h' }, help) : null);
  }
  function selectField(label, path, options, { help, full, root = C, onchange, tip } = {}) {
    const cur = get(root, path) ?? '';
    return h('label', { class: `f${full ? ' full' : ''}` }, h('span', {}, label, tipIcon(tipFor(path, tip))),
      h('select', { onchange: (e) => { set(root, path, e.target.value); onchange ? onchange() : render(); } },
        options.map((o) => h('option', { value: o.id, selected: o.id === cur ? true : null }, o.label))),
      help ? h('span', { class: 'h' }, help) : null);
  }
  function listField(label, path, opts = {}) {
    const root = opts.root || C;
    return h('label', { class: `f${opts.full ? ' full' : ''}` }, h('span', {}, label, tipIcon(tipFor(path, opts.tip))),
      h('input', { type: 'text', value: (get(root, path) || []).join(', '), placeholder: eg(opts.placeholder), oninput: (e) => set(root, path, e.target.value.split(',').map((s) => s.trim()).filter(Boolean)) }),
      opts.help ? h('span', { class: 'h' }, opts.help) : null);
  }
  function checkbox(label, desc, path, { root = C, disabled, onchange, tip } = {}) {
    return h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: !!get(root, path), disabled, onchange: (e) => { set(root, path, e.target.checked); onchange ? onchange() : render(); } }),
      h('div', {}, h('div', { class: 'b' }, h('b', {}, label), tipIcon(tipFor(path, tip))), desc ? h('div', { class: 'd' }, desc) : null));
  }
  function seg(path, options, { root = C, onchange } = {}) {
    const cur = get(root, path);
    return h('div', { class: 'seg' }, options.map((o) => h('button', { type: 'button', class: cur === o.id ? 'on' : '', onclick: () => { set(root, path, o.id); onchange && onchange(); render(); } }, o.label)));
  }
  function cards(list, path, { isDisabled, tagFor, onpick } = {}) {
    const cur = get(C, path);
    return h('div', { class: 'cards' }, list.map((t) => {
      const dis = isDisabled ? isDisabled(t) : null;
      return h('button', { type: 'button', class: `card${cur === t.id ? ' sel' : ''}${dis ? ' disabled' : ''}`, title: dis || '', onclick: () => { if (dis) return; set(C, path, t.id); onpick && onpick(t); render(); } },
        h('div', { class: 't' }, h('span', {}, t.icon || ''), t.label, tagFor && tagFor(t) ? h('span', { class: 'tag' }, tagFor(t)) : null),
        dis ? h('div', { class: 'd' }, dis) : (t.desc ? h('div', { class: 'd' }, t.desc) : null));
    }));
  }
  const note = (kind, ...kids) => h('div', { class: `note ${kind}` }, ...kids);

  /** Where to create each token (opened in a new tab from the wizard). */
  function tokenLink(env, section = {}) {
    const base = String(section.baseUrl || section.orgUrl || '').replace(/\/+$/, '');
    const L = {
      ADO_PAT: base && /dev\.azure\.com|visualstudio\.com/.test(base) ? `${base}/_usersSettings/tokens` : 'https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate',
      JIRA_API_TOKEN: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      CONFLUENCE_API_TOKEN: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      JIRA_PAT: 'https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html',
      CONFLUENCE_PAT: 'https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html',
      FIGMA_ACCESS_TOKEN: 'https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens',
      GITHUB_TOKEN: 'https://github.com/settings/personal-access-tokens/new',
      GITLAB_TOKEN: `${base && !/gitlab\.com$/.test(base) ? base : 'https://gitlab.com'}/-/user_settings/personal_access_tokens`,
      LINEAR_API_KEY: 'https://linear.app/settings/account/security',
      TESTRAIL_API_KEY: base ? `${base}/index.php?/mysettings` : 'https://support.testrail.com/hc/en-us/articles/7077039051284-Accessing-the-TestRail-API',
      XRAY_CLIENT_ID: 'https://docs.getxray.app/display/XRAYCLOUD/Global+Settings%3A+API+Keys',
      XRAY_CLIENT_SECRET: 'https://docs.getxray.app/display/XRAYCLOUD/Global+Settings%3A+API+Keys',
      ZEPHYR_API_TOKEN: 'https://support.smartbear.com/zephyr-scale-cloud/docs/en/rest-api/generating-api-access-tokens.html',
      QASE_API_TOKEN: 'https://app.qase.io/user/api/token',
      NOTION_TOKEN: 'https://www.notion.so/my-integrations',
      BITBUCKET_APP_PASSWORD: 'https://bitbucket.org/account/settings/app-passwords/',
    };
    return L[env] || null;
  }

  /** Error text if a selected tool's tokens are still empty (tokens kept from a previous install count as present). */
  function needTokens(tool, section = {}) {
    if (!tool || tool.mode === 'file' || ['none', 'csv', 'manual', 'local', 'files'].includes(tool.adapter || tool.id)) return null;
    const missing = secretsFor(tool, section.deployment || 'cloud').filter((s) => !String(S.secrets[s.env] || '').trim() && !S.prevSecrets.has(s.env));
    return missing.length ? `${tool.label}: enter ${missing.map((s) => s.label.replace(/\s*\(.*?\)\s*/g, ' ').trim()).join(' and ')} - use "Get it here" next to the field.` : null;
  }

  /** Tokens that apply to this deployment (Cloud vs Data Center / Server). */
  function secretsFor(tool, deployment = 'cloud') {
    return (tool.secrets || []).filter((s) => {
      const l = `${s.label} ${s.help}`;
      if (/cloud only/i.test(l) && deployment === 'server') return false;
      if (/(data center|server)( \/ server)? only/i.test(l) && deployment !== 'server') return false;
      return true;
    });
  }

  /** Adapter-driven fields + secrets + Test connection button. */
  function toolPanel(kind, tool, section, connKey = kind) {
    if (!tool || tool.id === 'none') return null;
    const adapterId = tool.adapter || tool.id;
    if ((tool.fields || []).some((f) => f.key === 'deployment') && !section.deployment) section.deployment = 'cloud';
    if (tool.formats && !section.format) section.format = 'generic';
    const deployment = section.deployment || 'cloud';
    const fields = (tool.fields || []).map((f) => {
      if (f.key === 'deployment') return selectField(f.label, 'deployment', [{ id: 'cloud', label: 'Cloud (atlassian.net)' }, { id: 'server', label: 'Data Center / Server' }], { root: section, help: f.help, onchange: render });
      if (f.key === 'format' && tool.formats) return selectField(f.label, 'format', tool.formats, { root: section, help: f.help });
      if (section[f.key] === undefined && f.default !== undefined) section[f.key] = f.default;
      const why = FIELD_TIPS[f.key] ? FIELD_TIPS[f.key](tool.label) : null;
      return textField(f.label, f.key, { root: section, placeholder: f.placeholder, help: f.help, required: f.required, tip: why || f.help || ' ' });
    });
    const visibleSecrets = secretsFor(tool, deployment);
    const kept = (env) => S.prevSecrets.has(env) && !S.secrets[env];
    const secrets = visibleSecrets.map((s) => {
      const isLogin = /email|user/i.test(s.env);
      const link = isLogin ? null : tokenLink(s.env, section);
      return h('label', { class: 'f' },
        h('span', { class: 'req' }, s.label, h('span', { class: 'muted' }, `  (${s.env})`), tipIcon(isLogin
          ? `The login that goes with the token below. The agents act in ${tool.label} as this user, so it needs the permissions listed underneath.`
          : `A secret key that lets the agents use ${tool.label} on your behalf, instead of your password. It is saved only in the .env file of your installation on this computer, and you can revoke it in ${tool.label} at any time. Paste it exactly, without spaces.`)),
        h('input', { type: isLogin ? 'text' : 'password', autocomplete: 'off', value: S.secrets[s.env] || '', placeholder: kept(s.env) ? 'kept from your previous installation - leave empty to keep it' : (isLogin ? 'e.g. you@company.com' : 'paste the token here'), oninput: (e) => { S.secrets[s.env] = e.target.value; } }),
        h('span', { class: 'h' }, s.help || '', link ? [' ', h('a', { href: link, target: '_blank', rel: 'noopener' }, 'Get it here ↗')] : null));
    });
    const missing = visibleSecrets.filter((s) => !/email|user/i.test(s.env) && !String(S.secrets[s.env] || '').trim() && !S.prevSecrets.has(s.env));
    const st = S.conn[connKey];
    return h('div', { class: 'panel' },
      connKey !== kind ? h('div', { class: 'panel-title' }, tool.icon || '', ' ', tool.label) : null,
      missing.length ? h('div', { class: 'note warn token-call' }, '🔑 ', h('b', {}, `${tool.label} needs ${missing.length > 1 ? 'these API tokens' : 'an API token'}`), ' so the agents can read', kind === 'test' || kind === 'task' ? ' and write' : '', ' on your behalf. It takes about a minute: ',
        missing.map((s, i) => [i ? ' · ' : '', tokenLink(s.env, section) ? h('a', { href: tokenLink(s.env, section), target: '_blank', rel: 'noopener' }, `create the ${s.label.replace(/\s*\(.*?\)\s*/g, ' ').trim()} ↗`) : s.label]), ', then paste it below.') : null,
      h('div', { class: 'grid' }, fields, secrets),
      (tool.secrets || []).length ? note('info', '🔒 Tokens stay on this computer: they are written only to the .env file of your installation, never sent anywhere else.') : null,
      h('div', { class: 'conn' },
        h('button', { type: 'button', class: 'ghost', onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'Testing…';
          try {
            S.conn[connKey] = { ...(await api('/api/test-connection', { kind, tool: adapterId, config: section, secrets: S.secrets, task: C.taskManagement })), at: Date.now() };
          } catch (err) { S.conn[connKey] = { ok: false, message: err.message }; }
          render();
        } }, 'Test connection'),
        tipIcon('Checks the values above against the real tool right now (read-only, nothing is changed). Green means the agents will be able to connect. You can still continue if it fails and fix it later with "npm run verify".'),
        st ? h('span', { class: `pill ${st.ok ? 'ok' : 'bad'}` }, st.ok ? 'Connected' : 'Failed') : h('span', { class: 'pill idle' }, 'Not tested'),
        st ? h('span', { class: 'msg' }, st.message, st.fix && !st.ok ? h('div', { class: 'h' }, '→ ', st.fix) : null) : null));
  }

  /** Bug Filing settings, pre-filled from the task tool's defaults (re-filled if the tool changes). */
  function bugDefaultsFor() {
    const tool = C.taskManagement.tool || 'manual';
    if (!C.bugFiling || C.bugFiling._tool !== tool) {
      const d = JSON.parse(JSON.stringify(S.cat.bugDefaults[tool] || S.cat.bugDefaults.manual));
      C.bugFiling = { _tool: tool, types: d.types, closedStates: d.closedStates, fields: { severity: d.severity, priority: d.priority, environment: d.environment },
        linkToStory: true, linkRel: d.linkRels[0], commentOnStory: true, duplicateCheck: true,
        sections: ['summary', 'steps', 'expected', 'actual', 'environment', 'testData', 'attachments'], defaults: { component: '', assignee: { name: '', id: '' }, tags: [] } };
    }
    return C.bugFiling;
  }

  /** QA lead step → Bug Report questions. Shares bug types / states / severity with Bug Filing when both are on. */
  function bugReportSection() {
    const r = C.bugReport;
    const d = S.cat.bugDefaults[C.taskManagement.tool] || S.cat.bugDefaults.manual;
    const shared = m().bugFiling ? bugDefaultsFor() : null;
    if (!r.types.length) r.types = [...(shared?.types || d.types)];
    if (!r.closedStates.length) r.closedStates = [...(shared?.closedStates || d.closedStates)];
    if (!r.severityValues.length) r.severityValues = [...((shared?.fields.severity || d.severity).values || [])];
    if (!r.severity) r.severity = { ...(shared?.fields.severity || d.severity) };
    const DIMS = [['severity', 'Severity'], ['state', 'State'], ['module', 'Module'], ['assignee', 'Assigned developer'], ['reporter', 'Reporting QA'], ['environment', 'Environment'], ['release', 'Release'], ['age', 'Age of open bugs']];
    // Agent 1 on → Confluence comes from the Requirement documents step. Agent 1 off → connect it right here.
    const inlineConfluence = !m().agent1;
    const hasConfluence = C.requirementDocs.picked.includes('confluence') || inlineConfluence;
    const confTool = S.cat.docTools.find((x) => x.id === 'confluence');
    const onPublish = () => {
      if (inlineConfluence) {
        const p = C.requirementDocs.picked.filter((x) => x !== 'none' && x !== 'confluence');
        C.requirementDocs.picked = r.publish.enabled ? [...p, 'confluence'] : p;
        C.requirementDocs.settings.confluence = C.requirementDocs.settings.confluence || {};
      }
      render();
    };
    return [
      sectionHead('🐞 Bug Report', 'bugReport', 'A read-only report the lead can ask for any time: "bug report for release 12", "open bugs", "bugs in the last 30 days". HTML + Excel; nothing is changed in the tool.'),
      h('div', { class: 'panel' }, h('div', { class: 'grid' },
        listField('Bug types to include', 'bugReport.types', { placeholder: 'Bug, Prod Bug', tip: 'Every item type that counts as a bug, exactly as named in your tool (e.g. Bug, Test Bug, Prod Bug, UAT Bug).' }),
        listField('States that mean "closed"', 'bugReport.closedStates', { placeholder: 'Closed, Done', tip: 'Anything not in this list counts as open. Include states like Resolved if your team treats them as done.' }),
        shared ? null : textField('Severity field', 'bugReport.severity.field', { placeholder: 'Microsoft.VSTS.Common.Severity', tip: 'Where severity is stored on bugs: a field reference, "priority", or "label:severity:".' }),
        listField('Severity order (most severe first)', 'bugReport.severityValues', { placeholder: 'Critical, High, Medium, Low', tip: 'Used to sort the report and to show "open Critical" at the top.' }),
        selectField('Module / feature area comes from', 'bugReport.moduleSource', [{ id: 'component', label: 'Component / area path' }, { id: 'titlePrefix', label: 'A prefix in the title, e.g. "[Checkout] …"' }, { id: 'tags', label: 'Tags / labels' }], { tip: 'How the report knows which part of the product a bug belongs to - pick whatever your team fills in reliably.' }),
        selectField('Default scope when the lead doesn\'t say', 'bugReport.defaultScope', [{ id: 'release', label: 'Ask for a release' }, { id: 'days', label: 'Last N days' }, { id: 'open', label: 'All open bugs' }], { tip: 'What "bug report" means when no release or period is given.' }),
        r.defaultScope === 'days' ? textField('N (days)', 'bugReport.days', { placeholder: '30' }) : null)),
      h('p', {}, h('b', {}, 'Break the report down by'), tipIcon('Each ticked item becomes a table (and an Excel sheet). Module × severity is always included.')),
      h('div', { class: 'cards' }, DIMS.map(([id, label]) => { const on = r.dimensions.includes(id); return h('button', { type: 'button', class: `card${on ? ' sel' : ''}`, onclick: () => { r.dimensions = on ? r.dimensions.filter((x) => x !== id) : [...r.dimensions, id]; render(); } }, h('div', { class: 't' }, h('span', { class: 'ck' }, on ? '☑' : '☐'), label)); })),
      hasConfluence
        ? [checkbox('Also publish the report to a Confluence page', 'The lead says "publish the bug report" and one page is created / refreshed (same title each time).', 'bugReport.publish.enabled', { onchange: onPublish, tip: inlineConfluence ? 'Connect Confluence below. The token needs permission to create and edit pages in that space.' : 'Uses the Confluence connection from the Requirement documents step. The token needs permission to create and edit pages in that space.' }),
          r.publish.enabled && inlineConfluence ? toolPanel('docs', confTool, C.requirementDocs.settings.confluence, 'docs:confluence') : null,
          r.publish.enabled ? h('div', { class: 'panel' }, h('div', { class: 'grid' },
            textField('Confluence space key', 'bugReport.publish.spaceKey', { required: true, placeholder: 'QA', tip: 'The short key of the space, shown in page addresses: …/spaces/QA/…' }),
            textField('Parent page ID (optional)', 'bugReport.publish.parentPageId', { placeholder: '123456789', tip: 'The page the report should live under - the number in its address (…/pages/123456789/…). Leave empty for the space root.' }),
            textField('Page title prefix', 'bugReport.publish.titlePrefix', { placeholder: 'Bug report', tip: 'The page is titled "<prefix> - Release 12" (or "- All open bugs").' }))) : null]
        : note('info', 'Want the report on a Confluence page too? Add Confluence in the Requirement documents step and this option appears.'),
    ];
  }

  // ── requirement sources (ticket + docs + design + code) ────────────────────
  /** The "how Agent 1 builds test cases" strip, highlighting the current step's source. */
  function sourceFlow(active) {
    const short = (s) => String(s || '').replace(/\s*\(.*?\)/g, '').split(/\s+\/\s+|\s+-\s+/)[0];
    const picked = (sec, list) => sec.picked.map((id) => list.find((x) => x.id === id)).filter(Boolean).map((x) => (x.id === 'none' ? 'None' : short(x.label))).join(', ');
    const taskLabel = short(S.cat.taskTools.find((x) => x.id === C.taskManagement.tool)?.label);
    const box = (id, icon, title, job, chosen) => h('div', { class: `flow-box${active === id ? ' on' : ''}` },
      h('div', { class: 'flow-t' }, icon, ' ', title), h('div', { class: 'flow-j' }, job), chosen ? h('div', { class: 'flow-c' }, chosen) : null);
    return h('div', { class: 'flow' },
      box('ticket', '🎫', 'Ticket', 'Scope & acceptance criteria', taskLabel),
      h('span', { class: 'flow-op' }, '+'),
      box('docs', '📄', 'Requirement docs', 'Business rules & edge cases', picked(C.requirementDocs, S.cat.docTools)),
      h('span', { class: 'flow-op' }, '+'),
      box('design', '🎨', 'Designs', 'Screen text & UI states', picked(C.design, S.cat.designTools)),
      h('span', { class: 'flow-op' }, '+'),
      box('code', '🧑‍💻', 'Code changes', 'Regression areas', C.codeChanges.tool !== 'none' ? S.cat.codeTools.find((x) => x.id === C.codeChanges.tool)?.label : ''),
      h('span', { class: 'flow-op' }, '→'),
      h('div', { class: 'flow-box out' }, h('div', { class: 'flow-t' }, '🧪 Agent 1'), h('div', { class: 'flow-j' }, 'Test cases that cover all of it')));
  }

  /** Multi-select cards; "none" is exclusive. */
  function multiCards(list, section, kind) {
    return h('div', { class: 'cards' }, list.map((t) => {
      const on = section.picked.includes(t.id);
      return h('button', { type: 'button', class: `card${on ? ' sel' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: () => {
        if (t.id === 'none') section.picked = on ? [] : ['none'];
        else section.picked = on ? section.picked.filter((x) => x !== t.id) : [...section.picked.filter((x) => x !== 'none'), t.id];
        Object.keys(S.conn).filter((k) => k.startsWith(`${kind}:`)).forEach((k) => { if (!section.picked.some((id) => k === `${kind}:${list.find((x) => x.id === id)?.adapter}`)) delete S.conn[k]; });
        render();
      } },
      h('div', { class: 't' }, h('span', { class: 'ck' }, on ? '☑' : '☐'), h('span', {}, t.icon || ''), t.label,
        t.mode ? h('span', { class: `tag ${t.mode}` }, t.mode === 'api' ? 'reads links' : 'file / export') : null),
      t.desc ? h('div', { class: 'd' }, t.desc) : null);
    }));
  }

  /** Connection panel per API source; "how to prepare" panel for file-based sources. */
  function sourcePanels(kind, list, section) {
    const items = section.picked.map((id) => list.find((x) => x.id === id)).filter((x) => x && x.id !== 'none');
    const api = items.filter((x) => x.mode === 'api');
    const files = items.filter((x) => x.mode === 'file');
    const seen = new Set();
    const out = [];
    for (const t of api) {
      if (seen.has(t.adapter)) continue;
      seen.add(t.adapter);
      section.settings[t.adapter] = section.settings[t.adapter] || {};
      if (t.adapter === 'ado-wiki' && C.taskManagement.tool === 'ado') out.push(note('info', 'Azure DevOps Wiki uses your Azure Boards organization, project and token - just test the connection.'));
      out.push(toolPanel(kind, t, section.settings[t.adapter], `${kind}:${t.adapter}`));
    }
    if (files.length) {
      const folder = kind === 'docs' ? 'requirements-docs' : 'design-exports';
      out.push(h('div', { class: 'panel' },
        h('div', { class: 'panel-title' }, kind === 'docs' ? '📁 Documents you download as files' : '📁 Screens you export as files',
          tipIcon(kind === 'docs' ? 'These tools have no simple API for reading documents, so the QA downloads the document (Word is best) and gives Agent 1 the file path. Word .docx files are read directly; PDFs are opened by the assistant.' : 'These tools have no simple API, so the designer exports the screens as images or PDF. Agent 1 opens each image and uses the file names as screen references in test cases.')),
        h('ul', { class: 'tight' }, files.map((x) => h('li', {}, h('b', {}, x.label), ': ', x.prepare))),
        h('p', { class: 'muted' }, 'Save them in the ', h('code', {}, `${folder}/`), ' folder of the installation (a README with these steps is created there). No account or token needed.')));
    }
    return out;
  }

  /** First missing token among the picked API sources of a multi-select step. */
  function sourceTokens(list, section) {
    for (const id of section.picked) {
      const t = list.find((x) => x.id === id);
      if (t && t.mode === 'api') { const e = needTokens(t, (section.settings || {})[t.adapter] || {}); if (e) return e; }
    }
    return null;
  }

  function missingFields(list, section) {
    for (const id of section.picked) {
      const t = list.find((x) => x.id === id);
      if (!t || t.mode !== 'api') continue;
      const set = section.settings[t.adapter] || {};
      const miss = (t.fields || []).filter((f) => f.required && !String(set[f.key] || '').trim());
      if (miss.length) return `${t.label}: fill in ${miss.map((f) => f.label).join(', ')}`;
    }
    return null;
  }

  // ── technology prerequisites ───────────────────────────────────────────────
  const LINKS = {
    node: 'https://nodejs.org/en/download',
    git: 'https://git-scm.com/downloads',
    claude: 'https://claude.ai/download',
    vscode: 'https://code.visualstudio.com/download',
    cursor: 'https://cursor.com/downloads',
  };
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  function checkRow(name, status, detail, why, fix) {
    return h('tr', {},
      h('td', {}, h('b', {}, name), h('div', { class: 'h' }, why)),
      h('td', {}, h('span', { class: `pill ${status}` }, { ok: 'Installed', bad: 'Missing', warn: 'Not found', idle: 'Checking…', info: 'Can\'t detect' }[status])),
      h('td', {}, detail || '', fix ? h('div', { class: 'h' }, fix) : null));
  }
  async function loadSys() { S.sys = null; render(); try { S.sys = await api('/api/system-check'); } catch (e) { S.sys = { error: e.message }; } render(); }

  /** Everything a team member needs, derived from the answers so far. */
  function needsList() {
    const tool = (list, id) => S.cat[list].find((x) => x.id === id);
    const machine = [
      ['Node.js 18 or newer', 'Runs the agent scripts.', LINKS.node],
      ['Git', C.automation.status === 'existing' ? 'Required: clones your automation repo and delivers approved feature files.' : 'Recommended: to keep the installation folder under version control.', LINKS.git],
      ...C.assistants.map((a) => ({
        'claude-code': ['Claude Code or the Claude desktop app', 'The AI assistant that runs the agents.', LINKS.claude],
        copilot: ['VS Code (or Visual Studio) with GitHub Copilot Chat', 'The AI assistant that runs the agents. Needs a Copilot licence.', LINKS.vscode],
        cursor: ['Cursor', 'The AI assistant that runs the agents.', LINKS.cursor],
      })[a]),
      ['Excel, or anything that opens .xlsx', 'QAs review the Agent 1 test cases in Excel.', null],
    ];
    const access = [];
    const addTool = (t, why, section = {}) => {
      if (!t || t.id === 'none' || t.mode === 'file' || ['csv', 'manual'].includes(t.id)) return;
      const toks = secretsFor(t, section.deployment || 'cloud').map((s) => s.env);
      access.push([`${t.label} account`, `${why}${toks.length ? ` · tokens: ${toks.join(', ')}` : ''}`]);
    };
    const docSettings = (id, sec) => (sec.settings || {})[(tool('docTools', id) || {}).adapter] || {};
    addTool(tool('taskTools', C.taskManagement.tool), 'Read tickets, post comments' + (m().agent3 && automationInScope() && C.automation.createTrackingTask ? ', create tasks' : '') + (m().qaAssignment ? ', edit the QA field' : ''), C.taskManagement);
    if (C.taskManagement.tool === 'manual') access.push(['Ticket files', 'QAs save each ticket as requirements/<ID>.md (template provided) or a Word export']);
    if (needsTest()) addTool(tool('testTools', C.testManagement.tool), 'Create test plans and test cases');
    if (m().agent1) {
      C.requirementDocs.picked.forEach((id) => addTool(tool('docTools', id), 'Read requirement pages', docSettings(id, C.requirementDocs)));
      const docFiles = C.requirementDocs.picked.map((id) => tool('docTools', id)).filter((t) => t?.mode === 'file');
      if (docFiles.length) access.push([`Access to the documents in ${docFiles.map((t) => t.label).join(', ')}`, 'To download them as Word/PDF for Agent 1']);
      C.design.picked.forEach((id) => addTool(tool('designTools', id), 'Read design files'));
      const desFiles = C.design.picked.map((id) => tool('designTools', id)).filter((t) => t?.mode === 'file');
      if (desFiles.length) access.push([`Exported screens from ${desFiles.map((t) => t.label).join(', ')}`, 'Designers export PNG/PDF into design-exports/']);
      addTool(tool('codeTools', C.codeChanges.tool), 'Read commits and pull requests (read-only)');
    }
    if (C.automation.status === 'existing') access.push(['Automation repository access', `Clone ${C.automation.repo.cloneUrl || 'the repo'}${C.automation.delivery.mode !== 'local' ? ', push a branch' : ''}${C.automation.delivery.mode === 'pull-request' ? ', open pull requests' : ''}`]);
    if (m().queryRunner && C.queryRunner.engine) {
      const eng = S.cat.dbEngines.find((e) => e.id === C.queryRunner.engine);
      const envs = C.queryRunner.environments.filter((e) => e.name).map((e) => e.name).join(', ');
      access.push([`${eng.label} access (${envs || 'test environments'})`, `${C.queryRunner.auth === 'windows' ? 'Their Windows login must have database access' : C.queryRunner.sharedCredentials ? 'One shared database login (DB_USER / DB_PASSWORD) - read-only is enough except where data changes are allowed' : 'A database login per environment'}${C.queryRunner.vpnRequired ? '; VPN connected while running queries' : ''}`]);
    }
    if (m().bugFiling) access.push(['Permission to create bugs', `Create ${(bugDefaultsFor().types || ['Bug'])[0]} items${['ado', 'jira', 'gitlab'].includes(C.taskManagement.tool) ? ' and add attachments' : ''} in the task tool (same token as above)`]);
    if (m().bugReport && C.bugReport.publish.enabled) access.push(['Confluence edit permission', `Create and edit pages in space ${C.bugReport.publish.spaceKey || '(space key)'}`]);
    const notNeeded = ['Admin rights on the computer', 'A database, Docker or cloud hosting', C.automation.status === 'existing' ? `The ${S.cat.frameworks.find((f) => f.id === C.automation.framework)?.language || 'automation'} runtime: the agents only read and write text files. Only the engineers who run the tests need it.` : null].filter(Boolean);
    return { machine, access, notNeeded };
  }

  // ── steps ──────────────────────────────────────────────────────────────────
  const STEPS = [
    {
      id: 'prereq', title: 'Before you start', show: () => true,
      render: () => {
        const s = S.sys;
        const st = (v) => (!s ? 'idle' : v ? 'ok' : 'warn');
        return [
          h('h1', {}, 'Before you start'),
          h('p', { class: 'lead' }, 'Here is the technology the QA agents need. This page checks what is already installed on this computer.'),
          s?.error ? note('bad', s.error) : null,
          h('div', { class: 'panel' },
            h('table', { class: 'roster' },
              h('thead', {}, h('tr', {}, h('th', {}, 'Technology'), h('th', {}, 'Status'), h('th', {}, 'Details'))),
              h('tbody', {},
                checkRow('Node.js 18+', !s ? 'idle' : s.nodeOk ? 'ok' : 'bad', s ? `v${s.node}` : '', 'Required. Runs this wizard and the agent scripts.', s && !s.nodeOk ? h('span', {}, 'Install the LTS version from ', link(LINKS.node, 'nodejs.org')) : null),
                checkRow('npm', !s ? 'idle' : s.npm ? 'ok' : 'bad', s?.npm ? `v${s.npm}` : '', 'Required. Installs the scripts\' one dependency (Excel support). It comes with Node.js.', s && !s.npm ? 'Reinstall Node.js; npm is included.' : null),
                checkRow('Git', st(s?.git), s?.git || '', 'Required if you have an automation repository, recommended otherwise.', s && !s.git ? h('span', {}, 'Install from ', link(LINKS.git, 'git-scm.com')) : null),
                checkRow('AI assistant', !s ? 'idle' : (s.claude || s.code) ? 'ok' : 'info', [s?.claude ? `Claude Code ${s.claude}` : null, s?.code ? `VS Code ${s.code.split(' ')[0]}` : null].filter(Boolean).join(' · ') || 'Claude desktop app, Copilot in Visual Studio and Cursor can\'t be detected from here.', 'Required. At least one of Claude Code / Claude desktop app, GitHub Copilot (VS Code or Visual Studio), or Cursor.',
                  s && !s.claude && !s.code ? h('span', {}, 'Get ', link(LINKS.claude, 'Claude'), ', ', link(LINKS.vscode, 'VS Code + Copilot'), ' or ', link(LINKS.cursor, 'Cursor'), '.') : null)))),
          h('div', { class: 'conn' }, h('button', { type: 'button', class: 'ghost small', onclick: loadSys }, 'Check again'), s && !s.error ? h('span', { class: 'msg' }, s.os) : null),
          h('h2', {}, 'Accounts and access'),
          h('ul', { class: 'tight' },
            h('li', {}, 'An account in your ', h('b', {}, 'task management tool'), ' (Azure Boards, Jira, GitHub, GitLab or Linear), with permission to create an API token.'),
            h('li', {}, 'An account in your ', h('b', {}, 'test management tool'), ', if you use one (Azure Test Plans, Xray, Zephyr Scale, TestRail or Qase).'),
            h('li', {}, 'Optional: access to requirement docs (Confluence or Notion), Figma, and the code repositories.'),
            h('li', {}, 'If you already have automated tests: read access to that repository, plus permission to push a branch.'),
            h('li', {}, 'Network access to those tools from this computer (connect to the VPN if your tools need it).')),
          h('h2', {}, 'Not needed'),
          h('ul', { class: 'tight' }, h('li', {}, 'Admin rights, a database, Docker or cloud hosting.'), h('li', {}, 'Your test framework\'s runtime (.NET, Java, Python…): the agents only read and write text files.')),
          note('info', 'The wizard shows exactly which accounts and tokens you need for the tools you pick, with step-by-step help to create each token.'),
        ];
      },
      validate: () => (S.sys && !S.sys.error && !S.sys.nodeOk ? 'Node.js 18 or newer is required. Install it, then restart the installer.' : null),
    },
    {
      id: 'welcome', title: 'Welcome', show: () => true,
      render: () => [
        h('h1', {}, 'Set up your QA agents'),
        h('p', { class: 'lead' }, 'Answer a few questions about how your team works. The wizard adapts as you go and writes a ready-to-use installation folder - instruction files for your AI assistant, connectors for your tools, and configuration. Takes about 10 minutes.'),
        h('div', { class: 'panel' }, h('div', { class: 'grid' },
          textField('Your company name', 'organization.company', { required: true, placeholder: 'Contoso Ltd', help: 'The organization whose QA team will use the agents.' }),
          textField('Application under test', 'organization.product', { required: true, placeholder: 'Claims Portal', help: 'The product or system your QA team tests.' }),
          textField('Short code', 'organization.shortCode', { placeholder: 'CP', help: 'Prefix for scenario tags, e.g. @TC_CP_1234_001. Letters/numbers only.' }),
          textField('Install into folder', 'target', { root: S, required: true, placeholder: 'C:\\QA\\claims-portal-qa-agents', help: 'A new or empty folder. Re-running into a previous installation updates it.' }))),
        note('info', 'You need: access to your task management tool, your test management tool (if any), and permission to create API tokens. Each step shows exactly where to get them.'),
      ],
      validate: () => (!C.organization.company.trim() || !C.organization.product.trim() ? 'Enter the company and product name.' : !S.target.trim() ? 'Choose an install folder.' : null),
    },
    {
      id: 'modules', title: 'What to set up', show: () => true,
      render: () => {
        CORE.forEach((id) => { m()[id] = true; });
        const core = S.cat.modules.filter((x) => CORE.includes(x.id)).map((x) => h('div', { class: 'check core' },
          h('input', { type: 'checkbox', checked: true, disabled: true, 'aria-label': `${x.label} (always included)` }),
          h('div', {}, h('div', { class: 'b' }, h('b', {}, x.label), h('span', { class: 'pill ok', style: 'margin-left:8px' }, 'Always included'), tipIcon(TIPS[`modules.${x.id}`])),
            h('div', { class: 'd' }, x.desc, x.id === 'agent3' ? ' (Switched off automatically if you have no test automation and none is planned.)' : ''))));
        const optional = (role, grp) => S.cat.modules.filter((x) => !CORE.includes(x.id) && x.role === role && (x.group || '') === (grp || '')).map((x) => checkbox(x.label, x.desc, `modules.${x.id}`, { onchange: () => { S.skipped.delete(x.id); render(); } }));
        return [
          h('h1', {}, 'What should we set up?'),
          h('p', { class: 'lead' }, 'The three agents are the core and are always set up. Everything else is optional: it is ticked so you can see its questions, and every optional step has a Skip button if you don\'t need it now.'),
          h('h2', {}, '👩‍💻 Core agents (QA engineers)'), core,
          h('h2', {}, '🧰 Optional - misc tools for QA engineers', tipIcon('Stand-alone helpers that work with or without the agents: run saved database queries, and file well-formed bugs.')), optional('QA Engineer', 'Misc tools'),
          h('h2', {}, '🧑‍✈️ Optional - QA lead tools'), optional('QA Lead'),
          note('info', 'Not sure yet? Leave them ticked and press Skip on any step you don\'t want - you can add skipped tools later by re-running this wizard.'),
        ];
      },
      validate: () => null,
    },
    {
      id: 'assistant', title: 'AI assistant', show: () => true,
      render: () => [
        h('h1', {}, 'Which AI assistant will your team use?'),
        h('p', { class: 'lead' }, 'The agents are instructions + scripts your assistant runs. We write the instruction file each assistant reads. Pick all that apply.'),
        S.cat.assistants.map((a) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: C.assistants.includes(a.id), onchange: (e) => { C.assistants = e.target.checked ? [...new Set([...C.assistants, a.id])] : C.assistants.filter((x) => x !== a.id); render(); } }),
          h('div', {}, h('b', {}, a.label), tipIcon({
            'claude-code': 'Anthropic\'s Claude, used through the Claude Code terminal tool or the Code tab of the Claude desktop app. It reads CLAUDE.md in the installation folder to learn the agents. Needs a Claude Pro, Max, Team or Enterprise plan.',
            copilot: 'GitHub Copilot Chat in VS Code or Visual Studio. It reads .github/copilot-instructions.md. Use agent mode so it can run the scripts. Needs a Copilot licence.',
            cursor: 'The Cursor editor. It reads the rule file in .cursor/rules. Use agent mode so it can run the scripts.',
          }[a.id]), h('div', { class: 'd' }, 'Writes ', h('code', {}, a.file))))),
        C.assistants.includes('claude-code') ? checkbox('Also add MCP servers for our tools (optional)', 'Lets Claude browse your tools directly in addition to the scripts. Each server asks you to sign in the first time it is used.', 'options.mcp', { root: S }) : null,
      ],
      validate: () => (!C.assistants.length ? 'Pick at least one assistant.' : null),
    },
    {
      id: 'task', title: 'Task management', show: () => true,
      render: () => {
        const t = S.cat.taskTools.find((x) => x.id === C.taskManagement.tool);
        const tm = C.taskManagement;
        return [
          h('h1', {}, 'Where are your tickets tracked?', tipIcon('Your task management tool: where user stories, bugs and releases are tracked. Agents read each ticket (description, acceptance criteria, child items, comments) from here and post their audit comments back.')),
          h('p', { class: 'lead' }, 'The tool that holds user stories, bugs and releases.'),
          m().agent1 ? sourceFlow('ticket') : null,
          cards(S.cat.taskTools, 'taskManagement.tool', { onpick: (tool) => {
            const keep = { tool: tool.id, fields: { acceptanceCriteria: tool.acDefault, storyPoints: tool.storyPointsDefault, release: { type: tool.releaseTypes[0].id, pattern: tool.releaseTypes[0].example }, qaAssignee: tool.id === 'manual' ? 'qaAssignee' : '' }, excludedTypes: tool.excludedTypes, excludedStates: tool.excludedStates };
            S.config.taskManagement = keep; delete S.conn.task; delete S.conn.test; delete S.conn.code;
            C.qaLead.bugTypes = tool.bugTypes; C.audit.requirementTypes = tool.requirementTypes;
            if (S.cat.testTools.find((x) => x.id === C.testManagement.tool)?.requires && !S.cat.testTools.find((x) => x.id === C.testManagement.tool).requires.includes(tool.id)) C.testManagement.tool = '';
          } }),
          t ? [
            h('h2', {}, `Connect ${t.label}`),
            toolPanel('task', t, S.config.taskManagement),
            h('h2', {}, 'How your team uses it'),
            h('div', { class: 'panel' }, h('div', { class: 'grid' },
              textField('Acceptance criteria field', 'fields.acceptanceCriteria', { root: S.config.taskManagement, placeholder: t.acDefault || 'leave empty = read the "Acceptance Criteria" section of the description', help: t.id === 'jira' ? 'Custom field id if AC has its own field (e.g. customfield_10050). Empty = parse from the description.' : t.acDefault ? 'Default is fine unless your process uses a custom field.' : 'Leave empty - the agent reads an "Acceptance Criteria" heading in the description.' }),
              t.id === 'ado' || t.id === 'jira' ? textField('Story points field', 'fields.storyPoints', { root: S.config.taskManagement, placeholder: t.storyPointsDefault }) : null,
              lead() ? [
                selectField(`Releases are identified by`, 'fields.release.type', t.releaseTypes, { root: S.config.taskManagement, onchange: () => { const rt = t.releaseTypes.find((r) => r.id === S.config.taskManagement.fields.release.type); S.config.taskManagement.fields.release.pattern = rt.example; render(); } }),
                textField('Release name pattern', 'fields.release.pattern', { root: S.config.taskManagement, required: true, help: 'Use {release} where the release number goes. Example: "Release 12" → pattern "Release {release}".' }),
                m().qaAssignment ? textField('QA owner field', 'fields.qaAssignee', { root: S.config.taskManagement, required: true, placeholder: t.id === 'ado' ? 'Custom.QAAssigned' : t.id === 'jira' ? 'customfield_10070' : 'label:qa-', help: t.qaAssigneeHint }) : null,
                listField('Ignore these item types', 'excludedTypes', { root: S.config.taskManagement, help: 'Comma-separated. Not assigned or audited.' }),
                listField('Ignore these states', 'excludedStates', { root: S.config.taskManagement }),
              ] : null)),
          ] : null,
        ];
      },
      validate: () => {
        const tm = C.taskManagement;
        if (!tm.tool) return 'Pick your task management tool.';
        const t = S.cat.taskTools.find((x) => x.id === tm.tool);
        const miss = (t.fields || []).filter((f) => f.required && !String(tm[f.key] || '').trim()).map((f) => f.label);
        if (miss.length) return `Fill in: ${miss.join(', ')}`;
        if (m().qaAssignment && !tm.fields.qaAssignee) return 'QA Assignment needs the QA owner field.';
        return needTokens(t, tm);
      },
    },
    {
      id: 'docs', title: 'Requirement documents', show: () => m().agent1,
      render: () => [
        h('h1', {}, 'Where are the detailed requirements written?', tipIcon('A ticket usually says WHAT is built in this sprint. The full rules - validations, roles, calculations, error cases - normally live in a bigger document: SRS, BRD, functional spec or wiki page. Agent 1 reads both, so test cases cover the real business rules, not just the ticket summary.')),
        h('p', { class: 'lead' }, 'SRS, BRD, functional specs, wiki pages. Pick every place your team uses.'),
        sourceFlow('docs'),
        multiCards(S.cat.docTools, C.requirementDocs, 'docs'),
        sourcePanels('docs', S.cat.docTools, C.requirementDocs),
        C.requirementDocs.picked.length ? note('info', '🔎 You won\'t need to paste links every time: Agent 1 finds document links inside the ticket (description, AC, comments) and reads them automatically. It asks only when none are found.') : null,
      ],
      validate: () => (!C.requirementDocs.picked.length ? 'Pick where requirements are written, or "Only the ticket".' : missingFields(S.cat.docTools, C.requirementDocs) || sourceTokens(S.cat.docTools, C.requirementDocs)),
    },
    {
      id: 'design', title: 'Design artifacts', show: () => m().agent1,
      render: () => [
        h('h1', {}, 'Where do the UI designs live?', tipIcon('Designs give the exact screen text, button labels, error messages and states (empty, loading, error). Agent 1 uses them so UI test cases check what the user should really see, and each UI test case cites the screen it came from.')),
        h('p', { class: 'lead' }, 'Mockups, prototypes, wireframes. Pick every tool your designers use.'),
        sourceFlow('design'),
        multiCards(S.cat.designTools, C.design, 'design'),
        sourcePanels('design', S.cat.designTools, C.design),
      ],
      validate: () => (!C.design.picked.length ? 'Pick where designs live, or "No designs".' : missingFields(S.cat.designTools, C.design) || sourceTokens(S.cat.designTools, C.design)),
    },
    {
      id: 'code', title: 'Code changes', show: () => m().agent1,
      render: () => {
        const code = S.cat.codeTools.find((x) => x.id === C.codeChanges.tool);
        return [
          h('h1', {}, 'Where does the development team commit code?', tipIcon('Optional but valuable: the commits and pull requests linked to a ticket show which screens, APIs and modules really changed, so Agent 1 adds regression tests for those areas. Read-only - the agents never modify code.')),
          h('p', { class: 'lead' }, 'Agent 1 looks up the commits and pull requests linked to a ticket to see what actually changed (read-only).'),
          cards(S.cat.codeTools, 'codeChanges.tool', {
            isDisabled: (x) => (x.requires && !x.requires.includes(C.taskManagement.tool) ? 'Only with Azure Boards' : null),
            onpick: (x) => { S.config.codeChanges = { tool: x.id }; delete S.conn.code; },
          }),
          code && code.id !== 'none' ? [code.id === 'ado' ? note('info', 'Reads commits/PRs linked on the work item, using your Azure Boards connection.') : null, toolPanel('code', code, S.config.codeChanges)] : null,
        ];
      },
      validate: () => {
        const t = S.cat.codeTools.find((x) => x.id === C.codeChanges.tool);
        const miss = (t?.fields || []).filter((f) => f.required && !String(C.codeChanges[f.key] || '').trim() && C.codeChanges.tool !== 'ado');
        return miss.length ? `Fill in: ${miss.map((f) => f.label).join(', ')}` : needTokens(t, C.codeChanges);
      },
    },
    {
      id: 'automation', title: 'Test automation', show: () => anyAgent() || m().qaAudit,
      render: () => {
        const a = C.automation;
        const fw = S.cat.frameworks.find((f) => f.id === a.framework);
        return [
          h('h1', {}, 'Do you already have automated tests?', tipIcon('Automated tests = UI/API test code your team already runs (SpecFlow, Cucumber, Playwright, Selenium…) kept in a git repository. Answer "No" if testing is manual today.')),
          h('p', { class: 'lead' }, 'This decides how the agents write steps: with existing BDD automation, every new test reuses your step wording so it needs no new code.'),
          seg('automation.status', [{ id: 'existing', label: 'Yes, we have automation' }, { id: 'none', label: 'No, not yet' }], { onchange: () => { delete S.conn.automation; } }),
          a.status === 'existing' ? [
            h('h2', {}, 'Your framework'),
            h('div', { class: 'cards' }, S.cat.frameworks.map((f) => h('button', { type: 'button', class: `card${a.framework === f.id ? ' sel' : ''}`, onclick: () => { a.framework = f.id; render(); } }, h('div', { class: 't' }, f.label, h('span', { class: 'tag' }, f.bdd ? 'BDD' : 'code'))))),
            fw ? note(fw.bdd ? 'ok' : 'info', fw.bdd ? '✔ BDD framework: Agent 1 will reuse your existing step text, Agent 3 will only mark genuinely new steps.' : 'ℹ Not BDD: Agent 3 still produces a Gherkin file, used as the specification your engineers implement. Agent 1 uses your existing test titles to avoid duplicates.') : null,
            h('h2', {}, 'Automation repository'),
            h('div', { class: 'panel' }, h('div', { class: 'grid' },
              textField('Git clone URL', 'automation.repo.cloneUrl', { required: true, full: true, placeholder: 'https://github.com/acme/ui-tests.git', help: 'Uses your normal git credentials. Agents read it; only Agent 3\'s delivery script writes to it (on its own branch).' }),
              textField('Main branch', 'automation.repo.branch', { required: true, placeholder: 'main' }),
              textField('Local folder name', 'automation.repo.localPath', { placeholder: 'automation-repo', help: 'Cloned inside your installation folder.' }),
              fw?.bdd !== false ? textField('Feature files folder (in the repo)', 'automation.repo.featuresPath', { placeholder: 'src/Features' }) : null,
              fw?.bdd !== false ? textField('Step definitions folder (in the repo)', 'automation.repo.stepDefinitionsPath', { placeholder: 'src/StepDefinitions' }) : null)),
          ] : null,
          a.status === 'none' ? [
            h('h2', {}, 'Do you plan to start automating?', tipIcon('Yes: Agent 3 stays on and saves approved feature files locally until you have a repository. No: Agent 3 is switched off and nothing automation-related is asked of your QAs.')),
            seg('automation.planned', [{ id: true, label: 'Yes, soon' }, { id: false, label: 'No' }]),
            a.planned === true ? [
              h('p', {}, 'Which framework are you planning? (pick "Something else" if undecided)'),
              selectField('Planned framework', 'automation.framework', [{ id: '', label: '- choose -' }, ...S.cat.frameworks]),
              note('info', 'Agent 3 will write approved feature files to an automation-handoff/ folder until your repo exists. Re-run the wizard then to connect it.'),
            ] : null,
            a.planned === false ? note('warn', 'No automation in scope: Agent 3 will be switched off, Agent 2 skips the automation-tag check, and QA Audit checks Agent 2 only.') : null,
          ] : null,
          automationInScope() && m().agent3 ? [
            h('h2', {}, 'Handing over approved feature files'),
            h('div', { class: 'panel' }, h('div', { class: 'grid' },
              a.status === 'existing' ? selectField('Delivery', 'automation.delivery.mode', [{ id: 'pull-request', label: 'Open a pull request (recommended)' }, { id: 'push-branch', label: 'Push a branch only' }, { id: 'local', label: 'Copy into the local repo only' }]) : null,
              a.status === 'existing' ? textField('Folder for new feature files', 'automation.delivery.targetFolder', { placeholder: 'PendingFeatures' }) : null,
              a.status === 'existing' && a.delivery.mode !== 'local' ? textField('Pull request / base branch', 'automation.delivery.baseBranch', { placeholder: a.repo.branch || 'main' }) : null,
              textField('Automation owner - name', 'automation.owner.name', { placeholder: 'Jane Doe', help: 'Gets a tracking task for every approved feature file.' }),
              textField('Automation owner - email / username', 'automation.owner.email', { placeholder: 'jane@acme.com' }),
              h('div', { class: 'full' }, checkbox('Create a tracking task in the task tool for the automation owner', null, 'automation.createTrackingTask')))),
          ] : null,
        ];
      },
      validate: () => {
        const a = C.automation;
        if (!a.status) return 'Tell us whether you have automation today.';
        if (a.status === 'existing' && !a.framework) return 'Pick your framework.';
        if (a.status === 'existing' && (!a.repo.cloneUrl || !a.repo.branch)) return 'Enter the repository URL and branch.';
        if (a.status === 'none' && a.planned === null) return 'Do you plan to automate?';
        return null;
      },
    },
    {
      id: 'test', title: 'Test management', show: () => needsTest(),
      render: () => {
        const t = S.cat.testTools.find((x) => x.id === C.testManagement.tool);
        const taskLabel = S.cat.taskTools.find((x) => x.id === C.taskManagement.tool)?.label;
        return [
          h('h1', {}, 'Where should test plans and test cases go?'),
          h('p', { class: 'lead' }, 'Agent 2 creates the plan here; Agent 3 reads the automation-tagged cases back. No tool? Pick the CSV option - you get an import file.'),
          cards(S.cat.testTools, 'testManagement.tool', {
            isDisabled: (x) => (x.requires && !x.requires.includes(C.taskManagement.tool) ? `Needs ${x.requires.map((r) => S.cat.taskTools.find((tt) => tt.id === r)?.label).join(' / ')} (you chose ${taskLabel || 'none'})` : null),
            onpick: (x) => {
              const keep = { tool: x.id, automationTag: C.testManagement.automationTag || 'Automation' };
              if (x.id === 'csv') keep.format = 'generic';
              if (x.id === 'confluence') { const doc = C.requirementDocs.settings?.confluence || {}; keep.baseUrl = doc.baseUrl || ''; keep.deployment = doc.deployment || 'cloud'; }
              S.config.testManagement = keep; delete S.conn.test;
            },
          }),
          t ? [
            t.fields?.length || t.secrets?.length ? h('h2', {}, `Connect ${t.label}`) : null,
            t.id === 'ado-test-plans' ? note('info', 'Uses the same Azure DevOps organization, project and token as Azure Boards.') : null,
            toolPanel('test', t, S.config.testManagement),
            automationInScope() && m().agent3 ? h('div', { class: 'panel' }, h('div', { class: 'grid' }, textField('Automation tag', 'automationTag', { root: S.config.testManagement, required: true, help: 'QA reviewers add this tag to test cases that should be automated. Only tagged cases reach Agent 3.' }))) : null,
          ] : null,
        ];
      },
      validate: () => {
        const tm = C.testManagement;
        if (!tm.tool) return 'Pick a test management option.';
        const t = S.cat.testTools.find((x) => x.id === tm.tool);
        const miss = (t.fields || []).filter((f) => f.required && !String(tm[f.key] || '').trim()).map((f) => f.label);
        return miss.length ? `Fill in: ${miss.join(', ')}` : needTokens(t, tm);
      },
    },
    {
      id: 'query', title: 'Query Runner', show: () => m().queryRunner, skip: ['queryRunner'],
      render: () => {
        const q = C.queryRunner;
        const eng = S.cat.dbEngines.find((e) => e.id === q.engine);
        const envKey = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
        const secretRow = (env, label) => h('label', { class: 'f' }, h('span', {}, label, h('span', { class: 'muted' }, `  (${env})`), tipIcon('Saved only in the .env file of your installation. Use a read-only database account where possible - the Query Runner never needs more than your testers already have.')),
          h('input', { type: /PASSWORD/.test(env) ? 'password' : 'text', autocomplete: 'off', value: S.secrets[env] || '', oninput: (e) => { S.secrets[env] = e.target.value; } }));
        const envRow = (e, i) => h('tr', {},
          h('td', {}, h('input', { type: 'text', value: e.name, placeholder: 'e.g. QA', oninput: (ev) => { e.name = ev.target.value; } })),
          h('td', {}, h('input', { type: 'text', value: e.host, placeholder: q.engine === 'sqlserver' ? 'e.g. sql-qa.contoso.local' : 'e.g. db-qa.contoso.local', oninput: (ev) => { e.host = ev.target.value; } })),
          h('td', { style: 'width:90px' }, h('input', { type: 'text', value: e.port, placeholder: String(eng?.port || ''), oninput: (ev) => { e.port = ev.target.value; } })),
          h('td', {}, h('input', { type: 'text', value: e.database, placeholder: q.engine === 'oracle' ? 'e.g. ORCLPDB1 (service name)' : 'e.g. ClaimsDb', oninput: (ev) => { e.database = ev.target.value; } })),
          h('td', { style: 'text-align:center' }, /prod|live/i.test(e.name) ? h('span', { class: 'pill bad', title: 'Always blocked on production-like environments' }, 'Blocked') : h('input', { type: 'checkbox', checked: !!e.writeAllowed, onchange: (ev) => { e.writeAllowed = ev.target.checked; } })),
          h('td', {}, h('button', { type: 'button', class: 'ghost small', onclick: async (ev) => {
            ev.target.textContent = '…';
            try { S.conn[`db:${i}`] = await api('/api/tcp-check', { host: e.host, port: Number(e.port) || eng?.port }); } catch (err) { S.conn[`db:${i}`] = { ok: false, message: err.message }; }
            render();
          } }, 'Check'), S.conn[`db:${i}`] ? h('div', { class: `h ${S.conn[`db:${i}`].ok ? 'okc' : 'badc'}` }, S.conn[`db:${i}`].message) : null),
          h('td', {}, h('button', { type: 'button', class: 'ghost small', onclick: () => { q.environments.splice(i, 1); render(); } }, 'Remove')));
        return [
          h('h1', {}, 'Query Runner', tipIcon('Lets QAs run the team\'s saved SQL (health checks, test-data lookups, cleanup scripts) on a test database by just asking - results come back as Excel + HTML. Read queries can never change data.')),
          h('p', { class: 'lead' }, 'Which database do your test environments use, and how do testers connect?'),
          h('h2', {}, '1. Database engine'),
          h('div', { class: 'cards' }, S.cat.dbEngines.map((x) => h('button', { type: 'button', class: `card${q.engine === x.id ? ' sel' : ''}`, onclick: () => { q.engine = x.id; q.auth = x.auths[0].id; render(); } }, h('div', { class: 't' }, x.icon, ' ', x.label)))),
          eng ? [
            h('h2', {}, '2. How do testers sign in to the database?', tipIcon('Use the same kind of account your testers use in SQL tools today. A shared read-only service account is the safest choice.')),
            h('div', { class: 'panel' }, h('div', { class: 'grid' },
              selectField('Sign-in method', 'queryRunner.auth', eng.auths, { tip: 'SQL login = a database username and password. Entra ID = your company Microsoft account (accounts that require MFA prompts cannot be used by scripts - use a service account). Windows authentication = your own Windows login, no password stored.' }),
              q.auth !== 'windows' ? h('label', { class: 'check full' }, h('input', { type: 'checkbox', checked: !q.sharedCredentials, onchange: (ev) => { q.sharedCredentials = !ev.target.checked; render(); } }), h('div', {}, h('b', {}, 'Each environment has a different login'), tipIcon('Tick this if, for example, QA and UAT use different database accounts. You can then enter a login per environment.'))) : null),
              q.auth === 'windows' ? note('info', 'Windows authentication uses the logged-in Windows user - nothing is stored. Works on Windows PCs only.') : null,
              q.auth !== 'windows' ? h('div', { class: 'grid', style: 'margin-top:10px' }, q.sharedCredentials
                ? [secretRow('DB_USER', 'Database username'), secretRow('DB_PASSWORD', 'Database password')]
                : q.environments.filter((e) => e.name).flatMap((e) => [secretRow(`DB_${envKey(e.name)}_USER`, `${e.name} username`), secretRow(`DB_${envKey(e.name)}_PASSWORD`, `${e.name} password`)])) : null),
            h('h2', {}, '3. Environments', tipIcon('One row per test database. "Allow data changes" lets setup/cleanup queries run there after the tester types the environment name; leave it off for shared or production-like databases. Production / Live are always blocked.')),
            h('div', { class: 'panel' },
              h('table', { class: 'roster' }, h('thead', {}, h('tr', {}, ['Name', 'Server / host', 'Port', 'Database', 'Allow data changes', 'Reachable?', ''].map((x) => h('th', {}, x)))), h('tbody', {}, q.environments.map(envRow))),
              h('div', { style: 'margin-top:10px' }, h('button', { type: 'button', class: 'ghost small', onclick: () => { q.environments.push({ name: '', host: '', port: '', database: '', writeAllowed: false }); render(); } }, '+ Add environment')),
              h('p', { class: 'muted' }, '"Check" tests that the server answers on that port from this computer (it does not log in).')),
            h('h2', {}, '4. Network'),
            checkbox('The databases are only reachable on the company VPN', 'If a connection fails, the Query Runner will remind testers to connect to the VPN.', 'queryRunner.vpnRequired'),
            h('h2', {}, '5. Where do your saved queries come from?', tipIcon('Teams usually already have useful SQL - in a shared folder or in the automation repo. Bring it in now; testers can add more later.')),
            seg('queryRunner.querySource.type', [{ id: 'examples', label: 'Start with examples' }, { id: 'folder', label: 'Copy .sql files from a folder' }, ...(C.automation.status === 'existing' ? [{ id: 'automation-repo', label: 'Use the automation repo\'s SQL' }] : [])]),
            q.querySource.type === 'folder' ? h('div', { class: 'panel' }, textField('Folder with .sql files (on this computer)', 'queryRunner.querySource.path', { placeholder: 'C:\\Team\\SQL', help: 'All .sql files (including sub-folders) are copied into queries/imported/. Files without a header get one; data-changing ones are marked as setup.' })) : null,
            q.querySource.type === 'automation-repo' ? h('div', { class: 'panel' }, textField('Folder inside the automation repo', 'queryRunner.querySource.path', { placeholder: 'Tests/Sql', help: 'Read live from the repo every run, so it is always the latest version.' })) : null,
            note('info', `Read queries always run inside a transaction that is rolled back. Example queries for ${eng.label} are included either way.`),
          ] : null,
        ];
      },
      validate: () => {
        const q = C.queryRunner;
        if (!q.engine) return 'Pick the database engine.';
        const rows = q.environments.filter((e) => e.name || e.host || e.database);
        if (!rows.length) return 'Add at least one environment.';
        const bad = rows.find((e) => !e.name || !e.host || !e.database);
        if (bad) return `Environment "${bad.name || '(no name)'}": fill in name, server and database.`;
        if (q.querySource.type !== 'examples' && !q.querySource.path) return 'Enter the folder with your .sql files.';
        return null;
      },
    },
    {
      id: 'bugs', title: 'Bug Filing', show: () => m().bugFiling, skip: ['bugFiling'],
      render: () => {
        const b = bugDefaultsFor();
        const f = b.fields;
        const tool = C.taskManagement.tool;
        const SECTIONS = [['summary', 'Summary'], ['steps', 'Steps to reproduce'], ['expected', 'Expected result'], ['actual', 'Actual result'], ['environment', 'Environment / build'], ['testData', 'Test data'], ['attachments', 'Screenshots / logs'], ['frequency', 'Frequency (always / sometimes)'], ['impact', 'Business impact']];
        const fieldRow = (key, label, tip) => [
          textField(`${label} - field`, `fields.${key}.field`, { root: b, placeholder: key === 'severity' ? (tool === 'ado' ? 'Microsoft.VSTS.Common.Severity' : tool === 'jira' ? 'priority or customfield_10050' : 'label:severity:') : 'description', tip }),
          listField(`${label} - allowed values`, `fields.${key}.values`, { root: b, placeholder: 'High, Medium, Low', tip: 'Comma-separated, spelled exactly as in your tool. The assistant will only accept these values.' }),
        ];
        const fieldFormTip = 'Where this is stored on the bug: a field reference (e.g. Microsoft.VSTS.Common.Severity or customfield_10050), "priority" for the tool\'s own priority, "label:severity:" to add a label like severity:high, or "description" to just write it in the bug text.';
        return [
          h('h1', {}, 'Bug Filing', tipIcon('QAs describe the problem in plain words (and drop screenshots in a folder); the assistant writes a complete bug in your team\'s format, checks whether it already exists, shows a draft, and files it only after the QA says yes.')),
          h('p', { class: 'lead' }, `How should bugs look when they are filed in ${S.cat.taskTools.find((x) => x.id === tool)?.label || 'your task tool'}?`),
          h('h2', {}, '1. Bug type and fields'),
          h('div', { class: 'panel' }, h('div', { class: 'grid' },
            listField('Bug types QAs file', 'types', { root: b, placeholder: 'Bug, Test Bug, Prod Bug', tip: 'The item type(s) for bugs, exactly as named in your tool. The first one is the default; QAs can pick another (e.g. Prod Bug).' }),
            listField('States that mean "closed"', 'closedStates', { root: b, placeholder: 'Closed, Done', tip: 'Used to find OPEN bugs when checking for duplicates (and in the Bug Report).' }),
            ...fieldRow('severity', 'Severity', fieldFormTip),
            ...fieldRow('priority', 'Priority', `${fieldFormTip} Leave empty if your team does not set priority when filing.`),
            ...fieldRow('environment', 'Environment found in', fieldFormTip))),
          h('h2', {}, '2. Defaults'),
          h('div', { class: 'panel' }, h('div', { class: 'grid' },
            textField(tool === 'ado' ? 'Default area path' : 'Default component', 'defaults.component', { root: b, placeholder: tool === 'ado' ? 'MyProject\\Claims' : 'Checkout', tip: 'Used when the QA does not say which area/component the bug belongs to. Leave empty to always ask.' }),
            textField('Assign new bugs to (triage owner)', 'defaults.assignee.name', { root: b, placeholder: 'Dev Lead name', tip: 'Many teams send new bugs to a triage owner (dev lead / PO). Leave empty to leave bugs unassigned.' }),
            textField('Triage owner email / username', 'defaults.assignee.id', { root: b, placeholder: 'devlead@contoso.com' }),
            listField('Tags / labels to add', 'defaults.tags', { root: b, placeholder: 'qa-found', tip: 'Added to every bug filed this way - handy for reporting.' }))),
          h('h2', {}, '3. Linking and safety checks'),
          checkbox('Link the bug to the story it was found on', 'The QA says which story; the bug is linked to it.', 'linkToStory', { root: b, tip: 'Keeps traceability: the story shows its bugs, and the Bug Report can count bugs per story.' }),
          b.linkToStory ? h('div', { class: 'panel' }, h('div', { class: 'grid' },
            selectField('Link type', 'linkRel', (S.cat.bugDefaults[tool]?.linkRels || ['related']).map((x) => ({ id: x, label: { related: 'Related', parent: 'Child of the story', 'tested-by': 'Tested by' }[x] })), { root: b, tip: '"Related" is the usual choice. "Child of the story" makes the bug a sub-item of the story.' }),
            h('div', {}, checkbox('Also post a comment on the story', null, 'commentOnStory', { root: b })))) : null,
          checkbox('Check for duplicates before filing', 'Searches open bugs with similar titles and asks the QA before creating a new one.', 'duplicateCheck', { root: b, tip: 'Saves developers from triaging the same problem twice.' }),
          h('h2', {}, '4. What every bug description must contain', tipIcon('The assistant will not create the draft until each ticked section is filled in. Pick what your developers need to reproduce a bug.')),
          h('div', { class: 'cards' }, SECTIONS.map(([id, label]) => { const on = b.sections.includes(id); return h('button', { type: 'button', class: `card${on ? ' sel' : ''}`, onclick: () => { b.sections = on ? b.sections.filter((x) => x !== id) : [...b.sections, id]; render(); } }, h('div', { class: 't' }, h('span', { class: 'ck' }, on ? '☑' : '☐'), label)); })),
          ['github', 'linear'].includes(tool) ? note('warn', `${S.cat.taskTools.find((x) => x.id === tool)?.label} doesn't accept screenshot uploads through its API - the bug lists the file names and the QA drags them in afterwards.`) : note('info', 'Screenshots saved in the installation\'s bug-evidence/ folder are uploaded to the bug automatically.'),
          note('info', 'Every bug is shown to the QA as a draft first - nothing is filed without their yes.'),
        ];
      },
      validate: () => {
        const b = bugDefaultsFor();
        if (!b.types.length) return 'Enter at least one bug type.';
        if (!b.sections.includes('steps') || !b.sections.includes('actual')) return 'Keep at least "Steps to reproduce" and "Actual result" - developers cannot fix a bug without them.';
        return null;
      },
    },
    {
      id: 'lead', title: 'QA lead setup', show: () => lead(), skip: ['qaAssignment', 'qaAudit', 'bugReport'],
      render: () => {
        const r = C.qaLead.roster;
        const row = (p, i) => h('tr', {},
          h('td', {}, h('input', { type: 'text', value: p.name, placeholder: 'Full name as shown in the tool', oninput: (e) => { p.name = e.target.value; } })),
          h('td', {}, h('input', { type: 'text', value: p.id, placeholder: 'email / username', oninput: (e) => { p.id = e.target.value; } })),
          h('td', {}, h('select', { onchange: (e) => { p.pool = e.target.value; render(); } }, [['general', 'General pool'], ['reserved', 'Reserved (specialist)'], ['excluded', 'Excluded']].map(([v, l]) => h('option', { value: v, selected: p.pool === v ? true : null }, l)))),
          h('td', {}, h('input', { type: 'text', value: (p.subjectKeywords || []).join(', '), placeholder: 'Payments, Checkout', oninput: (e) => { p.subjectKeywords = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); } })),
          h('td', {}, p.pool === 'reserved' ? h('input', { type: 'text', value: (p.reservedKeywords || []).join(', '), placeholder: 'Performance', oninput: (e) => { p.reservedKeywords = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); } }) : h('span', { class: 'muted' }, '-')),
          h('td', {}, h('button', { type: 'button', class: 'ghost small', onclick: () => { r.splice(i, 1); render(); } }, 'Remove')));
        return [
          h('h1', {}, 'QA lead setup'),
          h('p', { class: 'lead' }, 'Optional tools for the QA lead. Skip any section you don\'t need now - or the whole step with the Skip button below.'),
          m().qaAssignment ? [
            sectionHead('👥 QA Assignment - roster', 'qaAssignment'),
            h('p', { class: 'muted' }, 'Subject keywords route matching tickets (title, tags, component) to that QA first. Reserved people only get their keyword tickets and stay out of the general pool.'),
            h('div', { class: 'panel' },
              h('table', { class: 'roster' }, h('thead', {}, h('tr', {}, ['Name', 'Email / username', 'Pool', 'Subject keywords', 'Reserved keywords', ''].map((x) => h('th', {}, x, tipIcon(ROSTER_TIPS[x]))))), h('tbody', {}, r.map(row))),
              h('div', { style: 'margin-top:10px' }, h('button', { type: 'button', class: 'ghost small', onclick: () => { r.push({ name: '', id: '', pool: 'general', subjectKeywords: [], reservedKeywords: [] }); render(); } }, '+ Add QA'))),
            h('h2', {}, 'Routing rules'),
            checkbox('Bugs go to the QA who filed them', 'Highest-priority rule: whoever found the bug verifies the fix.', 'qaLead.bugAuthorRouting'),
            C.qaLead.bugAuthorRouting ? h('div', { class: 'panel' }, listField('Bug types', 'qaLead.bugTypes', { help: 'Item types treated as bugs.' })) : null,
            checkbox('Use comment involvement', 'Give unrouted tickets to the roster QA who commented most recently (slower - reads comments per ticket).', 'qaLead.commentInvolvement'),
          ] : null,
          m().qaAudit ? [
            sectionHead('🔍 QA Audit - scope', 'qaAudit'),
            h('div', { class: 'panel' }, listField('Requirement types to audit', 'audit.requirementTypes', { full: true, help: 'Empty = every item in the release (except ignored types).' })),
            note('info', `The audit reads the marker comments Agent 2${automationInScope() && m().agent3 ? ' and Agent 3' : ''} post on each requirement, so it works the same on any task tool.`),
          ] : null,
          m().bugReport ? bugReportSection() : null,
        ];
      },
      validate: () => {
        if (m().qaAssignment && !C.qaLead.roster.filter((p) => p.name.trim()).length) return 'Add at least one QA to the roster.';
        if (m().bugReport && !C.bugReport.types.length) return 'Bug report: enter at least one bug type.';
        if (m().bugReport && C.bugReport.publish.enabled && !C.bugReport.publish.spaceKey) return 'Bug report: enter the Confluence space key (or untick publishing).';
        if (m().bugReport && C.bugReport.publish.enabled && !m().agent1 && !(C.requirementDocs.settings.confluence || {}).baseUrl) return 'Bug report: enter the Confluence URL (or untick publishing).';
        if (m().bugReport && C.bugReport.publish.enabled && !m().agent1) return needTokens(S.cat.docTools.find((x) => x.id === 'confluence'), C.requirementDocs.settings.confluence || {});
        return null;
      },
    },
    {
      id: 'review', title: 'Review & install', show: () => true,
      render: () => {
        if (S.result) return resultView();
        const p = S.preview;
        const apiKeys = (kind, list, sec) => [...new Set(sec.picked.map((id) => list.find((x) => x.id === id)).filter((t) => t?.mode === 'api').map((t) => `${kind}:${t.adapter}`))];
        const untested = [C.taskManagement.tool !== 'manual' && 'task', needsTest() && C.testManagement.tool !== 'csv' && 'test',
          ...(m().agent1 ? [...apiKeys('docs', S.cat.docTools, C.requirementDocs), ...apiKeys('design', S.cat.designTools, C.design)] : []),
          m().agent1 && C.codeChanges.tool !== 'none' && 'code'].filter(Boolean).filter((k) => !S.conn[k]?.ok);
        return [
          h('h1', {}, 'Review & install'),
          h('p', { class: 'lead' }, `Installs into `, h('code', {}, S.target)),
          !p ? h('p', {}, 'Building preview…') : [
            p.warnings.map((w) => note('warn', '⚠ ', w)),
            notSetUp().length ? note('info', h('b', {}, 'Not set up now (optional): '), notSetUp().map(MODULE_LABEL).join(', '), '. To add any of them later, run the wizard again, click "Load previous answers", pick this folder, and tick them.') : null,
            untested.length ? note('warn', `Connections not verified yet: ${untested.join(', ')}. You can install anyway and fix them later with "npm run verify".`) : note('ok', '✔ All connections verified.'),
            h('h2', {}, 'Decisions made from your answers'),
            h('ul', { class: 'tight' }, (p.decisions.length ? p.decisions : ['Standard setup - no special dependencies.']).map((d) => h('li', {}, d))),
            (() => {
              const n = needsList();
              return [
                h('h2', {}, 'What each team member needs'),
                h('div', { class: 'panel' },
                  h('b', {}, 'On their computer'),
                  h('ul', { class: 'tight' }, n.machine.map(([what, why, href]) => h('li', {}, href ? link(href, what) : what, ' - ', h('span', { class: 'muted' }, why)))),
                  h('b', {}, 'Accounts and access'),
                  h('ul', { class: 'tight' }, n.access.length ? n.access.map(([what, why]) => h('li', {}, what, ' - ', h('span', { class: 'muted' }, why))) : h('li', {}, 'No tool accounts needed for this setup.')),
                  h('b', {}, 'Not needed'),
                  h('ul', { class: 'tight' }, n.notNeeded.map((x) => h('li', { class: 'muted' }, x)))),
              ];
            })(),
            h('h2', {}, `Files we'll generate (${Object.keys(p.files).length}) - click to preview`),
            h('div', { class: 'files' }, Object.keys(p.files).sort().map((f) => h('button', { type: 'button', onclick: () => { $('dlgTitle').textContent = f; $('dlgBody').textContent = p.files[f]; $('dlg').showModal(); } }, f))),
            h('p', { class: 'muted' }, '+ the runtime scripts (agents, connectors, QA-lead tools) and package.json.'),
          ],
        ];
      },
    },
  ];

  function resultView() {
    const r = S.result;
    const cdPath = r.target;
    return [
      h('h1', {}, '🎉 Installed'),
      note('ok', `${r.count} files written to `, h('code', {}, r.target)),
      r.warnings.map((w) => note('warn', '⚠ ', w)),
      h('h2', {}, 'Next steps'),
      h('ol', {},
        h('li', {}, 'Open a terminal in the folder and install dependencies:', h('pre', { class: 'cmd' }, `cd "${cdPath}"\nnpm install\nnpm run verify`)),
        C.automation.status === 'existing' ? h('li', {}, 'Pull your automation repo and build the step library:', h('pre', { class: 'cmd' }, 'npm run sync-automation\nnpm run step-library')) : null,
        h('li', {}, 'Open the folder in your AI assistant and say, for example:', h('ul', { class: 'tight' },
          m().agent1 ? h('li', {}, h('code', {}, 'Generate test cases for 1234')) : null,
          m().qaAssignment ? h('li', {}, h('code', {}, 'QA assignment for release 12')) : null,
          m().qaAudit ? h('li', {}, h('code', {}, 'Audit release 12')) : null)),
        h('li', {}, 'Share ', h('code', {}, 'docs/GETTING-STARTED.md'), ' with the team.')),
      h('p', { class: 'muted' }, 'Need changes? Run the wizard again, click "Load previous answers", and install into the same folder. Tokens are not saved in the answers file - re-enter them or keep the existing .env.'),
    ];
  }

  // ── navigation ─────────────────────────────────────────────────────────────
  const visible = () => STEPS.filter((s) => s.show());
  function render() {
    const vis = visible();
    if (S.step >= vis.length) S.step = vis.length - 1;
    const cur = vis[S.step];
    $('steps').replaceChildren(...vis.map((s, i) => h('button', {
      type: 'button',
      class: `step${i === S.step ? ' active' : ''}${S.visited.has(s.id) && i !== S.step ? ' done' : ''}${!S.visited.has(s.id) && i > S.step ? ' locked' : ''}`,
      onclick: () => { if (S.visited.has(s.id) || i < S.step) go(i); },
    }, h('span', { class: 'n' }, i + 1), s.title)));
    const scrollY = window.scrollY;
    $('view').replaceChildren(...[cur.render()].flat(Infinity).filter(Boolean));
    window.scrollTo(0, scrollY);
    $('back').style.visibility = S.step === 0 || S.result ? 'hidden' : 'visible';
    $('next').textContent = cur.id === 'review' ? (S.result ? 'Done' : 'Install') : 'Next →';
    $('next').disabled = cur.id === 'review' && (!S.preview || !!S.result);
    $('skip').style.display = cur.skip && !S.result ? '' : 'none';
    $('navErr').textContent = '';
  }
  async function go(i) {
    const vis = visible();
    S.step = Math.max(0, Math.min(i, vis.length - 1));
    S.visited.add(vis[S.step].id);
    if (vis[S.step].id === 'review' && !S.result) {
      S.preview = null; render();
      try { S.preview = await api('/api/preview', payload()); } catch (e) { S.preview = { files: {}, warnings: [e.message], decisions: [] }; }
    }
    render();
    window.scrollTo(0, 0);
  }
  const payload = () => ({ config: C, secrets: Object.fromEntries(Object.entries(S.secrets).filter(([, v]) => v)), target: S.target, options: S.options });

  $('next').onclick = async () => {
    const vis = visible();
    const cur = vis[S.step];
    const err = cur.validate && cur.validate();
    if (err) { $('navErr').textContent = err; return; }
    if (cur.id === 'review') {
      $('next').disabled = true; $('next').textContent = 'Installing…';
      try { S.result = await api('/api/install', payload()); render(); window.scrollTo(0, 0); }
      catch (e) { $('navErr').textContent = e.message; $('next').disabled = false; $('next').textContent = 'Install'; }
      return;
    }
    go(S.step + 1);
  };
  $('back').onclick = () => go(S.step - 1);
  // Optional step: switch its tool(s) off without asking its questions; the step then disappears and the wizard moves on.
  $('skip').onclick = () => {
    const cur = visible()[S.step];
    if (!cur?.skip) return;
    skipModules(cur.skip.filter((id) => m()[id]));
    go(S.step);
  };
  $('loadBtn').onclick = async () => {
    const folder = prompt('Folder of the previous installation (full path):', S.target);
    if (!folder) return;
    try {
      const saved = await api('/api/load', { target: folder });
      Object.assign(C, JSON.parse(JSON.stringify(saved.config)));
      // Answers saved by an older wizard version used { tool } instead of { picked, settings }.
      for (const key of ['requirementDocs', 'design']) {
        const sec = C[key] || {};
        if (!Array.isArray(sec.picked)) {
          const { tool, ...rest } = sec;
          C[key] = { picked: tool && tool !== 'none' ? [tool === 'local' ? 'word' : tool] : [], settings: tool && tool !== 'local' && tool !== 'none' ? { [tool]: rest } : {} };
        }
        C[key].settings = C[key].settings || {};
      }
      S.options = saved.options || S.options;
      S.prevSecrets = new Set(saved.secretNames || []); // their values stay in that folder's .env
      S.target = folder;
      S.visited = new Set(STEPS.map((s) => s.id));
      S.preview = null; S.result = null;
      go(1);
      alert(`Loaded. Your tokens (${(saved.secretNames || []).join(', ') || 'none'}) stay in that installation's .env - leave the token fields empty to keep them, or paste a new one to replace it.`);
    } catch (e) { alert(e.message); }
  };

  (async () => {
    S.cat = await api('/api/catalog');
    const d = await api('/api/defaults');
    S.target = d.target;
    render();
    loadSys();
  })().catch((e) => { $('view').textContent = `Could not start the wizard: ${e.message}`; });
})();
