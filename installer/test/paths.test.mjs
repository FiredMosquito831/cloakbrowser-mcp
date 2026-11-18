import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { makeContext, resolveDataRoot, shimArgs, shimPath } from '../src/paths.mjs';
import { resolveTarget } from '../src/harnesses.mjs';
import { envForHome, invoke, makeTree } from './helpers.mjs';

test('data-root precedence and shim arguments', async () => {
  const tree = await makeTree('codex', 'user');
  const context = makeContext({ homedir: tree.home, env: envForHome(tree), cwd: tree.project });
  assert.equal(resolveDataRoot({}, context).path, tree.envRoot);
  assert.equal(resolveDataRoot({}, context).source, 'env:STEALTH_DATA_DIR');
  const explicit = resolveDataRoot({ dataRoot: tree.dataRoot }, context);
  assert.equal(explicit.path, tree.dataRoot);
  assert.equal(explicit.source, 'cli');
  const fallback = resolveDataRoot({}, makeContext({ homedir: tree.home, env: {}, cwd: tree.project }));
  assert.equal(fallback.path, join(tree.home, '.secret-agent-browser-mcps'));
  assert.deepEqual(shimArgs('codex', 'cloakbrowser', tree.dataRoot), [
    'node',
    shimPath(tree.dataRoot),
    '--harness',
    'codex',
    '--entry',
    'cloakbrowser',
  ]);

  const fromCli = await invoke(['list', '--json', '--data-root', tree.dataRoot], tree);
  assert.equal(fromCli.code, 0);
  assert.equal(fromCli.jsonLines[0].dataRoot, tree.dataRoot);
  assert.equal(fromCli.jsonLines[0].dataRootSource, 'cli');
});

test('path matrix, overrides, derived labels and Windows refusal', async () => {
  const tree = await makeTree('codex', 'user');
  const env = envForHome(tree);
  const context = makeContext({ homedir: tree.home, env, cwd: tree.project, platform: 'linux' });

  const codex = await resolveTarget('codex', { scope: 'user' }, context);
  assert.equal(codex.path, join(tree.home, '.codex', 'config.toml'));
  assert.equal(codex.pathSource, 'documented');

  const antigravity = await resolveTarget('antigravity', { scope: 'project' }, context);
  assert.match(antigravity.path.replace(/\\/g, '/'), /\.agents\/mcp_config\.json$/);
  assert.equal(antigravity.pathSource, 'documented');

  const openclaw = await resolveTarget('openclaw', { scope: 'user' }, context);
  assert.equal(openclaw.path, env.OPENCLAW_CONFIG_PATH);
  assert.equal(openclaw.pathSource, 'documented');

  const hermes = await resolveTarget('hermes', { scope: 'user' }, context);
  assert.match(hermes.path.replace(/\\/g, '/'), /\/config\.yaml$/);

  const custom = await resolveTarget(
    'codex',
    { scope: 'user' },
    makeContext({
      homedir: tree.home,
      env: { CODEX_HOME: tree.envRoot },
      cwd: tree.project,
      platform: 'linux',
    }),
  );
  assert.equal(custom.path, join(tree.envRoot, 'config.toml'));

  const win = makeContext({ homedir: tree.home, env: {}, cwd: tree.project, platform: 'win32' });
  assert.equal((await resolveTarget('opencode', { scope: 'user' }, win)).refused, true);
  assert.equal((await resolveTarget('hermes', { scope: 'user' }, win)).refused, true);
  assert.equal((await resolveTarget('codex', { scope: 'user' }, win)).pathSource, 'derived');
  assert.equal((await resolveTarget('antigravity', { scope: 'user' }, win)).pathSource, 'derived');
  assert.equal((await resolveTarget('openclaw', { scope: 'user' }, win)).pathSource, 'derived');

  const unsupported = await invoke(['install', 'openclaw', '--scope', 'project', '--dry-run'], tree);
  assert.equal(unsupported.code, 2);
  assert.equal(unsupported.jsonLines[0].error.kind, 'unsupported-scope');
  assert.match(unsupported.jsonLines[0].error.message, /OPENCLAW_CONFIG_PATH/);
});
