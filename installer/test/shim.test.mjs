import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { composeEnvironment } from '../src/shim-runtime.mjs';
import { shimPath } from '../src/paths.mjs';
import { readCurrent } from '../src/engine.mjs';
import { writeSettingsValue, SETTINGS_ENV_NAMES } from '../src/settings-documents.mjs';
import { envForHome, INSTALLER_ROOT, invoke, makeTree, SCHEMA_FROM } from './helpers.mjs';

async function installedTree(harness = 'codex') {
  const tree = await makeTree(harness, 'user');
  const result = await invoke(
    ['install', harness, '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(result.code, 0, result.out);
  return tree;
}

function baseEnv(tree, extra = {}) {
  return { ...envForHome(tree), STEALTH_DATA_DIR: tree.dataRoot, ...extra };
}

test('shim precedence: global < harness < entry < project < host env', async () => {
  const tree = await installedTree();
  for (const [level, key, value] of [
    ['global', 'headless', 'true'],
    ['harness', 'on_locked', 'block'],
    ['entry', 'copy_contents', 'full'],
    ['project', 'humanize', 'false'],
  ]) {
    await writeSettingsValue({
      dataRoot: tree.dataRoot,
      harness: 'codex',
      level,
      key,
      value,
      entry: 'cloakbrowser',
      project: tree.project,
    });
  }
  const env = baseEnv(tree);
  const composed = await composeEnvironment({
    dataRoot: tree.dataRoot,
    harness: 'codex',
    entry: 'cloakbrowser',
    env,
    cwd: tree.project,
  });
  assert.equal(composed.env[SETTINGS_ENV_NAMES.headless], 'true');
  assert.equal(composed.env[SETTINGS_ENV_NAMES.on_locked], 'block');
  assert.equal(composed.env[SETTINGS_ENV_NAMES.copy_contents], 'full');
  assert.equal(composed.env[SETTINGS_ENV_NAMES.humanize], 'false');
  assert.equal(composed.env.STEALTH_DATA_DIR, tree.dataRoot);
  assert.equal(composed.env.STEALTH_HARNESS, 'codex');
  assert.equal(Object.hasOwn(composed.env, 'CLAUDE_PLUGIN_DATA'), false);

  const host = await composeEnvironment({
    dataRoot: tree.dataRoot,
    harness: 'codex',
    entry: 'cloakbrowser',
    env: { ...env, [SETTINGS_ENV_NAMES.headless]: 'false', [SETTINGS_ENV_NAMES.humanize]: 'true' },
    cwd: tree.project,
  });
  assert.equal(host.env[SETTINGS_ENV_NAMES.headless], 'false');
  assert.equal(host.env[SETTINGS_ENV_NAMES.humanize], 'true');

  const printed = await invoke(
    ['configure', 'codex', '--print-env', '--json', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot],
    tree,
    { env },
  );
  assert.equal(printed.code, 0, printed.out);
  assert.deepEqual(
    printed.jsonLines[0].environment,
    composed.env,
    'configure --print-env equals the shim env',
  );
});

test('the child receives exactly the composed environment from a stub engine', async () => {
  const tree = await installedTree();
  const current = await readCurrent(tree.dataRoot);
  const broker = join(tree.dataRoot, 'engine', current.pluginVersion, 'broker.mjs');
  await writeFile(broker, 'process.stderr.write(`SABM_ENV=${JSON.stringify(process.env)}\\n`);\n');
  const env = baseEnv(tree);
  const composed = await composeEnvironment({
    dataRoot: tree.dataRoot,
    harness: 'codex',
    entry: 'cloakbrowser',
    env,
    cwd: tree.project,
  });
  const child = spawnSync(
    process.execPath,
    [shimPath(tree.dataRoot), '--harness', 'codex', '--entry', 'cloakbrowser'],
    {
      env,
      cwd: tree.project,
      encoding: 'utf8',
    },
  );
  const line = child.stderr.split('\n').find((value) => value.startsWith('SABM_ENV='));
  assert.ok(line, `stub engine did not print its env: ${child.stderr}`);
  const observed = JSON.parse(line.slice('SABM_ENV='.length));
  for (const key of [
    'STEALTH_DATA_DIR',
    'STEALTH_HARNESS',
    'CLOAK_PLAYWRIGHT_MCP_PACKAGE',
    'STEALTH_TOOL_PROFILE',
  ]) {
    assert.equal(observed[key], composed.env[key], `${key} differs between report and child`);
  }
  assert.equal(observed.STEALTH_HARNESS, 'codex');
  assert.equal(Object.hasOwn(observed, 'CLAUDE_PLUGIN_DATA'), false);
});

const STUB_SERVER = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const at = buffer.indexOf('\\n');
    if (at === -1) break;
    const raw = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    let message;
    try { message = JSON.parse(raw); } catch { continue; }
    if (!message.method || message.id === undefined) continue;
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'stub', version: '0' }, capabilities: {} };
    else if (message.method === 'tools/list') result = { tools: ['browser_capabilities','browser_engine_status','browser_profiles'].map((name) => ({ name, inputSchema: { type: 'object' } })) };
    else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ dataDir: process.env.STEALTH_DATA_DIR, engine: 'cloak', toolProfile: 'portable', backendState: 'running', backendSubstate: null, startupMs: 12, provisioning: null }) }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// Hold the inherited stdio pipes open; only real process-tree teardown lets
