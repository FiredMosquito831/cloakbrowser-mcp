#!/usr/bin/env node
// CloakBrowser multi-engine broker.
//
// One stdio MCP server in front of the existing launcher. It reads the engine id
// from the environment, loads the matching manifest from ./engines, starts
// launch.mjs for that engine and relays JSON-RPC in both directions. It also
// owns the two broker meta-tools and the disabled-tools filter.
//
// Protocol rules: stdout carries JSON-RPC lines only; every log goes to stderr.
// Windows rules: no detached children, stdin EOF is the shutdown signal, and the
// backend process tree is killed with taskkill after a 300 ms grace period.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  accountProxyPath,
  backendEnvironment,
  DEFAULT_PROFILE_NAME,
  effectiveProfileDir,
  lockBlocksStart,
  profileFallbackReason,
  profileLockFix,
  profileLockMessage,
  readAccountProxy,
  readProfileLock,
  redactSecrets,
  resolveProfile,
  resolveProfileIsolation,
  selectFallbackProfile,
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

const META_TOOL_NAMES = new Set(['browser_capabilities', 'browser_engine_status']);
const META_TOOLS = [
  {
    name: 'browser_capabilities',
    description:
      'Report the selected browser engine, its Playwright MCP contract, the active tool profile, the backend tool count, per-tool support and how to change engines. This is a local broker tool; it does not start a browser. When another session already uses the browser profile, it also reports the profile directory, the owning process and the fix.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_engine_status',
    description:
      'Report the selected engine, backend process state, backend version when the handshake has completed, startup timing and the last error. This is a local broker tool; it does not start a browser. When another session already uses the browser profile, it also reports the profile directory, the owning process and the fix.',
    inputSchema: { type: 'object', properties: {} },
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
// "workspace" derives one profile per project folder, Playwright-style. An
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
        error: null,
      }
    : resolveProfile({
        account: rawAccount,
        profileDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR,
        engineId: engine.id,
        dataDir: PLUGIN_DATA_DIR,
        launcherName: resolveLauncherName(engine),
        ignoredSettings: Array.isArray(engine.ignoredSettings) ? engine.ignoredSettings : [],
        profileApplies,
        isolation: profileIsolation.mode,
        cwd: process.cwd(),
      });
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

// Loud lock preflight. The bridge takes its exclusive profile lock at backend
// start-up, so starting a backend against a profile a live process owns only
// produces "Backend exited" and a two-tool surface. The broker reads the same
// lock file first (never writes, moves, copies or deletes a lock or a profile).
//   shared / account / profile_dir: a busy profile stops the spawn; the owner and
//                                   the fix are reported instead.
//   workspace:                      a busy derived profile moves to its first
//                                   free numbered sibling (-2 ... -5) and the
//                                   fallback is always reported.
let profileLock = null;
let profileFallback = null;
if (engineError === null && profileApplies) {
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
  }
}

// The profile directory an optional .proxy file sits beside: an account or
// workspace profile, or the default profile when the broker sets nothing.
function proxyCandidate() {
  const source = profileResolution.profileSource;
  if (source === 'account' || source === 'workspace') {
    return profileResolution.profileDir;
  }
  return source === 'default' ? profileResolution.defaultProfileDir : null;
}

// The optional per-account proxy file. proxy_server wins when set; otherwise the
// file beside the resolved profile is read for a named account, for a workspace
// profile and for the default account (where it is used only when it exists).
// Engines whose manifest ignores profile_dir have no account profile, so no file
// is read.
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

// The broker creates the resolved account or workspace directory (it never
// deletes, copies or migrates one). An explicit profile_dir is not created here:
// launch.mjs has always created it, and its bytes are unchanged.
if (
  engineError === null &&
  (profileResolution.profileSource === 'account' || profileResolution.profileSource === 'workspace')
) {
  try {
    mkdirSync(profileResolution.profileDir, { recursive: true });
  } catch (error) {
    const label = profileResolution.profileSource === 'workspace' ? 'workspace' : 'account';
    engineError = `Cannot create the ${label} profile directory ${profileResolution.profileDir}: ${error.message}`;
  }
}

