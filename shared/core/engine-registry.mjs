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
// A native engine speaks its own tool names; the manifest aliases the ones with
// a canonical equivalent and prefixes the rest. The contract value is what the
// broker branches on, never an engine id.
export const NATIVE_CONTRACT = 'native-mcp';
export const NATIVE_TRANSFORMS = Object.freeze([
  'accept-to-action',
  'console-level',
  'evaluate-function',
  'form-fields',
  'single-select-value',
]);
const NATIVE_TRANSFORM_SET = new Set(NATIVE_TRANSFORMS);
const NATIVE_PREFIX_PATTERN = /^[a-z][a-z0-9_]*$/;
const CANONICAL_NAME_PATTERN = /^browser_[a-z0-9_]+$/;
const META_TOOL_NAMES = new Set(['browser_capabilities', 'browser_engine_status']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A configured value that can be used as it stands. An empty value and an
// unresolved ${user_config.*} placeholder mean "the host did not supply it".
function usableEnvValue(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.includes('${')) {
    return null;
  }
  return trimmed;
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

// Position of a manifest-declared canonical schema file, or null when the value
// is not a safe relative path inside the plugin root.
function contractSchemasPath(manifest, pluginRoot) {
  const value = manifest.contractSchemas;
  if (!nonEmptyString(value)) {
    return { error: 'contractSchemas must be a non-empty string' };
  }
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    return { error: 'contractSchemas must be a relative path with forward slashes' };
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { error: 'contractSchemas must not contain empty, "." or ".." segments' };
  }
  if (pluginRoot === undefined) {
    return { error: null, file: null };
  }
  const base = path.resolve(pluginRoot);
  const file = path.resolve(base, value);
  const relativeToBase = path.relative(base, file);
  if (relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase)) {
    return { error: 'contractSchemas must stay inside the plugin root' };
  }
  if (!existsSync(file)) {
    return { error: `contractSchemas "${value}" does not exist in ${pluginRoot}` };
  }
  return { error: null, file };
}

