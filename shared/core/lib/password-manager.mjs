// Saved logins and autofill for the Camoufox engine (2.15.0; the Windows route
// was withdrawn in 2.15.1).
//
// Firefox's login manager is gated by `signon.rememberSignons` (the save offer
// and every fetch/autofill path) and `signon.autofillForms` (the fill itself).
// The pinned Camoufox build sets both as defaults false and, more importantly,
// locks `signon.rememberSignons` false through its own
// `distribution/policies.json` (`PasswordManagerEnabled: false`,
// `OfferToSaveLogins: false`). Launch prefs alone lose to that lock (verified by
// the 2026-10-26 investigation, run C), so 2.15.0 tried Firefox's per-user policy
// file: a copy of the build's own policies with only the two password keys true,
// written where Firefox reads it when `toolkit.policies.perUserDir=true`.
//
// 2.15.1 withdraws that route on Windows. The 2026-10-26 follow-up proved this
// build has no readable per-user policy directory there: `XREUserRunTimeDir`
// returns NS_ERROR_FAILURE in the compiled platform branch, so the pref simply
// applies no policies at all. The route was therefore dead on the only platform
// it ran on: it wrote a machine-wide file outside the plugin data directory that
// nothing ever reads, and its one-time verification could hold the MCP handshake
// for up to ~80 s against a 30 s client connect timeout. `applyPasswordManager`
// now records and reports the block without resolving a path, writing a file,
// starting a browser or merging a pref. The route itself is retained below,
// unchanged and covered by tests, for a future build or platform that
// implements a readable per-user directory; the plugin-owned overlay build (the
// build's own tree with only `distribution/policies.json` changed) is the
// intended route and is not shipped yet.
//
// The per-user directory is derived from the Windows KnownFolder LocalAppData
// (never from a possibly redirected environment variable) and is accepted only
// when it is the same directory as the resolved build's Camoufox cache root. The
// first enable proves the file was actually read with a one-off geolocation
// permission probe. A per-user file that is not ours is never overwritten, and
// the pref is never set without a readable file: with the pref set and no file,
// Firefox applies no policies at all (also verified by the investigation).
//
// Everything here is inert unless `password_manager` is on: the launcher calls it
// with the setting off and it only removes a file a previous on start created.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PASSWORD_MANAGER_ENGINE_ID = 'camoufox';
export const PASSWORD_MANAGER_SETTING_VAR = 'STEALTH_PASSWORD_MANAGER';
export const PASSWORD_MANAGER_STATE_VAR = 'STEALTH_PASSWORD_MANAGER_STATE';
export const PASSWORD_MANAGER_STATE_APPLIED = 'applied';
export const PASSWORD_MANAGER_POLICY_FILENAME = 'policies.json';
export const PASSWORD_MANAGER_RECORD_FILENAME = 'password-manager.json';
export const PASSWORD_MANAGER_RECORD_VERSION = 1;
export const PASSWORD_MANAGER_SOURCE_POLICY_PARTS = Object.freeze(['distribution', 'policies.json']);
export const PASSWORD_MANAGER_POLICY_KEYS = Object.freeze(['PasswordManagerEnabled', 'OfferToSaveLogins']);
export const PASSWORD_MANAGER_CONFIG_ENV_NAMES = Object.freeze([
  'CAMOUFOX_MCP_CONFIG',
  'PLAYWRIGHT_MCP_CONFIG',
]);
export const PASSWORD_MANAGER_PATH_TIMEOUT_MS = 20000;
export const PASSWORD_MANAGER_PROBE_TIMEOUT_MS = 60000;

// The four prefs this setting owns. `signon.autofillForms.http` stays false: a
// credential filled into an unencrypted page is a clear downgrade, and HTTPS is
// unaffected (USER DECISION P3). Address/credit-card autofill and form history
// are deliberately not touched (P9).
export const PASSWORD_MANAGER_PREFS = Object.freeze({
  'toolkit.policies.perUserDir': true,
  'signon.rememberSignons': true,
  'signon.autofillForms': true,
  'signon.autofillForms.http': false,
});

export const PASSWORD_MANAGER_APPLIED_SENTENCE =
  'Saved logins are enabled for this profile: Firefox may autofill credentials from the profile into matching ' +
  'login forms, and the page (and therefore the model) can read the filled values; treat them as secrets.';

export const PASSWORD_MANAGER_NATIVE_NOTE =
  'Saved logins: mcp-camoufox 0.4.5 has no Firefox prefs input, so password_manager cannot be applied to the ' +
  'camoufox-native engine and has no effect there.';

export const PASSWORD_MANAGER_NOT_APPLICABLE_NOTE =
  'Saved logins: password_manager applies only to the camoufox engine; this engine has no Firefox login manager ' +
  'or per-user policy file, so the setting has no effect.';

export const PASSWORD_MANAGER_PENDING_NOTE =
  'Saved logins: the per-user policy file is prepared and verified when the Camoufox backend starts; this ' +
  'report was taken before that step finished.';

// 2.15.1: the per-user route is dead on Windows (see the file header), so a
// Windows start with the setting on records this note instead of trying it.
export const PASSWORD_MANAGER_WINDOWS_DEAD_PATH_NOTE =
  'Saved logins: this Camoufox build has no readable per-user Firefox policy directory on Windows, so no policy ' +
  'file is written, no verification browser runs and the setting stays off. The plugin-owned overlay build (not ' +
  'yet shipped) is the future route.';

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

// Host path semantics (the feature only runs on win32). Paths are compared
// case-insensitively because Windows is: the Camoufox cache root is
// `<LocalAppData>\camoufox\camoufox` while Firefox's per-user directory is
// `<LocalAppData>\Camoufox\Camoufox` (vendor/name), and those are the same
// directory on Windows. Using the host module keeps the unit suite on Linux CI
// running against real temporary directories.

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

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

