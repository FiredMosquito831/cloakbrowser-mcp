// Profile resolution and session safety for the CloakBrowser broker.
//
// A profile name selects one persistent browser profile under the plugin data
// directory: profiles/<engine>/<name> for a named account, profiles/default for
// the Chromium engines' legacy default, and profiles/<engine>/default for every
// other engine's own default. `profile_dir` stays the explicit path override and
// wins whenever it is set. profile_isolation=workspace adds one profile per
// project folder (profiles/<engine>/ws-<sha256(cwd)[:7]>) and a numbered-sibling
// fallback; the lock helpers read the bridge's own lock file so the broker can
// refuse a start that would fail. The functions here are explicitly parameterised
// (no path is read from a global setting) and read only the files named by their
// arguments, so the unit suite can exercise every rule without a backend.
//
// The account name is joined into a path, so it is validated before any join:
// letters, digits, ".", "_" and "-", starting with a letter or digit, at most 64
// characters, no trailing dot, and no Windows device name. A dot-dot or slash can
// therefore never appear.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ACCOUNT_NAME_MAX = 64;
export const DEFAULT_PROFILE_NAME = 'default';
export const DEFAULT_LAUNCHER = 'launch.mjs';
// Session safety. "shared" is the historical behaviour: every Claude Code
// session of an account uses one profile directory. "workspace" derives one
// profile per project folder, Playwright-style, and may fall back to a numbered
// sibling when that profile is already in use.
export const PROFILE_ISOLATION_VALUES = Object.freeze(['shared', 'workspace']);
export const DEFAULT_PROFILE_ISOLATION = 'shared';
export const WORKSPACE_PROFILE_PREFIX = 'ws-';
export const WORKSPACE_PROFILE_HASH_LENGTH = 7;
export const PROFILE_FALLBACK_FIRST_SUFFIX = 2;
export const PROFILE_FALLBACK_LAST_SUFFIX = 5;
// The bridge's own exclusive lock file, created beside the user data directory.
// The broker reads the same file (never writes, moves or deletes it) so it can
// refuse to spawn a backend that would exit at start-up.
export const PROFILE_LOCK_FILENAME = '.cloakbrowser-mcp-profile.lock';
export const INVALID_ACCOUNT_PREFIX = 'Invalid account name';
export const INVALID_ACCOUNT_HINT =
  'Use letters, digits, ".", "_" or "-", starting with a letter or digit, up to 64 characters, no trailing dot or space.';
export const ACCOUNT_PROXY_SUFFIX = '.proxy';
// Windows reserves these device names in every directory, any case and with any
// extension ("CON", "con.txt"). Joining one as a directory name would create a
// device path instead of a profile.
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);
// Proxy schemes the engine and the bridge understand. A missing scheme means
// http:// (the bridge's own rule), so a bare host:port stays valid.
const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks5:']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Quote an invalid value for a message without echoing control characters or a
// long paste. The normal case ("../x") is reproduced exactly.
function quotedValue(value) {
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, '?')
    .slice(0, ACCOUNT_NAME_MAX);
  return `"${text}"`;
}

// The full start-up error for an invalid account name. The exact sentence is
// part of the contract: it is what browser_engine_status.lastError reports.
export function accountNameError(value) {
  return `${INVALID_ACCOUNT_PREFIX} ${quotedValue(value)}. ${INVALID_ACCOUNT_HINT}`;
}

// True for a name that is safe to join into profiles/<engine>/<name>.
export function validateAccountName(value) {
  if (!nonEmptyString(value)) {
    return false;
  }
  // The pattern already excludes whitespace and slashes; the remaining rules
  // mirror Windows: no trailing dot (Windows strips it, so "alice." and "alice"
  // would be one directory) and no reserved device name.
  if (!ACCOUNT_NAME_PATTERN.test(value)) {
    return false;
  }
  if (value.endsWith('.')) {
    return false;
  }
  const stem = value.split('.')[0].toUpperCase();
  return !WINDOWS_RESERVED_NAMES.has(stem);
}

