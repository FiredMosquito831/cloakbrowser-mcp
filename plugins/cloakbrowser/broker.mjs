#!/usr/bin/env node
// CloakBrowser multi-engine broker.
//
// One stdio MCP server in front of the existing launcher. It reads the engine id
// from the environment, loads the matching manifest from ./engines, starts
// launch.mjs for that engine and relays JSON-RPC in both directions. It also
// owns the three broker meta-tools, the default-profile pointer and the
// disabled-tools filter.
//
// Protocol rules: stdout carries JSON-RPC lines only; every log goes to stderr.
// Windows rules: no detached children, stdin EOF is the shutdown signal, and the
// backend process tree is killed with taskkill after a 300 ms grace period.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  availableProfileNames,
  DEFAULT_ENGINE,
  engineChangeHelp,
  firstMissingRequiredEnv,
  loadEngineConfiguration,
  manifestProfileApplies,
  manifestSupport,
  portableToolNames,
  profileAllows,
  resolveLauncherName,
  resolveToolProfile,
  systemDependencies,
} from './engine-registry.mjs';
import { enrichToolError, runtimeErrorHint, runtimeStatusFields } from './lib/attach.mjs';
import {
  hasFirefoxLoginStore,
  PASSWORD_MANAGER_APPLIED_SENTENCE,
  PASSWORD_MANAGER_ENGINE_ID,
  PASSWORD_MANAGER_NATIVE_NOTE,
  PASSWORD_MANAGER_NOT_APPLICABLE_NOTE,
  PASSWORD_MANAGER_PENDING_NOTE,
  passwordUserConfigProblem,
  readPasswordPolicyRecord,
  resolvePasswordManager,
  sha256File,
} from './lib/password-manager.mjs';
import { PING_TIMEOUT_ENGINE_ID, pingTimeoutProblemNote, resolvePingTimeout } from './lib/ping-timeout.mjs';
import {
  accountNameError,
  accountProxyPath,
  backendEnvironment,
  COPY_KEEP_LOCK_POLL_MS,
  COPY_KEEP_LOCK_WAIT_MS,
  copyPlanToTarget,
  createProfileLock,
  DEFAULT_PROFILE_NAME,
  effectiveProfileDir,
  engineLockBlocksStart,
  engineProfileLockFix,
  engineProfileLockMessage,
  INVALID_ACCOUNT_HINT,
  ISOLATED_IGNORED_POINTER,
  isCopyIsolation,
  isPathInsideRoot,
  isolatedIgnoredEntry,
  listPreviousTrees,
  listSessionCopies,
  lockBlocksStart,
  planCopy,
  PROFILE_ISOLATED_NATIVE_NOTE,
  PROFILE_ISOLATED_NOTE,
  PROFILE_ISOLATED_POINTER_NOTE,
  PROFILE_LOCK_FILENAME,
  profileCopyKeepNote,
  profileCopyNotApplicableNote,
  profileCopyNote,
  profileDefaultPointerDir,
  profileDefaultPointerPath,
  profileFallbackReason,
  profileIgnoredReason,
  profileLockFix,
  profileLockMessage,
  readAccountProxy,
  readEngineProfileLock,
  readProfileDefaultPointer,
  readProfileLock,
  readSwapRecord,
  redactSecrets,
  releaseProfileLock,
  resolveProfile,
  resolveProfileIsolation,
  selectFallbackProfile,
  sessionCopyDir,
  sessionCopyHasLiveLock,
  SESSION_OWNER_FILENAME,
  swapSessionCopyIntoBase,
  validateAccountName,
  writeProfileDefaultPointer,
  writeSwapRecord,
} from './lib/profile.mjs';
import {
  aliasSummary,
  buildNativeSurface,
  classifyExposedTool,
  createAliasIndex,
  isNativeContract,
  loadContractSchemas,
  resolveNativeCall,
} from './lib/surface.mjs';

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENGINES_DIR = path.join(PLUGIN_ROOT, 'engines');
const PROFILES_FILE = path.join(ENGINES_DIR, 'profiles.json');
const PLUGIN_MANIFEST = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
const SHUTDOWN_GRACE_MS = 300;
const LOG_PREFIX = '[cloakbrowser-broker]';

// Appended to a rejected initialize when the backend serves the 2026-07-28
// protocol era (the Camoufox wrapper stack before plugin 2.9.2, where every
// request gets a new session and the wrapper starts a new browser per call).
// Additive text only: every other rejection keeps its exact previous message.
const PROTOCOL_2026_MARKER = '2026-07-28';
const PROTOCOL_2026_HINT =
  'The backend is serving the 2026-07-28 protocol era (a new session per request, so the Camoufox wrapper starts a new browser on every tool call); update the plugin, because 2.9.2 and later pin the Python MCP stack (fastmcp 3.4.7, mcp 1.29.0) so this no longer occurs.';

function protocolEraHint(reason) {
  return String(reason).includes(PROTOCOL_2026_MARKER) ? ` ${PROTOCOL_2026_HINT}` : '';
}

const META_TOOL_NAMES = new Set(['browser_capabilities', 'browser_engine_status', 'browser_profiles']);
const META_TOOLS = [
  {
    name: 'browser_capabilities',
    description:
      'Report the selected browser engine, its Playwright MCP contract, the active tool profile, the backend tool count, per-tool support and how to change engines. It also reports the default-profile pointer, the server working directory, the effective artifact directory and the MCP roots the client advertised, which together explain a file-access refusal. This is a local broker tool; it does not start a browser. When another session already uses the browser profile, it also reports the profile directory, the owning process and the fix.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_engine_status',
    description:
      'Report the selected engine, backend process state, backend version when the handshake has completed, startup timing and the last error. A backend that rejected the initialize handshake but still answers tools reports `initializeRejected: true` and stays running. This is a local broker tool; it does not start a browser. When another session already uses the browser profile, it also reports the profile directory, the owning process and the fix.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_profiles',
    description:
      'List the browser profiles of the selected engine and set the default profile for the next server start. "list" reports the engine, the available profiles (existing directories plus the pointer name), the current profile and its source, the default-profile pointer, the effective profile directory and the profile lock. "set-default" validates a profile name and writes it to the default-profile pointer next to the profiles; the change applies at the next server start, this session keeps its profile, and no browser is started. This is a local broker tool.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'set-default'],
          description: 'What to do: "list" (the default) reports profiles, "set-default" writes the pointer.',
        },
        name: {
          type: 'string',
          description:
            'Profile name for "set-default": letters, digits, ".", "_" or "-", starting with a letter or digit, up to 64 characters; "default" means the engine default. The change applies at the next server start.',
        },
      },
    },
  },
];

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

