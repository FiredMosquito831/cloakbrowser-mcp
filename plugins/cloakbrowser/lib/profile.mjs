// Per-account profile resolution for the CloakBrowser broker.
//
// A profile name selects one persistent browser profile under the plugin data
// directory: profiles/<engine>/<name> for a named account, profiles/default for
// the Chromium engines' legacy default, and profiles/<engine>/default for every
// other engine's own default. `profile_dir` stays the explicit path override and
// wins whenever it is set. The functions here are pure apart from
// readAccountProxy, which is given a file path, so the unit suite can exercise
// every rule without starting a backend.
//
// The account name is joined into a path, so it is validated before any join:
// letters, digits, ".", "_" and "-", starting with a letter or digit, at most 64
// characters, no trailing dot, and no Windows device name. A dot-dot or slash can
// therefore never appear.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ACCOUNT_NAME_MAX = 64;
export const DEFAULT_PROFILE_NAME = 'default';
export const DEFAULT_LAUNCHER = 'launch.mjs';
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

// Resolve the profile for this server start.
//
// Returns:
//   profileDir        absolute directory the broker must set, or null when the
//                     broker sets nothing and the engine/launcher default applies
//   defaultProfileDir the engine's default profile (absolute), always known
//   profileSource     "profile_dir" | "account" | "engine" | "default" | null
//   account           the resolved account name, or null
//   accountApplies    false when the manifest ignores profile_dir (the engine
//                     has its own profile setting; do not add a second control)
//   error             the exact start-up error, or null
export function resolveProfile({
  account,
  profileDir,
  engineId,
  dataDir,
  launcherName = DEFAULT_LAUNCHER,
  ignoredSettings = [],
}) {
  const engineDefault = defaultProfileDir(engineId, dataDir, launcherName);
  const base = {
    profileDir: null,
    defaultProfileDir: engineDefault,
    profileSource: null,
    account: null,
    error: null,
  };
  if (Array.isArray(ignoredSettings) && ignoredSettings.includes('profile_dir')) {
    // The engine owns its profile selection; profile_dir and account are inert.
    return { ...base, profileSource: 'engine', accountApplies: false };
  }
  const explicit = nonEmptyString(profileDir) && !isPlaceholder(profileDir) ? profileDir.trim() : '';
  if (explicit !== '') {
    // The broker does not normalise, resolve or create an explicit path.
    return { ...base, profileDir: explicit, profileSource: 'profile_dir', accountApplies: true };
  }
  const raw = typeof account === 'string' ? account : '';
  const trimmed = raw.trim();
  if (trimmed === '' || isPlaceholder(trimmed)) {
    return { ...base, profileSource: 'default', accountApplies: true };
  }
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
