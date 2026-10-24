#!/usr/bin/env node
// Regenerate userConfig.browser_engine.options in plugin.json from the engine
// manifests. --check exits non-zero when plugin.json is out of sync; --write
// rewrites only the options array and leaves every other byte untouched.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  availableProfileNames,
  DEFAULT_ENGINE,
  loadProfiles,
  PROFILES_FILE_NAME,
  scanEngines,
} from '../engine-registry.mjs';

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENGINES_DIR = path.join(PLUGIN_ROOT, 'engines');
const PLUGIN_MANIFEST = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');

function fail(message) {
  process.stderr.write(`[generate-engine-options] ${message}\n`);
  process.exit(1);
}

function scanStringEnd(text, start) {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text[index] === '"') {
      return index;
    }
    index += 1;
  }
  return -1;
}

// Returns the absolute index of the bracket matching the one at `start`.
function matchingBracket(text, start) {
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const end = scanStringEnd(text, index);
      if (end === -1) {
        return -1;
      }
      index = end + 1;
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }
  return -1;
}

// Locate the browser_engine object, then its options array, without reparsing
// the whole document (a full JSON.stringify would reflow every array).
function findOptionsRange(text) {
  const keyIndex = text.indexOf('"browser_engine"');
  if (keyIndex === -1) {
    fail('plugin.json has no userConfig.browser_engine entry');
  }
  const objectStart = text.indexOf('{', keyIndex);
  if (objectStart === -1) {
    fail('browser_engine is not an object');
  }
  const objectEnd = matchingBracket(text, objectStart);
  if (objectEnd === -1) {
    fail('cannot find the end of the browser_engine object');
  }
  const optionsKey = text.indexOf('"options"', objectStart);
  if (optionsKey === -1 || optionsKey > objectEnd) {
    fail('browser_engine has no options array');
  }
  const arrayStart = text.indexOf('[', optionsKey);
  if (arrayStart === -1 || arrayStart > objectEnd) {
    fail('browser_engine.options is not an array');
  }
  const arrayEnd = matchingBracket(text, arrayStart);
  if (arrayEnd === -1) {
    fail('cannot find the end of the browser_engine.options array');
  }
  return { arrayStart, arrayEnd };
}

function sameOptions(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.length === 1 && (args[0] === '--check' || args[0] === '--write') ? args[0] : null;
  if (mode === null) {
    process.stderr.write('Usage: generate-engine-options.mjs --check | --write\n');
    process.exit(2);
  }

  const profilesResult = loadProfiles(path.join(ENGINES_DIR, PROFILES_FILE_NAME));
  if (profilesResult.profiles === null) {
    fail(profilesResult.error);
  }
  const scan = scanEngines(ENGINES_DIR, availableProfileNames(profilesResult.profiles), PLUGIN_ROOT);
  if (scan.warnings.length > 0) {
    fail(`refusing to generate options from invalid manifests:\n${scan.warnings.join('\n')}`);
  }
  const ids = scan.ids;
  if (ids.length === 0) {
    fail(`no engine manifests found in ${ENGINES_DIR}`);
  }
  if (!ids.includes(DEFAULT_ENGINE)) {
    fail(`the default engine "${DEFAULT_ENGINE}" has no valid manifest in ${ENGINES_DIR}`);
  }

  const text = readFileSync(PLUGIN_MANIFEST, 'utf8');
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    fail(`cannot parse ${PLUGIN_MANIFEST}: ${error.message}`);
  }
  const declared = document?.userConfig?.browser_engine?.options;
  if (!Array.isArray(declared) || declared.some((value) => typeof value !== 'string')) {
    fail('plugin.json userConfig.browser_engine.options is not an array of strings');
  }

  if (sameOptions(declared, ids)) {
    process.stdout.write(`[generate-engine-options] browser_engine.options are in sync: ${ids.join(', ')}\n`);
    return;
  }
  if (mode === '--check') {
    fail(
      'browser_engine.options are out of sync.\n' +
        `  plugin.json: ${JSON.stringify(declared)}\n` +
        `  manifests:   ${JSON.stringify(ids)}\n` +
        'Run "node plugins/cloakbrowser/scripts/generate-engine-options.mjs --write" from the repository root.',
    );
  }

  const { arrayStart, arrayEnd } = findOptionsRange(text);
  const replacement = `[${ids.map((id) => JSON.stringify(id)).join(', ')}]`;
  const updated = `${text.slice(0, arrayStart)}${replacement}${text.slice(arrayEnd + 1)}`;
  let reparsed;
  try {
    reparsed = JSON.parse(updated);
  } catch (error) {
    fail(`refusing to write invalid JSON: ${error.message}`);
  }
  if (!sameOptions(reparsed?.userConfig?.browser_engine?.options, ids)) {
    fail('rewrite did not produce the expected options array');
  }
  writeFileSync(PLUGIN_MANIFEST, updated);
  process.stdout.write(
    `[generate-engine-options] updated browser_engine.options: ${JSON.stringify(declared)} -> ${JSON.stringify(ids)}\n`,
  );
}

main();