// The last non-empty stderr line a launcher wrote, bounded so a stack trace
// cannot bloat a status payload. Every engine reports it when its backend exits;
// the line is redacted before it is stored, so a proxy URL never appears.
function lastStderrLine(tail) {
  const lines = String(tail)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length === 0 ? null : lines[lines.length - 1].slice(0, 300);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function readPluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'));
    return nonEmptyString(manifest.version) ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

const BROKER_VERSION = readPluginVersion();

function usableEngineValue(value) {
  if (!nonEmptyString(value)) {
    return null;
  }
  const trimmed = value.trim();
  // An unsubstituted ${user_config.*} placeholder means the host did not resolve
  // the setting; fall through to the next source instead of rejecting the server.
  if (trimmed.includes('${')) {
    log(`ignoring unsubstituted engine placeholder: ${trimmed}`);
    return null;
  }
  return trimmed;
}

function resolveEngine(env) {
  const explicit = usableEngineValue(env.STEALTH_ENGINE);
  if (explicit !== null) {
    return { id: explicit, source: 'STEALTH_ENGINE' };
  }
  const legacy = usableEngineValue(env.PLAYWRIGHT_MCP_BROWSER_ENGINE);
  if (legacy !== null) {
    return { id: legacy, source: 'PLAYWRIGHT_MCP_BROWSER_ENGINE' };
  }
  return { id: DEFAULT_ENGINE, source: 'default' };
}

function parseDisabledTools(value) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

const selected = resolveEngine(process.env);
const loaded = loadEngineConfiguration({
  enginesDir: ENGINES_DIR,
  profilesFile: PROFILES_FILE,
  engineId: selected.id,
  launcherDir: PLUGIN_ROOT,
});
const engine = loaded.engine;
const profiles = loaded.profiles;
const native = isNativeContract(engine);
let contractSchemas = null;
let aliasIndex = null;
let engineError = loaded.error;
if (engineError === null && native) {
  const contractResult = loadContractSchemas(path.join(PLUGIN_ROOT, engine.contractSchemas));
  if (contractResult.error !== null) {
    engineError = contractResult.error;
  } else {
    contractSchemas = contractResult.schemas;
    aliasIndex = createAliasIndex(engine);
    if (aliasIndex.error !== null) {
      engineError = aliasIndex.error;
      aliasIndex = null;
    }
  }
}
if (engineError === null) {
  // A manifest's requiredEnv is machine-checkable: without it the engine can
  // never work, so fail at initialize instead of spawning a backend that
  // cannot answer. The reason is the manifest's own actionable sentence.
  const missingEnv = firstMissingRequiredEnv(engine, process.env);
  if (missingEnv !== null) {
    engineError = missingEnv;
  }
}

// The plugin data root the launchers use. ${CLAUDE_PLUGIN_DATA} is the only
// supported location; the home fallback matches launch.mjs exactly.
const PLUGIN_DATA_DIR =
  typeof process.env.CLAUDE_PLUGIN_DATA === 'string' && process.env.CLAUDE_PLUGIN_DATA.trim() !== ''
    ? path.resolve(process.env.CLAUDE_PLUGIN_DATA.trim())
    : path.join(homedir(), '.cloakbrowser-mcp-plugin');

// profile_isolation. "shared" (the default) is the behaviour before the setting
// existed: one profile per account, shared by every Claude Code session.
// "workspace" derives one profile per project folder, Playwright-style.
// "isolated" uses no profile at all: nothing is resolved, created or locked and
// nothing persists (2.11.0). "copy" resolves the base exactly like "shared",
// holds the base profile's lock for the session, starts the engine on a
// temporary whole-tree copy and discards it on a clean shutdown (2.12.0).
// "copy-keep" does the same and swaps the copy into the base path on a clean
// shutdown, keeping the old base as <base>.previous-<stamp> (2.13.0). An
// unsubstituted placeholder and an unknown value both mean "shared"; they are
// logged once and are never fatal.
const isolationSetting =
  typeof process.env.STEALTH_PROFILE_ISOLATION === 'string' ? process.env.STEALTH_PROFILE_ISOLATION : '';
const profileIsolation = resolveProfileIsolation(isolationSetting);
if (profileIsolation.placeholder !== null) {
  log(`ignoring unsubstituted profile-isolation placeholder: ${profileIsolation.placeholder.trim()}`);
}
if (profileIsolation.ignored !== null) {
  log(`ignoring unknown profile isolation: ${profileIsolation.ignored}`);
}
// An engine that owns its profile elsewhere, or attaches to one, declares
// profileApplies: false; the whole profile model is inert for it.
const profileApplies = engine !== null && manifestProfileApplies(engine);
// The mode itself, before the engine's profileApplies says whether it can act.
const isolatedMode = profileIsolation.mode === 'isolated';
// Both copy modes share everything except what a clean shutdown does with the
// session tree; `copyKeepMode` names the one that swaps.
const copyMode = isCopyIsolation(profileIsolation.mode);
const copyKeepMode = profileIsolation.mode === 'copy-keep';
// The mode's own name in every user-facing sentence, so "copy" text stays
// byte-identical and "copy-keep" never claims to be the other mode.
const copyModeLabel = profileIsolation.mode;

// The default-profile pointer (2.10.0). It is read once here, next to the
// profiles, and is only a candidate: resolveProfile applies it after profile_dir
// and account, so an explicit setting always wins. A missing pointer is the
// normal state; a broken one is reported and ignored, never fatal. The pointer
// itself is reported by browser_capabilities and browser_profiles whether or not
// it supplies this start's profile. An isolated start never uses it, so a broken
// pointer is not logged there (it would claim relevance it does not have); the
// meta-tools still report its state.
const profilePointer = profileApplies ? readProfileDefaultPointer(engine.id, PLUGIN_DATA_DIR) : null;
if (profilePointer !== null && profilePointer.error !== null && !isolatedMode) {
  log(profilePointer.error);
}

// One profile per account. Resolution runs once, before the backend starts, and
// its result feeds both the spawn environment and the meta-tools. With the
// account, profile_dir and profile_isolation settings unset it resolves to
// "default" and the broker sets nothing, so launch.mjs keeps applying
// profiles/default exactly as before. An unsubstituted placeholder is treated as
// unset, like the engine.
const rawAccount = typeof process.env.STEALTH_ACCOUNT === 'string' ? process.env.STEALTH_ACCOUNT : '';
if (rawAccount.includes('${')) {
  log(`ignoring unsubstituted account placeholder: ${rawAccount.trim()}`);
}
const profileResolution =
  engine === null
    ? {
        profileDir: null,
        defaultProfileDir: null,
        profileSource: null,
        account: null,
        accountApplies: false,
        ignored: [],
        error: null,
      }
    : resolveProfile({
        account: rawAccount,
        profileDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR,
        pointer: profilePointer === null ? null : profilePointer.name,
        engineId: engine.id,
        dataDir: PLUGIN_DATA_DIR,
        launcherName: resolveLauncherName(engine),
        ignoredSettings: Array.isArray(engine.ignoredSettings) ? engine.ignoredSettings : [],
        profileApplies,
        isolation: profileIsolation.mode,
        cwd: process.cwd(),
      });
// What an isolated start ignored, in the order the resolution checked it. A
// pointer file that exists but cannot be used has no name to pass, so the broker
// adds it here; the report is the same shape either way.
const profileIgnored =
  profileResolution.profileSource === 'isolated'
    ? [
        ...(profileResolution.ignored ?? []),
        ...(profilePointer !== null && profilePointer.exists === true && profilePointer.name === null
          ? [isolatedIgnoredEntry(ISOLATED_IGNORED_POINTER, profilePointer.path)]
          : []),
      ]
    : [];
if (profileIgnored.length > 0) {
  log(profileIgnoredReason(profileIgnored));
}
if (profileResolution.profileSource === 'pointer') {
  log(`using the default profile "${profilePointer.name}" from ${profilePointer.path}`);
}
if (rawAccount.trim() !== '' && !rawAccount.includes('${') && profileResolution.accountApplies === false) {
  const ownSetting = engine?.profileArgument?.setting;
  log(
    `the "${selected.id}" engine does not use account profiles; ` +
      (typeof ownSetting === 'string' && ownSetting.trim() !== ''
        ? `set "${ownSetting}" instead`
        : 'it uses its own profile settings'),
  );
}
if (engineError === null && profileResolution.error !== null) {
  engineError = profileResolution.error;
}

// profile_isolation=copy / copy-keep never silently degrades. An engine that owns
// its own profile (profileApplies: false) has no broker profile to copy, so the
// start is refused loudly instead of starting that engine some other way.
// ("isolated" is inert for such engines by contrast: it needs no profile at all.)
if (copyMode && engineError === null && engine !== null && !profileApplies) {
  engineError =
    `The "${selected.id}" engine manages its own browser profile, so profile_isolation "${copyModeLabel}" does not apply to it. ` +
    'Set "Profile isolation" (profile_isolation) to shared, or choose an engine that uses the plugin\'s ' +
    'profiles. The backend was not started.';
  log(engineError);
}

// Loud lock preflight. The bridge takes its exclusive profile lock at backend
// start-up, so starting a backend against a profile a live process owns only
// produces "Backend exited" and a two-tool surface. The broker reads the same
// lock file first (never writes, moves, copies or deletes a lock or a profile).
//   shared / account / profile_dir: a busy profile stops the spawn; the owner and
//                                   the fix are reported instead.
//   workspace:                      a busy derived profile moves to its first
//                                   free numbered sibling (-2 ... -5) and the
//                                   fallback is always reported.
//   isolated:                       no profile exists, so no lock is read at all.
let profileLock = null;
let profileFallback = null;
let engineProfileLock = null;
if (engineError === null && profileApplies && profileResolution.profileSource !== 'isolated') {
  const lockDir = effectiveProfileDir(profileResolution);
  if (lockDir !== null) {
    const lock = readProfileLock(lockDir);
    if (lockBlocksStart(lock)) {
      const workspaceProfile =
        profileIsolation.mode === 'workspace' && profileResolution.profileSource === 'workspace';
      const fallbackDir = workspaceProfile
        ? selectFallbackProfile(lockDir, (candidate) => lockBlocksStart(readProfileLock(candidate)))
        : null;
      if (fallbackDir !== null) {
        profileFallback = {
          from: lockDir,
          to: fallbackDir,
          reason: profileFallbackReason(lock, fallbackDir),
        };
        profileResolution.profileDir = fallbackDir;
        profileLock = readProfileLock(fallbackDir);
        log(profileFallback.reason);
      } else {
        profileLock = { ...lock, fix: profileLockFix(lock) };
        engineError = profileLockMessage(lock, { fallbackExhausted: workspaceProfile });
        if (copyMode) {
          // Copy mode never falls back to another profile: the base is either
          // safe to copy or the start is refused, loudly.
          engineError += ` Profile isolation is "${copyModeLabel}", so the base profile was not copied.`;
        }
        log(engineError);
      }
    } else {
      profileLock = { ...lock, fix: null };
      if (lock.state === 'stale') {
        log(
          `profile lock ${lock.path} is stale (pid ${lock.owner?.pid ?? 'unknown'} is gone); ` +
            'the backend reclaims it',
        );
      }
    }
    // An engine that declares its own lock file (Camoufox: Firefox's parent.lock)
    // gets a second, additive check. The bridge's lock missed it before, and a
    // busy Firefox profile is a 180 s hang or an exitCode=0 launch failure, so a
    // live owner stops the spawn with the same loud, actionable start. The file is
    // never written, moved or deleted; a stale one is reported and allowed.
    if (engineError === null && engine !== null && engine.profileLock !== undefined) {
      const engineOwnerLock = readEngineProfileLock(lockDir, engine.profileLock);
      engineProfileLock = { ...engineOwnerLock, fix: engineProfileLockFix(engineOwnerLock) };
      if (engineLockBlocksStart(engineOwnerLock)) {
        engineError = engineProfileLockMessage(engineOwnerLock);
        if (copyMode) {
          engineError += ` Profile isolation is "${copyModeLabel}", so the base profile was not copied.`;
        }
        log(engineError);
      } else if (engineOwnerLock.state === 'stale') {
        log(
          `engine profile lock ${engineOwnerLock.path} is stale (no live process holds it); ` +
            'the browser replaces it',
        );
      } else if (engineOwnerLock.state === 'unknown') {
        log(engineOwnerLock.error);
      }
    }
  }
}

// The profile directory an optional .proxy file sits beside: an account or
// workspace profile, or the default profile when the broker sets nothing.
function proxyCandidate() {
  const source = profileResolution.profileSource;
  if (source === 'account' || source === 'workspace' || source === 'pointer') {
    return profileResolution.profileDir;
  }
  return source === 'default' ? profileResolution.defaultProfileDir : null;
}

// The optional per-account proxy file. proxy_server wins when set; otherwise the
// file beside the resolved profile is read for a named account, for a workspace
// profile and for the default account (where it is used only when it exists).
// Engines whose manifest ignores profile_dir have no account profile, so no file
// is read. An isolated start has no profile either, so its account proxy file is
// not used; proxy_server still applies because a proxy is not profile state.
function resolveProxy() {
  const setting =
    typeof process.env.PLAYWRIGHT_MCP_PROXY_SERVER === 'string'
      ? process.env.PLAYWRIGHT_MCP_PROXY_SERVER.trim()
      : '';
  const candidate = proxyCandidate();
  if (setting !== '') {
    if (candidate !== null && existsSync(accountProxyPath(candidate))) {
      log('ignoring the account proxy file because the proxy_server setting is set');
    }
    return { source: 'setting', configured: true, value: null, error: null };
  }
  if (candidate === null) {
    return { source: 'none', configured: false, value: null, error: null };
  }
  const result = readAccountProxy(accountProxyPath(candidate));
  if (result.error !== null) {
    return { source: 'error', configured: false, value: null, error: result.error };
  }
  if (result.value !== null) {
    if (profileResolution.profileSource === 'account') {
      log(`using the account proxy file for account "${profileResolution.account}"`);
    } else if (profileResolution.profileSource === 'pointer') {
      log(
        `using the proxy file beside the profile named by the default-profile pointer (${profilePointer.name})`,
      );
    } else if (profileResolution.profileSource === 'workspace') {
      log('using the proxy file beside the workspace profile');
    } else {
      log('using the account proxy file beside the default profile');
    }
    return { source: 'account-file', configured: true, value: result.value, error: null };
  }
  return { source: 'none', configured: false, value: null, error: null };
}

const proxyResolution =
  engineError === null ? resolveProxy() : { source: 'none', configured: false, value: null, error: null };
if (engineError === null && proxyResolution.error !== null) {
  engineError = proxyResolution.error;
}

// The broker creates the resolved account, pointer or workspace directory (it
// never deletes, copies or migrates one). An explicit profile_dir is not created
// here: launch.mjs has always created it, and its bytes are unchanged. A pointer
// profile is created exactly like an account, so a pointer set before its first
// launch works on that launch. An isolated start creates nothing: it has no
// profile directory at all, and both launchers skip their default-profile
// creation while the engine's isolated switch is on.
if (
  engineError === null &&
  (profileResolution.profileSource === 'account' ||
    profileResolution.profileSource === 'workspace' ||
    profileResolution.profileSource === 'pointer')
) {
  try {
    mkdirSync(profileResolution.profileDir, { recursive: true });
  } catch (error) {
    const label =
      profileResolution.profileSource === 'workspace'
        ? 'workspace'
        : profileResolution.profileSource === 'pointer'
          ? 'default-profile'
          : 'account';
    engineError = `Cannot create the ${label} profile directory ${profileResolution.profileDir}: ${error.message}`;
  }
}

// profile_isolation=copy and copy-keep (2.12.0, 2.13.0). The preflight above
// proved the base has no live owner. From here the broker becomes the base's
// writer-owner for the session: it holds the bridge's own lock format (so a
// shared/workspace start, and the bridge itself, refuse the base), copies the
// base tree through the shared copy plan into
// profiles/<engine>/.sessions/<base>-<stamp>-<pid>, and starts the engine on that
// copy. The base is never written. Every failure is loud, releases the lock,
// removes only a partial copy, and leaves the base untouched; there is never a
// silent fallback to another profile. copy-keep also refuses a base outside the
// plugin data directory, because it replaces the base tree on a clean close.
let copySession = null;
// The lock handle this session holds on the base profile, or null. It is kept
// outside the reportable `copySession` object so no file identity leaks into a
// payload.
let copyBaseLockHandle = null;
function prepareCopySession() {
  const baseDir = effectiveProfileDir(profileResolution);
  if (baseDir === null) {
    engineError = `profile_isolation "${copyModeLabel}" could not resolve a base profile directory. The backend was not started.`;
    log(engineError);
    return null;
  }
  if (copyKeepMode && !isPathInsideRoot(baseDir, PLUGIN_DATA_DIR)) {
    // A whole-tree swap replaces the base, so it is only allowed on a profile
    // the plugin owns. "copy" stays allowed here: it never writes the base.
    engineError =
      `profile_isolation "copy-keep" replaces the base profile tree, so it can only run on a profile ` +
      `inside the plugin data directory (${PLUGIN_DATA_DIR}); the base profile ${baseDir} is outside it. ` +
      'Set "Profile directory" (profile_dir) to a path under the plugin data directory, or set ' +
      '"Profile isolation" (profile_isolation) to copy to run on a temporary copy without replacing the ' +
      'base. The backend was not started.';
    log(engineError);
    return null;
  }
  // The session copy lives under profiles/<engine>/.sessions. If the base
  // contains that directory (for example profile_dir pointing at the engine's
  // own profile folder), a whole-tree rename would move the session copy along
  // with the base, so copy-keep refuses before it takes a lock or copies
  // anything. "copy" is unaffected: it never renames the base.
  const sessionDir = sessionCopyDir(selected.id, PLUGIN_DATA_DIR, baseDir);
  if (copyKeepMode && isPathInsideRoot(sessionDir, baseDir)) {
    engineError =
      `profile_isolation "copy-keep" cannot replace the base profile ${baseDir} because it contains ` +
      `this session's copy directory ${sessionDir}. Set "Profile directory" (profile_dir) to a profile ` +
      "folder, not to the folder that holds the engine's profiles. The backend was not started.";
    log(engineError);
    return null;
  }
  let baseCreated = false;
  try {
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
      baseCreated = true;
    } else if (!statSync(baseDir).isDirectory()) {
      throw new Error('it is not a directory');
    }
  } catch (error) {
    engineError =
      `profile_isolation "${copyModeLabel}" cannot use the base profile ${baseDir}: ${error.message}. ` +
      'The backend was not started.';
    log(engineError);
    return null;
  }
  const held = createProfileLock(baseDir);
  if (!held.ok) {
    engineError =
      `profile_isolation "${copyModeLabel}" could not hold the base profile ${baseDir}: ${held.error} ` +
      'The backend was not started.';
    log(engineError);
    return null;
  }
  const engineLockFile =
    engine !== null && engine.profileLock !== undefined && typeof engine.profileLock.file === 'string'
      ? engine.profileLock.file
      : null;
  let plan;
  try {
    plan = planCopy(baseDir, { engineLockFile });
    copyPlanToTarget(plan, sessionDir, { targetName: path.basename(sessionDir) });
  } catch (error) {
    const released = releaseProfileLock(held);
    if (released.error !== null) {
      log(released.error);
    }
    engineError =
      `The ${copyModeLabel}-mode session copy failed: ${redactSecrets(error?.message ?? String(error))} ` +
      'The backend was not started.';
    log(engineError);
    return null;
  }
  log(
    `profile ${copyModeLabel}: base=${baseDir} copy=${sessionDir} files=${plan.files.length} ` +
      `bytes=${plan.bytes}${baseCreated ? ' baseCreated=true' : ''}`,
  );
  // Mark the copy as owned by this broker before the engine starts, so an
  // explicit --prune can never remove it in the window before the bridge writes
  // its own lock. A failed marker write is logged and does not stop the session:
  // the bridge lock takes over as soon as the backend starts.
  try {
    writeFileSync(
      path.join(sessionDir, SESSION_OWNER_FILENAME),
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), baseDir }, null, 2)}\n`,
    );
  } catch (error) {
    log(
      `profile ${copyModeLabel}: cannot write the session owner marker in ${sessionDir}: ${error.message}; ` +
        'the bridge lock protects the copy once the backend starts',
    );
  }
  copyBaseLockHandle = held;
  return {
    baseDir,
    sessionDir,
    baseCreated,
    baseLock: { path: held.path, owner: held.owner, reclaimed: held.reclaimed },
    copied: {
      files: plan.files.length,
      directories: plan.directories.length,
      bytes: plan.bytes,
    },
    discarded: false,
    // copy-keep only: the swap this session will attempt on a clean close. While
    // the session runs its state is "pending"; the result is written to the
    // engine's swap record and reported by the next browser_profiles call.
    swap: copyKeepMode ? { state: 'pending', previousDir: null, restored: false, error: null } : null,
  };
}
if (copyMode && engineError === null && profileApplies) {
  copySession = prepareCopySession();
}

// --- device identity (2.14.0) ----------------------------------------------
// The camouflage identity of a persistent Camoufox profile. Camoufox draws a new
// fingerprint on every launch unless the caller pins one, and its own code names
// the changing-fonts-under-identical-cookies pattern as a spoof tell
// (daijro/camoufox#442, #765, #378). The entry point (camoufox_entry.py) owns the
// file and the generated config because only it runs inside the engine venv; the
// broker reads the same file for the meta-tools and the initialize sentence.
// The setting is inert for every other engine: cloak pins its own Chromium seed,
// playwright and the native contract have no identity input, and the attach
// engine owns its own profiles. The manifests are deliberately not edited — each
// one feeds its engine's venv marker — so the inertness is reported from here and
// documented in the READMEs.
const IDENTITY_ENGINE_ID = 'camoufox';
const IDENTITY_MODE_DEFAULT = 'profile';
const IDENTITY_MODES = Object.freeze(['profile', 'random']);
const IDENTITY_FILE_NAME = '.camoufox-identity.json';
const IDENTITY_CONFIG_ENV_NAMES = ['CAMOUFOX_MCP_CONFIG', 'PLAYWRIGHT_MCP_CONFIG'];

function resolveIdentityMode(value) {
  const raw = typeof value === 'string' ? value : '';
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.includes('${')) {
    return {
      mode: IDENTITY_MODE_DEFAULT,
      placeholder: trimmed.includes('${') ? trimmed : null,
      ignored: null,
    };
  }
  const folded = trimmed.toLowerCase();
  if (IDENTITY_MODES.includes(folded)) {
    return { mode: folded, placeholder: null, ignored: null };
  }
  return { mode: IDENTITY_MODE_DEFAULT, placeholder: null, ignored: trimmed };
}

const identityModeResolution = resolveIdentityMode(process.env.STEALTH_IDENTITY_MODE);
if (identityModeResolution.placeholder !== null) {
  log(`ignoring unsubstituted identity-mode placeholder: ${identityModeResolution.placeholder}`);
}
if (identityModeResolution.ignored !== null) {
  log(`ignoring unknown identity mode: ${identityModeResolution.ignored}`);
}

// The profile directory the identity file lives in for this start: the same one
// the engine runs on, including the copy-mode session tree and a workspace
// fallback. Null when there is no profile (isolated, an engine that owns its
// own, or a failed resolution).
function identityProfileDirForStart() {
  if (!profileApplies || profileResolution.profileSource === 'isolated') {
    return null;
  }
  if (copyMode) {
    return copySession === null || copySession === undefined ? null : copySession.sessionDir;
  }
  return effectiveProfileDir(profileResolution);
}

// A user's own wrapper config. The entry merges our identity into a plugin-data
// copy when the file is a readable JSON object and leaves it untouched (today's
// behaviour) when it is INI or unreadable; the meta-tools must say the same, so
// they read the same variable and apply the same shape test.
function userIdentityConfigPath() {
  for (const name of IDENTITY_CONFIG_ENV_NAMES) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      return path.resolve(value.trim());
    }
  }
  return null;
}

function usableIdentityConfig(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  let config;
  try {
    config = JSON.parse(text.replace(/^﻿/u, ''));
  } catch {
    return false;
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return false;
  }
  const browser = config.browser;
  // null is "absent" for the entry too, so it is usable and gets filled in.
  if (browser !== undefined && browser !== null && (typeof browser !== 'object' || Array.isArray(browser))) {
    return false;
  }
  const options = browser === undefined || browser === null ? undefined : browser.camoufoxOptions;
  return (
    options === undefined || options === null || (typeof options === 'object' && !Array.isArray(options))
  );
}

// The minimum stored shape the entry also requires. A file that parses but has no
// usable fingerprint is corrupt and is regenerated on the next browser start.
function validStoredIdentity(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const fingerprint = value.fingerprint;
  const navigator = fingerprint?.navigator;
  const screen = fingerprint?.screen;
  if (navigator === null || typeof navigator !== 'object' || screen === null || typeof screen !== 'object') {
    return false;
  }
  return (
    typeof navigator.userAgent === 'string' &&
    navigator.userAgent.trim() !== '' &&
    Number.isFinite(screen.width) &&
    screen.width > 0 &&
    Number.isFinite(screen.height) &&
    screen.height > 0
  );
}

function readStoredIdentity(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'missing' : 'corrupt', createdAt: null, regeneratedAt: null };
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/u, ''));
  } catch {
    return { state: 'corrupt', createdAt: null, regeneratedAt: null };
  }
  if (!validStoredIdentity(data)) {
    return { state: 'corrupt', createdAt: null, regeneratedAt: null };
  }
  const createdAt =
    typeof data.createdAt === 'string' && data.createdAt.trim() !== '' ? data.createdAt : null;
  const regeneratedAt =
    typeof data.regeneratedAt === 'string' && data.regeneratedAt.trim() !== '' ? data.regeneratedAt : null;
  return { state: 'present', createdAt, regeneratedAt };
}

const IDENTITY_RANDOM_NOTE =
  'Device identity: identity_mode is "random", so each browser start draws a new one.';
const IDENTITY_ISOLATED_NOTE =
  'Device identity: this isolated start has no profile and draws a new one each time.';
const IDENTITY_NATIVE_NOTE =
  'Device identity: this native engine (mcp-camoufox 0.4.5) has no fingerprint input, so each browser start draws a new one; identity_mode has no effect.';
const IDENTITY_NOT_APPLICABLE_NOTE =
  'Device identity: identity_mode applies only to the camoufox engine; this engine has no generated identity file, so the setting has no effect.';

// The identity facts for this start, computed once. The created-at value and the
// corrupt/regenerated note are read fresh by identityReport(), because the entry
// creates or regenerates the file when the backend starts.
function identityFacts() {
  const mode = identityModeResolution.mode;
  if (native) {
    return { mode, applies: false, source: 'native-unavailable', file: null, note: IDENTITY_NATIVE_NOTE };
  }
  if (engine === null || engine.id !== IDENTITY_ENGINE_ID) {
    return { mode, applies: false, source: 'not-applicable', file: null, note: IDENTITY_NOT_APPLICABLE_NOTE };
  }
  if (profileResolution.profileSource === 'isolated') {
    return { mode, applies: true, source: 'isolated', file: null, note: IDENTITY_ISOLATED_NOTE };
  }
  if (mode === 'random') {
    return { mode, applies: true, source: 'random', file: null, note: IDENTITY_RANDOM_NOTE };
  }
  if (copyMode && (copySession === null || copySession === undefined)) {
    return {
      mode,
      applies: true,
      source: 'random',
      file: null,
      note: 'Device identity: no copy session started, so this start has no identity file.',
    };
  }
  const theirs = userIdentityConfigPath();
  if (theirs !== null && !usableIdentityConfig(theirs)) {
    return {
      mode,
      applies: true,
      source: 'random',
      file: null,
      note:
        `Device identity: the config file ${theirs} is INI or unreadable, so it is left untouched and ` +
        'identity_mode is not applied on this start.',
    };
  }
  const dir = identityProfileDirForStart();
  if (dir === null) {
    return {
      mode,
      applies: true,
      source: 'random',
      file: null,
      note: 'Device identity: no profile directory was resolved, so this start draws a new one.',
    };
  }
  return {
    mode,
    applies: true,
    source: 'profile-file',
    file: path.join(dir, IDENTITY_FILE_NAME),
    note: null,
  };
}

const identityState = identityFacts();

// The additive payload keys every engine gains. identityFile and
// identityCreatedAt are null unless a profile file is actually used, and
// identityNote appears only when there is something honest to say (inert engine,
// random mode, isolation, or a corrupt/regenerated file).
function identityReport() {
  const report = {
    identityMode: state.identity.mode,
    identityApplies: state.identity.applies,
    identitySource: state.identity.source,
    identityFile: state.identity.file,
    identityCreatedAt: null,
  };
  let note = state.identity.note;
  if (state.identity.file !== null) {
    const stored = readStoredIdentity(state.identity.file);
    if (stored.state === 'present') {
      report.identityCreatedAt = stored.createdAt;
      if (stored.regeneratedAt !== null) {
        note = `Device identity: the identity file was corrupt and was regenerated at ${stored.regeneratedAt}.`;
      }
    } else if (stored.state === 'corrupt') {
      note = `Device identity: the identity file ${state.identity.file} is unreadable, so the next browser start removes it and draws a new identity.`;
    }
  }
  return note === null ? report : { ...report, identityNote: note };
}

// One sentence for initialize.instructions, only for the engine that can pin, so
// every other engine's handshake text stays byte-identical.
function identitySentence() {
  if (state.identity.applies !== true) {
    return '';
  }
  if (state.identity.source === 'isolated') {
    return IDENTITY_ISOLATED_NOTE;
  }
  if (state.identity.mode === 'random') {
    return IDENTITY_RANDOM_NOTE;
  }
  if (state.identity.file === null) {
    return state.identity.note ?? '';
  }
  return (
    `Device identity: this profile keeps one device identity across launches (identity_mode "profile", file ` +
    `${state.identity.file}); delete that file to draw a new one on the next start.`
  );
}

const runtimeHint = runtimeErrorHint(engine, process.env);
const profileSelection = resolveToolProfile(process.env.STEALTH_TOOL_PROFILE, engine, profiles);

// --- server heartbeat timeout (2.14.1) --------------------------------------
// The camoufox wrapper (camoufox-playwright-mcp 0.1.5) pings its client every
// 3 s and closes the browser and the session when an answer is more than 5 s
// late (mcp/server.py:332-380; 0 disables the middleware, :105-107). One late
// answer was enough to lose the browser, so the launcher now passes 0 unless the
// ping_timeout_ms setting or an explicit operator value says otherwise; the
// resolution lives in one shared helper so the launcher's child environment and
// this report can never disagree. A value that cannot be used becomes 0 and is
// reported (the launcher also logs it once). The setting is inert for every
// other engine — they send no server heartbeat — and they say so.
const pingTimeoutState = resolvePingTimeout(process.env);
const PING_TIMEOUT_NOT_APPLICABLE_NOTE =
  'Ping timeout: ping_timeout_ms applies only to the camoufox engine; this engine sends no server heartbeat ping, so the setting has no effect.';

// The additive keys every engine gains: whether the setting applies, the
// effective deadline, where it came from (env, setting or default) and whether
// the wrapper heartbeat runs at all (false at 0). The note appears only when
// there is something honest to say: an engine the setting cannot reach, or a
// supplied value that was ignored.
function pingTimeoutReport() {
  if (native || engine === null || engine.id !== PING_TIMEOUT_ENGINE_ID) {
    return {
      pingTimeoutApplies: false,
      pingTimeoutMs: null,
      pingTimeoutSource: null,
      heartbeatEnabled: null,
      pingTimeoutNote: PING_TIMEOUT_NOT_APPLICABLE_NOTE,
    };
  }
  const problemNote = pingTimeoutProblemNote(pingTimeoutState);
  return {
    pingTimeoutApplies: true,
    pingTimeoutMs: pingTimeoutState.ms,
    pingTimeoutSource: pingTimeoutState.source,
    heartbeatEnabled: pingTimeoutState.ms > 0,
    ...(problemNote === null ? {} : { pingTimeoutNote: problemNote }),
  };
}

// --- saved logins and autofill (2.15.0) --------------------------------------
// The `password_manager` setting. The pinned Camoufox build locks Firefox's
// login manager off through its own enterprise policy, so enabling it needs a
// managed per-user policy file written by the camoufox launcher (the only
// surgical route; see lib/password-manager.mjs). The broker never writes it: it
// reports the launcher's ownership record and the store's *file existence* only.
// Off (the default) adds no key to any payload, so every engine stays
// byte-identical; on, the applying engine reports what happened and the engines
// that cannot apply it say so.
const passwordManagerResolution = resolvePasswordManager(process.env);

// The profile's Firefox login store: file existence only, never opened. A copy
// start reports the session copy's store (it is copied with the profile); an
// isolated start has no profile and reports missing.
function passwordStoreState() {
  if (!profileApplies || profileResolution.profileSource === 'isolated') {
    return 'missing';
  }
  const dir = identityProfileDirForStart();
  return dir !== null && hasFirefoxLoginStore(dir) ? 'firefox-logins-db-present' : 'missing';
}

function passwordBlockedNote(status) {
  if (status === 'blocked-by-existing-policy') {
    return 'Saved logins: a per-user policy file written by something else is present at the Firefox policy path, so it is left untouched and the setting stays off for this start.';
  }
  return 'Saved logins: the per-user policy file could not be derived from the Camoufox build policy, so the setting stays off for this start.';
}

// The additive keys, only when the setting is on. `passwordManagerEnabled` is
// the effective value for this start, `passwordManagerApplies` says whether the
// engine can honour it, and `passwordManagerSource` says what happened:
// "setting" (the managed file is in use), "default" (nothing applied yet or an
// engine without the mechanism), "native-unavailable" (mcp-camoufox has no prefs
// input), "blocked-by-existing-policy" or "blocked-by-build-policy". The note
// appears only when there is something honest to say.
function passwordManagerFacts() {
  if (!passwordManagerResolution.enabled) {
    return null;
  }
  if (native) {
    return {
      passwordManagerEnabled: false,
      passwordManagerApplies: false,
      passwordManagerSource: 'native-unavailable',
      passwordManagerPolicyFile: null,
      passwordManagerStore: null,
      passwordManagerNote: PASSWORD_MANAGER_NATIVE_NOTE,
    };
  }
  if (engine === null || engine.id !== PASSWORD_MANAGER_ENGINE_ID) {
    return {
      passwordManagerEnabled: false,
      passwordManagerApplies: false,
      passwordManagerSource: 'default',
      passwordManagerPolicyFile: null,
      passwordManagerStore: null,
      passwordManagerNote: PASSWORD_MANAGER_NOT_APPLICABLE_NOTE,
    };
  }
  const facts = {
    passwordManagerEnabled: false,
    passwordManagerApplies: true,
    passwordManagerSource: 'default',
    passwordManagerPolicyFile: null,
    passwordManagerStore: passwordStoreState(),
  };
  const configProblem = passwordUserConfigProblem(process.env);
  if (configProblem !== null) {
    return { ...facts, passwordManagerNote: configProblem };
  }
  const record = readPasswordPolicyRecord(PLUGIN_DATA_DIR);
  if (record === null) {
    return { ...facts, passwordManagerNote: PASSWORD_MANAGER_PENDING_NOTE };
  }
  if (record.status === 'blocked-by-existing-policy' || record.status === 'blocked-by-build-policy') {
    return {
      ...facts,
      passwordManagerSource: record.status,
      passwordManagerPolicyFile:
        record.status === 'blocked-by-existing-policy' && typeof record.policyFile === 'string'
          ? record.policyFile
          : null,
      passwordManagerNote:
        typeof record.note === 'string' && record.note !== ''
          ? record.note
          : passwordBlockedNote(record.status),
    };
  }
  if (record.status !== 'applied') {
    return { ...facts, passwordManagerNote: PASSWORD_MANAGER_PENDING_NOTE };
  }
  const file = typeof record.policyFile === 'string' && record.policyFile !== '' ? record.policyFile : null;
  if (file !== null && existsSync(file)) {
    const hash = sha256File(file);
    if (typeof record.contentHash === 'string' && hash === record.contentHash) {
      return {
        ...facts,
        passwordManagerEnabled: true,
        passwordManagerSource: 'setting',
        passwordManagerPolicyFile: file,
      };
    }
    if (typeof record.probeHash === 'string' && hash === record.probeHash) {
      return {
        ...facts,
        passwordManagerNote:
          'Saved logins: the per-user policy file holds the temporary verification document of an interrupted ' +
          'start; the next Camoufox start rewrites it before the setting is used.',
      };
    }
    return {
      ...facts,
      passwordManagerSource: 'blocked-by-existing-policy',
      passwordManagerNote:
        `Saved logins: ${file} no longer matches the file this plugin wrote, so it is left untouched and the ` +
        'setting stays off for this start.',
    };
  }
  return { ...facts, passwordManagerNote: PASSWORD_MANAGER_PENDING_NOTE };
}

function passwordManagerReport() {
  const facts = passwordManagerFacts();
  return facts === null ? {} : facts;
}

// One sentence for initialize.instructions, only for the applying engine and only
// when the setting is on, so every other engine's handshake text stays
// byte-identical.
function passwordManagerSentence() {
  if (!passwordManagerResolution.enabled || engine === null || engine.id !== PASSWORD_MANAGER_ENGINE_ID) {
    return '';
  }
  const facts = passwordManagerFacts();
  if (facts === null) {
    return '';
  }
  if (facts.passwordManagerSource === 'setting') {
    return PASSWORD_MANAGER_APPLIED_SENTENCE;
  }
  if (
    facts.passwordManagerSource === 'blocked-by-existing-policy' ||
    facts.passwordManagerSource === 'blocked-by-build-policy'
  ) {
    return facts.passwordManagerNote ?? '';
  }
  return '';
}

// Artifact directory policy (2.10.1). Upstream's file-access allowlist is
// [output directory, workspace root], and through the Cloak bridge the client's
// roots never reach the backend, so both values fall back to the MCP server's
// working directory. browser_capabilities therefore reports the cwd, the
// effective output directory and the client's roots: without them a denied
// screenshot ("File access denied: ... outside allowed roots") is unexplainable.
//
// The directory itself follows one policy, in order:
//   1. an explicit output_dir always wins and is resolved against the server
//      cwd, exactly as the bridge resolves it;
//   2. with no setting, .playwright-mcp inside the client's first usable file://
//      root, so auto-named artifacts land next to the project the client opened;
//   3. with no setting and no usable file root, <plugin data>/output/<engine>,
//      which is one known writable place per engine and survives a change of
//      working directory.
// An engine whose manifest lists output_dir in ignoredSettings keeps its own
// model and reports null. Nothing here reads or creates a directory: the engine
// creates the directory it is given when it first needs it.
const SERVER_CWD = process.cwd();
const outputDirSetting = (() => {
  const raw =
    typeof process.env.PLAYWRIGHT_MCP_OUTPUT_DIR === 'string'
      ? process.env.PLAYWRIGHT_MCP_OUTPUT_DIR.trim()
      : '';
  if (raw === '') {
    return null;
  }
  if (raw.includes('${')) {
    log(`ignoring unsubstituted output_dir placeholder: ${raw}`);
    return null;
  }
  return raw;
})();
const outputDirIgnoredByEngine =
  engine !== null && Array.isArray(engine.ignoredSettings) && engine.ignoredSettings.includes('output_dir');
const OUTPUT_DIR_SOURCE =
  outputDirIgnoredByEngine === true ? 'engine' : outputDirSetting === null ? 'default' : 'setting';
// The plugin-data fallback, named in the instructions sentence and used when the
// client offers no usable file root.
const PLUGIN_DATA_OUTPUT_DIR = path.join(PLUGIN_DATA_DIR, 'output', selected.id);
// The effective directory and its provenance. "setting" and "engine" are known
// at startup; "default" needs the client's roots, which only exist after it has
// sent initialize, so it is resolved exactly once by resolveOutputDir() before
// the backend starts (see the deferred start below).
let outputDirState =
  OUTPUT_DIR_SOURCE === 'engine'
    ? { resolved: true, dir: null, branch: 'engine', rootUri: null, rootPath: null }
    : OUTPUT_DIR_SOURCE === 'setting'
      ? {
          resolved: true,
          dir: path.resolve(SERVER_CWD, outputDirSetting),
          branch: 'setting',
          rootUri: null,
          rootPath: null,
        }
      : { resolved: false, dir: null, branch: null, rootUri: null, rootPath: null };

// The first root the client advertises as a usable file:// directory. A non-file
// root (https:, in-memory names) is skipped, and a file URI that fileURLToPath
// rejects is skipped rather than guessed at, so a malformed entry cannot send
// artifacts somewhere unintended. Windows drive letters and percent-encoded
// names are what fileURLToPath is for; the path it returns is the native one.
function firstFileRootPath(roots) {
  if (!Array.isArray(roots)) {
    return null;
  }
  for (const entry of roots) {
    if (entry === null || typeof entry !== 'object' || typeof entry.uri !== 'string') {
      continue;
    }
    let rootPath;
    try {
      const url = new URL(entry.uri);
      if (url.protocol !== 'file:') {
        continue;
      }
      rootPath = fileURLToPath(url);
    } catch {
      continue;
    }
    if (nonEmptyString(rootPath)) {
      return { uri: entry.uri, path: rootPath };
    }
  }
  return null;
}

// Resolve the "default" source once. It reuses the cached roots probe, so the
// client is asked at most once per session; a client that declared no roots,
// refused, answered a malformed payload or stayed silent takes the plugin-data
// fallback after the probe's 2 s bound. Callers await this before the backend
// starts, so every later read of outputDirState is synchronous.
function resolveOutputDir() {
  if (outputDirState.resolved || OUTPUT_DIR_SOURCE !== 'default') {
    return Promise.resolve(outputDirState);
  }
  return clientRootsResult().then((roots) => {
    if (outputDirState.resolved) {
      return outputDirState;
    }
    const root = firstFileRootPath(roots.roots);
    if (root !== null) {
      outputDirState = {
        resolved: true,
        dir: path.join(root.path, '.playwright-mcp'),
        branch: 'client-root',
        rootUri: root.uri,
        rootPath: root.path,
      };
      log(`artifact directory from the client's first file root: ${outputDirState.dir}`);
    } else {
      outputDirState = {
        resolved: true,
        dir: PLUGIN_DATA_OUTPUT_DIR,
        branch: 'plugin-data',
        rootUri: null,
        rootPath: null,
      };
      log(`artifact directory from plugin data (no usable client file root): ${outputDirState.dir}`);
    }
    return outputDirState;
  });
}

