// Profile resolution and session safety for the CloakBrowser broker.
//
// A profile name selects one persistent browser profile under the plugin data
// directory: profiles/<engine>/<name> for a named account, profiles/default for
// the Chromium engines' legacy default, and profiles/<engine>/default for every
// other engine's own default. `profile_dir` stays the explicit path override and
// wins whenever it is set. profile_isolation=workspace adds one profile per
// project folder (profiles/<engine>/ws-<sha256(cwd)[:7]>) and a numbered-sibling
// fallback; profile_isolation=isolated uses no profile at all, so nothing is
// resolved, created or locked and nothing persists after the session.
// profile_isolation=copy resolves the base profile exactly like "shared", takes
// the base's bridge-format lock for the session, and launches the engine on a
// whole-tree copy under profiles/<engine>/.sessions; the copy is discarded on a
// clean shutdown, and a crashed broker leaves it for browser_profiles and the
// explicit prune command. profile_isolation=copy-keep does everything copy does
// and then swaps the whole tree back on a clean shutdown: the base is renamed to
// <base>.previous-<stamp> (retained as user data, never pruned automatically) and
// the session copy takes its place; a hard kill performs no swap. The lock
// helpers read (and, for the copy modes only, write)
// the bridge's own lock file so the broker can refuse a start that would fail. A one-line default-profile pointer (profiles/<engine>/.default)
// names the profile a start uses when neither profile_dir nor account is set.
// on_locked (2.16.0) decides what happens when the resolved profile is already
// held: block (the 2.15 behaviour), fallback to the first free numbered sibling
// (-2 ... -5) of a plugin-managed profile, or an isolated start with no profile.
// The functions here are explicitly parameterised (no path is read from a global
// setting) and read only the files named by their arguments, so the unit suite
// can exercise every rule without a backend.
//
// The account name is joined into a path, so it is validated before any join:
// letters, digits, ".", "_" and "-", starting with a letter or digit, at most 64
// characters, no trailing dot, and no Windows device name. A dot-dot or slash can
// therefore never appear. The default-profile pointer is validated with the same
// rule before it is joined or applied.
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ACCOUNT_NAME_MAX = 64;
export const DEFAULT_PROFILE_NAME = 'default';
export const DEFAULT_LAUNCHER = 'launch.mjs';
// Session safety. "shared" is the historical behaviour: every Claude Code
// session of an account uses one profile directory. "workspace" derives one
// profile per project folder, Playwright-style, and may fall back to a numbered
// sibling when that profile is already in use. "isolated" uses no profile at
// all: nothing is resolved, created or locked, and nothing persists after the
// session (the engines' own isolated mode, which keeps the browser profile
// ephemeral; it is deliberately not described as "in memory"). "copy" launches
// the browser on a temporary whole-tree copy of the profile the ordinary
// precedence resolves, holds the base profile's lock for the session so another
// shared/workspace start cannot use it, and discards the copy on a clean
// shutdown; the base profile is never written. "copy-keep" behaves exactly like
// "copy" and additionally swaps the whole tree on a clean close: the base is
// renamed to <base>.previous-<stamp> (retained) and the session copy takes the
// base path, so the session's changes are kept. A hard kill never swaps. In this
// version both copy modes resolve whatever profile_dir/account/the
// pointer/engine default resolves and do not combine with "workspace".
export const PROFILE_ISOLATION_VALUES = Object.freeze([
  'shared',
  'workspace',
  'isolated',
  'copy',
  'copy-keep',
]);
export const DEFAULT_PROFILE_ISOLATION = 'shared';
export const PROFILE_ISOLATION_ISOLATED = 'isolated';
export const PROFILE_ISOLATION_COPY = 'copy';
export const PROFILE_ISOLATION_COPY_KEEP = 'copy-keep';
// The two modes that run on a session copy. They share the base resolution, the
// preflights, the base lock, the copy plan and the session directory; they differ
// only in what a clean shutdown does with the copy.
export const PROFILE_ISOLATION_COPY_VALUES = Object.freeze([
  PROFILE_ISOLATION_COPY,
  PROFILE_ISOLATION_COPY_KEEP,
]);
export function isCopyIsolation(value) {
  return PROFILE_ISOLATION_COPY_VALUES.includes(value);
}
// on_locked (2.16.0): what a start does when the profile it resolved is already
// held by another process. "block" is the behaviour before this setting existed:
// no backend is spawned and the meta-tools name the owner and the fix.
// "fallback" starts on the first free numbered sibling of the same profile
// (-2 ... -5), so the session works but with separate cookies, logins and
// fingerprint seed. "isolated" starts with no profile at all: nothing is created,
// locked or saved. Only profiles the plugin manages get siblings; an explicit
// profile_dir always keeps the "block" behaviour.
export const ON_LOCKED_VALUES = Object.freeze(['block', 'fallback', 'isolated']);
export const ON_LOCKED_BLOCK = 'block';
export const ON_LOCKED_FALLBACK = 'fallback';
export const ON_LOCKED_ISOLATED = 'isolated';
export const DEFAULT_ON_LOCKED = ON_LOCKED_FALLBACK;
// The profile settings that an isolated start reports as ignored. The names are
// the settings a user can see and change; `value` carries what was supplied so
// the report never claims a setting was ignored when it was empty.
export const ISOLATED_IGNORED_PROFILE_DIR = 'profile_dir';
export const ISOLATED_IGNORED_ACCOUNT = 'account';
export const ISOLATED_IGNORED_POINTER = 'default_profile_pointer';
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
// The one-line default-profile pointer that sits beside the engine's account
// directories. It is a file, never a directory, so it can never be mistaken for
// a profile of its own.
export const PROFILE_DEFAULT_POINTER_FILENAME = '.default';
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

// --- default-profile pointer ----------------------------------------------
// One line beside the engine's account profiles names the profile a start uses
// when neither `profile_dir` nor `account` is set. The file is read at start and
// never created there: a missing pointer is the normal "no default configured"
// state, and a broken one is reported and ignored rather than made fatal.

// The pointer file for one engine: <plugin data>/profiles/<engine>/.default.
export function profileDefaultPointerPath(engineId, dataDir) {
  return path.join(path.resolve(dataDir), 'profiles', engineId, PROFILE_DEFAULT_POINTER_FILENAME);
}

// The profile directory a pointer name maps to: "default" is the engine default
// the launcher would use anyway; any other valid name is an account-like profile
// directory under profiles/<engine>/. Returns null for an invalid name.
export function profileDefaultPointerDir(engineId, dataDir, name, launcherName = DEFAULT_LAUNCHER) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!validateAccountName(trimmed)) {
    return null;
  }
  return trimmed === DEFAULT_PROFILE_NAME
    ? defaultProfileDir(engineId, dataDir, launcherName)
    : accountProfileDir(engineId, trimmed, dataDir);
}

function invalidPointer(pointerPath, error) {
  return { path: pointerPath, exists: true, name: null, state: 'invalid', error };
}

// Read the default-profile pointer without creating, moving or deleting
// anything. Returns { path, exists, name, state, error } where state is:
//   missing  no pointer file; nothing to apply
//   present  exactly one valid profile name; `name` holds it
//   invalid  the file exists but cannot be used; `error` explains why and how to
//            fix it, and the caller ignores the pointer for this start
// A missing file is not an error. A file that is not a regular file, cannot be
// read, is not valid UTF-8, holds no name, holds more than one line, or holds a
// name the account rule rejects is invalid.
export function readProfileDefaultPointer(engineId, dataDir) {
  const pointerPath = profileDefaultPointerPath(engineId, dataDir);
  const base = { path: pointerPath, exists: false, name: null, state: 'missing', error: null };
  let bytes;
  try {
    if (!statSync(pointerPath).isFile()) {
      return invalidPointer(
        pointerPath,
        `The default profile pointer ${pointerPath} is not a regular file; it is ignored.`,
      );
    }
    bytes = readFileSync(pointerPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return base;
    }
    return invalidPointer(
      pointerPath,
      `Cannot read the default profile pointer ${pointerPath}: ${error.message}. It is ignored.`,
    );
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalidPointer(
      pointerPath,
      `The default profile pointer ${pointerPath} is not valid UTF-8; it is ignored.`,
    );
  }
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) {
    return invalidPointer(pointerPath, `The default profile pointer ${pointerPath} is empty; it is ignored.`);
  }
  if (lines.length > 1) {
    return invalidPointer(
      pointerPath,
      `The default profile pointer ${pointerPath} must contain exactly one profile name; it is ignored.`,
    );
  }
  if (!validateAccountName(lines[0])) {
    return invalidPointer(
      pointerPath,
      `The default profile pointer ${pointerPath} does not name a valid profile ` +
        `(${quotedValue(lines[0])}). ${INVALID_ACCOUNT_HINT} It is ignored.`,
    );
  }
  return { path: pointerPath, exists: true, name: lines[0], state: 'present', error: null };
}

// Write the default-profile pointer atomically: one line to a sibling temporary
// file, then a rename over the pointer. A failed write removes only its own
// temporary file and leaves any existing pointer in place. Returns
// { path, written, error }: error is null on success.
export function writeProfileDefaultPointer(engineId, dataDir, name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const pointerPath = profileDefaultPointerPath(engineId, dataDir);
  if (!validateAccountName(trimmed)) {
    return { path: pointerPath, written: false, error: accountNameError(name) };
  }
  const directory = path.dirname(pointerPath);
  const temporary = path.join(directory, `${PROFILE_DEFAULT_POINTER_FILENAME}.${process.pid}.tmp`);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, `${trimmed}\n`, 'utf8');
    renameSync(temporary, pointerPath);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The temporary file is beside the pointer; leaving it behind changes no
      // behaviour and the next write replaces it.
    }
    return {
      path: pointerPath,
      written: false,
      error: `Cannot write the default profile pointer ${pointerPath}: ${error.message}`,
    };
  }
  return { path: pointerPath, written: true, error: null };
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