// An unsubstituted ${user_config.*} placeholder means the host did not resolve
// the setting; it behaves as unset, exactly like the engine and tool-profile
// settings.
function isPlaceholder(value) {
  return typeof value === 'string' && value.includes('${');
}

// The default profile of an engine, as the launcher will compute it when the
// broker sets nothing. The default launcher (launch.mjs) has always used
// profiles/default; every other launcher uses its own profiles/<engine>/default.
export function defaultProfileDir(engineId, dataDir, launcherName = DEFAULT_LAUNCHER) {
  const base = path.resolve(dataDir);
  return launcherName === DEFAULT_LAUNCHER
    ? path.join(base, 'profiles', DEFAULT_PROFILE_NAME)
    : path.join(base, 'profiles', engineId, DEFAULT_PROFILE_NAME);
}

// The directory a named account uses. The name must already be validated.
export function accountProfileDir(engineId, account, dataDir) {
  return path.join(path.resolve(dataDir), 'profiles', engineId, account);
}

// The profile name a workspace gets: Playwright's own derivation
// (sha256(cwd) truncated to seven hex characters), with a "ws-" prefix so a
// workspace profile can never collide with a named account or with "default".
export function workspaceProfileName(cwd) {
  const value = nonEmptyString(cwd) ? cwd : process.cwd();
  const digest = createHash('sha256').update(value).digest('hex').slice(0, WORKSPACE_PROFILE_HASH_LENGTH);
  return `${WORKSPACE_PROFILE_PREFIX}${digest}`;
}

// The directory a workspace uses: profiles/<engine>/ws-<hash>.
export function workspaceProfileDir(engineId, dataDir, cwd) {
  return path.join(path.resolve(dataDir), 'profiles', engineId, workspaceProfileName(cwd));
}

// Resolve the profile_isolation setting. Unset, empty, an unsubstituted
// ${user_config.*} placeholder and an unknown value all mean "shared", which is
// exactly the behaviour before the setting existed. The extra fields exist so
// the broker can log a value it ignored once at startup.
export function resolveProfileIsolation(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') {
    return { mode: DEFAULT_PROFILE_ISOLATION, source: 'default', ignored: null, placeholder: null };
  }
  if (isPlaceholder(raw)) {
    return { mode: DEFAULT_PROFILE_ISOLATION, source: 'default', ignored: null, placeholder: raw };
  }
  if (PROFILE_ISOLATION_VALUES.includes(raw)) {
    return { mode: raw, source: 'setting', ignored: null, placeholder: null };
  }
  return { mode: DEFAULT_PROFILE_ISOLATION, source: 'default', ignored: raw, placeholder: null };
}

// Resolve the profile for this server start.
//
// Returns:
//   profileDir        absolute directory the broker must set, or null when the
//                     broker sets nothing and the engine/launcher default applies
//   defaultProfileDir the engine's default profile (absolute), always known
//   profileSource     "profile_dir" | "account" | "workspace" | "engine" |
//                     "default" | null
//   account           the resolved account name, or null
//   accountApplies    false when the manifest ignores profile_dir (the engine
//                     has its own profile setting; do not add a second control)
//   error             the exact start-up error, or null
//
// Precedence: profile_dir, then account, then the workspace profile when
// profile_isolation is "workspace", then the engine default.
export function resolveProfile({
  account,
  profileDir,
  engineId,
  dataDir,
  launcherName = DEFAULT_LAUNCHER,
  ignoredSettings = [],
  profileApplies = true,
  isolation = DEFAULT_PROFILE_ISOLATION,
  cwd = process.cwd(),
}) {
  const engineDefault = defaultProfileDir(engineId, dataDir, launcherName);
  const base = {
    profileDir: null,
    defaultProfileDir: engineDefault,
    profileSource: null,
    account: null,
    error: null,
  };
  if (
    profileApplies === false ||
    (Array.isArray(ignoredSettings) && ignoredSettings.includes('profile_dir'))
  ) {
    // The engine owns its profile selection; profile_dir, account and
    // profile_isolation are inert.
    return { ...base, profileSource: 'engine', accountApplies: false };
  }
  const explicit = nonEmptyString(profileDir) && !isPlaceholder(profileDir) ? profileDir.trim() : '';
  if (explicit !== '') {
    // The broker does not normalise, resolve or create an explicit path.
    return { ...base, profileDir: explicit, profileSource: 'profile_dir', accountApplies: true };
  }
  const raw = typeof account === 'string' ? account : '';
  const trimmed = raw.trim();
  if (trimmed !== '' && !isPlaceholder(trimmed)) {
    if (!validateAccountName(trimmed)) {
      return { ...base, accountApplies: true, error: accountNameError(trimmed) };
    }
    const resolved =
      trimmed === DEFAULT_PROFILE_NAME ? engineDefault : accountProfileDir(engineId, trimmed, dataDir);
    return {
      ...base,
      profileDir: resolved,
      profileSource: 'account',
      account: trimmed,
      accountApplies: true,
    };
  }
  if (isolation === 'workspace') {
    return {
      ...base,
      profileDir: workspaceProfileDir(engineId, dataDir, cwd),
      profileSource: 'workspace',
      accountApplies: true,
    };
  }
  return { ...base, profileSource: 'default', accountApplies: true };
}