// One sentence for every initialize handshake the broker returns. It names the
// directory artifacts go to and how to change it, and when a default was
// applied it says which one, so the text never claims the setting is in force
// when it is empty.
function artifactDirectorySentence() {
  if (OUTPUT_DIR_SOURCE === 'engine') {
    return "This engine manages its own artifact files, so the plugin's output_dir setting does not apply to it.";
  }
  if (OUTPUT_DIR_SOURCE === 'setting') {
    return (
      `Browser artifacts (screenshots, traces, downloads) go to ${outputDirState.dir} from the output_dir setting; ` +
      `set that setting to change it, and while it is empty they default to .playwright-mcp inside the client's ` +
      `first file root, or to ${PLUGIN_DATA_OUTPUT_DIR} when no file root is available.`
    );
  }
  if (!outputDirState.resolved) {
    // Defensive: every path that answers initialize resolves the value first.
    return (
      "Browser artifacts (screenshots, traces, downloads) default to .playwright-mcp inside the client's first " +
      `file root, or to ${PLUGIN_DATA_OUTPUT_DIR} when no file root is available, because the output_dir setting ` +
      'is empty; set that setting to change it.'
    );
  }
  if (outputDirState.branch === 'client-root') {
    return (
      `Browser artifacts (screenshots, traces, downloads) go to ${outputDirState.dir} because the output_dir ` +
      `setting is empty and the client's first file root is ${outputDirState.rootPath}; set that setting to change it.`
    );
  }
  return (
    `Browser artifacts (screenshots, traces, downloads) go to ${outputDirState.dir} because the output_dir ` +
    'setting is empty and no file root was available from the client; set that setting to change it.'
  );
}

