# QA Agent Framework - Client Kit

A shareable, tool-agnostic version of the QA agent workflow, with a **web-based setup wizard**.

| Module | For | What it does |
|---|---|---|
| Agent 1 - Test Case Generator | QA engineers | Requirement (+ children, comments, linked code, BRD, designs) → linted, persona-reviewed test cases → Excel |
| Agent 2 - Test Plan Creator | QA engineers | Approved Excel → test plan in the client's test tool (duplicate guard, automation-tag check) |
| Agent 3 - Feature File Generator | QA engineers | Automation-tagged cases → Gherkin that reuses existing step text → PR + task for the automation owner |
| QA Assignment | QA leads | Release load balancing: plan → review in HTML → apply (writes only the QA field) |
| QA Audit | QA leads | Per-release compliance: did Agent 2 / Agent 3 run for every requirement? |
| Bug Report | QA leads | Release / last-N-days / all-open bug report: module × severity matrix, owners, aging; HTML + Excel, optional Confluence page |
| Query Runner *(misc tool)* | QA engineers | Runs the team's saved SQL on a chosen test database (SQL Server, PostgreSQL, MySQL, Oracle); Excel + HTML; read queries always roll back |
| Bug Filing *(misc tool)* | QA engineers | Plain-words description + screenshots → complete bug in the team's format, duplicate check, draft approval, then filed and linked |

## Install (for the client)

### Technology needed before you start

| Technology | Needed? | Why | Get it |
|---|---|---|---|
| **Node.js 18+** (includes npm) | Required | Runs the setup wizard and the agent scripts | https://nodejs.org/en/download (LTS) |
| **Git** | Required if you have an automation repo; recommended otherwise | Clones the automation repo, delivers feature files | https://git-scm.com/downloads |
| **An AI assistant** | Required (one of) | Runs the agents | Claude Code / Claude desktop app, VS Code or Visual Studio + GitHub Copilot, or Cursor |
| Excel (or any .xlsx viewer) | Required for QAs | Reviewing Agent 1 test cases | - |
| Tool accounts + API tokens | Required | Task tool (+ test tool, docs, Figma, code host if used) | The wizard shows how to create each token |
| Database login (+ VPN if needed) | Only for Query Runner | Running saved queries on test databases; the driver is installed by `npm install` | Ask your DBA for a read-only test account |
| Admin rights, database, Docker, cloud hosting, your test framework's runtime (.NET/Java/…) | **Not needed** | | |

### Start the wizard

- **Windows:** double-click **`Start-Installer.cmd`**
- **macOS / Linux:** run `./start-installer.sh`
- or, from a terminal in this folder: `npm start`

The launcher checks Node.js first. If Node is missing or too old, it says so and opens the download page. Then the browser opens at http://127.0.0.1:4600.

The wizard's first page, **Before you start**, checks this computer for Node.js, npm, Git and an AI assistant (Claude Code or VS Code), with download links for anything missing. The Review page then lists exactly what each team member needs for the tools you picked: software, accounts, token names and permissions. The wizard asks, in order:

0. **Before you start**: technology check
1. **Company, product, install folder**
2. **Modules** - QA engineer agents and/or QA lead modules (dependencies are enforced live)
3. **AI assistant** - Claude Code, GitHub Copilot, Cursor (writes `CLAUDE.md`, `.github/copilot-instructions.md`, `.cursor/rules/…`)
4. **Task management (tickets)**: Azure Boards, Jira (Cloud/DC), GitHub Issues, GitLab, Linear, or **Other tool** (ServiceNow, Rally, Asana, ClickUp, Monday, Trello… as exported ticket files) → credentials + **Test connection** + field mapping (AC field, release naming, QA field)
5. **Requirement documents** (Agent 1, pick several): Confluence, Azure DevOps Wiki, Notion (read from links), SharePoint / OneDrive, Word / PDF files, Google Docs (downloaded as Word/PDF), or "only the ticket"
6. **Design artifacts** (Agent 1, pick several): Figma (read from links), Adobe XD, Sketch, Zeplin, Miro / wireframes, screenshots / PDF mockups (exported as images), or "no designs"
7. **Code changes** (Agent 1): code host for commits and PRs linked to the ticket (read-only)
8. **Test automation**: existing? → framework (BDD or not), repo, feature/step folders, delivery (PR / branch / local), automation owner. Not yet? → planned or not.
9. **Test management**: only compatible tools are offered (Azure Test Plans needs Azure Boards; Xray/Zephyr need Jira), TestRail, Qase, or CSV import files for anything else
10. **Query Runner** (misc tool): database engine → sign-in method (SQL login, Entra ID, Windows) → environments (server, port, database, "allow data changes", reachability check; production is always read-only) → VPN → where saved queries come from (examples, a folder of .sql files, or the automation repo)
11. **Bug Filing** (misc tool): bug types and "closed" states → severity / priority / environment fields and allowed values (pre-filled per tool) → defaults (area, triage owner, tags) → link to the story, duplicate check → sections every bug must contain
12. **QA lead setup**: roster with subject/reserved keywords, bug-author routing, audit scope; **Bug Report**: bug types, closed states, severity order, where "module" comes from, breakdowns, default scope, optional Confluence publishing
13. **Review & install**: decisions taken from the answers, a preview of every generated file (secrets masked), then install