// Resolve the on_locked setting (2.16.0). Unset, empty, an unsubstituted
// ${user_config.*} placeholder and an unknown value all mean "fallback"; the
// extra fields let the broker log a value it ignored once at startup. The
// placeholder is reported separately because it is a missing substitution, not a
// setting the user typed.
export function resolveOnLocked(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') {
    return { mode: DEFAULT_ON_LOCKED, source: 'default', ignored: null, placeholder: null };
  }
  if (isPlaceholder(raw)) {
    return { mode: DEFAULT_ON_LOCKED, source: 'default', ignored: null, placeholder: raw };
  }
  if (ON_LOCKED_VALUES.includes(raw)) {
    return { mode: raw, source: 'setting', ignored: null, placeholder: null };
  }
  return { mode: DEFAULT_ON_LOCKED, source: 'default', ignored: raw, placeholder: null };
}

// --- isolated starts ---------------------------------------------------------
// profile_isolation=isolated uses no profile at all. These strings are the one
// honest wording every surface shares, so the mode never claims "in memory" and
// never hides what it ignored.
export const PROFILE_ISOLATED_REASON =
  'profile_isolation is "isolated": this start uses no profile, so the setting has no effect.';
export const PROFILE_ISOLATED_NOTE =
  'Profile isolation is "isolated": this session uses no browser profile, so no cookies, logins or other browser state are saved and nothing persists after it closes.';
export const PROFILE_ISOLATED_POINTER_NOTE =
  'This server started with profile_isolation "isolated": it uses no profile, so the default-profile pointer and ' +
  'set-default do not affect this session; a pointer set now applies at the next server start once ' +
  'profile_isolation is "shared" or "workspace".';
export const PROFILE_ISOLATED_NATIVE_NOTE =
  'This engine manages its own browser profile, so the "Profile isolation" setting (including "isolated") has no ' +
  'effect on it.';
// on_locked=isolated switched an ordinary start to an isolated one (2.16.0). The
// configured profile_isolation is unchanged, so this note never claims the
// setting is "isolated"; it says why this start has no profile.
export const PROFILE_ON_LOCKED_ISOLATED_NOTE =
  'This session started with no profile because on_locked is "isolated" and the resolved profile was in use: ' +
  'the default-profile pointer and set-default do not affect it, and nothing is saved when it closes.';

// --- copy starts -------------------------------------------------------------
// profile_isolation=copy runs the session on a temporary whole-tree copy of the
// base profile and never writes to the base. The sentence is one honest
// statement shared by initialize.instructions and every meta-tool: what runs,
// where, and what happens to the changes.
export function profileCopyNote(baseDir, sessionDir) {
  const base = nonEmptyString(baseDir) ? baseDir : 'the selected profile';
  const session = nonEmptyString(sessionDir) ? sessionDir : 'a temporary copy';
  return (
    `Profile isolation is "copy": this session runs on a temporary copy of ${base} at ${session}, ` +
    'the base profile is locked and never written, and the copy is discarded when the session ends cleanly.'
  );
}

// profile_isolation=copy-keep runs on the same temporary copy and then keeps the
// changes: on a clean close the base is renamed to <base>.previous-<stamp> and
// the session copy takes its place. The one sentence says exactly that, and a
// hard kill keeps both the base and the session tree untouched.
export function profileCopyKeepNote(baseDir, sessionDir) {
  const base = nonEmptyString(baseDir) ? baseDir : 'the selected profile';
  const session = nonEmptyString(sessionDir) ? sessionDir : 'a temporary copy';
  return (
    `Profile isolation is "copy-keep": this session runs on a temporary copy of ${base} at ${session}, ` +
    'and changes are kept: the base is replaced on a clean close and the previous tree is retained beside it.'
  );
}

// The one sentence every surface shares when the active engine owns its own
// profile and neither copy mode applies. For "copy" this is byte-identical to the
// sentence it replaced.
export function profileCopyNotApplicableNote(mode) {
  return (
    'This engine manages its own browser profile, so profile_isolation ' +
    `"${nonEmptyString(mode) ? mode : PROFILE_ISOLATION_COPY}" does not apply to it.`
  );
}

// Session copies of one engine live beside its account profiles, in a
// dot-directory the profile inventory deliberately skips: a session copy is a
// working directory, never a profile a user can select.
export const SESSION_ROOT_DIRNAME = '.sessions';
// The broker writes this marker inside each session copy before the engine
// starts, so an explicit prune can never remove a copy whose broker is still
// copying or starting the backend (the bridge lock appears only once the
// backend runs). It is not part of the profile and is removed with the tree.
export const SESSION_OWNER_FILENAME = '.session-owner.json';
// <baseName>-<YYYYMMDD-HHMMSS>-<pid>. The stamp is local time; the pid is the
// broker that created the copy, so a leftover copy can be attributed and a
// live one proven before pruning.
const SESSION_COPY_NAME_PATTERN = /^(.+)-(\d{8}-\d{6})-(\d+)$/u;

// The directory basename a session copy is named after. Account names are
// already safe; an explicit profile_dir can be any folder name, so characters
// that are not portable in a directory name collapse to "-", leading and
// trailing dots are removed (Windows strips them), and the result is bounded.
export function sessionBaseName(baseDir) {
  const raw = path.basename(path.resolve(typeof baseDir === 'string' ? baseDir : ''));
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^[.\-]+/u, '')
    .replace(/[.\-]+$/u, '')
    .slice(0, ACCOUNT_NAME_MAX);
  return cleaned === '' ? 'profile' : cleaned;
}

function localStamp(now) {
  const date = now instanceof Date ? now : new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function sessionCopyName(baseDir, { pid = process.pid, now = new Date() } = {}) {
  return `${sessionBaseName(baseDir)}-${localStamp(now)}-${pid}`;
}

export function sessionRootDir(engineId, dataDir) {
  return path.join(path.resolve(dataDir), 'profiles', engineId, SESSION_ROOT_DIRNAME);
}

export function sessionCopyDir(engineId, dataDir, baseDir, { pid = process.pid, now = new Date() } = {}) {
  return path.join(sessionRootDir(engineId, dataDir), sessionCopyName(baseDir, { pid, now }));
}

// True for a YYYYMMDD-HHMMSS stamp whose date and time fields are in range. The
// stamp is local time and is only ever produced by localStamp(); this check keeps
// a directory name the plugin did not create from being listed, locked or pruned.
function validLocalStamp(stamp) {
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  const hour = Number(stamp.slice(9, 11));
  const minute = Number(stamp.slice(11, 13));
  const second = Number(stamp.slice(13, 15));
  return !(month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59);
}

// Parse a session-copy directory name. Returns
// { name, baseName, startedAtLocal, pid } or null for anything else, so a
// directory the plugin did not create is never listed, locked or pruned.
export function parseSessionCopyName(name) {
  if (typeof name !== 'string') {
    return null;
  }
  const match = SESSION_COPY_NAME_PATTERN.exec(name);
  if (match === null) {
    return null;
  }
  const pid = Number(match[3]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  const stamp = match[2];
  if (!validLocalStamp(stamp)) {
    return null;
  }
  return { name, baseName: match[1], startedAtLocal: stamp, pid };
}

// The broker's own marker inside a session copy: { pid, createdAt, baseDir }.
// Missing, unreadable or malformed markers are ignored (the locks below remain
// the proof); a valid marker naming a live process marks the copy active even
// before the engine has written its own locks.
export function readSessionOwner(copyDir) {
  const file = path.join(path.resolve(typeof copyDir === 'string' ? copyDir : ''), SESSION_OWNER_FILENAME);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }
  const pid = parsed.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  return {
    pid,
    createdAt:
      typeof parsed.createdAt === 'string' && parsed.createdAt.trim() !== ''
        ? parsed.createdAt.trim().slice(0, 64)
        : null,
  };
}

// List the session copies of one engine without creating, moving or deleting
// anything. A copy is:
//   current   the copy this broker started (currentDir), never prunable here
//   active    a live process still owns it: the broker's session-owner marker,
//             its bridge lock or the engine's own lock proves a live holder (an
//             orphaned browser after a broker crash)
//   leftover  no live holder; safe for the explicit prune command to remove
// The engine lock descriptor is the manifest's profileLock (Chromium lockfile,
// Firefox parent.lock), or null for an engine that declares none.
export function listSessionCopies(
  engineId,
  dataDir,
  { engineLockDescriptor = null, currentDir = null } = {},
) {
  const root = sessionRootDir(engineId, dataDir);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { root, copies: [] };
    }
    return {
      root,
      copies: [],
      error: `Cannot read the session copy directory ${root}: ${error.message}`,
    };
  }
  const resolvedCurrent = nonEmptyString(currentDir) ? path.resolve(currentDir) : null;
  const copies = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const parsed = parseSessionCopyName(entry.name);
    if (parsed === null) {
      continue;
    }
    const copyDir = path.join(root, entry.name);
    const bridgeLock = readProfileLock(copyDir);
    const engineLock =
      engineLockDescriptor === null ? null : readEngineProfileLock(copyDir, engineLockDescriptor);
    const engineLive = engineLock !== null && engineLock.state === 'live';
    const owner = readSessionOwner(copyDir);
    const ownerLive = owner !== null && processLiveness(owner.pid) === 'live';
    const state =
      resolvedCurrent !== null && path.resolve(copyDir) === resolvedCurrent
        ? 'current'
        : ownerLive || bridgeLock.state === 'live' || engineLive
          ? 'active'
          : 'leftover';
    copies.push({
      name: parsed.name,
      path: copyDir,
      baseName: parsed.baseName,
      startedAtLocal: parsed.startedAtLocal,
      pid: parsed.pid,
      state,
      owner,
      bridgeLock: { state: bridgeLock.state, owner: bridgeLock.owner },
      engineLock:
        engineLock === null
          ? null
          : { state: engineLock.state, file: engineLock.file, owner: engineLock.owner },
    });
  }
  copies.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { root, copies };
}

