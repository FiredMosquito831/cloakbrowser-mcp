#!/usr/bin/env node
// Keep every plugin's shared core byte-identical to shared/core.
//
// A Claude Code plugin install copies only the plugin directory, so the broker,
// launchers, lib/ helpers, canonical contract and shared profiles document must
// exist inside each plugin. This script is the only writer: edit shared/core,
// run --write, commit both sides.
//
// Engine manifests are per plugin. The universal plugin holds the canonical
// manifest for every engine; a plugin's plugin-config.json names the ids it
// ships, and this script copies those files (plus the shared profiles.json)
// into it. --check fails on a byte difference, a missing copy, an unexpected
// engine manifest or an invalid plugin-config.json.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.dirname(path.dirname(SCRIPT_PATH));
const LOG_PREFIX = '[sync-plugin-core]';

// Files that must be identical in every core plugin. Keep this list explicit:
// a new shared file is a deliberate decision, not an accident of a glob.
export const CORE_FILES = Object.freeze([
  'broker.mjs',
  'camoufox_bootstrap.py',
  'camoufox_entry.py',
  'contracts/playwright-canonical.json',
  'engine-registry.mjs',
  'engines/profiles.json',
  'lib/attach.mjs',
  'lib/profile.mjs',
  'lib/provision.mjs',
  'lib/surface.mjs',
  'launch-camoufox-native.mjs',
  'launch-camoufox.mjs',
  'launch-kameleo.mjs',
  'launch.mjs',
]);

export const CORE_ROOT = 'shared/core';
export const PLUGINS_ROOT = 'plugins';
export const PLUGIN_CONFIG_FILE = 'plugin-config.json';
export const PROFILES_FILE = 'engines/profiles.json';
// The universal plugin owns the canonical engine manifests.
export const UNIVERSAL_PLUGIN = 'cloakbrowser';
const ENGINE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function log(message) {
  process.stdout.write(`${LOG_PREFIX} ${message}\n`);
}

