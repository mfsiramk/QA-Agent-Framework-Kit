#!/usr/bin/env node
/**
 * Clone (first time) or fast-forward the client's existing automation repo.
 * READ-ONLY use by the agents except Agent 3's push script. Non-blocking:
 * on failure it warns and exits 0 so Agent 1 can continue with the cached copy.
 *   npm run sync-automation
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadConfig } = require('../core/config');

const cfg = loadConfig();
const a = cfg.automation || {};
if (a.status !== 'existing' || !a.repo?.cloneUrl) {
  console.log('ℹ️  No existing automation repo configured - nothing to sync.');
  process.exit(0);
}
const dir = path.resolve(cfg.root, a.repo.localPath || 'automation-repo');
const branch = a.repo.branch || 'main';
const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

try {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    console.log(`📥 Cloning ${a.repo.cloneUrl} (${branch}) → ${dir}`);
    git(['clone', '--branch', branch, a.repo.cloneUrl, dir], cfg.root);
  } else {
    git(['fetch', 'origin', branch], dir);
    const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
    if (current !== branch) {
      console.log(`⚠️  Automation repo is on "${current}", not "${branch}" - left untouched.`);
      process.exit(0);
    }
    git(['merge', '--ff-only', `origin/${branch}`], dir);
  }
  console.log(`✅ Automation repo up to date at ${git(['rev-parse', '--short', 'HEAD'], dir)} (${branch})`);
} catch (e) {
  console.log(`⚠️  Could not sync the automation repo: ${String(e.stderr || e.message).split('\n')[0]}`);
  console.log('   Continuing with the local copy. Check git credentials / VPN if this persists.');
}