if (profileSelection.placeholder !== null) {
  log(`ignoring unsubstituted tool-profile placeholder: ${profileSelection.placeholder}`);
}
if (profileSelection.ignored !== null) {
  log(`ignoring unknown tool profile: ${profileSelection.ignored}`);
}
for (const warning of loaded.warnings) {
  log(warning);
}

const ENGINE_CHANGE_HELP = engineChangeHelp(loaded.engineIds);

const state = {
  engineId: selected.id,
  engineSource: selected.source,
  engine,
  engineError,
  engineChoices: loaded.engineIds,
  profiles,
  native,
  aliasIndex,
  contractSchemas,
  nativeSurface: null,
  nativeSurfaceError: null,
  toolProfile: profileSelection.profile,
  toolProfileSource: profileSelection.source,
  requestedToolProfile: profileSelection.requested,
  disabled: parseDisabledTools(process.env.CLOAK_DISABLED_TOOLS),
  // Profile state. `dir` is set only when the broker resolved an account or a
  // workspace and must set PLAYWRIGHT_MCP_USER_DATA_DIR itself; `appliedProxy` is
  // the file proxy to inject into the spawn environment. The lock/fallback facts
  // describe this start and are reported additively by the meta-tools. An
  // isolated start has `dir: null`, `isolated: true`, no lock, and the settings it
  // ignored in `ignored` (reported by the meta-tools).
  profile: {
    account: profileResolution.account,
    dir:
      copySession !== null
        ? copySession.sessionDir
        : profileResolution.profileSource === 'account' ||
            profileResolution.profileSource === 'workspace' ||
            profileResolution.profileSource === 'pointer'
          ? profileResolution.profileDir
          : null,
    source: profileResolution.profileSource,
    // True only for profile_isolation=isolated on an engine that uses the
    // broker's profile model; the spawn environment and both launchers key on it.
    isolated: profileResolution.profileSource === 'isolated',
    // The copy-mode session (2.12.0), or null. Present only when the base was
    // locked and copied; every later report reads it additively.
    copy: copySession,
    ignored: profileIgnored,
    applies: profileResolution.accountApplies,
    defaultDir: profileResolution.defaultProfileDir,
    error: profileResolution.error,
    isolation: profileIsolation.mode,
    isolationSource: profileIsolation.source,
    appliesToEngine: profileApplies,
    lock: profileLock,
    // The engine's own lock (manifest "profileLock"). Always null for an engine
    // that declares none, and then no payload key is added.
    engineLock: engineProfileLock,
    fallback: profileFallback,
    // The default-profile pointer as read at start: { path, exists, name, state,
    // error }, or null for an engine whose profile the broker does not own. It is
    // reported whether or not it supplied this start's profile.
    pointer: profilePointer,
  },
  // Device identity (2.14.0): the resolved mode and the file this start would
  // use. The created-at value and corruption notes are read by identityReport().
  identity: identityState,
  proxy: {
    source: proxyResolution.source,
    configured: proxyResolution.configured,
    appliedProxy: proxyResolution.value,
    error: proxyResolution.error,
  },
  child: null,
  spawnedAt: null,
  initializeAnsweredAt: null,
  requestedProtocolVersion: null,
  // Whether the client's initialize request declared the MCP roots capability
  // (true), declared none (false) or has not initialized yet (null). The roots
  // probe reads it: a server does not request an undeclared capability, and the
  // capability is reported as the reason instead.
  clientRootsDeclared: null,
  initializeAnswered: false,
  // A backend can refuse the initialize handshake and still answer tools/list
  // and tool calls (the Camoufox wrapper did before plugin 2.9.2). These flags
  // keep the status honest without changing the normal path: initializeRejected
  // is reported additively, and backendAnswered stops waitMs growing once the
  // backend has answered anything at all.
  initializeRejected: false,
  backendAnswered: false,
  serverInfo: null,
  backendCapabilities: null,
  backendTools: [],
  toolsListed: false,
  lastExposedCount: null,
  lastToolsListWaitMs: null,
  lastError: engineError,
  stderrTail: '',
  toolCallSucceeded: false,
  // Set when the backend reports a failure that a manifest-declared system
  // dependency can explain. Only engines that declare dependencies read it, so
  // every other engine's payloads stay byte-identical.
  systemDependencyMissing: false,
  shuttingDown: false,
  backend: {
    state: engineError === null ? 'idle' : 'failed',
    pid: null,
    exitCode: null,
    exitSignal: null,
  },
  pendingRequests: new Map(),
  hiddenByManifest: new Set(),
  hiddenByCollision: new Set(),
  hiddenByProfile: new Set(),
};

function supportFor(toolName) {
  if (state.native) {
    if (state.aliasIndex === null) {
      return 'unknown';
    }
    return classifyExposedTool(state.aliasIndex, state.engine, toolName).support ?? 'unknown';
  }
  return manifestSupport(state.engine, toolName);
}

// The profile name injected into every native call, except the tools the
// manifest's profileArgument.except names. The setting is read from the
// environment once per call so a host restart is the only way it changes.
function nativeProfileValue() {
  const spec = state.engine?.profileArgument;
  if (spec === null || typeof spec !== 'object') {
    return null;
  }
  const raw = typeof spec.env === 'string' ? process.env[spec.env] : undefined;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value !== '') {
    return value;
  }
  return typeof spec.default === 'string' && spec.default.trim() !== '' ? spec.default.trim() : null;
}

// A prefixed name is only known when the backend listed that native tool. Before
// the first tools/list, the manifest's native-only classification is the proof.
function unknownNativeToolReason(name) {
  if (state.aliasIndex === null) {
    return null;
  }
  const classification = classifyExposedTool(state.aliasIndex, state.engine, name);
  if (classification.kind === 'unknown') {
    return `Unknown tool "${name}" for the "${state.engineId}" engine. Call browser_capabilities to see the canonical and prefixed names this engine exposes.`;
  }
  if (classification.kind !== 'native-only') {
    return null;
  }
  if (state.nativeSurface !== null) {
    return state.nativeSurface.backendNatives.has(classification.native)
      ? null
      : `Unknown native tool "${classification.native}" for the "${state.engineId}" engine; the backend did not list it.`;
  }
  const rules = state.engine?.toolSupport;
  return rules !== null && typeof rules === 'object' && Object.hasOwn(rules, classification.native)
    ? null
    : `Unknown native tool "${classification.native}" for the "${state.engineId}" engine; the manifest does not classify it.`;
}

// The effective profile is the active manifest's default unless the user set
// tool_profile. Filtering runs after the backend's own list and after the seven
// tool-group switches have shaped it.
function profileAllowsTool(toolName) {
  return profileAllows(state.toolProfile, state.profiles, toolName, supportFor(toolName));
}

function backendAlive() {
  const child = state.child;
  return child !== null && child.exitCode === null && child.signalCode === null;
}

function backendDescription() {
  if (state.engineError !== null) {
    return `backend unavailable: ${state.engineError}`;
  }
  if (state.backend.state === 'failed' || state.backend.state === 'exited') {
    return `backend is not running (${state.backend.state})${state.lastError === null ? '' : `: ${state.lastError}`}`;
  }
  if (!backendAlive()) {
    return `backend is not running (${state.backend.state})${state.lastError === null ? '' : `: ${state.lastError}`}`;
  }
  if (state.backend.state === 'starting') {
    return 'backend is still starting (the MCP handshake has not completed)';
  }
  return 'backend is running';
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function sendToolError(id, text) {
  sendResult(id, { content: [{ type: 'text', text }], isError: true });
}

function sendToolPayload(id, payload) {
  sendResult(id, {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  });
}

// --- MCP client roots probe (2.9.5) -----------------------------------------
// The client's roots are the other half of the file-access allowlist, and
// through the Cloak bridge they never reach the backend. The broker asks the
// client once, lazily: the first browser_capabilities call sends one
// server->client roots/list request under this id and waits at most 2 s. Any
// answer (roots, an error such as -32601, a malformed payload, silence) is
// cached for the life of the process; silence becomes null plus a short reason.
// The probe never runs at startup, never delays initialize or tools/list, and
// never changes tool filtering. A client that did not declare the roots
// capability is not asked at all (MCP: a server does not request an undeclared
// capability), so that call answers immediately with the reason.
const ROOTS_PROBE_TIMEOUT_MS = 2000;
const ROOTS_PROBE_ID = 'cloakbrowser-broker-roots';

const clientRootsProbe = {
  state: 'idle', // idle | pending | done
  result: null, // { roots: Array|null, error: string|null }
  timer: null,
  waiters: [],
};

function finishClientRootsProbe(result) {
  if (clientRootsProbe.state === 'done') {
    return;
  }
  clientRootsProbe.state = 'done';
  clientRootsProbe.result = result;
  if (clientRootsProbe.timer !== null) {
    clearTimeout(clientRootsProbe.timer);
    clientRootsProbe.timer = null;
  }
  const waiters = clientRootsProbe.waiters.splice(0);
  for (const waiter of waiters) {
    waiter();
  }
  log(
    result.roots === null
      ? `client roots unavailable: ${String(result.error)}`
      : `client roots: ${result.roots.length}`,
  );
}

// The protocol carries { uri, name? }. Only those two fields are reported; an
// entry without a string uri is dropped rather than guessed at.
function normalizeClientRoots(roots) {
  const normalized = [];
  for (const entry of roots) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    if (typeof entry.uri !== 'string' || entry.uri === '') {
      continue;
    }
    normalized.push(
      typeof entry.name === 'string' && entry.name !== ''
        ? { uri: entry.uri, name: entry.name }
        : { uri: entry.uri },
    );
  }
  return normalized;
}

function startClientRootsProbe() {
  if (state.clientRootsDeclared === false) {
    finishClientRootsProbe({ roots: null, error: 'the client did not advertise the roots capability' });
    return;
  }
  clientRootsProbe.state = 'pending';
  writeMessage({ jsonrpc: '2.0', id: ROOTS_PROBE_ID, method: 'roots/list' });
  clientRootsProbe.timer = setTimeout(() => {
    finishClientRootsProbe({ roots: null, error: `no answer within ${ROOTS_PROBE_TIMEOUT_MS} ms` });
  }, ROOTS_PROBE_TIMEOUT_MS);
}

function clientRootsResult() {
  if (clientRootsProbe.state === 'done') {
    return Promise.resolve(clientRootsProbe.result);
  }
  return new Promise((resolve) => {
    clientRootsProbe.waiters.push(() => resolve(clientRootsProbe.result));
    if (clientRootsProbe.state === 'idle') {
      startClientRootsProbe();
    }
  });
}

// The answer to the broker's own request, matched by id in the client line
// reader. It is never relayed to the backend, which has no request with this id.
function handleClientRootsAnswer(message) {
  if (clientRootsProbe.state !== 'pending') {
    return; // a late answer after the timeout is dropped
  }
  if (message.error !== undefined && message.error !== null) {
    const error = message.error;
    const detail =
      typeof error.message === 'string' && error.message !== '' ? error.message : 'unknown error';
    const code = typeof error.code === 'number' ? `${error.code}: ` : '';
    finishClientRootsProbe({ roots: null, error: `${code}${detail}` });
    return;
  }
  const roots = message.result?.roots;
  if (!Array.isArray(roots)) {
    finishClientRootsProbe({ roots: null, error: 'malformed roots/list response' });
    return;
  }
  finishClientRootsProbe({ roots: normalizeClientRoots(roots), error: null });
}

// --- deferred backend start (2.10.1) ----------------------------------------
// When the artifact directory depends on the client's roots, the backend cannot
// start at process start: PLAYWRIGHT_MCP_OUTPUT_DIR is read from the child
// environment at its first breath, and the roots exist only after the client has
// sent initialize. Until the value is resolved every client line is buffered in
// arrival order and replayed once the backend is up, so the relay stays
// byte-for-byte and no request is lost. The answer to the broker's own roots
// probe is the one line that is never buffered: it is consumed above. A client
// that answers at once makes the wait a few milliseconds; one that stays silent
// costs the probe's 2 s bound and takes the plugin-data default.
//
// Two kinds of line are not initialize: a notification, and the 2026-era
// `server/discover` era probe that a current client sends immediately before
// initialize (observed from Claude Code 2.1.310). Both are buffered, because a
// conforming client either does not wait for them or sends initialize at once,
// and because answering discover would need the backend whose environment is
// what is being decided. Any *other* request before initialize comes from a
// client that will never give us roots: the safe plugin-data default is used,
// the backend starts, and the request is replayed exactly as before.
const deferredStart = { lines: [], started: false };

