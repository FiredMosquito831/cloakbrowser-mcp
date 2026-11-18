import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { shimPath } from '../src/paths.mjs';
import { envForHome, invoke, makeTree, SCHEMA_FROM } from './helpers.mjs';

test('list keeps Claude Code plugin-managed and never runs an external CLI', async () => {
  const tree = await makeTree('claude-code', 'user');
  const json = await invoke(['list', '--harness', 'claude-code', '--json'], tree);
  assert.equal(json.code, 0);
  const row = json.jsonLines[0].harnesses[0];
  assert.equal(row.status, 'plugin-managed');
  assert.equal(row.entry, 'plugin-managed (claude plugin)');
  assert.match(row.message, /claude plugin list --json/);
  const text = await invoke(['list', '--harness', 'claude-code'], tree);
  assert.match(text.out, /plugin-managed \(claude plugin\)/);
  assert.match(text.out, /claude plugin list --json/);
});

test('doctor --static reports the three Phase 0 skips and succeeds on a clean tree', async () => {
  const tree = await makeTree('codex', 'user');
  const result = await invoke(['doctor', '--static', '--json', '--data-root', tree.dataRoot], tree);
  assert.equal(result.code, 0);
  const names = result.jsonLines[0].checks.map((check) => check.name);
  for (const name of ['shim-current-json', 'engine-tree', 'settings-types']) assert.ok(names.includes(name));
  for (const check of result.jsonLines[0].checks) assert.notEqual(check.status, 'error');
  const text = await invoke(['doctor', '--static', '--data-root', tree.dataRoot], tree);
  assert.match(text.out, /SKIP  settings-types/);
  assert.match(text.out, /mode check only — not probed/);
});

test('install --dry-run plans a splice, detects current entries and refuses foreign ones', async () => {
  const tree = await makeTree('codex', 'user');
  const plan = await invoke(
    ['install', 'codex', '--dry-run', '--json', '--scope', 'user', '--data-root', tree.dataRoot],
    tree,
  );
  assert.equal(plan.code, 0);
  const body = plan.jsonLines[0];
  assert.equal(body.dryRun, true);
  assert.equal(body.changed, true);
  assert.equal(body.files[0].action, 'modify');
  assert.match(body.files[0].snippet, /\[mcp_servers\.cloakbrowser\]/);
  assert.match(body.files[0].backup, /\.sabm-backup-\d+/);
  assert.deepEqual(body.writes, []);
  assert.match(body.next.join(' '), /Phase 1/);

  const shim = shimPath(tree.dataRoot);
  await writeFile(
    tree.target.path,
    `[mcp_servers.cloakbrowser]\ncommand = "node"\nargs = [${JSON.stringify(shim)}, "--harness", "codex", "--entry", "cloakbrowser"]\n`,
  );
  const current = await invoke(
    ['install', 'codex', '--dry-run', '--json', '--data-root', tree.dataRoot],
    tree,
  );
  assert.equal(current.jsonLines[0].changed, false);
  assert.equal(current.jsonLines[0].files[0].action, 'noop');
  assert.equal(current.jsonLines[0].files[0].backup, null);

  const foreignTree = await makeTree('codex', 'user', 'foreign');
  const before = await invoke(
    ['install', 'codex', '--dry-run', '--json', '--data-root', foreignTree.dataRoot],
    foreignTree,
  );
  assert.equal(before.code, 2);
  assert.equal(before.jsonLines[0].error.kind, 'foreign-entry');
  assert.match(before.jsonLines[0].error.message, /config\.toml/);

  const claude = await invoke(['install', 'claude-code', '--dry-run', '--json'], tree);
  assert.equal(claude.code, 0);
  assert.deepEqual(claude.jsonLines[0].files, []);
  assert.ok(claude.jsonLines[0].commands.some((command) => command.includes('claude plugin install')));
  assert.ok(claude.jsonLines[0].commands.some((command) => command.includes('--values-stdin')));
});

test('configure --show redacts secrets, reports the absent document and the D0 notice', async () => {
  const tree = await makeTree('codex', 'user');
  const secret = 'hunter2-secret-value';
  const result = await invoke(
    ['configure', '--show', '--json', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot],
    tree,
    { env: { CLOAKBROWSER_LICENSE_KEY: secret, PLAYWRIGHT_MCP_PROXY_SERVER: `http://u:p@host/${secret}` } },
  );
  assert.equal(result.code, 0);
  assert.ok(!result.out.includes(secret), 'secret value never printed');
  const body = result.jsonLines[0];
  assert.equal(body.settings.length, 36);
  assert.equal(body.settingsDocument, 'absent (broker-owned; items 51/52)');
  const licence = body.settings.find((setting) => setting.key === 'licence_key');
  assert.equal(licence.value, 'configured: true');
  const engine = body.settings.find((setting) => setting.key === 'browser_engine');
  assert.equal(engine.value, 'cloak');
  assert.equal(engine.source, 'plugin.json');
  const host = await invoke(['configure', '--show', '--json', '--from', SCHEMA_FROM], tree, {
    env: { STEALTH_ENGINE: 'camoufox' },
  });
  assert.equal(
    host.jsonLines[0].settings.find((setting) => setting.key === 'browser_engine').value,
    'camoufox',
  );
  assert.match(
    host.jsonLines[0].settings.find((setting) => setting.key === 'browser_engine').source,
    /host environment/,
  );

  const claude = await invoke(
    ['configure', '--show', '--from', SCHEMA_FROM, '--harness', 'claude-code'],
    tree,
  );
  assert.match(claude.out, /plugin -> Configure/);
  assert.match(claude.out, /disjoint/);
});

test('--print-config prints only the snippet and the read-only line', async () => {
  const tree = await makeTree('antigravity', 'user');
  const text = await invoke(['--print-config', 'antigravity', '--data-root', tree.dataRoot], tree);
  assert.equal(text.code, 0);
  assert.match(text.out, /Antigravity — .*mcp_config\.json/);
  assert.match(text.out, /format: json/);
  assert.match(text.out, /read-only; nothing written\n?$/);
  const json = await invoke(['--print-config', 'antigravity', '--json', '--data-root', tree.dataRoot], tree);
  assert.equal(json.jsonLines[0].command, 'print-config');
  assert.match(json.jsonLines[0].snippet, /"mcpServers": \{/);
  assert.deepEqual(json.jsonLines[0].writes, []);
});

test('list --data-size never fabricates a size for an absent data root', async () => {
  const tree = await makeTree('codex', 'user');
  const missingRoot = `${tree.root}/not-created`;
  const result = await invoke(['list', '--json', '--data-size', '--data-root', missingRoot], tree);
  assert.equal(result.code, 0);
  assert.equal(result.jsonLines[0].dataSize, null);
  assert.match(result.jsonLines[0].dataSizeNote, /absent/);
});

test('configure --show without a schema tree refuses with an actionable one-liner', async () => {
  const tree = await makeTree('codex', 'user');
  const result = await invoke(['configure', '--show', '--json', '--from', `${tree.root}/no-plugin`], tree);
  assert.equal(result.code, 2);
  assert.equal(result.jsonLines[0].error.kind, 'config-not-found');
  assert.match(result.jsonLines[0].error.remedy, /--from/);
});
