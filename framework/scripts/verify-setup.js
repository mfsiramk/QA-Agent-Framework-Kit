#!/usr/bin/env node
/**
 * Verify the installation: config present, Node version, dependencies, live
 * connection to every configured tool, and the automation repo (if any).
 *   npm run verify
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./core/config');
const { check } = require('./core/preflight');

(async () => {
  const cfg = loadConfig();
  let bad = 0;
  const ok = (m) => console.log(`  ✅ ${m}`);
  const no = (m, fix) => { bad++; console.log(`  ❌ ${m}${fix ? `\n     → ${fix}` : ''}`); };

  console.log(`\n🔎 QA Agent Framework - setup check (${cfg.organization?.company || ''} / ${cfg.organization?.product || ''})\n`);
  const major = Number(process.versions.node.split('.')[0]);
  major >= 18 ? ok(`Node ${process.versions.node}`) : no(`Node ${process.versions.node} is too old`, 'Install Node 18 or newer from nodejs.org');
  try { require.resolve('xlsx'); ok('npm dependencies installed'); } catch { no('npm dependencies missing', 'Run: npm install'); }

  const kinds = ['task'];
  if (cfg.modules.agent2 || cfg.modules.agent3 || cfg.modules.qaAudit) kinds.push('test');
  if (cfg.modules.agent1) kinds.push('docs', 'design', 'code');
  else if (cfg.modules.bugReport && cfg.bugReport?.publish?.enabled) kinds.push('docs');
  console.log('\nConnections:');
  for (const r of await check(cfg, kinds)) r.ok ? ok(`${r.label}: ${r.message || 'connected'}`) : no(`${r.label}: ${r.message}`, r.fix);

  if (cfg.modules.queryRunner && cfg.queryRunner) {
    const { ENGINES } = require('./misc/lib/db');
    const eng = ENGINES[cfg.queryRunner.engine];
    console.log(`\nQuery Runner (${eng?.label || cfg.queryRunner.engine}):`);
    try { require.resolve(eng.driver); ok(`Driver "${eng.driver}" installed`); } catch { no(`Driver "${eng.driver}" not installed`, 'Run: npm install'); }
    const net = require('net');
    for (const e of cfg.queryRunner.environments || []) {
      const host = String(e.host).replace(/\\.*$/, '');
      const reach = await new Promise((res) => { const s = net.connect({ host, port: e.port }); s.setTimeout(5000); s.on('connect', () => { s.destroy(); res(true); }); s.on('timeout', () => { s.destroy(); res(false); }); s.on('error', () => res(false)); });
      reach ? ok(`${e.name}: ${host}:${e.port} reachable`) : no(`${e.name}: ${host}:${e.port} not reachable`, cfg.queryRunner.vpnRequired ? 'Connect to the VPN and try again.' : 'Check the server name / port and your network.');
    }
  }

  if (cfg.automation?.status === 'existing') {
    console.log('\nAutomation repository:');
    const repo = path.resolve(cfg.root, cfg.automation.repo.localPath || 'automation-repo');
    if (!fs.existsSync(repo)) no(`Not cloned yet at ${repo}`, 'Run: npm run sync-automation');
    else {
      ok(`Found at ${repo}`);
      const lib = path.join(cfg.root, 'steering', 'step-library.md');
      fs.existsSync(lib) ? ok('Step library built (steering/step-library.md)') : no('Step library not built', 'Run: npm run step-library');
    }
  }

  console.log(bad ? `\n⚠️  ${bad} problem(s) found - fix them and run "npm run verify" again.\n` : '\n🎉 All checks passed. Open this folder in your AI assistant and say e.g. "Generate test cases for <ID>".\n');
  process.exit(bad ? 1 : 0);
})();
