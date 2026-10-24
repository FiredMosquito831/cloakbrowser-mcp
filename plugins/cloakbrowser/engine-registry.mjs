// Manifest-driven engine registry for the CloakBrowser broker.
//
// This module is pure data access: it discovers engine manifests under
// engines/*.json, validates them and resolves the active engine and tool
// profile. Importing it never starts a backend and never writes anything, so
// the unit tests can exercise every rule directly.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_ENGINE = 'cloak';
// Shared data file beside the manifests; never treated as an engine.
export const PROFILES_FILE_NAME = 'profiles.json';
// A manifest that names no launcher starts the default one. Every launcher is a
// plain file in the plugin root, named launch.mjs or launch-<engine>.mjs; the
// engine setting still selects a manifest id, never a command or a path.
export const DEFAULT_LAUNCHER = 'launch.mjs';
const LAUNCHER_NAME_PATTERN = /^launch(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.mjs$/;
export const SUPPORT_VALUES = Object.freeze(['full', 'partial', 'none', 'unknown']);
const SUPPORT_VALUE_SET = new Set(SUPPORT_VALUES);
const IMPLEMENTED_PROFILES = Object.freeze(['full', 'portable']);
const IMPLEMENTED_PROFILE_SET = new Set(IMPLEMENTED_PROFILES);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Validate the shared profile document. "full" is a rule (everything the
// manifest supports), "portable" is the one explicit allowlist shared by every
// engine, so a new engine cannot drift from the rest.
export function validateProfiles(document) {
  if (!isPlainObject(document)) {
    return 'profiles file is not a JSON object';
  }
  if (document.schemaVersion !== 1) {
    return `unsupported schemaVersion: ${String(document.schemaVersion)}`;
  }
  if (!isPlainObject(document.profiles)) {
    return 'profiles is missing';
  }
  for (const name of Object.keys(document.profiles)) {
    if (!IMPLEMENTED_PROFILE_SET.has(name)) {
      return `unsupported profile "${name}"; this broker implements "full" and "portable"`;
    }
  }
  if (!isPlainObject(document.profiles.full)) {
    return 'profile "full" is missing';
  }
  if (document.profiles.full.kind !== 'all-supported') {
    return 'profile "full" must use kind "all-supported"';
  }
  if (!isPlainObject(document.profiles.portable)) {
    return 'profile "portable" is missing';
  }
  if (document.profiles.portable.kind !== 'explicit') {
    return 'profile "portable" must use kind "explicit"';
  }
  if (!Array.isArray(document.profiles.portable.tools)) {
    return 'profile "portable" tools must be an array';
  }
  const seen = new Set();
  for (const toolName of document.profiles.portable.tools) {
    if (!nonEmptyString(toolName)) {
      return 'profile "portable" tools must be non-empty strings';
    }
    if (seen.has(toolName)) {
      return `profile "portable" lists "${toolName}" more than once`;
    }
    seen.add(toolName);
  }
  return null;
}

export function loadProfiles(profilesFile) {
  let document;
  try {
    document = JSON.parse(readFileSync(profilesFile, 'utf8'));
  } catch (error) {
    return { profiles: null, error: `Cannot read ${profilesFile}: ${error.message}` };
  }
  const validationError = validateProfiles(document);
  if (validationError !== null) {
    return { profiles: null, error: `Invalid tool profiles ${profilesFile}: ${validationError}` };
  }
  return { profiles: document, error: null };
}

export function availableProfileNames(profiles) {
  if (!isPlainObject(profiles?.profiles)) {
    return [];
  }
  return Object.keys(profiles.profiles).sort();
}

export function portableToolNames(profiles) {
  const tools = profiles?.profiles?.portable?.tools;
  return Array.isArray(tools) ? [...tools].sort() : [];
}

// A launcher is a file name in the plugin root: no directory, no command, no
// "..". Anything else is a manifest error, not something to spawn.
export function validateLauncherName(value) {
  if (!nonEmptyString(value)) {
    return 'launcher must be a non-empty string';
  }
  if (value !== value.trim()) {
    return 'launcher must not have leading or trailing whitespace';
  }
  if (!LAUNCHER_NAME_PATTERN.test(value)) {
    return `launcher "${value}" is not a launcher file name like "launch.mjs" or "launch-camoufox.mjs"`;
  }
  return null;
}

// The launcher a manifest names, or the default one. Callers still join this to
// the plugin root; the value is always a bare basename.
export function resolveLauncherName(manifest) {
  const launch = isPlainObject(manifest?.launch) ? manifest.launch : null;
  return launch !== null && nonEmptyString(launch.launcher) ? launch.launcher.trim() : DEFAULT_LAUNCHER;
}

// Validate one engine manifest. expectedId comes from the file name, so a
// manifest cannot advertise an id different from the file that defines it.
// launcherDir is optional: when given, the named launcher must exist there.
export function validateManifest(manifest, expectedId, profileNames, launcherDir) {
  if (!isPlainObject(manifest)) {
    return 'manifest is not a JSON object';
  }
  if (manifest.schemaVersion !== 1) {
    return `unsupported schemaVersion: ${String(manifest.schemaVersion)}`;
  }
  if (manifest.id !== expectedId) {
    return `manifest id "${String(manifest.id)}" does not match engine "${expectedId}"`;
  }
  if (!nonEmptyString(manifest.label)) {
    return 'label is missing';
  }
  if (manifest.transport !== 'launch') {
    return `unsupported transport: ${String(manifest.transport)}`;
  }
  if (manifest.contract !== 'playwright-mcp') {
    return `unsupported contract: ${String(manifest.contract)}`;
  }
  if (!nonEmptyString(manifest.defaultToolProfile)) {
    return 'defaultToolProfile is missing';
  }
  if (!Array.isArray(profileNames) || !profileNames.includes(manifest.defaultToolProfile)) {
    const available = Array.isArray(profileNames) ? profileNames.join(', ') : '';
    return (
      `unsupported defaultToolProfile "${manifest.defaultToolProfile}"; ` +
      `no such profile in ${PROFILES_FILE_NAME} (available: ${available})`
    );
  }
  if (manifest.toolSupport === null || typeof manifest.toolSupport !== 'object') {
    return 'toolSupport is missing';
  }
  if (Array.isArray(manifest.toolSupport)) {
    return 'toolSupport must be an object';
  }
  for (const [name, support] of Object.entries(manifest.toolSupport)) {
    if (name.trim() === '') {
      return 'toolSupport has an empty tool name';
    }
    if (!SUPPORT_VALUE_SET.has(support)) {
      return `toolSupport["${name}"] has unsupported value "${String(support)}"`;
    }
  }
  if (manifest.toolSupportNotes !== undefined) {
    if (!isPlainObject(manifest.toolSupportNotes)) {
      return 'toolSupportNotes must be an object';
    }
    for (const [name, note] of Object.entries(manifest.toolSupportNotes)) {
      if (name.trim() === '') {
        return 'toolSupportNotes has an empty tool name';
      }
      if (!nonEmptyString(note)) {
        return `toolSupportNotes["${name}"] must be a non-empty string`;
      }
    }
  }
  if (manifest.launch !== undefined) {
    if (!isPlainObject(manifest.launch)) {
      return 'launch must be an object';
    }
    for (const key of Object.keys(manifest.launch)) {
      if (key !== 'launcher') {
        return `launch has an unsupported field "${key}"`;
      }
    }
    if (manifest.launch.launcher !== undefined) {
      const launcherError = validateLauncherName(manifest.launch.launcher);
      if (launcherError !== null) {
        return launcherError;
      }
    }
  }
  if (launcherDir !== undefined) {
    const launcher = resolveLauncherName(manifest);
    const launcherPath = path.join(launcherDir, launcher);
    if (!existsSync(launcherPath)) {
      return `launcher "${launcher}" does not exist in ${launcherDir}`;
    }
  }
  for (const field of ['requirements', 'ignoredSettings']) {
    const value = manifest[field];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value)) {
      return `${field} must be an array`;
    }
    for (const entry of value) {
      if (!nonEmptyString(entry)) {
        return `${field} must contain only non-empty strings`;
      }
    }
  }
  if (typeof manifest.notes !== 'string') {
    return 'notes is missing';
  }
  return null;
}

