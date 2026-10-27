// Saved logins and autofill for the Camoufox engine (2.16.0).
//
// Firefox's login manager is gated by `signon.rememberSignons` (the save offer
// and every fetch/autofill path) and `signon.autofillForms` (the fill itself).
// The pinned Camoufox build sets both as defaults false and, more importantly,
// locks `signon.rememberSignons` false through its own
// `distribution/policies.json` (`PasswordManagerEnabled: false`,
// `OfferToSaveLogins: false`). Launch prefs alone lose to that lock, and the
// build has no readable per-user policy directory on Windows (the 2026-10-26
// follow-up proved `XREUserRunTimeDir` fails in the compiled platform branch).
//
// The surgical route is therefore a plugin-owned overlay of the installed build:
// every heavy byte is shared (hardlinks/junctions, lib/camoufox-overlay.mjs) and
// only `distribution/policies.json` is ours - the build's own document with the
// two password values true, every other policy preserved. The launcher exports
// the overlay's `camoufox.exe` through `CAMOUFOX_EXECUTABLE_PATH`, which is the
// route the pinned wrapper honours, and the entry point merges exactly the three
// signon prefs. The first enable (and any build/policy/format change) is proved
// with one short headless start whose temporary geolocation policy must answer
// `denied`; anything else runs the stock build and reports why.
//
// Everything here is inert unless `password_manager` is on: the launcher calls it
// with the setting off and it only removes an overlay and record a previous on
// start created. A directory without this plugin's marker is never touched.

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
export const PASSWORD_MANAGER_RECORD_FILENAME = 'password-manager.json';
export const PASSWORD_MANAGER_RECORD_VERSION = 1;
export const PASSWORD_MANAGER_SOURCE_POLICY_PARTS = Object.freeze(['distribution', 'policies.json']);
export const PASSWORD_MANAGER_POLICY_KEYS = Object.freeze(['PasswordManagerEnabled', 'OfferToSaveLogins']);
export const PASSWORD_MANAGER_CONFIG_ENV_NAMES = Object.freeze([
  'CAMOUFOX_MCP_CONFIG',
  'PLAYWRIGHT_MCP_CONFIG',
]);
export const PASSWORD_MANAGER_PROBE_TIMEOUT_MS = 60000;

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

