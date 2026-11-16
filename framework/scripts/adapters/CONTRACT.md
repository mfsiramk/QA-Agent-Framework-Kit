# Adapter Contract

Every external tool is reached through one adapter file. Agent scripts never call a
tool's API directly - they call the functions below, so swapping Jira for Azure
Boards (or TestRail for Xray) only changes which adapter file is loaded.

Rules for every adapter:

- CommonJS, **zero npm dependencies** - use `request()` / `basicAuth()` / `bearer()` /
  `htmlToText()` / `adfToText()` from `../../core/http.js` (Node 18+ `fetch`).
  The web installer `require()`s adapters directly to run "Test connection", before
  `npm install` has happened.
- Every function receives `ctx` first: `{ config, env, root }`.
  - `ctx.config` = that tool's section of `qa-framework.config.json` (see below).
  - `ctx.env` = `process.env` (secrets live only in `.env`).
  - Test and code adapters also get `ctx.task` = the `taskManagement` section.
- Pass `service: '<Tool name>'` to `request()` so errors read in plain language.
- Optional capabilities: if a tool cannot do something, export the function anyway
  and throw `new Error('<Tool> does not support <x>: <what to do instead>')`.
- `testConnection(ctx)` must be read-only and return `{ ok: true, message }` or
  `{ ok: false, message, fix }` (never throw). `fix` = one plain-language sentence.
- Export `id`, `label`, `secrets` (array of `{ env, label, help }`), and `fields`
  (array of `{ key, label, placeholder, help, required }`) describing the non-secret
  config keys the adapter reads from `ctx.config`. The installer renders these.

## Normalized shapes

```js
WorkItem = {
  id: '1234',            // string; Jira key "ABC-12", GitHub "42", Linear "ENG-7"
  type: 'User Story',    // tool's type name ("Bug", "Story", "Issue"...)
  title, state,
  description: 'plain text',
  acceptanceCriteria: 'plain text ('' if none)',
  tags: ['a','b'],       // ADO tags / Jira labels / GitHub+GitLab labels / Linear labels
  component: 'area path / component / project',
  release: 'iteration / fixVersion / milestone / cycle name',
  assignee: { name, id } | null,
  qaAssignee: { name, id } | null,   // per config.fields.qaAssignee
  createdBy: { name, id } | null,
  storyPoints: number | null,
  parentId: string | null,
  url: 'browser URL',
  links: [{ rel: 'related|parent|child|predecessor|successor', id }],
  severity: string | null,     // per config.bugFields.severity (see below)
  priority: string | null,     // per config.bugFields.priority; tool's own value (ADO "2", Jira "High", Linear "Urgent")
  environment: string | null,  // per config.bugFields.environment
  createdDate: ISOString | null,
  changedDate: ISOString | null,
  closedDate: ISOString | null,  // ADO ClosedDate, Jira resolutiondate, closed_at, Linear completedAt/canceledAt
}
SearchQuery = { types: ['Bug'], states?: [], notStates?: [], release?: '42',
                createdFrom?: ISODate, createdTo?: ISODate, text?: 'words in title', max?: 500 }
BugInput = { type: 'Bug', title, description: 'markdown',
             fields: { severity?, priority?, environment?, foundIn?, component?, assignee?: { name, id } },
             tags: [], linkTo?: { id, rel: 'parent'|'related'|'tested-by' } }
Comment = { id, author: { name, id }, date: ISOString, text: 'plain text' }
CodeChange = { kind: 'commit'|'pull-request', id, title, url, repo, author, date, files: ['path', ...] }
TestCase (input) = { id, title, priority: 'Critical|High|Medium|Low', preconditions,
                     steps: [{ action, expected }], testData, tags: [], subject, acRef }
TestCase (listed) = { id, title, priority, steps: [{ action, expected }], tags: [], suite, url }
```

## Task management (`adapters/task/<id>.js`) - ado, jira, github, gitlab, linear

