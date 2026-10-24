// Pin discovery, writing and the fail-closed guard.
//
// A pin is a fact written in more than one place:
//   - the MCP bridge pin: shared/core/lib/provision.mjs (DEFAULT_NPM_PACKAGE)
//     and every plugins/*/.mcp.json that carries CLOAK_PLAYWRIGHT_MCP_PACKAGE;
//   - the engine wrapper pin: shared/core/lib/provision.mjs (NPM_ENGINE_WRAPPER_PIN).
// Generated plugin copies are never edited here: sync-plugin-core.mjs --write
// copies the canonical core, and --check proves the copies stayed identical.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseVersion } from '../lib/semver.mjs';
import { writePluginCore } from '../sync-plugin-core.mjs';
import { parseCompatibilityDocument, wrapperDecision } from './compatibility.mjs';
import {
  BUILD_PACKAGE,
  COMPATIBILITY_FILE,
  CORE_PROVISION_FILE,
  PLUGINS_ROOT,
  WRAPPER_PACKAGE,
} from './constants.mjs';

const DEFAULT_PACKAGE_PATTERN = /^export const DEFAULT_NPM_PACKAGE = '([^']+)';$/m;
const WRAPPER_PIN_PATTERN = /^export const NPM_ENGINE_WRAPPER_PIN = '([^']+)';$/m;

/**
 * List the plugin directories that ship a plugin manifest.
 *
 * @param {string} root Repository root.
 * @returns {string[]} Sorted plugin names.
 */
