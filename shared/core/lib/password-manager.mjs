// The plugin-owned Camoufox build overlay (2.17.0).
//
// The pinned Camoufox build ships an enterprise policy document
// (`distribution/policies.json`) that (a) locks Firefox's login manager off
// (`PasswordManagerEnabled: false`, `OfferToSaveLogins: false`) and (b) replaces
// the stock search-engine list with one dummy engine: `Remove` hides every
// engine, `Default: "None"` points the address bar at it and `Add` creates the
// dummy itself. Launch prefs cannot override either, and this Windows build has
// no readable per-user policy directory (the 2026-10-26 follow-up proved
// `XREUserRunTimeDir` fails in the compiled platform branch).
//
// The surgical route is therefore a plugin-owned overlay of the installed build:
// every heavy byte is shared (hardlinks/junctions, lib/camoufox-overlay.mjs) and
// only `distribution/policies.json` is ours, derived from the build's own
// document. The launcher exports the overlay's `camoufox.exe` through
// `CAMOUFOX_EXECUTABLE_PATH`, which is the route the pinned wrapper honours.
//
// Two independent transforms feed that document:
//   - the SEARCH transform is unconditional (2.17.0): the build's `SearchEngines`
//     block is replaced by exactly `{ Default: "Google", PreventInstalls: false }`,
//     which restores the stock engine list, seeds Google once and leaves the
//     browser UI editable (the policy language has no lock for this block);
//     explicit engine entries are never added, so each locale keeps its stock set;
//   - the PASSWORD transform applies only when `password_manager` is on: the two
//     password values become true and the entry point merges exactly the three
//     signon prefs.
//
// Creation, or any change to the source/managed document, is proved with one
// short headless start whose temporary geolocation policy must answer `denied`;
// anything else runs the stock build and reports why. When the search transform
// is active, the launcher also renames the profile's `search.json.mozlz4` aside
// once (a backup, never deleted) so Firefox rebuilds the stock list instead of
// keeping engines the old policy had hidden; a per-profile marker makes it run
// once, and a failure is reported, never fatal.
//
// A directory without this plugin's marker is never touched. `password_manager`
// off means "no password keys", not "no overlay".

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  cleanStaleTemps,
  createOverlay,
  inspectOverlay,
  isRealDirectory,
  leaseOverlay,
  lockOverlayRoot,
  overlayInUse,
  overlayExecutablePath,
  overlayPolicyPath,
  overlayRoot,
  overlayTarget,
  OVERLAY_ENGINE,
  OVERLAY_FORMAT,
  OVERLAY_MARKER_FILENAME,
  OVERLAY_MARKER_VERSION,
  pruneOverlays,
  readJsonFile,
  readOverlayMarker,
  removeOverlay,
  sha256,
  sha256File,
  swapOverlay,
  sameOverlayPath,
  writeFileAtomic,
} from './camoufox-overlay.mjs';

export { readJsonFile, sha256, sha256File, writeFileAtomic };

export const PASSWORD_MANAGER_ENGINE_ID = 'camoufox';
export const PASSWORD_MANAGER_SETTING_VAR = 'STEALTH_PASSWORD_MANAGER';
export const PASSWORD_MANAGER_STATE_VAR = 'STEALTH_PASSWORD_MANAGER_STATE';
export const PASSWORD_MANAGER_STATE_OVERLAY = 'overlay';
export const PASSWORD_MANAGER_STATE_PREFS = 'prefs';
// The retained per-user route's state value (2.15.0). No shipped platform
// reaches it any more; it stays for `applyPerUserPolicyFile` and its tests.
export const PASSWORD_MANAGER_STATE_APPLIED = 'applied';
export const PASSWORD_MANAGER_POLICY_FILENAME = 'policies.json';
export const PASSWORD_MANAGER_RECORD_FILENAME = 'password-manager.json';
export const PASSWORD_MANAGER_RECORD_VERSION = 1;
export const PASSWORD_MANAGER_SOURCE_POLICY_PARTS = Object.freeze(['distribution', 'policies.json']);
export const PASSWORD_MANAGER_POLICY_KEYS = Object.freeze(['PasswordManagerEnabled', 'OfferToSaveLogins']);
export const PASSWORD_MANAGER_PATH_TIMEOUT_MS = 20000;
export const PASSWORD_MANAGER_PROBE_TIMEOUT_MS = 60000;
export const PASSWORD_MANAGER_CONFIG_ENV_NAMES = Object.freeze([
  'CAMOUFOX_MCP_CONFIG',
  'PLAYWRIGHT_MCP_CONFIG',
]);

// The overlay state variable. The entry point uses it to remove a user
// `camoufoxOptions.executable_path` from this session's config copy whenever the
// overlay is in use, independently of the password setting: that key would
// silently win over `CAMOUFOX_EXECUTABLE_PATH` and bypass the overlay.
export const CAMOUFOX_OVERLAY_STATE_VAR = 'STEALTH_CAMOUFOX_OVERLAY_STATE';
export const CAMOUFOX_OVERLAY_STATE_APPLIED = 'applied';
export const CAMOUFOX_OVERLAY_STATE_BLOCKED = 'blocked';
export const CAMOUFOX_OVERLAY_STATE_STOCK = 'stock';

// The search transform (2.17.0). The build policy hides every stock engine and
// points the default at a policy-only dummy, and this Camoufox build hard-disables
// its own app-provided engine configuration: `SearchEngineSelector` in
// `browser/omni.ja` returns one inert `None` engine instead of reading the
// packaged search-config-v2 (the source comment says "Camoufox ships no search
// engines"), and `services.settings.server` is empty. Dropping `Remove`/`Add`
// alone therefore restores nothing (measured 2026-10-27: a fresh profile on the
// overlay still held only `None`). The one offline route the build supports is
// the policy `Add` list, so the transform supplies the same five engines the
// build's packaged configuration defines for its default environment (`en-US`,
// region unknown), with each engine's public search URL and no partner codes
// (the packaged variants carry partner parameters this build can never load;
// inventing values would be worse). Google is seeded as the default once - the
// policy language has no lock, so the user's later choice persists - and
// `PreventInstalls: false` keeps the Add-engine UI usable (USER DECISION D2).
export const SEARCH_ENGINE_DEFAULT = 'Google';
export const SEARCH_ENGINE_SET = Object.freeze([
  Object.freeze({
    Name: 'Google',
    Description: 'Google Search',
    Method: 'GET',
    URLTemplate: 'https://www.google.com/search?q={searchTerms}',
  }),
  Object.freeze({
    Name: 'DuckDuckGo',
    Description: 'DuckDuckGo Search',
    Method: 'GET',
    URLTemplate: 'https://duckduckgo.com/?q={searchTerms}',
  }),
  Object.freeze({
    Name: 'Bing',
    Description: 'Bing Search',
    Method: 'GET',
    URLTemplate: 'https://www.bing.com/search?q={searchTerms}',
  }),
  Object.freeze({
    Name: 'Wikipedia (en)',
    Description: 'Wikipedia (en)',
    Method: 'GET',
    URLTemplate: 'https://en.wikipedia.org/wiki/Special:Search?search={searchTerms}',
  }),
  Object.freeze({
    Name: 'Perplexity',
    Description: 'Perplexity',
    Method: 'GET',
    URLTemplate: 'https://www.perplexity.ai/search?q={searchTerms}',
  }),
]);
export const SEARCH_ENGINES_POLICY = Object.freeze({
  Default: SEARCH_ENGINE_DEFAULT,
  PreventInstalls: false,
  Add: SEARCH_ENGINE_SET,
});
// The profile files the one-time search migration touches. The backup keeps the
// original bytes beside the profile file; nothing is ever deleted.
export const SEARCH_PROFILE_FILENAME = 'search.json.mozlz4';
export const SEARCH_MIGRATION_MARKER_FILENAME = '.camoufox-search-migration.json';
export const SEARCH_MIGRATION_MARKER_VERSION = 1;