// The managed file is the build's own policy document with exactly the two
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

// The one-off verification file: the managed document plus a policy that is
// observable from a page without any credential. `Permissions: Location:
// BlockNewRequests` maps to permissions.default.geo=2, so
// navigator.permissions.query({name:'geolocation'}).state is "denied" only when
// this file was actually read.
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

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function sha256File(file) {
  try {
    return sha256(readFileSync(file));
  } catch {
    return null;
  }
}

function readTextFile(file) {
  try {
    return readFileSync(file, 'utf8').replace(/^﻿/u, '');
  } catch {
    return null;
  }
}

export function readJsonFile(file) {
  const text = readTextFile(file);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
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
  'blocked-by-existing-policy',
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

function writeFileAtomic(target, text) {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, text, { encoding: 'utf8' });
    renameSync(temporary, target);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // A leftover temp file is harmless and never read; never mask the write.
    }
  }
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
// variables (the investigation confirmed it).
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

function blockedResult({ env, pluginDataDir, build, status, note, policyFile, log, extra }) {
  delete env[PASSWORD_MANAGER_STATE_VAR];
  const record = {
    version: PASSWORD_MANAGER_RECORD_VERSION,
    engine: PASSWORD_MANAGER_ENGINE_ID,
    status,
    build: nonEmptyString(build) ? build : null,
    policyFile: nonEmptyString(policyFile) ? policyFile : null,
    note,
    checkedAt: timestamp(),
    ...(isPlainObject(extra) ? extra : {}),
  };
  try {
    writePasswordPolicyRecord(pluginDataDir, record);
  } catch {
    // The report still works from this start's result; never fail the start.
  }
  log(note);
  return { status, note, policyFile: nonEmptyString(policyFile) ? policyFile : null };
}

function disablePasswordManager({ env, pluginDataDir, log }) {
  delete env[PASSWORD_MANAGER_STATE_VAR];
  const record = readPasswordPolicyRecord(pluginDataDir);
  if (record === null) {
    return { status: 'off', note: null, policyFile: null };
  }
  const file = nonEmptyString(record.policyFile) ? record.policyFile : null;
  let removed = false;
  if (file !== null) {
    removed = removeOwnedPolicyFile(record, file);
  }
  removePasswordPolicyRecord(pluginDataDir);
  log(
    removed
      ? `saved logins are off: removed this plugin's per-user policy file ${file}.`
      : 'saved logins are off: no per-user policy file of this plugin is present; nothing was removed.',
  );
  return { status: 'off', note: null, policyFile: removed ? file : null };
}

// The retained per-user policy-file route (2.15.0), unchanged. 2.15.1 does not
// call it: no shipped Windows build has a readable per-user policy directory
// (`XREUserRunTimeDir` returns NS_ERROR_FAILURE) and the POSIX branch refuses
// before it. It stays exported and covered by tests so a future build or platform
// that implements the directory can use it without a rewrite.
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
  const managed = buildPolicy === null ? null : managedPolicy(buildPolicy);
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
  // for a browser start on every launch. Turning the setting off removes the
  // record and therefore retries when it is turned on again.
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
            'and policy document; turn the setting off and on to retry after a Firefox or cache change.',
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
    return { status: 'applied', note: null, policyFile: target };
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
    return { status: 'blocked-by-build-policy', note, policyFile: null };
  }
}

// The whole step, called by launch-camoufox.mjs before the wrapper starts.
// Returns { status, note, policyFile } for the launcher's log; it never throws on
// a normal failure path and never stops the server from starting.
//
// 2.15.1: with the setting on, a Windows start resolves no path, writes no file,
// starts no browser and merges no prefs. The per-user route is dead there (this
// build has no readable per-user policy directory), so the block is recorded and
// reported straight away: the handshake no longer carries the 20 s path lookup
// and the 60 s verification start of 2.15.0, and no machine-wide file can be
// orphaned outside the plugin data directory. Other platforms keep their 2.15.0
// answer. Off is unchanged and still removes only a file this plugin wrote.
export async function applyPasswordManager(options) {
  const { env, pluginDataDir, build, log = () => {}, platform = process.platform } = options;
  const resolution = resolvePasswordManager(env);
  const problem = passwordManagerProblemNote(resolution);
  if (problem !== null) {
    log(problem);
  }
  if (!resolution.enabled) {
    return disablePasswordManager({ env, pluginDataDir, log });
  }

  const configProblem = passwordUserConfigProblem(env);
  if (configProblem !== null) {
    delete env[PASSWORD_MANAGER_STATE_VAR];
    log(configProblem);
    return { status: 'blocked-config', note: configProblem, policyFile: null };
  }

  if (platform !== 'win32') {
    return blockedResult({
      env,
      pluginDataDir,
      build,
      status: 'blocked-by-build-policy',
      note:
        'Saved logins: the per-user Firefox policy path could not be resolved on this platform, so the setting is ' +
        'not applied. It was verified on Windows only.',
      policyFile: null,
      log,
    });
  }

  return blockedResult({
    env,
    pluginDataDir,
    build,
    status: 'blocked-by-build-policy',
    note: PASSWORD_MANAGER_WINDOWS_DEAD_PATH_NOTE,
    policyFile: null,
    log,
  });
}

// File existence only. The broker never opens logins.db or key4.db.
export function hasFirefoxLoginStore(profileDir) {
  if (!nonEmptyString(profileDir)) {
    return false;
  }
  return existsSync(path.join(profileDir, 'logins.db'));
}