function outputDirUnresolved() {
  return !outputDirState.resolved;
}

function replayBufferedClientLines() {
  const lines = deferredStart.lines.splice(0);
  for (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Preserve the old proxy behaviour for non-JSON input: pass it through.
      if (!forwardToBackend(line)) {
        log('dropped non-JSON client line because the backend is unavailable');
      }
      continue;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      log('dropped client line that is not a JSON-RPC object');
      continue;
    }
    if (message.method === undefined && message.id === ROOTS_PROBE_ID) {
      handleClientRootsAnswer(message);
      continue;
    }
    handleClientRequest(message, line);
  }
}

function startBackendIfNeeded() {
  if (state.shuttingDown) {
    return;
  }
  if (state.child === null) {
    startBackend();
  }
  replayBufferedClientLines();
}

function beginDeferredStart() {
  if (deferredStart.started) {
    return;
  }
  deferredStart.started = true;
  resolveOutputDir().then(startBackendIfNeeded);
}

// A request arrived before any initialize: there is no client roots statement to
// wait for, so the fallback applies immediately and the request is answered.
function beginDeferredStartWithoutRoots(method) {
  if (deferredStart.started) {
    return;
  }
  deferredStart.started = true;
  outputDirState = {
    resolved: true,
    dir: PLUGIN_DATA_OUTPUT_DIR,
    branch: 'plugin-data',
    rootUri: null,
    rootPath: null,
  };
  log(`artifact directory from plugin data ("${String(method)}" arrived before initialize)`);
  startBackendIfNeeded();
}

function metaToolList() {
  return META_TOOLS.map((tool) => ({ ...tool }));
}

function backendToolNames() {
  return state.backendTools.map((tool) => tool.name).filter((name) => typeof name === 'string');
}

function toolCounts() {
  const names = backendToolNames();
  if (state.native) {
    // Canonical aliases replace their native names; the rest are prefixed. The
    // counts describe the exposed surface, and are null until tools/list has
    // classified the backend list.
    const surface = state.nativeSurface;
    if (surface === null) {
      return { backend: names.length, browser: null, local: null };
    }
    const exposed = [...surface.exposedNames];
    return {
      backend: names.length,
      browser: exposed.filter((name) => surface.canonicalNames.has(name)).length,
      local: exposed.filter((name) => surface.prefixedNames.has(name)).length,
    };
  }
  const browserNames = names.filter((name) => name.startsWith('browser_'));
  return {
    backend: names.length,
    browser: browserNames.length,
    local: names.length - browserNames.length,
  };
}

function supportedCounts() {
  if (state.native) {
    const surface = state.nativeSurface;
    if (surface === null) {
      return { all: 0, browser: 0 };
    }
    const exposed = [...surface.exposedNames];
    return {
      all: exposed.length,
      browser: exposed.filter((name) => surface.canonicalNames.has(name)).length,
    };
  }
  const names = backendToolNames();
  const supported = names.filter((name) => profileAllowsTool(name));
  return {
    all: supported.length,
    browser: supported.filter((name) => name.startsWith('browser_')).length,
  };
}

function manifestStringList(field) {
  const value = state.engine?.[field];
  return Array.isArray(value) ? [...value] : [];
}

// Read-only inventory of the profiles that already exist for this engine. It
// never creates, renames or deletes anything: the directory name is the
// registry. The account root holds named accounts; the default profile lives
// beside it for the Chromium engines, so it is added when its directory exists.
// The current account is always listed. The count is untruncated; the list is
// capped so a directory with thousands of profiles cannot bloat a payload.
const MAX_AVAILABLE_ACCOUNTS = 100;

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function availableAccounts() {
  if (state.profile.applies !== true || state.engine === null) {
    return { names: [], count: 0 };
  }
  const names = new Set();
  const accountRoot = path.join(PLUGIN_DATA_DIR, 'profiles', state.engine.id);
  try {
    for (const entry of readdirSync(accountRoot, { withFileTypes: true })) {
      // Dot-directories are the engine's own metadata (profiles/<engine>/.sessions
      // holds copy-mode working directories, and the pointer .default is a file);
      // an account name cannot start with ".", so none is a selectable profile.
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        names.add(entry.name);
      }
    }
  } catch {
    // A missing account root simply means no named account exists yet.
  }
  if (state.profile.defaultDir !== null && isDirectory(state.profile.defaultDir)) {
    names.add(DEFAULT_PROFILE_NAME);
  }
  if (state.profile.account !== null) {
    names.add(state.profile.account);
  }
  const sorted = [...names].sort();
  return { names: sorted.slice(0, MAX_AVAILABLE_ACCOUNTS), count: sorted.length };
}

// Manifest "none" names the backend did not list. The rule is exact, so this
// is available before tools/list and does not depend on the backend's own list;
// a listed-but-hidden name is reported through hiddenByManifest instead.
function unavailableToolEntries() {
  const rules = state.engine?.toolSupport;
  if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) {
    return [];
  }
  const notes = state.engine?.toolSupportNotes;
  const listed = new Set(backendToolNames());
  const entries = [];
  for (const [name, support] of Object.entries(rules)) {
    if (name === '*' || support !== 'none' || listed.has(name)) {
      continue;
    }
    const note = notes !== null && typeof notes === 'object' ? notes[name] : undefined;
    entries.push({
      name,
      support: 'none',
      reason: typeof note === 'string' && note.trim() !== '' ? note : 'Not supported by this engine.',
    });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
}

function nativeCapabilitiesExtras() {
  if (!state.native) {
    return {};
  }
  const surface = state.nativeSurface;
  const spec = state.engine?.profileArgument;
  return {
    groupSwitchesApply: state.engine?.capabilities?.groupSwitchesApply === true,
    profileArgument:
      spec === null || typeof spec !== 'object'
        ? null
        : {
            name: spec.name ?? null,
            setting: spec.setting ?? null,
            except: Array.isArray(spec.except) ? [...spec.except] : [],
          },
    canonicalToolCount:
      surface === null ? (state.aliasIndex?.byCanonical.size ?? null) : surface.counts.canonical,
    nativeOnlyToolCount: surface === null ? null : surface.counts.nativeOnly,
    surfaceError: state.nativeSurfaceError,
    toolAliases: aliasSummary(state.engine),
  };
}

// External software declared by the active manifest (for example a commercial
// desktop app). The broker reports it, never installs it: status is "unknown"
// until evidence says it is absent ("missing") — a configuration error, a
// backend start/exit failure, or a failed call the manifest's runtime hint
// explains. An engine that declares none gains no key at all.
function systemDependencyUnavailable() {
  return (
    state.systemDependencyMissing ||
    state.engineError !== null ||
    state.backend.state === 'failed' ||
    state.backend.state === 'exited'
  );
}

function systemDependencyReport() {
  const unavailable = systemDependencyUnavailable();
  return systemDependencies(state.engine).map((entry) => ({
    ...entry,
    status: unavailable ? 'missing' : 'unknown',
  }));
}

function systemDependencyHint() {
  const missing = systemDependencyReport().filter((entry) => entry.required && entry.status === 'missing');
  if (missing.length === 0) {
    return null;
  }
  return missing.map((entry) => `${entry.label} is required. ${entry.installHint}`).join(' ');
}

// --- copy-mode reporting (2.12.0, copy-keep 2.13.0) -------------------------
// Additive only: in a copy mode the meta-tools report the base, the session copy,
// the lock the broker holds on the base and what a clean shutdown does with the
// changes. The leftover session copies and the retained previous trees are
// listed whenever one exists, so a crashed or swapped session is discoverable
// from any mode. Every other mode's payload is unchanged.
function copyReport() {
  const copy = state.profile.copy;
  if (copy === null || copy === undefined) {
    return null;
  }
  const baseLock = readProfileLock(copy.baseDir);
  return {
    baseDir: copy.baseDir,
    sessionDir: copy.sessionDir,
    baseCreated: copy.baseCreated,
    baseLock: {
      state: baseLock.state,
      path: baseLock.path,
      owner: baseLock.owner,
      reclaimed: copy.baseLock.reclaimed,
      heldByThisSession:
        baseLock.state === 'live' && baseLock.owner !== null && baseLock.owner.pid === process.pid,
    },
    copied: { ...copy.copied },
    discarded: copy.discarded,
    // copy-keep only: the clean-close swap. On a running session it is
    // "pending"; a hard kill writes no result and leaves the trees in place.
    ...(copy.swap === null || copy.swap === undefined ? {} : { swap: { ...copy.swap } }),
  };
}

function copyReportNote() {
  const copy = state.profile.copy;
  if (copy !== null && copy !== undefined) {
    return state.profile.isolation === 'copy-keep'
      ? profileCopyKeepNote(copy.baseDir, copy.sessionDir)
      : profileCopyNote(copy.baseDir, copy.sessionDir);
  }
  if (isCopyIsolation(state.profile.isolation) && state.profile.appliesToEngine === false) {
    return profileCopyNotApplicableNote(state.profile.isolation);
  }
  return null;
}

// The retained previous trees beside the base this server would swap (the
// session copy's base in a copy mode, otherwise the resolved profile). Bounded
// and newest first; null when there are none, so a clean payload is unchanged.
function previousTreesReport() {
  if (state.engine === null || state.profile.appliesToEngine !== true) {
    return null;
  }
  const baseDir =
    state.profile.copy !== null && state.profile.copy !== undefined
      ? state.profile.copy.baseDir
      : currentProfileDir();
  if (baseDir === null) {
    return null;
  }
  const listed = listPreviousTrees(baseDir);
  if (listed.trees.length === 0) {
    return null;
  }
  return {
    root: listed.root,
    baseName: listed.baseName,
    count: listed.count,
    truncated: listed.truncated,
    trees: listed.trees.map((tree) => ({
      name: tree.name,
      path: tree.path,
      timestamp: tree.timestamp,
      suffix: tree.suffix,
    })),
    ...(listed.error === undefined ? {} : { error: listed.error }),
  };
}

// The engine's last clean-close swap, written by the broker that swapped (it is
// exiting and cannot answer a tool call). Null when no copy-keep session has
// completed on this engine.
function lastSwapReport() {
  if (state.engine === null) {
    return null;
  }
  return readSwapRecord(state.engineId, PLUGIN_DATA_DIR);
}

// The session copies under profiles/<engine>/.sessions, with the current one
// marked "current" and any copy a live process still owns marked "active"; the
// rest are "leftover". Null when there is nothing to report, so every other
// mode's payload stays byte-identical on a clean machine.
function sessionCopiesReport() {
  if (state.engine === null || state.profile.appliesToEngine !== true) {
    return null;
  }
  const currentDir =
    state.profile.copy === null || state.profile.copy === undefined ? null : state.profile.copy.sessionDir;
  const listed = listSessionCopies(state.engineId, PLUGIN_DATA_DIR, {
    engineLockDescriptor: state.engine.profileLock === undefined ? null : state.engine.profileLock,
    currentDir,
  });
  if (listed.copies.length === 0) {
    return null;
  }
  return {
    root: listed.root,
    currentDir,
    copies: listed.copies.map((copy) => ({
      name: copy.name,
      path: copy.path,
      baseName: copy.baseName,
      startedAtLocal: copy.startedAtLocal,
      pid: copy.pid,
      state: copy.state,
    })),
    ...(listed.error === undefined ? {} : { error: listed.error }),
  };
}