// Rules for contract "native-mcp" only. Playwright-mcp manifests never reach
// this function, so their validation is byte-identical to before.
function validateNativeManifest(manifest, pluginRoot) {
  if (!nonEmptyString(manifest.nativePrefix)) {
    return 'nativePrefix is missing';
  }
  if (!NATIVE_PREFIX_PATTERN.test(manifest.nativePrefix)) {
    return `nativePrefix "${manifest.nativePrefix}" must be lowercase letters, digits and underscores, starting with a letter`;
  }
  if (manifest.nativePrefix.startsWith('browser_')) {
    return 'nativePrefix must not start with "browser_"; prefixed names must not look canonical';
  }
  const schemas = contractSchemasPath(manifest, pluginRoot);
  if (schemas.error !== null) {
    return schemas.error;
  }

  if (!isPlainObject(manifest.profileArgument)) {
    return 'profileArgument is missing';
  }
  const profileKeys = new Set(['default', 'env', 'except', 'name', 'setting']);
  for (const key of Object.keys(manifest.profileArgument)) {
    if (!profileKeys.has(key)) {
      return `profileArgument has an unsupported field "${key}"`;
    }
  }
  const profile = manifest.profileArgument;
  if (!nonEmptyString(profile.name)) {
    return 'profileArgument.name is missing';
  }
  for (const field of ['env', 'setting', 'default']) {
    if (profile[field] !== undefined && !nonEmptyString(profile[field])) {
      return `profileArgument.${field} must be a non-empty string`;
    }
  }
  if (profile.except !== undefined) {
    if (!Array.isArray(profile.except) || profile.except.some((entry) => !nonEmptyString(entry))) {
      return 'profileArgument.except must be an array of non-empty strings';
    }
  }

  if (!Array.isArray(manifest.toolAliases) || manifest.toolAliases.length === 0) {
    return 'toolAliases must be a non-empty array';
  }
  const canonicalNames = new Set();
  const nativeNames = new Set();
  for (const [index, alias] of manifest.toolAliases.entries()) {
    const label = `toolAliases[${index}]`;
    if (!isPlainObject(alias)) {
      return `${label} must be an object`;
    }
    const aliasKeys = new Set([
      'args',
      'canonical',
      'dispatch',
      'ignore',
      'native',
      'reject',
      'required',
      'send',
      'support',
      'transform',
    ]);
    for (const key of Object.keys(alias)) {
      if (!aliasKeys.has(key)) {
        return `${label} has an unsupported field "${key}"`;
      }
    }
    if (!nonEmptyString(alias.canonical)) {
      return `${label}.canonical is missing`;
    }
    if (!CANONICAL_NAME_PATTERN.test(alias.canonical)) {
      return `${label}.canonical "${alias.canonical}" must be a browser_* tool name`;
    }
    if (META_TOOL_NAMES.has(alias.canonical)) {
      return `${label}.canonical "${alias.canonical}" is a broker meta-tool and cannot be aliased`;
    }
    if (canonicalNames.has(alias.canonical)) {
      return `toolAliases declares "${alias.canonical}" more than once`;
    }
    canonicalNames.add(alias.canonical);
    if (!SUPPORT_VALUE_SET.has(alias.support)) {
      return `${label}.support has unsupported value "${String(alias.support)}"`;
    }
    if (alias.transform !== undefined && !NATIVE_TRANSFORM_SET.has(alias.transform)) {
      return `${label}.transform "${String(alias.transform)}" is not one of ${NATIVE_TRANSFORMS.join(', ')}`;
    }
    if (alias.args !== undefined) {
      if (!isPlainObject(alias.args)) {
        return `${label}.args must be an object`;
      }
      for (const [from, to] of Object.entries(alias.args)) {
        if (!nonEmptyString(from) || !nonEmptyString(to)) {
          return `${label}.args must map non-empty argument names to non-empty native names`;
        }
      }
    }
    for (const field of ['ignore', 'reject']) {
      const value = alias[field];
      if (value !== undefined) {
        if (!Array.isArray(value) || value.some((entry) => !nonEmptyString(entry))) {
          return `${label}.${field} must be an array of non-empty strings`;
        }
      }
    }
    const ignored = new Set(alias.ignore ?? []);
    const rejected = new Set(alias.reject ?? []);
    for (const name of ignored) {
      if (rejected.has(name)) {
        return `${label} both ignores and rejects argument "${name}"`;
      }
    }
    for (const name of Object.keys(alias.args ?? {})) {
      if (rejected.has(name)) {
        return `${label} maps and rejects argument "${name}"`;
      }
      if (ignored.has(name)) {
        return `${label} maps and ignores argument "${name}"`;
      }
    }

    const hasNative = nonEmptyString(alias.native);
    const hasDispatch = isPlainObject(alias.dispatch);
    if (hasNative === hasDispatch) {
      return `${label} must have exactly one of "native" or "dispatch"`;
    }
    if (hasNative) {
      nativeNames.add(alias.native);
      for (const field of ['send', 'required']) {
        if (alias[field] !== undefined) {
          return `${label}.${field} is only valid with "dispatch"`;
        }
      }
      continue;
    }
    if (Object.keys(alias.dispatch).length === 0) {
      return `${label}.dispatch must not be empty`;
    }
    for (const [action, native] of Object.entries(alias.dispatch)) {
      if (!nonEmptyString(action) || !nonEmptyString(native)) {
        return `${label}.dispatch must map non-empty actions to non-empty native names`;
      }
      nativeNames.add(native);
    }
    const dispatchActions = new Set(Object.keys(alias.dispatch));
    for (const field of ['send', 'required']) {
      const value = alias[field];
      if (value === undefined) {
        continue;
      }
      if (!isPlainObject(value)) {
        return `${label}.${field} must be an object keyed by action`;
      }
      for (const [action, names] of Object.entries(value)) {
        if (!dispatchActions.has(action)) {
          return `${label}.${field} names unknown action "${action}"`;
        }
        if (!Array.isArray(names) || names.some((entry) => !nonEmptyString(entry))) {
          return `${label}.${field}.${action} must be an array of non-empty strings`;
        }
      }
    }
    for (const [action, names] of Object.entries(alias.required ?? {})) {
      const send = alias.send?.[action] ?? [];
      for (const name of names) {
        if (!send.includes(name)) {
          return `${label}.required.${action} names "${name}", which ${label}.send.${action} does not send`;
        }
      }
    }
    for (const [action, names] of Object.entries(alias.send ?? {})) {
      for (const name of names) {
        if (!Object.hasOwn(alias.args ?? {}, name) && !ignored.has(name)) {
          return `${label}.send.${action} names "${name}", which is neither mapped by args nor ignored`;
        }
      }
    }
  }

  // A native name is either aliased (possibly by several canonical tools) or
  // native-only, never both; and a canonical alias must not also carry a
  // toolSupport rule.
  for (const name of Object.keys(manifest.toolSupport ?? {})) {
    if (name === '*') {
      continue;
    }
    if (nativeNames.has(name)) {
      return `toolSupport["${name}"] is an aliased native tool; declare its support on the alias instead`;
    }
    if (canonicalNames.has(name)) {
      return `toolSupport["${name}"] is an aliased canonical tool; declare its support on the alias instead`;
    }
  }
  for (const [name, support] of Object.entries(manifest.toolSupport ?? {})) {
    if (name !== '*' && support === 'none') {
      const note = manifest.toolSupportNotes?.[name];
      if (typeof note !== 'string' || note.trim() === '') {
        return `toolSupport["${name}"] is "none" but has no toolSupportNotes reason`;
      }
    }
  }
  return null;
}