// Remove the leftover session copies of one engine. Explicit only: the broker
// never calls this. `current` and `active` copies are kept and reported, and a
// deletion failure is reported rather than retried or forced. Returns
// { root, removed, kept, failed, copies }.
export function pruneSessionCopies(
  engineId,
  dataDir,
  { engineLockDescriptor = null, currentDir = null, dryRun = false } = {},
) {
  const listed = listSessionCopies(engineId, dataDir, { engineLockDescriptor, currentDir });
  const removed = [];
  const kept = [];
  const failed = [];
  for (const copy of listed.copies) {
    if (copy.state !== 'leftover') {
      kept.push(copy);
      continue;
    }
    if (dryRun) {
      removed.push(copy);
      continue;
    }
    try {
      rmSync(copy.path, { recursive: true, force: true });
      removed.push(copy);
    } catch (error) {
      failed.push({ ...copy, error: `Cannot remove ${copy.path}: ${error.message}` });
    }
  }
  return {
    root: listed.root,
    ...(listed.error === undefined ? {} : { error: listed.error }),
    copies: listed.copies,
    removed,
    kept,
    failed,
  };
}

// --- keeping a session copy (copy-keep) --------------------------------------
// A copy-keep session ends by swapping whole trees: the base is renamed to a
// retained sibling named <base>.previous-<YYYYMMDD-HHMMSS> and the session copy
// takes the base path. Previous trees are user data: they are listed (bounded)
// and never removed by the plugin or by an explicit --prune, which only ever
// touches .sessions. A hard kill performs no swap at all.

// The separator and the sibling name a kept base moves to. A collision in the
// same second gets a numbered suffix, so a second swap can never overwrite the
// first retained tree.
export const PREVIOUS_TREE_INFIX = '.previous-';
export const PREVIOUS_TREE_LIST_LIMIT = 10;
const PREVIOUS_TREE_PATTERN = /^(.+)\.previous-(\d{8}-\d{6})(?:-(\d+))?$/u;
// How long a clean close waits for the session copy's own locks to disappear
// before it gives up and keeps everything. Never forced.
export const COPY_KEEP_LOCK_WAIT_MS = 5000;
export const COPY_KEEP_LOCK_POLL_MS = 100;
export const SWAP_RECORD_FILENAME = '.last-swap.json';

// <baseName>.previous-<YYYYMMDD-HHMMSS>, or with a 1-based numbered suffix after
// a same-second collision. The stamp is local time, like the session copies.
export function previousTreeName(baseDir, { now = new Date(), suffix = 0 } = {}) {
  const stem = `${sessionBaseName(baseDir)}${PREVIOUS_TREE_INFIX}${localStamp(now)}`;
  return suffix > 0 ? `${stem}-${suffix + 1}` : stem;
}

// The retained sibling of a base profile: the base's parent directory keeps its
// name, so the rename is always inside one directory and never across volumes.
export function previousTreeDir(baseDir, options = {}) {
  return path.join(path.dirname(path.resolve(baseDir)), previousTreeName(baseDir, options));
}

// The first free previous-tree name for this base. `exists` is injectable for
// tests; it must answer false for a path that does not exist.
export function selectPreviousTreeDir(baseDir, { now = new Date(), exists = existsSync } = {}) {
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = previousTreeDir(baseDir, { now, suffix });
    if (!exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Parse a retained previous-tree name. Returns
// { name, baseName, timestamp, suffix } or null for anything else.
export function parsePreviousTreeName(name) {
  if (typeof name !== 'string') {
    return null;
  }
  const match = PREVIOUS_TREE_PATTERN.exec(name);
  if (match === null) {
    return null;
  }
  const timestamp = match[2];
  if (!validLocalStamp(timestamp)) {
    return null;
  }
  const suffix = match[3] === undefined ? 0 : Number(match[3]);
  // 0 is the un-suffixed name; a collision suffix starts at 2, so "-1" is a
  // name this plugin never writes.
  if (!Number.isSafeInteger(suffix) || suffix < 0 || suffix === 1) {
    return null;
  }
  return { name, baseName: match[1], timestamp, suffix };
}

// The retained previous trees that sit beside one base profile, newest first and
// bounded so a long history cannot bloat a payload. Read-only: nothing is
// created, moved or deleted. Returns
// { root, baseName, trees, count, truncated, error? }; `count` is untruncated.
export function listPreviousTrees(baseDir, { limit = PREVIOUS_TREE_LIST_LIMIT } = {}) {
  const resolved = path.resolve(typeof baseDir === 'string' ? baseDir : '');
  const root = path.dirname(resolved);
  const baseName = sessionBaseName(resolved);
  const bounded = Number.isSafeInteger(limit) && limit > 0 ? limit : PREVIOUS_TREE_LIST_LIMIT;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    const empty = { root, baseName, trees: [], count: 0, truncated: false };
    return error?.code === 'ENOENT'
      ? empty
      : {
          ...empty,
          error: `Cannot read the profile directory ${root}: ${error.message}`,
        };
  }
  const trees = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const parsed = parsePreviousTreeName(entry.name);
    if (parsed === null || parsed.baseName !== baseName) {
      continue;
    }
    trees.push({
      name: parsed.name,
      path: path.join(root, entry.name),
      timestamp: parsed.timestamp,
      suffix: parsed.suffix,
    });
  }
  // Newest first: the stamp sorts lexicographically, then the collision suffix.
  trees.sort((left, right) => (left.name === right.name ? 0 : left.name < right.name ? 1 : -1));
  return {
    root,
    baseName,
    trees: trees.slice(0, bounded),
    count: trees.length,
    truncated: trees.length > bounded,
  };
}