function capabilitiesPayload(clientRoots) {
  const systemDeps = systemDependencyReport();
  const counts = state.toolsListed ? toolCounts() : null;
  const supported = state.toolsListed ? supportedCounts() : null;
  const accounts = availableAccounts();
  const copyNow = copyReport();
  const copyNoteNow = copyReportNote();
  const sessionCopiesNow = sessionCopiesReport();
  const lastSwapNow = lastSwapReport();
  const pointerNow =
    state.profile.appliesToEngine && state.engine !== null
      ? readProfileDefaultPointer(state.engineId, PLUGIN_DATA_DIR)
      : null;
  const perToolSupport = {};
  if (state.toolsListed) {
    if (state.native) {
      const surface = state.nativeSurface;
      if (surface !== null) {
        for (const [name, support] of surface.exposedSupport) {
          if (surface.exposedNames.has(name)) {
            perToolSupport[name] = support;
          }
        }
      }
      for (const entry of unavailableToolEntries()) {
        perToolSupport[entry.name] = entry.support;
      }
    } else {
      for (const name of [...backendToolNames()].sort()) {
        perToolSupport[name] = supportFor(name);
      }
    }
  }
  return {
    engine: state.engineId,
    label: state.engine?.label ?? null,
    contract: state.engine?.contract ?? null,
    transport: state.engine?.transport ?? null,
    // Manifest-declared capability facts for a contract engine (cdpAttach,
    // groupSwitchesApply). A native engine reports groupSwitchesApply through
    // nativeCapabilitiesExtras, so its existing key order is unchanged; an
    // engine that declares no capabilities gains no keys.
    ...(!state.native && state.engine?.capabilities !== null && typeof state.engine?.capabilities === 'object'
      ? state.engine.capabilities
      : {}),
    toolProfile: state.toolProfile,
    engineChoices: [...state.engineChoices],
    engineSource: state.engineSource,
    engineError: state.engineError,
    engineNotes: state.engine?.notes ?? null,
    howToChangeEngine: ENGINE_CHANGE_HELP,
    backendToolCount: counts?.backend ?? null,
    browserToolCount: counts?.browser ?? null,
    localToolCount: counts?.local ?? null,
    supportedToolCount: supported?.all ?? null,
    supportedBrowserToolCount: supported?.browser ?? null,
    exposedToolCount: state.lastExposedCount,
    metaToolCount: META_TOOL_NAMES.size,
    metaTools: [...META_TOOL_NAMES],
    backendCapabilities: state.backendCapabilities,
    perToolSupport,
    supportRules: state.engine?.toolSupport ?? null,
    disabledTools: [...state.disabled],
    hiddenByManifest: state.native
      ? (state.nativeSurface?.hiddenByManifest ?? [])
      : [...state.hiddenByManifest],
    hiddenByCollision: state.native
      ? (state.nativeSurface?.hiddenByCollision ?? [])
      : [...state.hiddenByCollision],
    requestedToolProfile: state.requestedToolProfile,
    toolProfileSource: state.toolProfileSource,
    engineDefaultToolProfile: state.engine?.defaultToolProfile ?? null,
    availableToolProfiles: state.profiles === null ? [] : availableProfileNames(state.profiles),
    portableToolNames: state.profiles === null ? [] : portableToolNames(state.profiles),
    perToolSupportNotes: state.engine?.toolSupportNotes ?? {},
    hiddenByProfile: state.native ? (state.nativeSurface?.hiddenByProfile ?? []) : [...state.hiddenByProfile],
    unavailableTools: unavailableToolEntries(),
    launch: resolveLauncherName(state.engine),
    requirements: manifestStringList('requirements'),
    ignoredSettings: manifestStringList('ignoredSettings'),
    ...(systemDeps.length === 0 ? {} : { systemDependencies: systemDeps }),
    ...nativeCapabilitiesExtras(),
    // Per-account profile facts, additive. The proxy URL itself is never
    // returned: proxyConfigured is a boolean and proxySource names its origin.
    account: state.profile.account,
    profileDir: state.profile.dir,
    profileSource: state.profile.source,
    defaultProfileDir: state.profile.defaultDir,
    availableAccounts: accounts.names,
    availableAccountCount: accounts.count,
    accountApplies: state.profile.applies,
    proxySource: state.proxy.source,
    proxyConfigured: state.proxy.configured,
    // Session safety, additive. profileLock is null only when the engine owns its
    // profile, or before the resolution failed; profileFallback is non-null only
    // when a workspace profile was busy and a numbered sibling was chosen.
    // engineProfileLock appears only for a manifest that declares profileLock.
    profileIsolation: state.profile.isolation,
    profileIsolationSource: state.profile.isolationSource,
    profileApplies: state.profile.appliesToEngine,
    profileFallback: state.profile.fallback,
    profileLock: state.profile.lock,
    ...(state.profile.engineLock === null ? {} : { engineProfileLock: state.profile.engineLock }),
    // Copy start (2.12.0) and copy-keep (2.13.0), additive only in those modes.
    // profileCopy names the base, the session copy, the lock this session holds
    // on the base and the copy size; in copy-keep it also carries the pending
    // clean-close swap. profileCopyNote states what happens to the changes. For
    // an engine with profileApplies false the mode is refused loudly and
    // profileCopySupported is false. sessionCopies lists leftover copies and
    // lastSwap the last completed clean-close swap, both only when they exist, so
    // a clean payload is unchanged.
    ...(isCopyIsolation(state.profile.isolation)
      ? {
          profileCopy: copyNow,
          profileCopySupported: state.profile.appliesToEngine,
          ...(copyNoteNow === null ? {} : { profileCopyNote: copyNoteNow }),
        }
      : {}),
    ...(sessionCopiesNow === null ? {} : { sessionCopies: sessionCopiesNow }),
    ...(lastSwapNow === null ? {} : { lastSwap: lastSwapNow }),
    // Isolated start (2.11.0), additive only in that mode so every shared and
    // workspace payload stays byte-identical. profileIgnored lists the profile
    // settings the mode made inert, with the value that was supplied; the note
    // says what the pointer and set-default mean (nothing) for this session.
    ...(state.profile.ignored.length === 0
      ? {}
      : {
          profileIgnored: state.profile.ignored,
          profileIgnoredReason: profileIgnoredReason(state.profile.ignored),
        }),
    ...(state.profile.isolation === 'isolated'
      ? {
          profileIsolationNote: state.profile.appliesToEngine
            ? PROFILE_ISOLATED_POINTER_NOTE
            : PROFILE_ISOLATED_NATIVE_NOTE,
        }
      : {}),
    // Device identity (2.14.0), additive. identitySource is profile-file,
    // random, isolated or native-unavailable (or not-applicable on an engine
    // that cannot pin); identityFile and identityCreatedAt describe the stored
    // file when one is used, and identityNote explains an inert engine, the
    // random and isolated modes, or a corrupt/regenerated file.
    ...identityReport(),
    // Server heartbeat (2.14.1), additive and the same values in both
    // meta-tools: whether ping_timeout_ms applies to this engine, the effective
    // deadline, its source and whether the wrapper heartbeat runs at all.
    ...pingTimeoutReport(),
    // Saved logins (2.15.0), additive and only when password_manager is on. The
    // values match browser_engine_status; the policy file path is reported only
    // when this plugin's managed file is in use, and passwordManagerStore is the
    // profile's logins.db *file existence* only (never opened).
    ...passwordManagerReport(),
    // Artifact diagnostics, additive and last, so every key above keeps its
    // position and value. serverCwd is the directory both allowlist values fall
    // back to; outputDir is the effective artifact directory (null for an engine
    // that does not use the setting); clientRoots is what the MCP client
    // advertised ({ uri, name? }, an empty list when it advertises none) or null
    // when the probe could not read it, with the short reason beside it.
    serverCwd: SERVER_CWD,
    outputDir: outputDirState.dir,
    clientRoots: clientRoots.roots,
    ...(clientRoots.roots === null ? { clientRootsError: clientRoots.error ?? 'unavailable' } : {}),
    // Default-profile pointer (2.10.0), additive and last. It is re-read here so
    // the report describes what the NEXT start will use, not what this start
    // read (browser_profiles set-default can change it while the server runs).
    // profileDefault is the name the pointer holds when the file is usable,
    // otherwise null; profileDefaultSource says where that value stands ("pointer"
    // is a usable file, "none" no file, "invalid" a file that is ignored, null an
    // engine whose profile the broker does not own); profileDefaultPath is the file
    // browser_profiles set-default writes. Whether the pointer supplied THIS
    // start's profile is profileSource === "pointer".
    profileDefault: pointerNow === null ? null : pointerNow.name,
    profileDefaultSource:
      pointerNow === null
        ? null
        : pointerNow.state === 'present'
          ? 'pointer'
          : pointerNow.state === 'missing'
            ? 'none'
            : 'invalid',
    profileDefaultPath: pointerNow === null ? null : pointerNow.path,
    ...(pointerNow === null || pointerNow.error === null ? {} : { profileDefaultError: pointerNow.error }),
  };
}

function statusPayload() {
  const counts = state.toolsListed ? toolCounts() : null;
  const now = Date.now();
  const copyNow = copyReport();
  const copyNoteNow = copyReportNote();
  const sessionCopiesNow = sessionCopiesReport();
  const lastSwapNow = lastSwapReport();
  const dependencyHint = systemDependencyHint();
  const rawLastError =
    dependencyHint === null
      ? state.lastError
      : state.lastError === null
        ? dependencyHint
        : state.lastError.includes(dependencyHint)
          ? state.lastError
          : `${state.lastError} ${dependencyHint}`;
  const lastError = rawLastError === null ? null : redactSecrets(rawLastError);
  const startupMs =
    state.spawnedAt === null || state.initializeAnsweredAt === null
      ? null
      : state.initializeAnsweredAt - state.spawnedAt;
  const waitMs =
    state.spawnedAt === null || state.initializeAnswered || state.backendAnswered
      ? null
      : Math.max(0, now - state.spawnedAt);
  return {
    engine: state.engineId,
    label: state.engine?.label ?? null,
    engineSource: state.engineSource,
    engineError: state.engineError,
    transport: state.engine?.transport ?? null,
    contract: state.engine?.contract ?? null,
    toolProfile: state.toolProfile,
    backendState: state.backend.state,
    backendPid: state.backend.pid,
    backendVersion: state.serverInfo?.version ?? null,
    backendServerName: state.serverInfo?.name ?? null,
    lastError,
    ...(state.initializeRejected ? { initializeRejected: true } : {}),
    startupMs,
    waitMs,
    toolsListWaitMs: state.lastToolsListWaitMs,
    pendingRequestCount: state.pendingRequests.size,
    uptimeMs: state.spawnedAt === null ? null : Math.max(0, now - state.spawnedAt),
    backendToolCount: counts?.backend ?? null,
    exposedToolCount: state.lastExposedCount,
    metaToolCount: META_TOOL_NAMES.size,
    brokerVersion: BROKER_VERSION,
    howToChangeEngine: ENGINE_CHANGE_HELP,
    backendStderrTail: state.stderrTail.trim() === '' ? null : redactSecrets(state.stderrTail.slice(-1500)),
    // A manifest that declares a runtime (an attach endpoint and profile id)
    // names its own extra status keys here. Other engines add nothing.
    ...runtimeStatusFields(state.engine, process.env),
    ...(state.native
      ? {
          surfaceBuilt: state.nativeSurface !== null,
          surfaceError: state.nativeSurfaceError,
        }
      : {}),
    account: state.profile.account,
    profileDir: state.profile.dir,
    // Session safety, additive; every existing value above is unchanged.
    profileIsolation: state.profile.isolation,
    profileApplies: state.profile.appliesToEngine,
    profileFallback: state.profile.fallback,
    profileLock: state.profile.lock,
    ...(state.profile.engineLock === null ? {} : { engineProfileLock: state.profile.engineLock }),
    // Copy start (2.12.0) and copy-keep (2.13.0), additive only in those modes,
    // same values as browser_capabilities. profileSource is reported with it so a
    // status read alone shows where the base came from.
    ...(isCopyIsolation(state.profile.isolation)
      ? {
          profileSource: state.profile.source,
          profileCopy: copyNow,
          profileCopySupported: state.profile.appliesToEngine,
          ...(copyNoteNow === null ? {} : { profileCopyNote: copyNoteNow }),
        }
      : {}),
    ...(sessionCopiesNow === null ? {} : { sessionCopies: sessionCopiesNow }),
    ...(lastSwapNow === null ? {} : { lastSwap: lastSwapNow }),
    // Isolated start (2.11.0), additive only in that mode. profileSource is
    // reported here as well so a status read alone can tell where the profile
    // would have come from (it is "isolated": none).
    ...(state.profile.isolation === 'isolated'
      ? {
          profileSource: state.profile.source,
          profileIsolationNote: state.profile.appliesToEngine
            ? PROFILE_ISOLATED_POINTER_NOTE
            : PROFILE_ISOLATED_NATIVE_NOTE,
          ...(state.profile.ignored.length === 0
            ? {}
            : {
                profileIgnored: state.profile.ignored,
                profileIgnoredReason: profileIgnoredReason(state.profile.ignored),
              }),
        }
      : {}),
    // Device identity (2.14.0), additive and the same values browser_capabilities
    // reports, so a status read alone shows which identity this start uses.
    ...identityReport(),
    // Server heartbeat (2.14.1), additive and the same values browser_capabilities
    // reports, so a status read alone shows whether the wrapper heartbeat runs.
    ...pingTimeoutReport(),
    // Saved logins (2.15.0), additive and only when password_manager is on. The
    // values match browser_engine_status; the policy file path is reported only
    // when this plugin's managed file is in use, and passwordManagerStore is the
    // profile's logins.db *file existence* only (never opened).
    ...passwordManagerReport(),
  };
}

// browser_capabilities needs both the client's roots and the effective artifact
// directory. Resolving the directory first reuses the same cached probe, so this
// is still at most one roots/list request per session; every other request and
// notification keeps flowing while the probe waits. The call is answered once
// the probe settles (an answer, an error, or the 2 s bound).
function respondCapabilities(id) {
  resolveOutputDir()
    .then(() => clientRootsResult())
    .then(
      (roots) => sendToolPayload(id, capabilitiesPayload(roots)),
      (error) => {
        // Unreachable in practice; a failed probe must still answer the call.
        sendToolPayload(
          id,
          capabilitiesPayload({
            roots: null,
            error: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
        );
      },
    );
}

// --- browser_profiles (2.10.0) ---------------------------------------------
// A local broker tool. It never starts, stops or reconfigures the backend, and it
// writes exactly one file: the default-profile pointer. That pointer applies at
// the next server start (decision A2), so this session's profile never changes
// under a running browser. Every read here is fresh, because this tool is the one
// thing that can change the pointer while the server runs.

// The engine's own profile directory for this start: what the lock preflight
// read at start, recomputed from the same three values.
function currentProfileDir() {
  return effectiveProfileDir({
    profileDir: state.profile.dir,
    defaultProfileDir: state.profile.defaultDir,
    profileSource: state.profile.source,
  });
}

// The pointer facts the meta-tools report, with its target directory resolved
// through the active launcher (so "default" is the engine default).
function pointerFacts(pointer) {
  if (pointer === null || state.engine === null) {
    return null;
  }
  const targetDir =
    pointer.name === null
      ? null
      : profileDefaultPointerDir(
          state.engineId,
          PLUGIN_DATA_DIR,
          pointer.name,
          resolveLauncherName(state.engine),
        );
  return {
    path: pointer.path,
    exists: pointer.exists,
    name: pointer.name,
    state: pointer.state,
    error: pointer.error,
    targetDir,
    targetExists: targetDir === null ? null : isDirectory(targetDir),
  };
}

// The profiles that exist for this engine, from the same directory inventory and
// the same 100-name cap browser_capabilities reports, plus the name the pointer
// holds (which may not have a directory yet: it is created on its first launch).
function availableProfiles(pointerName = null) {
  const inventory = availableAccounts();
  const names = new Set(inventory.names);
  const named =
    typeof pointerName === 'string' && pointerName !== ''
      ? pointerName
      : state.profile.source === 'pointer' && state.profile.pointer !== null
        ? state.profile.pointer.name
        : null;
  if (typeof named === 'string' && named !== '') {
    names.add(named);
  }
  const sorted = [...names].filter((name) => typeof name === 'string').sort();
  return { names: sorted.slice(0, MAX_AVAILABLE_ACCOUNTS), count: sorted.length };
}

// `current` is the profile this running server uses; `pointer` is the default for
// the next start. They differ exactly when set-default has been called in this
// session or when the pointer is overridden by profile_dir/account.
function profileStatePayload() {
  const effective = currentProfileDir();
  const lock = effective === null ? null : readProfileLock(effective);
  return {
    account: state.profile.account,
    profileSource: state.profile.source,
    profileDir: effective,
    defaultProfileDir: state.profile.defaultDir,
    profileIsolation: state.profile.isolation,
    profileIsolationSource: state.profile.isolationSource,
    profileLock: lock === null ? null : { ...lock, fix: lockBlocksStart(lock) ? profileLockFix(lock) : null },
    // Copy start (2.12.0) and copy-keep (2.13.0), additive only in those modes:
    // the base, the session copy this server runs on, the base lock this session
    // holds and the note on what happens to the changes. The lock above is the
    // session copy's own bridge lock once the backend has started.
    ...(isCopyIsolation(state.profile.isolation)
      ? {
          profileCopy: copyReport(),
          profileCopySupported: state.profile.appliesToEngine,
          ...(copyReportNote() === null ? {} : { profileCopyNote: copyReportNote() }),
        }
      : {}),
    // Isolated start (2.11.0), additive only in that mode: there is no profile
    // directory and no lock, and the settings supplied are reported as ignored.
    ...(state.profile.isolation === 'isolated'
      ? {
          profileIsolationNote: state.profile.appliesToEngine
            ? PROFILE_ISOLATED_POINTER_NOTE
            : PROFILE_ISOLATED_NATIVE_NOTE,
          ...(state.profile.ignored.length === 0
            ? {}
            : {
                profileIgnored: state.profile.ignored,
                profileIgnoredReason: profileIgnoredReason(state.profile.ignored),
              }),
        }
      : {}),
  };
}

function respondProfiles(id, args) {
  const action =
    args !== null && typeof args === 'object' && typeof args.action === 'string' && args.action.trim() !== ''
      ? args.action.trim()
      : 'list';
  if (action === 'list') {
    const pointer =
      state.profile.appliesToEngine && state.engine !== null
        ? readProfileDefaultPointer(state.engineId, PLUGIN_DATA_DIR)
        : null;
    const profiles = availableProfiles(pointer === null ? null : pointer.name);
    const previousTreesNow = previousTreesReport();
    const lastSwapNow = lastSwapReport();
    sendToolPayload(id, {
      action: 'list',
      engine: state.engineId,
      label: state.engine?.label ?? null,
      profileApplies: state.profile.appliesToEngine,
      availableProfiles: profiles,
      current: profileStatePayload(),
      pointer: pointerFacts(pointer),
      // A set-default call changes the next start only; this session keeps its
      // profile, so the two are reported separately.
      applies: 'next server start',
      // Copy start (2.12.0) and copy-keep (2.13.0), additive only in those
      // modes; the current payload above names the base and the session copy.
      // The leftover copies and the retained previous trees are listed whenever
      // one exists (in every mode), so a crashed copy or a completed swap is
      // discoverable; previous trees are user data and pruning never removes
      // them.
      ...(isCopyIsolation(state.profile.isolation)
        ? {
            profileCopySupported: state.profile.appliesToEngine,
            ...(copyReportNote() === null ? {} : { profileCopyNote: copyReportNote() }),
          }
        : {}),
      ...(sessionCopiesReport() === null ? {} : { sessionCopies: sessionCopiesReport() }),
      ...(previousTreesNow === null ? {} : { previousTrees: previousTreesNow }),
      ...(lastSwapNow === null ? {} : { lastSwap: lastSwapNow }),
      ...(state.profile.isolation === 'isolated'
        ? {
            profileIsolationNote: state.profile.appliesToEngine
              ? PROFILE_ISOLATED_POINTER_NOTE
              : PROFILE_ISOLATED_NATIVE_NOTE,
          }
        : {}),
      brokerVersion: BROKER_VERSION,
    });
    return;
  }
  if (action === 'set-default') {
    if (!state.profile.appliesToEngine || state.engine === null) {
      sendToolError(
        id,
        `The "${state.engineId}" engine does not use broker profiles (profileApplies: false), ` +
          'so there is no default profile to set.',
      );
      return;
    }
    const rawName = args !== null && typeof args === 'object' ? args.name : undefined;
    if (typeof rawName !== 'string' || rawName.trim() === '') {
      sendToolError(id, `browser_profiles set-default requires a profile "name". ${INVALID_ACCOUNT_HINT}`);
      return;
    }
    const name = rawName.trim();
    if (!validateAccountName(name)) {
      sendToolError(id, `browser_profiles set-default: ${accountNameError(rawName)}`);
      return;
    }
    const written = writeProfileDefaultPointer(state.engineId, PLUGIN_DATA_DIR, name);
    if (!written.written) {
      sendToolError(id, written.error);
      return;
    }
    const pointer = readProfileDefaultPointer(state.engineId, PLUGIN_DATA_DIR);
    const facts = pointerFacts(pointer);
    const profiles = availableProfiles(name);
    sendToolPayload(id, {
      action: 'set-default',
      ok: true,
      engine: state.engineId,
      name,
      pointer: facts,
      availableProfiles: profiles,
      // The write does not touch the running browser; say so explicitly so a
      // caller does not expect the profile to change in this session.
      current: profileStatePayload(),
      applies: 'next server start',
      note:
        state.profile.isolation === 'isolated'
          ? 'The default profile is written; this server started with profile_isolation "isolated", so it ' +
            'uses no profile and the pointer has no effect on this session. It applies at the next server ' +
            'start once profile_isolation is "shared" or "workspace"; restart Claude Code to use it.'
          : 'The default profile is written and applies at the next server start; this session keeps its ' +
            'current profile and no browser was started or restarted. Restart Claude Code to use it.',
      brokerVersion: BROKER_VERSION,
    });
    return;
  }
  sendToolError(id, `Unknown browser_profiles action "${action}". Use "list" or "set-default".`);
}

function handleMetaCall(message) {
  const name = message.params?.name;
  if (name === 'browser_capabilities') {
    respondCapabilities(message.id);
    return true;
  }
  if (name === 'browser_engine_status') {
    sendToolPayload(message.id, statusPayload());
    return true;
  }
  if (name === 'browser_profiles') {
    respondProfiles(message.id, message.params?.arguments);
    return true;
  }
  return false;
}

// Application order: meta collision, then manifest "none", then the selected
// profile, then disabled_tools. The seven group switches already shaped the
// backend list inside the launcher.
function filterTools(tools, addMeta) {
  const kept = [];
  state.hiddenByManifest = new Set();
  state.hiddenByCollision = new Set();
  state.hiddenByProfile = new Set();
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object' || typeof tool.name !== 'string') {
      kept.push(tool);
      continue;
    }
    const name = tool.name;
    if (META_TOOL_NAMES.has(name)) {
      // The broker meta-tools are always present; a backend tool with the same
      // name cannot be addressed and is dropped with a log line.
      state.hiddenByCollision.add(name);
      log(`backend tool "${name}" collides with a broker meta-tool and was hidden`);
      continue;
    }
    if (supportFor(name) === 'none') {
      state.hiddenByManifest.add(name);
      continue;
    }
    if (!profileAllowsTool(name)) {
      state.hiddenByProfile.add(name);
      continue;
    }
    if (state.disabled.has(name)) {
      continue;
    }
    kept.push(tool);
  }
  if (addMeta) {
    kept.push(...metaToolList());
  }
  return kept;
}