// Optional machine-checkable environment requirements. `requirements` is
// display-only prose; `requiredEnv` names the environment variables without
// which the engine can never work, so the broker can fail at initialize instead
// of spawning a backend that cannot answer. Generic: any engine may declare it.
function validateRequiredEnv(manifest) {
  if (manifest.requiredEnv === undefined) {
    return null;
  }
  if (!Array.isArray(manifest.requiredEnv)) {
    return 'requiredEnv must be an array';
  }
  const seen = new Set();
  for (const [index, entry] of manifest.requiredEnv.entries()) {
    const label = `requiredEnv[${index}]`;
    if (!isPlainObject(entry)) {
      return `${label} must be an object`;
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'env' && key !== 'reason') {
        return `${label} has an unsupported field "${key}"`;
      }
    }
    if (!nonEmptyString(entry.env)) {
      return `${label}.env is missing`;
    }
    if (!nonEmptyString(entry.reason)) {
      return `${label}.reason is missing`;
    }
    if (seen.has(entry.env)) {
      return `requiredEnv declares "${entry.env}" more than once`;
    }
    seen.add(entry.env);
  }
  return null;
}

// Optional data the broker uses to describe a remote/attached runtime in
// browser_engine_status and to enrich a backend error with an actionable hint.
// The broker itself stays engine-agnostic: every name and sentence lives here.
function validateRuntime(manifest) {
  if (manifest.runtime === undefined) {
    return null;
  }
  if (!isPlainObject(manifest.runtime)) {
    return 'runtime must be an object';
  }
  const allowed = new Set(['defaultEndpoint', 'endpointEnv', 'errorHint', 'profileEnv', 'statusKeys']);
  for (const key of Object.keys(manifest.runtime)) {
    if (!allowed.has(key)) {
      return `runtime has an unsupported field "${key}"`;
    }
  }
  for (const field of ['defaultEndpoint', 'endpointEnv', 'errorHint', 'profileEnv']) {
    const value = manifest.runtime[field];
    if (value !== undefined && !nonEmptyString(value)) {
      return `runtime.${field} must be a non-empty string`;
    }
  }
  if (manifest.runtime.defaultEndpoint !== undefined) {
    if (!manifest.runtime.defaultEndpoint.includes('{profileId}')) {
      return 'runtime.defaultEndpoint must contain the "{profileId}" placeholder';
    }
    if (!nonEmptyString(manifest.runtime.profileEnv)) {
      return 'runtime.profileEnv is required when runtime.defaultEndpoint is set';
    }
  }
  if (manifest.runtime.statusKeys !== undefined) {
    if (!isPlainObject(manifest.runtime.statusKeys)) {
      return 'runtime.statusKeys must be an object';
    }
    for (const key of Object.keys(manifest.runtime.statusKeys)) {
      if (key !== 'endpoint' && key !== 'profileId') {
        return `runtime.statusKeys has an unsupported field "${key}"`;
      }
    }
    for (const [field, value] of Object.entries(manifest.runtime.statusKeys)) {
      if (!nonEmptyString(value)) {
        return `runtime.statusKeys.${field} must be a non-empty string`;
      }
    }
  }
  return null;
}