// the runner exit. This intentionally has no stdin 'end' handler.
const SILENT_BROKER = 'setInterval(() => {}, 1000);\n';

test('doctor --start against a stub MCP server passes with three meta tools', async () => {
  const tree = await installedTree();
  const current = await readCurrent(tree.dataRoot);
  await writeFile(join(tree.dataRoot, 'engine', current.pluginVersion, 'broker.mjs'), STUB_SERVER);
  const result = await invoke(
    [
      'doctor',
      'codex',
      '--start',
      '--timeout',
      '45000',
      '--json',
      '--from',
      SCHEMA_FROM,
      '--data-root',
      tree.dataRoot,
    ],
    tree,
    { env: baseEnv(tree) },
  );
  assert.equal(result.code, 0, result.out);
  const body = result.jsonLines[0];
  const names = body.checks.map((check) => check.name);
  for (const name of ['start-initialize', 'start-tools-list', 'start-capabilities'])
    assert.ok(names.includes(name));
  assert.ok(
    body.checks.every((check) => check.status !== 'error'),
    JSON.stringify(body.checks),
  );
  assert.match(
    body.checks.find((check) => check.name === 'start-tools-list').message,
    /cold meta-only start is a PASS/,
  );
  assert.equal(body.staticOnly, false);
  assert.deepEqual(body.writes, []);
});

test('doctor --start honours --timeout and never launches a browser', async () => {
  const tree = await installedTree();
  const current = await readCurrent(tree.dataRoot);
  await writeFile(join(tree.dataRoot, 'engine', current.pluginVersion, 'broker.mjs'), SILENT_BROKER);
  const result = await invoke(
    [
      'doctor',
      'codex',
      '--start',
      '--timeout',
      '400',
      '--json',
      '--from',
      SCHEMA_FROM,
      '--data-root',
      tree.dataRoot,
    ],
    tree,
    { env: baseEnv(tree) },
  );
  assert.equal(result.code, 3, result.out);
  assert.equal(result.jsonLines[0].error.code, 'verification_failed');
  assert.ok(result.jsonLines[0].checks.some((check) => check.name === 'start-handshake'));
  const refused = await invoke(
    ['doctor', 'codex', '--browser', '--json', '--data-root', tree.dataRoot],
    tree,
  );
  assert.equal(refused.code, 2);
  assert.match(refused.jsonLines[0].error.message, /later phase/);
});

test('a failed doctor --start leaves no child handles and the process exits promptly', async () => {
  const tree = await installedTree();
  const current = await readCurrent(tree.dataRoot);
  await writeFile(join(tree.dataRoot, 'engine', current.pluginVersion, 'broker.mjs'), SILENT_BROKER);
  const cliUrl = pathToFileURL(join(INSTALLER_ROOT, 'src', 'cli.mjs')).href;
  const argv = [
    'doctor',
    'codex',
    '--start',
    '--timeout',
    '400',
    '--json',
    '--from',
    SCHEMA_FROM,
    '--data-root',
    tree.dataRoot,
  ];
  const runner = join(tree.root, 'doctor-failure-runner.mjs');
  await writeFile(
    runner,
    `import { main } from ${JSON.stringify(cliUrl)};
const out = [];
const sink = () => ({ write(text) { out.push(String(text)); return true; } });
const code = await main(${JSON.stringify(argv)}, {
  stdout: sink(), stderr: sink(), env: process.env, platform: process.platform,
  homedir: process.env.HOME || process.env.USERPROFILE || '', cwd: process.cwd(),
});
process.stdout.write(JSON.stringify({ code, out: out.join('') }));
`,
  );
  const started = Date.now();
  const child = spawnSync(process.execPath, [runner], {
    env: baseEnv(tree),
    cwd: tree.project,
    encoding: 'utf8',
    timeout: 10000,
  });
  const elapsed = Date.now() - started;
  assert.equal(child.error, undefined, `runner did not exit: ${child.stderr ?? child.error}`);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.ok(elapsed < 9000, `runner took ${elapsed} ms; child handles survived`);
  const body = JSON.parse(child.stdout);
  assert.equal(body.code, 3);
  assert.match(body.out, /start-handshake/);
});