// The directory the backend will actually use this start, or null when the
// engine owns its profile (attach/native engines) or no resolution is known.
// This is what the lock preflight reads: an explicit/account/workspace path, or
// the engine default the launcher applies when the broker sets nothing.
export function effectiveProfileDir(resolution) {
  if (resolution === null || typeof resolution !== 'object') {
    return null;
  }
  if (nonEmptyString(resolution.profileDir)) {
    return resolution.profileDir;
  }
  if (resolution.profileSource === 'default' && nonEmptyString(resolution.defaultProfileDir)) {
    return resolution.defaultProfileDir;
  }
  return null;
}

// The bridge's lock file for a profile directory.
export function profileLockPath(profileDir) {
  return path.join(path.resolve(profileDir), PROFILE_LOCK_FILENAME);
}

// Liveness: process.kill(pid, 0) answers whether a process exists. ESRCH means
// gone (the bridge reclaims such a lock); EPERM means it exists under another
// account; any other failure is treated as "cannot prove it is gone", so the
// safer choice is to report it as live rather than start a doomed backend.
function processLiveness(pid) {
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return 'dead';
    }
    return 'live';
  }
}

function invalidLock(base, error) {
  return { ...base, state: 'invalid', owner: null, error };
}

// Read the bridge's lock file without creating, moving or deleting anything.
//
// Returns { profileDir, path, state, owner, error } where state is:
//   free     no lock file (or the directory does not exist)
//   live     a valid lock naming a process that exists
//   stale    a valid lock naming a process that is gone; the bridge reclaims it
//   invalid  the file exists but cannot be read or does not name a process
// owner is { pid, createdAt } for live/stale locks, null otherwise.
export function readProfileLock(profileDir) {
  const resolved = path.resolve(typeof profileDir === 'string' ? profileDir : '');
  const lockPath = path.join(resolved, PROFILE_LOCK_FILENAME);
  const base = { profileDir: resolved, path: lockPath, state: 'free', owner: null, error: null };
  let bytes;
  try {
    if (!statSync(lockPath).isFile()) {
      return invalidLock(base, `The profile lock ${lockPath} is not a regular file.`);
    }
    bytes = readFileSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return base;
    }
    return invalidLock(base, `Cannot read the profile lock ${lockPath}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return invalidLock(base, `The profile lock ${lockPath} is not valid JSON.`);
  }
  if (!isPlainObject(parsed)) {
    return invalidLock(base, `The profile lock ${lockPath} is not a JSON object.`);
  }
  const pid = parsed.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return invalidLock(base, `The profile lock ${lockPath} does not name a process id.`);
  }
  const createdAt =
    typeof parsed.createdAt === 'string' && parsed.createdAt.trim() !== ''
      ? parsed.createdAt.trim().slice(0, 64)
      : null;
  const owner = { pid, createdAt };
  return { ...base, state: processLiveness(pid) === 'live' ? 'live' : 'stale', owner, error: null };
}

// True when a lock result must stop the backend: a live owner, or a file the
// bridge itself cannot reclaim. A stale lock is not blocking.
export function lockBlocksStart(lock) {
  return lock !== null && typeof lock === 'object' && (lock.state === 'live' || lock.state === 'invalid');
}

// A plain-language, actionable fix for a blocking lock. It names settings the
// user can change and never suggests deleting a profile directory.
export function profileLockFix(lock) {
  if (lock === null || typeof lock !== 'object') {
    return null;
  }
  if (lock.state === 'live') {
    const owner = lock.owner ?? {};
    const who = owner.pid === undefined || owner.pid === null ? 'the other process' : `pid ${owner.pid}`;
    const when = typeof owner.createdAt === 'string' ? `, started ${owner.createdAt}` : '';
    return (
      `Close the Claude Code session or browser window that owns this profile (${who}${when}); ` +
      'if that process is gone, the lock is reclaimed automatically. You can also set ' +
      '"Profile directory" (profile_dir) to another folder, or set "Profile isolation" ' +
      '(profile_isolation) to workspace so each project folder gets its own profile. ' +
      'Restart Claude Code after the change.'
    );
  }
  if (lock.state === 'invalid') {
    return (
      `If no browser is running, delete the lock file ${lock.path}; otherwise close the browser ` +
      'that owns this profile. Then restart Claude Code.'
    );
  }
  return null;
}

// The start-up sentence for a blocking lock. The broker does not spawn a
// backend in this state; this text is what initialize.instructions,
// browser_capabilities.engineError and browser_engine_status.lastError carry.
export function profileLockMessage(lock, { fallbackExhausted = false } = {}) {
  if (lock === null || typeof lock !== 'object') {
    return 'The browser profile is locked by another process.';
  }
  let head;
  if (lock.state === 'live') {
    const owner = lock.owner ?? {};
    const who = owner.pid === undefined || owner.pid === null ? '' : ` by pid ${owner.pid}`;
    const when = typeof owner.createdAt === 'string' ? `, started ${owner.createdAt}` : '';
    head = `The browser profile ${lock.profileDir} is already in use${who}${when}.`;
  } else if (lock.state === 'invalid') {
    head = `The browser profile ${lock.profileDir} has a lock file that cannot be read (${lock.path}).`;
  } else {
    head = `The browser profile ${lock.profileDir} is locked.`;
  }
  const fix = profileLockFix(lock);
  const exhausted = fallbackExhausted
    ? ` The numbered workspace fallbacks (suffixes ${PROFILE_FALLBACK_FIRST_SUFFIX} to ${PROFILE_FALLBACK_LAST_SUFFIX}) are also in use.`
    : '';
  return `${head}${fix === null ? '' : ` ${fix}`}${exhausted} The backend was not started.`;
}

// The sentence reported when a workspace profile was busy and a numbered sibling
// was chosen instead. The fallback has a different cookie jar, login state and
// fingerprint seed, so it is always named, never silent.
export function profileFallbackReason(lock, toDir) {
  const from = lock !== null && typeof lock === 'object' ? lock.profileDir : 'the workspace profile';
  const owner = lock?.owner ?? {};
  const who =
    owner.pid === undefined || owner.pid === null
      ? 'another process'
      : `pid ${owner.pid}${typeof owner.createdAt === 'string' ? `, started ${owner.createdAt}` : ''}`;
  return (
    `The workspace profile ${from} was already in use (${who}), so this session uses ${toDir} instead. ` +
    'It has separate cookies, logins and fingerprint seed.'
  );
}

// Pick the first numbered sibling (ws-<hash>-2, then -3 ... -5) whose lock does
// not block a start. isBlocked(candidateDir) is supplied by the caller so the
// rule stays pure and testable. Returns null when every sibling is in use.
export function selectFallbackProfile(baseDir, isBlocked) {
  if (!nonEmptyString(baseDir) || typeof isBlocked !== 'function') {
    return null;
  }
  const base = baseDir.trim().replace(/[\\/]+$/u, '');
  for (let suffix = PROFILE_FALLBACK_FIRST_SUFFIX; suffix <= PROFILE_FALLBACK_LAST_SUFFIX; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!isBlocked(candidate)) {
      return candidate;
    }
  }
  return null;
}

// The optional proxy file that sits beside a profile directory:
// profiles/cloak/alice.proxy beside profiles/cloak/alice/.
export function accountProxyPath(profileDir) {
  const resolved = path.resolve(profileDir);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}${ACCOUNT_PROXY_SUFFIX}`);
}