// Optional description of the engine's own profile lock, read by the broker
// before it spawns a backend. The bridge's lock file is not enough for every
// engine: the Camoufox wrapper checks a Unix "lockfile" name and never writes
// the bridge lock, while Firefox itself takes <profile>/parent.lock. "file" is a
// plain file name inside the profile directory (never a path); "owner" names how
// the broker proves a live owner. An engine without the field keeps every
// previous byte of behaviour: no second check, no new payload key.
const ENGINE_PROFILE_LOCK_OWNERS = new Set(['exclusive-open', 'pid']);
const ENGINE_PROFILE_LOCK_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateProfileLock(manifest) {
  if (manifest.profileLock === undefined) {
    return null;
  }
  if (!isPlainObject(manifest.profileLock)) {
    return 'profileLock must be an object';
  }
  const allowed = new Set(['file', 'owner']);
  for (const key of Object.keys(manifest.profileLock)) {
    if (!allowed.has(key)) {
      return `profileLock has an unsupported field "${key}"`;
    }
  }
  const file = manifest.profileLock.file;
  if (!nonEmptyString(file)) {
    return 'profileLock.file is missing';
  }
  const trimmed = file.trim();
  if (!ENGINE_PROFILE_LOCK_FILE_PATTERN.test(trimmed) || trimmed === '.' || trimmed === '..') {
    return 'profileLock.file must be a plain file name inside the profile directory';
  }
  if (!nonEmptyString(manifest.profileLock.owner)) {
    return 'profileLock.owner is missing';
  }
  if (!ENGINE_PROFILE_LOCK_OWNERS.has(manifest.profileLock.owner.trim())) {
    return `profileLock.owner must be one of: ${[...ENGINE_PROFILE_LOCK_OWNERS].join(', ')}`;
  }
  if (manifest.profileApplies === false) {
    return 'profileLock is only meaningful when profileApplies is not false';
  }
  return null;
}

// Optional boolean: whether the plugin's own profile model applies to this
// engine. A local-profile engine (cloak, playwright, camoufox) resolves
// profile_dir, account, profile_isolation and the lock preflight; an engine that
// owns its profile elsewhere (camoufox-native) or attaches to a browser it did
// not start (kameleo) declares false and gains none of that behaviour. Omitted
// means true, so every existing manifest keeps its previous meaning.
function validateProfileApplies(manifest) {
  if (manifest.profileApplies === undefined) {
    return null;
  }
  if (typeof manifest.profileApplies !== 'boolean') {
    return 'profileApplies must be a boolean';
  }
  return null;
}

// The profile model applies unless the manifest explicitly opts out.
export function manifestProfileApplies(manifest) {
  return manifest?.profileApplies !== false;
}

// Optional capability facts. Only the names the broker understands are allowed,
// so a typo cannot silently disappear from browser_capabilities.
function validateCapabilities(manifest) {
  if (manifest.capabilities === undefined) {
    return null;
  }
  if (!isPlainObject(manifest.capabilities)) {
    return 'capabilities must be an object';
  }
  for (const key of Object.keys(manifest.capabilities)) {
    if (key !== 'groupSwitchesApply' && key !== 'cdpAttach') {
      return `capabilities has an unsupported field "${key}"`;
    }
  }
  for (const field of ['groupSwitchesApply', 'cdpAttach']) {
    const value = manifest.capabilities[field];
    if (value !== undefined && typeof value !== 'boolean') {
      return `capabilities.${field} must be a boolean`;
    }
  }
  return null;
}

