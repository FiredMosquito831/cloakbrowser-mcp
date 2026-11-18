import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO = resolve(ROOT, '..');
const PREFIX = resolve(tmpdir(), 'sabm-installer-packaging');
await mkdir(PREFIX, { recursive: true });

function run(command, args, options = {}) {
  const isNpm = command === 'npm';
  const executable = isNpm && process.platform === 'win32' ? 'npm.cmd' : command;
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    shell: isNpm && process.platform === 'win32',
    ...options,
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stdout}\n${result.stderr}`);
  return result;
}

test('npm pack ships dist, vendor and bin with no postinstall and stays under 3 MB', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.postinstall, undefined);
  assert.deepEqual(Object.keys(manifest.bin).sort(), ['sabm', 'secret-agent-browser-mcps']);
  const dry = run('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT });
  const described = JSON.parse(dry.stdout)[0];
  const paths = described.files.map((file) => file.path);
  for (const required of [
    'package.json',
    'src/cli.mjs',
    'dist/bin/run.mjs',
    'dist/bin/vendor/lib/settings-precedence.mjs',
    'dist/bundle.json',
  ]) {
    assert.ok(paths.includes(required), `tarball is missing ${required}`);
  }
  const pack = run('npm', ['pack', '--json', '--pack-destination', PREFIX], { cwd: ROOT });
  const tarball = JSON.parse(pack.stdout)[0].filename;
  const bytes = (await stat(join(PREFIX, tarball))).size;
  assert.ok(bytes <= 3 * 1024 * 1024, `tarball is ${bytes} bytes (> 3 MB)`);
  assert.match(await readFile(join(ROOT, 'src', 'cli.mjs'), 'utf8'), /^#!\/usr\/bin\/env node/);
});

test('packaged tarball installs into a scratch prefix and runs the smoke commands', async () => {
  const pack = run('npm', ['pack', '--json', '--pack-destination', PREFIX], { cwd: ROOT });
  const tarball = join(PREFIX, JSON.parse(pack.stdout)[0].filename);
  const prefix = await mkdtemp(join(tmpdir(), 'sabm-packaged-'));
  run('npm', ['install', '--prefix', prefix, tarball, '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: REPO,
  });
  const cli = join(prefix, 'node_modules', 'secret-agent-browser-mcps', 'src', 'cli.mjs');
  const env = {
    ...process.env,
    HOME: prefix,
    USERPROFILE: prefix,
    XDG_CONFIG_HOME: join(prefix, '.config'),
    CODEX_HOME: join(prefix, '.codex'),
    TMP: join(prefix, 'tmp'),
    TEMP: join(prefix, 'tmp'),
    TMPDIR: join(prefix, 'tmp'),
    STEALTH_DATA_DIR: '',
  };
  const version = run(process.execPath, [cli, '--version'], { env });
  assert.match(version.stdout, /secret-agent-browser-mcps 1\.1\.0/);
  const list = run(process.execPath, [cli, 'list', '--json'], { env });
  const envelope = JSON.parse(list.stdout);
  assert.equal(envelope.schema, 'sabm/1');
  assert.deepEqual(envelope.writes, []);
  const plan = run(process.execPath, [cli, 'install', 'codex', '--dry-run', '--json'], { env });
  const installed = JSON.parse(plan.stdout);
  assert.equal(installed.ok, true);
  assert.deepEqual(installed.writes, []);
  assert.equal(installed.dryRun, true);
  assert.ok(installed.engineTree?.pluginVersion, 'packaged CLI found its bundled engine');
});
