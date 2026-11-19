import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CLI_VERSION } from '../src/engine.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '..');
const read = (path) => readFile(path, 'utf8');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

const manifest = JSON.parse(await read(join(root, 'package.json')));
assert.equal(manifest.name, 'secret-agent-browser-mcps');
assert.deepEqual(manifest.repository, {
  type: 'git',
  url: 'git+https://github.com/FiredMosquito831/secret-agent-browser-mcps.git',
});
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
assert.equal(manifest.version, CLI_VERSION);
assert.deepEqual(Object.keys(manifest.bin).sort(), ['sabm', 'secret-agent-browser-mcps']);
assert.equal(manifest.engines.node, '>=22.13.0');
assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['commander', 'json5', 'smol-toml', 'yaml']);
assert.equal(manifest.scripts.check, 'node scripts/check.mjs');
assert.ok(manifest.files.includes('dist') && manifest.files.includes('vendor'), 'dist and vendor must ship');
assert.equal(manifest.scripts.postinstall, undefined, 'the package must never install at npm install time');

const lock = JSON.parse(await read(join(root, 'package-lock.json')));
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages[''].version, manifest.version);
assert.equal(lock.name, 'secret-agent-browser-mcps');
assert.deepEqual(lock.packages[''].repository, manifest.repository);

const entry = await read(join(root, 'src', 'cli.mjs'));
assert.ok(entry.startsWith('#!/usr/bin/env node\n'), 'bin entry needs a node shebang');
for (const name of Object.keys(manifest.dependencies)) await import(name);

const vendored = await read(join(root, 'vendor', 'lib', 'settings-precedence.mjs'));
assert.equal(
  hash(vendored),
  hash(await read(join(repo, 'shared', 'core', 'lib', 'settings-precedence.mjs'))),
  'vendored settings-precedence.mjs is not byte-identical to shared/core',
);
const registry = await read(join(root, 'vendor', 'engine-registry.mjs'));
assert.equal(hash(registry), hash(await read(join(repo, 'shared', 'core', 'engine-registry.mjs'))));

const cloak = JSON.parse(await read(join(repo, 'plugins', 'cloakbrowser', '.claude-plugin', 'plugin.json')));
const camoufox = JSON.parse(await read(join(repo, 'plugins', 'camoufox', '.claude-plugin', 'plugin.json')));
const mcp = JSON.parse(await read(join(repo, 'plugins', 'cloakbrowser', '.mcp.json')));
const configKeys = Object.keys(cloak.userConfig);
assert.equal(configKeys.length, 36);
assert.equal(Object.keys(camoufox.userConfig).length, 23);
const envValues = Object.values(mcp.cloakbrowser.env).map(String);
const placeholderKeys = envValues
  .map((value) => /^\$\{user_config\.([^}]+)\}$/.exec(value)?.[1])
  .filter(Boolean);
assert.deepEqual(
  placeholderKeys.filter((key) => !configKeys.includes(key)),
  [],
);
assert.deepEqual([...new Set(placeholderKeys)].sort(), [...configKeys].sort());
assert.ok(envValues.length - placeholderKeys.length > 0);

const srcDir = join(root, 'src');
async function sourceFiles(dir, prefix = '') {
  const files = [];
  for (const item of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const name = prefix ? join(prefix, item.name) : item.name;
    if (item.isDirectory()) files.push(...(await sourceFiles(dir, name)));
    else if (name.endsWith('.mjs')) files.push(name.replace(/\\/g, '/'));
  }
  return files;
}
const files = await sourceFiles(srcDir);
const READ_ONLY = new Set([
  'cli.mjs',
  'envelope.mjs',
  'harnesses.mjs',
  'parsers.mjs',
  'paths.mjs',
  'report.mjs',
  'schema.mjs',
  'schema-validation.mjs',
  'settings-documents.mjs',
]);
const forbidden = [
  /node:child_process/,
  /\bspawn(Sync)?\s*\(/,
  /\bwriteFile(Sync)?\s*\(/,
  /\bappendFile(Sync)?\s*\(/,
  /\bcreateWriteStream\s*\(/,
  /\bmkdir(Sync)?\s*\(/,
  /\bunlink(Sync)?\s*\(/,
  /\brename(Sync)?\s*\(/,
  /\bfetch\s*\(/,
];
for (const name of files) {
  const source = await read(join(srcDir, name));
  if (READ_ONLY.has(name)) {
    for (const pattern of forbidden)
      assert.doesNotMatch(source, pattern, `${name} contains a forbidden write/process call`);
  }
  const checked = spawnSync(process.execPath, ['--check', join(srcDir, name)], { encoding: 'utf8' });
  assert.equal(checked.status, 0, `${name} failed node --check: ${checked.stderr}`);
}

const bundled = spawnSync(process.execPath, [join(root, 'scripts', 'build-installer.mjs'), '--check'], {
  encoding: 'utf8',
});
assert.equal(bundled.status, 0, `bundle check failed: ${bundled.stdout}${bundled.stderr}`);
process.stdout.write(bundled.stdout);

process.stdout.write(
  `installer check: ok (name/version, 2 bins, ${Object.keys(manifest.dependencies).length} deps, schema 36/23 + ${new Set(placeholderKeys).size} mappings + ${envValues.length - placeholderKeys.length} env pins, ${files.length} source files, vendored hash match)\n`,
);
