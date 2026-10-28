import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Dead-backend recovery (2.19.0).
//
// Two deaths used to be invisible or permanent:
//   (c) launch.mjs (and the bridge with it) exits: every call said "backend is
//       not running" forever and nothing restarted it;
//   (d) only the bridge's own @playwright/mcp child exits: the bridge stays up
//       and answers every call and tools/list with JSON-RPC -32603
//       "Not connected", while browser_engine_status still said "running".
//
// The broker now classifies that exact answer (the pinned MCP SDK's own text),
// reports it honestly, answers tools/list from the meta-tools, and makes one
// bounded restart: the same call is replayed into the new backend, the client's
// handshake is replayed with the 2.16.0 machinery, and one
// notifications/tools/list_changed follows. A second death within 5 minutes is
// not restarted; a successful call reopens the window; a busy profile, a
// refused start or an active hold never restarts.
//
// Every probe stops at the stub: no browser is launched anywhere in this suite.

interface JsonRpcResponse {
  id?: number | string;
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
  notify: (method: string, params?: Record<string, unknown>) => void;
  notifications: () => string[];
  stderr: () => string;
  close: () => Promise<void>;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const brokerPath = path.join(repoRoot, 'plugins', 'cloakbrowser', 'broker.mjs');
const LOCK = '.cloakbrowser-mcp-profile.lock';
const STUB_TOOLS = ['browser_navigate', 'browser_snapshot', 'browser_crash'];
const META_TOOLS = ['browser_capabilities', 'browser_engine_status', 'browser_profiles'];
// The exact answer the pinned bridge gives once its upstream has gone:
// @modelcontextprotocol/sdk 1.32.2 dist/cjs/client/stdio.js throws
// `new Error('Not connected')`, the bridge re-throws it, and the SDK server
// turns it into InternalError with that message.
const NOT_CONNECTED = 'Not connected';

// The stub models both shapes. STUB_DEAD_STARTS=n makes the first n instances
// answer everything but initialize with -32603 "Not connected"; STUB_COUNTER
// records how many instances started; STUB_LOG records every request so a test
// can prove that exactly one call was replayed.
const STUB_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const TOOLS = __TOOLS__;
const COUNTER = process.env.STUB_COUNTER || '';
const LOG = process.env.STUB_LOG || '';
const EXIT_ON = process.env.STUB_EXIT_ON_CALL || '';
let prior = 0;
try {
  if (COUNTER && fs.existsSync(COUNTER)) prior = Number(fs.readFileSync(COUNTER, 'utf8')) || 0;
} catch {
  prior = 0;
}
const instance = prior + 1;
if (COUNTER) fs.writeFileSync(COUNTER, String(instance));
const dead = instance <= Number(process.env.STUB_DEAD_STARTS || '0');
function note(entry) {
  if (!LOG) return;
  fs.appendFileSync(LOG, JSON.stringify(Object.assign({ instance, dead }, entry)) + '\\n');
}
note({ event: 'start' });
const PID_DIR = process.env.STUB_PID_DIR || '';
if (PID_DIR) {
  fs.mkdirSync(PID_DIR, { recursive: true });
  fs.writeFileSync(require('node:path').join(PID_DIR, instance + '.pid'), String(process.pid));
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
function handle(message) {
  if (message.method === 'initialize') {
    note({ event: 'request', method: 'initialize', id: message.id });
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'stub-dead-backend', version: '0.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    note({ event: 'request', method: 'tools/list', id: message.id });
    if (dead) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: __NOT_CONNECTED__ } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: TOOLS.map((name) => ({
          name,
          description: 'stub ' + name,
          inputSchema: { type: 'object', properties: {} },
        })),
      },
    });
    return;
  }
  if (message.method === 'tools/call') {
    note({
      event: 'request',
      method: 'tools/call',
      id: message.id,
      name: message.params && message.params.name,
    });
    if (EXIT_ON !== '' && message.params && message.params.name === EXIT_ON) {
      process.exit(7);
    }
    if (dead) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: __NOT_CONNECTED__ } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ instance }) }], isError: false },
    });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: {} });
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (line.trim() === '') return;
  try {
    handle(JSON.parse(line));
  } catch {}
});
rl.on('close', () => process.exit(0));
`;

interface Harness {
  dataDir: string;
  counter: string;
  log: string;
  session: BrokerSession;
}

interface HarnessOptions {
  deadStarts?: number;
  exitOnCall?: string;
  onLocked?: string;
  preseedLockPid?: number;
}

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

function writeLock(profileDir: string, pid: number): string {
  mkdirSync(profileDir, { recursive: true });
  const file = path.join(profileDir, LOCK);
  writeFileSync(
    file,
    `${JSON.stringify({ pid, createdAt: '2026-10-28T08:00:00.000Z', userDataDir: profileDir }, null, 2)}\n`,
  );
  return file;
}

function createRuntime(dataDir: string): void {
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
  const source = STUB_SOURCE.replaceAll('__TOOLS__', JSON.stringify(STUB_TOOLS)).replaceAll(
    '__NOT_CONNECTED__',
    JSON.stringify(NOT_CONNECTED),
  );
  writeFileSync(path.join(modules, 'cloakbrowser-mcp', 'dist', 'cli.js'), source);
  mkdirSync(path.join(dataDir, 'profiles', 'cloak'), { recursive: true });
}

function startBroker(dataDir: string, counter: string, log: string, options: HarnessOptions): BrokerSession {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dataDir,
    CLOAK_PLAYWRIGHT_MCP_PACKAGE: 'cloakbrowser-mcp@1.15.1',
    STEALTH_ENGINE: 'cloak',
    STEALTH_TOOL_PROFILE: 'full',
    STUB_COUNTER: counter,
    STUB_LOG: log,
    STUB_DEAD_STARTS: String(options.deadStarts ?? 0),
    STUB_EXIT_ON_CALL: options.exitOnCall ?? '',
    STUB_PID_DIR: path.join(dataDir, 'stub-pids'),
  };
  for (const name of [
    'STEALTH_ACCOUNT',
    'STEALTH_PROFILE_ISOLATION',
    'STEALTH_ON_LOCKED',
    'PLAYWRIGHT_MCP_USER_DATA_DIR',
    'PLAYWRIGHT_MCP_ISOLATED',
  ]) {
    delete childEnv[name];
  }
  if (options.onLocked !== undefined) childEnv.STEALTH_ON_LOCKED = options.onLocked;
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
  const pending = new Map<string, (response: JsonRpcResponse) => void>();
  const clientRoots = new Set<string>();
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim() === '') return;
    let message: JsonRpcResponse & { method?: string };
    try {
      message = JSON.parse(line) as JsonRpcResponse & { method?: string };
    } catch {
      return;
    }
    if (typeof message.method === 'string') {
      if (message.id === undefined) {
        notes.push(message.method);
        return;
      }
      // A server-initiated request (the broker's own roots probe) must never be
      // matched against a client id.
      return;
    }
    const key = String(message.id);
    const resolve = pending.get(key);
    if (resolve !== undefined) {
      pending.delete(key);
      resolve(message);
    }
  });
  let nextId = 1;
  const request = (method: string, params?: Record<string, unknown>, timeoutMs = 15000) => {
    const id = nextId++;
    const key = String(id);
    clientRoots.add(key);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`timeout waiting for ${method}; stderr=${stderr.slice(-800)}`));
      }, timeoutMs);
      pending.set(key, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  };
  const notify = (method: string, params?: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  };
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  };
  const session: BrokerSession = {
    request,
    notify,
    notifications: () => [...notes],
    stderr: () => stderr,
    close,
  };
  sessions.push(session);
  return session;
}

function harness(prefix: string, options: HarnessOptions = {}): Harness {
  const dataDir = tempRoot(prefix);
  createRuntime(dataDir);
  const counter = path.join(dataDir, 'stub-instances.txt');
  const log = path.join(dataDir, 'stub-requests.log');
  if (options.preseedLockPid !== undefined) {
    writeLock(path.join(dataDir, 'profiles', 'default'), options.preseedLockPid);
  }
  const session = startBroker(dataDir, counter, log, options);
  return { dataDir, counter, log, session };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stubPid(dataDir: string, instance: number): number | null {
  const file = path.join(dataDir, 'stub-pids', `${instance}.pid`);
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : null;
}

function instances(counter: string): number {
  return existsSync(counter) ? Number(readFileSync(counter, 'utf8')) || 0 : 0;
}

interface LogEntry {
  instance: number;
  dead: boolean;
  event: string;
  method?: string;
  id?: number | string;
  name?: string;
}

function entries(log: string): LogEntry[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LogEntry);
}

async function initialize(session: BrokerSession): Promise<JsonRpcResponse> {
  const response = await session.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  session.notify('notifications/initialized');
  return response;
}

async function status(session: BrokerSession): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name: 'browser_engine_status', arguments: {} });
  return response.result?.structuredContent ?? {};
}

async function capabilities(session: BrokerSession): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name: 'browser_capabilities', arguments: {} });
  return response.result?.structuredContent ?? {};
}

async function toolNames(session: BrokerSession): Promise<string[]> {
  const list = await session.request('tools/list', {});
  return (list.result?.tools ?? []).map((tool) => tool.name);
}

function responseText(response: JsonRpcResponse): string {
  return response.result?.content?.[0]?.text ?? '';
}

describe('F1 — honest liveness when only the upstream is gone', () => {
  it('classifies -32603 "Not connected", reports it and answers tools/list meta-only', async () => {
    const { session, counter } = harness('dead-upstream-status-', { deadStarts: 1 });
    await initialize(session);
    // The bridge is alive and answers, but its upstream is gone: the exact
    // answer the pinned SDK produces.
    const list = await session.request('tools/list', {});
    expect(list.result?.tools?.map((tool) => tool.name)).toEqual(META_TOOLS);

    const payload = await status(session);
    expect(payload.backendState).toBe('failed');
    expect(payload.backendSubstate).toBe('upstream-disconnected');
    expect(String(payload.lastError)).toContain(NOT_CONNECTED);
    // The bridge process itself is still there: the honesty is about usability.
    expect(payload.backendPid).not.toBeNull();
    // No restart happened on a list: the next tool call is what recovers.
    expect(Object.hasOwn(payload, 'backendRestart')).toBe(false);
    expect(instances(counter)).toBe(1);

    const caps = await capabilities(session);
    expect(caps.backendSubstate).toBe('upstream-disconnected');
    expect(session.stderr()).toContain(`dead-backend recovery: Upstream disconnected: ${NOT_CONNECTED}`);
  });

  it('keeps a healthy backend payload free of the degraded keys', async () => {
    const { session } = harness('dead-healthy-baseline-');
    await initialize(session);
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
    const call = await session.request('tools/call', { name: 'browser_navigate', arguments: {} });
    expect(call.result?.isError).toBe(false);
    const payload = await status(session);
    expect(payload.backendState).toBe('running');
    expect(payload.lastError).toBeNull();
    expect(Object.hasOwn(payload, 'backendSubstate')).toBe(false);
    expect(Object.hasOwn(payload, 'backendRestart')).toBe(false);
    const caps = await capabilities(session);
    expect(Object.hasOwn(caps, 'backendSubstate')).toBe(false);
    expect(Object.hasOwn(caps, 'backendRestart')).toBe(false);
    expect(session.stderr()).not.toContain('dead-backend recovery');
  });
});

describe('F2 — one bounded restart and one replayed call', () => {
  it('restarts once, replays exactly that call and emits list_changed', async () => {
    const { dataDir, session, counter, log } = harness('dead-upstream-restart-', { deadStarts: 1 });
    await initialize(session);
    // The list is classified first, so the surface is honest before the restart.
    expect((await session.request('tools/list', {})).result?.tools?.map((tool) => tool.name)).toEqual(
      META_TOOLS,
    );

    const call = await session.request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: 'https://x/' },
    });
    expect(call.error).toBeUndefined();
    expect(call.result?.isError).toBe(false);
    // The answer comes from the second instance: the call was replayed, not
    // fabricated by the broker.
    expect(JSON.parse(responseText(call))).toEqual({ instance: 2 });
    expect(instances(counter)).toBe(2);
    expect(session.notifications()).toContain('notifications/tools/list_changed');

    const all = entries(log);
    const calls = all.filter((entry) => entry.method === 'tools/call');
    // The classified session never sends the call to the dead bridge: the call
    // itself is what finds the backend unusable, so it goes out exactly once,
    // to the restarted backend. One call, one new instance, no duplicate.
    expect(calls.map((entry) => entry.instance)).toEqual([2]);
    expect(calls).toHaveLength(1);
    // The new backend received the client's own handshake before the call.
    const secondInitialize = all.filter((entry) => entry.instance === 2 && entry.method === 'initialize');
    expect(secondInitialize).toHaveLength(1);

    const payload = await status(session);
    expect(payload.backendState).toBe('running');
    expect(Object.hasOwn(payload, 'backendSubstate')).toBe(false);
    expect(payload.backendRestart).toMatchObject({
      count: 1,
      reason: 'the upstream disconnected',
      outcome: 'recovered',
    });
    expect(session.stderr()).toContain(
      'restarting the backend once (attempt 1 since the last successful tool call)',
    );
    // The bridge that answered "Not connected" was still running. Only this
    // session's own tree may be stopped, and it must be: a second bridge would
    // hold the profile lock and a browser seat.
    expect(session.stderr()).toContain("stopping this session's own backend tree");
    const firstPid = stubPid(dataDir, 1);
    const secondPid = stubPid(dataDir, 2);
    expect(firstPid).not.toBeNull();
    expect(secondPid).not.toBeNull();
    expect(alive(firstPid!)).toBe(false);
    expect(alive(secondPid!)).toBe(true);
  });

  it('does not restart a second time inside the 5-minute window', async () => {
    // Every instance is dead: the restarted backend reports the same death, and
    // the second failure inside the window must not restart again.
    const { session, counter } = harness('dead-upstream-cap-', { deadStarts: 3 });
    await initialize(session);
    const call = await session.request('tools/call', { name: 'browser_navigate', arguments: {} });
    expect(call.error).toBeUndefined();
    expect(call.result?.isError).toBe(true);
    const text = responseText(call);
    expect(text).toContain(NOT_CONNECTED);
    expect(text).toContain(
      'No automatic restart ran: one automatic restart already ran in the last 5 minutes.',
    );
    expect(instances(counter)).toBe(2);
    const payload = await status(session);
    expect(payload.backendState).toBe('failed');
    expect(payload.backendSubstate).toBe('upstream-disconnected');
    expect(payload.backendRestart).toMatchObject({ count: 1, reason: 'the upstream disconnected' });
    expect(String((payload.backendRestart as Record<string, unknown>).refusedReason)).toContain(
      'one automatic restart already ran',
    );
    expect(session.stderr()).toContain(
      'not restarting (the upstream disconnected): one automatic restart already ran',
    );
  });

  it('reopens the window after a successful call', async () => {
    // Death, restart, a successful call, a second death: the successful call
    // resets the window, so the next death restarts again (three instances).
    const { session, counter, log } = harness('dead-upstream-reopen-', {
      deadStarts: 1,
      exitOnCall: 'browser_crash',
    });
    await initialize(session);
    const first = await session.request('tools/call', { name: 'browser_navigate', arguments: {} });
    expect(JSON.parse(responseText(first))).toEqual({ instance: 2 });
    expect(instances(counter)).toBe(2);
    // The crash is answered with the existing error and is never replayed.
    const crash = await session.request('tools/call', { name: 'browser_crash', arguments: {} });
    expect(crash.error?.message).toContain('Cannot complete "tools/call"');
    // The successful call above reset the window, so this death restarts again.
    const second = await session.request('tools/call', { name: 'browser_navigate', arguments: {} });
    expect(second.result?.isError).toBe(false);
    expect(JSON.parse(responseText(second))).toEqual({ instance: 3 });
    expect(instances(counter)).toBe(3);
    const payload = await status(session);
    expect(payload.backendRestart).toMatchObject({ count: 2, outcome: 'recovered' });
    expect(session.stderr()).toContain('a tool call succeeded; the automatic restart window is open again');
    // Instance 1 received the call that discovered the death; the same call was
    // replayed exactly once into instance 2, and the last call went to 3.
    const perInstance = entries(log).filter((entry) => entry.method === 'tools/call');
    expect(perInstance.map((entry) => entry.instance)).toEqual([1, 2, 2, 3]);
  });

  it('restarts when the launcher itself exited, on the next call', async () => {
    const { session, counter } = harness('dead-child-exit-', { exitOnCall: 'browser_crash' });
    await initialize(session);
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
    // The call that kills the backend is answered with the existing error and is
    // never replayed: it may already have run in the browser.
    const crashed = await session.request('tools/call', { name: 'browser_crash', arguments: {} });
    expect(crashed.error?.message).toContain('Cannot complete "tools/call"');
    const dead = await status(session);
    expect(dead.backendState).toBe('exited');
    expect(String(dead.lastError)).toContain('Backend exited');
    // The next call finds the backend dead and is the retry.
    const recovered = await session.request('tools/call', { name: 'browser_navigate', arguments: {} });
    expect(recovered.result?.isError).toBe(false);
    expect(JSON.parse(responseText(recovered))).toEqual({ instance: 2 });
    expect(instances(counter)).toBe(2);
    expect(session.notifications()).toContain('notifications/tools/list_changed');
    const payload = await status(session);
    expect(payload.backendState).toBe('running');
    expect(payload.backendRestart).toMatchObject({
      count: 1,
      reason: 'the backend exited',
      outcome: 'recovered',
    });
  });
});

describe('F2 — a restart never runs where it must not', () => {
  it('never restarts a start that was refused (on_locked=block)', async () => {
    const { session, counter } = harness('dead-blocked-start-', {
      onLocked: 'block',
      preseedLockPid: process.pid,
    });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain('The backend was not started');
    expect(await toolNames(session)).toEqual(META_TOOLS);
    const call = await session.request('tools/call', { name: 'browser_navigate', arguments: {} });
    expect(call.result?.isError).toBe(true);
    // The 2.15 message for a refused start is unchanged: it already carries the
    // cause, and no restart is mentioned because none is possible.
    const text = responseText(call);
    expect(text).toContain('backend unavailable:');
    expect(text).toContain('already in use');
    expect(text).not.toContain('automatic restart');
    expect(instances(counter)).toBe(0);
    const payload = await status(session);
    expect(Object.hasOwn(payload, 'backendRestart')).toBe(false);
  });

  it('never restarts while a single-seat hold is active, and keeps the hold path', async () => {
    const { session, counter } = harness('dead-held-start-', { preseedLockPid: process.pid });
    await initialize(session);
    const call = await session.request('tools/call', { name: 'browser_navigate', arguments: {} });
    expect(call.result?.isError).toBe(true);
    expect(responseText(call)).toContain('retries automatically on the next tool call');
    expect(instances(counter)).toBe(0);
    const caps = await capabilities(session);
    expect(caps.hold).toMatchObject({ state: 'waiting' });
    expect(Object.hasOwn(caps, 'backendRestart')).toBe(false);
  });

  it('goes down the hold path when the profile is taken between the death and the call', async () => {
    // The backend starts fine, then dies; before the retry the profile is locked
    // by another session. The preflight runs before the spawn, so no second
    // CloakBrowser can start: the session holds instead.
    const { session, counter, dataDir } = harness('dead-profile-taken-', { exitOnCall: 'browser_crash' });
    await initialize(session);
    await session.request('tools/call', { name: 'browser_crash', arguments: {} });
    const dead = await status(session);
    expect(dead.backendState).toBe('exited');
    writeLock(path.join(dataDir, 'profiles', 'default'), process.pid);
    const call = await session.request('tools/call', { name: 'browser_navigate', arguments: {} });
    expect(call.result?.isError).toBe(true);
    expect(responseText(call)).toContain('already in use');
    expect(responseText(call)).toContain('retries automatically on the next tool call');
    // Only the original instance ever started.
    expect(instances(counter)).toBe(1);
    const payload = await status(session);
    expect(payload.backendState).toBe('waiting-for-profile');
    expect(payload.hold).toMatchObject({
      state: 'waiting',
      profileDir: path.join(dataDir, 'profiles', 'default'),
    });
    expect(Object.hasOwn(payload, 'backendRestart')).toBe(false);
    expect(session.stderr()).toContain('not restarting (the backend exited): the profile');
  });
});
