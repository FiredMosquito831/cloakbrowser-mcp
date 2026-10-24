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
  loadEngineConfiguration,
  manifestSupport,
  portableToolNames,
  profileAllows,
  resolveToolProfile,
} from './engine-registry.mjs';

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.join(PLUGIN_ROOT, 'launch.mjs');
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
});
const engine = loaded.engine;
const profiles = loaded.profiles;
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
  engineError: loaded.error,
  engineChoices: loaded.engineIds,
  profiles,
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
  lastError: loaded.error,
  stderrTail: '',
  shuttingDown: false,
  backend: {
    state: loaded.error === null ? 'idle' : 'failed',
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
  return manifestSupport(state.engine, toolName);
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
  const browserNames = names.filter((name) => name.startsWith('browser_'));
  return {
    backend: names.length,
    browser: browserNames.length,
    local: names.length - browserNames.length,
  };
}

function supportedCounts() {
  const names = backendToolNames();
  const supported = names.filter((name) => profileAllowsTool(name));
  return {
    all: supported.length,
    browser: supported.filter((name) => name.startsWith('browser_')).length,
  };
}

function capabilitiesPayload() {
  const counts = state.toolsListed ? toolCounts() : null;
  const supported = state.toolsListed ? supportedCounts() : null;
  const perToolSupport = {};
  if (state.toolsListed) {
    for (const name of [...backendToolNames()].sort()) {
      perToolSupport[name] = supportFor(name);
    }
  }
  return {
    engine: state.engineId,
    label: state.engine?.label ?? null,
    contract: state.engine?.contract ?? null,
    transport: state.engine?.transport ?? null,
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
    hiddenByManifest: [...state.hiddenByManifest],
    hiddenByCollision: [...state.hiddenByCollision],
    requestedToolProfile: state.requestedToolProfile,
    toolProfileSource: state.toolProfileSource,
    engineDefaultToolProfile: state.engine?.defaultToolProfile ?? null,
    availableToolProfiles: state.profiles === null ? [] : availableProfileNames(state.profiles),
    portableToolNames: state.profiles === null ? [] : portableToolNames(state.profiles),
    perToolSupportNotes: state.engine?.toolSupportNotes ?? {},
    hiddenByProfile: [...state.hiddenByProfile],
    unavailableTools: [],
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
  state.backend.state = 'starting';
  state.spawnedAt = Date.now();
  log(
    `engine=${state.engineId} source=${state.engineSource} contract=${state.engine.contract} ` +
      `profile=${state.toolProfile} profileSource=${state.toolProfileSource} launcher=${path.basename(LAUNCHER)}`,
  );
  const child = spawn(process.execPath, [LAUNCHER], {
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
      state.lastError = `Backend exited (${detail}).`;
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