// Optional external software the engine needs but the plugin never installs
// (a commercial desktop app, for example). The section is display-only: the
// broker reports it in browser_capabilities and never downloads or runs an
// installer. Every field is validated so a typo cannot silently vanish.
function validateSystemDependencies(manifest) {
  if (manifest.systemDependencies === undefined) {
    return null;
  }
  if (!Array.isArray(manifest.systemDependencies)) {
    return 'systemDependencies must be an array';
  }
  const allowed = new Set([
    'id',
    'label',
    'required',
    'downloadUrl',
    'installerName',
    'installHint',
    'licenceNote',
  ]);
  const seen = new Set();
  for (const [index, entry] of manifest.systemDependencies.entries()) {
    const label = `systemDependencies[${index}]`;
    if (!isPlainObject(entry)) {
      return `${label} must be an object`;
    }
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        return `${label} has an unsupported field "${key}"`;
      }
    }
    if (!nonEmptyString(entry.id)) {
      return `${label}.id is missing`;
    }
    if (seen.has(entry.id)) {
      return `systemDependencies declares "${entry.id}" more than once`;
    }
    seen.add(entry.id);
    if (!nonEmptyString(entry.label)) {
      return `${label}.label is missing`;
    }
    if (entry.required !== undefined && typeof entry.required !== 'boolean') {
      return `${label}.required must be a boolean`;
    }
    if (!nonEmptyString(entry.installHint)) {
      return `${label}.installHint is missing`;
    }
    for (const field of ['downloadUrl', 'installerName', 'licenceNote']) {
      const value = entry[field];
      if (value !== undefined && !nonEmptyString(value)) {
        return `${label}.${field} must be a non-empty string`;
      }
    }
    if (entry.downloadUrl !== undefined && !/^https:\/\//.test(entry.downloadUrl)) {
      return `${label}.downloadUrl must be an https:// URL`;
    }
  }
  return null;
}

// Normalized view of the system dependencies a manifest declares. The broker
// reports these generically; an engine that declares none gains no new key.
export function systemDependencies(manifest) {
  const entries = Array.isArray(manifest?.systemDependencies) ? manifest.systemDependencies : [];
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    required: entry.required !== false,
    downloadUrl: nonEmptyString(entry.downloadUrl) ? entry.downloadUrl : null,
    installerName: nonEmptyString(entry.installerName) ? entry.installerName : null,
    installHint: entry.installHint,
    licenceNote: nonEmptyString(entry.licenceNote) ? entry.licenceNote : null,
  }));
}

// The first required environment variable the process does not supply, as the
// manifest's own actionable sentence. Null when every requirement is satisfied
// or the manifest declares none.
export function firstMissingRequiredEnv(manifest, env) {
  const requirements = Array.isArray(manifest?.requiredEnv) ? manifest.requiredEnv : [];
  for (const requirement of requirements) {
    if (!isPlainObject(requirement) || !nonEmptyString(requirement.env)) {
      continue;
    }
    if (usableEnvValue(env?.[requirement.env]) !== null) {
      continue;
    }
    return nonEmptyString(requirement.reason)
      ? requirement.reason
      : `Required environment variable ${requirement.env} is not set.`;
  }
  return null;
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
  if (manifest.contract !== 'playwright-mcp' && manifest.contract !== NATIVE_CONTRACT) {
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
  for (const validation of [
    validateRequiredEnv,
    validateRuntime,
    validateCapabilities,
    validateProfileApplies,
    validateProfileLock,
    validateSystemDependencies,
  ]) {
    const error = validation(manifest);
    if (error !== null) {
      return error;
    }
  }
  if (manifest.contract === NATIVE_CONTRACT) {
    const nativeError = validateNativeManifest(manifest, launcherDir);
    if (nativeError !== null) {
      return nativeError;
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