function recordBackendTools(tools, hasCursor) {
  const named = tools.filter(
    (tool) => tool !== null && typeof tool === 'object' && typeof tool.name === 'string',
  );
  if (hasCursor) {
    const existing = new Set(backendToolNames());
    for (const tool of named) {
      if (!existing.has(tool.name)) {
        existing.add(tool.name);
        state.backendTools.push(tool);
      }
    }
  } else {
    state.backendTools = named;
  }
  state.toolsListed = true;
}

function sendMetaOnlyList(id, cursor) {
  const tools = cursor === undefined || cursor === null || cursor === '' ? metaToolList() : [];
  state.lastExposedCount = tools.length;
  sendResult(id, { tools });
}

function synthesizeInitialize(id, reason) {
  state.initializeAnswered = true;
  state.initializeAnsweredAt = state.initializeAnsweredAt ?? Date.now();
  const dependencyHint = systemDependencyHint();
  const instructions =
    `The ${state.engineId} backend is unavailable: ${reason} ` +
    'Call browser_engine_status for details. Only broker meta-tools are exposed until Claude Code restarts the MCP server.' +
    (state.profile.fallback === null ? '' : ` ${state.profile.fallback.reason}`) +
    (dependencyHint === null ? '' : ` ${dependencyHint}`) +
    (state.profile.isolated && state.profile.appliesToEngine ? ` ${PROFILE_ISOLATED_NOTE}` : '') +
    ` ${artifactDirectorySentence()}`;
  sendResult(id, {
    protocolVersion: state.requestedProtocolVersion ?? '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: {
      name: 'cloakbrowser-broker',
      title: 'CloakBrowser broker',
      version: BROKER_VERSION,
    },
    instructions,
  });
}

function drainPendingRequests(reason) {
  const pending = [...state.pendingRequests.entries()];
  state.pendingRequests.clear();
  for (const [id, request] of pending) {
    if (request.method === 'initialize') {
      synthesizeInitialize(id, reason);
      continue;
    }
    if (request.method === 'tools/list') {
      sendMetaOnlyList(id, request.cursor);
      continue;
    }
    sendError(id, -32603, `Cannot complete "${request.method}": ${reason}`);
  }
}

function forwardToBackend(line) {
  const child = state.child;
  if (child === null || child.stdin === null || !child.stdin.writable) {
    return false;
  }
  try {
    child.stdin.write(`${line}\n`);
    return true;
  } catch (error) {
    log(`failed to write to backend: ${error.message}`);
    return false;
  }
}

function killBackendTree() {
  const child = state.child;
  if (child === null || child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    if (result.status !== 0) {
      log(`taskkill for pid ${child.pid} exited with status ${String(result.status)}`);
    }
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch (error) {
    log(`failed to kill backend pid ${child.pid}: ${error.message}`);
  }
}

// --- copy-mode session lifecycle --------------------------------------------
// A clean shutdown is the broker's own shutdown path (the client closed stdin,
// or the process received SIGINT/SIGTERM/SIGHUP): the backend is stopped first.
// "copy" then deletes the session tree and releases the base lock. "copy-keep"
// instead swaps the whole tree back: the old base becomes <base>.previous-<ts>
// (retained) and the session copy takes the base path; the base lock and the
// owner marker are released only after the swap succeeds. A hard kill runs none
// of this: the copy stays on disk (data is never lost), the base lock is a stale
// file whose dead pid every preflight and the bridge's own reclaim rule accept,
// and browser_profiles / scripts/profile-copy.mjs --prune list it.
function discardCopySession() {
  const copy = state.profile.copy;
  if (copy === null || copy === undefined || copy.discarded) {
    return;
  }
  try {
    rmSync(copy.sessionDir, { recursive: true, force: true });
    copy.discarded = true;
    log(`profile ${copyModeLabel}: discarded session copy ${copy.sessionDir} after a clean shutdown`);
  } catch (error) {
    // A file a dying browser still holds on Windows: keep the tree, say where
    // it is and how to remove it later. Nothing is forced.
    log(
      `profile ${copyModeLabel}: could not discard the session copy ${copy.sessionDir}: ${error.message}; ` +
        'it is left in place for browser_profiles list and scripts/profile-copy.mjs --prune',
    );
  }
}

// Keep the base lock when a copy-keep swap did not complete: the brief's rule is
// to release it only after a successful swap. The file then reads as stale (its
// pid is gone) and never blocks the next start.
let retainCopyBaseLock = false;

function releaseCopyBaseLock() {
  if (copyBaseLockHandle === null) {
    return;
  }
  if (retainCopyBaseLock) {
    const where = existsSync(copyBaseLockHandle.path)
      ? copyBaseLockHandle.path
      : 'it moved with the base tree into the retained previous tree';
    log(
      `profile copy-keep: no swap completed, so the base lock was not released (${where}); ` +
        'its process id is gone, so the next start reclaims it',
    );
    copyBaseLockHandle = null;
    return;
  }
  const released = releaseProfileLock(copyBaseLockHandle);
  if (released.error !== null) {
    log(released.error);
  }
  copyBaseLockHandle = null;
}

// Blocking sleep for the bounded wait below. The broker is already shutting down
// and the backend has exited, so no protocol traffic can be starved.
function sleepSync(ms) {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Wait, bounded, until the session copy's own locks are gone: the backend's
// bridge lock and the engine's lock (Chromium lockfile / Firefox parent.lock).
// A stale lock or a missing file counts as released. Never removes or forces a
// lock; a live holder after the bound keeps everything and reports a failure.
function waitForSessionCopyLocksFree(sessionDir) {
  const engineLockDescriptor = state.engine?.profileLock ?? null;
  const deadline = Date.now() + COPY_KEEP_LOCK_WAIT_MS;
  for (;;) {
    const check = sessionCopyHasLiveLock(sessionDir, { engineLockDescriptor });
    if (!check.live) {
      return { free: true, check };
    }
    if (Date.now() >= deadline) {
      const holder = check.engine ?? check.bridge;
      return { free: false, check, holder };
    }
    sleepSync(COPY_KEEP_LOCK_POLL_MS);
  }
}

function recordCopyKeepSwap(copy, fields) {
  const written = writeSwapRecord(state.engineId, PLUGIN_DATA_DIR, {
    at: new Date().toISOString(),
    isolation: 'copy-keep',
    baseDir: copy.baseDir,
    sessionDir: copy.sessionDir,
    ...fields,
  });
  if (written.error !== null) {
    log(written.error);
  }
}

// The clean-close swap of one copy-keep session. Order: wait for the copy's
// locks, move the base aside, move the copy into the base path, then remove the
// owner marker from the new base and release the base lock (which travelled into
// the retained tree). A failure before or during the swap keeps both trees and
// leaves the base lock and the owner marker in place.
function completeCopyKeepShutdown() {
  const copy = state.profile.copy;
  if (copy === null || copy === undefined) {
    return;
  }
  if (copy.swap === null || copy.swap === undefined || copy.swap.state !== 'pending') {
    return;
  }
  if (state.spawnedAt === null) {
    // No backend ever started, so the browser never used this copy. There is
    // nothing to keep; the base was never opened and the copy is a duplicate.
    copy.swap = {
      state: 'skipped',
      previousDir: null,
      restored: false,
      error: 'The backend never started, so the session copy was not swapped.',
    };
    log(`profile copy-keep: ${copy.swap.error} The base ${copy.baseDir} is unchanged.`);
    discardCopySession();
    return;
  }
  retainCopyBaseLock = true;
  const wait = waitForSessionCopyLocksFree(copy.sessionDir);
  if (!wait.free) {
    const holderPath = wait.holder === null || wait.holder === undefined ? null : wait.holder.path;
    copy.swap = {
      state: 'failed',
      previousDir: null,
      restored: false,
      error:
        `The session copy ${copy.sessionDir} is still locked after ${COPY_KEEP_LOCK_WAIT_MS} ms` +
        (holderPath === null ? '' : ` (${holderPath})`) +
        `, so the base ${copy.baseDir} was not replaced. Both trees were kept.`,
    };
    log(`profile copy-keep: ${copy.swap.error}`);
    recordCopyKeepSwap(copy, {
      state: 'failed',
      previousDir: null,
      restored: false,
      error: copy.swap.error,
    });
    return;
  }
  const result = swapSessionCopyIntoBase({ baseDir: copy.baseDir, sessionDir: copy.sessionDir });
  if (!result.ok) {
    copy.swap = {
      state: 'failed',
      previousDir: result.previousDir,
      restored: result.restored === true,
      error: result.error,
    };
    log(`profile copy-keep: ${result.error}`);
    recordCopyKeepSwap(copy, {
      state: 'failed',
      previousDir: result.previousDir ?? result.retainedPreviousDir ?? null,
      restored: result.restored === true,
      error: result.error,
    });
    return;
  }
  // The swap succeeded: the session tree now is the base, and the owner marker
  // travelled with it. Remove that marker, then release the base lock, whose
  // file moved into the retained previous tree with the old base.
  copy.discarded = true;
  try {
    rmSync(path.join(copy.baseDir, SESSION_OWNER_FILENAME), { force: true });
  } catch (error) {
    log(
      `profile copy-keep: cannot remove the session owner marker from ${copy.baseDir}: ${error.message}; ` +
        'the browser ignores it',
    );
  }
  if (copyBaseLockHandle !== null) {
    copyBaseLockHandle = {
      ...copyBaseLockHandle,
      path: path.join(result.previousDir, PROFILE_LOCK_FILENAME),
    };
  }
  retainCopyBaseLock = false;
  const released = releaseProfileLock(copyBaseLockHandle);
  if (released.error !== null) {
    log(released.error);
  }
  copyBaseLockHandle = null;
  copy.swap = { state: 'swapped', previousDir: result.previousDir, restored: false, error: null };
  log(
    `profile copy-keep: swapped ${copy.sessionDir} into ${copy.baseDir}; ` +
      `the previous tree is retained at ${result.previousDir}`,
  );
  recordCopyKeepSwap(copy, {
    state: 'swapped',
    previousDir: result.previousDir,
    restored: false,
    error: null,
  });
}

let shutdownCompleted = false;
function completeShutdown() {
  if (shutdownCompleted) {
    return;
  }
  shutdownCompleted = true;
  if (copyKeepMode) {
    completeCopyKeepShutdown();
  } else {
    discardCopySession();
  }
  releaseCopyBaseLock();
  process.exit(0);
}

// An uncaught error exits without beginShutdown; release the base lock there too
// (the tree is kept). SIGKILL runs no hook, which is why every preflight also
// reclaims by pid liveness.
process.on('exit', () => {
  releaseCopyBaseLock();
});

function beginShutdown() {
  if (state.shuttingDown) {
    return;
  }
  state.shuttingDown = true;
  log('stdin closed; stopping backend');
  const child = state.child;
  if (child === null || child.exitCode !== null || child.signalCode !== null) {
    completeShutdown();
    return;
  }
  try {
    child.stdin.end();
  } catch (error) {
    log(`failed to close backend stdin: ${error.message}`);
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      log(`backend still alive after ${SHUTDOWN_GRACE_MS} ms; killing process tree pid=${child.pid}`);
      killBackendTree();
    }
    setTimeout(() => completeShutdown(), 100);
  }, SHUTDOWN_GRACE_MS);
}

// An initialize request states the client's capabilities. Only the roots fact is
// kept: it decides whether the lazy roots/list probe may be sent at all.
function noteInitializeRequest(message) {
  state.requestedProtocolVersion = message.params?.protocolVersion ?? null;
  const capabilities = message.params?.capabilities;
  state.clientRootsDeclared =
    capabilities !== null &&
    typeof capabilities === 'object' &&
    capabilities.roots !== undefined &&
    capabilities.roots !== null;
}

