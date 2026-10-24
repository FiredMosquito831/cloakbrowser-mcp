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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  availableProfileNames,
  DEFAULT_ENGINE,
  engineChangeHelp,
  firstMissingRequiredEnv,
  loadEngineConfiguration,
  manifestSupport,
  portableToolNames,
  profileAllows,
  resolveLauncherName,
  resolveToolProfile,
} from './engine-registry.mjs';
import { enrichToolError, runtimeErrorHint, runtimeStatusFields } from './lib/attach.mjs';
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
      'Report the selected browser engine, its Playwright MCP contract, the active tool profile, the backend tool count, per-tool support and how to change engines. This is a local broker tool; it does not start a browser.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_engine_status',
    description:
      'Report the selected engine, backend process state, backend version when the handshake has completed, startup timing and the last error. This is a local broker tool; it does not start a browser.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

// The last non-empty stderr line a launcher wrote, bounded so a stack trace
// cannot bloat a status payload. Used only for engines that declare a runtime
// hint, so other engines keep their exact previous error text.
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

function capabilitiesPayload() {
  const counts = state.toolsListed ? toolCounts() : null;
  const supported = state.toolsListed ? supportedCounts() : null;
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
    ...nativeCapabilitiesExtras(),
  };
}

function statusPayload() {
  const counts = state.toolsListed ? toolCounts() : null;
  const now = Date.now();
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
    lastError: state.lastError,
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
    backendStderrTail: state.stderrTail.trim() === '' ? null : state.stderrTail.slice(-1500),
    // A manifest that declares a runtime (an attach endpoint and profile id)
    // names its own extra status keys here. Other engines add nothing.
    ...runtimeStatusFields(state.engine, process.env),
    ...(state.native
      ? {
          surfaceBuilt: state.nativeSurface !== null,
          surfaceError: state.nativeSurfaceError,
        }
      : {}),
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
  const instructions =
    `The ${state.engineId} backend is unavailable: ${reason} ` +
    'Call browser_engine_status for details. Only broker meta-tools are exposed until Claude Code restarts the MCP server.';
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
      if (runtimeHint !== null && !state.toolCallSucceeded) {
        const enriched = enrichToolError(message.result, runtimeHint);
        if (enriched !== null) {
          process.stdout.write(`${JSON.stringify({ ...message, result: enriched })}\n`);
          return;
        }
      }
    } else {
      state.toolCallSucceeded = true;
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
  const child = spawn(process.execPath, [launcher], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // The manifest is the source of truth for the selected engine; keep the
    // legacy backend variable in sync even if only STEALTH_ENGINE was set.
    env: { ...process.env, PLAYWRIGHT_MCP_BROWSER_ENGINE: state.engineId },
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
    process.stderr.write(chunk);
    state.stderrTail = `${state.stderrTail}${chunk.toString('utf8')}`.slice(-4000);
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
      const launcherLine = runtimeHint === null ? null : lastStderrLine(state.stderrTail);
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
