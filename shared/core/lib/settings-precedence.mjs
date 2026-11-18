// Harness identity, settings documents and the additive `precedence` report
// (2.26.0).
//
// This module is the one source of truth for the harness-id rule and the
// settings ladder: the broker resolves STEALTH_HARNESS and the gated settings
// documents with it, the default-pointer helpers validate the optional harness
// argument with it, and the profile-default CLI uses it for --harness. The file
// is in CORE_FILES and is vendored byte-identically into both plugins, so the
// installer CLI can use the same rules later. Nothing in this module writes,
// creates, moves or deletes a file.
import { settingState } from './launcher-settings.mjs';

export const HARNESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const INFERRED_HARNESS_ID = 'claude-code';
export const HARNESS_ENV_NAME = 'STEALTH_HARNESS';

const HARNESS_HINT =
  'Use lowercase letters, digits and "-", starting with a letter or digit, up to 32 characters.';

// Echo a bad value as one bounded line, with no control characters and no
// multi-line paste. This is a diagnostic only; it never reaches a child env.
function echo(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, '?')
    .trim()
    .slice(0, 60);
}

// Normalize one harness id. Null means "not a harness id" and is handled by
// the caller as an unset value; no path is ever joined from a raw id.
export function normalizeHarnessId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const id = value.trim().toLowerCase();
  // The pinned pattern permits a trailing "-"; the documented slug shape does
  // not, so the one extra rule is applied here in the shared validator.
  return HARNESS_ID_PATTERN.test(id) && !id.endsWith('-') ? id : null;
}

// Resolve harness identity from the environment. `{ id, source, error }` has
// only two source spellings: "env" for a usable id (explicit or inferred) and
// "unset" when there is no harness level. A bad value is reported once and
// never kills a start. Inference is broker-only: the plugin manager sets
// CLAUDE_PLUGIN_DATA and no STEALTH_DATA_DIR on the Claude Code plugin path,
// so that path gets the same id without adding an env var to either .mcp.json
// or exporting anything to the engine child. A CLI data-root alias suppresses
// inference; an explicitly bad value is never replaced by an inferred one.
export function resolveHarness(env = process.env, log = () => {}) {
  const source = env ?? {};
  const raw = source[HARNESS_ENV_NAME];
  if (raw === undefined) {
    const pluginData = typeof source.CLAUDE_PLUGIN_DATA === 'string' ? source.CLAUDE_PLUGIN_DATA.trim() : '';
    const aliasSet = Object.hasOwn(source, 'STEALTH_DATA_DIR') && source.STEALTH_DATA_DIR !== undefined;
    if (pluginData !== '' && !aliasSet) {
      return { id: INFERRED_HARNESS_ID, source: 'env', error: null };
    }
    return { id: null, source: 'unset', error: null };
  }
  if (typeof raw !== 'string') {
    const error = `STEALTH_HARNESS: ignoring a non-string value; ${HARNESS_HINT}`;
    log(error);
    return { id: null, source: 'unset', error };
  }
  const state = settingState(raw);
  if (state === 'empty') {
    return { id: null, source: 'unset', error: null };
  }
  if (state === 'placeholder') {
    const error = `STEALTH_HARNESS: ignoring an unsubstituted placeholder "${echo(raw)}"; ${HARNESS_HINT}`;
    log(error);
    return { id: null, source: 'unset', error };
  }
  const id = normalizeHarnessId(raw);
  if (id === null) {
    const error = `STEALTH_HARNESS: ignoring "${echo(raw)}"; ${HARNESS_HINT}`;
    log(error);
    return { id: null, source: 'unset', error };
  }
  return { id, source: 'env', error: null };
}

// The pointer file's own facts, without targetDir: this block reports files,
// not profile directories. A pointer that was never read (no harness id, or an
// engine that owns its profile) is reported as not-applicable.
function pointerView(pointer) {
  return {
    path: pointer?.path ?? null,
    state: pointer?.state ?? 'not-applicable',
    name: pointer?.name ?? null,
    error: pointer?.error ?? null,
  };
}

