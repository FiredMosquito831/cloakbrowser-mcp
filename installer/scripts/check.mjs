import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(path, 'utf8');

const manifest = JSON.parse(await read(join(root, 'package.json')));
assert.equal(manifest.name, 'secret-agent-browser-mcps');
assert.equal(manifest.version, '1.0.0');
assert.deepEqual(Object.keys(manifest.bin).sort(), ['sabm', 'secret-agent-browser-mcps']);
assert.equal(manifest.engines.node, '>=22.13.0');
assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['commander', 'json5', 'smol-toml', 'yaml']);
assert.equal(manifest.scripts.check, 'node scripts/check.mjs');

const lock = JSON.parse(await read(join(root, 'package-lock.json')));
assert.equal(lock.packages[''].version, '1.0.0');
assert.equal(lock.name, 'secret-agent-browser-mcps');

const entry = await read(join(root, 'src', 'cli.mjs'));
assert.ok(entry.startsWith('#!/usr/bin/env node\n'), 'bin entry needs a node shebang');

for (const name of Object.keys(manifest.dependencies)) {
  await import(name);
}

const cloak = JSON.parse(
  await read(join(root, '..', 'plugins', 'cloakbrowser', '.claude-plugin', 'plugin.json')),
);
const camoufox = JSON.parse(
  await read(join(root, '..', 'plugins', 'camoufox', '.claude-plugin', 'plugin.json')),
);
const mcp = JSON.parse(await read(join(root, '..', 'plugins', 'cloakbrowser', '.mcp.json')));
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
  '.mcp.json maps an unknown user_config key',
);
const uniqueMappedKeys = [...new Set(placeholderKeys)].sort();
assert.deepEqual(uniqueMappedKeys, [...configKeys].sort(), '.mcp.json must map every userConfig option');
const fixedCount = envValues.length - placeholderKeys.length;
assert.ok(fixedCount > 0, '.mcp.json should carry fixed pins');

const srcDir = join(root, 'src');
const files = (await readdir(srcDir)).filter((name) => name.endsWith('.mjs')).sort();
assert.ok(files.includes('cli.mjs'));
const forbidden = [
  /node:child_process/,
  /\bspawn(Sync)?\s*\(/,
  /require\s*\(\s*['"]child_process/,
  /\bwriteFile(Sync)?\s*\(/,
  /\bappendFile(Sync)?\s*\(/,
  /\bcreateWriteStream\s*\(/,
  /\bmkdir(Sync)?\s*\(/,
  /\brmdir(Sync)?\s*\(/,
  /\bunlink(Sync)?\s*\(/,
  /\brename(Sync)?\s*\(/,
  /\brmSync\s*\(/,
  /\bfetch\s*\(/,
];
for (const name of files) {
  const source = await read(join(srcDir, name));
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${name} contains a forbidden call`);
  const checked = spawnSync(process.execPath, ['--check', join(srcDir, name)], { encoding: 'utf8' });
  assert.equal(checked.status, 0, `${name} failed node --check: ${checked.stderr}`);
}

process.stdout.write(
  `installer check: ok (name/version, 2 bins, ${Object.keys(manifest.dependencies).length} deps, schema 36/23 + ${uniqueMappedKeys.length} mappings + ${fixedCount} env pins, ${files.length} source files, zero-write static guard)\n`,
);