// The three prefs this setting owns. `signon.autofillForms.http` stays false: a
// credential filled into an unencrypted page is a clear downgrade, and HTTPS is
// unaffected (USER DECISION P3). Address/credit-card autofill and form history
// are deliberately not touched (P9). `toolkit.policies.perUserDir` is never set:
// with the overlay the install policies are already the modified ones, and that
// pref with no readable file disables every policy (the 2.15.0 finding).
export const PASSWORD_MANAGER_PREFS = Object.freeze({
  'signon.rememberSignons': true,
  'signon.autofillForms': true,
  'signon.autofillForms.http': false,
});

export const PASSWORD_MANAGER_APPLIED_SENTENCE =
  'Saved logins are enabled for this profile through a plugin-owned Camoufox build overlay: Firefox may autofill ' +
  'credentials from the profile into matching login forms, and the page (and therefore the model) can read the ' +
  'filled values; treat them as secrets.';

export const PASSWORD_MANAGER_PREFS_SENTENCE =
  'Saved logins are enabled for this profile with the Camoufox build’s own policy: Firefox may autofill credentials ' +
  'from the profile into matching login forms, and the page (and therefore the model) can read the filled values; ' +
  'treat them as secrets.';

export const PASSWORD_MANAGER_NATIVE_NOTE =
  'Saved logins: mcp-camoufox 0.4.5 has no Firefox prefs input, so password_manager cannot be applied to the ' +
  'camoufox-native engine and has no effect there.';

export const PASSWORD_MANAGER_NOT_APPLICABLE_NOTE =
  'Saved logins: password_manager applies only to the camoufox engine; this engine has no Firefox login manager ' +
  'or per-user policy file, so the setting has no effect.';

export const PASSWORD_MANAGER_PENDING_NOTE =
  'Saved logins: the Camoufox overlay build is prepared and verified when the Camoufox backend starts; this ' +
  'report was taken before that step finished.';

const ON_VALUES = new Set(['true', '1', 'yes', 'on']);
const OFF_VALUES = new Set(['false', '0', 'no', 'off']);

// Same shape as the other boolean settings: unset and empty are off, an
// unsubstituted ${user_config.*} placeholder is off, and a value that is not a
// boolean is off with one honest sentence. Nothing here throws.
export function resolvePasswordManager(env = {}) {
  const raw = env[PASSWORD_MANAGER_SETTING_VAR];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') {
    return { enabled: false, raw: null, problem: null };
  }
  if (value.includes('${')) {
    return { enabled: false, raw: value, problem: 'placeholder' };
  }
  const folded = value.toLowerCase();
  if (ON_VALUES.has(folded)) {
    return { enabled: true, raw: value, problem: null };
  }
  if (OFF_VALUES.has(folded)) {
    return { enabled: false, raw: value, problem: null };
  }
  return { enabled: false, raw: value, problem: 'ignored' };
}

