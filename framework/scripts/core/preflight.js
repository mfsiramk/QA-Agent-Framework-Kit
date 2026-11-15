/**
 * Credential preflight - live-checks the tools an agent is about to use.
 * Exits 4 with CREDENTIALS_INVALID and plain-language fix steps on failure.
 *
 *   await preflight(cfg, ['task', 'test', 'docs', 'design', 'code']);
 */

const { taskAdapter, testAdapter, docsAdapters, designAdapters, codeAdapter } = require('./config');

// Each resolver returns a list of { adapter, ctx } (docs/design may have several sources).
const RESOLVERS = {
  task: (c) => [taskAdapter(c)],
  test: (c) => [testAdapter(c)],
  docs: docsAdapters,
  design: designAdapters,
  code: (c) => [codeAdapter(c)].filter(Boolean),
};

async function check(cfg, kinds) {
  const results = [];
  for (const kind of kinds) {
    let list;
    try { list = RESOLVERS[kind](cfg); } catch (e) { results.push({ kind, ok: false, label: kind, message: e.message, fix: 'Re-run the installer and pick a supported tool.' }); continue; }
    for (const pair of list) {
      let r;
      try { r = await pair.adapter.testConnection(pair.ctx); } catch (e) { r = { ok: false, message: e.message }; }
      results.push({ kind, label: pair.adapter.label || kind, ...r });
    }
  }
  return results;
}

async function preflight(cfg, kinds, { quiet = false } = {}) {
  const results = await check(cfg, kinds);
  const failed = results.filter((r) => !r.ok);
  if (!quiet) {
    console.log('🔐 Credential preflight');
    results.forEach((r) => console.log(`   ${r.ok ? '✅' : '❌'} ${r.label}: ${r.message || (r.ok ? 'connected' : 'failed')}`));
  }
  if (failed.length) {
    console.log('\nCREDENTIALS_INVALID - the agent has stopped.\n');
    failed.forEach((r) => {
      console.log(`• ${r.label}: ${r.message}`);
      console.log(`  How to fix: ${r.fix || 'Create a new token for this tool, paste it into .env (replace the old value), save the file, then say "done".'}`);
      console.log('  Do not paste the token into the chat - edit .env directly.\n');
    });
    process.exit(4);
  }
  return results;
}

module.exports = { preflight, check };