// The managed document is the build's own policy document with exactly the two
// password values flipped. Every other policy (telemetry, updates, extension
// uninstall, search engines, form-history and profile-import locks) stays as the
// build shipped it.
export function managedPolicy(buildPolicy) {
  if (!isPlainObject(buildPolicy) || !isPlainObject(buildPolicy.policies)) {
    return null;
  }
  const managed = cloneJson(buildPolicy);
  managed.policies.PasswordManagerEnabled = true;
  managed.policies.OfferToSaveLogins = true;
  return managed;
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
  'blocked-by-overlay',
  'blocked-by-existing-overlay',
  'blocked-by-build-policy',
  'blocked-config',
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
// record carries the overlay path (so turning the setting off removes it) and a
// failure kind the next start uses to decide whether to retry.
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
  try {
    writePasswordPolicyRecord(pluginDataDir, {
      version: PASSWORD_MANAGER_RECORD_VERSION,
      engine: PASSWORD_MANAGER_ENGINE_ID,
      status,
      build: nonEmptyString(build) ? build : null,
      ...(isPlainObject(extra) ? extra : {}),
      overlay: nonEmptyString(overlayPath) ? overlayPath : null,
      policyFile: nonEmptyString(policyFile) ? policyFile : null,
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
  };
}

// Off removes this plugin's overlay (marker + containment + no-follow) and the
// record. A tree that is not ours is never touched, and an in-use overlay is left
// and reported instead of forced.
function disablePasswordManager({ env, pluginDataDir, log, overlayOps }) {
  delete env[PASSWORD_MANAGER_STATE_VAR];
  const record = readPasswordPolicyRecord(pluginDataDir);
  if (record === null) {
    return {
      status: 'off',
      note: null,
      policyFile: null,
      overlay: null,
      overlayMode: null,
      executable: null,
    };
  }
  let removed = false;
  let reason = null;
  const recorded = nonEmptyString(record.overlay) ? record.overlay : null;
  if (recorded !== null) {
    const result = removeOverlay({ target: recorded, pluginDataDir, ...overlayOps });
    removed = result.removed;
    reason = result.reason;
  }
  removePasswordPolicyRecord(pluginDataDir);
  if (removed) {
    log(`saved logins are off: removed this plugin's overlay ${recorded}.`);
  } else if (recorded !== null && reason !== null) {
    log(`saved logins are off: the overlay ${recorded} was left in place (${reason}).`);
  } else {
    log('saved logins are off: no overlay of this plugin is present; nothing was removed.');
  }
  return {
    status: 'off',
    note: null,
    policyFile: null,
    overlay: null,
    overlayMode: null,
    executable: null,
  };
}

// The whole step, called by launch-camoufox.mjs before the wrapper starts.
// Returns { status, note, policyFile, overlay, overlayMode, executable } where
// `executable` is the Camoufox executable the launcher must export. It never
// throws on a normal failure path and never stops the server from starting.
async function applyPasswordManagerLocked(options) {
  const {
    env,
    pluginDataDir,
    binary,
    build,
    python,
    bootstrap,
    log = () => {},
    platform = process.platform,
    probe = runOverlayProbe,
    overlayOps = {},
  } = options;
  const resolution = resolvePasswordManager(env);
  const problem = passwordManagerProblemNote(resolution);
  if (problem !== null) {
    log(problem);
  }
  if (!resolution.enabled) {
    return disablePasswordManager({ env, pluginDataDir, log, overlayOps });
  }

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
  const managed = managedPolicy(buildPolicy);
  if (binaryPath === null || !existsSync(binaryPath) || managed === null) {
    return blockedResult({
      env,
      pluginDataDir,
      build,
      status: 'blocked-by-build-policy',
      note:
        `Saved logins: the Camoufox build policy ${sourcePolicyFile ?? '(unknown)'} is missing or not the expected ` +
        'JSON, or the build executable is missing, so the overlay cannot be derived and the setting stays off for ' +
        'this start.',
      log,
      executable: binary,
    });
  }

  const managedText = policyBytes(managed);
  const probeText = policyBytes(probePolicy(managed));
  const sourcePolicyHash = sha256(sourceText);
  const managedPolicyHash = sha256(managedText);
  const probePolicyHash = sha256(probeText);
  const key = {
    build,
    sourcePolicyHash,
    managedPolicyHash,
    overlayFormat: OVERLAY_FORMAT,
    overlayMarkerVersion: OVERLAY_MARKER_VERSION,
  };

  // A build that no longer locks the manager off does not need an overlay: the
  // stock build with the signon prefs is the minimal, forward-compatible action.
  if (!passwordPolicyLocked(buildPolicy)) {
    try {
      writePasswordPolicyRecord(pluginDataDir, {
        version: PASSWORD_MANAGER_RECORD_VERSION,
        engine: PASSWORD_MANAGER_ENGINE_ID,
        status: 'prefs',
        build,
        sourcePolicyHash,
        managedPolicyHash,
        overlayFormat: OVERLAY_FORMAT,
        overlay: null,
        policyFile: null,
        verified: true,
        checkedAt: timestamp(),
        note: null,
      });
    } catch {
      // Never fail the start over the record.
    }
    env[PASSWORD_MANAGER_STATE_VAR] = PASSWORD_MANAGER_STATE_PREFS;
    log(
      'saved logins: this Camoufox build no longer locks the password manager off, so the stock build is used ' +
        'with the signon prefs and no overlay is created.',
    );
    return {
      status: 'prefs',
      note: null,
      policyFile: null,
      overlay: null,
      overlayMode: null,
      executable: binaryPath,
    };
  }

  if (platform !== 'win32') {
    return blockedResult({
      env,
      pluginDataDir,
      build,
      status: 'blocked-by-overlay',
      note:
        'Saved logins: the Camoufox overlay build is Windows-only, so the setting is not applied on this ' +
        'platform; the stock build is used and its own policy stays in force.',
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
        : 'Saved logins: the overlay verification previously failed.',
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
        `Saved logins: ${target} already exists and was not written by this plugin ` +
        `(${markerState.reason ?? 'no marker of ours'}), so it is left untouched and the setting stays off for ` +
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
          `Saved logins: the Camoufox overlay build could not be created or refreshed (${detail}); the stock ` +
          'build is used and the setting stays off for this start.',
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
      log('saved logins: verifying that Firefox reads the overlay policy (one short headless start).');
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
            ? `Saved logins: the overlay build was created but Firefox did not read its policy (geolocation ` +
              `answered ${detail}), so the overlay was ${removed ? 'removed' : 'left in place'} and the stock ` +
              'build is used. This result is cached for this build and policy document; turn the setting off and ' +
              'on to retry after a Firefox or cache change.'
            : `Saved logins: the overlay build could not be verified (${detail}), so the stock build is used for ` +
              'this start; the next start retries.',
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
      note: null,
    });
    if (options.lease === true) leaseOverlay(target);
    env[PASSWORD_MANAGER_STATE_VAR] = PASSWORD_MANAGER_STATE_OVERLAY;
    log(
      `saved logins enabled: the Camoufox overlay build ${target} (${marker.mode}) carries the build's policies ` +
        'with only PasswordManagerEnabled and OfferToSaveLogins set true; the session runs that executable with ' +
        'the signon prefs.',
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
        `Saved logins: the overlay verification or record could not be completed (${detail}); the stock build is ` +
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

// Re-exported for the broker's overlay re-check: a directory that is not a real
// directory (a junction, a file) is not a usable overlay even when the record
// says applied.
export { isRealDirectory, overlayPolicyPath, overlayRoot };

// The operation lock also covers verification: a second start cannot launch a
// temporary probe policy or remove an overlay while another start verifies it.
export async function applyPasswordManager(options) {
  const enabled = resolvePasswordManager(options.env).enabled;
  if (!enabled && readPasswordPolicyRecord(options.pluginDataDir) === null) {
    return applyPasswordManagerLocked(options);
  }
  let unlock = null;
  try {
    unlock = await lockOverlayRoot(options.pluginDataDir, options.lockTimeoutMs);
    return await applyPasswordManagerLocked(options);
  } catch (error) {
    return blockedResult({
      ...options,
      status: 'blocked-by-overlay',
      executable: options.binary,
      log: options.log ?? (() => {}),
      note: `Saved logins: overlay setup could not complete (${error.message}); the stock build is used.`,
    });
  } finally {
    if (unlock !== null) unlock();
  }
}