const runtimeHint = runtimeErrorHint(engine, process.env);
const profileSelection = resolveToolProfile(process.env.STEALTH_TOOL_PROFILE, engine, profiles);

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
  // describe this start and are reported additively by the meta-tools.
  profile: {
    account: profileResolution.account,
    dir:
      profileResolution.profileSource === 'account' || profileResolution.profileSource === 'workspace'
        ? profileResolution.profileDir
        : null,
    source: profileResolution.profileSource,
    applies: profileResolution.accountApplies,
    defaultDir: profileResolution.defaultProfileDir,
    error: profileResolution.error,
    isolation: profileIsolation.mode,
    isolationSource: profileIsolation.source,
    appliesToEngine: profileApplies,
    lock: profileLock,
    fallback: profileFallback,
  },
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
  initializeAnswered: false,
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
      if (entry.isDirectory()) {
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

function capabilitiesPayload() {
  const systemDeps = systemDependencyReport();
  const counts = state.toolsListed ? toolCounts() : null;
  const supported = state.toolsListed ? supportedCounts() : null;
  const accounts = availableAccounts();
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
    profileIsolation: state.profile.isolation,
    profileIsolationSource: state.profile.isolationSource,
    profileApplies: state.profile.appliesToEngine,
    profileFallback: state.profile.fallback,
    profileLock: state.profile.lock,
  };
}

function statusPayload() {
  const counts = state.toolsListed ? toolCounts() : null;
  const now = Date.now();
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
    state.spawnedAt === null || state.initializeAnswered ? null : Math.max(0, now - state.spawnedAt);
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
  };
}

function handleMetaCall(message) {
  const name = message.params?.name;
  if (name === 'browser_capabilities') {
    sendToolPayload(message.id, capabilitiesPayload());
    return true;
  }
  if (name === 'browser_engine_status') {
    sendToolPayload(message.id, statusPayload());
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
    (dependencyHint === null ? '' : ` ${dependencyHint}`);
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

function beginShutdown() {
  if (state.shuttingDown) {
    return;
  }
  state.shuttingDown = true;
  log('stdin closed; stopping backend');
  const child = state.child;
  if (child === null || child.exitCode !== null || child.signalCode !== null) {
    process.exit(0);
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
    setTimeout(() => process.exit(0), 100);
  }, SHUTDOWN_GRACE_MS);
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
      state.requestedProtocolVersion = message.params?.protocolVersion ?? null;
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
      state.requestedProtocolVersion = message.params?.protocolVersion ?? null;
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

function handleBackendMessage(message, rawLine) {
  if (message === null || typeof message !== 'object') {
    return;
  }
  const id = message.id;
  const isResponse = message.method === undefined && id !== undefined && id !== null;
  const pending = isResponse ? state.pendingRequests.get(id) : undefined;
  if (isResponse) {
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
    state.lastError = `Backend rejected initialize: ${String(reason)}`;
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
    if (state.profile.fallback !== null) {
      // The session is running on a different identity than its workspace
      // profile; say so in the handshake, not only in the meta-tools. Every
      // other initialise response is relayed byte-for-byte.
      const result = message.result !== null && typeof message.result === 'object' ? message.result : {};
      const current = typeof result.instructions === 'string' ? result.instructions.trim() : '';
      message.result = {
        ...result,
        instructions:
          current === '' ? state.profile.fallback.reason : `${current} ${state.profile.fallback.reason}`,
      };
      process.stdout.write(`${JSON.stringify(message)}\n`);
      return;
    }
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
  // Only an active account/workspace profile, a fallback or a proxy-file
  // decision adds a line, so the default start-up log stays byte-identical.
  if (
    state.profile.source === 'account' ||
    state.profile.source === 'workspace' ||
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
    // otherwise the environment is the base plus that one variable.
    env: backendEnvironment(process.env, {
      engineId: state.engineId,
      profileDir: state.profile.dir,
      proxyServer: state.proxy.appliedProxy,
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
      // forced taskkill path, so do not surface the child's signal code.
      process.exit(0);
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
    handleClientRequest(message, line);
  })
  .on('close', beginShutdown);

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, beginShutdown);
}

if (state.engineError !== null) {
  log(state.engineError);
}

startBackend();