// The additive `precedence.profile` block from spec §7.1, narrowed to the
// profile half. `won` is the existing profileSource vocabulary; the level that
// won is reported separately as profilePointerLevel.
export function profilePrecedenceReport({
  harness = null,
  session = null,
  harnessPointer = null,
  globalPointer = null,
  pointerLevel = null,
  won = null,
} = {}) {
  return {
    harness: {
      id: harness?.id ?? null,
      source: harness?.source ?? 'unset',
      error: harness?.error ?? null,
    },
    profile: {
      won,
      session: {
        profile_dir: session?.profile_dir ?? null,
        account: session?.account ?? null,
      },
      harness: pointerView(harnessPointer),
      global: pointerView(globalPointer),
    },
  };
}

// The existing pointer-source vocabulary, reused by the additive
// profileDefaultGlobal key. `null` means the pointer was not read at all.
export function pointerSource(pointer) {
  if (pointer === null || pointer === undefined) {
    return null;
  }
  if (pointer.state === 'present') {
    return 'pointer';
  }
  return pointer.state === 'missing' ? 'none' : 'invalid';
}

// { name, source, path, error } | null for the global pointer, reported beside
// the effective profileDefault* keys.
export function globalPointerReport(pointer) {
  if (pointer === null || pointer === undefined) {
    return null;
  }
  return {
    name: pointer.name,
    source: pointerSource(pointer),
    path: pointer.path,
    error: pointer.error,
  };
}

// --- settings documents and the full ladder (2.26.0) ------------------------
//
// The gate runs BEFORE this module looks at either document. A plugin-management
// install (CLAUDE_PLUGIN_DATA, no STEALTH_DATA_DIR, no explicit opt-in) never
// stats or reads settings.json or settings.d/<harness>.json, whether they exist
// or not. Nothing here writes a file, and every unusable value is skipped and
// reported rather than fatal.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveToolProfile } from '../engine-registry.mjs';
import {
  LAUNCHER_SETTING_ENV,
  resolveBooleanSetting,
  resolveChoiceSetting,
  resolveOptionalSetting,
} from './launcher-settings.mjs';
import {
  PING_TIMEOUT_DEFAULT_MS,
  PING_TIMEOUT_ENV_VAR,
  PING_TIMEOUT_SETTING_VAR,
  resolvePingTimeout,
} from './ping-timeout.mjs';
import { resolvePasswordManager } from './password-manager.mjs';
import {
  resolveCopyContents,
  resolveOnLocked,
  resolveProfileIsolation,
  resolveProfileLifetime,
  resolveSeatLimit,
} from './profile.mjs';

export const SETTINGS_DOCUMENT_LIMIT_BYTES = 64 * 1024;
export const SETTINGS_LEVEL_ENV = 'STEALTH_SETTINGS_LEVEL';
export const SETTINGS_LEVELS = Object.freeze(['auto', 'session', 'harness', 'global']);
export const DOCUMENT_SETTINGS_KEYS = Object.freeze([
  'profile_isolation',
  'on_locked',
  'copy_contents',
  'profile_lifetime',
  'seat_limit',
  'identity_mode',
  'ping_timeout_ms',
  'password_manager',
  'headless',
  'humanize',
  'human_preset',
  'release_channel',
  'proxy_bypass',
  'engine_version',
  'output_dir',
  'tool_profile',
]);
export const CREDENTIAL_SETTINGS_KEYS = Object.freeze(['proxy_server', 'licence_key']);
export const EXCLUDED_DOCUMENT_KEYS = Object.freeze([
  'profile_dir',
  'account',
  ...CREDENTIAL_SETTINGS_KEYS,
  'extension_paths',
  'disabled_tools',
  'tools_vision',
  'tools_pdf',
  'tools_devtools',
  'tools_storage',
  'tools_network',
  'tools_testing',
  'tools_config',
  'browser_engine',
  'camoufox_profile',
  'camoufox_data_dir',
  'kameleo_profile_id',
  'kameleo_endpoint',
  'geoip_proxy_match',
  'allow_unrestricted_file_access',
  'settings_level',
]);
export const SETTINGS_ENV_NAMES = Object.freeze({
  profile_isolation: 'STEALTH_PROFILE_ISOLATION',
  on_locked: 'STEALTH_ON_LOCKED',
  copy_contents: 'STEALTH_COPY_CONTENTS',
  profile_lifetime: 'STEALTH_PROFILE_LIFETIME',
  seat_limit: 'STEALTH_SEAT_LIMIT',
  identity_mode: 'STEALTH_IDENTITY_MODE',
  ping_timeout_ms: PING_TIMEOUT_SETTING_VAR,
  password_manager: 'STEALTH_PASSWORD_MANAGER',
  headless: 'PLAYWRIGHT_MCP_HEADLESS',
  humanize: 'CLOAK_PLAYWRIGHT_MCP_HUMANIZE',
  human_preset: 'CLOAK_PLAYWRIGHT_MCP_HUMAN_PRESET',
  release_channel: 'CLOAK_PLAYWRIGHT_MCP_RELEASE_CHANNEL',
  proxy_bypass: 'PLAYWRIGHT_MCP_PROXY_BYPASS',
  engine_version: 'CLOAKBROWSER_VERSION',
  output_dir: 'PLAYWRIGHT_MCP_OUTPUT_DIR',
  tool_profile: 'STEALTH_TOOL_PROFILE',
});