function invalidProxyUrl(file) {
  return (
    `The account proxy file ${file} does not contain a valid proxy URL. ` +
    'Use one line such as http://user:pass@host:port with an http, https, socks, socks4 or ' +
    'socks5 scheme (a missing scheme means http://).'
  );
}

// The bridge accepts a bare host:port by prefixing http://; apply the same rule
// before parsing, then keep only proxy schemes. The value is returned exactly as
// the user wrote it (trimmed), never rewritten.
export function parseProxyUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') {
    return { value: null, error: null };
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { value: null, error: 'unparsable' };
  }
  if (!PROXY_SCHEMES.has(parsed.protocol.toLowerCase()) || parsed.hostname === '') {
    return { value: null, error: 'unsupported-scheme' };
  }
  return { value: raw, error: null };
}

// Read the optional <name>.proxy file.
//
// Missing file or a whitespace-only file: no proxy (null), no error. A file that
// cannot be read, is not valid UTF-8, holds more than one non-empty line, or does
// not parse as a proxy URL is an error: the caller fails the start-up instead of
// silently opening a direct connection. The file's contents never appear in an
// error message (it is a credential).
export function readAccountProxy(file) {
  let bytes;
  try {
    if (!statSync(file).isFile()) {
      return { value: null, error: `The account proxy file ${file} is not a regular file.`, exists: true };
    }
    bytes = readFileSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { value: null, error: null, exists: false };
    }
    return {
      value: null,
      error: `Cannot read the account proxy file ${file}: ${error.message}`,
      exists: true,
    };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { value: null, error: `The account proxy file ${file} is not valid UTF-8.`, exists: true };
  }
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) {
    return { value: null, error: null, exists: true };
  }
  if (lines.length > 1) {
    return {
      value: null,
      error: `The account proxy file ${file} must contain exactly one non-empty line.`,
      exists: true,
    };
  }
  const parsed = parseProxyUrl(lines[0]);
  if (parsed.error !== null) {
    return { value: null, error: invalidProxyUrl(file), exists: true };
  }
  return { value: parsed.value, error: null, exists: true };
}