| Function | Purpose |
|---|---|
| `testConnection(ctx)` | read-only credential + project check |
| `getWorkItem(ctx, id)` → WorkItem | |
| `getChildren(ctx, id)` → WorkItem[] | sub-tasks / child items / sub-issues |
| `getComments(ctx, id)` → Comment[] | oldest first |
| `addComment(ctx, id, markdown)` → `{ id, url }` | |
| `createTask(ctx, { parentId, title, description, assignee })` → `{ id, url }` | assignee = `{ name, id }` (email/username) |
| `listReleaseItems(ctx, release)` → WorkItem[] | uses `config.fields.release` + `excludedTypes` / `excludedStates` |
| `setQaAssignee(ctx, id, person)` → `{ ok }` | writes ONLY the field in `config.fields.qaAssignee` |
| `searchItems(ctx, SearchQuery)` → WorkItem[] | newest first, paginated, capped at `max` (default 500); see below |
| `createBug(ctx, BugInput)` → `{ id, url, warnings: [] }` | field writes per `config.bugFields`; never fails on an unsupported field |
| `attachFile(ctx, id, filePath)` → `{ ok: true, url }` | or throws "<Tool> does not support attachments through the API: ..." |

The "Other tool" adapter (`manual`) implements the same functions against ticket files.

### `searchItems`

- `types` = item types (ADO work item type, Jira issuetype). GitHub / GitLab / Linear have no
  types, so each type is treated as a label name (e.g. `"bug"`); several types match ANY of them.
- `states` / `notStates` = state names (GitHub `open`/`closed`, GitLab `opened`/`closed`).
- `release` uses `config.fields.release` exactly like `listReleaseItems` (excluded types/states are NOT applied).
- `createdFrom` / `createdTo` = ISO dates; a bare `YYYY-MM-DD` for `createdTo` includes that whole day.
- `text` = words that must ALL appear in the title (duplicate detection): ADO `[System.Title] CONTAINS`
  per word, Jira `summary ~`, GitHub search `in:title`, GitLab `search=` + `in=title`,
  Linear `title containsIgnoreCase` per word, manual case-insensitive substring per word.
  GitHub search returns at most 1000 results.

### `createBug` and `config.bugFields`

```json
"bugFields": {
  "severity":    { "field": "Microsoft.VSTS.Common.Severity", "values": ["1 - Critical", "2 - High", "3 - Medium", "4 - Low"] },
  "priority":    { "field": "priority", "values": ["Highest", "High", "Medium", "Low"] },
  "environment": { "field": "label:env-" },
  "foundIn":     { "field": "description" }
}
```

`field` forms:

| Form | Meaning |
|---|---|
| field reference | ADO `Microsoft.VSTS.Common.Severity`, `Custom.Environment`; Jira `customfield_10050` (select option first, then plain text) or the system `environment` field |
| `priority` | the tool's built-in priority: Jira priority name; ADO `Microsoft.VSTS.Common.Priority` 1-4 (Critical/High/Medium/Low or a number); Linear 1 Urgent/Critical, 2 High, 3 Medium, 4 Low |
| `label:<prefix>` | adds label `<prefix><value>`, lowercased, spaces to `-` (ADO: a tag) |
| `description` or empty | only written into the description as a `**Severity:** High` line |

`values` (optional) = allowed values; a given value is matched case-insensitively, also against
`"2 - High"` style entries. A value that does not match is written as given, with a warning.

Defaults when `bugFields` does not mention a field:
ADO severity `Microsoft.VSTS.Common.Severity` (High is sent as "2 - High"), priority `priority`;
Jira priority `priority`, environment `environment`; Linear priority `priority`; everything else `description`.

Per tool:
- **ADO**: description goes to `Microsoft.VSTS.TCM.ReproSteps` for type Bug (falls back to `System.Description`
  if rejected; other types use `System.Description`) as HTML converted from markdown (headings, bullets,
  numbered lists, bold, links, line breaks). `fields.component` = AreaPath. Links: parent = Hierarchy-Reverse,
  related = `System.LinkTypes.Related`, tested-by = `Microsoft.VSTS.Common.TestedBy-Forward`. A field ADO
  rejects is dropped, noted in the description, and reported in `warnings`.
- **Jira**: ADF description on Cloud (paragraphs, headings, bullet/numbered lists), wiki markup on Server.
  `fields.component` = components (comma-separated names). Tags = labels (spaces to `-`). Link: issue link
  "Relates"; for a sub-task issue type with `rel: 'parent'` the parent field is used. Rejected fields are
  retried in another shape, then dropped with a warning.
- **GitHub / GitLab**: issue with labels = type label (lowercased) + tags + `label:` fields, reusing the
  repository's existing label spelling; body markdown; `linkTo` adds a "Related: #<id>" line (GitHub also
  tries a sub-issue when `rel: 'parent'`; GitLab also tries a "relates_to" issue link). Field references and
  `priority` are not available: written to the description with a warning.
- **Linear**: `issueCreate` with `labelIds` (unknown labels are skipped with a warning, never created), priority
  mapping above, markdown description; `rel: 'parent'` sets the parent, other rels use `issueRelationCreate`
  type "related".