function handleClientRequest(message, rawLine) {
  const method = message.method;
  const id = message.id;
  // A JSON-RPC response also carries an id, so only a message with a method is
  // a request we should track.
  const isRequest = typeof method === 'string' && id !== undefined && id !== null;
  const name = message.params?.name;

  if (method === 'tools/call' && isRequest) {
    if (META_TOOL_NAMES.has(name)) {
      if (!handleMetaCall(message)) {
        sendToolError(id, `Unknown broker meta-tool "${String(name)}".`);
      }
      return;
    }
    if (state.native && typeof name === 'string') {
      // Strict call routing for native contracts: a name the manifest does not
      // expose is an error result, never a forward to a backend that cannot know
      // it. Canonical aliases and correctly prefixed native names pass.
      const unknownReason = unknownNativeToolReason(name);
      if (unknownReason !== null) {
        sendToolError(id, unknownReason);
        return;
      }
    }
    if (typeof name === 'string' && state.engine !== null && state.profiles !== null) {
      const support = supportFor(name);
      if (support === 'none') {
        sendToolError(
          id,
          `Tool "${name}" is not exposed by the "${state.engineId}" engine manifest (support: none).`,
        );
        return;
      }
      if (!profileAllowsTool(name)) {
        sendToolError(
          id,
          `Tool "${name}" is hidden by the "${state.toolProfile}" tool profile (support: ${support}). ` +
            'Set "Tool profile" (tool_profile) to "full" and restart Claude Code to expose it.',
        );
        return;
      }
    }
    if (typeof name === 'string' && state.disabled.has(name)) {
      sendToolError(
        id,
        `Tool "${name}" is disabled by the cloakbrowser plugin. Remove it from the "disabled_tools" setting and restart Claude Code to use it.`,
      );
      return;
    }
    if (!backendAlive()) {
      sendToolError(id, `Cannot call "${String(name)}": ${backendDescription()}.`);
      return;
    }
  }

  if (!backendAlive()) {
    if (!isRequest) {
      log(`dropping client notification "${String(method)}": ${backendDescription()}`);
      return;
    }
    if (method === 'initialize') {
      noteInitializeRequest(message);
      synthesizeInitialize(id, backendDescription());
      return;
    }
    if (method === 'tools/list') {
      sendMetaOnlyList(id, message.params?.cursor);
      return;
    }
    if (method === 'ping') {
      sendResult(id, {});
      return;
    }
    sendError(id, -32603, `Cannot handle "${String(method)}": ${backendDescription()}.`);
    return;
  }

  if (isRequest && state.native && method === 'tools/call' && typeof name === 'string') {
    // Translate the canonical name and its arguments into the native tool the
    // manifest names. Exactly one native call per canonical call; the result is
    // passed through untouched.
    const resolution = resolveNativeCall({
      manifest: state.engine,
      contracts: state.contractSchemas,
      surface: state.nativeSurface,
      exposedName: name,
      args: message.params?.arguments,
      profileValue: nativeProfileValue(),
    });
    if (resolution.error !== null) {
      sendToolError(id, resolution.error);
      return;
    }
    rawLine = JSON.stringify({
      ...message,
      params: { ...message.params, name: resolution.native, arguments: resolution.arguments },
    });
  }

  if (isRequest) {
    state.pendingRequests.set(id, {
      method,
      cursor: message.params?.cursor,
      sentAt: Date.now(),
    });
    if (method === 'initialize') {
      noteInitializeRequest(message);
    }
  }
  if (!forwardToBackend(rawLine)) {
    if (isRequest) {
      state.pendingRequests.delete(id);
      if (method === 'initialize') {
        synthesizeInitialize(id, backendDescription());
      } else if (method === 'tools/list') {
        sendMetaOnlyList(id, message.params?.cursor);
      } else {
        sendError(id, -32603, `Cannot handle "${String(method)}": ${backendDescription()}.`);
      }
    }
  }
}

// A backend that answered a forwarded request is alive, even when the answer is
// an error. Once it answers tools/list or a tool call, a rejected initialize is
// no longer the last word: the state returns to running and the rejection stays
// visible through initializeRejected and lastError.
function noteBackendAnswered(pending) {
  state.backendAnswered = true;
  if (
    state.initializeRejected &&
    state.backend.state === 'failed' &&
    (pending?.method === 'tools/list' || pending?.method === 'tools/call')
  ) {
    state.backend.state = 'running';
  }
}

function handleBackendMessage(message, rawLine) {
  if (message === null || typeof message !== 'object') {
    return;
  }
  const id = message.id;
  const isResponse = message.method === undefined && id !== undefined && id !== null;
  const pending = isResponse ? state.pendingRequests.get(id) : undefined;
  if (isResponse) {
    noteBackendAnswered(pending);
    state.pendingRequests.delete(id);
  }

  // An engine whose manifest declares a runtime hint gets one actionable
  // sentence appended to a failed tool result, until a tool call succeeds in
  // this process. Protocol errors are never rewritten, and engines without the
  // hint keep the raw line byte-for-byte.
  if (pending?.method === 'tools/call' && message.error === undefined) {
    if (message.result?.isError === true) {
      // Evidence that the manifest's system dependency is absent: the
      // manifest's own runtime hint explains the failure. Only engines that
      // declare dependencies read this flag, and any later success clears it.
      if (runtimeHint !== null && systemDependencies(state.engine).length > 0) {
        state.systemDependencyMissing = true;
        state.lastError = state.lastError === null ? runtimeHint : state.lastError;
      }
      if (runtimeHint !== null && !state.toolCallSucceeded) {
        const enriched = enrichToolError(message.result, runtimeHint);
        if (enriched !== null) {
          process.stdout.write(`${JSON.stringify({ ...message, result: enriched })}\n`);
          return;
        }
      }
    } else {
      state.toolCallSucceeded = true;
      // A successful call is evidence the backend (and any app it attaches to)
      // is present; the dependency status returns to "unknown", never
      // "installed". Only engines that declare dependencies read this flag.
      state.systemDependencyMissing = false;
    }
  }

  if (pending?.method === 'initialize' && message.error !== undefined) {
    const reason = message.error?.message ?? 'unknown error';
    state.initializeRejected = true;
    state.lastError = `Backend rejected initialize: ${String(reason)}${protocolEraHint(reason)}`;
    state.backend.state = 'failed';
  }

  if (pending?.method === 'initialize' && message.error === undefined) {
    state.initializeAnswered = true;
    state.initializeAnsweredAt = Date.now();
    state.serverInfo = message.result?.serverInfo ?? null;
    state.backendCapabilities = message.result?.capabilities ?? null;
    if (state.backend.state === 'starting' || state.backend.state === 'idle') {
      state.backend.state = 'running';
    }
    // The artifact sentence is the one addition to a relayed handshake, and it is
    // added on every path. A workspace fallback keeps its own sentence after the
    // backend's text and before the artifact fact; every other initialise
    // response is otherwise unchanged. An isolated start adds the one honest
    // "nothing persists" sentence (2.11.0); shared and workspace text is
    // unchanged.
    const result = message.result !== null && typeof message.result === 'object' ? message.result : {};
    const current = typeof result.instructions === 'string' ? result.instructions.trim() : '';
    const parts = [
      current,
      state.profile.fallback === null ? '' : state.profile.fallback.reason,
      // Copy start (2.12.0) and copy-keep (2.13.0): one honest sentence, only
      // when a copy is actually running, so shared/workspace/isolated text is
      // unchanged. The copy-keep sentence says the changes are kept and the
      // previous tree is retained.
      state.profile.copy === null || state.profile.copy === undefined ? '' : (copyReportNote() ?? ''),
      state.profile.isolated && state.profile.appliesToEngine ? PROFILE_ISOLATED_NOTE : '',
      identitySentence(),
      passwordManagerSentence(),
      artifactDirectorySentence(),
    ];
    message.result = {
      ...result,
      instructions: parts.filter((part) => part !== '').join(' '),
    };
    process.stdout.write(`${JSON.stringify(message)}\n`);
    return;
  }

  if (pending?.method === 'tools/list' && Array.isArray(message.result?.tools)) {
    const waitMs = Date.now() - pending.sentAt;
    state.lastToolsListWaitMs = waitMs;
    const rawTools = message.result.tools;
    recordBackendTools(rawTools, pending.cursor !== undefined);
    if (state.native) {
      // A native backend lists its own tools; the broker replaces that list
      // with the manifest's surface. mcp-camoufox answers in one page, so a
      // cursor must not make the surface repeat itself.
      if (pending.cursor !== undefined && pending.cursor !== null && pending.cursor !== '') {
        sendResult(id, { tools: [] });
        return;
      }
      const surface = buildNativeSurface({
        manifest: state.engine,
        contracts: state.contractSchemas,
        backendTools: state.backendTools,
        toolProfile: state.toolProfile,
        profiles: state.profiles,
        disabled: state.disabled,
      });
      if (surface.error !== null) {
        state.nativeSurface = null;
        state.nativeSurfaceError = surface.error;
        state.lastError = surface.error;
        log(surface.error);
        sendMetaOnlyList(id, null);
        return;
      }
      state.nativeSurface = surface;
      state.nativeSurfaceError = null;
      const tools = [...surface.tools, ...metaToolList()];
      state.lastExposedCount = tools.length;
      sendResult(id, { ...message.result, tools });
      return;
    }
    const addMeta = pending.cursor === undefined || pending.cursor === null || pending.cursor === '';
    // Filter the page the backend just returned, not the accumulated cache;
    // otherwise a paginated second page would repeat the first page.
    const filteredTools = filterTools(rawTools, addMeta);
    state.lastExposedCount = filteredTools.length;
    const filtered = { ...message.result, tools: filteredTools };
    sendResult(id, filtered);
    return;
  }

  // Everything else is relayed unchanged so the backend MCP response stays
  // byte-for-byte what the client would have received through proxy.mjs.
  process.stdout.write(`${rawLine}\n`);
}

function startBackend() {
  if (state.engineError !== null) {
    log(`not starting a backend: ${state.engineError}`);
    return;
  }
  const launcher = path.join(PLUGIN_ROOT, resolveLauncherName(state.engine));
  state.backend.state = 'starting';
  state.spawnedAt = Date.now();
  log(
    `engine=${state.engineId} source=${state.engineSource} contract=${state.engine.contract} ` +
      `profile=${state.toolProfile} profileSource=${state.toolProfileSource} launcher=${path.basename(launcher)}`,
  );
  // Only an active account/workspace profile, a fallback, an isolated start or a
  // proxy-file decision adds a line, so the default start-up log stays
  // byte-identical.
  if (
    state.profile.source === 'account' ||
    state.profile.source === 'workspace' ||
    state.profile.isolated ||
    state.proxy.source !== 'none' ||
    state.profile.fallback !== null
  ) {
    log(
      `account=${state.profile.account ?? 'none'} profileSource=${state.profile.source ?? 'none'} ` +
        `proxySource=${state.proxy.source} profileDir=${state.profile.dir ?? 'none'}`,
    );
  }
  const child = spawn(process.execPath, [launcher], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // The manifest is the source of truth for the selected engine; keep the
    // legacy backend variable in sync even if only STEALTH_ENGINE was set. The
    // account profile and the file proxy are added only when they were resolved;
    // otherwise the environment is the base plus that one variable. The resolved
    // default artifact directory is passed the way every launcher and engine
    // honours it; an explicit output_dir already reaches the engine through the
    // plugin env and is never rewritten, and an engine that ignores output_dir
    // never receives it.
    env: backendEnvironment(process.env, {
      engineId: state.engineId,
      profileDir: state.profile.dir,
      proxyServer: state.proxy.appliedProxy,
      outputDir: OUTPUT_DIR_SOURCE === 'default' ? outputDirState.dir : null,
      isolated: state.profile.isolated,
    }),
    windowsHide: true,
    detached: false,
  });
  state.child = child;
  state.backend.pid = child.pid ?? null;

  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim() === '') {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // stdout is reserved for JSON-RPC; a non-JSON backend line is a bug and
      // must not corrupt the client stream.
      log(`backend wrote non-JSON to stdout: ${line.slice(0, 300)}`);
      return;
    }
    handleBackendMessage(message, line);
  });

  child.stderr.on('data', (chunk) => {
    // A credential-bearing proxy URL must never reach the log or a status
    // payload. Ordinary lines are unchanged; redaction only rewrites a
    // scheme://userinfo@host pattern.
    const text = redactSecrets(chunk.toString('utf8'));
    process.stderr.write(text);
    state.stderrTail = `${state.stderrTail}${text}`.slice(-4000);
  });

  child.stdin.on('error', (error) => {
    log(`backend stdin error: ${error.message}`);
  });

  child.on('error', (error) => {
    state.lastError = `Failed to start backend: ${error.message}`;
    state.backend.state = 'failed';
    log(state.lastError);
    drainPendingRequests(backendDescription());
  });

  child.on('exit', (code, signal) => {
    const wasStarting = state.backend.state === 'starting';
    state.child = null;
    state.backend.exitCode = code;
    state.backend.exitSignal = signal;
    state.backend.state = wasStarting ? 'failed' : 'exited';
    if (!state.shuttingDown) {
      const detail = signal === null ? `code ${String(code)}` : `signal ${signal}`;
      // The last stderr line explains most backend exits (a profile lock, a
      // missing package, a refused licence seat). It is reported for every
      // engine, not only those that declare a runtime hint.
      const launcherLine = lastStderrLine(state.stderrTail);
      state.lastError =
        launcherLine === null ? `Backend exited (${detail}).` : `Backend exited (${detail}): ${launcherLine}`;
      log(state.lastError);
      drainPendingRequests(backendDescription());
    }
    if (state.shuttingDown) {
      // A client-initiated stdin EOF is a normal shutdown, including the
      // forced taskkill path, so do not surface the child's signal code. The
      // copy-mode session tree is discarded and the base lock released here,
      // after the backend (and its browser tree) has exited.
      completeShutdown();
    }
  });
}

process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') {
    log(`stdout error: ${error.message}`);
  }
});

readline
  .createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on('line', (line) => {
    if (line.trim() === '') {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Preserve the old proxy behaviour for non-JSON input: pass it through.
      if (!forwardToBackend(line)) {
        log('dropped non-JSON client line because the backend is unavailable');
      }
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      log('dropped client line that is not a JSON-RPC object');
      return;
    }
    // The answer to the broker's own roots/list probe is a response, and the
    // backend has no request with this id: it is consumed here, never relayed.
    if (message.method === undefined && message.id === ROOTS_PROBE_ID) {
      handleClientRootsAnswer(message);
      return;
    }
    // While the artifact directory is unresolved the backend has not started
    // yet: buffer every line in arrival order and resolve the directory on the
    // initialize request, which is where the client states whether it supports
    // roots at all. The buffer is replayed by beginDeferredStart().
    if (outputDirUnresolved()) {
      deferredStart.lines.push(line);
      if (message.method === 'initialize') {
        noteInitializeRequest(message);
        beginDeferredStart();
        return;
      }
      const isRequest = typeof message.method === 'string' && message.id !== undefined && message.id !== null;
      if (isRequest && message.method !== 'server/discover') {
        // No initialize is coming (or this client never sends one): the
        // plugin-data default is all that can be chosen, and the backend must
        // start now to answer this request as before.
        beginDeferredStartWithoutRoots(message.method);
      }
      return;
    }
    handleClientRequest(message, line);
  })
  .on('close', beginShutdown);

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, beginShutdown);
}

if (state.engineError !== null) {
  log(state.engineError);
}

// The artifact directory can depend on the client's roots (2.10.1). When it
// does, the backend must not start until the client's initialize arrives and the
// value is resolved, because the engine reads PLAYWRIGHT_MCP_OUTPUT_DIR from its
// environment at start; all client lines are buffered until then. With an
// explicit output_dir, an engine that ignores it, or a failed engine, the start
// is exactly the previous path.
if (outputDirUnresolved() && state.engineError === null) {
  log('backend start deferred until initialize: the artifact directory depends on the client roots');
} else {
  startBackend();
}