export function passwordManagerProblemNote(resolution) {
  if (resolution.problem === 'placeholder') {
    return (
      `Saved logins: ignoring the unsubstituted placeholder ${JSON.stringify(resolution.raw)} from ` +
      `${PASSWORD_MANAGER_SETTING_VAR}; saved logins stay disabled.`
    );
  }
  if (resolution.problem === 'ignored') {
    return (
      `Saved logins: ignoring ${PASSWORD_MANAGER_SETTING_VAR} value ${JSON.stringify(resolution.raw)} because it ` +
      'is not a boolean; saved logins stay disabled.'
    );
  }
  return null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function randomToken() {
  return randomBytes(6).toString('hex');
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

// The managed document is derived from the build's own policy document. The
// search block is replaced whenever the build carries one (unconditionally: this
// is the 2.17.0 search restore), and the two password values are flipped only when
// `password_manager` is on. Every other policy (telemetry, updates, extension
// uninstall, form-history and profile-import locks) stays byte-identical.
export function managedPolicy(buildPolicy, options = {}) {
  const { passwordOn = false } = isPlainObject(options) ? options : {};
  if (!isPlainObject(buildPolicy) || !isPlainObject(buildPolicy.policies)) {
    return null;
  }
  const managed = cloneJson(buildPolicy);
  if (isPlainObject(managed.policies.SearchEngines)) {
    managed.policies.SearchEngines = cloneJson(SEARCH_ENGINES_POLICY);
  }
  if (passwordOn) {
    managed.policies.PasswordManagerEnabled = true;
    managed.policies.OfferToSaveLogins = true;
  }
  return managed;
}

// True when the build's own search block is one this plugin must replace: an
// object (even an empty one) with the build's restrictive or dummy entries. A
// document without the key already ships the stock list, so nothing is added
// (an absent key is left absent, never invented).
export function searchPolicyApplies(buildPolicy) {
  return isPlainObject(buildPolicy) && isPlainObject(buildPolicy.policies)
    ? isPlainObject(buildPolicy.policies.SearchEngines)
    : false;
}

// The policy language has no lock for `SearchEngines` in this build (no `Locked`
// key, no `setAndLockPref`), so the managed block must stay exactly the documented
// keys and the engine entries must stay plain: `Default` is a one-time seed per
// value change and the user's later choice persists. This guard is what a test
// asserts; returning the reason keeps the failure honest.
export function searchPolicyLockFree(managed) {
  const block = isPlainObject(managed?.policies) ? managed.policies.SearchEngines : undefined;
  if (!isPlainObject(block)) {
    return { ok: false, reason: 'the managed document has no SearchEngines object' };
  }
  const keys = Object.keys(block).sort();
  if (keys.join(',') !== 'Add,Default,PreventInstalls') {
    return { ok: false, reason: `unexpected SearchEngines keys: ${keys.join(',')}` };
  }
  if (block.Default !== SEARCH_ENGINE_DEFAULT) {
    return { ok: false, reason: `unexpected SearchEngines default: ${String(block.Default)}` };
  }
  if (typeof block.PreventInstalls !== 'boolean') {
    return { ok: false, reason: 'PreventInstalls is not a boolean' };
  }
  if (!Array.isArray(block.Add) || block.Add.length !== SEARCH_ENGINE_SET.length) {
    return { ok: false, reason: 'the Add list is not the documented engine set' };
  }
  for (const entry of block.Add) {
    if (!isPlainObject(entry) || typeof entry.Name !== 'string' || typeof entry.URLTemplate !== 'string') {
      return { ok: false, reason: 'an Add entry is missing Name or URLTemplate' };
    }
    if ('Locked' in entry || 'SuggestURLTemplate' in entry || 'PostData' in entry) {
      return { ok: false, reason: `an Add entry carries unexpected keys: ${Object.keys(entry).join(',')}` };
    }
  }
  return { ok: true, reason: null };
}

// The one-off verification document: the managed document plus a policy that is
// observable from a page without any credential. `Permissions: Location:
// BlockNewRequests` maps to permissions.default.geo=2, so
// navigator.permissions.query({name:'geolocation'}).state is "denied" only when
// this file was actually read. It is written for the probe and always replaced
// by the managed document afterwards.
export function probePolicy(managed) {
  if (!isPlainObject(managed) || !isPlainObject(managed.policies)) {
    return null;
  }
  const probe = cloneJson(managed);
  const permissions = isPlainObject(probe.policies.Permissions) ? probe.policies.Permissions : {};
  const location = isPlainObject(permissions.Location) ? permissions.Location : {};
  location.BlockNewRequests = true;
  permissions.Location = location;
  probe.policies.Permissions = permissions;
  return probe;
}

export function policyBytes(policy) {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

// True when the build's own policy switches the login manager off. A document
// whose keys are absent or already true does not need an overlay: the stock build
// plus the signon prefs is enough, and that is reported as `prefs`.
export function passwordPolicyLocked(buildPolicy) {
  if (!isPlainObject(buildPolicy) || !isPlainObject(buildPolicy.policies)) {
    return true;
  }
  return PASSWORD_MANAGER_POLICY_KEYS.some((key) => buildPolicy.policies[key] === false);
}

function readTextFile(file) {
  try {
    return readFileSync(file, 'utf8').replace(/^﻿/u, '');
  } catch {
    return null;
  }
}

// The wrapper config a user may already point us at. The entry point applies the
// same shape test before merging; an INI or unreadable file is left untouched and
// the setting is inert for that start, exactly like device identity.
export function passwordUserConfigPath(env = {}) {
  for (const name of PASSWORD_MANAGER_CONFIG_ENV_NAMES) {
    const value = env[name];
    if (nonEmptyString(value)) {
      return path.resolve(value.trim());
    }
  }
  return null;
}

export function passwordUserConfigProblem(env = {}) {
  const file = passwordUserConfigPath(env);
  if (file === null) {
    return null;
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'does not exist' : 'cannot be read';
    return `Saved logins: the config file ${file} ${reason}, so password_manager is not applied on this start.`;
  }
  let config;
  try {
    config = JSON.parse(text.replace(/^﻿/u, ''));
  } catch {
    return `Saved logins: the config file ${file} is not JSON (an INI config or malformed), so password_manager is not applied on this start.`;
  }
  if (!isPlainObject(config)) {
    return `Saved logins: the config file ${file} is not a JSON object, so password_manager is not applied on this start.`;
  }
  const browser = config.browser;
  if (browser !== undefined && browser !== null && !isPlainObject(browser)) {
    return `Saved logins: the config file ${file} has a "browser" value that is not an object, so password_manager is not applied on this start.`;
  }
  const options = isPlainObject(browser) ? browser.camoufoxOptions : undefined;
  if (options !== undefined && options !== null && !isPlainObject(options)) {
    return `Saved logins: the config file ${file} has a "browser.camoufoxOptions" value that is not an object, so password_manager is not applied on this start.`;
  }
  const prefs = isPlainObject(options) ? options.firefox_user_prefs : undefined;
  if (prefs !== undefined && prefs !== null && !isPlainObject(prefs)) {
    return `Saved logins: the config file ${file} has a "browser.camoufoxOptions.firefox_user_prefs" value that is not an object, so password_manager is not applied on this start.`;
  }
  return null;
}

export function passwordRecordPath(pluginDataDir) {
  return path.join(pluginDataDir, 'config', PASSWORD_MANAGER_ENGINE_ID, PASSWORD_MANAGER_RECORD_FILENAME);
}

const RECORD_STATUSES = new Set([
  'applied',
  'prefs',
  'stock',
  'blocked-by-overlay',
  'blocked-by-existing-overlay',
  'blocked-by-build-policy',
  'blocked-config',
  // Written only by the retained per-user route (2.15.0), which no shipped
  // platform reaches; kept readable so an old record is still understood.
  'blocked-by-existing-policy',
]);

// The ownership record is written by the launcher and read by the broker. A
// corrupt record is reported as absent: the next start rewrites it.
export function readPasswordPolicyRecord(pluginDataDir) {
  const record = readJsonFile(passwordRecordPath(pluginDataDir));
  if (!isPlainObject(record)) {
    return null;
  }
  if (record.version !== PASSWORD_MANAGER_RECORD_VERSION || record.engine !== PASSWORD_MANAGER_ENGINE_ID) {
    return null;
  }
  if (typeof record.status !== 'string' || !RECORD_STATUSES.has(record.status)) {
    return null;
  }
  return record;
}

export function writePasswordPolicyRecord(pluginDataDir, record) {
  writeFileAtomic(passwordRecordPath(pluginDataDir), `${JSON.stringify(record, null, 2)}\n`);
}

export function removePasswordPolicyRecord(pluginDataDir) {
  try {
    rmSync(passwordRecordPath(pluginDataDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

function lastNonEmptyLine(text) {
  const lines = String(text)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length === 0 ? null : lines[lines.length - 1];
}

function killProcessTree(child) {
  if (child === null || child === undefined || child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

// One short browser start, bounded. The helper prints exactly one JSON line;
// progress and errors go to stderr. A timeout kills the whole tree (Python, the
// Playwright driver and the browser), so no probe browser is left behind.
export function runOverlayProbe(options) {
  const { env, python, bootstrap, binary, timeoutMs = PASSWORD_MANAGER_PROBE_TIMEOUT_MS } = options;
  return new Promise((resolve) => {
    if (!nonEmptyString(python) || !nonEmptyString(bootstrap) || !nonEmptyString(binary)) {
      resolve({ state: 'error', detail: 'the probe helper is not available' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(python, ['-I', bootstrap, 'overlay-probe', binary], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({ state: 'timeout', detail: `no answer within ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000);
    });
    child.on('error', (error) => {
      finish({ state: 'error', detail: error.message });
    });
    child.on('close', (code) => {
      const line = lastNonEmptyLine(stdout);
      if (line !== null) {
        try {
          const parsed = JSON.parse(line);
          if (isPlainObject(parsed) && typeof parsed.state === 'string') {
            finish(parsed);
            return;
          }
        } catch {
          // fall through to the stderr detail
        }
      }
      finish({
        state: 'error',
        detail: lastNonEmptyLine(stderr) ?? `the probe exited with code ${String(code)}`,
      });
    });
  });
}

function recordMatchesKey(record, key) {
  return (
    record !== null &&
    record.build === key.build &&
    record.sourcePolicyHash === key.sourcePolicyHash &&
    record.managedPolicyHash === key.managedPolicyHash &&
    record.overlayFormat === key.overlayFormat &&
    record.overlayMarkerVersion === key.overlayMarkerVersion
  );
}

// Every blocked path runs the stock build and reports one honest sentence. The
// record carries the overlay path (so a later start can remove it) and a failure
// kind the next start uses to decide whether to retry.
function blockedResult(options) {
  const {
    env,
    pluginDataDir,
    build,
    status,
    note,
    log,
    executable,
    extra,
    overlayPath = null,
    policyFile = null,
  } = options;
  delete env[PASSWORD_MANAGER_STATE_VAR];
  env[CAMOUFOX_OVERLAY_STATE_VAR] = CAMOUFOX_OVERLAY_STATE_BLOCKED;
  try {
    writePasswordPolicyRecord(pluginDataDir, {
      version: PASSWORD_MANAGER_RECORD_VERSION,
      engine: PASSWORD_MANAGER_ENGINE_ID,
      status,
      build: nonEmptyString(build) ? build : null,
      ...(isPlainObject(extra) ? extra : {}),
      overlay: nonEmptyString(overlayPath) ? overlayPath : null,
      policyFile: nonEmptyString(policyFile) ? policyFile : null,
      searchSource: 'blocked',
      note,
      checkedAt: timestamp(),
    });
  } catch {
    // The report still works from this start's result; never fail the start.
  }
  log(note);
  return {
    status,
    note,
    policyFile: nonEmptyString(policyFile) ? policyFile : null,
    overlay: null,
    overlayMode: null,
    executable: nonEmptyString(executable) ? executable : null,
    searchSource: 'blocked',
    searchDefault: null,
    searchMigration: null,
    searchBackupFile: null,
  };
}

// No overlay is needed for this build (its policy already carries the stock
// search block and, when the password setting is on, does not lock the manager).
// A trees this plugin created for an older policy is retired here - marker,
// containment and no-follow only - and a tree that is not ours is never touched.
// The record then says `prefs` (the signon prefs apply to the stock build) or
// `stock` (nothing to apply); either way search reports the stock list.
function stockResult({ env, pluginDataDir, status, build, key, log, overlayOps, executable }) {
  delete env[PASSWORD_MANAGER_STATE_VAR];
  if (status === 'prefs') {
    // The entry point merges the three signon prefs into the stock build.
    env[PASSWORD_MANAGER_STATE_VAR] = PASSWORD_MANAGER_STATE_PREFS;
  }
  env[CAMOUFOX_OVERLAY_STATE_VAR] = CAMOUFOX_OVERLAY_STATE_STOCK;
  const record = readPasswordPolicyRecord(pluginDataDir);
  const recorded = record !== null && nonEmptyString(record.overlay) ? record.overlay : null;
  let removed = false;
  let reason = null;
  if (recorded !== null) {
    const result = removeOverlay({ target: recorded, pluginDataDir, ...overlayOps });
    removed = result.removed;
    reason = result.reason;
  }
  if (removed) {
    log(`camoufox overlay: removed this plugin's overlay ${recorded}; this build needs none.`);
  } else if (recorded !== null && reason !== null) {
    log(`camoufox overlay: the overlay ${recorded} was left in place (${reason}).`);
  }
  const note =
    status === 'prefs'
      ? 'Saved logins: this Camoufox build does not lock the password manager off, so the stock build is used ' +
        'with the signon prefs and no overlay is created.'
      : null;
  try {
    writePasswordPolicyRecord(pluginDataDir, {
      version: PASSWORD_MANAGER_RECORD_VERSION,
      engine: PASSWORD_MANAGER_ENGINE_ID,
      status,
      build: nonEmptyString(build) ? build : null,
      ...(isPlainObject(key) ? key : {}),
      overlay: null,
      policyFile: null,
      mode: null,
      verified: true,
      checkedAt: timestamp(),
      searchSource: 'stock',
      searchDefault: null,
      searchMigration: null,
      searchBackupFile: null,
      searchNote: null,
      note,
    });
  } catch {
    // Never fail the start over the record.
  }
  return {
    status,
    note,
    policyFile: null,
    overlay: null,
    overlayMode: null,
    executable: executable ?? null,
    searchSource: 'stock',
    searchDefault: null,
    searchMigration: null,
    searchBackupFile: null,
  };
}

// The whole step, called by launch-camoufox.mjs before the wrapper starts.
// Returns { status, note, policyFile, overlay, overlayMode, executable,
// searchSource, searchDefault, searchMigration, searchBackupFile } where
// `executable` is the Camoufox executable the launcher must export. It never
// throws on a normal failure path and never stops the server from starting.
//
// 2.17.0: the overlay is always-on for the camoufox engine. It is created when
// either transform would change the build's policy document (search, always;
// password, only with the setting on); otherwise the stock build runs unchanged
// and any overlay an older policy needed is retired.
async function applyCamoufoxOverlayLocked(options) {
  const {
    env,
    pluginDataDir,
    binary,
    build,
    python,
    bootstrap,
    profileDir = null,
    log = () => {},
    platform = process.platform,
    probe = runOverlayProbe,
    migrate = migrateSearchProfile,
    overlayOps = {},
  } = options;
  const resolution = resolvePasswordManager(env);
  const problem = passwordManagerProblemNote(resolution);
  if (problem !== null) {
    log(problem);
  }
  const passwordOn = resolution.enabled;

  const binaryPath = nonEmptyString(binary) ? path.resolve(binary) : null;
  const sourceDir = binaryPath === null ? null : path.dirname(binaryPath);
  const sourcePolicyFile =
    sourceDir === null ? null : path.join(sourceDir, ...PASSWORD_MANAGER_SOURCE_POLICY_PARTS);
  const sourceText = sourcePolicyFile === null ? null : readTextFile(sourcePolicyFile);
  let buildPolicy = null;
  if (sourceText !== null) {
    try {
      buildPolicy = JSON.parse(sourceText);
    } catch {
      buildPolicy = null;
    }
  }
  const managed = managedPolicy(buildPolicy, { passwordOn });
  if (binaryPath === null || !existsSync(binaryPath) || managed === null) {
    return blockedResult({
      env,
      pluginDataDir,
      build,
      status: 'blocked-by-build-policy',
      note:
        `Camoufox overlay: the build policy ${sourcePolicyFile ?? '(unknown)'} is missing or not the expected ` +
        'JSON, or the build executable is missing, so the overlay cannot be derived and the stock build is used ' +
        'for this start.',
      log,
      executable: binary,
    });
  }

  // The user config only matters when the signon prefs are merged. With the
  // password setting off the entry point touches the user's file only to strip a
  // bypassing `executable_path` from this session's copy, which cannot fail.
  if (passwordOn) {
    const configProblem = passwordUserConfigProblem(env);
    if (configProblem !== null) {
      return blockedResult({
        env,
        pluginDataDir,
        build,
        status: 'blocked-config',
        note: configProblem,
        log,
        executable: binary,
      });
    }
  }

  const managedText = policyBytes(managed);
  const probeText = policyBytes(probePolicy(managed));
  const sourcePolicyHash = sha256(sourceText);
  const managedPolicyHash = sha256(managedText);
  const probePolicyHash = sha256(probeText);
  const searchActive = searchPolicyApplies(buildPolicy);
  const key = {
    build,
    sourcePolicyHash,
    managedPolicyHash,
    overlayFormat: OVERLAY_FORMAT,
    overlayMarkerVersion: OVERLAY_MARKER_VERSION,
  };

  // Neither transform changes anything for this build: the stock build already
  // ships the list this plugin would write, and (when on) the manager is not
  // locked. That is the minimal, forward-compatible action; an overlay an older
  // policy needed is retired, never left to shadow a newer build.
  if (!searchActive && !(passwordOn && passwordPolicyLocked(buildPolicy))) {
    return stockResult({
      env,
      pluginDataDir,
      status: passwordOn ? 'prefs' : 'stock',
      build,
      key: { sourcePolicyHash, managedPolicyHash, overlayFormat: OVERLAY_FORMAT },
      log,
      overlayOps,
      executable: binaryPath,
    });
  }

  if (platform !== 'win32') {
    return blockedResult({
      env,
      pluginDataDir,
      build,
      status: 'blocked-by-overlay',
      note:
        'Camoufox overlay: the overlay build is Windows-only, so the stock build is used on this platform and ' +
        'its own policy (including the search-engine block) stays in force.',
      log,
      executable: binaryPath,
      extra: { ...key, failure: 'platform' },
    });
  }

  // A definitive verification failure (`prompt`: the file was not read) is
  // cached for the same build, source policy, managed policy and format, so a
  // machine where Firefox does not read the overlay does not pay for a browser
  // start on every launch. A timeout or error is never cached: the next start
  // retries. Turning the setting off removes the record.
  const earlier = readPasswordPolicyRecord(pluginDataDir);
  if (
    earlier !== null &&
    earlier.status === 'blocked-by-overlay' &&
    earlier.failure === 'probe' &&
    recordMatchesKey(earlier, key)
  ) {
    return blockedResult({
      env,
      pluginDataDir,
      build,
      status: 'blocked-by-overlay',
      note: nonEmptyString(earlier.note)
        ? earlier.note
        : 'Camoufox overlay: the overlay verification previously failed.',
      log,
      executable: binaryPath,
      extra: { ...key, failure: 'probe' },
    });
  }

  const target = overlayTarget(pluginDataDir, sourceDir);
  const markerState = readOverlayMarker(target);
  if (markerState.state === 'foreign') {
    return blockedResult({
      env,
      pluginDataDir,
      build,
      status: 'blocked-by-existing-overlay',
      note:
        `Camoufox overlay: ${target} already exists and was not written by this plugin ` +
        `(${markerState.reason ?? 'no marker of ours'}), so it is left untouched and the stock build is used for ` +
        'this start.',
      log,
      executable: binaryPath,
      overlayPath: target,
      extra: { ...key, failure: 'foreign' },
    });
  }

  let marker = markerState.state === 'ours' ? markerState.marker : null;
  let inspection =
    marker === null
      ? { ok: false, reason: 'no overlay yet', needsFinalPolicy: false }
      : inspectOverlay({
          target,
          marker,
          sourceDir,
          sourcePolicyHash,
          managedPolicyHash,
          probePolicyHash,
        });

  if (!inspection.ok) {
    let tempDir = null;
    try {
      cleanStaleTemps({ pluginDataDir, ...overlayOps });
      tempDir = `${target}.tmp-${process.pid}-${randomToken()}`;
      const createdAt = timestamp();
      marker = createOverlay({
        sourceDir,
        tempDir,
        probePolicyText: probeText,
        markerBase: {
          version: OVERLAY_MARKER_VERSION,
          engine: OVERLAY_ENGINE,
          sourceBuild: path.resolve(sourceDir),
          sourceExe: path.join(sourceDir, 'camoufox.exe'),
          sourcePolicySha256: sourcePolicyHash,
          managedPolicySha256: managedPolicyHash,
          probePolicySha256: probePolicyHash,
          createdAt,
          verifiedAt: null,
          pluginOverlayFormat: OVERLAY_FORMAT,
        },
        ...overlayOps,
      });
      swapOverlay({ tempDir, target, ...overlayOps, log });
      inspection = { ok: true, reason: null, needsFinalPolicy: true };
    } catch (error) {
      if (tempDir !== null) {
        try {
          rmSync(tempDir, { recursive: true, force: true, maxRetries: 2 });
        } catch {
          // A leftover temp tree is pruned by age on a later start.
        }
      }
      const leftover = markerState.state === 'ours' ? target : null;
      const detail = error instanceof Error ? error.message : String(error);
      return blockedResult({
        env,
        pluginDataDir,
        build,
        status: 'blocked-by-overlay',
        note:
          `Camoufox overlay: the overlay build could not be created or refreshed (${detail}); the stock build ` +
          'is used for this start and the next start retries.',
        log,
        executable: binaryPath,
        overlayPath: leftover,
        extra: { ...key, failure: typeof error?.code === 'string' ? error.code : 'create' },
      });
    }
  }

  const verifiedForThisKey =
    earlier !== null &&
    earlier.status === 'applied' &&
    earlier.verified === true &&
    recordMatchesKey(earlier, key) &&
    sameOverlayPath(earlier.overlay, target) &&
    (earlier.mode === 'hardlink' || earlier.mode === 'copy');

  try {
    if (!verifiedForThisKey && overlayInUse(target))
      throw new Error('the overlay is in use and cannot be probed');
    if (!verifiedForThisKey) {
      writeFileAtomic(overlayPolicyPath(target), probeText);
      log('camoufox overlay: verifying that Firefox reads the overlay policy (one short headless start).');
      const probeResult = await probe({
        env,
        python,
        bootstrap,
        binary: overlayExecutablePath(target),
      });
      // Always restore the final policy, so a leftover overlay can never carry
      // the temporary verification policy into a user session.
      writeFileAtomic(overlayPolicyPath(target), managedText);
      if (probeResult === null || typeof probeResult !== 'object' || probeResult.state !== 'denied') {
        const definitive =
          probeResult !== null && typeof probeResult === 'object' && probeResult.state === 'prompt';
        const detail =
          probeResult === null || typeof probeResult !== 'object' || !nonEmptyString(probeResult.detail)
            ? String(probeResult?.state ?? 'no answer')
            : probeResult.detail;
        let overlayPath = target;
        let removed = false;
        if (definitive) {
          const removal = removeOverlay({ target, pluginDataDir, ...overlayOps });
          removed = removal.removed;
          if (removed) {
            overlayPath = null;
          }
        }
        return blockedResult({
          env,
          pluginDataDir,
          build,
          status: 'blocked-by-overlay',
          note: definitive
            ? `Camoufox overlay: the overlay build was created but Firefox did not read its policy (geolocation ` +
              `answered ${detail}), so the overlay was ${removed ? 'removed' : 'left in place'} and the stock ` +
              'build is used. This result is cached for this build and policy document; a Firefox or build ' +
              'change retries it.'
            : `Camoufox overlay: the overlay build could not be verified (${detail}), so the stock build is used ` +
              'for this start; the next start retries.',
          log,
          executable: binaryPath,
          overlayPath,
          extra: { ...key, failure: definitive ? 'probe' : 'transient', verified: false },
        });
      }
      marker = { ...marker, verifiedAt: timestamp() };
      writeFileAtomic(path.join(target, OVERLAY_MARKER_FILENAME), `${JSON.stringify(marker, null, 2)}\n`);
    } else if (inspection.needsFinalPolicy) {
      // An earlier start was interrupted between the probe policy write and the
      // final one; restore the final document without another browser start.
      writeFileAtomic(overlayPolicyPath(target), managedText);
    }

    // The one-time search migration runs only when the overlay's search
    // transform is actually in this document (searchActive), before the wrapper
    // and therefore Firefox start, so the browser rebuilds the stock list from
    // the build's packaged configuration instead of keeping the hidden flags the
    // old policy stored. It is never fatal: a failed rename keeps the file and
    // the session starts.
    const migration = searchActive
      ? migrate({ profileDir, log })
      : { status: 'no-profile', backup: null, note: null };
    const searchSource = searchActive ? 'overlay' : 'stock';
    const searchDefault = searchActive ? SEARCH_ENGINE_DEFAULT : null;
    const policyFile = overlayPolicyPath(target);
    writePasswordPolicyRecord(pluginDataDir, {
      version: PASSWORD_MANAGER_RECORD_VERSION,
      engine: PASSWORD_MANAGER_ENGINE_ID,
      status: 'applied',
      build,
      sourcePolicyHash,
      managedPolicyHash,
      probePolicyHash,
      overlayFormat: OVERLAY_FORMAT,
      overlayMarkerVersion: OVERLAY_MARKER_VERSION,
      overlay: target,
      policyFile,
      mode: marker.mode,
      verified: true,
      verifiedAt: marker.verifiedAt ?? timestamp(),
      checkedAt: timestamp(),
      passwordOn,
      searchSource,
      searchDefault,
      searchMigration: migration.status,
      searchBackupFile: migration.backup ?? null,
      searchNote: migration.note ?? null,
      note: null,
    });
    if (options.lease === true) leaseOverlay(target);
    if (passwordOn) {
      env[PASSWORD_MANAGER_STATE_VAR] = PASSWORD_MANAGER_STATE_OVERLAY;
    } else {
      delete env[PASSWORD_MANAGER_STATE_VAR];
    }
    env[CAMOUFOX_OVERLAY_STATE_VAR] = CAMOUFOX_OVERLAY_STATE_APPLIED;
    log(
      `camoufox overlay enabled: ${target} (${marker.mode}) carries the build's policies with ` +
        `${searchActive ? `the search block replaced by {Default: "${SEARCH_ENGINE_DEFAULT}"} and ` : ''}` +
        `${passwordOn ? 'only PasswordManagerEnabled and OfferToSaveLogins set true' : 'no password change'}; ` +
        'the session runs that executable.',
    );
    pruneOverlays({
      pluginDataDir,
      currentName: path.basename(target),
      ...overlayOps,
      log,
    });
    return {
      status: 'applied',
      note: null,
      policyFile,
      overlay: target,
      overlayMode: marker.mode,
      executable: overlayExecutablePath(target),
      searchSource,
      searchDefault,
      searchMigration: migration.status,
      searchBackupFile: migration.backup ?? null,
    };
  } catch (error) {
    try {
      writeFileAtomic(overlayPolicyPath(target), managedText);
    } catch {
      // The overlay may be gone; the stock build still starts.
    }
    const detail = error instanceof Error ? error.message : String(error);
    return blockedResult({
      env,
      pluginDataDir,
      build,
      status: 'blocked-by-overlay',
      note:
        `Camoufox overlay: the verification or record could not be completed (${detail}); the stock build is ` +
        'used for this start and the next start retries.',
      log,
      executable: binaryPath,
      overlayPath: readOverlayMarker(target).state === 'ours' ? target : null,
      extra: { ...key, failure: 'transient', verified: false },
    });
  }
}

// File existence only. The broker never opens logins.db or key4.db.
export function hasFirefoxLoginStore(profileDir) {
  if (!nonEmptyString(profileDir)) {
    return false;
  }
  return existsSync(path.join(profileDir, 'logins.db'));
}

// --- one-time search migration (2.17.0) ------------------------------------
// A profile created under the build's old policy carries `search.json.mozlz4`
// with the stock engines hidden and the dummy `None` engine as the default. With
// the overlay the policy no longer removes or adds anything, but Firefox keeps
// the hidden flags it already stored, so the engine list would stay short. The
// only route that does not edit browser state from the plugin is to move that
// one file aside *once*, before Firefox starts, and let it rebuild the stock
// list from the build's packaged configuration. The backup is never deleted, the
// per-profile marker makes the step run once, and a failure keeps the file and
// starts normally.

export function searchMigrationMarkerPath(profileDir) {
  return path.join(profileDir, SEARCH_MIGRATION_MARKER_FILENAME);
}

export function readSearchMigrationMarker(profileDir) {
  if (!nonEmptyString(profileDir)) {
    return null;
  }
  const marker = readJsonFile(searchMigrationMarkerPath(profileDir));
  if (!isPlainObject(marker)) {
    return null;
  }
  if (
    marker.version !== SEARCH_MIGRATION_MARKER_VERSION ||
    marker.engine !== PASSWORD_MANAGER_ENGINE_ID ||
    marker.migrated !== true
  ) {
    return null;
  }
  return marker;
}

function searchBackupStamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
}

// Best effort and never fatal. Returns the outcome the launcher records and the
// broker reports: renamed | already | no-profile | no-file | failed.
export function migrateSearchProfile(options) {
  const { profileDir, log = () => {} } = options ?? {};
  if (!nonEmptyString(profileDir)) {
    return { status: 'no-profile', backup: null, note: null };
  }
  if (!existsSync(profileDir)) {
    return { status: 'no-profile', backup: null, note: null };
  }
  if (readSearchMigrationMarker(profileDir) !== null) {
    return { status: 'already', backup: null, note: null };
  }
  const sourceFile = path.join(profileDir, SEARCH_PROFILE_FILENAME);
  if (!existsSync(sourceFile)) {
    // Nothing was stored under the old policy; Firefox builds the stock list on
    // this start. No marker: a file that appears later is still migrated once.
    return { status: 'no-file', backup: null, note: null };
  }
  let backupName = `${SEARCH_PROFILE_FILENAME}.backup-${searchBackupStamp()}`;
  if (existsSync(path.join(profileDir, backupName))) {
    backupName = `${backupName}-${randomToken()}`;
  }
  try {
    renameSync(sourceFile, path.join(profileDir, backupName));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const note =
      `Search engines: the profile's ${SEARCH_PROFILE_FILENAME} could not be moved aside (${detail}); it was ` +
      'kept and the browser starts normally, so this profile may keep the old hidden engine list until that ' +
      'file is removed by hand.';
    log(note);
    return { status: 'failed', backup: null, note };
  }
  let markerNote = null;
  try {
    writeFileAtomic(
      searchMigrationMarkerPath(profileDir),
      `${JSON.stringify(
        {
          version: SEARCH_MIGRATION_MARKER_VERSION,
          engine: PASSWORD_MANAGER_ENGINE_ID,
          migrated: true,
          at: timestamp(),
          backup: backupName,
          reason: 'overlay-search-policy',
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    markerNote =
      `Search engines: moved ${SEARCH_PROFILE_FILENAME} aside but could not write ` +
      `${SEARCH_MIGRATION_MARKER_FILENAME} (${detail}), so the next start may move it aside once more.`;
  }
  const note =
    markerNote ??
    `Search engines: moved the profile's old ${SEARCH_PROFILE_FILENAME} aside once as ${backupName} so Firefox ` +
      'rebuilds the stock engine list; the backup is kept.';
  log(note);
  return { status: 'renamed', backup: backupName, note };
}

// Re-exported for the broker's overlay re-check: a directory that is not a real
// directory (a junction, a file) is not a usable overlay even when the record
// says applied.
export { isRealDirectory, overlayPolicyPath, overlayRoot };

// The operation lock also covers verification: a second start cannot launch a
// temporary probe policy or remove an overlay while another start verifies it.
// 2.17.0: the overlay is always-on for this engine, so the lock is taken on every
// camoufox start; on a warm start it is held for a few milliseconds.
export async function applyCamoufoxOverlay(options) {
  let unlock = null;
  try {
    unlock = await lockOverlayRoot(options.pluginDataDir, options.lockTimeoutMs);
    return await applyCamoufoxOverlayLocked(options);
  } catch (error) {
    return blockedResult({
      ...options,
      status: 'blocked-by-overlay',
      executable: options.binary,
      log: options.log ?? (() => {}),
      note: `Camoufox overlay: setup could not complete (${error.message}); the stock build is used.`,
    });
  } finally {
    if (unlock !== null) unlock();
  }
}

// The name the launcher and the earlier suites call. Kept as a thin alias so the
// 2.16.0 tests and any external caller keep working unchanged.
export async function applyPasswordManager(options) {
  return applyCamoufoxOverlay(options);
}

// --- the retained per-user policy-file route (2.15.0) ----------------------
// 2.15.1 withdrew this route from every shipped platform: this Windows build has
// no readable per-user Firefox policy directory (`XREUserRunTimeDir` returns
// NS_ERROR_FAILURE) and the POSIX branch never had one. The overlay above is the
// route 2.17.0 uses. The functions stay exported and covered by tests so a
// future build or platform that implements a readable per-user directory can use
// them without a rewrite; nothing in production calls `applyPerUserPolicyFile`.
export const PASSWORD_MANAGER_WINDOWS_DEAD_PATH_NOTE =
  'Saved logins: this Camoufox build has no readable per-user Firefox policy directory on Windows, so no policy ' +
  'file is written, no verification browser runs and the setting stays off. The plugin-owned overlay build (not ' +
  'yet shipped) is the future route.';

export function expectedPerUserDir(localAppData) {
  return path.join(localAppData, 'Camoufox', 'Camoufox');
}

// The resolved build lives at <cacheRoot>\Cache\browsers\official\<build>\camoufox.exe.
// Anything else (a custom executable, an overlay tree) is not the standard cache
// and is refused: writing the per-user file there would be a guess.
export function buildLayout(binary) {
  if (!nonEmptyString(binary)) {
    return null;
  }
  const buildDir = path.dirname(path.resolve(binary));
  const official = path.dirname(buildDir);
  const browsers = path.dirname(official);
  const cache = path.dirname(browsers);
  const cacheRoot = path.dirname(cache);
  if (
    path.basename(official).toLowerCase() !== 'official' ||
    path.basename(browsers).toLowerCase() !== 'browsers' ||
    path.basename(cache).toLowerCase() !== 'cache'
  ) {
    return null;
  }
  return { buildDir, cacheRoot };
}

export function sameWindowsPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left === '' || right === '') {
    return false;
  }
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

// 'ours' means the file's content is exactly a document this plugin wrote (the
// managed one or the temporary probe one, recorded when it was written). Anything
// else is foreign and must never be overwritten or removed.
export function policyOwnership(record, policyFile) {
  if (
    record === null ||
    !nonEmptyString(record.policyFile) ||
    !sameWindowsPath(record.policyFile, policyFile)
  ) {
    return 'unknown';
  }
  const hash = sha256File(policyFile);
  if (hash === null) {
    return 'missing';
  }
  if (
    (nonEmptyString(record.contentHash) && hash === record.contentHash) ||
    (nonEmptyString(record.probeHash) && hash === record.probeHash)
  ) {
    return 'ours';
  }
  return 'foreign';
}

function removeOwnedPolicyFile(record, policyFile) {
  if (policyOwnership(record, policyFile) !== 'ours') {
    return false;
  }
  try {
    rmSync(policyFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

// Resolve the Windows KnownFolder LocalAppData through the helper script. The
// environment is passed through so a scratch run keeps its redirected homes, but
// the folder itself comes from SHGetKnownFolderPath, which ignores those
// variables (the 2026-10-26 investigation confirmed it).
export function resolvePasswordPolicyPath(options) {
  const { env, python, bootstrap, timeoutMs = PASSWORD_MANAGER_PATH_TIMEOUT_MS } = options;
  if (!nonEmptyString(python) || !nonEmptyString(bootstrap)) {
    return null;
  }
  const result = spawnSync(python, ['-I', bootstrap, 'password-path'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result === null || result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }
  const line = lastNonEmptyLine(result.stdout);
  if (line === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(line);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// One short browser start, bounded, with `toolkit.policies.perUserDir=true` and
// the temporary geolocation policy in the per-user file.
export function runPasswordProbe(options) {
  const { env, python, bootstrap, binary, timeoutMs = PASSWORD_MANAGER_PROBE_TIMEOUT_MS } = options;
  return new Promise((resolve) => {
    if (!nonEmptyString(python) || !nonEmptyString(bootstrap) || !nonEmptyString(binary)) {
      resolve({ state: 'error', detail: 'the probe helper is not available' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(python, ['-I', bootstrap, 'password-probe', binary], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({ state: 'timeout', detail: `no answer within ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000);
    });
    child.on('error', (error) => {
      finish({ state: 'error', detail: error.message });
    });
    child.on('close', (code) => {
      const line = lastNonEmptyLine(stdout);
      if (line !== null) {
        try {
          const parsed = JSON.parse(line);
          if (isPlainObject(parsed) && typeof parsed.state === 'string') {
            finish(parsed);
            return;
          }
        } catch {
          // fall through to the stderr detail
        }
      }
      finish({
        state: 'error',
        detail: lastNonEmptyLine(stderr) ?? `the probe exited with code ${String(code)}`,
      });
    });
  });
}

// The retained per-user policy-file route (2.15.0), unchanged in behaviour. No
// shipped platform reaches it in 2.17.0.
export async function applyPerUserPolicyFile(options) {
  const {
    env,
    pluginDataDir,
    binary,
    build,
    python,
    bootstrap,
    log = () => {},
    resolvePath = resolvePasswordPolicyPath,
    probe = runPasswordProbe,
  } = options;

  let localAppData = null;
  try {
    const resolved = resolvePath({ env, python, bootstrap });
    localAppData =
      isPlainObject(resolved) && nonEmptyString(resolved.localAppData) ? resolved.localAppData : null;
  } catch {
    localAppData = null;
  }
  if (localAppData === null) {
    return blockedResult({
      env,
      pluginDataDir,
      build,
      status: 'blocked-by-build-policy',
      note:
        'Saved logins: the Windows LocalAppData folder could not be resolved, so the per-user policy file is not ' +
        'written and the setting stays off for this start.',
      policyFile: null,
      log,
    });
  }
  const expectedDir = expectedPerUserDir(localAppData);
  const target = path.join(expectedDir, PASSWORD_MANAGER_POLICY_FILENAME);

  const layout = buildLayout(binary);
  if (layout === null || !sameWindowsPath(layout.cacheRoot, expectedDir)) {
    return blockedResult({
      env,
      pluginDataDir,
      build,
      status: 'blocked-by-build-policy',
      note:
        `Saved logins: the Camoufox build (${binary}) is not inside the expected machine-wide Camoufox cache ` +
        `(${expectedDir}), so the per-user policy file is not written and the setting stays off for this start.`,
      policyFile: null,
      log,
    });
  }

  const sourceFile = path.join(layout.buildDir, ...PASSWORD_MANAGER_SOURCE_POLICY_PARTS);
  const sourceText = readTextFile(sourceFile);
  let buildPolicy = null;
  if (sourceText !== null) {
    try {
      buildPolicy = JSON.parse(sourceText);
    } catch {
      buildPolicy = null;
    }
  }
  const managed = buildPolicy === null ? null : managedPolicy(buildPolicy, { passwordOn: true });
  if (managed === null) {
    return blockedResult({
      env,
      pluginDataDir,
      build,
      status: 'blocked-by-build-policy',
      note:
        `Saved logins: the Camoufox build policy ${sourceFile} is missing or not the expected JSON, so the ` +
        'per-user policy file cannot be derived and the setting stays off for this start.',
      policyFile: null,
      log,
    });
  }
  const managedText = policyBytes(managed);
  const probeText = policyBytes(probePolicy(managed));
  const contentHash = sha256(managedText);
  const probeHash = sha256(probeText);
  const sourcePolicyHash = sha256(sourceText);

  const record = readPasswordPolicyRecord(pluginDataDir);
  if (existsSync(target)) {
    const ownership = policyOwnership(record, target);
    if (ownership !== 'ours') {
      return blockedResult({
        env,
        pluginDataDir,
        build,
        status: 'blocked-by-existing-policy',
        note:
          `Saved logins: ${target} already exists and was not written by this plugin, so it is left untouched ` +
          'and the setting stays off for this start.',
        policyFile: target,
        log,
      });
    }
  }

  // A verification failure is cached for the same build and policy document, so a
  // machine where Firefox does not read the resolved per-user path does not pay
  // for a browser start on every launch.
  if (
    record !== null &&
    record.status === 'blocked-by-build-policy' &&
    record.verified !== true &&
    record.build === build &&
    record.sourcePolicyHash === sourcePolicyHash &&
    record.contentHash === contentHash &&
    record.policyFile === null &&
    !existsSync(target)
  ) {
    return blockedResult({
      env,
      pluginDataDir,
      build,
      status: 'blocked-by-build-policy',
      note: nonEmptyString(record.note)
        ? record.note
        : 'Saved logins: the verification start previously failed.',
      policyFile: null,
      log,
      extra: { sourcePolicyHash, contentHash, probeHash, verified: false, failure: 'probe' },
    });
  }

  const needsProbe =
    record === null ||
    record.verified !== true ||
    record.build !== build ||
    record.sourcePolicyHash !== sourcePolicyHash ||
    record.contentHash !== contentHash ||
    !nonEmptyString(record.policyFile) ||
    !sameWindowsPath(record.policyFile, target);

  try {
    if (needsProbe) {
      writeFileAtomic(target, probeText);
      log(`saved logins: verifying that Firefox reads ${target} (one short headless start).`);
      const probeResult = await probe({ env, python, bootstrap, binary });
      if (probeResult === null || typeof probeResult !== 'object' || probeResult.state !== 'denied') {
        removeOwnedPolicyFile(
          {
            version: PASSWORD_MANAGER_RECORD_VERSION,
            engine: PASSWORD_MANAGER_ENGINE_ID,
            policyFile: target,
            contentHash,
            probeHash,
          },
          target,
        );
        const detail =
          probeResult === null || typeof probeResult !== 'object' || !nonEmptyString(probeResult.detail)
            ? String(probeResult?.state ?? 'no answer')
            : probeResult.detail;
        return blockedResult({
          env,
          pluginDataDir,
          build,
          status: 'blocked-by-build-policy',
          note:
            `Saved logins: the verification start could not confirm that Firefox reads ${target} (${detail}), so ` +
            'the per-user policy file was removed and the setting stays off. This result is cached for this build ' +
            'and policy document; a Firefox or cache change retries it.',
          policyFile: null,
          log,
          extra: { sourcePolicyHash, contentHash, probeHash, verified: false, failure: 'probe' },
        });
      }
    }
    writeFileAtomic(target, managedText);
    writePasswordPolicyRecord(pluginDataDir, {
      version: PASSWORD_MANAGER_RECORD_VERSION,
      engine: PASSWORD_MANAGER_ENGINE_ID,
      status: 'applied',
      build,
      policyFile: target,
      sourcePolicyFile: sourceFile,
      sourcePolicyHash,
      contentHash,
      probeHash,
      verified: true,
      verifiedAt: timestamp(),
      checkedAt: timestamp(),
      note: null,
    });
    env[PASSWORD_MANAGER_STATE_VAR] = PASSWORD_MANAGER_STATE_APPLIED;
    log(
      `saved logins enabled: wrote the per-user policy file ${target} (the build's policies with only ` +
        'PasswordManagerEnabled and OfferToSaveLogins set true) and the Firefox prefs that use it.',
    );
    return { status: 'applied', note: null, policyFile: target, executable: null, searchSource: 'stock' };
  } catch (error) {
    removeOwnedPolicyFile(
      {
        version: PASSWORD_MANAGER_RECORD_VERSION,
        engine: PASSWORD_MANAGER_ENGINE_ID,
        policyFile: target,
        contentHash,
        probeHash,
      },
      target,
    );
    removePasswordPolicyRecord(pluginDataDir);
    const detail = error instanceof Error ? error.message : String(error);
    const note = `Saved logins: the per-user policy file ${target} could not be written (${detail}); the setting is off for this start.`;
    delete env[PASSWORD_MANAGER_STATE_VAR];
    log(note);
    return {
      status: 'blocked-by-build-policy',
      note,
      policyFile: null,
      executable: null,
      searchSource: 'stock',
    };
  }
}