function fail(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function readText(file) {
  return readFileSync(file, 'utf8');
}

function readJson(file) {
  return JSON.parse(readText(file));
}

function listPluginDirectories(root) {
  const pluginsDir = path.join(root, PLUGINS_ROOT);
  let entries;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch (error) {
    return { directories: [], errors: [`Cannot read ${pluginsDir}: ${error.message}`] };
  }
  return {
    directories: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
    errors: [],
  };
}

function validatePluginConfig(name, config) {
  const errors = [];
  if (!isPlainObject(config)) {
    return [`plugins/${name}/${PLUGIN_CONFIG_FILE} must be a JSON object`];
  }
  if (typeof config.core !== 'boolean') {
    errors.push(`plugins/${name}/${PLUGIN_CONFIG_FILE} "core" must be a boolean`);
  }
  if (!Array.isArray(config.engines)) {
    return [...errors, `plugins/${name}/${PLUGIN_CONFIG_FILE} "engines" must be an array`];
  }
  const seen = new Set();
  for (const [index, id] of config.engines.entries()) {
    const label = `plugins/${name}/${PLUGIN_CONFIG_FILE} engines[${index}]`;
    if (!nonEmptyString(id)) {
      errors.push(`${label} must be a non-empty engine id`);
      continue;
    }
    if (id === 'profiles') {
      errors.push(`${label} must not be "profiles"; ${PROFILES_FILE} is shared core`);
      continue;
    }
    if (!ENGINE_ID_PATTERN.test(id)) {
      errors.push(`${label} "${id}" is not a lowercase engine id`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`${label} declares "${id}" more than once`);
      continue;
    }
    seen.add(id);
  }
  if (config.core !== true && config.engines.length > 0) {
    errors.push(`plugins/${name}/${PLUGIN_CONFIG_FILE} declares engines but not "core": true`);
  }
  return errors;
}

/**
 * Resolve every plugin's expected files as { relativePath: sourcePath }.
 * Reading is separate from writing so --check never mutates the tree.
 *
 * @param {string} root Repository root to inspect.
 * @returns {{plugins: {name: string, config: object, expected: Map<string, string>}[], errors: string[]}} Plan.
 */
export function collectExpected(root) {
  const errors = [];
  const coreDir = path.join(root, CORE_ROOT);
  for (const relative of CORE_FILES) {
    if (!existsSync(path.join(coreDir, relative))) {
      errors.push(`missing canonical core file ${CORE_ROOT}/${relative}`);
    }
  }
  const { directories, errors: directoryErrors } = listPluginDirectories(root);
  errors.push(...directoryErrors);
  const universalEngines = path.join(root, PLUGINS_ROOT, UNIVERSAL_PLUGIN, 'engines');
  const plugins = [];
  for (const name of directories) {
    const configPath = path.join(root, PLUGINS_ROOT, name, PLUGIN_CONFIG_FILE);
    if (!existsSync(configPath)) {
      errors.push(`plugins/${name}/${PLUGIN_CONFIG_FILE} is missing; every shipped plugin declares its core`);
      continue;
    }
    let config;
    try {
      config = readJson(configPath);
    } catch (error) {
      errors.push(`cannot read plugins/${name}/${PLUGIN_CONFIG_FILE}: ${error.message}`);
      continue;
    }
    const configErrors = validatePluginConfig(name, config);
    errors.push(...configErrors);
    if (configErrors.length > 0) {
      continue;
    }
    const expected = new Map();
    if (config.core) {
      for (const relative of CORE_FILES) {
        expected.set(relative, path.join(coreDir, relative));
      }
    }
    for (const id of config.engines) {
      const source = path.join(universalEngines, `${id}.json`);
      if (!existsSync(source)) {
        errors.push(
          `plugins/${name}/${PLUGIN_CONFIG_FILE} names engine "${id}" but ${PLUGINS_ROOT}/${UNIVERSAL_PLUGIN}/engines/${id}.json does not exist`,
        );
        continue;
      }
      expected.set(`engines/${id}.json`, source);
    }
    plugins.push({ name, config, expected });
  }
  return { plugins, errors };
}

function destinationPath(root, pluginName, relative) {
  return path.join(root, PLUGINS_ROOT, pluginName, relative);
}

function pluginEngineFiles(root, pluginName) {
  const directory = path.join(root, PLUGINS_ROOT, pluginName, 'engines');
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
}

function expectedEngineNames(plugin) {
  return new Set(
    [...plugin.expected.keys()]
      .filter((relative) => relative.startsWith('engines/'))
      .map((relative) => path.basename(relative)),
  );
}

function comparePlugin(root, plugin) {
  const errors = [];
  let checked = 0;
  for (const [relative, source] of plugin.expected) {
    const destination = destinationPath(root, plugin.name, relative);
    checked += 1;
    if (!existsSync(destination)) {
      errors.push(`plugins/${plugin.name}/${relative} is missing (run --write)`);
      continue;
    }
    const expectedBytes = readFileSync(source);
    const actualBytes = readFileSync(destination);
    if (!expectedBytes.equals(actualBytes)) {
      errors.push(
        `plugins/${plugin.name}/${relative} differs from ${path.relative(root, source)} (run --write)`,
      );
    }
  }
  const declared = expectedEngineNames(plugin);
  for (const fileName of pluginEngineFiles(root, plugin.name)) {
    if (!declared.has(fileName) && fileName !== path.basename(PROFILES_FILE)) {
      errors.push(
        `plugins/${plugin.name}/engines/${fileName} is not declared by ${PLUGIN_CONFIG_FILE} (run --write to remove it)`,
      );
    }
  }
  return { checked, errors };
}

/**
 * Compare every plugin's generated files with the canonical sources.
 *
 * @param {string} root Repository root to check.
 * @returns {{ok: boolean, plugins: string[], checked: number, errors: string[]}} Check result.
 */
export function checkPluginCore(root = REPO_ROOT) {
  const { plugins, errors } = collectExpected(root);
  let checked = 0;
  for (const plugin of plugins) {
    const result = comparePlugin(root, plugin);
    checked += result.checked;
    errors.push(...result.errors);
  }
  return { ok: errors.length === 0, plugins: plugins.map((plugin) => plugin.name), checked, errors };
}

function writePluginFiles(root, plugin, written) {
  for (const [relative, source] of plugin.expected) {
    const destination = destinationPath(root, plugin.name, relative);
    if (path.resolve(source) === path.resolve(destination) && existsSync(destination)) {
      continue;
    }
    const expectedBytes = readFileSync(source);
    if (existsSync(destination) && expectedBytes.equals(readFileSync(destination))) {
      continue;
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, expectedBytes);
    written.push(`plugins/${plugin.name}/${relative}`);
  }
}

function removeUndeclaredEngines(root, plugin, removed) {
  const declared = expectedEngineNames(plugin);
  for (const fileName of pluginEngineFiles(root, plugin.name)) {
    if (declared.has(fileName) || fileName === path.basename(PROFILES_FILE)) {
      continue;
    }
    rmSync(path.join(root, PLUGINS_ROOT, plugin.name, 'engines', fileName), { force: true });
    removed.push(`plugins/${plugin.name}/engines/${fileName}`);
  }
}

/**
 * Copy the canonical core and declared engine manifests into every plugin.
 *
 * @param {string} root Repository root to write.
 * @returns {{ok: boolean, written: string[], removed: string[], errors: string[]}} Write result.
 */
export function writePluginCore(root = REPO_ROOT) {
  const { plugins, errors } = collectExpected(root);
  if (errors.length > 0) {
    return { ok: false, written: [], removed: [], errors };
  }
  const written = [];
  const removed = [];
  for (const plugin of plugins) {
    writePluginFiles(root, plugin, written);
    removeUndeclaredEngines(root, plugin, removed);
  }
  const verification = checkPluginCore(root);
  return { ok: verification.ok, written, removed, errors: verification.errors };
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.length === 1 && (args[0] === '--check' || args[0] === '--write') ? args[0] : null;
  if (mode === null) {
    process.stderr.write('Usage: sync-plugin-core.mjs --check | --write\n');
    process.exit(2);
  }
  if (mode === '--check') {
    const result = checkPluginCore(REPO_ROOT);
    if (!result.ok) {
      fail('plugin core is out of sync:');
      for (const error of result.errors) {
        fail(`  ${error}`);
      }
      process.exit(1);
    }
    log(
      `${result.plugins.length} plugin(s), ${result.checked} file(s) byte-identical to ${CORE_ROOT} and the universal engine manifests`,
    );
    return;
  }
  const result = writePluginCore(REPO_ROOT);
  if (!result.ok) {
    fail('could not sync the plugin core:');
    for (const error of result.errors) {
      fail(`  ${error}`);
    }
    process.exit(1);
  }
  for (const file of result.written) {
    log(`wrote ${file}`);
  }
  for (const file of result.removed) {
    log(`removed undeclared ${file}`);
  }
  log(`${result.written.length} file(s) written, ${result.removed.length} removed`);
}

const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (invokedPath !== null && import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
