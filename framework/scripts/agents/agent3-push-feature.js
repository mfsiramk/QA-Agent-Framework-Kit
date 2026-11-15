#!/usr/bin/env node
/**
 * AGENT 3 - deliver the APPROVED feature file and notify the automation owner.
 * This script is the ONLY place that creates the automation tracking task and posts
 * the Agent 3 audit marker - never commit the file or post the comment by hand.
 *
 *   node scripts/agents/agent3-push-feature.js <testPlanId> <workItemId> --file "<approved.feature>"
 *   node scripts/agents/agent3-push-feature.js <testPlanId> <workItemId> --task-only   (backfill task + comment)
 *
 * Delivery (from qa-framework.config.json → automation.delivery.mode):
 *   pull-request  new branch in the automation repo + push + open a PR (GitHub / GitLab / Azure Repos)
 *   push-branch   new branch + push, no PR
 *   local         copy into the automation repo (existing) or automation-handoff/ (planned)
 * Idempotent: re-running after a partial failure is safe (skips the task if the marker exists).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadConfig, taskAdapter, MARKERS } = require('../core/config');
const { preflight } = require('../core/preflight');
const { request, basicAuth, bearer } = require('../core/http');
const { arg, positional, exitWith } = require('../core/util');

const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

async function openPullRequest(cloneUrl, branch, base, title, body, env) {
  const u = cloneUrl.replace(/\.git$/, '');
  let m;
  if ((m = u.match(/github\.com[/:]([^/]+)\/([^/]+)$/))) {
    const r = await request({ url: `https://api.github.com/repos/${m[1]}/${m[2]}/pulls`, method: 'POST', service: 'GitHub', headers: { Authorization: bearer(env.GITHUB_TOKEN) }, body: { title, head: branch, base, body } });
    return r.html_url;
  }
  if ((m = u.match(/^(https?:\/\/[^/]*gitlab[^/]*)\/(.+)$/))) {
    const r = await request({ url: `${m[1]}/api/v4/projects/${encodeURIComponent(m[2])}/merge_requests`, method: 'POST', service: 'GitLab', headers: { 'PRIVATE-TOKEN': env.GITLAB_TOKEN }, body: { source_branch: branch, target_branch: base, title, description: body } });
    return r.web_url;
  }
  if ((m = u.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/)) || (m = u.match(/\/\/[^@]*@?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/))) {
    const [, org, project, repo] = m;
    const r = await request({ url: `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/pullrequests?api-version=7.0`, method: 'POST', service: 'Azure Repos', headers: { Authorization: basicAuth('', env.ADO_PAT) }, body: { sourceRefName: `refs/heads/${branch}`, targetRefName: `refs/heads/${base}`, title, description: body } });
    return `https://dev.azure.com/${org}/${project}/_git/${repo}/pullrequest/${r.pullRequestId}`;
  }
  throw new Error(`Cannot open a PR automatically for ${cloneUrl} - open it manually from branch "${branch}".`);
}

(async () => {
  const [planId, workItemId] = positional();
  if (!planId || !workItemId) exitWith(1, 'Usage: node scripts/agents/agent3-push-feature.js <testPlanId> <workItemId> --file "<approved.feature>" [--task-only]');
  const cfg = loadConfig();
  const a = cfg.automation || {};
  const taskOnly = !!arg('task-only');
  const file = arg('file');
  if (!taskOnly && (!file || file === true || !fs.existsSync(file))) exitWith(1, '❌ --file "<approved.feature>" is required and must exist (the exact file the user approved).');

  await preflight(cfg, ['task']);
  const task = taskAdapter(cfg);
  const requirement = await task.adapter.getWorkItem(task.ctx, workItemId);
  const mode = a.delivery?.mode || 'local';
  let deliveredTo = null;
  let prUrl = null;

  if (!taskOnly) {
    const base = path.basename(file);
    if (a.status === 'existing') {
      const repo = path.resolve(cfg.root, a.repo?.localPath || 'automation-repo');
      if (!fs.existsSync(path.join(repo, '.git'))) exitWith(1, `❌ Automation repo not found at ${repo}. Run: npm run sync-automation`);
      const targetRel = path.join(a.delivery?.targetFolder || a.repo?.featuresPath || 'PendingFeatures', base);
      const baseBranch = a.delivery?.baseBranch || a.repo?.branch || 'main';
      if (mode === 'local') {
        fs.mkdirSync(path.dirname(path.join(repo, targetRel)), { recursive: true });
        fs.copyFileSync(file, path.join(repo, targetRel));
        deliveredTo = path.join(repo, targetRel);
      } else {
        const branch = `qa-agent/${String(requirement.id).replace(/[^A-Za-z0-9_-]/g, '-')}-feature`;
        git(['fetch', 'origin', baseBranch], repo);
        const exists = (() => { try { git(['rev-parse', '--verify', branch], repo); return true; } catch { return false; } })();
        git(exists ? ['checkout', branch] : ['checkout', '-b', branch, `origin/${baseBranch}`], repo);
        fs.mkdirSync(path.dirname(path.join(repo, targetRel)), { recursive: true });
        fs.copyFileSync(file, path.join(repo, targetRel));
        git(['add', targetRel.replace(/\\/g, '/')], repo);
        const dirty = git(['status', '--porcelain', '--', targetRel.replace(/\\/g, '/')], repo);
        if (dirty) git(['commit', '-m', `QA Agent 3: feature file for ${requirement.id} - ${requirement.title}`.slice(0, 200)], repo);
        git(['push', '-u', 'origin', branch], repo);
        git(['checkout', baseBranch], repo);
        deliveredTo = `${a.repo.cloneUrl} @ ${branch}/${targetRel.replace(/\\/g, '/')}`;
        if (mode === 'pull-request') {
          try { prUrl = await openPullRequest(a.repo.cloneUrl, branch, baseBranch, `QA Agent 3: ${requirement.id} ${requirement.title}`.slice(0, 200), `Feature file generated from test plan ${planId} for ${requirement.url || requirement.id}.`, process.env); }
          catch (e) { console.log(`⚠️ ${e.message}`); }
        }
      }
    } else {
      const dir = path.join(cfg.root, 'automation-handoff', String(requirement.id));
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(file, path.join(dir, base));
      deliveredTo = path.join(dir, base);
    }
    console.log(`📦 Delivered: ${deliveredTo}${prUrl ? `\n🔀 Pull request: ${prUrl}` : ''}`);
  }

  // Tracking task for the automation owner (skip if a marker already exists → idempotent)
  const comments = await task.adapter.getComments(task.ctx, requirement.id).catch(() => []);
  const alreadyDone = comments.some((c) => c.text.includes(MARKERS.agent3));
  let taskRef = null;
  if (a.createTrackingTask !== false && a.owner?.name && !(alreadyDone && !arg('force'))) {
    try {
      taskRef = await task.adapter.createTask(task.ctx, {
        parentId: requirement.id,
        title: `Automate: ${requirement.title}`.slice(0, 250),
        description: `Automate the approved feature file for ${requirement.id}.\nTest plan: ${planId}\nFile: ${deliveredTo || '(already delivered)'}${prUrl ? `\nPR: ${prUrl}` : ''}`,
        assignee: { name: a.owner.name, id: a.owner.email || a.owner.name },
      });
      console.log(`🧾 Automation task created for ${a.owner.name}: ${taskRef.url || taskRef.id}`);
    } catch (e) { console.log(`⚠️ Automation task NOT created: ${e.message}`); }
  } else if (alreadyDone) console.log('ℹ️  Agent 3 marker already present - tracking task not duplicated (pass --force to create another).');

  const body = [
    `${MARKERS.agent3} Feature file delivered by QA Agent 3`,
    `Test plan: ${planId}`,
    deliveredTo ? `Delivered to: ${deliveredTo}` : 'Task backfill (file delivered earlier)',
    prUrl ? `Pull request: ${prUrl}` : null,
    taskRef ? `Automation task: ${taskRef.url || taskRef.id} (assigned to ${a.owner.name})` : null,
  ].filter(Boolean).join('\n');
  try { await task.adapter.addComment(task.ctx, requirement.id, body); } catch (e) { console.log(`⚠️ Audit comment not posted: ${e.message}`); }

  console.log('\n✅ Agent 3 complete');
})().catch((e) => { console.error(`❌ ${String(e.stderr || e.message).split('\n')[0]}`); process.exit(1); });