// Exact rule, then the "*" rule, then unknown. Unknown is never treated as
// unsupported: the broker forwards it and the backend answers for itself.
export function manifestSupport(manifest, toolName) {
  const rules = isPlainObject(manifest?.toolSupport) ? manifest.toolSupport : {};
  if (Object.hasOwn(rules, toolName)) {
    return rules[toolName];
  }
  if (Object.hasOwn(rules, '*')) {
    return rules['*'];
  }
  return 'unknown';
}

// Discover engines in deterministic order: JSON files sorted by file name,
// excluding the shared profiles file. Every file is validated; a broken
// manifest is reported and excluded from the supported id list.
export function scanEngines(enginesDir, profileNames, launcherDir) {
  let fileNames;
  try {
    fileNames = readdirSync(enginesDir);
  } catch (error) {
    return {
      entries: [],
      ids: [],
      warnings: [`Cannot read engines directory ${enginesDir}: ${error.message}`],
    };
  }
  const manifestFiles = fileNames
    .filter((fileName) => fileName.endsWith('.json') && fileName !== PROFILES_FILE_NAME)
    .sort();
  const entries = [];
  const warnings = [];
  for (const fileName of manifestFiles) {
    const id = path.basename(fileName, '.json');
    const file = path.join(enginesDir, fileName);
    let manifest;
    let entryError = null;
    try {
      manifest = JSON.parse(readFileSync(file, 'utf8'));
      const validationError = validateManifest(manifest, id, profileNames, launcherDir);
      if (validationError !== null) {
        entryError = `Invalid engine manifest ${file}: ${validationError}`;
      }
    } catch (error) {
      manifest = null;
      entryError = `Cannot read ${file}: ${error.message}`;
    }
    if (entryError !== null) {
      warnings.push(entryError);
    }
    entries.push({ id, file, manifest: entryError === null ? manifest : null, error: entryError });
  }
  return { entries, ids: entries.filter((entry) => entry.error === null).map((entry) => entry.id), warnings };
}