// Hide the credentials of any URL that carries user information. The bridge
// strips a credentialed proxy from the child environment it builds; the broker
// must not reintroduce it through a relayed stderr line or a status payload.
// Ordinary URLs and timestamps do not match. A literal "@" inside a password
// must be percent-encoded, or redaction stops at the first one.
export function redactSecrets(text) {
  if (typeof text !== 'string') {
    return text;
  }
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([A-Za-z0-9._~%!$&'()*+,;=:-]+)@/giu, '$1***@');
}

// The child environment for the selected engine. With no account resolved and no
// file proxy this is exactly process.env plus the engine id, which is what the
// broker has always passed. Values are never derived from the account setting
// unless resolveProfile returned a directory.
export function backendEnvironment(baseEnv, { engineId, profileDir = null, proxyServer = null } = {}) {
  const env = { ...(isPlainObject(baseEnv) ? baseEnv : {}), PLAYWRIGHT_MCP_BROWSER_ENGINE: engineId };
  if (nonEmptyString(profileDir)) {
    env.PLAYWRIGHT_MCP_USER_DATA_DIR = profileDir;
  }
  if (nonEmptyString(proxyServer)) {
    env.PLAYWRIGHT_MCP_PROXY_SERVER = proxyServer;
  }
  return env;
}