// True when a session copy's own locks still prove a live holder: the backend's
// bridge-format lock or the engine's own lock (Chromium lockfile, Firefox
// parent.lock). A stale lock, a missing file and an unreadable one are all free
// for the swap; only a proven live owner waits.
export function sessionCopyHasLiveLock(sessionDir, { engineLockDescriptor = null } = {}) {
  const bridge = readProfileLock(sessionDir);
  if (lockBlocksStart(bridge)) {
    return { live: true, bridge, engine: null };
  }
  if (engineLockDescriptor !== null && engineLockDescriptor !== undefined) {
    const engine = readEngineProfileLock(sessionDir, engineLockDescriptor);
    if (engineLockBlocksStart(engine)) {
      return { live: true, bridge, engine };
    }
    return { live: false, bridge, engine };
  }
  return { live: false, bridge, engine: null };
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Swap a session copy into its base path, keeping the old base as a retained
// sibling. The two renames run back to back:
//   1. base        -> <base>.previous-<stamp>   (retained, never auto-pruned)
//   2. sessionCopy -> base
// If the second rename fails, the base is renamed back from the previous tree and
// the session copy is kept, so neither tree is lost. `exists` and `rename` are
// injectable for tests, as are `retryMs`, `pollMs` and `sleep`: Windows can refuse
// a directory rename transiently (EPERM/EBUSY) while a dying browser, an indexer
// or antivirus still holds a handle inside a tree, so both renames are retried
// within one bounded window — never forced, never longer than the window.
//
// Returns { ok, baseDir, sessionDir, previousDir, restored, retriedMs, error }:
//   ok            both renames succeeded; previousDir is the retained tree
//   restorable    false when a failed swap could not restore the base; then
//                 previousDir names the retained tree that holds it
//   error         the loud failure sentence, naming both paths
export const SWAP_RENAME_RETRY_MS = 3000;
const SWAP_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST']);

export function swapSessionCopyIntoBase({
  baseDir,
  sessionDir,
  now = new Date(),
  exists = existsSync,
  rename = renameSync,
  retryMs = SWAP_RENAME_RETRY_MS,
  pollMs = COPY_KEEP_LOCK_POLL_MS,
  sleep = null,
  clock = () => Date.now(),
} = {}) {
  const resolvedBase = path.resolve(typeof baseDir === 'string' ? baseDir : '');
  const resolvedSession = path.resolve(typeof sessionDir === 'string' ? sessionDir : '');
  const base = {
    baseDir: resolvedBase,
    sessionDir: resolvedSession,
    previousDir: null,
    restored: false,
    retriedMs: 0,
  };
  const wait = (ms) => {
    if (typeof sleep === 'function') {
      sleep(ms);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  // Retry a rename only for the transient Windows refusals, and only inside one
  // window shared by both renames. A test-injected plain Error is not retried.
  let retriedMs = 0;
  const deadline = clock() + (Number.isFinite(retryMs) && retryMs > 0 ? retryMs : 0);
  const renameWithRetry = (from, to) => {
    for (;;) {
      try {
        rename(from, to);
        return null;
      } catch (error) {
        const retryable = SWAP_RETRY_CODES.has(error?.code);
        const remaining = deadline - clock();
        if (!retryable || remaining <= 0) {
          return error;
        }
        const pause = Math.min(pollMs, remaining);
        wait(pause);
        retriedMs += pause;
      }
    }
  };
  if (resolvedBase === resolvedSession) {
    return {
      ...base,
      ok: false,
      error: `The base ${resolvedBase} and the session copy are the same directory; nothing was swapped.`,
    };
  }
  if (isPathInsideRoot(resolvedSession, resolvedBase)) {
    // Renaming the base would move the session copy with it. A base that holds
    // the session root is never a profile folder; nothing is renamed.
    return {
      ...base,
      ok: false,
      error:
        `The session copy ${resolvedSession} is inside the base ${resolvedBase}, so a swap would move ` +
        'both trees at once; nothing was swapped.',
    };
  }
  if (!exists(resolvedBase)) {
    return {
      ...base,
      ok: false,
      error:
        `The base profile ${resolvedBase} disappeared before the swap, so nothing was swapped; ` +
        `the session copy ${resolvedSession} was kept.`,
    };
  }
  if (!exists(resolvedSession)) {
    return {
      ...base,
      ok: false,
      error:
        `The session copy ${resolvedSession} disappeared before the swap, so nothing was swapped; ` +
        `the base profile ${resolvedBase} was left unchanged.`,
    };
  }
  const previousDir = selectPreviousTreeDir(resolvedBase, { now, exists });
  if (previousDir === null) {
    return {
      ...base,
      ok: false,
      error:
        `Cannot find a free previous-tree name beside ${resolvedBase}, so nothing was swapped; ` +
        `the base profile and the session copy ${resolvedSession} were both kept.`,
    };
  }
  const retryText = () => (retriedMs > 0 ? ` (after retrying the rename for ${retriedMs} ms)` : '');
  const firstError = renameWithRetry(resolvedBase, previousDir);
  if (firstError !== null) {
    return {
      ...base,
      ok: false,
      previousDir: null,
      restored: false,
      retriedMs,
      error:
        `Cannot move the base profile ${resolvedBase} to ${previousDir}: ${firstError.message}` +
        `${retryText()}. Nothing was swapped; the session copy ${resolvedSession} was kept.`,
    };
  }
  const secondError = renameWithRetry(resolvedSession, resolvedBase);
  if (secondError !== null) {
    let restored = false;
    let restoreError = null;
    try {
      rename(previousDir, resolvedBase);
      restored = true;
    } catch (failure) {
      restoreError = failure?.message ?? String(failure);
    }
    const restoreText = restored
      ? `The base was restored from ${previousDir}.`
      : `The base could not be restored from ${previousDir} (${restoreError}); it is retained there.`;
    return {
      ok: false,
      baseDir: resolvedBase,
      sessionDir: resolvedSession,
      previousDir: restored ? null : previousDir,
      retainedPreviousDir: previousDir,
      restored,
      retriedMs,
      error:
        `Cannot move the session copy ${resolvedSession} into ${resolvedBase}: ${secondError.message}` +
        `${retryText()}. ${restoreText} The session copy was kept.`,
    };
  }
  return {
    ok: true,
    baseDir: resolvedBase,
    sessionDir: resolvedSession,
    previousDir,
    restored: false,
    retriedMs,
    error: null,
  };
}

// True when `candidate` is inside `root` (not equal to it). Copy-keep replaces a
// whole profile tree, so the broker refuses a base outside the plugin data
// directory; the lexical check is the rule stated to the user, and Windows paths
// compare case-insensitively through path.relative.
export function isPathInsideRoot(candidate, root) {
  if (!nonEmptyString(candidate) || !nonEmptyString(root)) {
    return false;
  }
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// The engine-scoped record of the last clean-close swap, so a later
// browser_profiles call can report the result (the broker that swapped is
// exiting and cannot answer a tool call). One small dot-file; the profile
// inventory skips it and --prune never touches it.
export function swapRecordPath(engineId, dataDir) {
  return path.join(path.resolve(dataDir), 'profiles', engineId, SWAP_RECORD_FILENAME);
}

function boundedRecordField(value, max) {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  return text === '' ? null : text.slice(0, max);
}

// Write the swap record atomically; a failure is reported, never fatal.
export function writeSwapRecord(engineId, dataDir, record) {
  const file = swapRecordPath(engineId, dataDir);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temporary, file);
    return { path: file, written: true, error: null };
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The temporary file is beside the record; leaving it changes no behaviour.
    }
    return { path: file, written: false, error: `Cannot write the swap record ${file}: ${error.message}` };
  }
}

// Read the last swap record, shaped and bounded. Null when it is missing,
// unreadable or not a record this plugin wrote (state is "swapped" or "failed").
export function readSwapRecord(engineId, dataDir) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(swapRecordPath(engineId, dataDir), 'utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }
  const state = boundedRecordField(parsed.state, 16);
  if (state !== 'swapped' && state !== 'failed') {
    return null;
  }
  return {
    at: boundedRecordField(parsed.at, 64),
    isolation: boundedRecordField(parsed.isolation, 16),
    state,
    baseDir: boundedRecordField(parsed.baseDir, 1024),
    sessionDir: boundedRecordField(parsed.sessionDir, 1024),
    previousDir: boundedRecordField(parsed.previousDir, 1024),
    restored: parsed.restored === true,
    error: boundedRecordField(parsed.error, 800),
  };
}

const IGNORED_SETTING_LABELS = Object.freeze({
  [ISOLATED_IGNORED_PROFILE_DIR]: 'the Profile directory setting',
  [ISOLATED_IGNORED_ACCOUNT]: 'the Account profile setting',
  [ISOLATED_IGNORED_POINTER]: 'the default-profile pointer',
});

function boundedSettingValue(value, max = 200) {
  const text = String(value).replace(/[\u0000-\u001f\u007f]/gu, '?');
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

// One entry for the `ignored` report. `value` is what the user supplied, bounded
// and stripped of control characters; the reason is the shared sentence above.
export function isolatedIgnoredEntry(setting, value) {
  return { setting, value: boundedSettingValue(value), reason: PROFILE_ISOLATED_REASON };
}

// The human-readable sentence for an `ignored` list, or null when nothing was
// supplied. It names the settings in the order they were checked.
export function profileIgnoredReason(ignored) {
  if (!Array.isArray(ignored) || ignored.length === 0) {
    return null;
  }
  const labels = ignored.map((entry) => IGNORED_SETTING_LABELS[entry?.setting] ?? String(entry?.setting));
  const joined =
    labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return (
    `profile_isolation is "isolated", so ${joined} ${labels.length === 1 ? 'is' : 'are'} ignored for this ` +
    'start: no profile directory is resolved, created or locked.'
  );
}

// Resolve the profile for this server start.
//
// Returns:
//   profileDir        absolute directory the broker must set, or null when the
//                     broker sets nothing and the engine/launcher default applies
//   defaultProfileDir the engine's default profile (absolute), always known
//   profileSource     "profile_dir" | "account" | "pointer" | "workspace" |
//                     "engine" | "default" | null
//   account           the resolved account name, or null
//   accountApplies    false when the manifest ignores profile_dir (the engine
//                     has its own profile setting; do not add a second control)
//   ignored           the profile settings this start ignored because
//                     profile_isolation is "isolated": [{ setting, value, reason }].
//                     Absent for "shared" and "workspace", so their resolution
//                     objects are byte-identical to before the mode existed.
//   error             the exact start-up error, or null
//
// Precedence: profile_isolation=isolated (no profile at all), then profile_dir,
// then account, then the default-profile pointer, then the workspace profile when
// profile_isolation is "workspace", then the engine default. The pointer is
// passed in already read (null when absent or invalid); an invalid name here is
// ignored rather than turned into an error, because a broken pointer is never
// fatal. With no pointer the result is byte-identical to the behaviour before the
// pointer existed. profile_isolation="copy" and "copy-keep" resolve exactly like
// "shared" (same precedence, same sources) and never derive a workspace profile:
// in this version the copy modes and workspace do not combine.
export function resolveProfile({
  account,
  profileDir,
  pointer = null,
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
  if (isolation === PROFILE_ISOLATION_ISOLATED) {
    // No profile at all. Nothing is resolved, created or locked, so every
    // profile setting that was supplied is reported as ignored rather than as an
    // error (an isolated start never fails because of a profile value), and the
    // workspace derivation does not run.
    const ignored = [];
    const explicitIsolated =
      nonEmptyString(profileDir) && !isPlaceholder(profileDir) ? profileDir.trim() : '';
    if (explicitIsolated !== '') {
      ignored.push(isolatedIgnoredEntry(ISOLATED_IGNORED_PROFILE_DIR, explicitIsolated));
    }
    const accountValue = typeof account === 'string' ? account.trim() : '';
    if (accountValue !== '' && !isPlaceholder(accountValue)) {
      ignored.push(isolatedIgnoredEntry(ISOLATED_IGNORED_ACCOUNT, accountValue));
    }
    const pointerValue = typeof pointer === 'string' ? pointer.trim() : '';
    if (pointerValue !== '' && !isPlaceholder(pointerValue)) {
      ignored.push(isolatedIgnoredEntry(ISOLATED_IGNORED_POINTER, pointerValue));
    }
    return { ...base, profileSource: PROFILE_ISOLATION_ISOLATED, accountApplies: true, ignored };
  }
  const explicit = nonEmptyString(profileDir) && !isPlaceholder(profileDir) ? profileDir.trim() : '';
  if (explicit !== '') {
    // The broker does not normalise, resolve or create an explicit path.
    return {
      ...base,
      profileDir: explicit,
      profileSource: 'profile_dir',
      accountApplies: true,
    };
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
  const pointerName =
    typeof pointer === 'string' && pointer.trim() !== '' && !isPlaceholder(pointer) ? pointer.trim() : '';
  if (pointerName !== '' && validateAccountName(pointerName)) {
    const resolved =
      pointerName === DEFAULT_PROFILE_NAME
        ? engineDefault
        : accountProfileDir(engineId, pointerName, dataDir);
    return {
      ...base,
      profileDir: resolved,
      profileSource: 'pointer',
      // `account` stays the account setting's value; the pointer is a separate
      // source and is reported as profileSource "pointer".
      account: null,
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
// engine owns its profile (attach/native engines), the profile_isolation is
// "isolated" (no profile exists), or no resolution is known. This is what the
// lock preflight reads: an explicit/account/workspace path, or the engine default
// the launcher applies when the broker sets nothing.
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

// --- holding a base profile's lock ------------------------------------------
// profile_isolation=copy must keep the base profile unusable for the session's
// duration. The broker therefore becomes a writer of the bridge's own lock file,
// with the exact bytes the bridge writes ({pid, createdAt, userDataDir}) and the
// bridge's own reclaim rule, so a shared/workspace start (and the bridge itself)
// sees the same "already in use" state it already understands. This is the only
// place the broker creates a lock; it never creates one in shared, workspace or
// isolated mode, whose bytes are unchanged.

// A stale lock may be reclaimed only when the file snapshot the reader saw is
// still the file on disk: same inode, contents, mtime and ctime. This mirrors
// repos/cloakbrowser-mcp/src/bridge/config.ts (reclaimProfileLockFile), so the
// broker and the bridge cannot disagree about whose lock they are removing.
function profileLockSnapshot(lockPath) {
  try {
    const identity = lstatSync(lockPath);
    if (!identity.isFile()) {
      return { ok: false, reason: 'not a regular file' };
    }
    return { ok: true, identity, contents: readFileSync(lockPath, 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, reason: 'missing' };
    }
    return { ok: false, reason: error.message };
  }
}

function sameLockFileId(left, right) {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino;
}

function sameLockIdentity(left, right) {
  return sameLockFileId(left, right) && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

// Remove one stale bridge-format lock file after proving its owner is gone and
// the file did not change between the read and the removal. Returns
// { reclaimed, error }: error is non-null only when a stale lock was seen but
// could not be proven or removed, which the caller turns into a loud refusal.
function reclaimProfileLockFile(lockPath) {
  const snapshot = profileLockSnapshot(lockPath);
  if (!snapshot.ok) {
    return snapshot.reason === 'missing'
      ? { reclaimed: true, error: null }
      : { reclaimed: false, error: `Cannot read the profile lock ${lockPath}: ${snapshot.reason}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(snapshot.contents);
  } catch {
    return { reclaimed: false, error: `The profile lock ${lockPath} is not valid JSON.` };
  }
  if (!isPlainObject(parsed)) {
    return { reclaimed: false, error: `The profile lock ${lockPath} is not a JSON object.` };
  }
  const pid = parsed.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return { reclaimed: false, error: `The profile lock ${lockPath} does not name a process id.` };
  }
  if (processLiveness(pid) === 'live') {
    return {
      reclaimed: false,
      error:
        `The profile lock ${lockPath} names live pid ${pid}; it cannot be reclaimed. ` +
        'Close that process, then restart Claude Code.',
    };
  }
  const current = profileLockSnapshot(lockPath);
  if (!current.ok) {
    return current.reason === 'missing'
      ? { reclaimed: true, error: null }
      : { reclaimed: false, error: `Cannot re-read the profile lock ${lockPath}: ${current.reason}` };
  }
  if (current.contents !== snapshot.contents || !sameLockIdentity(snapshot.identity, current.identity)) {
    return {
      reclaimed: false,
      error:
        `The profile lock ${lockPath} changed while it was being reclaimed; another process may be ` +
        'starting. Try again.',
    };
  }
  try {
    unlinkSync(lockPath);
    return { reclaimed: true, error: null };
  } catch (error) {
    return {
      reclaimed: false,
      error: `Cannot remove the stale profile lock ${lockPath}: ${error.message}`,
    };
  }
}

// Take the bridge-format lock for a base profile. Returns
// { ok, path, owner, identity, reclaimed, error }; a live or unreadable lock, or
// one that changes while being reclaimed, is a loud failure — never a silent
// fallback. `now` is injectable for tests.
export function createProfileLock(
  profileDir,
  { pid = process.pid, now = new Date(), userDataDir = null } = {},
) {
  const resolved = path.resolve(typeof profileDir === 'string' ? profileDir : '');
  const lockPath = path.join(resolved, PROFILE_LOCK_FILENAME);
  const owner = {
    pid,
    createdAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    userDataDir: nonEmptyString(userDataDir) ? path.resolve(userDataDir) : resolved,
  };
  const record = `${JSON.stringify(owner, null, 2)}\n`;
  let reclaimed = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST' && attempt === 0) {
        const reclaim = reclaimProfileLockFile(lockPath);
        if (reclaim.reclaimed) {
          reclaimed = true;
          continue;
        }
        return {
          ok: false,
          path: lockPath,
          owner,
          identity: null,
          contents: null,
          reclaimed: false,
          error: reclaim.error,
        };
      }
      return {
        ok: false,
        path: lockPath,
        owner,
        identity: null,
        contents: null,
        reclaimed,
        error: `Cannot create the profile lock ${lockPath}: ${error.message}`,
      };
    }
    let identity;
    try {
      identity = fstatSync(descriptor);
      writeFileSync(descriptor, record);
    } catch (error) {
      // Close first: on Windows an open handle makes the unlink below fail.
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor ends with the process.
      }
      // Remove only the file this call just created, by its identity, so a
      // half-written lock cannot block every later start (an empty or partial
      // file reads as `invalid`, which the preflight refuses). A file another
      // process replaced is left in place.
      let cleanup;
      if (identity === undefined) {
        cleanup = ' The partially created lock file was left in place.';
      } else {
        try {
          const current = lstatSync(lockPath);
          if (sameLockFileId(identity, current)) {
            unlinkSync(lockPath);
            cleanup = ' The partially created lock file was removed.';
          } else {
            cleanup = ' The lock file changed during the write and was left in place.';
          }
        } catch {
          cleanup = ' The partially created lock file could not be removed.';
        }
      }
      return {
        ok: false,
        path: lockPath,
        owner,
        identity: null,
        contents: null,
        reclaimed,
        error: `Cannot write the profile lock ${lockPath}: ${error.message}.${cleanup}`,
      };
    }
    try {
      closeSync(descriptor);
    } catch {
      // Closing cannot change the result; the descriptor ends with the process.
    }
    return { ok: true, path: lockPath, owner, identity, contents: record, reclaimed, error: null };
  }
  return {
    ok: false,
    path: lockPath,
    owner,
    identity: null,
    contents: null,
    reclaimed,
    error: `Cannot create the profile lock ${lockPath}: another process keeps recreating it.`,
  };
}

// Remove the lock created by createProfileLock, and only that file: the file id
// must still be the one this session wrote and the contents must still be the
// record it wrote (a rewrite in the same timestamp tick keeps the file id on
// NTFS, so the bytes are the second proof). A missing file is success (a crashed
// predecessor's lock was already reclaimed). Never throws.
export function releaseProfileLock(handle) {
  if (handle === null || typeof handle !== 'object' || handle.ok !== true || handle.identity === null) {
    return { released: false, error: null };
  }
  try {
    const current = lstatSync(handle.path);
    let contents = null;
    try {
      contents = readFileSync(handle.path, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return {
          released: false,
          error: `Cannot read the profile lock ${handle.path}: ${error.message}`,
        };
      }
    }
    if (contents !== null && sameLockFileId(handle.identity, current) && contents === handle.contents) {
      unlinkSync(handle.path);
      return { released: true, error: null };
    }
    return {
      released: false,
      error: `The profile lock ${handle.path} is no longer the file this session created; it was left in place.`,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { released: true, error: null };
    }
    return { released: false, error: `Cannot remove the profile lock ${handle.path}: ${error.message}` };
  }
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
// `fallbackKind` names which rule ran out of siblings: the workspace rule keeps
// its original sentence byte for byte, and the on_locked policy says "sibling
// profiles" because the base need not be a workspace profile.
export function profileLockMessage(lock, { fallbackExhausted = false, fallbackKind = 'workspace' } = {}) {
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
    ? fallbackKind === 'workspace'
      ? ` The numbered workspace fallbacks (suffixes ${PROFILE_FALLBACK_FIRST_SUFFIX} to ${PROFILE_FALLBACK_LAST_SUFFIX}) are also in use.`
      : ` The numbered sibling profiles (suffixes ${PROFILE_FALLBACK_FIRST_SUFFIX} to ${PROFILE_FALLBACK_LAST_SUFFIX}) are also in use.`
    : '';
  return `${head}${fix === null ? '' : ` ${fix}`}${exhausted} The backend was not started.`;
}

// The sentence reported when the resolved profile was busy and a numbered sibling
// was chosen instead. The fallback has a different cookie jar, login state and
// fingerprint seed, so it is always named, never silent. `kind` is "workspace"
// for the profile_isolation=workspace rule (its original sentence, byte for
// byte) and "on-locked" for the on_locked policy applied to any plugin-managed
// profile.
export function profileFallbackReason(lock, toDir, kind = 'workspace') {
  const from = lock !== null && typeof lock === 'object' ? lock.profileDir : 'the workspace profile';
  const owner = lock?.owner ?? {};
  const who =
    owner.pid === undefined || owner.pid === null
      ? 'another process'
      : `pid ${owner.pid}${typeof owner.createdAt === 'string' ? `, started ${owner.createdAt}` : ''}`;
  if (kind === 'workspace') {
    return (
      `The workspace profile ${from} was already in use (${who}), so this session uses ${toDir} instead. ` +
      'It has separate cookies, logins and fingerprint seed.'
    );
  }
  return (
    `The profile ${from} was already in use (${who}), so this session uses ${toDir} instead. ` +
    'It has separate cookies, logins and fingerprint seed.'
  );
}

// The sentence reported when on_locked is "isolated" and the resolved profile was
// busy: this start has no profile at all, so nothing is saved and nothing
// persists. Same shape as profileFallbackReason, with no destination directory.
export function profileOnLockedIsolatedReason(lock) {
  const from = lock !== null && typeof lock === 'object' ? lock.profileDir : 'the resolved profile';
  const owner = lock?.owner ?? {};
  const who =
    owner.pid === undefined || owner.pid === null
      ? 'another process'
      : `pid ${owner.pid}${typeof owner.createdAt === 'string' ? `, started ${owner.createdAt}` : ''}`;
  return (
    `The profile ${from} was already in use (${who}), and on_locked is "isolated", so this session started ` +
    'with no profile at all: its cookies, logins and fingerprint are not saved and nothing persists after it closes.'
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

// An engine's own profile lock, declared by its manifest as
// "profileLock": { "file": "<name inside the profile directory>", "owner": "<rule>" }.
// Camoufox is why this exists: its Firefox wrapper checks a Unix "lockfile" name
// and never writes the bridge's lock, while Firefox itself takes
// <profile>/parent.lock. Chromium's Windows <profile>/lockfile needs a different
// proof again. The owner rule is explicit because the real files differ:
//   exclusive-open        the OS refuses to open the file while a live process
//                         holds it (the Windows Firefox lock: a zero-byte file
//                         kept open, so it carries no process id)
//   exclusive-open-write  the OS allows a plain read but refuses an open with
//                         write access while a live process holds the file
//                         (Chromium's Windows lockfile, shared for readers but
//                         not writers), so liveness is proven by opening it r+
//                         and closing it at once; it is never written to
//   pid                   the file contains the owner's process id as text
// A malformed or unreadable file is never treated as a lock: the start is allowed
// and the reason is reported, because this check is a courtesy, not a guarantee.
export const ENGINE_LOCK_OWNER_RULES = Object.freeze(['exclusive-open', 'exclusive-open-write', 'pid']);
// Error codes that prove a live holder: the file exists and the OS refuses to
// open it (or, for the write probe, to open it for writing). Windows
// ERROR_SHARING_VIOLATION surfaces as EBUSY or EACCES.
const ENGINE_LOCK_LIVE_CODES = new Set(['EBUSY', 'EACCES', 'EPERM', 'ETXTBSY']);

function engineLockResult(base, liveness, state, owner, error = null) {
  return { ...base, liveness, state, owner, error };
}

// Liveness proof for Chromium's Windows <profile>/lockfile. The browser opens it
// for writing without sharing writes, so a plain read still succeeds while a
// browser runs, but an open with write access is refused (measured: EBUSY;
// EPERM/EACCES are the same refusal across accounts). The probe opens r+, closes
// at once and never writes, so a file nobody holds — including one left behind by
// a crash — reads as stale, exactly like Chromium's own rule. A vanished file is
// free: it was removed between the stat and the open.
function probeEngineLockWrite(base, liveness, lockPath) {
  let handle;
  try {
    handle = openSync(lockPath, 'r+');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return base;
    }
    if (ENGINE_LOCK_LIVE_CODES.has(error?.code)) {
      return engineLockResult(base, liveness, 'live', { pid: null, createdAt: null });
    }
    return engineLockResult(
      base,
      liveness,
      'unknown',
      null,
      `Cannot probe the engine profile lock ${lockPath} for writing: ${error.message}. ` +
        'The start continues.',
    );
  }
  try {
    closeSync(handle);
  } catch {
    // The open already proved nobody holds the file; a failed close leaves the
    // descriptor to the process exit and never changes the result.
  }
  return engineLockResult(base, liveness, 'stale', null);
}

// Read an engine's own lock file without creating, moving or deleting anything.
//
// Returns { profileDir, path, file, liveness, state, owner, error } where state is:
//   free     no lock file (or the directory does not exist)
//   live     a live process owns the profile (the file cannot be opened, or the
//            pid it names exists); owner is { pid, createdAt } and pid may be null
//   stale    the file exists but no live owner holds it; the browser replaces it
//   unknown  the file cannot be interpreted; the start is allowed with a note
export function readEngineProfileLock(profileDir, descriptor) {
  const resolved = path.resolve(typeof profileDir === 'string' ? profileDir : '');
  const file = isPlainObject(descriptor) && nonEmptyString(descriptor.file) ? descriptor.file.trim() : null;
  const liveness =
    isPlainObject(descriptor) && nonEmptyString(descriptor.owner) ? descriptor.owner.trim() : null;
  const lockPath = path.join(resolved, file === null ? '' : file);
  const base = {
    profileDir: resolved,
    path: lockPath,
    file,
    liveness,
    state: 'free',
    owner: null,
    error: null,
  };
  if (file === null || !ENGINE_LOCK_OWNER_RULES.includes(liveness)) {
    return engineLockResult(
      base,
      liveness,
      'unknown',
      null,
      `The engine profile lock descriptor ${JSON.stringify(descriptor ?? null)} is not usable; ` +
        'the start continues without checking it.',
    );
  }
  let bytes;
  try {
    if (!statSync(lockPath).isFile()) {
      return engineLockResult(
        base,
        liveness,
        'unknown',
        null,
        `The engine profile lock ${lockPath} is not a regular file; the start continues.`,
      );
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return base;
    }
    return engineLockResult(
      base,
      liveness,
      'unknown',
      null,
      `Cannot read the engine profile lock ${lockPath}: ${error.message}. The start continues.`,
    );
  }
  if (liveness === 'exclusive-open-write') {
    return probeEngineLockWrite(base, liveness, lockPath);
  }
  try {
    bytes = readFileSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return base;
    }
    if (ENGINE_LOCK_LIVE_CODES.has(error?.code)) {
      // The operating system proved a live holder: the file exists and cannot be
      // opened. Its contents are not readable, so no process id is known.
      return engineLockResult(base, liveness, 'live', { pid: null, createdAt: null });
    }
    return engineLockResult(
      base,
      liveness,
      'unknown',
      null,
      `Cannot read the engine profile lock ${lockPath}: ${error.message}. The start continues.`,
    );
  }
  if (liveness === 'exclusive-open') {
    // The file was opened, so no process holds it. Firefox leaves this zero-byte
    // file behind after a clean exit; the next browser replaces it.
    return engineLockResult(base, liveness, 'stale', null);
  }
  // pid rule: the leading integer is the owner's process id. Firefox and other
  // tools append text after it, so trailing text and whitespace are tolerated;
  // a fractional value ("1.5") is not a process id and reads as malformed.
  const text = bytes.toString('utf8');
  const match = /^\s*(\d+)(?!\d|\.\d)/u.exec(text);
  const pid = match === null ? NaN : Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return engineLockResult(
      base,
      liveness,
      'unknown',
      null,
      `The engine profile lock ${lockPath} does not name a process id; the start continues.`,
    );
  }
  const owner = { pid, createdAt: null };
  return engineLockResult(base, liveness, processLiveness(pid) === 'live' ? 'live' : 'stale', owner);
}

// True when an engine lock must stop the backend. Only a proven live owner does;
// a stale file and an unreadable one never block.
export function engineLockBlocksStart(lock) {
  return lock !== null && typeof lock === 'object' && lock.state === 'live';
}

// A plain-language, actionable fix for a live engine lock. It names the lock file
// and never suggests deleting, moving or editing a profile directory.
export function engineProfileLockFix(lock) {
  if (lock === null || typeof lock !== 'object' || lock.state !== 'live') {
    return null;
  }
  const owner = lock.owner ?? {};
  const who =
    typeof owner.pid === 'number'
      ? `pid ${owner.pid}${typeof owner.createdAt === 'string' ? `, started ${owner.createdAt}` : ''}`
      : 'another process';
  return (
    `Close the browser or Claude Code session that owns this profile (${who}); ` +
    `${lock.path} stays locked until that process exits. You can also set "Profile directory" ` +
    '(profile_dir) to another folder, or set "Profile isolation" (profile_isolation) to workspace so ' +
    'each project folder gets its own profile. Restart Claude Code after the change.'
  );
}

// The start-up sentence for a blocking engine lock. The broker does not spawn a
// backend in this state; this text is what initialize.instructions,
// browser_capabilities.engineError and browser_engine_status.lastError carry.
// `trailing` is the closing sentence; the default is the broker's own and keeps
// every existing message byte-identical (the profile copy tool reuses the same
// heading and fix and says "The profile was not copied." instead).
export function engineProfileLockMessage(lock, { trailing = 'The backend was not started.' } = {}) {
  if (lock === null || typeof lock !== 'object') {
    return 'The browser profile is locked by another process.';
  }
  const owner = lock.owner ?? {};
  let heading;
  if (typeof owner.pid === 'number') {
    const when = typeof owner.createdAt === 'string' ? `, started ${owner.createdAt}` : '';
    heading = `The browser profile ${lock.profileDir} is already in use by pid ${owner.pid}${when}.`;
  } else {
    heading =
      `The browser profile ${lock.profileDir} is already in use: another process holds the engine ` +
      `lock file ${lock.path} open.`;
  }
  const fix = engineProfileLockFix(lock);
  const end = nonEmptyString(trailing) ? trailing.trim() : 'The backend was not started.';
  return `${heading}${fix === null ? '' : ` ${fix}`} ${end}`;
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

// --- unpacked extension paths (2.18.0) --------------------------------------
// An opt-in list of unpacked Chromium extension directories for the cloak
// engine. The bridge (cloakbrowser-mcp) reads CLOAK_PLAYWRIGHT_MCP_EXTENSION_PATHS
// as a JSON string array or a comma-separated list, validates every entry as an
// existing directory and, for a persistent profile only, turns the list into
// --load-extension plus --disable-extensions-except; the engine wrapper joins
// the list with commas, so a directory whose path contains a comma cannot be
// expressed at all.
//
// The plugin setting is `extension_paths` (STEALTH_EXTENSION_PATHS) and is
// deliberately not the bridge variable's name: an explicit
// CLOAK_PLAYWRIGHT_MCP_EXTENSION_PATHS in the environment always wins and is
// reported as the source, exactly like ping_timeout_ms.
//
// Parsing mirrors the bridge's envList, so a value that works in the variable
// works as a setting: a value that starts with "[" is a JSON string array and
// anything else is a comma-separated list. Every entry is then canonicalised and
// validated here, before a backend starts, so a mistake produces one actionable
// sentence instead of a bridge failure after provisioning. Nothing here reads or
// writes an extension directory: only its existence and kind are checked.
export const EXTENSION_PATHS_ENV_VAR = 'CLOAK_PLAYWRIGHT_MCP_EXTENSION_PATHS';
export const EXTENSION_PATHS_SETTING_VAR = 'STEALTH_EXTENSION_PATHS';

// The settings that together resolve the list: the operator variable first, then
// the plugin setting.
function extensionRawValue(env) {
  for (const [variable, source] of [
    [EXTENSION_PATHS_ENV_VAR, 'environment'],
    [EXTENSION_PATHS_SETTING_VAR, 'setting'],
  ]) {
    const value = env[variable];
    if (typeof value !== 'string' || value.trim() === '') {
      continue;
    }
    return { variable, source, raw: value.trim() };
  }
  return null;
}

// The same two forms the bridge accepts. A malformed JSON array is an error, not
// a comma list: silently splitting it would load directories the user did not
// name.
function splitExtensionEntries(raw) {
  if (raw.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { entries: null, error: 'the value starts with "[" but is not valid JSON' };
    }
    if (!Array.isArray(parsed)) {
      return { entries: null, error: 'a "[" value must be a JSON string array' };
    }
    return {
      entries: parsed.map((item) => (typeof item === 'string' ? item.trim() : null)),
      error: null,
    };
  }
  return { entries: raw.split(',').map((item) => item.trim()), error: null };
}

// One entry, canonicalised. A comma is refused even from a JSON array: the
// wrapper joins the list with commas and cannot represent the path.
function resolveExtensionEntry(index, entry) {
  if (entry === null) {
    return { path: null, reason: 'not-string', detail: `entry ${index + 1} is not a string` };
  }
  if (entry === '') {
    return { path: null, reason: 'empty', detail: `entry ${index + 1} is empty` };
  }
  if (entry.includes(',')) {
    return {
      path: null,
      reason: 'comma',
      detail: `entry ${index + 1} contains a comma, and the engine joins the list with commas`,
    };
  }
  if (!path.isAbsolute(entry)) {
    return {
      path: null,
      reason: 'relative',
      detail: `entry ${index + 1} (${JSON.stringify(entry)}) is not an absolute path`,
    };
  }
  let stats;
  try {
    stats = statSync(entry);
  } catch (error) {
    const missing = error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
    return {
      path: null,
      reason: missing ? 'missing' : 'unreadable',
      detail:
        `entry ${index + 1} (${JSON.stringify(entry)}) ` +
        (missing
          ? 'does not exist'
          : `cannot be read (${typeof error?.code === 'string' ? error.code : 'unknown error'})`),
    };
  }
  if (!stats.isDirectory()) {
    return {
      path: null,
      reason: 'not-directory',
      detail: `entry ${index + 1} (${JSON.stringify(entry)}) is not a directory`,
    };
  }
  try {
    return { path: realpathSync(entry), reason: null, detail: null };
  } catch (error) {
    return {
      path: null,
      reason: 'unreadable',
      detail:
        `entry ${index + 1} (${JSON.stringify(entry)}) cannot be resolved ` +
        `(${typeof error?.code === 'string' ? error.code : 'unknown error'})`,
    };
  }
}

// The complete sentence for a value that cannot be used, shared by the broker
// log, the refused start and the meta-tool report so all three agree.
export function extensionPathsProblemText(error) {
  return (
    `Unpacked extensions: ${error.detail}. Use absolute unpacked-extension directories, one per entry, ` +
    'as a JSON string array or a comma-separated list; a comma cannot appear inside a path because the ' +
    'engine joins the list with commas.'
  );
}

// Resolve the effective list from the environment.
//
// `configured` is true only when a non-empty value names at least one entry; an
// unsubstituted ${user_config.*} placeholder is treated as unset (problem
// "placeholder") and is never a path. `paths` holds the canonical absolute
// directories and is null when one entry failed: a partial list is never applied,
// because a half-loaded extension set would quietly change what the browser runs.
// `entries` is the list as written (null when the value could not be parsed at
// all) and `error` is `{ index, reason, detail }` for the first failing entry.
export function resolveExtensionPaths(env = {}) {
  const found = extensionRawValue(env);
  if (found === null) {
    return {
      configured: false,
      source: 'none',
      variable: null,
      raw: null,
      entries: null,
      paths: null,
      error: null,
      problem: null,
    };
  }
  const base = { configured: false, source: found.source, variable: found.variable, raw: found.raw };
  if (found.raw.includes('${')) {
    return { ...base, entries: null, paths: null, error: null, problem: 'placeholder' };
  }
  const split = splitExtensionEntries(found.raw);
  if (split.error !== null) {
    return {
      ...base,
      configured: true,
      entries: null,
      paths: null,
      error: { index: null, reason: 'invalid', detail: split.error },
      problem: null,
    };
  }
  const entries = split.entries;
  if (entries.length === 0) {
    return { ...base, entries, paths: null, error: null, problem: null };
  }
  const paths = [];
  const seen = new Map();
  for (const [index, entry] of entries.entries()) {
    const resolved = resolveExtensionEntry(index, entry);
    if (resolved.path === null) {
      return {
        ...base,
        configured: true,
        entries,
        paths: null,
        error: { index, reason: resolved.reason, detail: resolved.detail },
        problem: null,
      };
    }
    // Windows paths are case-insensitive, so two spellings of one directory are
    // the same extension directory; everywhere else the canonical path compares
    // exactly.
    const key = process.platform === 'win32' ? resolved.path.toLowerCase() : resolved.path;
    if (seen.has(key)) {
      return {
        ...base,
        configured: true,
        entries,
        paths: null,
        error: {
          index,
          reason: 'duplicate',
          detail: `entry ${index + 1} (${JSON.stringify(resolved.path)}) repeats entry ${seen.get(key) + 1}`,
        },
        problem: null,
      };
    }
    seen.set(key, index);
    paths.push(resolved.path);
  }
  return { ...base, configured: true, entries, paths, error: null, problem: null };
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
// unless resolveProfile returned a directory. `outputDir` is the broker's
// resolved default artifact directory (2.10.1); when null nothing is added, so an
// explicit output_dir setting keeps flowing through the plugin env untouched.
// `isolated` is the profile_isolation=isolated start: any user-data-dir the base
// environment carried is removed (the setting is inert in that mode) and the
// engines' own isolated switch is turned on. Both engines read that variable:
// the Cloak bridge passes it through when it sets no user-data-dir, and the
// Camoufox wrapper reads it in mcp/config.py. With `isolated` false the
// environment is byte-identical to before.
// `extensionPaths` (2.18.0) is the resolved unpacked-extension list for the cloak
// engine, written as CLOAK_PLAYWRIGHT_MCP_EXTENSION_PATHS only when it is
// non-empty; with null, empty or an isolated start the variable is not written,
// so the environment is byte-identical to 2.17.0.
export function backendEnvironment(
  baseEnv,
  {
    engineId,
    profileDir = null,
    proxyServer = null,
    outputDir = null,
    isolated = false,
    extensionPaths = null,
  } = {},
) {
  const env = { ...(isPlainObject(baseEnv) ? baseEnv : {}), PLAYWRIGHT_MCP_BROWSER_ENGINE: engineId };
  if (nonEmptyString(profileDir)) {
    env.PLAYWRIGHT_MCP_USER_DATA_DIR = profileDir;
  }
  if (nonEmptyString(proxyServer)) {
    env.PLAYWRIGHT_MCP_PROXY_SERVER = proxyServer;
  }
  if (nonEmptyString(outputDir)) {
    env.PLAYWRIGHT_MCP_OUTPUT_DIR = outputDir;
  }
  // Unpacked extensions (2.18.0): the canonical list as a JSON string array,
  // which the bridge reads exactly like a comma list but without the ambiguity a
  // comma inside a path would create. An empty or missing list writes nothing, so
  // the default child environment stays byte-identical to 2.17.0.
  if (Array.isArray(extensionPaths) && extensionPaths.length > 0) {
    env[EXTENSION_PATHS_ENV_VAR] = JSON.stringify(extensionPaths);
  }
  if (isolated === true) {
    // Last, so neither the base environment nor a caller-supplied directory can
    // leave a user-data-dir on an isolated start (both engines refuse or ignore
    // it there). An isolated start has no persistent profile, so it can carry no
    // unpacked extension either: the bridge refuses extension paths without a
    // user-data-dir, and the broker refuses this combination before spawning.
    delete env.PLAYWRIGHT_MCP_USER_DATA_DIR;
    delete env[EXTENSION_PATHS_ENV_VAR];
    env.PLAYWRIGHT_MCP_ISOLATED = 'true';
  }
  return env;
}

// --- profile copy engine -----------------------------------------------------
// One exclusion engine, one walk and one copy writer, shared by the copy tool
// (scripts/profile-copy.mjs) and by the broker's profile_isolation "copy" mode,
// so a session copy and a named-profile copy can never exclude different files.
// A copy keeps cookies, logins, Local State, Preferences, the fingerprint seed
// and every database WAL/SHM companion; it leaves every lock, Chromium
// singleton, cache, metrics dump, thumbnail cache, *.tmp entry and log directory
// behind. Nothing here writes to the source.

// A copy failure with a stable code for the tool's JSON output and exit status.
export class ProfileCopyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfileCopyError';
    this.code = code;
  }
}

// Chromium's process-singleton files. They name a live browser instance on this
// machine and mean nothing in a copy; SingletonLock is also what stops a second
// browser from opening a profile.
const SINGLETON_NAMES = new Set(['singletonlock', 'singletonsocket', 'singletoncookie']);
// Regenerable caches. They hold no identity, can be very large, and the copy
// rebuilds them on first use. The list covers both profile formats this plugin
// copies: Chromium's cache directories (including Chromium 146's Dawn shader
// caches) and Firefox's cache2/startupCache.
const CACHE_NAMES = new Set([
  'cache',
  'cache2',
  'code cache',
  'gpucache',
  'grshadercache',
  'graphitedawncache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'dawncache',
  'shadercache',
  'startupcache',
  'crashpad',
]);
// Crash and usage dumps Chromium rewrites. They carry no identity and can be
// several megabytes.
const METRICS_NAMES = new Set(['browsermetrics']);
// Firefox's page thumbnails. Regenerated on demand, not identity.
const THUMBNAIL_NAMES = new Set(['thumbnails']);
// Log directories, excluded by name at any depth. Logs are not identity and may
// contain incidental browsing text.
const LOG_DIRECTORY_NAMES = new Set(['log', 'logs']);
export const EXCLUSION_RULES = Object.freeze([
  'profileLock',
  'engineLock',
  'singleton',
  'cache',
  'metrics',
  'thumbnails',
  'temporary',
  'logs',
]);
export const EXCLUSION_LABELS = Object.freeze({
  profileLock: 'profile lock',
  engineLock: 'engine lock file',
  singleton: 'Chromium singleton',
  cache: 'cache',
  metrics: 'metrics dump',
  thumbnails: 'thumbnail cache',
  temporary: 'temporary file',
  logs: 'log directory',
});
// The rules whose excluded entries are named one by one in the report. Their
// names differ by profile format (Chromium's lockfile/Dawn caches/BrowserMetrics,
// Firefox's parent.lock/cache2/startupCache/thumbnails), so counts alone would
// hide which engine's artifacts a copy left behind.
const ENGINE_SPECIFIC_RULES = Object.freeze(['engineLock', 'cache', 'metrics', 'thumbnails']);
// Every *.sqlite-wal and *.sqlite-shm file is deliberately NOT matched by any
// rule: those files are part of the database, and a copy without them can lose
// the newest committed rows. No rule ends in these suffixes.

function sortEntries(entries) {
  return [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

// The exclusion rule for one directory entry, or null when it is copied. The
// first matching rule wins, so one excluded entry is counted once. engineLockFile
// is the lock file name the engine's manifest declares (Chromium "lockfile",
// Firefox "parent.lock"); without it, only the bridge's own lock is excluded.
export function exclusionRule(name, isDirectory, engineLockFile = null) {
  const lower = String(name).toLowerCase();
  if (lower === PROFILE_LOCK_FILENAME.toLowerCase()) {
    return 'profileLock';
  }
  if (typeof engineLockFile === 'string' && engineLockFile.trim() !== '') {
    if (lower === engineLockFile.trim().toLowerCase()) {
      return 'engineLock';
    }
  }
  if (SINGLETON_NAMES.has(lower)) {
    return 'singleton';
  }
  if (CACHE_NAMES.has(lower)) {
    return 'cache';
  }
  if (METRICS_NAMES.has(lower)) {
    return 'metrics';
  }
  if (THUMBNAIL_NAMES.has(lower)) {
    return 'thumbnails';
  }
  if (/\.tmp$/iu.test(name)) {
    return 'temporary';
  }
  if (isDirectory && LOG_DIRECTORY_NAMES.has(lower)) {
    return 'logs';
  }
  return null;
}

function emptyExcludedCounts() {
  return Object.fromEntries(EXCLUSION_RULES.map((rule) => [rule, 0]));
}

// Count one excluded entry, and remember its name for the engine-specific
// report. Names are merged case-insensitively per rule so one class of artifact
// appears once with its total, however deep it was found.
function recordExclusion(plan, name, rule) {
  plan.excluded[rule] += 1;
  if (!ENGINE_SPECIFIC_RULES.includes(rule)) {
    return;
  }
  const key = `${rule}\u0000${String(name).toLowerCase()}`;
  const entry = plan.excludedNames.get(key) ?? { name: String(name), rule, count: 0 };
  entry.count += 1;
  plan.excludedNames.set(key, entry);
}

// The engine-specific exclusions as a stable list: rule order first, then name.
export function excludedNameList(excludedNames) {
  const order = (rule) => ENGINE_SPECIFIC_RULES.indexOf(rule);
  return [...excludedNames.values()].sort((left, right) => {
    const byRule = order(left.rule) - order(right.rule);
    if (byRule !== 0) {
      return byRule;
    }
    return left.name.toLowerCase() < right.name.toLowerCase()
      ? -1
      : left.name.toLowerCase() > right.name.toLowerCase()
        ? 1
        : 0;
  });
}

// Walk the source once. The returned plan is the dry-run listing and the exact
// list of directories and files the copy executes, so a caller never counts one
// tree and copies another. `engineLockFile` is the manifest-declared lock file of
// the engine being copied; it is excluded like the bridge lock.
export function planCopy(sourceDir, { engineLockFile = null } = {}) {
  const plan = {
    directories: [],
    files: [],
    topLevel: [],
    excluded: emptyExcludedCounts(),
    excludedNames: new Map(),
    skipped: { symlinks: 0, other: 0 },
    bytes: 0,
  };

  function readDirectory(directory) {
    try {
      return sortEntries(readdirSync(directory, { withFileTypes: true }));
    } catch (error) {
      throw new ProfileCopyError(
        'source-unreadable',
        `Cannot read the source profile directory ${redactSecrets(directory)}: ${redactSecrets(error.message)}`,
      );
    }
  }

  function addFile(absolute, relative, stats) {
    let size;
    try {
      size = statSync(absolute).size;
    } catch (error) {
      throw new ProfileCopyError(
        'source-unreadable',
        `Cannot read the source file ${redactSecrets(absolute)}: ${redactSecrets(error.message)}`,
      );
    }
    plan.files.push({ source: absolute, relative, bytes: size });
    plan.bytes += size;
    if (stats !== null) {
      stats.files += 1;
      stats.bytes += size;
    }
  }

  function walk(directory, relative, stats) {
    plan.directories.push(relative);
    for (const entry of readDirectory(directory)) {
      const childRelative = path.join(relative, entry.name);
      const childAbsolute = path.join(directory, entry.name);
      const isDirectory = entry.isDirectory();
      const rule = exclusionRule(entry.name, isDirectory, engineLockFile);
      if (rule !== null) {
        recordExclusion(plan, entry.name, rule);
        continue;
      }
      if (isDirectory) {
        walk(childAbsolute, childRelative, stats);
      } else if (entry.isFile()) {
        addFile(childAbsolute, childRelative, stats);
      } else if (entry.isSymbolicLink()) {
        plan.skipped.symlinks += 1;
      } else {
        plan.skipped.other += 1;
      }
    }
  }

  for (const entry of readDirectory(sourceDir)) {
    const isDirectory = entry.isDirectory();
    const stats = {
      path: entry.name,
      type: isDirectory ? 'directory' : entry.isFile() ? 'file' : 'other',
      files: 0,
      bytes: 0,
      excluded: null,
    };
    plan.topLevel.push(stats);
    const rule = exclusionRule(entry.name, isDirectory, engineLockFile);
    if (rule !== null) {
      stats.excluded = rule;
      recordExclusion(plan, entry.name, rule);
      continue;
    }
    if (isDirectory) {
      walk(path.join(sourceDir, entry.name), entry.name, stats);
    } else if (entry.isFile()) {
      addFile(path.join(sourceDir, entry.name), entry.name, stats);
    } else if (entry.isSymbolicLink()) {
      plan.skipped.symlinks += 1;
    } else {
      plan.skipped.other += 1;
    }
  }
  return plan;
}

// The first ancestor that does not exist yet, i.e. the top of the tree this run
// would create. Null when every parent already exists.
function firstMissingAncestor(target) {
  let current = path.dirname(target);
  let highest = null;
  while (!existsSync(current)) {
    highest = current;
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return highest;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Remove only what this run created: the destination directory, then any parent
// directory it created that is still empty. rmdirSync refuses a non-empty
// directory, so a concurrent writer's files are never deleted.
function cleanupCreated(targetDir, targetCreated, createdParentRoot) {
  const failures = [];
  if (targetCreated) {
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch (error) {
      failures.push(redactSecrets(error.message));
    }
  }
  if (createdParentRoot !== null) {
    let current = path.dirname(targetDir);
    while (isWithin(createdParentRoot, current)) {
      if (existsSync(current)) {
        try {
          rmdirSync(current);
        } catch {
          // ENOTEMPTY (another writer's files) or a permission error: stop here
          // rather than touch anything this run did not create empty.
          break;
        }
      }
      if (path.resolve(current) === path.resolve(createdParentRoot)) {
        break;
      }
      current = path.dirname(current);
    }
  }
  return failures;
}

/**
 * Create the destination and copy the planned entries. Exported so the failure
 * path can be exercised with a plan whose source file is gone: the destination
 * this run created must be removed, and a destination another writer created
 * must never be touched or merged into.
 *
 * @param {{directories: string[], files: {source: string, relative: string}[]}} plan Copy plan.
 * @param {string} targetDir Destination directory (absolute).
 * @param {{targetName?: string}} [options] Name used in a destination-exists message.
 * @returns {void}
 */
export function copyPlanToTarget(plan, targetDir, { targetName = path.basename(targetDir) } = {}) {
  const createdParentRoot = firstMissingAncestor(targetDir);
  let targetCreated = false;
  try {
    mkdirSync(path.dirname(targetDir), { recursive: true });
    try {
      mkdirSync(targetDir);
      targetCreated = true;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new ProfileCopyError(
          'destination-exists',
          `The destination profile "${targetName}" already exists: ${redactSecrets(targetDir)}. ` +
            'Choose another name; the copy tool never overwrites or merges a profile.',
        );
      }
      throw error;
    }
    for (const relative of plan.directories) {
      mkdirSync(path.join(targetDir, relative), { recursive: true });
    }
    for (const file of plan.files) {
      copyFileSync(file.source, path.join(targetDir, file.relative));
    }
  } catch (error) {
    const cleanupFailures = cleanupCreated(targetDir, targetCreated, createdParentRoot);
    let cleanupNote;
    if (cleanupFailures.length > 0) {
      cleanupNote = ` The partial destination could not be fully removed: ${cleanupFailures.join('; ')}`;
    } else if (error instanceof ProfileCopyError && error.code === 'destination-exists') {
      cleanupNote = '';
    } else {
      cleanupNote = ' The partial destination was removed.';
    }
    if (error instanceof ProfileCopyError) {
      throw new ProfileCopyError(error.code, `${error.message}${cleanupNote}`);
    }
    throw new ProfileCopyError(
      'copy-failed',
      `Copying the profile failed: ${redactSecrets(error?.message ?? String(error))}.${cleanupNote}`,
    );
  }
}
