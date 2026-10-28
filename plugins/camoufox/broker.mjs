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
import { createHash } from 'node:crypto';
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
  manifestExtensionPaths,
  manifestIdentityCopy,
  manifestProfileApplies,
  manifestProvisioningRecord,
  manifestSingleSeat,
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
  PASSWORD_MANAGER_PREFS_SENTENCE,
  passwordUserConfigProblem,
  readPasswordPolicyRecord,
  resolvePasswordManager,
  SEARCH_ENGINE_DEFAULT,
  sha256File,
} from './lib/password-manager.mjs';
import { isRealDirectory, overlayPolicyPath, overlayRoot } from './lib/camoufox-overlay.mjs';
import { launcherSettingsReport } from './lib/launcher-settings.mjs';
import { PING_TIMEOUT_ENGINE_ID, pingTimeoutProblemNote, resolvePingTimeout } from './lib/ping-timeout.mjs';
import { readProvisioningRecord } from './lib/provision.mjs';
import { readToolCache, toolCacheKey, toolCachePath, writeToolCache } from './lib/tool-cache.mjs';
import {
  accountNameError,
  accountProxyPath,
  backendEnvironment,
  COPY_CONTENTS_FULL,
  COPY_CONTENTS_IDENTITY,
  COPY_CONTENTS_SOURCE_CLAMPED,
  COPY_KEEP_LOCK_POLL_MS,
  COPY_KEEP_LOCK_WAIT_MS,
  copyContentsClampedNote,
  copyPlanToTarget,
  createProfileLock,
  DEFAULT_PROFILE_NAME,
  effectiveProfileDir,
  engineLockBlocksStart,
  engineProfileLockFix,
  engineProfileLockMessage,
  extensionPathsProblemText,
  INVALID_ACCOUNT_HINT,
  ISOLATED_IGNORED_POINTER,
  isCopyIsolation,
  isPathInsideRoot,
  isolatedIgnoredEntry,
  listPreviousTrees,
  listSessionCopies,
  lockBlocksStart,
  ON_LOCKED_COPY,
  planCopy,
  PROFILE_FALLBACK_FIRST_SUFFIX,
  PROFILE_FALLBACK_LAST_SUFFIX,
  PROFILE_ISOLATED_NATIVE_NOTE,
  PROFILE_ISOLATED_NOTE,
  PROFILE_ISOLATED_POINTER_NOTE,
  PROFILE_LIFETIME_BROWSER,
  PROFILE_LOCK_FILENAME,
  PROFILE_ON_LOCKED_ISOLATED_NOTE,
  profileCopyKeepNote,
  profileCopyNotApplicableNote,
  profileCopyNote,
  profileCopyOnLockReason,
  profileDefaultPointerDir,
  profileDefaultPointerPath,
  profileFallbackReason,
  profileIgnoredReason,
  profileLockFix,
  profileLockMessage,
  profileOnLockedIsolatedReason,
  readAccountProxy,
  readEngineProfileLock,
  readProfileDefaultPointer,
  readProfileLock,
  readSwapRecord,
  redactSecrets,
  releaseProfileLock,
  resolveCopyContents,
  resolveExtensionPaths,
  resolveOnLocked,
  resolveProfile,
  resolveProfileIsolation,
  resolveProfileLifetime,
  resolveSeatLimit,
  restrictPlanToIdentity,
  scanLiveEngineLocks,
  SEAT_LIMIT_UNLIMITED,
  SEAT_LIMIT_VENDOR,
  selectFallbackProfile,
  sessionCopyDir,
  sessionCopyHasLiveLock,
  SESSION_OWNER_FILENAME,
  SESSION_ROOT_DIRNAME,
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
      'Report the selected browser engine, its Playwright MCP contract, the active tool profile, the backend tool count, per-tool support and how to change engines. It also reports the default-profile pointer, the server working directory, the effective artifact directory and the MCP roots the client advertised, which together explain a file-access refusal. This is a local broker tool; it does not start a browser. When another session already uses the browser profile, it also reports the profile directory, the owning process and the fix, plus the on_locked policy: with "fallback" this session runs on a numbered sibling profile, and with "isolated" it runs with no profile, both reported under onLocked and profileFallback.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_engine_status',
    description:
      'Report the selected engine, backend process state, backend version when the handshake has completed, startup timing and the last error. A backend that rejected the initialize handshake but still answers tools reports `initializeRejected: true` and stays running. This is a local broker tool; it does not start a browser. When another session already uses the browser profile, it also reports the profile directory, the owning process and the fix, plus the on_locked policy: with "fallback" this session runs on a numbered sibling profile, and with "isolated" it runs with no profile, both reported under onLocked and profileFallback.',
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
// on_locked (2.16.0). What this start does when the profile it resolved is held
// by another process: "block" is the 2.15 behaviour (meta-only, loud), "fallback"
// starts on the first free numbered sibling of the same profile, and "isolated"
// starts with no profile at all. Unset, empty, a placeholder and an unknown value
// all mean "fallback"; an unknown value is logged once and never fails a start.
const onLockedSetting =
  typeof process.env.STEALTH_ON_LOCKED === 'string' ? process.env.STEALTH_ON_LOCKED : '';
const onLockedResolution = resolveOnLocked(onLockedSetting);
if (onLockedResolution.placeholder !== null) {
  log(`ignoring unsubstituted on-locked placeholder: ${onLockedResolution.placeholder.trim()}`);
}
if (onLockedResolution.ignored !== null) {
  log(`ignoring unknown on-locked policy: ${onLockedResolution.ignored}`);
}
const onLocked = onLockedResolution.mode;
// profile_lifetime (2.20.0): how long this session holds the profile facts it
// owns (the broker's own base lock and, in a copy mode, the session copy). The
// default is "browser": the lock is taken at the first browser action, released
// when the browser closes, and taken again on the next browser action. "server"
// is the 2.12-2.19 behaviour. An unset, empty, placeholder or unknown value is
// the default; an unknown value is logged once and never fails a start.
const profileLifetimeSetting =
  typeof process.env.STEALTH_PROFILE_LIFETIME === 'string' ? process.env.STEALTH_PROFILE_LIFETIME : '';
const profileLifetimeResolution = resolveProfileLifetime(profileLifetimeSetting);
if (profileLifetimeResolution.placeholder !== null) {
  log(`ignoring unsubstituted profile-lifetime placeholder: ${profileLifetimeResolution.placeholder.trim()}`);
}
if (profileLifetimeResolution.ignored !== null) {
  log(`ignoring unknown profile lifetime: ${profileLifetimeResolution.ignored}`);
}
const profileLifetime = profileLifetimeResolution.mode;
// copy_contents (2.20.0): what a session copy contains. "identity" (the default
// since 2.21.0) keeps the identity core the engine's manifest lists; "full" is
// the whole plan and therefore exactly what 2.12-2.19 copied. An engine without
// an identityCopy descriptor cannot honour the tier, so it copies the full tree
// and says so. The effective tier also depends on the isolation mode (copy-keep
// may never run on a thin tree), so it is computed below, after copyKeepMode.
const copyContentsSetting =
  typeof process.env.STEALTH_COPY_CONTENTS === 'string' ? process.env.STEALTH_COPY_CONTENTS : '';
const copyContentsResolution = resolveCopyContents(copyContentsSetting);
if (copyContentsResolution.placeholder !== null) {
  log(`ignoring unsubstituted copy-contents placeholder: ${copyContentsResolution.placeholder.trim()}`);
}
if (copyContentsResolution.ignored !== null) {
  log(`ignoring unknown copy contents: ${copyContentsResolution.ignored}`);
}
const identityCopyDescriptor = engine === null ? null : manifestIdentityCopy(engine);
const copyContentsRequested = copyContentsResolution.mode;
// seat_limit (2.20.0): the concurrent-browser capacity of an engine that has a
// seat concept. "engine-default" is the manifest's own rule (today's behaviour);
// "unlimited" and "vendor-license" are the user's licence assertions. The
// setting is declared in the universal plugin only, so the dedicated Camoufox
// plugin has no key and this resolves to the default there.
const seatLimitSetting =
  typeof process.env.STEALTH_SEAT_LIMIT === 'string' ? process.env.STEALTH_SEAT_LIMIT : '';
const seatLimitResolution = resolveSeatLimit(seatLimitSetting);
if (seatLimitResolution.placeholder !== null) {
  log(`ignoring unsubstituted seat-limit placeholder: ${seatLimitResolution.placeholder.trim()}`);
}
if (seatLimitResolution.ignored !== null) {
  log(`ignoring unknown seat limit: ${seatLimitResolution.ignored}`);
}
const seatLimit = seatLimitResolution.mode;
// An engine that owns its profile elsewhere, or attaches to one, declares
// profileApplies: false; the whole profile model is inert for it.
const profileApplies = engine !== null && manifestProfileApplies(engine);
// An engine that declares one concurrent browser seat (the free CloakBrowser
// licence) cannot run a second browser on a sibling profile: a busy profile is
// held and retried instead (2.16.0). The rule is the manifest's, not an engine
// id's, and it is inert for every other engine.
const singleSeat = engine !== null && manifestSingleSeat(engine);
// The mode itself, before the engine's profileApplies says whether it can act.
const isolatedMode = profileIsolation.mode === 'isolated';
// Both copy modes share everything except what a clean shutdown does with the
// session tree; `copyKeepMode` names the one that swaps.
const copyMode = isCopyIsolation(profileIsolation.mode);
const copyKeepMode = profileIsolation.mode === 'copy-keep';
// The mode's own name in every user-facing sentence, so "copy" text stays
// byte-identical and "copy-keep" never claims to be the other mode.
const copyModeLabel = profileIsolation.mode;
// The effective copy tier (2.21.0). Two clamps, in this order:
//   1. copy-keep always keeps the full tree. Its session copy is renamed into the
//      base path on a clean close (swapSessionCopyIntoBase), so a thin identity
//      copy would REPLACE the base's IndexedDB, OPFS and caches with a fragment and
//      the loss would be permanent from the live path. A setting may never
//      silently destroy data, so the tier is replaced in code and every payload
//      reports copyContentsSource "clamped" with the one-line reason.
//   2. an engine with no identityCopy descriptor can only copy the whole plan.
const copyContentsClamped = copyKeepMode === true;
const copyContents =
  copyContentsClamped || (copyContentsRequested === COPY_CONTENTS_IDENTITY && identityCopyDescriptor === null)
    ? COPY_CONTENTS_FULL
    : copyContentsRequested;
const copyContentsSource = copyContentsClamped ? COPY_CONTENTS_SOURCE_CLAMPED : copyContentsResolution.source;
if (copyContentsRequested !== copyContents) {
  log(
    copyContentsClamped
      ? `copy_contents is "${copyContentsRequested}", but profile_isolation "${copyModeLabel}" replaces the base ` +
          'profile on a clean close, so its copy keeps the full tree (clamped; nothing is silently destroyed)'
      : `copy_contents is "identity" but the "${selected.id}" engine declares no identityCopy descriptor, ` +
          'so a copy keeps the full tree (nothing is silently downgraded without this line)',
  );
}
const copyContentsIgnoredNote = copyContentsClamped
  ? copyContentsClampedNote(copyModeLabel)
  : copyContentsRequested !== copyContents
    ? `copy_contents is "${COPY_CONTENTS_IDENTITY}", but the "${selected.id}" engine declares no identityCopy ` +
      'descriptor, so the copy keeps the full tree.'
    : null;

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
const profileResolutionArgs =
  engine === null
    ? null
    : {
        account: rawAccount,
        profileDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR,
        pointer: profilePointer === null ? null : profilePointer.name,
        engineId: engine.id,
        dataDir: PLUGIN_DATA_DIR,
        launcherName: resolveLauncherName(engine),
        ignoredSettings: Array.isArray(engine.ignoredSettings) ? engine.ignoredSettings : [],
        profileApplies,
        cwd: process.cwd(),
      };
let profileResolution =
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
    : resolveProfile({ ...profileResolutionArgs, isolation: profileIsolation.mode });
// What an isolated start ignored, in the order the resolution checked it. A
// pointer file that exists but cannot be used has no name to pass, so the broker
// adds it here; the report is the same shape either way. It is a function because
// on_locked=isolated can turn this start into an isolated one during the lock
// preflight, after the first resolution.
function profileIgnoredForStart() {
  return profileResolution.profileSource === 'isolated'
    ? [
        ...(profileResolution.ignored ?? []),
        ...(profilePointer !== null && profilePointer.exists === true && profilePointer.name === null
          ? [isolatedIgnoredEntry(ISOLATED_IGNORED_POINTER, profilePointer.path)]
          : []),
      ]
    : [];
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
//   on_locked=block:                a busy profile stops the spawn; the owner and
//                                   the fix are reported instead (the 2.15 shape).
//   on_locked=fallback:             a busy profile the plugin manages moves to its
//                                   first free numbered sibling (-2 ... -5), whose
//                                   bridge lock and engine lock must both be free;
//                                   the switch is always reported.
//   on_locked=isolated:             a busy profile the plugin manages becomes an
//                                   isolated start: no profile, no lock, nothing
//                                   saved, also always reported.
//   workspace (profile_isolation):  its own numbered fallback, unchanged.
//   profile_dir (explicit path):    always the block behaviour, whatever
//                                   on_locked says: creating <path>-2 in a folder
//                                   the plugin does not own would be unpredictable.
//   isolated (profile_isolation):   no profile exists, so no lock is read at all.
let profileLock = null;
let profileFallback = null;
let engineProfileLock = null;
// True when on_locked=isolated turned this start into an isolated one. The
// configured profile_isolation is reported unchanged; this flag reports why.
let onLockedIsolated = false;
// The base profile an on_locked=fallback moved this start away from, or null. It
// is not reported: the profile .proxy file beside the base still applies (a proxy
// is configuration, not identity) and a fresh sibling has no file of its own. The
// workspace rule keeps reading the sibling's own file, as it always has.
let onLockedFallbackBase = null;
// --- copy on lock (2.20.0) ---------------------------------------------------
// on_locked=copy runs this session on a temporary copy of the base profile it
// resolved. The base stays its owner's: the copy takes no lock of its own, and
// under profile_isolation copy/copy-keep the value means "wait for the base,
// then take the copy" (a copy is never taken of a copy). The copy lands in the
// same .sessions layout a copy-mode session uses, so list/prune and the owner
// marker are unchanged.
// `pendingCopy` is a copy this session owes but has not taken yet: under
// profile_lifetime "browser" nothing is locked or copied until the first browser
// action. The session directory is computed once, here, and reused for every
// re-copy in this session, because the backend was started with it.
let pendingCopy = null;
let copyFallbackOwner = null;
// The live state object, once it exists. The copy helpers run at module level
// (a "server" lifetime takes its copy during startup, before `state` is built),
// and a few of them must also correct the already-built state when they run
// later; this is the one reference that makes that safe on both paths.
let stateRef = null;
// --- single-seat hold (2.16.0) ----------------------------------------------
// An engine that declares one concurrent browser seat cannot start a second
// browser on a sibling profile, so a busy profile is not moved aside: the server
// stays up, serves its cached tool list, answers tool calls with an isError that
// names the owner, and re-runs this preflight on every call. When the profile is
// free the backend starts, the client's handshake is replayed to it, the
// triggering call is forwarded, and the client is told to re-list its tools.
// Nothing is created, locked or deleted while waiting.
const holdState = {
  active: false,
  // "waiting" while held, "recovered" after the backend started, "failed" when
  // the recovery start itself could not proceed (a copy that could not be made).
  state: null,
  profileDir: null,
  owner: null,
  attempts: 0,
  recoveredAt: null,
  reason: null,
  // The seat facts that made this start wait (2.20.0), or null when the wait is
  // the plain single-seat rule. Reported by browser_capabilities and
  // browser_engine_status inside hold.
  seat: null,
  // { source: 'cache' | 'none', path, savedAt, error } once a held list is served.
  cache: null,
  // The client's own lines to replay into the backend on recovery. Only the
  // handshake is kept: every other line was answered by the broker already.
  initializeLine: null,
  initializedLine: null,
  // True while the handshake still has to be replayed into the backend.
  handshakePending: false,
};

function holdOwnerText(owner) {
  if (owner === null || typeof owner !== 'object' || typeof owner.pid !== 'number') {
    return 'another process';
  }
  return `pid ${owner.pid}${typeof owner.createdAt === 'string' ? `, started ${owner.createdAt}` : ''}`;
}

function holdReasonText(profileDir, owner) {
  return (
    `The ${selected.id} browser profile ${profileDir} is already in use (${holdOwnerText(owner)}). ` +
    'This session keeps its tool list and retries automatically on the next tool call, so close the ' +
    'session or browser that owns the profile and call a tool again; no restart is needed.'
  );
}

function beginHold(profileDir, lock, engineLock) {
  holdState.active = true;
  holdState.state = 'waiting';
  holdState.profileDir = profileDir;
  holdState.owner = lock?.owner ?? null;
  holdState.reason = holdReasonText(profileDir, holdState.owner);
  log(holdState.reason);
  if (lock !== null) {
    profileLock = { ...lock, fix: null };
  }
  if (engineLock !== null) {
    engineProfileLock = { ...engineLock, fix: null };
  }
}
if (engineError === null && profileApplies && profileResolution.profileSource !== 'isolated') {
  const lockDir = effectiveProfileDir(profileResolution);
  if (lockDir !== null) {
    const lock = readProfileLock(lockDir);
    // An engine that declares its own lock file (Camoufox: Firefox's parent.lock)
    // adds a second check. It is read here, once, so a live holder of either lock
    // can trigger the on_locked policy; the reporting below is unchanged.
    const engineOwnerLock =
      engine !== null && engine.profileLock !== undefined
        ? readEngineProfileLock(lockDir, engine.profileLock)
        : null;
    const bridgeBlocks = lockBlocksStart(lock);
    const engineBlocks = engineOwnerLock !== null && engineLockBlocksStart(engineOwnerLock);
    // Only a profile the plugin manages is given a sibling or an isolated start.
    const pluginManaged = profileResolution.profileSource !== 'profile_dir';
    // The engine lock is read from the directory this start will actually use. The
    // workspace rule keeps its 2.15 reading (the base directory) so its bytes and
    // outcome do not change; an on_locked fallback reads the sibling it chose.
    let engineLockDir = lockDir;
    if ((bridgeBlocks || engineBlocks) && onLocked === 'isolated' && pluginManaged) {
      const blocking = bridgeBlocks ? lock : engineOwnerLock;
      profileResolution = resolveProfile({ ...profileResolutionArgs, isolation: 'isolated' });
      onLockedIsolated = true;
      profileFallback = { from: lockDir, to: null, reason: profileOnLockedIsolatedReason(blocking) };
      log(profileFallback.reason);
    } else if ((bridgeBlocks || engineBlocks) && onLocked === 'fallback' && singleSeat) {
      // One concurrent browser seat: a sibling profile would only fail at the
      // first browser action, so this start holds the profile and retries. It
      // applies to a plugin-managed profile and to an explicit profile_dir alike:
      // a hold creates and moves nothing, which is exactly why the sibling rule
      // excludes an explicit path.
      beginHold(lockDir, bridgeBlocks ? lock : null, bridgeBlocks ? null : engineOwnerLock);
    } else if ((bridgeBlocks || engineBlocks) && onLocked === ON_LOCKED_COPY && pluginManaged && !copyMode) {
      // Copy on lock (2.20.0). The base keeps its owner: the copy takes no lock
      // of its own, because the owner's lock is the reservation. A seat-limited
      // engine is gated before anything is copied: a browser may only start when
      // a seat is free, and "no seat" is the existing hold, never a second
      // CloakBrowser.
      const blocking = bridgeBlocks ? lock : engineOwnerLock;
      const seat = seatFacts();
      if (seat !== null && seat.seatFree === false) {
        beginHold(lockDir, bridgeBlocks ? lock : null, bridgeBlocks ? null : engineOwnerLock);
        holdState.reason = seatHoldReason(lockDir, blocking?.owner ?? null, seat);
        holdState.seat = seat;
        log(holdState.reason);
      } else {
        copyFallbackOwner = blocking?.owner ?? null;
        pendingCopy = {
          kind: 'on-locked',
          baseDir: lockDir,
          sessionDir: sessionCopyDir(selected.id, PLUGIN_DATA_DIR, lockDir),
          owner: copyFallbackOwner,
          at: new Date().toISOString(),
          lock: blocking,
        };
        profileFallback = copyFallbackFor(pendingCopy);
        log(
          `on_locked=copy: ${lockDir} is busy, so this session will run on a temporary copy ` +
            `at ${pendingCopy.sessionDir}`,
        );
      }
    } else if ((bridgeBlocks || engineBlocks) && onLocked === ON_LOCKED_COPY && copyMode && pluginManaged) {
      // A copy is never taken of a copy. Under profile_isolation copy/copy-keep
      // this value means "wait for the base, then take the copy": the 2.16.0
      // hold, whose recovery path prepares the copy through prepareCopySession.
      beginHold(lockDir, bridgeBlocks ? lock : null, bridgeBlocks ? null : engineOwnerLock);
    } else if (bridgeBlocks) {
      const workspaceProfile =
        !singleSeat &&
        profileIsolation.mode === 'workspace' &&
        profileResolution.profileSource === 'workspace'
          ? true
          : false;
      // (A single-seat engine never gets a sibling of any kind: a workspace
      // sibling is a second browser it cannot run, so the workspace rule is
      // skipped for it under every policy and `block` stops the start instead.)
      const fallbackKind = workspaceProfile ? 'workspace' : 'sibling';
      // 2.20.0 seals the 2.16.0 regression: the copy modes never move to a
      // numbered sibling. Their base is either free to copy or the start is
      // refused loudly, exactly as 2.12-2.15 behaved.
      const wantsFallback = workspaceProfile || (onLocked === 'fallback' && pluginManaged && !copyMode);
      // A sibling is free only when both of its locks are free. The workspace rule
      // keeps its original bridge-lock-only test so its outcome does not change.
      const siblingBlocked = workspaceProfile
        ? (candidate) => lockBlocksStart(readProfileLock(candidate))
        : (candidate) =>
            lockBlocksStart(readProfileLock(candidate)) ||
            (engine !== null &&
              engine.profileLock !== undefined &&
              engineLockBlocksStart(readEngineProfileLock(candidate, engine.profileLock)));
      const fallbackDir = wantsFallback ? selectFallbackProfile(lockDir, siblingBlocked) : null;
      if (fallbackDir !== null) {
        profileFallback = {
          from: lockDir,
          to: fallbackDir,
          kind: fallbackKind === 'workspace' ? 'workspace' : 'sibling',
          // The 2026-10-28 incident: a sibling that did not exist is created
          // empty, and the session runs on a profile with none of the base's
          // data. The fact is reported, and the sentence says it out loud.
          createdEmpty: !existsSync(fallbackDir),
          reason: profileFallbackReason(lock, fallbackDir, fallbackKind, {
            createdEmpty: !existsSync(fallbackDir),
          }),
        };
        profileResolution.profileDir = fallbackDir;
        profileLock = readProfileLock(fallbackDir);
        if (fallbackKind !== 'workspace') {
          engineLockDir = fallbackDir;
          onLockedFallbackBase = lockDir;
        }
        log(profileFallback.reason);
      } else {
        profileLock = { ...lock, fix: profileLockFix(lock) };
        engineError = profileLockMessage(lock, { fallbackExhausted: wantsFallback, fallbackKind });
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
    // The engine's own lock is reported on the directory this start uses. A live
    // owner stops the spawn with the same loud, actionable start, unless
    // on_locked=fallback can move this start to a free numbered sibling instead
    // (only when no fallback has happened yet, so at most one switch per start).
    // The file is never written, moved or deleted; a stale one is reported and
    // allowed.
    if (
      !onLockedIsolated &&
      !holdState.active &&
      engineError === null &&
      engine !== null &&
      engine.profileLock !== undefined
    ) {
      let engineOwnerLockNow =
        engineLockDir === lockDir && engineOwnerLock !== null
          ? engineOwnerLock
          : readEngineProfileLock(engineLockDir, engine.profileLock);
      let attemptedFallback = false;
      if (
        engineLockBlocksStart(engineOwnerLockNow) &&
        onLocked === 'fallback' &&
        pluginManaged &&
        profileFallback === null
      ) {
        attemptedFallback = true;
        const siblingBlocked = (candidate) =>
          lockBlocksStart(readProfileLock(candidate)) ||
          engineLockBlocksStart(readEngineProfileLock(candidate, engine.profileLock));
        const fallbackDir = selectFallbackProfile(engineLockDir, siblingBlocked);
        if (fallbackDir !== null) {
          profileFallback = {
            from: engineLockDir,
            to: fallbackDir,
            reason: profileFallbackReason(engineOwnerLockNow, fallbackDir, 'on-locked'),
          };
          profileResolution.profileDir = fallbackDir;
          profileLock = readProfileLock(fallbackDir);
          engineOwnerLockNow = readEngineProfileLock(fallbackDir, engine.profileLock);
          onLockedFallbackBase = engineLockDir;
          log(profileFallback.reason);
        }
      }
      engineProfileLock = { ...engineOwnerLockNow, fix: engineProfileLockFix(engineOwnerLockNow) };
      if (engineLockBlocksStart(engineOwnerLockNow) && pendingCopy === null) {
        engineError = engineProfileLockMessage(
          engineOwnerLockNow,
          attemptedFallback
            ? {
                trailing:
                  `The numbered sibling profiles (suffixes ${PROFILE_FALLBACK_FIRST_SUFFIX} to ` +
                  `${PROFILE_FALLBACK_LAST_SUFFIX}) are also in use. The backend was not started.`,
              }
            : {},
        );
        if (copyMode) {
          engineError += ` Profile isolation is "${copyModeLabel}", so the base profile was not copied.`;
        }
        log(engineError);
      } else if (engineOwnerLockNow.state === 'stale') {
        log(
          `engine profile lock ${engineOwnerLockNow.path} is stale (no live process holds it); ` +
            'the browser replaces it',
        );
      } else if (engineOwnerLockNow.state === 'unknown') {
        log(engineOwnerLockNow.error);
      } else if (pendingCopy !== null) {
        // on_locked=copy (2.20.0): the base's own lock is live, and that is the
        // reservation this session relies on. Nothing is started on the base; the
        // copy runs on its own directory and owns no lock.
        log(
          `on_locked=copy: the engine lock ${engineOwnerLockNow.path} is held by the base's owner; ` +
            'this session runs on its copy and never on the base',
        );
      }
    }
  }
}
// --- unpacked extensions (2.18.0) -------------------------------------------
// An opt-in list of unpacked Chromium extension directories. The setting is
// resolved here, after the profile preflight, so an isolated start (the setting
// itself, or an on_locked switch) is already known, and before any copy is
// prepared, so a refused start copies nothing. The manifest decides whether the
// active engine can load unpacked extensions at all; an engine that does not
// declare support reports the setting as not applicable and never receives it,
// so it can never be applied somewhere it does not work.
//
// Refusals are loud and meta-only, exactly like the profile ones: an extension is
// arbitrary code inside the browser, and a start that silently dropped the list
// would look like it loaded something it did not. Nothing is ever partially
// applied: one bad entry refuses the whole list.
const EXTENSION_PATHS_ISOLATED_REASON =
  'Unpacked extensions need a persistent browser profile, and this start is isolated ' +
  '(profile_isolation "isolated", or on_locked "isolated" after a busy profile), so no profile is ' +
  'created, locked or saved and the configured extension directories cannot be loaded.';
const extensionResolution = resolveExtensionPaths(process.env);
if (extensionResolution.problem === 'placeholder') {
  log(`ignoring unsubstituted extension-paths placeholder: ${String(extensionResolution.raw)}`);
}
const extensionSupported = engine !== null && manifestExtensionPaths(engine);
const extensionIsolated = profileResolution.profileSource === 'isolated';
let extensionApplies = false;
let extensionNote = null;
if (extensionResolution.configured && !extensionSupported) {
  extensionNote =
    `The "${selected.id}" engine does not declare unpacked-extension support, so the extension_paths ` +
    'setting is ignored and no extension path was passed to the backend.';
} else if (extensionResolution.configured && extensionResolution.error !== null) {
  if (engineError === null) {
    engineError = `${extensionPathsProblemText(extensionResolution.error)} The backend was not started.`;
    log(engineError);
  }
} else if (extensionResolution.configured && extensionIsolated) {
  extensionNote =
    `${EXTENSION_PATHS_ISOLATED_REASON} Set Profile isolation (profile_isolation) to shared, ` +
    'or to copy or copy-keep, which keep a persistent profile.';
  if (engineError === null) {
    engineError =
      `${EXTENSION_PATHS_ISOLATED_REASON} Set Profile isolation (profile_isolation) to shared, ` +
      'or to copy or copy-keep, which keep a persistent profile, and restart the MCP server. ' +
      'The backend was not started.';
    log(engineError);
  }
} else if (extensionResolution.configured) {
  extensionApplies = true;
  const count = extensionResolution.paths.length;
  log(
    `unpacked extensions: ${String(count)} director${count === 1 ? 'y' : 'ies'} from the ` +
      `${extensionResolution.source} will be loaded`,
  );
}
// The facts every payload and the spawn environment read. `paths` is null unless
// the whole list resolved, so a caller can never pass a partial list on.
const extensionState = {
  configured: extensionResolution.configured,
  supported: extensionSupported,
  applies: extensionApplies,
  source: extensionResolution.source,
  entries: extensionResolution.entries,
  paths: extensionResolution.paths,
  error: extensionResolution.error,
  note: extensionNote,
};

const profileIgnored = profileIgnoredForStart();
if (profileIgnored.length > 0) {
  log(profileIgnoredReason(profileIgnored));
}

// The profile directory an optional .proxy file sits beside: an account or
// workspace profile, or the default profile when the broker sets nothing.
function proxyCandidate() {
  // An on_locked fallback keeps the base profile's proxy file: a proxy is
  // configuration, not identity, and the new sibling has no file of its own.
  if (onLockedFallbackBase !== null) {
    return onLockedFallbackBase;
  }
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
  const raw =
    typeof process.env.PLAYWRIGHT_MCP_PROXY_SERVER === 'string'
      ? process.env.PLAYWRIGHT_MCP_PROXY_SERVER.trim()
      : '';
  // An unsubstituted placeholder is a missing substitution, not a proxy: used as
  // a URL it would fail the browser at its first start (2.21.0). It is treated
  // exactly like an empty value, and the launchers drop it for the same reason.
  const setting = raw.includes('${') ? '' : raw;
  if (setting === '' && raw !== '') {
    log(`ignoring unsubstituted proxy-server placeholder: ${raw}`);
  }
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
// The engine's own lock file name, excluded from every copy plan.
function copyEngineLockFile() {
  return engine !== null && engine.profileLock !== undefined && typeof engine.profileLock.file === 'string'
    ? engine.profileLock.file
    : null;
}
// A copy that fails because the operating system refused a read has one usual
// cause, and the user needs it named: on Windows a browser that is still writing
// its profile holds some of its databases exclusively (measured 2026-10-28: the
// live Default/Network/Cookies cannot even be opened for reading), so no retry
// can win while it runs. The refusal stays a refusal - a copy without the cookie
// jar would look logged in and would not be - and the alternatives are offered.
const COPY_REFUSAL_CODES = new Set(['EBUSY', 'EACCES', 'EPERM']);

// One sentence with exactly one full stop, whichever layer wrote the text.
function sentence(text) {
  const trimmed = String(text).trim();
  return trimmed.endsWith('.') ? `${trimmed} ` : `${trimmed}. `;
}

function copyFailureHint(error) {
  const code = error?.code ?? '';
  const message = String(error?.message ?? '');
  // The copy engine wraps a refused file in a ProfileCopyError, so the original
  // code survives only in the text ("EBUSY: resource busy or locked").
  const refused =
    COPY_REFUSAL_CODES.has(code) ||
    COPY_REFUSAL_CODES.has(error?.cause?.code ?? '') ||
    /(EBUSY|EACCES|EPERM)/u.test(message) ||
    /resource busy or locked/iu.test(message);
  if (!refused) {
    return '';
  }
  return (
    ' Windows refused to read a file the copy needs because another process holds it exclusively; a browser ' +
    'that is still writing the profile is the usual cause, and closing it (or setting on_locked to ' +
    '"fallback" or "block") is the fix. Nothing was copied from that profile and it was not written.'
  );
}

// The plan for one copy. "full" is exactly the plan 2.12-2.19 produced, byte for
// byte; "identity" filters that same plan through the engine's identityCopy
// descriptor, so the two tiers can never disagree about exclusions or bytes.
function copyPlanFor(baseDir) {
  const plan = planCopy(baseDir, { engineLockFile: copyEngineLockFile() });
  if (copyContents !== COPY_CONTENTS_IDENTITY || identityCopyDescriptor === null) {
    return plan;
  }
  const restricted = restrictPlanToIdentity(plan, identityCopyDescriptor.keep);
  log(
    `copy_contents "identity": keeping ${restricted.files.length} of ${plan.files.length} files ` +
      `(${restricted.bytes} of ${plan.bytes} bytes)`,
  );
  return restricted;
}
// The copy object every report reads. `state` moves prepared -> discarded (the
// tree was removed) or leftover (it could not be removed, and is reported).
function buildCopyReport({ kind, baseDir, sessionDir, baseCreated, plan, lockHandle, owner, at }) {
  return {
    kind,
    baseDir,
    sessionDir,
    baseCreated,
    owner: owner ?? null,
    takenAt: at ?? new Date().toISOString(),
    baseLock:
      lockHandle === null
        ? null
        : { path: lockHandle.path, owner: lockHandle.owner, reclaimed: lockHandle.reclaimed },
    copied: {
      files: plan.files.length,
      directories: plan.directories.length,
      bytes: plan.bytes,
    },
    scope: copyContents,
    ...(plan.identity === undefined
      ? {}
      : { identity: { keep: plan.identity.keep.length, keptFiles: plan.identity.keptFiles } }),
    state: 'prepared',
    discarded: false,
    leftover: null,
    // copy-keep only: the swap this session will attempt on a clean close. While
    // the session runs its state is "pending"; the result is written to the
    // engine's swap record and reported by the next browser_profiles call.
    swap: copyKeepMode ? { state: 'pending', previousDir: null, restored: false, error: null } : null,
  };
}
// Copy one base into one session directory and mark it. Nothing outside the
// session directory is created, written, moved or deleted.
function writeSessionCopy({ baseDir, sessionDir, label, plan }) {
  copyPlanToTarget(plan, sessionDir, { targetName: path.basename(sessionDir) });
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
      `profile ${label}: cannot write the session owner marker in ${sessionDir}: ${error.message}; ` +
        'the bridge lock protects the copy once the backend starts',
    );
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
// Since 2.20.0 the session directory can be passed in (profile_lifetime
// "browser" reuses one path for every re-copy, because the backend was started
// with it).
function prepareCopySession(options = {}) {
  const baseDir =
    typeof options.baseDir === 'string' && options.baseDir !== ''
      ? options.baseDir
      : effectiveProfileDir(profileResolution);
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
  const sessionDir =
    typeof options.sessionDir === 'string' && options.sessionDir !== ''
      ? options.sessionDir
      : sessionCopyDir(selected.id, PLUGIN_DATA_DIR, baseDir);
  if (copyKeepMode && isPathInsideRoot(sessionDir, baseDir)) {
    engineError =
      `profile_isolation "copy-keep" cannot replace the base profile ${baseDir} because it contains ` +
      `this session's copy directory ${sessionDir}. Set "Profile directory" (profile_dir) to a profile ` +
      "folder, not to the folder that holds the engine's profiles. The backend was not started.";
    log(engineError);
    return null;
  }
  // A re-copy reuses this session's path, so a tree that could not be removed
  // when the browser closed is retried once before the fresh copy is refused.
  if (existsSync(sessionDir)) {
    const removed = removeSessionCopyWithRetry(sessionDir);
    if (!removed.ok) {
      engineError =
        `profile_isolation "${copyModeLabel}" cannot take a fresh copy because the previous session copy ` +
        `${sessionDir} could not be removed (${redactSecrets(removed.error ?? 'unknown error')}). ` +
        'Close anything holding it, or remove it with scripts/profile-copy.mjs --prune, then call again. ' +
        'The backend was not started.';
      log(engineError);
      return null;
    }
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
  let plan;
  try {
    plan = copyPlanFor(baseDir);
    writeSessionCopy({ baseDir, sessionDir, label: copyModeLabel, plan });
  } catch (error) {
    const released = releaseProfileLock(held);
    if (released.error !== null) {
      log(released.error);
    }
    engineError =
      `The ${copyModeLabel}-mode session copy failed: ${sentence(redactSecrets(error?.message ?? String(error)))}` +
      `${copyFailureHint(error)} The backend was not started.`;
    log(engineError);
    return null;
  }
  log(
    `profile ${copyModeLabel}: base=${baseDir} copy=${sessionDir} files=${plan.files.length} ` +
      `bytes=${plan.bytes}${baseCreated ? ' baseCreated=true' : ''}`,
  );
  copyBaseLockHandle = held;
  return buildCopyReport({
    kind: copyKeepMode ? 'copy-keep' : 'copy',
    baseDir,
    sessionDir,
    baseCreated,
    plan,
    lockHandle: held,
    at: new Date().toISOString(),
  });
}
// on_locked=copy (2.20.0): the base keeps its owner, so this copy takes no lock
// of its own and the base is only ever read. A base that does not exist here is
// a fact the caller must not paper over: the copy would be empty, which is the
// incident this mode exists to avoid.
//
// 2.21.0: the seat is re-read here, at take time. The start-time preflight
// checked it when the copy was planned; a lazy copy is taken at the first browser
// action, and another session may have opened its browser in between. A session
// with no seat free must never start a second CloakBrowser, so the copy is not
// taken and this start goes down the 2.16.0 hold path instead: the copy is no
// longer owed, the cached tool list stays, and when the base is free this session
// runs on the real profile.
function prepareOnLockedCopy(request) {
  const baseDir = request.baseDir;
  const sessionDir = request.sessionDir;
  const seat = seatFacts();
  if (seat !== null && seat.seatFree === false) {
    pendingCopy = null;
    copyFallbackOwner = null;
    profileFallback = null;
    beginHold(baseDir, request.lock ?? null, null);
    holdState.reason = seatHoldReason(baseDir, request.owner ?? null, seat);
    holdState.seat = seat;
    if (stateRef !== null) {
      stateRef.profile.fallback = null;
      stateRef.profile.pendingCopy = null;
      stateRef.profile.copyPendingError = null;
      stateRef.backend.state = 'waiting-for-profile';
    }
    log(holdState.reason);
    return null;
  }
  if (!existsSync(baseDir)) {
    engineError =
      `on_locked "copy" cannot copy the busy profile ${baseDir} because it no longer exists. ` +
      'The backend was not started; no other profile was used.';
    log(engineError);
    return null;
  }
  if (existsSync(sessionDir)) {
    const removed = removeSessionCopyWithRetry(sessionDir);
    if (!removed.ok) {
      engineError =
        `on_locked "copy" cannot take a fresh copy because the previous session copy ${sessionDir} could not ` +
        `be removed (${redactSecrets(removed.error ?? 'unknown error')}). Close anything holding it, or remove ` +
        'it with scripts/profile-copy.mjs --prune, then call again. The backend was not started; no other ' +
        'profile was used.';
      log(engineError);
      return null;
    }
  }
  let plan;
  try {
    plan = copyPlanFor(baseDir);
    writeSessionCopy({ baseDir, sessionDir, label: 'copy-on-lock', plan });
  } catch (error) {
    engineError =
      `The copy-on-lock session copy failed: ${sentence(redactSecrets(error?.message ?? String(error)))}` +
      `${copyFailureHint(error)} The backend was not started; no other profile was used.`;
    log(engineError);
    return null;
  }
  log(
    `on_locked=copy: base=${baseDir} copy=${sessionDir} files=${plan.files.length} bytes=${plan.bytes} ` +
      `owner=${request.owner?.pid ?? 'unknown'}`,
  );
  return buildCopyReport({
    kind: 'on-locked',
    baseDir,
    sessionDir,
    baseCreated: false,
    plan,
    lockHandle: null,
    owner: request.owner ?? null,
    at: request.at ?? new Date().toISOString(),
  });
}
// The profileFallback object an on_locked=copy start reports. Its reason is the
// one sentence every surface shares (R8 wording for 2.20.0).
function copyFallbackFor(request) {
  return {
    from: request.baseDir,
    to: request.sessionDir,
    kind: 'copy',
    createdEmpty: false,
    reason: profileCopyOnLockReason({
      baseDir: request.baseDir,
      sessionDir: request.sessionDir,
      owner: request.owner,
      at: request.at,
      contents: copyContents,
    }),
  };
}
// Take the copy this session owes as soon as the setting allows it. Under
// profile_lifetime "server" that is now (start), under "browser" it is the first
// browser action (takePendingCopyAtBrowserAction).
function takePendingCopyNow() {
  if (pendingCopy === null) {
    return false;
  }
  const request = pendingCopy;
  const copy =
    request.kind === 'on-locked'
      ? prepareOnLockedCopy(request)
      : prepareCopySession({ baseDir: request.baseDir, sessionDir: request.sessionDir });
  if (copy === null) {
    return false;
  }
  pendingCopy = null;
  copySession = copy;
  return true;
}
// The copy was just taken: make the live state describe it. Used by both paths
// that take a copy after the module's own state was built (the first browser
// action since 2.20.0, the cold-surface start since 2.21.0), so the two can never
// disagree about the directory the backend runs on.
function adoptTakenCopy() {
  state.profile.copy = copySession;
  state.profile.dir = copySession.sessionDir;
  state.profile.pendingCopy = null;
  state.profile.copyPendingError = null;
  // The copy directory is now known, so the identity facts (and the sentence the
  // handshake carries) describe the profile this session actually uses.
  state.identity = identityFacts();
}
// A copy that could not be taken: the refusal belongs to this call (the base may
// be free on the next one), so the session-level engineError keeps its previous
// value and the copy stays owed.
function recordCopyRefusal(before) {
  const refusal = engineError;
  engineError = before;
  state.profile.copyPendingError = pendingCopy === null ? null : refusal;
  state.profile.pendingCopy = pendingCopy;
  return refusal;
}
// --- cold-surface start (2.21.0) ---------------------------------------------
// The invariant: no configuration may leave the client with a tool list it cannot
// act on. While a copy is deferred, tools/list is answered from the cache; on a
// machine that has never cached this exact surface (a new install, a plugin
// release before 2.21.0, a changed pin or group switch) there is nothing to serve,
// and the three meta-tools start no browser — so the copy that would create the
// cache could never be taken and the session stayed dead until a restart.
// When that is the case the copy is taken and the backend started before the list
// is answered. It costs one copy and one spawn per new surface; after that the
// cache exists and every later start stays lazy again.
function coldCopyStartNeeded() {
  if (pendingCopy === null || state.child !== null) {
    return false;
  }
  return ensureHeldToolList().source === 'none';
}

function takeColdCopyNow() {
  if (pendingCopy === null) {
    return false;
  }
  const before = engineError;
  if (!takePendingCopyNow()) {
    recordCopyRefusal(before);
    log(
      'cold start: this configuration has no cached tool list and the session copy could not be taken, so the ' +
        'broker meta-tools answer tools/list until the copy succeeds',
    );
    return false;
  }
  adoptTakenCopy();
  log(
    'cold start: no cached tool list exists for this configuration, so the session copy is taken now and the ' +
      'backend starts before the client asks for its tool list',
  );
  return true;
}

// The copy this session owes is taken at the first browser action. The backend is
// spawned with the copy's directory in its environment, so the copy is on disk
// before the spawn; a re-copy after the browser closed reuses this session's path
// (the backend was started with it and cannot be told a new one without M2).
function ensureBrowserSessionCopy(rawLine) {
  if (state.profile.pendingCopy === null) {
    return { ok: true };
  }
  const before = engineError;
  if (!takePendingCopyNow()) {
    const refusal = recordCopyRefusal(before);
    return {
      ok: false,
      // 2.21.0: the copy was refused because no browser seat is free, which is the
      // 2.16.0 hold — the caller answers with the hold sentence, not with a copy
      // error.
      held: holdState.active,
      error: refusal ?? 'the session copy could not be taken',
    };
  }
  adoptTakenCopy();
  if (state.child === null) {
    if (outputDirUnresolved()) {
      // The artifact directory still needs the client's roots (bounded 2 s). The
      // call is buffered and replayed by the deferred-start path, after the
      // handshake has been replayed into the backend.
      deferredStart.lines.push(rawLine);
      state.hold.handshakePending = true;
      if (!holdResolutionPending) {
        holdResolutionPending = true;
        const resume = () => {
          holdResolutionPending = false;
          startBackendIfNeeded();
          notifyToolsListChanged();
        };
        resolveOutputDir().then(resume, resume);
      }
      return { ok: true, queued: true };
    }
    startBackend();
    if (state.child === null) {
      return { ok: false, error: state.lastError ?? backendDescription() };
    }
    // The client's handshake was answered by the broker (no backend existed yet);
    // the new backend gets the exact lines through the one replay function.
    if (state.clientHandshake.initializeLine !== null) {
      state.hold.initializeLine = state.clientHandshake.initializeLine;
    }
    if (state.clientHandshake.initializedLine !== null) {
      state.hold.initializedLine = state.clientHandshake.initializedLine;
    }
    replayHeldHandshake();
    notifyToolsListChanged();
  }
  return { ok: true };
}

// The isError a first browser action gets when the copy it owes cannot be taken.
function pendingCopyToolError(name) {
  const detail =
    state.profile.copyPendingError ??
    (state.profile.pendingCopy === null
      ? 'The session copy is not ready.'
      : copyFallbackFor(state.profile.pendingCopy).reason);
  return (
    `Cannot call "${String(name)}" yet. ${detail} ` +
    'This session did not start a browser and no other profile was used; the next tool call tries again.'
  );
}

// on_locked=isolated (2.16.0) before a copy: the busy base turned this start
// into an isolated one, so there is nothing to copy and no profile to hold. The
// switch is reported by profileFallback and onLocked on every surface. A held
// start (single-seat engine) makes its copy at recovery, when the base is free.
// profile_lifetime "browser" (2.20.0, the default) defers both the base lock and
// the copy to the first browser action: an idle session locks and copies nothing.
if (copyMode && engineError === null && profileApplies && !onLockedIsolated && !holdState.active) {
  const baseDir = effectiveProfileDir(profileResolution);
  if (profileLifetime === PROFILE_LIFETIME_BROWSER && baseDir !== null) {
    pendingCopy = {
      kind: 'isolation',
      baseDir,
      sessionDir: sessionCopyDir(selected.id, PLUGIN_DATA_DIR, baseDir),
      owner: null,
      at: new Date().toISOString(),
    };
  } else {
    copySession = prepareCopySession();
  }
} else if (engineError === null && profileApplies && pendingCopy !== null) {
  if (profileLifetime === PROFILE_LIFETIME_BROWSER) {
    log(
      `profile_lifetime "browser": the copy of ${pendingCopy.baseDir} and the base lock are taken at the ` +
        'first browser action, not at start',
    );
  } else {
    takePendingCopyNow();
  }
}

// --- session copy lifetime (2.20.0) ------------------------------------------
// Deleting a session copy is the one destructive operation in this file, so it
// is asserted to a path this broker created: <plugin data>/profiles/<engine>/
// .sessions/<something>. Retried because a browser that has just exited may
// still hold a file for a few hundred milliseconds on Windows; a tree that still
// cannot be removed is kept and reported as a leftover, never silently lost.
const COPY_DELETE_ATTEMPTS = 6;
const COPY_DELETE_BACKOFF_MS = Object.freeze([250, 500, 750, 1000, 1250, 1500]);

function sessionCopyRoot() {
  return path.join(PLUGIN_DATA_DIR, 'profiles', selected.id, SESSION_ROOT_DIRNAME);
}

function removeSessionCopyWithRetry(sessionDir) {
  if (!isPathInsideRoot(sessionDir, sessionCopyRoot())) {
    return {
      ok: false,
      attempts: 0,
      error: `${sessionDir} is not a session copy of the "${selected.id}" engine, so it is never removed`,
    };
  }
  let lastError = null;
  for (let attempt = 1; attempt <= COPY_DELETE_ATTEMPTS; attempt += 1) {
    try {
      rmSync(sessionDir, { recursive: true, force: true });
      return { ok: true, attempts: attempt, error: null };
    } catch (error) {
      lastError = error?.message ?? String(error);
      if (attempt < COPY_DELETE_ATTEMPTS) {
        sleepSync(COPY_DELETE_BACKOFF_MS[attempt - 1]);
      }
    }
  }
  return { ok: false, attempts: COPY_DELETE_ATTEMPTS, error: lastError };
}

// --- seat gate (2.20.0) -------------------------------------------------------
// The rule is capacity, not a permanent "one browser": the manifest's singleSeat
// is the free-tier default, and seat_limit raises or removes the cap. Three
// layers, in this order and never merged: (1) this scan of the engine locks the
// plugin manages, always and offline; (2) the vendor's own session-seat API,
// only when seat_limit is "vendor-license" AND a licence key is configured (a
// live network call, opt-in, documented); (3) the exit-code interpretation in
// noteSeatDenial, always on, as the backstop. "Unknown" is treated as no seat,
// which falls back to the hold and always works.
const SEAT_VENDOR_CACHE_MS = 60_000;
let vendorSeatCache = null;

function configuredLicenceKey() {
  const raw =
    typeof process.env.CLOAKBROWSER_LICENSE_KEY === 'string'
      ? process.env.CLOAKBROWSER_LICENSE_KEY.trim()
      : '';
  return raw === '' || raw.includes('${') ? null : raw;
}

// The launcher adapter (launch.mjs --seat-status) resolves and provisions the
// engine package, which the broker cannot do; it prints one JSON line. Any
// failure is reported as an unavailable answer, never as a seat.
function vendorSeatStatus() {
  if (configuredLicenceKey() === null) {
    return { state: 'unavailable', reason: 'no licence key is configured', limit: null, active: null };
  }
  const now = Date.now();
  if (vendorSeatCache !== null && now - vendorSeatCache.at < SEAT_VENDOR_CACHE_MS) {
    return vendorSeatCache.status;
  }
  let status;
  try {
    const launcher = path.join(PLUGIN_ROOT, resolveLauncherName(engine));
    const result = spawnSync(process.execPath, [launcher, '--seat-status'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: process.env,
      timeout: 120_000,
      windowsHide: true,
    });
    const line = String(result?.stdout ?? '')
      .trim()
      .split('\n')
      .filter((entry) => entry.trim() !== '')
      .pop();
    const parsed = line === undefined ? null : JSON.parse(line);
    status =
      parsed !== null && typeof parsed === 'object'
        ? {
            state: typeof parsed.state === 'string' ? parsed.state : 'unknown',
            active: typeof parsed.active === 'number' ? parsed.active : null,
            limit: typeof parsed.limit === 'number' ? parsed.limit : null,
            reason: typeof parsed.reason === 'string' ? parsed.reason : null,
          }
        : { state: 'unknown', active: null, limit: null, reason: null };
  } catch (error) {
    status = { state: 'unavailable', active: null, limit: null, reason: error?.message ?? String(error) };
  }
  log(
    `seat_limit "vendor-license": the vendor answered state=${status.state}` +
      `${status.limit === null ? '' : ` limit=${status.limit}`}` +
      `${status.reason === null ? '' : ` (${status.reason})`}`,
  );
  vendorSeatCache = { at: now, status };
  return status;
}

// The effective capacity and use count, or null when the engine has no seat
// concept at all (no singleSeat and the default setting) — then no seat key and
// no gate ever appears.
function seatFacts() {
  if (!singleSeat && seatLimit === 'engine-default') {
    return null;
  }
  let capacity = singleSeat ? 1 : 'unlimited';
  let source = 'manifest';
  let vendor = null;
  if (seatLimit === SEAT_LIMIT_UNLIMITED) {
    capacity = 'unlimited';
    source = 'setting';
  } else if (seatLimit === SEAT_LIMIT_VENDOR) {
    vendor = vendorSeatStatus();
    if (vendor.state === 'ok' && typeof vendor.limit === 'number') {
      capacity = vendor.limit;
      source = 'vendor';
    } else if (vendor.state === 'ok') {
      // An OK answer without a cap is the vendor saying "no limit to count".
      capacity = 'unlimited';
      source = 'vendor';
    }
  }
  const scan = scanLiveEngineLocks(selected.id, PLUGIN_DATA_DIR, engine?.profileLock ?? null);
  const seatsInUse = scan.count;
  const seatFree = capacity === 'unlimited' ? true : seatsInUse < capacity;
  return {
    seatLimit: capacity,
    seatLimitSource: source,
    seatsInUse,
    seatFree,
    seatScanTruncated: scan.truncated === true,
    seatVendor: vendor === null ? null : { state: vendor.state, reason: vendor.reason },
  };
}

function seatHoldReason(profileDir, owner, seat) {
  return (
    `The profile ${profileDir} is in use (${holdOwnerText(owner)}) and the ${selected.id} seat limit for this ` +
    `licence is reached (${seat.seatsInUse}/${String(seat.seatLimit)}), so this session waits; it will start ` +
    'on the real profile when a seat frees. It is not running on a different profile.'
  );
}

// Layer 3: the engine's own licence denial. The wrapper documents exit codes
// 76-79 for a seat over-cap, a bad key, an unreachable licence server and a local
// configuration problem; Playwright embeds the number as "<process did exit:
// exitCode=N>". The patterns are the wrapper's own (dist/license.js), anchored so
// an unrelated "exitCode=" cannot false-match. Once seen, the session never
// re-attempts the same launch: retrying a licence denial is a loop, not a fix.
const SEAT_DENIAL_CODES = new Map([
  [76, 'the session limit for this licence is reached'],
  [77, 'the licence key is invalid, expired or missing'],
  [78, 'the licence could not be verified (the licence server was unreachable)'],
  [79, 'a local configuration problem prevented the licence check'],
]);
const SEAT_DENIAL_PATTERNS = Object.freeze([
  /process did exit:\s*exitCode=(\d+)/u,
  /Failed to launch the browser process:\s*Code:\s*(\d+)/u,
  /exited with (?:exit )?code (\d+)/iu,
]);

function seatDenialFromText(text) {
  if (typeof text !== 'string' || text === '') {
    return null;
  }
  for (const pattern of SEAT_DENIAL_PATTERNS) {
    const match = text.match(pattern);
    if (match !== null) {
      const code = Number(match[1]);
      const reason = SEAT_DENIAL_CODES.get(code);
      if (reason !== undefined) {
        return { code, reason };
      }
      // A known pattern with an unrelated code (a genuine crash) is not a
      // licence answer: it must keep its own error, never be relabelled.
      return null;
    }
  }
  return null;
}

function recordSeatDenial(denial, source) {
  if (state.seatDenied !== null) {
    return;
  }
  state.seatDenied = { code: denial.code, reason: denial.reason, source, at: new Date().toISOString() };
  log(
    `seat gate: ${source} reported licence exit code ${denial.code} (${denial.reason}); this session will not ` +
      'attempt another launch',
  );
}

function noteSeatDenialInAnswer(message) {
  if (state.seatDenied !== null) {
    return;
  }
  const texts = [];
  if (typeof message?.error?.message === 'string') {
    texts.push(message.error.message);
  }
  const content = message?.result?.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (entry !== null && typeof entry === 'object' && typeof entry.text === 'string') {
        texts.push(entry.text);
      }
    }
  }
  for (const text of texts) {
    const denial = seatDenialFromText(text);
    if (denial !== null) {
      recordSeatDenial(denial, 'a tool answer');
      return;
    }
  }
}

// --- browser lifecycle: the engine lock is the authority (2.20.0) -------------
// The browser is created on the first tool call, so the engine's own lock file
// (Chromium lockfile / Firefox parent.lock) is probed right after every forwarded
// tool response and, only while it is latched open, polled. browser_close and a
// result carrying _meta.isClose are the instant paths. The bridge's lock is
// never touched (M2): it stays server-scoped and every payload says so.
const BROWSER_POLL_MS = 1000;
const CLOSE_TOOL_NAMES = (() => {
  const names = new Set(['browser_close']);
  const aliases = engine !== null && typeof engine.toolAliases === 'object' ? engine.toolAliases : {};
  for (const [canonical, native] of Object.entries(aliases)) {
    if (canonical === 'browser_close' || native === 'browser_close') {
      names.add(canonical);
      names.add(String(native));
    }
  }
  return names;
})();

function isCloseToolName(name) {
  return typeof name === 'string' && CLOSE_TOOL_NAMES.has(name);
}

// The directory whose engine lock proves a browser is open for this session, or
// null when this start has no profile or the engine declares no lock file.
function browserProfileDir() {
  if (!profileApplies || state.profile.isolated || state.profile.onLockedIsolated) {
    return null;
  }
  if (state.engine === null || state.engine.profileLock === undefined) {
    return null;
  }
  return currentProfileDir();
}

function probeBrowser() {
  const dir = browserProfileDir();
  if (dir === null) {
    return null;
  }
  let lock;
  try {
    lock = readEngineProfileLock(dir, state.engine.profileLock);
  } catch {
    return null;
  }
  return { dir, lock, live: engineLockBlocksStart(lock) };
}

function stopBrowserWatch() {
  if (state.browser.timer !== null) {
    clearInterval(state.browser.timer);
    state.browser.timer = null;
  }
}

function startBrowserWatch() {
  if (state.browser.timer !== null || state.shuttingDown) {
    return;
  }
  state.browser.timer = setInterval(() => {
    const probe = probeBrowser();
    if (probe === null) {
      stopBrowserWatch();
      return;
    }
    if (!probe.live) {
      noteBrowserClosed('engine-lock');
    }
  }, BROWSER_POLL_MS);
}

// Called after every forwarded tools/call response. Latches the fact that a
// browser is open (the call created it), and releases the session copy when the
// browser is already gone.
function noteBrowserAfterCall(pending, message) {
  const result = message !== null && typeof message === 'object' ? message.result : null;
  const failed = message?.error !== undefined || result?.isError === true;
  if (!failed && result !== null && typeof result === 'object' && result._meta?.isClose === true) {
    noteBrowserClosed('close-meta');
    return;
  }
  if (!failed && isCloseToolName(pending?.name)) {
    noteBrowserClosed('close-tool');
    return;
  }
  if (failed) {
    return;
  }
  const probe = probeBrowser();
  if (probe === null) {
    return;
  }
  if (probe.live) {
    if (state.browser.open !== true) {
      state.browser.open = true;
      state.browser.source = 'engine-lock';
      state.browser.changedAt = Date.now();
      log(`browser open: the engine lock ${probe.lock.path} is held by the browser on ${probe.dir}`);
    }
    startBrowserWatch();
    return;
  }
  if (state.browser.open === true) {
    noteBrowserClosed('engine-lock');
  }
}

function noteBrowserClosed(source) {
  stopBrowserWatch();
  const wasOpen = state.browser.open;
  state.browser.open = false;
  state.browser.source = source;
  state.browser.changedAt = Date.now();
  if (wasOpen !== true) {
    log(`browser close observed (${source})`);
  } else {
    log(`browser closed (${source}); releasing what this session holds for it`);
  }
  releaseSessionForClosedBrowser();
}

// The copy is discarded when the browser closes: the base lock is released, the
// session copy is removed (six bounded attempts) and the next browser action
// takes a fresh copy at the same path. copy-keep is deliberately excluded: its
// tree holds the session's changes and is swapped into the base at a clean
// close, so nothing here may remove or roll it back. Under profile_lifetime
// "server" nothing is released here; the clean shutdown does it, as before.
function releaseSessionForClosedBrowser() {
  const copy = state.profile.copy;
  if (copy === null || copy === undefined || state.profile.lifetime !== PROFILE_LIFETIME_BROWSER) {
    return;
  }
  if (copy.kind === 'copy-keep' || copy.state === 'discarded') {
    return;
  }
  const removed = removeSessionCopyWithRetry(copy.sessionDir);
  if (!removed.ok) {
    copy.state = 'leftover';
    copy.leftover = { path: copy.sessionDir, error: removed.error };
    log(
      `profile ${copy.kind}: the session copy ${copy.sessionDir} could not be removed after ` +
        `${removed.attempts} attempts (${removed.error}); it is kept and listed by browser_profiles and ` +
        'scripts/profile-copy.mjs --prune',
    );
    return;
  }
  copy.state = 'discarded';
  copy.discarded = true;
  copy.leftover = null;
  log(`profile ${copy.kind}: discarded session copy ${copy.sessionDir} after the browser closed`);
  // The copy is owed again: the next browser action takes a fresh snapshot of the
  // base at this same path (the backend was started with it and cannot be told a
  // new one without M2). Without this re-arm the backend would recreate an EMPTY
  // profile at the deleted path and the session would silently lose its identity.
  if (copy.kind !== 'on-locked') {
    releaseCopyBaseLock();
  }
  pendingCopy = {
    kind: copy.kind,
    baseDir: copy.baseDir,
    sessionDir: copy.sessionDir,
    owner: copy.owner ?? null,
    at: new Date().toISOString(),
  };
  state.profile.pendingCopy = pendingCopy;
  log(`profile ${copy.kind}: a fresh copy will be taken at the next browser action`);
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
  if (copyMode || (pendingCopy !== null && pendingCopy.kind === 'on-locked')) {
    if (copySession !== null && copySession !== undefined) {
      return copySession.sessionDir;
    }
    // profile_lifetime "browser": the copy this session will run on is known by
    // path before it is taken, so the identity file the report names is the one
    // the copy will carry.
    return pendingCopy !== null ? pendingCopy.sessionDir : null;
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
  if (
    (copyMode || (pendingCopy !== null && pendingCopy.kind === 'on-locked')) &&
    copySession === null &&
    pendingCopy === null
  ) {
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

// --- saved logins and autofill (2.16.0; overlay always-on in 2.17.0) --------
// The `password_manager` setting. The pinned Camoufox build locks Firefox's
// login manager off through its own enterprise policy, so enabling it needs a
// plugin-owned overlay of the build (hardlinks/junctions plus a policy document
// with only the two password values true; see lib/camoufox-overlay.mjs). Since
// 2.17.0 that overlay is always built for the camoufox engine (it also restores
// the stock search-engine list), so this group reports the password side only
// when the setting is on and adds no key otherwise. The broker never creates or
// writes the overlay: it reports the launcher's ownership record and the store's
// *file existence* only, re-checking the recorded overlay directory and policy
// hash cheaply. Off (the default) adds no key to any payload, so every engine
// stays byte-identical; on, the applying engine reports what happened and the
// engines that cannot apply it say so.
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

const PASSWORD_MANAGER_BLOCKED_NOTES = Object.freeze({
  'blocked-by-overlay':
    'Saved logins: the Camoufox overlay build could not be created or verified, so the stock build is in use ' +
    'and the setting stays off for this start.',
  'blocked-by-existing-overlay':
    'Saved logins: the overlay path already holds something this plugin did not write, so it is left untouched ' +
    'and the setting stays off for this start.',
  'blocked-config':
    'Saved logins: the wrapper config cannot carry the saved-login prefs, so the setting stays off for this start.',
  'blocked-by-build-policy':
    'Saved logins: the Camoufox build policy is missing or unreadable, so the overlay cannot be derived and the ' +
    'setting stays off for this start.',
  // Written only by the retained per-user route (2.15.0), which no shipped
  // platform reaches; kept readable so an old record is still understood.
  'blocked-by-existing-policy':
    'Saved logins: a per-user policy file written by something else is present at the Firefox policy path, so it ' +
    'is left untouched and the setting stays off for this start.',
});

function passwordBlockedNote(status) {
  return PASSWORD_MANAGER_BLOCKED_NOTES[status] ?? 'Saved logins: the setting stays off for this start.';
}

// The recorded overlay, re-checked with lstat and containment: a junction, a
// file, a foreign directory or a path outside the plugin overlay root is not a
// usable overlay even when the record says applied.
function passwordOverlayDirectory(record) {
  if (!nonEmptyString(record.overlay)) {
    return null;
  }
  if (!isPathInsideRoot(record.overlay, overlayRoot(PLUGIN_DATA_DIR))) {
    return null;
  }
  return isRealDirectory(record.overlay) ? record.overlay : null;
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
    passwordManagerOverlay: null,
    passwordManagerOverlayMode: null,
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
  if (record.status === 'prefs') {
    return {
      ...facts,
      passwordManagerEnabled: true,
      passwordManagerSource: 'prefs',
      passwordManagerNote:
        'Saved logins: this Camoufox build does not lock the password manager off, so the stock build is used ' +
        'with the signon prefs and no overlay is created.',
    };
  }
  if (record.status === 'stock') {
    // Written by a start with the setting off (the overlay itself is always on for
    // search). If the setting is on now, the launcher has not rewritten the
    // record yet; report the pending state rather than inventing a source.
    return { ...facts, passwordManagerNote: PASSWORD_MANAGER_PENDING_NOTE };
  }
  if (record.status !== 'applied') {
    return {
      ...facts,
      passwordManagerSource: record.status,
      passwordManagerNote:
        typeof record.note === 'string' && record.note !== ''
          ? record.note
          : passwordBlockedNote(record.status),
    };
  }
  const overlay = passwordOverlayDirectory(record);
  if (overlay === null) {
    return {
      ...facts,
      passwordManagerSource: 'blocked-by-overlay',
      passwordManagerNote: nonEmptyString(record.overlay)
        ? `Saved logins: the recorded overlay ${record.overlay} is missing, or is not a real directory inside ` +
          'the plugin overlay directory, so the setting stays off for this start.'
        : passwordBlockedNote('blocked-by-overlay'),
    };
  }
  const file = overlayPolicyPath(overlay);
  const hash = sha256File(file);
  if (typeof record.managedPolicyHash === 'string' && hash === record.managedPolicyHash) {
    return {
      ...facts,
      passwordManagerEnabled: record.passwordOn !== false,
      passwordManagerSource: 'overlay',
      passwordManagerPolicyFile: file,
      passwordManagerOverlay: overlay,
      passwordManagerOverlayMode: record.mode === 'hardlink' || record.mode === 'copy' ? record.mode : null,
    };
  }
  if (typeof record.probePolicyHash === 'string' && hash === record.probePolicyHash) {
    return {
      ...facts,
      passwordManagerNote:
        'Saved logins: the overlay policy holds the temporary verification document of an interrupted start; ' +
        'the next Camoufox start rewrites it before the setting is used.',
    };
  }
  return {
    ...facts,
    passwordManagerSource: 'blocked-by-overlay',
    passwordManagerNote:
      `Saved logins: ${file} ${hash === null ? 'is missing' : 'no longer matches the policy this plugin wrote'}, ` +
      'so the setting stays off for this start; the next Camoufox start rebuilds the overlay.',
  };
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
  if (facts.passwordManagerSource === 'overlay') {
    return PASSWORD_MANAGER_APPLIED_SENTENCE;
  }
  if (facts.passwordManagerSource === 'prefs') {
    return PASSWORD_MANAGER_PREFS_SENTENCE;
  }
  if (
    facts.passwordManagerSource === 'blocked-by-overlay' ||
    facts.passwordManagerSource === 'blocked-by-existing-overlay' ||
    facts.passwordManagerSource === 'blocked-config' ||
    facts.passwordManagerSource === 'blocked-by-build-policy' ||
    facts.passwordManagerSource === 'blocked-by-existing-policy'
  ) {
    return facts.passwordManagerNote ?? '';
  }
  return '';
}

// --- search engines (2.17.0) -------------------------------------------------
// The pinned Camoufox build replaces the stock search-engine list with one dummy
// engine. The launcher's always-on overlay replaces that policy block with
// `{ Default: "Google", PreventInstalls: false }`, which restores the build's own
// per-locale engine set, seeds Google as the default once and leaves the browser
// UI editable. This group is additive and appears for the camoufox engine only
// (every other engine keeps its payload byte-identical): it says whether the
// overlay carrying that policy is in use, what the default is, where the policy
// file is, and - in one sentence - anything the user must know (a blocked
// overlay, or the one-time profile migration).
const SEARCH_ENGINES_PENDING_NOTE =
  'Search engines: the Camoufox overlay is prepared when the Camoufox backend starts; this report was taken ' +
  'before that step finished.';

function searchEnginesFacts() {
  if (native || engine === null || engine.id !== PASSWORD_MANAGER_ENGINE_ID) {
    return null;
  }
  const facts = {
    searchEnginesSource: 'stock',
    searchEnginesDefault: null,
    searchEnginesPolicyFile: null,
    searchEnginesNote: null,
  };
  const record = readPasswordPolicyRecord(PLUGIN_DATA_DIR);
  if (record === null) {
    return { ...facts, searchEnginesNote: SEARCH_ENGINES_PENDING_NOTE };
  }
  if (record.status === 'prefs' || record.status === 'stock') {
    // The build's own policy already ships the stock list (or no overlay was ever
    // needed); the stock build is what runs.
    return facts;
  }
  if (record.status !== 'applied') {
    return {
      ...facts,
      searchEnginesSource: 'blocked-by-overlay',
      searchEnginesNote:
        typeof record.note === 'string' && record.note !== ''
          ? record.note
          : 'Search engines: the Camoufox overlay build could not be created or verified, so the stock build is ' +
            'in use and its own search-engine policy stays in force.',
    };
  }
  const overlay = passwordOverlayDirectory(record);
  if (overlay === null) {
    return {
      ...facts,
      searchEnginesSource: 'blocked-by-overlay',
      searchEnginesNote:
        'Search engines: the recorded overlay is missing, or is not a real directory inside the plugin overlay ' +
        'directory, so the stock build and its own search-engine policy are in force for this start.',
    };
  }
  const file = overlayPolicyPath(overlay);
  const hash = sha256File(file);
  const managed = typeof record.managedPolicyHash === 'string' && hash === record.managedPolicyHash;
  const probe = typeof record.probePolicyHash === 'string' && hash === record.probePolicyHash;
  if (!managed && !probe) {
    return {
      ...facts,
      searchEnginesSource: 'blocked-by-overlay',
      searchEnginesNote:
        `Search engines: the overlay policy ${file} ` +
        (hash === null ? 'is missing' : 'no longer matches the policy this plugin wrote') +
        ', so the next Camoufox start rebuilds the overlay.',
    };
  }
  if (record.searchSource !== 'overlay') {
    // The overlay is in use for the password policies only; this build's own
    // policy already carries the stock search list.
    return facts;
  }
  return {
    searchEnginesSource: 'overlay',
    searchEnginesDefault: SEARCH_ENGINE_DEFAULT,
    searchEnginesPolicyFile: file,
    searchEnginesNote: probe
      ? 'Search engines: the overlay policy holds the temporary verification document of an interrupted start; ' +
        'the next Camoufox start rewrites it.'
      : typeof record.searchNote === 'string' && record.searchNote !== ''
        ? record.searchNote
        : null,
  };
}

function searchEnginesReport() {
  const facts = searchEnginesFacts();
  return facts === null ? {} : facts;
}

// --- provisioning state (2.22.0) -------------------------------------------
// The Python engines' launchers provision a runtime generation on every start and
// write what happened to <plugin data>/config/provisioning/<name>.json. The broker
// never provisions anything itself: it reports that record, so a refusal ("a live
// session owns the runtime this start needed, nothing was changed") is visible in
// browser_capabilities and browser_engine_status instead of only as a truncated
// stderr line. An engine whose manifest declares no `provisioning.record` gains no
// key, so every non-Python payload stays byte-identical.
const PROVISIONING_STATES = new Set(['reused', 'built', 'refused-held', 'failed']);
const PROVISIONING_HOLDER_SOURCES = new Set(['lease', 'unknown']);

function provisioningHolder(holder) {
  if (holder === null || typeof holder !== 'object') {
    return null;
  }
  const file = typeof holder.path === 'string' && holder.path.trim() !== '' ? holder.path : null;
  const pid = Number.isInteger(holder.pid) && holder.pid > 0 ? holder.pid : null;
  const source = PROVISIONING_HOLDER_SOURCES.has(holder.source) ? holder.source : 'unknown';
  return file === null && pid === null ? null : { path: file, pid, source };
}

function provisioningFacts() {
  const recordName = manifestProvisioningRecord(state.engine);
  if (recordName === null) {
    return null;
  }
  const record = readProvisioningRecord(PLUGIN_DATA_DIR, recordName);
  if (record === null || !PROVISIONING_STATES.has(record.state)) {
    return null;
  }
  const kept = Array.isArray(record.keptGenerations)
    ? record.keptGenerations.filter((entry) => typeof entry === 'string' && entry.trim() !== '').sort()
    : [];
  const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);
  return {
    venv:
      typeof record.venv === 'string' && isPathInsideRoot(record.venv, PLUGIN_DATA_DIR) ? record.venv : null,
    generation: typeof record.generation === 'string' ? record.generation : null,
    state: record.state,
    holderProbe: record.holderProbe === 'cannot-tell' ? 'cannot-tell' : 'windows',
    holder: provisioningHolder(record.holder),
    keptGenerations: kept,
    reason: text(record.reason),
    remedy: text(record.remedy),
    ...(text(record.fallback) === null ? {} : { fallbackPath: text(record.fallback) }),
  };
}

function provisioningReport() {
  const facts = provisioningFacts();
  return facts === null ? {} : { provisioning: facts };
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

// URL guidance (2.19.0, user decision Q5). The upstream turns a bare word into
// https://<word> and the navigation then fails to resolve, which looks like a
// broken browser; one sentence is all a model needs. No refusal is added on the
// relay path, so the tool's own behaviour is unchanged.
const NAVIGATE_URL_SENTENCE =
  'browser_navigate takes a full URL: a bare word is sent to the browser as https://<word> and fails to ' +
  'resolve, so pass the whole address (https://…), and use a search URL if you mean a search.';

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
            profileResolution.profileSource === 'pointer' ||
            // on_locked=fallback (2.16.0) can move the engine default to a numbered
            // sibling; the broker sets that directory exactly like an account.
            // An on_locked=copy fallback (2.20.0) must NOT: its base is another
            // process's, and the session only ever runs on the copy.
            (profileFallback !== null && profileFallback.kind !== 'copy')
          ? profileResolution.profileDir
          : null,
    source: profileResolution.profileSource,
    // True only for an isolated start on an engine that uses the broker's profile
    // model (profile_isolation=isolated, or on_locked=isolated after a busy
    // profile); the spawn environment and both launchers key on it.
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
    // The resolved on_locked policy (2.16.0) and whether it turned this start into
    // an isolated one because the resolved profile was busy.
    onLocked,
    onLockedIsolated,
    appliesToEngine: profileApplies,
    lock: profileLock,
    // The engine's own lock (manifest "profileLock"). Always null for an engine
    // that declares none, and then no payload key is added.
    engineLock: engineProfileLock,
    fallback: profileFallback,
    // profile_lifetime (2.20.0): how long this session keeps the profile facts it
    // owns, and why it is what it is. `pendingCopy` is the copy this session owes
    // at its first browser action; nothing is locked or copied while it is set.
    lifetime: profileLifetime,
    lifetimeSource: profileLifetimeResolution.source,
    pendingCopy,
    copyContents,
    copyContentsSource,
    copyContentsIgnoredNote,
    seatLimit: seatLimitResolution.mode,
    seatLimitSource: seatLimitResolution.source,
    // The default-profile pointer as read at start: { path, exists, name, state,
    // error }, or null for an engine whose profile the broker does not own. It is
    // reported whether or not it supplied this start's profile.
    pointer: profilePointer,
  },
  // Browser lifecycle (2.20.0): the engine-lock latch. `open` is null until the
  // first observation; `source` says which signal set it last; the poll timer is
  // created only while the latch is open and cleared on close and shutdown.
  browser: { open: null, source: null, changedAt: null, timer: null },
  // The exit-code backstop (2.20.0): the licence denial this session saw, so a
  // refused launch is never retried in a loop.
  seatDenied: null,
  // Device identity (2.14.0): the resolved mode and the file this start would
  // use. The created-at value and corruption notes are read by identityReport().
  identity: identityState,
  // A single-seat hold (2.16.0): a busy profile this server waits for instead of
  // moving aside. Reported only while (or after) such a hold.
  hold: holdState,
  // Unpacked extensions (2.18.0): the resolved list, whether the active engine
  // supports it, and why it does not apply when it does not. Only a configured
  // list adds any payload key, so every other start stays byte-identical.
  extensions: extensionState,
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
    state: engineError === null ? (holdState.active ? 'waiting-for-profile' : 'idle') : 'failed',
    pid: null,
    exitCode: null,
    exitSignal: null,
  },
  // Dead-backend recovery (2.19.0). backendSubstate is non-null only while the
  // backend this session started is known to be unusable: "upstream-disconnected"
  // means the bridge is alive but its own @playwright/mcp child is gone, which
  // this broker used to report as "running". restart counts the automatic
  // restarts; every key below is reported additively and only when it applies,
  // so a healthy payload is byte-identical.
  backendSubstate: null,
  restart: {
    // Automatic restarts since the last successful tool call: the 5-minute cap.
    window: 0,
    // Automatic restarts in this broker's life, for the status report.
    total: 0,
    lastAt: null,
    reason: null,
    outcome: null,
    refusedReason: null,
  },
  // The client's own handshake lines, kept from the one message that carried
  // them. The 2.16.0 hold replay consumes its copy in state.hold, and a
  // dead-backend restart needs them again on every restart, so the source is
  // kept here instead of the one-shot slot.
  clientHandshake: { initializeLine: null, initializedLine: null },
  pendingRequests: new Map(),
  hiddenByManifest: new Set(),
  hiddenByCollision: new Set(),
  hiddenByProfile: new Set(),
};
// From here on the copy helpers may correct the live state (2.21.0).
stateRef = state;

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

// A backend that answered with its upstream gone (2.19.0) is as unusable as an
// exited one, so every routing decision treats it the same way: tools/list is
// answered by the broker's meta-tools instead of a relayed failure, and a tool
// call becomes the retry. On every healthy path backendSubstate is null and this
// is exactly backendAlive().
function backendUsable() {
  return backendAlive() && state.backendSubstate === null;
}

function backendDescription() {
  if (state.engineError !== null) {
    return `backend unavailable: ${state.engineError}`;
  }
  if (state.hold.active) {
    return (
      `backend is waiting for the browser profile (${state.hold.profileDir} is in use by ` +
      `${holdOwnerText(state.hold.owner)}; this session retries on the next tool call)`
    );
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

// --- single-seat hold: cache, recovery and replay (2.16.0) ------------------
// The parts that need the live state: serving the cached tool list while the
// profile is held, re-running the preflight on a tool call, replaying the
// client's handshake into the recovered backend, and telling the client its tool
// list is authoritative again. Every write here is local to the plugin data
// directory; nothing touches the busy profile.

// Everything that actually determines the backend's tool list, folded into the
// cache key (2.21.0): the engine id, the tool profile, the seven group switches,
// the MCP package pin and the manifest fields that shape the surface
// (`toolSupport`, `toolAliases`, `nativePrefix`, `contract`, the default profile).
// The broker version is deliberately NOT part of it: it never shaped a backend
// list, and keying on it made every release start with no cache at all — the
// 2026-10-28 meta-only deadlock, where a copy-mode session had no list to act on.
function toolGroupFacts() {
  const group = (name) => {
    const value = process.env[name];
    return typeof value === 'string' ? value.trim().toLowerCase() === 'true' : null;
  };
  return {
    vision: group('CLOAK_TOOL_GROUP_VISION'),
    pdf: group('CLOAK_TOOL_GROUP_PDF'),
    devtools: group('CLOAK_TOOL_GROUP_DEVTOOLS'),
    storage: group('CLOAK_TOOL_GROUP_STORAGE'),
    network: group('CLOAK_TOOL_GROUP_NETWORK'),
    testing: group('CLOAK_TOOL_GROUP_TESTING'),
    config: group('CLOAK_TOOL_GROUP_CONFIG'),
  };
}

function toolCacheCaps() {
  const groups = toolGroupFacts();
  const packagePin =
    typeof process.env.CLOAK_PLAYWRIGHT_MCP_PACKAGE === 'string'
      ? process.env.CLOAK_PLAYWRIGHT_MCP_PACKAGE
      : null;
  const manifest = state.engine !== null && typeof state.engine === 'object' ? state.engine : {};
  const surface = createHash('sha256')
    .update(
      JSON.stringify({
        engineId: state.engineId,
        toolProfile: state.toolProfile,
        groups,
        packagePin,
        contract: manifest.contract ?? null,
        toolSupport: manifest.toolSupport ?? null,
        toolAliases: manifest.toolAliases ?? null,
        nativePrefix: manifest.nativePrefix ?? null,
        defaultToolProfile: manifest.defaultToolProfile ?? null,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  return { groups, packagePin, surface };
}

function toolCacheFile() {
  return toolCachePath(
    state.engineId,
    PLUGIN_DATA_DIR,
    toolCacheKey({ engineId: state.engineId, toolProfile: state.toolProfile, caps: toolCacheCaps() }),
  );
}

// Write the backend's list after a successful tools/list. Every engine writes it
// (2.21.0): a cache is what a held start or a copy-mode start answers tools/list
// from, and until 2.21.0 only a single-seat engine ever wrote one, so every other
// engine was meta-only every time it owed a copy. A native contract engine is
// still skipped: its surface is built from the manifest, not from the backend list.
function saveToolCache() {
  if (state.native) {
    return;
  }
  const result = writeToolCache(toolCacheFile(), {
    engineId: state.engineId,
    toolProfile: state.toolProfile,
    caps: toolCacheCaps(),
    tools: state.backendTools,
  });
  if (!result.written) {
    log(`cannot cache the tool list: ${result.error}`);
  }
}

// Load the cached backend list once per held start. The cache holds the
// backend's own tool objects; the manifest → profile → disabled filter runs on
// read, so a changed profile or disabled list is never served stale.
function ensureHeldToolList() {
  if (state.hold.cache !== null) {
    return state.hold.cache;
  }
  const file = toolCacheFile();
  const read = readToolCache(file);
  if (read.tools === null) {
    state.hold.cache = { source: 'none', path: file, savedAt: null, error: read.error };
    log(
      `no cached tool list exists for this configuration (${read.error}); the broker meta-tools answer ` +
        'tools/list until a backend has served one',
    );
    return state.hold.cache;
  }
  state.backendTools = read.tools;
  state.toolsListed = true;
  state.hold.cache = { source: 'cache', path: file, savedAt: read.savedAt, error: null };
  log(`serving ${read.tools.length} cached backend tools from ${file}`);
  return state.hold.cache;
}

// While held, the client keeps its tool list: the cached backend tools through
// the usual filters, or the broker meta-tools when no cache exists yet.
function sendHeldToolList(id, cursor) {
  const cache = ensureHeldToolList();
  if (cache.source === 'none') {
    sendMetaOnlyList(id, cursor);
    return;
  }
  const addMeta = cursor === undefined || cursor === null || cursor === '';
  const tools = filterTools(state.backendTools, addMeta);
  state.lastExposedCount = tools.length;
  sendResult(id, { tools });
}

// Re-read both locks for a profile directory. The bridge remains the authority;
// this only decides whether a start is worth trying. The start-time preflight
// runs the same two reads, once, before anything is spawned.
function profileStillBlocked(dir) {
  if (dir === null) {
    return { blocked: false, lock: null, engineLock: null };
  }
  const lock = readProfileLock(dir);
  if (lockBlocksStart(lock)) {
    return { blocked: true, lock, engineLock: null };
  }
  if (state.engine !== null && state.engine.profileLock !== undefined) {
    const engineLock = readEngineProfileLock(dir, state.engine.profileLock);
    if (engineLockBlocksStart(engineLock)) {
      return { blocked: true, lock: null, engineLock };
    }
  }
  return { blocked: false, lock, engineLock: null };
}

// Re-read both locks for the held profile.
function holdStillBlocked() {
  return profileStillBlocked(state.hold.profileDir);
}

// Give the recovered backend the handshake the broker answered on its behalf.
// The response is consumed (marked replay) and never relayed: the client already
// has its initialize answer.
function replayHeldHandshake() {
  state.hold.handshakePending = false;
  const lines = [state.hold.initializeLine, state.hold.initializedLine];
  state.hold.initializeLine = null;
  state.hold.initializedLine = null;
  for (const line of lines) {
    if (typeof line !== 'string') {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message === null || typeof message !== 'object') {
      continue;
    }
    if (message.method === 'initialize' && message.id !== undefined && message.id !== null) {
      state.pendingRequests.set(message.id, {
        method: 'initialize',
        cursor: undefined,
        sentAt: Date.now(),
        replay: true,
      });
    }
    forwardToBackend(line);
  }
}

function notifyToolsListChanged() {
  writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
}

// The copy a copy-mode session owed: it was skipped while the base was busy, so
// it is made now, before the backend starts.
function prepareCopySessionAfterHold() {
  if (!copyMode || !profileApplies || onLockedIsolated || copySession !== null) {
    return;
  }
  const prepared = prepareCopySession();
  if (prepared !== null) {
    copySession = prepared;
    state.profile.copy = prepared;
    state.profile.dir = prepared.sessionDir;
    // The copy directory is now known, so the identity facts (and the sentence
    // the handshake carries) describe the profile this session actually uses.
    state.identity = identityFacts();
    return;
  }
  // prepareCopySession reports a refusal through the module's engineError; the
  // live state was built before it ran, so carry the refusal into it.
  if (engineError !== null) {
    state.engineError = engineError;
    state.lastError = state.lastError === null ? engineError : state.lastError;
  }
}

// One recovery attempt per tool call. Returns true when the backend is running
// (or the call was queued behind the artifact-directory resolution) and the call
// must not be answered with an error.
let holdResolutionPending = false;

function attemptHoldRecovery(rawLine) {
  state.hold.attempts += 1;
  const check = holdStillBlocked();
  if (check.blocked) {
    state.hold.owner = check.lock?.owner ?? null;
    state.hold.state = 'waiting';
    log(`on_locked hold: still in use (attempt ${state.hold.attempts}); this session stays available`);
    return false;
  }
  log('on_locked hold: the profile is free; starting the backend for this session');
  prepareCopySessionAfterHold();
  if (state.engineError !== null) {
    state.hold.state = 'failed';
    state.hold.active = false;
    log(`on_locked hold: the recovery start was refused: ${state.engineError}`);
    return false;
  }
  state.hold.active = false;
  state.hold.state = 'recovered';
  state.hold.recoveredAt = Date.now();
  if (outputDirUnresolved()) {
    // The artifact directory still needs the client's roots (bounded 2 s). The
    // call is buffered and replayed by the deferred-start path, after the
    // handshake has been replayed into the backend.
    deferredStart.lines.push(rawLine);
    state.hold.handshakePending = true;
    if (!holdResolutionPending) {
      holdResolutionPending = true;
      const resume = () => {
        holdResolutionPending = false;
        startBackendIfNeeded();
        notifyToolsListChanged();
      };
      resolveOutputDir().then(resume, resume);
    }
    return 'queued';
  }
  startBackend();
  if (state.child === null) {
    state.hold.state = 'failed';
    return false;
  }
  replayHeldHandshake();
  notifyToolsListChanged();
  return true;
}

// The isError a held session returns while the profile is still busy. It never
// claims the tool is unavailable for the session: the next call tries again.
function holdToolError(name) {
  if (state.engineError !== null) {
    return `Cannot call "${String(name)}": ${state.engineError}`;
  }
  return `Cannot call "${String(name)}" yet. ${state.hold.reason ?? holdReasonText(state.hold.profileDir, state.hold.owner)}`;
}

// The one hold object every surface reports, or null when no hold happened.
function holdReport() {
  if (state.hold.profileDir === null) {
    return null;
  }
  return {
    state: state.hold.state,
    profileDir: state.hold.profileDir,
    owner: state.hold.owner,
    attempts: state.hold.attempts,
    ...(state.hold.recoveredAt === null
      ? {}
      : { recoveredAt: new Date(state.hold.recoveredAt).toISOString() }),
    ...(state.hold.cache === null
      ? {}
      : {
          toolList: {
            source: state.hold.cache.source,
            savedAt: state.hold.cache.savedAt,
            ...(state.hold.cache.error === null ? {} : { error: state.hold.cache.error }),
          },
        }),
    // The seat facts that made this start wait (2.20.0), only when a seat limit
    // is what held it; a plain single-seat hold keeps its 2.16.0 shape.
    ...(state.hold.seat === null ? {} : { seat: { ...state.hold.seat } }),
    ...(state.engineError === null ? {} : { error: state.engineError }),
  };
}

// The hold sentence for initialize: why there is no backend yet, that the tool
// list is still there, and that no restart is needed. The cache is read here (once
// per held start) so the sentence says what the client will actually get.
function holdInstructionText() {
  const cache = ensureHeldToolList();
  const list =
    cache.source === 'cache'
      ? "The tool list you have comes from this session's cached copy and is filtered exactly like a live one."
      : 'No cached tool list exists yet, so only the broker meta-tools answer until then.';
  return `${state.hold.reason ?? holdReasonText(state.hold.profileDir, state.hold.owner)} ${list}`;
}

// profile_lifetime "browser" (2.20.0): the backend is not started yet because the
// session runs on a copy that is taken at the first browser action. The sentence
// says why, names the base and the owner, and states what the copy carries.
function copyPendingInstructionText() {
  const cache = ensureHeldToolList();
  const list =
    cache.source === 'cache'
      ? "The tool list you have comes from this session's cached copy and is filtered exactly like a live one."
      : 'No cached tool list exists yet, so only the broker meta-tools answer until then.';
  const reason =
    state.profile.pendingCopy === null
      ? 'This session runs on a temporary copy of its profile.'
      : copyFallbackFor(state.profile.pendingCopy).reason;
  return (
    `${reason} The copy is taken at the first browser action, so nothing is locked or copied while no ` +
    `browser is used. ${list}`
  );
}

// --- dead-backend recovery: honest liveness and one restart (2.19.0) --------
// The backend below launch.mjs can die in two ways, and until 2.19.0 the broker
// understood neither.
//   (c) launch.mjs (and with it the bridge) exits. backendAlive() is false, the
//       state says failed/exited, every call is answered "backend is not
//       running" and nothing ever restarts it.
//   (d) only the bridge's own @playwright/mcp child exits. The bridge stays
//       alive and answers every call and tools/list with the JSON-RPC error
//       -32603 "Not connected": the exact text the pinned MCP SDK's
//       StdioClientTransport throws once its process has gone
//       (@modelcontextprotocol/sdk 1.32.2, dist/cjs/client/stdio.js, send()),
//       re-thrown by the bridge's request handler and turned into InternalError
//       with that same message by the SDK server (dist/cjs/shared/protocol.js).
//       backendAlive() was true, so the broker reported backendState "running"
//       while every call failed — a lie.
// Both are now classified honestly, and one bounded restart is attempted: the
// same call the client made is replayed into the new backend.

const UPSTREAM_DISCONNECTED_CODE = -32603;
const UPSTREAM_DISCONNECTED_MESSAGE = 'Not connected';
// At most one automatic restart per window; a successful tool call resets it.
const RESTART_WINDOW_MS = 5 * 60 * 1000;

// The bridge's own answer that its upstream is gone. The code and the wording
// are the pinned SDK's, not ours: verify both against the installed runtime
// before changing them.
function upstreamDisconnectedAnswer(message) {
  const error = message === null || typeof message !== 'object' ? null : message.error;
  return (
    error !== null &&
    typeof error === 'object' &&
    error.code === UPSTREAM_DISCONNECTED_CODE &&
    typeof error.message === 'string' &&
    error.message.trim() === UPSTREAM_DISCONNECTED_MESSAGE
  );
}

// Record the death the way the status has to show it: a degraded state, an
// additive substate that says which half died, and the upstream's own text.
function noteUpstreamDisconnected(message) {
  const text =
    typeof message.error?.message === 'string' && message.error.message.trim() !== ''
      ? message.error.message
      : UPSTREAM_DISCONNECTED_MESSAGE;
  state.backend.state = 'failed';
  state.backendSubstate = 'upstream-disconnected';
  state.lastError = `Upstream disconnected: ${text}`;
  log(`dead-backend recovery: ${state.lastError} (the bridge is alive, its @playwright/mcp child is gone)`);
}

// The profile this session actually uses: the broker-resolved account,
// workspace, pointer, fallback or copy directory, and otherwise the engine
// default. An isolated start has none, so no lock is read.
function recoveryProfileDir() {
  return state.profile.dir ?? effectiveProfileDir(profileResolution);
}

// Why no automatic restart may run now, or null when it may.
function restartRefusal() {
  if (state.shuttingDown) {
    return 'the broker is shutting down';
  }
  if (state.engineError !== null) {
    return `this start was refused: ${state.engineError}`;
  }
  if (state.hold.active) {
    return 'the profile is held by another session';
  }
  if (state.seatDenied !== null) {
    // Layer 3 of the seat gate: the engine itself refused the launch. Retrying the
    // same launch would fail the same way, so this session never does.
    return (
      `the engine refused the launch with licence exit code ${state.seatDenied.code} ` +
      `(${state.seatDenied.reason})`
    );
  }
  if (
    state.restart.window > 0 &&
    state.restart.lastAt !== null &&
    Date.now() - state.restart.lastAt < RESTART_WINDOW_MS
  ) {
    return 'one automatic restart already ran in the last 5 minutes';
  }
  return null;
}

// Stop this session's own backend after it has failed. Only the broker's direct
// child and its tree are touched: no other session's process is ever signalled.
// state.child is cleared first, so the exit of the backend being replaced cannot
// overwrite the state of the one started after it.
function stopDeadBackend() {
  const child = state.child;
  state.child = null;
  if (child === null || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  log(`dead-backend recovery: stopping this session's own backend tree pid=${child.pid}`);
  killBackendTree(child);
}

// The restart facts, or null when none ever ran so every healthy payload stays
// byte-identical.
function restartReport() {
  if (state.restart.total === 0) {
    return null;
  }
  return {
    count: state.restart.total,
    lastAt: state.restart.lastAt === null ? null : new Date(state.restart.lastAt).toISOString(),
    reason: state.restart.reason,
    outcome: state.restart.outcome,
    ...(state.restart.refusedReason === null ? {} : { refusedReason: state.restart.refusedReason }),
  };
}

// A successful tool call is proof the backend and its upstream work again: the
// reported substate goes away and the 5-minute window opens again.
function noteBackendHealthy() {
  state.backendSubstate = null;
  state.restart.refusedReason = null;
  if (state.restart.window === 0) {
    return;
  }
  state.restart.window = 0;
  log('dead-backend recovery: a tool call succeeded; the automatic restart window is open again');
}

// The isError a call gets when the backend is dead and no restart ran. It names
// the state, why no restart happened and the fix — never a bare code.
function deadBackendToolError(name) {
  if (state.hold.active) {
    return holdToolError(name);
  }
  if (state.engineError !== null) {
    // A start that was refused before any backend existed keeps its exact
    // previous message: no restart is possible, and the cause is already in it.
    return `Cannot call "${String(name)}": ${backendDescription()}.`;
  }
  const description = backendDescription();
  const why =
    state.restart.refusedReason === null ? '' : ` No automatic restart ran: ${state.restart.refusedReason}.`;
  return (
    `Cannot call "${String(name)}": ${description.endsWith('.') ? description.slice(0, -1) : description}.${why} ` +
    'The call was not sent. Fix the cause named in browser_engine_status.lastError and call again, or ' +
    'restart Claude Code; at most one automatic restart runs every 5 minutes.'
  );
}

// One automatic restart: the dead backend is stopped, both lock reads run again,
// launch.mjs is spawned once, the client's handshake is replayed through the
// 2.16.0 machinery and the client is told its tool list is authoritative again.
// Returns true when the backend is running and the caller may send its one call,
// false when the caller must answer with the honest error instead.
function attemptDeadBackendRestart(reason) {
  const refusal = restartRefusal();
  if (refusal !== null) {
    state.restart.refusedReason = refusal;
    log(`dead-backend recovery: not restarting (${reason}): ${refusal}`);
    return false;
  }
  // The dead backend is this session's own: the launcher exited, or the bridge
  // outlived its upstream and can never serve again (the pinned bridge never
  // respawns it). It is stopped before the preflight, so the profile lock it
  // still holds is not read as another session's.
  stopDeadBackend();
  // The single-seat rule is absolute: never start a second CloakBrowser. Both
  // start-time lock reads run again here, before anything is spawned.
  const dir = recoveryProfileDir();
  const blocked = profileStillBlocked(dir);
  if (blocked.blocked) {
    if (singleSeat) {
      // A held profile goes down the existing 2.16.0 hold path, never a restart:
      // the cached tool list stays, the call gets an isError naming the owner and
      // the next call tries again.
      beginHold(dir, blocked.lock, blocked.engineLock);
      state.backend.state = 'waiting-for-profile';
    }
    state.restart.refusedReason = `the profile ${dir} is in use by another session`;
    log(`dead-backend recovery: not restarting (${reason}): ${state.restart.refusedReason}`);
    return false;
  }
  state.restart.window += 1;
  state.restart.total += 1;
  state.restart.lastAt = Date.now();
  state.restart.reason = reason;
  state.restart.outcome = 'starting';
  state.restart.refusedReason = null;
  state.backendSubstate = null;
  log(
    `dead-backend recovery: ${reason}; restarting the backend once ` +
      `(attempt ${state.restart.window} since the last successful tool call)`,
  );
  // The new backend has answered nothing yet, so startupMs must measure it, not
  // the dead one (a kept timestamp would make startupMs negative).
  state.initializeAnsweredAt = null;
  startBackend();
  if (state.child === null) {
    state.restart.outcome = 'failed';
    state.restart.refusedReason = 'the backend could not be started';
    return false;
  }
  // The client's own handshake, replayed by the one replay function the hold
  // path already uses; its answer is consumed, never relayed.
  if (state.clientHandshake.initializeLine !== null) {
    state.hold.initializeLine = state.clientHandshake.initializeLine;
  }
  if (state.clientHandshake.initializedLine !== null) {
    state.hold.initializedLine = state.clientHandshake.initializedLine;
  }
  replayHeldHandshake();
  notifyToolsListChanged();
  state.restart.outcome = 'recovered';
  return true;
}

// A relayed answer that says the bridge's upstream is gone. The death is always
// recorded; what the client gets depends on what it asked for. Returns true when
// this answer is fully handled here and must not be relayed.
function handleUpstreamDisconnectedAnswer(pending, id, message) {
  noteUpstreamDisconnected(message);
  if (pending.method === 'tools/call') {
    state.pendingRequests.delete(id);
    if (typeof pending.rawLine === 'string' && attemptDeadBackendRestart('the upstream disconnected')) {
      // Re-send exactly this one call, under the client's own id, into the
      // restarted backend: its answer is relayed as if nothing had happened.
      state.pendingRequests.set(id, { ...pending, sentAt: Date.now() });
      if (!forwardToBackend(pending.rawLine)) {
        state.pendingRequests.delete(id);
        sendToolError(id, deadBackendToolError(pending.name));
      }
      return true;
    }
    sendToolError(id, deadBackendToolError(pending.name));
    return true;
  }
  if (pending.method === 'tools/list') {
    // F1: the failing list is never relayed; the meta-tools answer instead, and
    // the next tool call is what restarts the backend.
    state.pendingRequests.delete(id);
    sendMetaOnlyList(id, pending.cursor);
    return true;
  }
  return false;
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
  // The artifact-directory path reaches this function on its own; while a
  // single-seat hold is active there is no backend to start, so the resolution
  // finishes and the start waits for a tool call like every other held start.
  if (state.hold.active) {
    log('backend start held until the profile is free; this session retries on its next tool call');
    return;
  }
  // profile_lifetime "browser" (2.20.0): the backend is spawned with the session
  // copy's directory in its environment, so it cannot start before that copy
  // exists. The first browser action takes the copy and starts it — unless no
  // cached tool list exists for this configuration (2.21.0), in which case the
  // copy is taken here so the client's list is one it can act on.
  if (state.profile.pendingCopy !== null && state.child === null) {
    if (coldCopyStartNeeded()) {
      takeColdCopyNow();
    }
    if (state.profile.pendingCopy !== null) {
      log('backend start deferred until the first browser action: this session runs on a session copy');
      return;
    }
  }
  if (state.child === null) {
    startBackend();
  }
  // A recovered hold owes the backend the handshake the broker answered for it,
  // before any buffered call is replayed.
  if (state.child !== null && state.hold.handshakePending === true) {
    replayHeldHandshake();
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
// --- lifetime reporting (2.20.0) ---------------------------------------------
// Every lock is reported with the lifetime it really has, never the setting's
// intent: the engine lock belongs to the browser, the bridge lock to the bridge
// process (server-scoped until M2, whatever profile_lifetime says), and a base
// lock this broker holds follows profile_lifetime. `heldBy` is resolved against
// this process, so "by whom" has an answer when the pid can be compared.
function lockLifetimeFields(lock, kind) {
  if (lock === null || typeof lock !== 'object' || lock.state === 'free' || lock.state === 'stale') {
    return lock;
  }
  const heldByThisSession =
    lock.state === 'live' &&
    lock.owner !== null &&
    lock.owner !== undefined &&
    lock.owner.pid === process.pid;
  if (kind === 'engine') {
    return {
      ...lock,
      lockKind: 'engine',
      lifetime: 'browser',
      lifetimeReason: 'engine-native',
      heldBy: lock.state === 'live' ? (heldByThisSession ? 'this-session' : 'another-session') : null,
    };
  }
  return {
    ...lock,
    lockKind: 'bridge',
    lifetime: 'server',
    lifetimeReason: 'engine-bridge-lock',
    heldBy: lock.state === 'live' ? (heldByThisSession ? 'this-session' : 'another-session') : null,
  };
}

// The profile_lifetime facts plus the engine-lock latch. Additive and only for an
// engine whose profile the broker manages: an isolated start has no profile and
// an inert engine has no lock to observe, so neither gains a key.
function profileLifetimeFields() {
  if (!state.profile.appliesToEngine || isolatedStartNow()) {
    return {};
  }
  return {
    profileLifetime: state.profile.lifetime,
    profileLifetimeSource: state.profile.lifetimeSource,
    browserOpen: state.browser.open,
    browserOpenSource: state.browser.source,
  };
}

// The seat facts, additive and only for an engine that has a seat concept (its
// manifest declares singleSeat) or whose seat_limit setting is not the default.
// The count is this broker's own scan; the limit is the manifest, the setting or
// the vendor's licence answer, and the source says which.
function seatFields() {
  const facts = seatFacts();
  if (facts === null) {
    return {};
  }
  return {
    seatLimit: facts.seatLimit,
    seatLimitSource: facts.seatLimitSource,
    seatsInUse: facts.seatsInUse,
    seatFree: facts.seatFree,
    ...(facts.seatScanTruncated ? { seatScanTruncated: true } : {}),
    ...(facts.seatVendor === null ? {} : { seatVendor: facts.seatVendor }),
    ...(state.seatDenied === null ? {} : { seatDenied: state.seatDenied }),
  };
}

// The launcher-side settings block (2.21.0): what the launcher for this engine
// resolves from this process's environment, and which source won. Null (no key)
// for an engine whose manifest names no launcher this module knows, so such a
// payload stays byte-identical.
function launcherSettingsFields() {
  if (state.engine === null) {
    return {};
  }
  const report = launcherSettingsReport(process.env, resolveLauncherName(state.engine));
  return report === null ? {} : { launcherSettings: report };
}

// What a copy would hold (copy_contents, 2.20.0): the effective tier, where the
// value came from, why an identity request could not be honoured, and the
// manifest's own identity list. Additive and only when the tier can act on this
// engine, so a clean payload of an engine that cannot copy gains nothing. The
// measured files/bytes of a plan are NOT computed here: walking a large profile
// costs over a second, and a meta-tool must stay local and cheap.
function copyContentsFields() {
  if (state.profile.appliesToEngine !== true) {
    return {};
  }
  return {
    copyContents: state.profile.copyContents,
    copyContentsSource: state.profile.copyContentsSource,
    ...(state.profile.copyContentsIgnoredNote === null
      ? {}
      : { copyContentsNote: state.profile.copyContentsIgnoredNote }),
    ...(identityCopyDescriptor === null
      ? {}
      : {
          identityCopy: {
            keep: identityCopyDescriptor.keep.length,
            notes: identityCopyDescriptor.notes,
          },
        }),
  };
}

function copyReport() {
  const copy = state.profile.copy;
  if (copy === null || copy === undefined) {
    return null;
  }
  const baseLock = readProfileLock(copy.baseDir);
  const onLockedCopy = copy.kind === 'on-locked';
  return {
    baseDir: copy.baseDir,
    sessionDir: copy.sessionDir,
    // 2.20.0: which rule took this copy ("copy", "copy-keep", "on-locked"), what
    // it holds ("full" or "identity"), and where its lifecycle stands.
    kind: copy.kind,
    scope: copy.scope,
    state: copy.state,
    takenAt: copy.takenAt,
    ...(copy.owner === null || copy.owner === undefined ? {} : { baseOwner: copy.owner }),
    baseCreated: copy.baseCreated,
    baseLock: {
      state: baseLock.state,
      path: baseLock.path,
      owner: baseLock.owner,
      reclaimed: copy.baseLock === null || copy.baseLock === undefined ? null : copy.baseLock.reclaimed,
      heldByThisSession:
        baseLock.state === 'live' && baseLock.owner !== null && baseLock.owner.pid === process.pid,
      // The base lock's real lifetime: in a copy mode it is this session's own and
      // follows profile_lifetime; for a copy-on-lock it is the base owner's bridge
      // lock, which stays server-scoped until M2.
      lifetime: onLockedCopy ? 'server' : state.profile.lifetime,
      lifetimeReason: onLockedCopy ? 'engine-bridge-lock' : 'setting',
      heldBy:
        baseLock.state === 'live' && baseLock.owner !== null
          ? baseLock.owner.pid === process.pid
            ? 'this-session'
            : 'another-session'
          : null,
    },
    copied: { ...copy.copied },
    discarded: copy.discarded,
    ...(copy.leftover === null || copy.leftover === undefined ? {} : { leftover: copy.leftover }),
    // copy-keep only: the clean-close swap. On a running session it is
    // "pending"; a hard kill writes no result and leaves the trees in place.
    ...(copy.swap === null || copy.swap === undefined ? {} : { swap: { ...copy.swap } }),
  };
}

function copyReportNote() {
  const copy = state.profile.copy;
  if (copy !== null && copy !== undefined) {
    if (copy.kind === 'on-locked') {
      // The on_locked=copy sentence is the fallback reason, which every surface
      // already carries exactly once (initialize.instructions, capabilities,
      // status and browser_profiles). Repeating it here would say it twice.
      return null;
    }
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

// True for any start with no profile at all: the configured
// profile_isolation=isolated, or an on_locked=isolated switch after a busy
// profile (2.16.0). The payload branches that describe "no profile" key on this,
// so both report the same facts about the pointer, the ignored settings and the
// nothing-persists rule.
function isolatedStartNow() {
  return state.profile.isolation === 'isolated' || state.profile.onLockedIsolated === true;
}

// The one note that says what "no profile" means for this start. A configured
// isolated start reports the pointer/native note it always has; an on_locked
// switch says why instead, because the profile_isolation setting is unchanged.
function profileIsolationNoteNow() {
  if (state.profile.onLockedIsolated === true) {
    return PROFILE_ON_LOCKED_ISOLATED_NOTE;
  }
  return state.profile.appliesToEngine ? PROFILE_ISOLATED_POINTER_NOTE : PROFILE_ISOLATED_NATIVE_NOTE;
}

// --- unpacked-extension reporting (2.18.0) ----------------------------------
// Additive and only when the setting names something: an unconfigured start gains
// no key at all, so every payload stays byte-identical to 2.17.0. The paths are
// the canonical absolute directories the backend receives; a directory path is
// not a secret and profile directories are already reported. `supported` says
// whether the active engine can load unpacked extensions at all, `applies` says
// whether this start will load them, and `note` explains every case where a
// configured list is not applied — the setting is never silently ignored.
function extensionReport() {
  const ext = state.extensions;
  if (!ext.configured) {
    return {};
  }
  return {
    extensionPathsSupported: ext.supported,
    extensionPaths: {
      configured: true,
      count: ext.entries === null ? null : ext.entries.length,
      source: ext.source,
      applies: ext.applies,
      // Only a list this start will load is shown: an engine that cannot load it
      // or an isolated start reports the count and the note instead, so the
      // directories can never read as "in use" when they are not.
      ...(ext.applies && ext.paths !== null ? { paths: ext.paths } : {}),
      ...(ext.error === null ? {} : { error: extensionPathsProblemText(ext.error) }),
      ...(ext.note === null ? {} : { note: ext.note }),
    },
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
  const holdNow = holdReport();
  const restartNow = restartReport();
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
    // Launcher-side settings (2.21.0), additive and only for a launcher that
    // resolves any: each one's effective value and where it came from, plus the
    // one-line reason when the supplied value was not usable. The resolution is
    // the same function the launcher itself runs on the same environment, so the
    // report can never disagree with the child the engine actually got.
    ...launcherSettingsFields(),
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
    // on_locked (2.16.0), additive and only where it can act: an engine whose
    // manifest declares profileApplies false keeps its exact previous payload.
    ...(state.profile.appliesToEngine ? { onLocked: state.profile.onLocked } : {}),
    // profile_lifetime and the engine-lock latch (2.20.0), additive and only for
    // an engine whose profile the broker manages, plus the seat facts where the
    // engine has a seat concept.
    ...profileLifetimeFields(),
    ...seatFields(),
    ...copyContentsFields(),
    profileFallback: state.profile.fallback,
    // A single-seat hold (2.16.0), additive and only while (or after) one
    // happened: why this session waited, the owner, how many recovery attempts
    // its tool calls made, and where the cached tool list came from.
    ...(holdNow === null ? {} : { hold: holdNow }),
    // Dead-backend recovery (2.19.0), additive and only on the degraded path or
    // after an automatic restart: the substate names which half of the backend
    // died while backendState says failed, and the restart facts say how many
    // automatic restarts ran and how the last one ended.
    ...(state.backendSubstate === null ? {} : { backendSubstate: state.backendSubstate }),
    ...(restartNow === null ? {} : { backendRestart: restartNow }),
    profileLock: lockLifetimeFields(state.profile.lock, 'bridge'),
    ...(state.profile.engineLock === null
      ? {}
      : { engineProfileLock: lockLifetimeFields(state.profile.engineLock, 'engine') }),
    // Copy start (2.12.0) and copy-keep (2.13.0), additive only in those modes.
    // profileCopy names the base, the session copy, the lock this session holds
    // on the base and the copy size; in copy-keep it also carries the pending
    // clean-close swap. profileCopyNote states what happens to the changes. For
    // an engine with profileApplies false the mode is refused loudly and
    // profileCopySupported is false. sessionCopies lists leftover copies and
    // lastSwap the last completed clean-close swap, both only when they exist, so
    // a clean payload is unchanged.
    ...((isCopyIsolation(state.profile.isolation) || state.profile.copy !== null) &&
    !state.profile.onLockedIsolated
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
    // says what the pointer and set-default mean (nothing) for this session. Since
    // 2.16.0 an on_locked=isolated switch reports the same facts, with its own
    // note because the profile_isolation setting is unchanged.
    ...(state.profile.ignored.length === 0
      ? {}
      : {
          profileIgnored: state.profile.ignored,
          profileIgnoredReason: profileIgnoredReason(state.profile.ignored),
        }),
    ...(isolatedStartNow()
      ? {
          profileIsolationNote: profileIsolationNoteNow(),
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
    // Saved logins (2.15.0; the overlay is always on in 2.17.0), additive and
    // only when password_manager is on. The values match browser_engine_status;
    // the policy file path and overlay directory are reported only when the
    // plugin-owned overlay build is in use, and passwordManagerStore is the
    // profile's logins.db *file existence* only (never opened).
    ...passwordManagerReport(),
    // Search engines (2.17.0), additive and for the camoufox engine only: whether
    // the overlay that restores the build's stock engine list is in use, the
    // seeded default, the overlay policy path, and one honest note (blocked
    // overlay or the one-time profile migration). Other engines add no key.
    ...searchEnginesReport(),
    // Provisioning state (2.22.0), additive and for the Python engines only: what
    // the last start did with the runtime generation (reused, built, refused
    // because a live session owned it, or failed), the probe's answer, the
    // generations kept on disk and the remedy. Read from the launcher's record;
    // an engine that provisions nothing gains no key.
    ...provisioningReport(),
    // Unpacked extensions (2.18.0), additive and only when extension_paths names
    // something: whether the engine can load them, the count and source, the
    // canonical directories this start will load, and a note when a configured
    // list is not applied.
    ...extensionReport(),
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
  const holdNow = holdReport();
  const restartNow = restartReport();
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
    // on_locked (2.16.0), additive and only where it can act.
    ...(state.profile.appliesToEngine ? { onLocked: state.profile.onLocked } : {}),
    // profile_lifetime and the engine-lock latch (2.20.0), additive and only for
    // an engine whose profile the broker manages, plus the seat facts where the
    // engine has a seat concept.
    ...profileLifetimeFields(),
    ...seatFields(),
    ...copyContentsFields(),
    profileFallback: state.profile.fallback,
    // A single-seat hold (2.16.0), additive and only while (or after) one
    // happened: why this session waited, the owner, how many recovery attempts
    // its tool calls made, and where the cached tool list came from.
    ...(holdNow === null ? {} : { hold: holdNow }),
    // Dead-backend recovery (2.19.0), additive and only on the degraded path or
    // after an automatic restart: the substate names which half of the backend
    // died while backendState says failed, and the restart facts say how many
    // automatic restarts ran and how the last one ended.
    ...(state.backendSubstate === null ? {} : { backendSubstate: state.backendSubstate }),
    ...(restartNow === null ? {} : { backendRestart: restartNow }),
    profileLock: lockLifetimeFields(state.profile.lock, 'bridge'),
    ...(state.profile.engineLock === null
      ? {}
      : { engineProfileLock: lockLifetimeFields(state.profile.engineLock, 'engine') }),
    // Copy start (2.12.0) and copy-keep (2.13.0), additive only in those modes,
    // same values as browser_capabilities. profileSource is reported with it so a
    // status read alone shows where the base came from.
    ...((isCopyIsolation(state.profile.isolation) || state.profile.copy !== null) &&
    !state.profile.onLockedIsolated
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
    // would have come from (it is "isolated": none). Since 2.16.0 an
    // on_locked=isolated switch reports the same facts.
    ...(isolatedStartNow()
      ? {
          profileSource: state.profile.source,
          profileIsolationNote: profileIsolationNoteNow(),
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
    // Saved logins (2.15.0; the overlay is always on in 2.17.0), additive and
    // only when password_manager is on. The values match browser_engine_status;
    // the policy file path and overlay directory are reported only when the
    // plugin-owned overlay build is in use, and passwordManagerStore is the
    // profile's logins.db *file existence* only (never opened).
    ...passwordManagerReport(),
    // Search engines (2.17.0), the same additive camoufox-only group
    // browser_capabilities reports.
    ...searchEnginesReport(),
    // Provisioning state (2.22.0), the same additive group browser_capabilities
    // reports, so a status read alone shows whether the runtime was reused, built
    // or refused because another session owned it.
    ...provisioningReport(),
    // Unpacked extensions (2.18.0), the same additive group browser_capabilities
    // reports, so a status read alone shows whether this start loads them.
    ...extensionReport(),
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
    // on_locked (2.16.0), additive and only where it can act: the policy that
    // decided what this start did when the profile was in use.
    ...(state.profile.appliesToEngine ? { onLocked: state.profile.onLocked } : {}),
    // profile_lifetime, the engine-lock latch and the seat facts (2.20.0), the
    // same values browser_capabilities and browser_engine_status report.
    ...profileLifetimeFields(),
    ...seatFields(),
    // The 2026-10-28 incident's blind spot: browser_profiles did not say that
    // this start was moved to a sibling or a copy while the other two meta-tools
    // did. Reported whenever a fallback happened, with its kind and whether the
    // destination was created empty.
    ...(state.profile.fallback === null ? {} : { profileFallback: state.profile.fallback }),
    // The copy this session still owes (profile_lifetime "browser"), so an idle
    // session says nothing is locked or copied yet instead of looking broken.
    ...(state.profile.pendingCopy === null || state.profile.pendingCopy === undefined
      ? {}
      : {
          profileCopyPending: {
            kind: state.profile.pendingCopy.kind,
            baseDir: state.profile.pendingCopy.baseDir,
            sessionDir: state.profile.pendingCopy.sessionDir,
            ...(state.profile.copyPendingError === null || state.profile.copyPendingError === undefined
              ? {}
              : { error: state.profile.copyPendingError }),
          },
        }),
    // copy_contents (2.20.0): what a copy would carry for this engine, and
    // whether the requested tier could be honoured. The same keys the other two
    // meta-tools report.
    ...copyContentsFields(),
    // A single-seat hold (2.16.0), reported with the profile this session uses.
    ...(holdReport() === null ? {} : { hold: holdReport() }),
    profileLock:
      lock === null
        ? null
        : lockLifetimeFields({ ...lock, fix: lockBlocksStart(lock) ? profileLockFix(lock) : null }, 'bridge'),
    // Copy start (2.12.0) and copy-keep (2.13.0), additive only in those modes:
    // the base, the session copy this server runs on, the base lock this session
    // holds and the note on what happens to the changes. The lock above is the
    // session copy's own bridge lock once the backend has started.
    ...((isCopyIsolation(state.profile.isolation) || state.profile.copy !== null) &&
    !state.profile.onLockedIsolated
      ? {
          profileCopy: copyReport(),
          profileCopySupported: state.profile.appliesToEngine,
          ...(copyReportNote() === null ? {} : { profileCopyNote: copyReportNote() }),
        }
      : {}),
    // Isolated start (2.11.0), additive only in that mode: there is no profile
    // directory and no lock, and the settings supplied are reported as ignored.
    // Since 2.16.0 an on_locked=isolated switch reports the same facts.
    ...(isolatedStartNow()
      ? {
          profileIsolationNote: profileIsolationNoteNow(),
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
      ...(isCopyIsolation(state.profile.isolation) || state.profile.copy !== null
        ? {
            profileCopySupported: state.profile.appliesToEngine,
            ...(copyReportNote() === null ? {} : { profileCopyNote: copyReportNote() }),
          }
        : {}),
      ...(sessionCopiesReport() === null ? {} : { sessionCopies: sessionCopiesReport() }),
      ...(previousTreesNow === null ? {} : { previousTrees: previousTreesNow }),
      ...(lastSwapNow === null ? {} : { lastSwap: lastSwapNow }),
      ...(isolatedStartNow()
        ? {
            profileIsolationNote: profileIsolationNoteNow(),
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
          : state.profile.onLockedIsolated === true
            ? 'The default profile is written; this server started with no profile because on_locked is ' +
              '"isolated" and the profile it resolved was in use, so the pointer has no effect on this ' +
              'session. It applies at the next server start.'
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
  // A single-seat engine can be held on a later start; keep the list it just
  // served so that session still has its tools while it waits.
  saveToolCache();
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
  // A single-seat hold is not a failure: the session is usable and recovers by
  // itself, so it gets its own honest sentence instead of "restart Claude Code".
  const instructions = state.hold.active
    ? `${holdInstructionText()} ${artifactDirectorySentence()}`
    : state.profile.pendingCopy !== null
      ? `${copyPendingInstructionText()} ${artifactDirectorySentence()}`
      : `The ${state.engineId} backend is unavailable: ${reason} ` +
        'Call browser_engine_status for details. Only broker meta-tools are exposed until Claude Code restarts the MCP server.' +
        (state.profile.fallback === null ? '' : ` ${state.profile.fallback.reason}`) +
        (dependencyHint === null ? '' : ` ${dependencyHint}`) +
        (state.profile.isolated && state.profile.appliesToEngine && !state.profile.onLockedIsolated
          ? ` ${PROFILE_ISOLATED_NOTE}`
          : '') +
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

function killBackendTree(target = state.child) {
  const child = target;
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
  if (copy === null || copy === undefined) {
    return;
  }
  // A copy already discarded at a browser close may have been re-created empty by
  // the backend on the deleted path (it still holds that user-data-dir until M2),
  // so the tree is checked on disk, not only in the flag.
  if (copy.discarded && !existsSync(copy.sessionDir)) {
    return;
  }
  const removed = removeSessionCopyWithRetry(copy.sessionDir);
  if (removed.ok) {
    copy.discarded = true;
    copy.state = 'discarded';
    copy.leftover = null;
    log(`profile ${copyModeLabel}: discarded session copy ${copy.sessionDir} after a clean shutdown`);
    return;
  }
  // A file a dying browser still holds on Windows: keep the tree, say where it is
  // and how to remove it later. Nothing is forced.
  copy.discarded = false;
  copy.state = 'leftover';
  copy.leftover = { path: copy.sessionDir, error: removed.error };
  log(
    `profile ${copyModeLabel}: could not discard the session copy ${copy.sessionDir} after ` +
      `${removed.attempts} attempts (${removed.error}); it is left in place for browser_profiles list and ` +
      'scripts/profile-copy.mjs --prune',
  );
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
  stopBrowserWatch();
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

  // The client's handshake is the only thing a new backend cannot be given by
  // the client again: keep the exact lines, so a hold recovery and a
  // dead-backend restart (2.19.0) both replay them through replayHeldHandshake().
  if (method === 'initialize') {
    state.clientHandshake.initializeLine = rawLine;
  } else if (method === 'notifications/initialized') {
    state.clientHandshake.initializedLine = rawLine;
  }

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
    if (!backendAlive() && state.hold.active) {
      // The single-seat hold: this call is the retry. When the profile is free
      // the backend starts, the handshake is replayed and the call is forwarded
      // below; while it is busy the call gets an honest isError and the session
      // stays usable for the next one.
      const recovery = attemptHoldRecovery(rawLine);
      if (recovery === 'queued') {
        // Buffered behind the artifact-directory resolution; the deferred start
        // replays it, so nothing is answered here.
        return;
      }
      if (recovery !== true) {
        sendToolError(id, holdToolError(name));
        return;
      }
    }
    if (state.profile.pendingCopy !== null) {
      // profile_lifetime "browser" (2.20.0): this is the first browser action (or
      // the first one after the browser closed), so the session copy is taken
      // now, before the backend is started with it or forwarded this call.
      const sessionCopy = ensureBrowserSessionCopy(rawLine);
      if (sessionCopy.queued === true) {
        // Buffered behind the artifact-directory resolution; the deferred start
        // replays it, so nothing is answered here.
        return;
      }
      if (!sessionCopy.ok) {
        // A copy refused because no browser seat is free is the 2.16.0 hold, and
        // it answers with the hold sentence that names the owner and the retry.
        sendToolError(id, sessionCopy.held === true ? holdToolError(name) : pendingCopyToolError(name));
        return;
      }
    }
    if (!backendUsable()) {
      // Dead-backend recovery (2.19.0): this call is the retry. One bounded
      // restart runs, then the call is forwarded below as if nothing had
      // happened; when no restart may run the call is answered with the honest
      // error naming the state and the fix.
      const reason = state.backendSubstate === null ? 'the backend exited' : 'the upstream disconnected';
      if (!attemptDeadBackendRestart(reason)) {
        sendToolError(id, deadBackendToolError(name));
        return;
      }
    }
  }

  if (!backendUsable()) {
    if (!isRequest) {
      // The client's handshake notification is kept for the replay; every other
      // notification is dropped while there is no backend, as before.
      if (method === 'notifications/initialized' && state.hold.active) {
        state.hold.initializedLine = rawLine;
        return;
      }
      log(`dropping client notification "${String(method)}": ${backendDescription()}`);
      return;
    }
    if (method === 'initialize') {
      noteInitializeRequest(message);
      if (state.hold.active || state.profile.pendingCopy !== null) {
        // The broker answers the handshake now and replays it to the backend on
        // recovery, so the client is never left waiting on a busy profile or on a
        // session copy that is only taken at the first browser action. The
        // artifact directory is resolved in the background meanwhile, so the
        // later start already knows where artifacts go.
        state.hold.initializeLine = rawLine;
        const settle = () => {};
        resolveOutputDir().then(settle, settle);
      }
      synthesizeInitialize(id, backendDescription());
      return;
    }
    if (method === 'tools/list') {
      if (state.hold.active) {
        sendHeldToolList(id, message.params?.cursor);
        return;
      }
      if (state.profile.pendingCopy !== null) {
        if (!coldCopyStartNeeded()) {
          // A cache for this surface exists: serve it, exactly as 2.20.0 did.
          sendHeldToolList(id, message.params?.cursor);
          return;
        }
        // 2.21.0: there is no cached list for this configuration, so answering
        // with the meta-tools would leave the client with no browser tool to act
        // on — and no way to take the copy that would create the cache. The copy
        // is taken and the backend started here, and the backend answers this
        // list below.
        const sessionCopy = ensureBrowserSessionCopy(rawLine);
        if (sessionCopy.queued === true) {
          return;
        }
        if (!sessionCopy.ok) {
          sendHeldToolList(id, message.params?.cursor);
          return;
        }
      } else {
        sendMetaOnlyList(id, message.params?.cursor);
        return;
      }
    } else if (method === 'ping') {
      sendResult(id, {});
      return;
    } else {
      sendError(id, -32603, `Cannot handle "${String(method)}": ${backendDescription()}.`);
      return;
    }
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
      // Dead-backend recovery (2.19.0) re-sends this exact line into a restarted
      // backend, so the name and the line are kept with the pending request.
      name: message.params?.name,
      rawLine,
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
  if (isResponse && pending?.replay === true) {
    // The answer to a replayed handshake: the client was already answered by the
    // broker, so this response is consumed, never relayed. The facts it carries
    // (server info, capabilities, a rejection) are still recorded.
    state.pendingRequests.delete(id);
    state.backendAnswered = true;
    if (pending.method === 'initialize') {
      if (message.error === undefined) {
        state.initializeAnswered = true;
        state.initializeAnsweredAt = state.initializeAnsweredAt ?? Date.now();
        state.serverInfo = message.result?.serverInfo ?? null;
        state.backendCapabilities = message.result?.capabilities ?? null;
        if (state.backend.state === 'starting' || state.backend.state === 'idle') {
          state.backend.state = 'running';
        }
      } else {
        const reason = message.error?.message ?? 'unknown error';
        state.initializeRejected = true;
        state.lastError = `Backend rejected initialize: ${String(reason)}${protocolEraHint(reason)}`;
        state.backend.state = 'failed';
      }
    }
    return;
  }
  // Dead-backend recovery (2.19.0): the bridge answered with its own upstream
  // gone. The death is recorded here, before anything else looks at the answer.
  if (isResponse && pending !== undefined && upstreamDisconnectedAnswer(message)) {
    if (handleUpstreamDisconnectedAnswer(pending, id, message)) {
      return;
    }
  }
  if (isResponse) {
    noteBackendAnswered(pending);
    state.pendingRequests.delete(id);
  }
  // Browser lifecycle (2.20.0): one engine-lock probe after each tool response,
  // except on the two instant paths (browser_close, _meta.isClose). The seat
  // backstop reads the same answer for a licence exit code.
  if (isResponse && pending?.method === 'tools/call') {
    noteBrowserAfterCall(pending, message);
    noteSeatDenialInAnswer(message);
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
      // It is also evidence the backend works again: the dead-backend substate
      // goes away and the automatic restart window opens (2.19.0).
      noteBackendHealthy();
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
      state.profile.isolated && state.profile.appliesToEngine && !state.profile.onLockedIsolated
        ? PROFILE_ISOLATED_NOTE
        : '',
      identitySentence(),
      passwordManagerSentence(),
      artifactDirectorySentence(),
      // URL guidance (2.19.0, Q5): one sentence on the healthy handshake only,
      // where navigation is possible.
      NAVIGATE_URL_SENTENCE,
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
      // Unpacked extensions (2.18.0): the canonical absolute directories of a
      // fully resolved list for an engine that declares support. Null otherwise,
      // so the variable is not written and the child environment is unchanged.
      extensionPaths: state.extensions.applies ? state.extensions.paths : null,
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
    if (state.child !== child) {
      // A backend this broker already replaced (dead-backend recovery, 2.19.0):
      // its exit belongs to a process nobody waits for any more, so it must not
      // touch the state, the error or the pending requests of the one now
      // running, and it must never end the shutdown.
      const detail = signal === null ? `code ${String(code)}` : `signal ${signal}`;
      log(`replaced backend pid=${child.pid ?? 'unknown'} exited (${detail}); ignored`);
      return;
    }
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
      // Layer 3 of the seat gate: a licence exit code anywhere in the backend's
      // own stderr tail is a permanent answer for this session.
      const denial = seatDenialFromText(state.stderrTail) ?? seatDenialFromText(state.lastError);
      if (denial !== null) {
        recordSeatDenial(denial, 'the backend exit');
      }
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
    // A held start (single-seat engine, busy profile) answers the client itself:
    // the handshake is synthesized and kept for the replay, the tool list comes
    // from the cache and every call retries. Buffering here would leave the
    // client waiting for an initialize that cannot come.
    if (outputDirUnresolved() && state.hold.active === false && state.profile.pendingCopy === null) {
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
// A single-seat hold never starts a backend while the profile is busy: the
// session waits, serves its cached list and retries on the next tool call.
// A copy-mode or on_locked=copy start is lazy only while it has a cached list to
// serve (2.21.0): on a surface this machine has never cached, the copy is taken
// now, because a client whose list is the three meta-tools can never take it.
function startBackendAtStartup() {
  if (state.hold.active) {
    log('backend start held until the profile is free; this session retries on its next tool call');
    return;
  }
  if (state.profile.pendingCopy !== null && coldCopyStartNeeded()) {
    takeColdCopyNow();
  }
  if (state.profile.pendingCopy !== null) {
    log(
      'backend start deferred until the first browser action: profile_lifetime "browser" takes the session ' +
        'copy (and, in a copy mode, the base lock) then',
    );
    return;
  }
  if (outputDirUnresolved() && state.engineError === null) {
    log('backend start deferred until initialize: the artifact directory depends on the client roots');
    return;
  }
  startBackend();
}

startBackendAtStartup();