### How Agent 1 combines the sources

A ticket usually says *what* is built now; the full rules live in a larger document. Agent 1 reads all of them, and each source has a job:

| Source | Used for |
|---|---|
| Ticket (description, acceptance criteria, child items) | **Scope**: every AC line is covered |
| Comments | **Latest decisions** (override older text) |
| Requirement documents (SRS / BRD / spec) | **Business rules**: validations, roles, calculations, error and edge cases |
| Designs | **UI**: exact labels, messages, empty/error/loading states |
| Code changes | **Regression areas** (read-only) |

When sources disagree, Agent 1 never picks one silently: it records a clarification question that quotes both.

- **Links are found automatically.** Document and design links inside the ticket, its child items and its comments are fetched without being asked for. Agent 1 asks only when nothing was found.
- **Links that can't be read** (SharePoint, Google Docs, Adobe XD…): Agent 1 prints the exact download/export steps. Word `.docx` files are read directly, PDFs are opened by the assistant, and exported screens are opened as images.

Then, in the installed folder: `npm install` → `npm run verify`.

## How answers change the installation

| Answer | Effect |
|---|---|
| Existing **BDD** automation | Agent 1 must reuse canonical step text (blocking scan); `npm run step-library` indexes feature steps + step bindings; Agent 3 marks only genuinely new steps |
| Existing **non-BDD** automation | Library becomes an index of existing test titles; Agent 3's feature file is the spec engineers implement |
| Automation **planned** | Agent 3 writes to `automation-handoff/` until a repo exists |
| **No** automation, not planned | Agent 3 off, no automation-tag gate in Agent 2, Agent 1 skips the scan, Audit checks Agent 2 only |
| Agent 3 without Agent 2 | Agent 2 is switched on (Agent 3 reads its plans) |
| QA Audit without Agent 2 | Audit is switched off (nothing to audit) |
| No test management tool | Agent 2 writes vendor-format CSV import files; Agent 3 reads them back |

The audit is tool-agnostic: Agent 2/3 post marker comments (`[QA-AGENT:TEST-PLAN]`, `[QA-AGENT:FEATURE-FILE]`, `[QA-AGENT:AUTOMATION-EXEMPT]`) on the requirement, and the audit only reads comments.

## Layout

```
QA-Agent-Framework-Kit/
  Start-Installer.cmd   Windows launcher (checks Node.js, starts the wizard)
  start-installer.sh    macOS / Linux launcher
  README.html           shareable copy of this file (rebuild: npm install, then npm run readme)
  tools/                build-readme-html.js
  installer/            web wizard (zero dependencies)
    public/assets/      Mindfire logo
    server.js           local server, 127.0.0.1 only
    lib/catalog.js      choices, compatibility, vocabulary
    lib/generator.js    answers → files (dependency rules live here)
    lib/templates.js    tailored agent instruction files
    selftest.js         npm run selftest
  framework/            runtime copied into every installation
    scripts/core/       config, http, preflight, utils
    scripts/adapters/   task/ test/ docs/ design/ code/ - one file per tool (see CONTRACT.md)
    scripts/agents/     Agent 1-3 scripts
    scripts/lead/       QA assignment + audit
    scripts/automation/ repo sync + step library
```

Adding a tool = one adapter file following `framework/scripts/adapters/CONTRACT.md`, plus one catalog entry.

## Status

- Wizard, generator, and the full script chain were tested end-to-end offline (mock tracker + CSV + a sample Reqnroll repo); `npm run selftest` covers the dependency rules.
- The connectors for Azure DevOps, Jira, Xray, Zephyr Scale, TestRail, Qase, GitHub, GitLab, Linear, Bitbucket, Confluence, Notion and Figma follow each vendor's documented API, but **have not yet been run against live accounts**. Pilot each one with real credentials before handing it to a client.