export function loadEngineConfiguration({ enginesDir, profilesFile, engineId, launcherDir }) {
  const profilesResult = loadProfiles(profilesFile);
  if (profilesResult.profiles === null) {
    return { engine: null, profiles: null, engineIds: [], warnings: [], error: profilesResult.error };
  }
  const profiles = profilesResult.profiles;
  const scan = scanEngines(enginesDir, availableProfileNames(profiles), launcherDir);
  const entry = scan.entries.find((candidate) => candidate.id === engineId);
  if (entry === undefined) {
    const supported = scan.ids.length === 0 ? 'none' : scan.ids.join(', ');
    return {
      engine: null,
      profiles,
      engineIds: scan.ids,
      warnings: scan.warnings,
      error: `Unknown engine "${engineId}". Supported engines: ${supported}.`,
    };
  }
  if (entry.error !== null) {
    return {
      engine: null,
      profiles,
      engineIds: scan.ids,
      warnings: scan.warnings.filter((warning) => warning !== entry.error),
      error: entry.error,
    };
  }
  return { engine: entry.manifest, profiles, engineIds: scan.ids, warnings: scan.warnings, error: null };
}

// "default", unset, empty, an unsubstituted placeholder or an unknown value
// never overrides the manifest default. The returned `placeholder` and
// `ignored` values exist so the broker can log them once at startup.
export function resolveToolProfile(rawValue, engine, profiles) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  let requested = null;
  let ignored = null;
  let placeholder = null;
  if (value !== '') {
    if (value.includes('${')) {
      placeholder = value;
    } else if (value !== 'default') {
      if (isPlainObject(profiles?.profiles) && Object.hasOwn(profiles.profiles, value)) {
        requested = value;
      } else {
        ignored = value;
      }
    }
  }
  if (requested !== null) {
    return { profile: requested, source: 'user', requested, ignored: null, placeholder };
  }
  return {
    profile: engine?.defaultToolProfile ?? null,
    source: 'engine-default',
    requested: null,
    ignored,
    placeholder,
  };
}

// full: everything except "none". portable: only names on the shared list.
export function profileAllows(profileName, profiles, toolName, support) {
  if (support === 'none') {
    return false;
  }
  if (profileName === 'full') {
    return true;
  }
  if (profileName === 'portable') {
    const tools = profiles?.profiles?.portable?.tools;
    return Array.isArray(tools) && tools.includes(toolName);
  }
  return false;
}

// Portable names a manifest marks "none"; the suite requires this to stay empty
// for every shipped manifest so the shared profile can never point at a tool an
// engine rejects.
export function findPortableGaps(manifest, profiles) {
  return portableToolNames(profiles).filter((toolName) => manifestSupport(manifest, toolName) === 'none');
}

export function engineChangeHelp(engineIds) {
  const quoted = (Array.isArray(engineIds) ? engineIds : []).map((id) => `'${id}'`);
  let list;
  if (quoted.length === 0) {
    list = 'a discovered engine';
  } else if (quoted.length === 1) {
    list = quoted[0];
  } else {
    list = `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
  }
  return (
    'Set the "Browser engine" (browser_engine) option in the cloakbrowser plugin configuration to ' +
    `${list}, then restart Claude Code. The engine is resolved when the MCP server starts; ` +
    'it cannot be switched inside a running session.'
  );
}