const IDENTITY_MODE_DEFAULT = 'profile';
const IDENTITY_MODES = Object.freeze(['profile', 'random']);
const LEVEL_ORDER = Object.freeze(['env', 'session', 'harness', 'global']);

// The broker's original identity-mode resolver, moved here verbatim so the
// shared module is the one validator the CLI can vendor. `source` is added for
// the layering report only; the log wording in the broker stays byte-identical.
export function resolveIdentityMode(value) {
  const raw = typeof value === 'string' ? value : '';
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.includes('${')) {
    return {
      mode: IDENTITY_MODE_DEFAULT,
      source: 'default',
      placeholder: trimmed.includes('${') ? trimmed : null,
      ignored: null,
    };
  }
  const folded = trimmed.toLowerCase();
  if (IDENTITY_MODES.includes(folded)) {
    return { mode: folded, source: 'setting', placeholder: null, ignored: null };
  }
  return { mode: IDENTITY_MODE_DEFAULT, source: 'default', placeholder: null, ignored: trimmed };
}

// `settings_level` is env-only. Unset, empty or an unusable value takes the safe
// `auto` branch with one log line and never refuses a start.
export function resolveSettingsLevel(env = {}, log = () => {}) {
  const source = env ?? {};
  const raw = source[SETTINGS_LEVEL_ENV];
  const state = settingState(raw);
  if (state !== 'value') {
    if (state === 'placeholder') {
      log(`${SETTINGS_LEVEL_ENV}: ignoring the unsubstituted placeholder "${echo(raw)}"; using auto.`);
    }
    return { value: 'auto', source: 'default' };
  }
  const value = raw.trim().toLowerCase();
  if (!SETTINGS_LEVELS.includes(value) || value.length > 32) {
    log(`${SETTINGS_LEVEL_ENV}: ignoring "${echo(raw)}"; using auto.`);
    return { value: 'auto', source: 'default' };
  }
  return { value, source: 'env' };
}

// D0: an explicit data-root alias or an explicit document-naming level is the
// ONLY permission to probe. This function performs no filesystem operation.
export function settingsDocumentsEnabled(env = {}, settingsLevel = 'auto') {
  const source = env ?? {};
  const aliasSet = Object.hasOwn(source, 'STEALTH_DATA_DIR') && source.STEALTH_DATA_DIR !== undefined;
  return aliasSet || settingsLevel === 'global' || settingsLevel === 'harness';
}

// The ONLY document reader the broker uses. The gate is evaluated here before
// any stat or read, so a plugin-path process cannot probe a document even when
// one exists. Tests can assert the zero-probe property on this one function.
export function readSettingsDocuments({
  env = {},
  dataDir,
  harnessId = null,
  settingsLevel = 'auto',
  log = () => {},
} = {}) {
  const enabled = settingsDocumentsEnabled(env, settingsLevel);
  if (!enabled) {
    return { enabled: false, documents: { global: null, harness: null } };
  }
  return {
    enabled: true,
    documents: {
      global: readSettingsDocument({ dataDir, level: 'global', log }),
      harness: readSettingsDocument({ dataDir, level: 'harness', harnessId, log }),
    },
  };
}

