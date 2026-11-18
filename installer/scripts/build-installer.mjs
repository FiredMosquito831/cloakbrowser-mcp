// Deterministic engine bundle. Copies the cloakbrowser tree into dist/engine,
// writes dist/bin (stable shim + vendored resolver) and dist/bundle.json with
// SHA-256 hashes. --check verifies the committed sources against that manifest.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
const PLUGIN = join(REPO, 'plugins', 'cloakbrowser');
const DIST = join(ROOT, 'dist');
const EXCLUDED = /(^|[\\/])(README\.md|__pycache__|\.DS_Store|node_modules)([\\/]|$)/;
const SHIM_FILES = ['run.mjs', 'envelope.mjs'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function listFiles(root, prefix = '') {
  const found = [];
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return found;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const child = prefix ? join(prefix, entry.name) : entry.name;
    if (EXCLUDED.test(child)) continue;
    if (entry.isDirectory()) found.push(...(await listFiles(root, child)));
    else if (entry.isFile()) found.push(child.replace(/\\/g, '/'));
  }
  return found;
}

async function hashes(root) {
  const result = {};
  for (const file of await listFiles(root)) result[file] = sha256(await readFile(join(root, file)));
  return result;
}

async function vendoredHashes() {
  const result = {};
  for (const file of await listFiles(join(ROOT, 'vendor'))) {
    result[`vendor/${file}`] = sha256(await readFile(join(ROOT, 'vendor', file)));
  }
  return result;
}

async function canonicalHashes() {
  const result = {};
  for (const file of await listFiles(join(REPO, 'shared', 'core', 'lib'))) {
    result[`vendor/lib/${file}`] = sha256(await readFile(join(REPO, 'shared', 'core', 'lib', file)));
  }
  result['vendor/engine-registry.mjs'] = sha256(
    await readFile(join(REPO, 'shared', 'core', 'engine-registry.mjs')),
  );
  return result;
}

async function main() {
  const manifest = JSON.parse(await readFile(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const engineDir = join(DIST, 'engine', manifest.version);
  const checkOnly = process.argv.includes('--check');
  if (!checkOnly) {
    await rm(engineDir, { recursive: true, force: true });
    await mkdir(engineDir, { recursive: true });
    await cp(PLUGIN, engineDir, { recursive: true, filter: (source) => !EXCLUDED.test(source) });
    const binDir = join(DIST, 'bin');
    await rm(binDir, { recursive: true, force: true });
    await mkdir(binDir, { recursive: true });
    for (const name of SHIM_FILES) {
      const source = name === 'run.mjs' ? join(ROOT, 'src', 'bin', name) : join(ROOT, 'src', name);
      await cp(source, join(binDir, name));
    }
    await cp(join(ROOT, 'src', 'shim-runtime.mjs'), join(binDir, 'shim-runtime.mjs'));
    await cp(join(ROOT, 'vendor'), join(binDir, 'vendor'), { recursive: true });
    const bundle = {
      schema: 'sabm-bundle/1',
      cliVersion: pkg.version,
      pluginVersion: manifest.version,
      files: await hashes(engineDir),
    };
    await writeFile(join(DIST, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);
    process.stdout.write(
      `installer build: ${bundle.pluginVersion}, ${Object.keys(bundle.files).length} engine files\n`,
    );
    return;
  }
  const bundle = JSON.parse(await readFile(join(DIST, 'bundle.json'), 'utf8'));
  if (bundle.cliVersion !== pkg.version || bundle.pluginVersion !== manifest.version) {
    throw new Error('bundle.json version drift; rerun npm --prefix installer run build');
  }
  const actual = await hashes(engineDir);
  if (JSON.stringify(actual) !== JSON.stringify(bundle.files)) {
    const changed = Object.keys({ ...actual, ...bundle.files }).filter(
      (key) => actual[key] !== bundle.files[key],
    );
    throw new Error(`bundle drift: ${changed.join(', ') || 'file set changed'}`);
  }
  const vendored = await vendoredHashes();
  const canonical = await canonicalHashes();
  for (const [key, value] of Object.entries(canonical)) {
    if (vendored[key] !== value) throw new Error(`vendored ${key} is not byte-identical to shared/core`);
  }
  const shim = await readFile(join(DIST, 'bin', 'run.mjs'), 'utf8');
  if (!shim.startsWith('#!/usr/bin/env node\n')) throw new Error('dist/bin/run.mjs lost its node shebang');
  process.stdout.write(
    `installer build --check: ok (${Object.keys(bundle.files).length} engine files, ${Object.keys(canonical).length} vendored core files byte-identical)\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