- **manual**: writes `requirements/BUG-<timestamp>.md` with front matter (id, type, title, state: New, severity,
  priority, environment, foundIn, component, tags, assignee, parent / related, created) and the markdown body.

### `attachFile`

- **ADO**: upload to `_apis/wit/attachments?fileName=...`, then add an `AttachedFile` relation.
- **Jira**: `POST /rest/api/{2|3}/issue/{key}/attachments` (multipart, `X-Atlassian-Token: no-check`).
- **GitLab**: `POST /projects/:id/uploads`, then a note with the returned markdown.
- **GitHub / Linear**: not supported through the API - throws; the QA drags the screenshot into the issue in the browser.
- **manual**: copies the file to `requirements/attachments/<id>/` and returns that path.

`config.fields.qaAssignee` forms: a field reference (`Custom.QAAssigned`, `customfield_10070`),
`label:<prefix>` (adds label `<prefix><username>`, removes other `<prefix>*` labels), or `assignee`.
`config.fields.release` = `{ type, pattern }` where `pattern` contains `{release}`; types:
`iterationPath` (ADO, UNDER), `fixVersion` / `sprint` (Jira), `milestone` (GitHub/GitLab),
`cycle` (Linear), `label`.

## Code changes (`adapters/code/<id>.js`) - ado, github, gitlab, bitbucket - READ-ONLY

| `testConnection(ctx)` | |
| `findChanges(ctx, workItem)` → CodeChange[] | ADO: work item relations (ArtifactLink). Others: search commits/PRs whose title/message/branch mentions the work item id/key in `config.repos` |

## Test management (`adapters/test/<id>.js`) - ado-test-plans, xray, zephyr-scale, testrail, qase, csv

| Function | Purpose |
|---|---|
| `testConnection(ctx)` | |
| `findPlans(ctx, requirementId)` → `[{ id, name, url }]` | plans already created for this requirement (duplicate guard) |
| `createPlan(ctx, { name, requirement, release })` → `{ id, url }` | requirement = WorkItem |
| `ensureSuite(ctx, plan, name)` → `{ id }` | reuse by name; ADO static suite, TestRail section, Xray test set/folder, Zephyr folder, Qase suite |
| `listSuites(ctx, plan)` → `[{ id, name }]` | |
| `createTestCase(ctx, { plan, suite, tc, requirement })` → `{ id, url }` | links TC to requirement where the tool supports it; tags incl. automation tag |
| `listTestCases(ctx, plan)` → TestCase(listed)[] | re-reads tags from the tool (human may have edited them) |
| `finalize(ctx, plan)` → `{ files? }` | csv adapter writes the import file here; others no-op |

## Documents (`adapters/docs/<id>.js`) - confluence, ado-wiki, jira, notion, local

Read side (all docs adapters): `testConnection(ctx)`, `matches(ctx, input)` (does this link/key/path belong
to me?) and `fetchDocument(ctx, input)` → `{ title, url, text, sections: [{ heading, text }], needsDirectRead? }`.
Agent 1 routes every link it finds in a ticket to the first adapter whose `matches` says yes.

Optional `discover(ctx, workItem, texts)` → `[link]`: requirement documents an adapter can find by itself for a
ticket. **jira** implements it: the ticket's parent and linked issues (when the task tool is the same Jira) plus
`/browse/KEY-n` links in the ticket text, kept only if their issue type is in `config.issueTypes`
(default `Epic, Requirement, SRS`). jira's `fetchDocument` also downloads `.docx/.pdf/.md/.txt/.html` attachments to
`output/temp/jira-attachments/<KEY>/` and adds their sections (PDFs: `needsDirectRead`).

Write side (confluence only):

| Function | Purpose |
|---|---|
| `upsertPage(ctx, { spaceKey, parentId, title, html })` → `{ id, url, created }` | Confluence only. Finds the page by title in the space (`/rest/api/content?spaceKey=&title=&expand=version`); updates it with version + 1 if found, else creates it under `parentId`. `html` = storage representation. `url` = `<baseUrl>/pages/viewpage.action?pageId=<id>`. Needs "Add page" permission in the space. |

## Shared helpers

`adapters/task/_bug.js` (not an adapter) holds the tool-neutral pieces used by the task adapters:
`bugFields` form resolution, value matching, markdown to HTML / ADF / Jira wiki conversion, and
the title-word / state / date post-filter for `searchItems`. Pure functions, no network.