export function settingsDocumentPath(dataDir, level, harnessId = null) {
  if (level === 'global') {
    return path.join(dataDir, 'settings.json');
  }
  return harnessId === null ? null : path.join(dataDir, 'settings.d', `${harnessId}.json`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Read one document; never write, never throw. `settings` is only the accepted
// string values; problems are reported once per offending key.
export function readSettingsDocument({ dataDir, level, harnessId = null, log = () => {} }) {
  const file = settingsDocumentPath(dataDir, level, harnessId);
  const base = { path: file, state: 'missing', version: null, keys: 0, error: null };
  const result = { ...base, settings: {}, problems: [] };
  if (file === null) {
    return { ...result, state: 'not-applicable' };
  }
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return result;
  }
  if (!stats.isFile()) {
    const error = `${file}: settings document is not a file; it is ignored.`;
    log(error);
    return { ...result, state: 'invalid', error };
  }
  if (stats.size > SETTINGS_DOCUMENT_LIMIT_BYTES) {
    const error = `${file}: settings document exceeds the 64 KB limit; it is ignored.`;
    log(error);
    return { ...result, state: 'invalid', error };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
  } catch {
    const error = `${file}: settings document is not valid UTF-8; it is ignored.`;
    log(error);
    return { ...result, state: 'invalid', error };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const error = `${file}: settings document is not valid JSON; it is ignored.`;
    log(error);
    return { ...result, state: 'invalid', error };
  }
  if (!isPlainObject(parsed) || parsed.version !== 1) {
    const error = `${file}: settings document must be an object with version 1; it is ignored.`;
    log(error);
    return { ...result, state: 'invalid', error };
  }
  if (!isPlainObject(parsed.settings)) {
    const error = `${file}: settings document has no settings object; it is ignored.`;
    log(error);
    return { ...result, state: 'invalid', error };
  }
  const settings = {};
  const problems = [];
  for (const [key, value] of Object.entries(parsed.settings)) {
    if (!DOCUMENT_SETTINGS_KEYS.includes(key)) {
      const excluded =
        key === SETTINGS_LEVEL_ENV || key === 'settings_level' || EXCLUDED_DOCUMENT_KEYS.includes(key);
      const reason = excluded ? 'session-only' : 'unknown key';
      problems.push({ key, value: echo(value), reason });
      log(`${file}: ignoring ${reason} "${key}" in the settings document.`);
      continue;
    }
    if (typeof value !== 'string') {
      problems.push({ key, value: echo(value), reason: 'invalid-type' });
      log(`${file}: "${key}" is not a string (invalid-type); it is ignored.`);
      continue;
    }
    settings[key] = value;
  }
  return {
    path: file,
    state: 'present',
    version: 1,
    keys: Object.keys(settings).length,
    error: null,
    settings,
    problems,
  };
}

function adaptMode(resolution) {
  return {
    value: resolution.mode,
    usable: resolution.source === 'setting',
    ignored: resolution.ignored,
    placeholder: resolution.placeholder,
    problem: null,
  };
}

function adaptLauncher(resolution) {
  return {
    value: resolution.value,
    usable: resolution.source === 'setting',
    ignored: null,
    placeholder: null,
    problem: null,
  };
}

function validatorFor(key, { env, engine, profiles }) {
  switch (key) {
    case 'profile_isolation':
      return (raw) => adaptMode(resolveProfileIsolation(raw));
    case 'on_locked':
      return (raw) => adaptMode(resolveOnLocked(raw));
    case 'copy_contents':
      return (raw) => adaptMode(resolveCopyContents(raw));
    case 'profile_lifetime':
      return (raw) => adaptMode(resolveProfileLifetime(raw));
    case 'seat_limit':
      return (raw) => adaptMode(resolveSeatLimit(raw));
    case 'identity_mode':
      return (raw) => adaptMode(resolveIdentityMode(raw));
    case 'ping_timeout_ms':
      return (raw) => {
        const candidateEnv = {};
        if (env[PING_TIMEOUT_ENV_VAR] !== undefined) {
          candidateEnv[PING_TIMEOUT_ENV_VAR] = env[PING_TIMEOUT_ENV_VAR];
        }
        candidateEnv[PING_TIMEOUT_SETTING_VAR] = raw;
        const resolution = resolvePingTimeout(candidateEnv);
        return {
          value: resolution.ms,
          usable: resolution.source === 'setting' && resolution.variable === PING_TIMEOUT_SETTING_VAR,
          ignored: null,
          placeholder: resolution.problem === 'placeholder' ? raw : null,
          problem: resolution.problem,
        };
      };
    case 'password_manager':
      return (raw) => {
        const resolution = resolvePasswordManager({ STEALTH_PASSWORD_MANAGER: raw });
        return {
          value: resolution.enabled,
          usable: resolution.raw !== null && resolution.problem === null,
          ignored: resolution.problem === 'ignored' ? raw : null,
          placeholder: resolution.problem === 'placeholder' ? raw : null,
          problem: resolution.problem,
        };
      };
    case 'headless':
      return (raw) =>
        adaptLauncher(
          resolveBooleanSetting(raw, {
            name: 'headless',
            envName: LAUNCHER_SETTING_ENV.headless,
            safe: false,
          }),
        );
    case 'humanize':
      return (raw) =>
        adaptLauncher(
          resolveBooleanSetting(raw, {
            name: 'humanize',
            envName: LAUNCHER_SETTING_ENV.humanize,
            safe: true,
          }),
        );
    case 'human_preset':
      return (raw) =>
        adaptLauncher(
          resolveChoiceSetting(raw, {
            name: 'human_preset',
            choices: ['default', 'careful'],
            safe: 'default',
          }),
        );
    case 'release_channel':
      return (raw) =>
        adaptLauncher(
          resolveChoiceSetting(raw, {
            name: 'release_channel',
            choices: ['stable', 'preview'],
            safe: 'stable',
          }),
        );
    case 'proxy_bypass':
    case 'engine_version':
    case 'output_dir':
      return (raw) => adaptLauncher(resolveOptionalSetting(raw, { name: key }));
    case 'tool_profile':
      return (raw) => {
        const resolution = resolveToolProfile(raw, engine, profiles);
        return {
          value: resolution.profile,
          usable: resolution.source === 'user',
          ignored: resolution.ignored,
          placeholder: resolution.placeholder,
          problem: null,
        };
      };
    default:
      throw new Error(`unknown document-settable key: ${key}`);
  }
}

function skipReason(raw, resolution, key) {
  if (key === 'ping_timeout_ms' && resolution.problem !== null) {
    return resolution.problem;
  }
  return settingState(raw) === 'placeholder'
    ? 'unsubstituted placeholder'
    : 'not one of the documented choices';
}

function skippedEntry(level, raw, resolution, key) {
  return { level, value: echo(raw), reason: skipReason(raw, resolution, key) };
}

function credentialReport(env, key) {
  const raw = env[key === 'proxy_server' ? 'PLAYWRIGHT_MCP_PROXY_SERVER' : 'CLOAKBROWSER_LICENSE_KEY'];
  const configured = typeof raw === 'string' && raw.trim() !== '' && !raw.includes('${');
  return { level: 'session', configured, source: configured ? 'setting' : 'default' };
}

function firstNote(settings) {
  for (const key of DOCUMENT_SETTINGS_KEYS) {
    const entry = settings[key];
    for (const level of LEVEL_ORDER) {
      const skip = entry.skipped.find((candidate) => candidate.level === level);
      if (skip !== undefined) {
        const used = typeof entry.value === 'string' ? echo(entry.value) : String(entry.value);
        return (
          `The ${level} ${key} value "${skip.value}" is ${skip.reason}; ` +
          `the ${entry.level} value "${used}" is used instead.`
        );
      }
    }
  }
  return null;
}

// Resolve all 16 document-settable keys through their EXISTING validators. The
// derived `env` is the only channel document-won values use to reach the
// launcher; process.env itself is never mutated and the plugin path gets the
// original object back, byte for byte.
export function resolveLayeredSettings({
  env = {},
  documents = {},
  settingsLevel = 'auto',
  dataRootEnabled = false,
  engine = null,
  profiles = null,
  log = () => {},
} = {}) {
  const sourceEnv = env ?? {};
  const enabled = dataRootEnabled;
  const resolution = {};
  const report = {};
  const sourceOverrides = {};
  const settingsEnv = enabled ? { ...sourceEnv } : sourceEnv;
  const promotion =
    enabled && (settingsLevel === 'global' || settingsLevel === 'harness') ? settingsLevel : null;

  for (const key of DOCUMENT_SETTINGS_KEYS) {
    const validate = validatorFor(key, { env: sourceEnv, engine, profiles });
    const fallback = validate('');
    const skipped = [];
    let chosen = { value: fallback.value, level: 'default', source: 'default', resolver: fallback };
    let engineRefused = false;

    // The engine variable is above session, documents and settings_level. An
    // explicit but unusable engine value is refused with no fallthrough.
    if (key === 'ping_timeout_ms' && settingState(sourceEnv[PING_TIMEOUT_ENV_VAR]) !== 'unset') {
      const engineRaw = sourceEnv[PING_TIMEOUT_ENV_VAR];
      if (settingState(engineRaw) !== 'empty') {
        const engineResult = resolvePingTimeout({ [PING_TIMEOUT_ENV_VAR]: engineRaw });
        chosen =
          engineResult.problem === null
            ? {
                value: engineResult.ms,
                level: 'env',
                source: 'env',
                resolver: { ...engineResult, ignored: null, placeholder: null },
              }
            : {
                value: PING_TIMEOUT_DEFAULT_MS,
                level: 'default',
                source: 'default',
                resolver: { ...engineResult, ignored: null, placeholder: null },
              };
        if (engineResult.problem !== null) {
          engineRefused = true;
          skipped.push({ level: 'env', value: echo(engineRaw), reason: engineResult.problem });
        }
      }
    }

    if (chosen.level !== 'env' && !engineRefused) {
      const candidates = [
        { level: 'session', raw: sourceEnv[SETTINGS_ENV_NAMES[key]] },
        { level: 'harness', raw: documents.harness?.settings?.[key] },
        { level: 'global', raw: documents.global?.settings?.[key] },
      ];
      const ordered =
        promotion === null
          ? candidates
          : [
              ...candidates.filter((c) => c.level === promotion),
              ...candidates.filter((c) => c.level !== promotion),
            ];
      const seen = new Set();
      for (const candidate of ordered) {
        if (
          seen.has(candidate.level) ||
          candidate.raw === undefined ||
          settingState(candidate.raw) === 'empty'
        ) {
          continue;
        }
        seen.add(candidate.level);
        const result = validate(candidate.raw);
        if (result.usable) {
          chosen = {
            value: result.value,
            level: candidate.level,
            source: candidate.level === 'session' ? 'setting' : 'document',
            resolver: result,
          };
          break;
        }
        skipped.push(skippedEntry(candidate.level, candidate.raw, result, key));
      }
      for (const problem of documents.harness?.problems ?? []) {
        if (problem.key === key && !seen.has('harness')) {
          skipped.push({ level: 'harness', value: problem.value, reason: problem.reason });
        }
      }
      for (const problem of documents.global?.problems ?? []) {
        if (problem.key === key && !seen.has('global')) {
          skipped.push({ level: 'global', value: problem.value, reason: problem.reason });
        }
      }
    }

    resolution[key] = { ...chosen, skipped };
    report[key] = { level: chosen.level, source: chosen.source, value: chosen.value, skipped };
    if (chosen.source === 'document') {
      sourceOverrides[key] = 'document';
      const envName = SETTINGS_ENV_NAMES[key];
      if (chosen.value === null || chosen.value === undefined) {
        delete settingsEnv[envName];
      } else {
        settingsEnv[envName] = String(chosen.value);
      }
    }
  }

  if (enabled) {
    for (const key of CREDENTIAL_SETTINGS_KEYS) {
      report[key] = credentialReport(sourceEnv, key);
    }
  }

  return {
    enabled,
    env: settingsEnv,
    resolution,
    report,
    sourceOverrides,
    note: enabled ? firstNote(report) : null,
  };
}

export function settingsPrecedenceReport(base, { enabled, documents, settingsLevel, report }) {
  if (!enabled) {
    return base;
  }
  const documentView = (document) => ({
    path: document?.path ?? null,
    state: document?.state ?? 'not-applicable',
    version: document?.version ?? null,
    keys: document?.keys ?? 0,
    error: document?.error ?? null,
    sessionOnly: (document?.problems ?? [])
      .filter((problem) => problem.reason === 'session-only')
      .map((problem) => problem.key),
  });
  return {
    ...base,
    documents: {
      harness: documentView(documents.harness),
      global: documentView(documents.global),
    },
    settingsLevel: { value: settingsLevel.value, source: settingsLevel.source },
    settings: report,
  };
}