export function listPlugins(root) {
  const directory = path.join(root, PLUGINS_ROOT);
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(path.join(directory, entry.name, '.claude-plugin', 'plugin.json')),
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * Read the canonical and per-plugin pin sites.
 *
 * @param {string} root Repository root.
 * @returns {{bridge: string, wrapper: string, coreFile: string, mcpSites: {file: string, server: string, version: string}[], pluginVersions: {plugin: string, version: string, file: string}[]}} Pin state.
 */
export function readPinState(root) {
  const coreFile = path.join(root, CORE_PROVISION_FILE);
  const coreText = readFileSync(coreFile, 'utf8');
  const defaultMatch = DEFAULT_PACKAGE_PATTERN.exec(coreText);
  const wrapperMatch = WRAPPER_PIN_PATTERN.exec(coreText);
  if (defaultMatch === null) {
    throw new Error(`${CORE_PROVISION_FILE} has no DEFAULT_NPM_PACKAGE constant`);
  }
  if (wrapperMatch === null) {
    throw new Error(`${CORE_PROVISION_FILE} has no NPM_ENGINE_WRAPPER_PIN constant`);
  }
  const spec = defaultMatch[1];
  if (!spec.startsWith(`${BUILD_PACKAGE}@`)) {
    throw new Error(`DEFAULT_NPM_PACKAGE "${spec}" is not a ${BUILD_PACKAGE} pin`);
  }
  const bridge = spec.slice(BUILD_PACKAGE.length + 1);
  parseVersion(bridge);
  parseVersion(wrapperMatch[1]);
  const mcpSites = [];
  const pluginVersions = [];
  for (const plugin of listPlugins(root)) {
    const manifestFile = path.join(root, PLUGINS_ROOT, plugin, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    parseVersion(manifest.version);
    pluginVersions.push({
      plugin,
      version: manifest.version,
      file: `${PLUGINS_ROOT}/${plugin}/.claude-plugin/plugin.json`,
    });
    const mcpFile = path.join(root, PLUGINS_ROOT, plugin, '.mcp.json');
    if (!existsSync(mcpFile)) {
      continue;
    }
    const mcp = JSON.parse(readFileSync(mcpFile, 'utf8'));
    for (const [server, entry] of Object.entries(mcp)) {
      const pin = entry?.env?.CLOAK_PLAYWRIGHT_MCP_PACKAGE;
      if (typeof pin !== 'string' || pin === '') {
        continue;
      }
      if (!pin.startsWith(`${BUILD_PACKAGE}@`)) {
        throw new Error(`plugins/${plugin}/.mcp.json pins "${pin}", not ${BUILD_PACKAGE}`);
      }
      mcpSites.push({
        file: `${PLUGINS_ROOT}/${plugin}/.mcp.json`,
        server,
        version: pin.slice(BUILD_PACKAGE.length + 1),
      });
    }
  }
  return { bridge, wrapper: wrapperMatch[1], coreFile: CORE_PROVISION_FILE, mcpSites, pluginVersions };
}

/**
 * Read and validate scripts/upstream-sync/wrapper-compatibility.json.
 *
 * @param {string} root Repository root.
 * @returns {{schemaVersion: number, bridge: Record<string, {cloakbrowser: string[]}>}} Validated table.
 */
export function readCompatibility(root) {
  const file = path.join(root, COMPATIBILITY_FILE);
  return parseCompatibilityDocument(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * Replace a token that must occur exactly once.
 *
 * @param {string} text Source text.
 * @param {string} needle Exact token.
 * @param {string} replacement New token.
 * @param {string} label Human-readable file label for errors.
 * @returns {string} Replaced text.
 */
function replaceOnce(text, needle, replacement, label) {
  const count = text.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected one occurrence of ${JSON.stringify(needle)}, found ${count}`);
  }
  return text.split(needle).join(replacement);
}

/**
 * Rewrite every occurrence of a token in a file text.
 *
 * @param {string} text Source text.
 * @param {string} needle Exact token.
 * @param {string} replacement New token.
 * @returns {{text: string, count: number}} Replaced text and occurrence count.
 */
function replaceAll(text, needle, replacement) {
  const count = text.split(needle).length - 1;
  return { text: count === 0 ? text : text.split(needle).join(replacement), count };
}

/**
 * Replace the version field of a plugin manifest, refusing an ambiguous file.
 *
 * @param {string} text Manifest text.
 * @param {string} from Current version.
 * @param {string} to New version.
 * @param {string} label File label for errors.
 * @returns {string} Updated manifest text.
 */
function replaceVersionField(text, from, to, label) {
  const pattern = /^(?<prefix>[ \t]*"version"[ \t]*:[ \t]*")(?<version>[^"]+)(?<suffix>",?)$/gm;
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected exactly one version field, found ${matches.length}`);
  }
  const match = matches[0];
  const current = match.groups.version;
  if (current !== from) {
    throw new Error(`${label}: version is ${current}, expected ${from}`);
  }
  const start = match.index;
  const end = start + match[0].length;
  return `${text.slice(0, start)}${match.groups.prefix}${to}${match.groups.suffix}${text.slice(end)}`;
}

/**
 * Update prose version and pin mentions in plugin READMEs.
 *
 * The exact tokens the READMEs use are rewritten; any other sentence about a
 * version (for example "the bridge rejects 0.6.4") is left for review and is
 * called out in the sync README.
 *
 * @param {string} text README text.
 * @param {{bridgeFrom: string, bridgeTo: string, wrapperFrom: string, wrapperTo: string, versionFrom: string, versionTo: string}} changes Old and new values.
 * @returns {{text: string, count: number}} Updated text and replacement count.
 */
export function rewriteReadmeMentions(
  text,
  { bridgeFrom, bridgeTo, wrapperFrom, wrapperTo, versionFrom, versionTo },
) {
  const tokens = [];
  if (bridgeFrom !== bridgeTo) {
    tokens.push([`${BUILD_PACKAGE}@${bridgeFrom}`, `${BUILD_PACKAGE}@${bridgeTo}`]);
    tokens.push([`bridge (${bridgeFrom})`, `bridge (${bridgeTo})`]);
  }
  if (wrapperFrom !== wrapperTo) {
    tokens.push([`${WRAPPER_PACKAGE}@${wrapperFrom}`, `${WRAPPER_PACKAGE}@${wrapperTo}`]);
    tokens.push([`wrapper to \`${wrapperFrom}\``, `wrapper to \`${wrapperTo}\``]);
  }
  if (versionFrom !== versionTo) {
    tokens.push([versionFrom, versionTo]);
  }
  let output = text;
  let count = 0;
  for (const [needle, replacement] of tokens) {
    const result = replaceAll(output, needle, replacement);
    output = result.text;
    count += result.count;
  }
  return { text: output, count };
}

/**
 * Write the decided pin values, the plugin versions and the generated copies.
 *
 * @param {string} root Repository root.
 * @param {{bridgeFrom: string, bridgeTo: string, wrapperFrom: string, wrapperTo: string, versionFrom: string, versionTo: string}} changes Decided values.
 * @returns {{changed: string[], readmes: string[], sync: {written: string[], removed: string[]}}} Written paths.
 */
export function writePinState(root, changes) {
  const changed = [];
  const readmes = [];
  const coreFile = path.join(root, CORE_PROVISION_FILE);
  let coreText = readFileSync(coreFile, 'utf8');
  if (changes.bridgeFrom !== changes.bridgeTo) {
    coreText = replaceOnce(
      coreText,
      `${BUILD_PACKAGE}@${changes.bridgeFrom}`,
      `${BUILD_PACKAGE}@${changes.bridgeTo}`,
      CORE_PROVISION_FILE,
    );
  }
  if (changes.wrapperFrom !== changes.wrapperTo) {
    coreText = replaceOnce(
      coreText,
      `NPM_ENGINE_WRAPPER_PIN = '${changes.wrapperFrom}'`,
      `NPM_ENGINE_WRAPPER_PIN = '${changes.wrapperTo}'`,
      CORE_PROVISION_FILE,
    );
  }
  writeFileSync(coreFile, coreText);
  if (changes.bridgeFrom !== changes.bridgeTo) {
    changed.push(CORE_PROVISION_FILE);
  }
  if (changes.wrapperFrom !== changes.wrapperTo) {
    changed.push(CORE_PROVISION_FILE);
  }
  for (const plugin of listPlugins(root)) {
    const mcpFile = path.join(root, PLUGINS_ROOT, plugin, '.mcp.json');
    if (existsSync(mcpFile) && changes.bridgeFrom !== changes.bridgeTo) {
      const mcpText = readFileSync(mcpFile, 'utf8');
      const needle = `${BUILD_PACKAGE}@${changes.bridgeFrom}`;
      if (mcpText.includes(needle)) {
        writeFileSync(mcpFile, replaceOnce(mcpText, needle, `${BUILD_PACKAGE}@${changes.bridgeTo}`, mcpFile));
        changed.push(`${PLUGINS_ROOT}/${plugin}/.mcp.json`);
      }
    }
    const manifestFile = path.join(root, PLUGINS_ROOT, plugin, '.claude-plugin', 'plugin.json');
    if (changes.versionFrom !== changes.versionTo) {
      const manifestText = readFileSync(manifestFile, 'utf8');
      writeFileSync(
        manifestFile,
        replaceVersionField(
          manifestText,
          changes.versionFrom,
          changes.versionTo,
          `${PLUGINS_ROOT}/${plugin}/.claude-plugin/plugin.json`,
        ),
      );
      changed.push(`${PLUGINS_ROOT}/${plugin}/.claude-plugin/plugin.json`);
    }
    const readmeFile = path.join(root, PLUGINS_ROOT, plugin, 'README.md');
    if (existsSync(readmeFile)) {
      const readmeText = readFileSync(readmeFile, 'utf8');
      const result = rewriteReadmeMentions(readmeText, changes);
      if (result.count > 0) {
        writeFileSync(readmeFile, result.text);
        readmes.push(`${PLUGINS_ROOT}/${plugin}/README.md`);
      }
    }
  }
  const sync = writePluginCore(root);
  if (!sync.ok) {
    throw new Error(`generated plugin core is inconsistent: ${sync.errors.join('; ')}`);
  }
  return { changed: [...new Set(changed)], readmes, sync: { written: sync.written, removed: sync.removed } };
}

/**
 * The fail-closed guard: prove the checked-in pins agree and are allowed.
 *
 * @param {string} root Repository root.
 * @returns {{ok: boolean, errors: string[], state: object}} Guard result.
 */
export function checkPinState(root) {
  const errors = [];
  let state;
  try {
    state = readPinState(root);
  } catch (error) {
    return { ok: false, errors: [error.message], state: null };
  }
  let table;
  try {
    table = readCompatibility(root);
  } catch (error) {
    return { ok: false, errors: [error.message], state };
  }
  const wrapper = wrapperDecision({ currentWrapper: state.wrapper, bridge: state.bridge, table });
  if (wrapper.reason === 'bridge-not-in-compatibility-table') {
    errors.push(`bridge ${state.bridge} is not in ${COMPATIBILITY_FILE}`);
  } else if (!wrapper.currentAllowed) {
    errors.push(
      `wrapper ${state.wrapper} is not allowed by bridge ${state.bridge} (${wrapper.allowed.join(', ') || 'no stable versions'})`,
    );
  }
  if (state.mcpSites.length === 0) {
    errors.push(`no ${BUILD_PACKAGE} pin was found in any plugins/*/.mcp.json`);
  }
  for (const site of state.mcpSites) {
    if (site.version !== state.bridge) {
      errors.push(
        `${site.file} pins ${BUILD_PACKAGE}@${site.version}, ${CORE_PROVISION_FILE} pins @${state.bridge}`,
      );
    }
  }
  const versions = new Set(state.pluginVersions.map((entry) => entry.version));
  if (versions.size !== 1) {
    errors.push(`plugin versions are not lockstep: ${[...versions].join(', ')}`);
  }
  return { ok: errors.length === 0, errors, state };
}
