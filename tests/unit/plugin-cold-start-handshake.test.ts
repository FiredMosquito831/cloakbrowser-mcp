import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The first-start handshake (2.23.0). On a machine that has never provisioned,
// the launcher spends the whole MCP connect window on npm install / uv / Python /
// venv / the Camoufox build before the engine that answers `initialize` exists,
// and Claude Code's startup timeout is 30 s. The broker now answers the client's
// handshake itself when the backend has not done so within a bounded window, lets
// provisioning continue behind it, consumes the backend's late answers and
// announces the real tool list with notifications/tools/list_changed.
//
// Every window here is shortened through the documented environment overrides, so
// the suite is fast and deterministic. No browser is launched anywhere: the stub
// answers `initialize`, `tools/list` and a tool call, nothing else.

interface JsonRpcResponse {
  id?: number;
  result?: {
    tools?: { name: string; description?: string; inputSchema?: unknown }[];
    content?: { type: string; text?: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    instructions?: string;
    serverInfo?: { name?: string; version?: string };
  };
  error?: { code: number; message: string };
}

interface BrokerSession {
  request: (method: string, params?: Record<string, unknown>) => Promise<JsonRpcResponse>;
  notify: (method: string) => void;
  notifications: () => string[];
  waitForNotification: (method: string, timeoutMs: number) => Promise<void>;
  stderr: () => string;
  close: () => Promise<void>;
}

interface BrokerOptions {
  dataDir: string;
  /** The stub's delay before its first `initialize` answer, in ms. */
  initDelayMs?: number;
  /** The stub's delay before its first `tools/list` answer, in ms. */
  listDelayMs?: number;
  /** The broker's own windows; the defaults are the shipped 5 000 / 15 000 ms. */
  handshakeGraceMs?: string;
  toolsListGraceMs?: string;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const brokerPath = path.join(repoRoot, 'plugins', 'cloakbrowser', 'broker.mjs');
const STUB_TOOLS = ['browser_navigate', 'browser_snapshot'];
const META_TOOLS = ['browser_capabilities', 'browser_engine_status', 'browser_profiles'];

// The stub models a provisioning engine: the first `initialize` and the first
// `tools/list` are answered only after the configured delay, and every later
// request is answered at once. That is what a launcher's cold start looks like
// from the broker's side.
const STUB_SOURCE = `#!/usr/bin/env node
const readline = require('node:readline');
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
const INIT_DELAY_MS = Number(process.env.STUB_INIT_DELAY_MS ?? '0');
const LIST_DELAY_MS = Number(process.env.STUB_LIST_DELAY_MS ?? '0');
let initializeAnswered = false;
let firstListAnswered = false;
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    const answer = { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-cold-start', version: '9.9.9' } } };
    if (initializeAnswered || INIT_DELAY_MS === 0) { initializeAnswered = true; send(answer); return; }
    initializeAnswered = true;
    setTimeout(() => send(answer), INIT_DELAY_MS);
    return;
  }
  if (message.method === 'tools/list') {
    const answer = { jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} } })) } };
    if (firstListAnswered || LIST_DELAY_MS === 0) { firstListAnswered = true; send(answer); return; }
    firstListAnswered = true;
    setTimeout(() => send(answer), LIST_DELAY_MS);
    return;
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ stub: true }) }], isError: false } });
    return;
  }
  if (message.id !== undefined) { send({ jsonrpc: '2.0', id: message.id, result: {} }); }
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => { if (line.trim() === '') return; try { handle(JSON.parse(line)); } catch {} });
rl.on('close', () => process.exit(0));
`;

const tempRoots: string[] = [];
const sessions: BrokerSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close();
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// The launcher's own runtime layout: when `.installed.json` and the package
// directories are present, `launch.mjs` spawns `dist/cli.js` without installing
// anything, so the stub is the backend.
function createRuntime(dataDir: string): string {
  const runtime = path.join(dataDir, 'runtime');
  const modules = path.join(runtime, 'node_modules');
  mkdirSync(path.join(modules, 'cloakbrowser'), { recursive: true });
  mkdirSync(path.join(modules, 'playwright-core'), { recursive: true });
  mkdirSync(path.join(modules, 'playwright'), { recursive: true });
  writeJson(path.join(runtime, '.installed.json'), {
    package: 'cloakbrowser-mcp@1.15.1',
    engine: '0.6.3',
    driver: 'patchright@1.64.1',
  });
  writeJson(path.join(modules, 'cloakbrowser', 'package.json'), { name: 'cloakbrowser', version: '0.6.3' });
  writeJson(path.join(modules, 'playwright-core', 'package.json'), {
    name: 'patchright-core',
    version: '1.64.1',
  });
  writeJson(path.join(modules, 'playwright', 'package.json'), { name: 'patchright', version: '1.64.1' });
  mkdirSync(path.join(modules, 'cloakbrowser-mcp', 'dist'), { recursive: true });
  writeFileSync(path.join(modules, 'cloakbrowser-mcp', 'dist', 'cli.js'), STUB_SOURCE);
  mkdirSync(path.join(dataDir, 'profiles', 'cloak'), { recursive: true });
  return dataDir;
}

function startBroker(options: BrokerOptions): BrokerSession {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: options.dataDir,
    CLOAK_PLAYWRIGHT_MCP_PACKAGE: 'cloakbrowser-mcp@1.15.1',
    STEALTH_ENGINE: 'cloak',
    STEALTH_TOOL_PROFILE: 'full',
    STUB_INIT_DELAY_MS: String(options.initDelayMs ?? 0),
    STUB_LIST_DELAY_MS: String(options.listDelayMs ?? 0),
  };
  for (const name of [
    'STEALTH_ACCOUNT',
    'STEALTH_PROFILE_ISOLATION',
    'STEALTH_ON_LOCKED',
    'PLAYWRIGHT_MCP_USER_DATA_DIR',
    'PLAYWRIGHT_MCP_ISOLATED',
    'CLOAK_DISABLED_TOOLS',
    'STEALTH_HANDSHAKE_GRACE_MS',
    'STEALTH_TOOLS_LIST_GRACE_MS',
  ]) {
    delete childEnv[name];
  }
  if (options.handshakeGraceMs !== undefined) childEnv.STEALTH_HANDSHAKE_GRACE_MS = options.handshakeGraceMs;
  if (options.toolsListGraceMs !== undefined) childEnv.STEALTH_TOOLS_LIST_GRACE_MS = options.toolsListGraceMs;
  const child = spawn(process.execPath, [brokerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const notes: string[] = [];
  const noteWaiters: { method: string; resolve: () => void }[] = [];
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim() === '') return;
    let message: JsonRpcResponse & { method?: string };
    try {
      message = JSON.parse(line) as JsonRpcResponse & { method?: string };
    } catch {
      return;
    }
    if (typeof message.method === 'string' && message.id === undefined) {
      notes.push(message.method);
      for (const waiter of noteWaiters.splice(0)) {
        if (waiter.method === message.method) {
          waiter.resolve();
        } else {
          noteWaiters.push(waiter);
        }
      }
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id) as (response: JsonRpcResponse) => void;
      pending.delete(message.id);
      resolve(message);
    }
  });
  let nextId = 1;
  const request = (method: string, params?: Record<string, unknown>, timeoutMs = 15000) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}; stderr=${stderr.slice(-500)}`));
      }, timeoutMs);
      pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  };
  const notify = (method: string) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  };
  const waitForNotification = (method: string, timeoutMs: number) =>
    new Promise<void>((resolve, reject) => {
      if (notes.includes(method)) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error(`timeout waiting for ${method}; stderr=${stderr.slice(-500)}`));
      }, timeoutMs);
      noteWaiters.push({
        method,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  };
  const session: BrokerSession = {
    request,
    notify,
    notifications: () => [...notes],
    waitForNotification,
    stderr: () => stderr,
    close,
  };
  sessions.push(session);
  return session;
}

async function initialize(session: BrokerSession): Promise<JsonRpcResponse> {
  return session.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
}

async function status(session: BrokerSession): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name: 'browser_engine_status', arguments: {} });
  return response.result?.structuredContent ?? {};
}

async function toolNames(session: BrokerSession): Promise<string[]> {
  const list = await session.request('tools/list', {});
  return (list.result?.tools ?? []).map((tool) => tool.name);
}

// A first, warm start writes the tool-list cache for this surface; closing it
// leaves the cache behind for the next start.
async function seedToolCache(dataDir: string): Promise<void> {
  const session = startBroker({ dataDir });
  await initialize(session);
  await session.request('tools/list', {});
  await session.close();
}

describe('first-start handshake: cold', () => {
  it('answers initialize and tools/list inside the window, then announces the real list', async () => {
    const dataDir = createRuntime(tempRoot('cold-start-'));
    // The stub answers its first initialize and its first tools/list 2 000 ms
    // after receiving them; the broker's windows are 400 ms and 600 ms.
    const session = startBroker({
      dataDir,
      initDelayMs: 2000,
      listDelayMs: 2000,
      handshakeGraceMs: '400',
      toolsListGraceMs: '600',
    });
    const startedAt = Date.now();
    const initialized = await initialize(session);
    const elapsed = Date.now() - startedAt;
    // budget: the broker's window is 400 ms; 1 500 ms still excludes the stub's 2 000 ms delay.
    expect(elapsed).toBeLessThan(1500);
    // The broker answered, not the stub: its own server identity and the
    // first-start sentence, which is neither the hold sentence nor "unavailable".
    expect(initialized.result?.serverInfo?.name).toBe('cloakbrowser-broker');
    const instructions = initialized.result?.instructions ?? '';
    expect(instructions).toContain('starting for the first time on this machine');
    expect(instructions).toContain('the full tool list appears automatically when the engine is ready');
    expect(instructions).toContain('browser_engine_status');
    expect(instructions).not.toContain('Restart Claude Code');
    expect(instructions).not.toContain('backend is unavailable');
    expect(instructions).not.toContain('already in use');
    // The artifact-directory sentence every initialize answer carries is kept.
    expect(instructions).toContain('Browser artifacts (screenshots, traces, downloads) go to');
    // The backend has answered nothing yet, so the status says so honestly and
    // startupMs still measures the backend's own answer.
    const starting = await status(session);
    expect(starting.backendState).toBe('starting');
    expect(starting.backendSubstate).toBe('provisioning');
    expect(starting.startupMs).toBeNull();
    expect(starting.backendPid).not.toBeNull();
    // The tool list is answered inside its own window: no cache exists for this
    // surface, so the three meta-tools are the honest answer.
    session.notify('notifications/initialized');
    expect(await toolNames(session)).toEqual(META_TOOLS);
    expect(session.stderr()).toContain('first start: the backend has not answered tools/list');
    // The stub finally answers both requests. The client is told its tool list is
    // authoritative again, and a fresh list is the backend's own.
    await session.waitForNotification('notifications/tools/list_changed', 15000);
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
    const running = await status(session);
    expect(running.backendState).toBe('running');
    expect(running.backendSubstate).toBeUndefined();
    expect(running.backendServerName).toBe('stub-cold-start');
    // budget: the stub delays 2 000 ms, so >= 1 000 ms proves startupMs measured the backend.
    expect(Number(running.startupMs)).toBeGreaterThanOrEqual(1000);
    expect(session.stderr()).toContain('first start: the backend has not answered initialize');
  });

  it('serves the cached tool list instead of the meta-tools when one exists', async () => {
    const dataDir = createRuntime(tempRoot('cold-start-cache-'));
    await seedToolCache(dataDir);
    expect(existsSync(path.join(dataDir, 'cache', 'cloak'))).toBe(true);
    const session = startBroker({
      dataDir,
      initDelayMs: 2000,
      listDelayMs: 2000,
      handshakeGraceMs: '400',
      toolsListGraceMs: '600',
    });
    await initialize(session);
    session.notify('notifications/initialized');
    // The cached backend list through the normal filters, not the meta-tools.
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
    expect(session.stderr()).toContain('serving 2 cached backend tools');
    await session.waitForNotification('notifications/tools/list_changed', 15000);
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
  });

  it('falls back to the default window on an invalid override, with one log line', async () => {
    const dataDir = createRuntime(tempRoot('cold-start-invalid-'));
    const session = startBroker({ dataDir, handshakeGraceMs: '-5', toolsListGraceMs: 'soon' });
    // The stub answers at once, so the (default, long) windows never fire.
    const initialized = await initialize(session);
    expect(initialized.result?.serverInfo?.name).toBe('stub-cold-start');
    expect(session.stderr()).toContain(
      'ignoring invalid STEALTH_HANDSHAKE_GRACE_MS value "-5"; using 5000 ms',
    );
    expect(session.stderr()).toContain(
      'ignoring invalid STEALTH_TOOLS_LIST_GRACE_MS value "soon"; using 15000 ms',
    );
  });
});

describe('first-start handshake: warm control', () => {
  it('relays the backend handshake and list unchanged, with no notification', async () => {
    const dataDir = createRuntime(tempRoot('cold-start-warm-'));
    const session = startBroker({ dataDir });
    const initialized = await initialize(session);
    // The backend's own identity is relayed: the broker never answered for it.
    expect(initialized.result?.serverInfo?.name).toBe('stub-cold-start');
    expect(initialized.result?.serverInfo?.version).toBe('9.9.9');
    expect(initialized.result?.instructions).not.toContain('starting for the first time on this machine');
    session.notify('notifications/initialized');
    // The first tools/list is the backend's own list, never the meta-tools.
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
    const statusPayload = await status(session);
    expect(statusPayload.backendState).toBe('running');
    expect(statusPayload.backendSubstate).toBeUndefined();
    expect(session.notifications()).not.toContain('notifications/tools/list_changed');
    expect(session.stderr()).not.toContain('first start:');
  });
});
