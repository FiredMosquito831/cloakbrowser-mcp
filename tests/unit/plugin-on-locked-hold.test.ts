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

// The single-seat hold (2.16.0). The cloak engine declares `singleSeat: true`,
// because the free CloakBrowser licence allows one concurrent browser: moving a
// second session to a sibling profile would start a backend and then fail at the
// first browser action. Instead the second session keeps its server and its tool
// list, answers tool calls with an isError naming the owner, and re-runs the
// preflight on every call: when the profile is free the backend starts, the
// client's handshake is replayed and the triggering call is forwarded.
//
// No browser is launched anywhere in this suite: every probe stops at
// initialize, tools/list, a meta-tool or a forwarded call answered by the stub.

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
  notifications: () => string[];
  stderr: () => string;
  close: () => Promise<void>;
}

interface BrokerOptions {
  dataDir: string;
  onLocked?: string;
  isolation?: string;
  account?: string;
  profileDir?: string;
  engine?: string;
  disabledTools?: string;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const brokerPath = path.join(repoRoot, 'plugins', 'cloakbrowser', 'broker.mjs');
const LOCK = '.cloakbrowser-mcp-profile.lock';
const STUB_TOOLS = ['browser_navigate', 'browser_snapshot'];
const META_TOOLS = ['browser_capabilities', 'browser_engine_status', 'browser_profiles'];

const STUB_SOURCE = `#!/usr/bin/env node
const readline = require('node:readline');
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
let initializeSeen = false;
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    initializeSeen = true;
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-seat', version: '0.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} } })) } });
    return;
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ profileDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? null, isolated: process.env.PLAYWRIGHT_MCP_ISOLATED ?? null, initializeSeen }) }], isError: false } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: {} });
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

function writeLock(profileDir: string, pid: number, createdAt = '2026-10-27T11:00:00.000Z'): string {
  mkdirSync(profileDir, { recursive: true });
  const file = path.join(profileDir, LOCK);
  writeFileSync(file, `${JSON.stringify({ pid, createdAt, userDataDir: profileDir }, null, 2)}\n`);
  return file;
}

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
    STEALTH_ENGINE: options.engine ?? 'cloak',
    STEALTH_TOOL_PROFILE: 'full',
  };
  for (const name of [
    'STEALTH_ACCOUNT',
    'STEALTH_PROFILE_ISOLATION',
    'STEALTH_ON_LOCKED',
    'PLAYWRIGHT_MCP_USER_DATA_DIR',
    'PLAYWRIGHT_MCP_ISOLATED',
    'CLOAK_DISABLED_TOOLS',
  ]) {
    delete childEnv[name];
  }
  if (options.account !== undefined) childEnv.STEALTH_ACCOUNT = options.account;
  if (options.isolation !== undefined) childEnv.STEALTH_PROFILE_ISOLATION = options.isolation;
  if (options.onLocked !== undefined) childEnv.STEALTH_ON_LOCKED = options.onLocked;
  if (options.profileDir !== undefined) childEnv.PLAYWRIGHT_MCP_USER_DATA_DIR = options.profileDir;
  if (options.disabledTools !== undefined) childEnv.CLOAK_DISABLED_TOOLS = options.disabledTools;
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
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id) as (response: JsonRpcResponse) => void;
      pending.delete(message.id);
      resolve(message);
    }
  });
  let nextId = 1;
  const request = (method: string, params?: Record<string, unknown>, timeoutMs = 8000) => {
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
  const session: BrokerSession = { request, notifications: () => [...notes], stderr: () => stderr, close };
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

async function capabilities(session: BrokerSession): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name: 'browser_capabilities', arguments: {} });
  return response.result?.structuredContent ?? {};
}

async function status(session: BrokerSession): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name: 'browser_engine_status', arguments: {} });
  return response.result?.structuredContent ?? {};
}

async function profilesPayload(session: BrokerSession): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name: 'browser_profiles', arguments: {} });
  return response.result?.structuredContent ?? {};
}

async function toolNames(session: BrokerSession): Promise<string[]> {
  const list = await session.request('tools/list', {});
  return (list.result?.tools ?? []).map((tool) => tool.name);
}

async function callTool(session: BrokerSession, name: string): Promise<JsonRpcResponse> {
  return session.request('tools/call', { name, arguments: { url: 'http://127.0.0.1:9/' } });
}

function callText(response: JsonRpcResponse): string {
  return response.result?.content?.[0]?.text ?? '';
}

// A first, unheld start writes the tool-list cache; closing it frees the profile
// so a second start can be held by a lock file. No browser is involved.
async function seedToolCache(dataDir: string): Promise<void> {
  const session = startBroker({ dataDir });
  await initialize(session);
  await session.request('tools/list', {});
  await session.close();
}

describe('single-seat hold: while the profile is busy', () => {
  it('keeps the server usable, spawns no backend and serves the meta-tools without a cache', async () => {
    const dataDir = createRuntime(tempRoot('seat-hold-'));
    const base = path.join(dataDir, 'profiles', 'default');
    writeLock(base, process.pid);
    const session = startBroker({ dataDir });
    const initialized = await initialize(session);
    const instructions = initialized.result?.instructions ?? '';
    expect(instructions).toContain(`The cloak browser profile ${base} is already in use`);
    expect(instructions).toContain(`pid ${process.pid}`);
    expect(instructions).toContain('retries automatically on the next tool call');
    expect(instructions).not.toContain('Restart Claude Code');
    expect(instructions).toContain('No cached tool list exists yet');
    expect(await toolNames(session)).toEqual(META_TOOLS);
    const caps = await capabilities(session);
    expect(caps).toMatchObject({
      onLocked: 'fallback',
      profileFallback: null,
      hold: { state: 'waiting', profileDir: base, owner: { pid: process.pid }, attempts: 0 },
    });
    expect(caps.engineError).toBeNull();
    const statusPayload = await status(session);
    expect(statusPayload.backendState).toBe('waiting-for-profile');
    expect(statusPayload.backendPid).toBeNull();
    expect(statusPayload.lastError).toBeNull();
    const profiles = await profilesPayload(session);
    expect((profiles.current as Record<string, unknown>).hold).toMatchObject({ state: 'waiting' });
    expect(session.stderr()).toContain('backend start held until the profile is free');
  });

  it('serves the cached tool list, filtered through the normal rules', async () => {
    const dataDir = createRuntime(tempRoot('seat-cache-'));
    await seedToolCache(dataDir);
    const cacheRoot = path.join(dataDir, 'cache', 'cloak');
    expect(existsSync(cacheRoot)).toBe(true);
    const base = path.join(dataDir, 'profiles', 'default');
    writeLock(base, process.pid);
    const session = startBroker({ dataDir, disabledTools: 'browser_snapshot' });
    await initialize(session);
    const names = await toolNames(session);
    // The cached backend list through manifest → profile → disabled_tools.
    expect(names).toEqual(['browser_navigate', ...META_TOOLS]);
    const caps = await capabilities(session);
    expect(caps.hold).toMatchObject({ state: 'waiting', toolList: { source: 'cache' } });
    expect(caps.backendToolCount).toBe(2);
    expect(session.stderr()).toContain('serving 2 cached backend tools');
  });

  it('answers a tool call with an isError naming the owner and tries again next time', async () => {
    const dataDir = createRuntime(tempRoot('seat-busy-call-'));
    const base = path.join(dataDir, 'profiles', 'default');
    writeLock(base, process.pid);
    const session = startBroker({ dataDir });
    await initialize(session);
    const first = await callTool(session, 'browser_navigate');
    expect(first.result?.isError).toBe(true);
    const text = callText(first);
    expect(text).toContain('already in use');
    expect(text).toContain(`pid ${process.pid}`);
    expect(text).toContain('retries automatically on the next tool call');
    const second = await callTool(session, 'browser_navigate');
    expect(second.result?.isError).toBe(true);
    const caps = await capabilities(session);
    expect(caps.hold).toMatchObject({ state: 'waiting', attempts: 2 });
    expect((await status(session)).backendPid).toBeNull();
    expect(session.stderr()).toContain('still in use (attempt 2)');
  });

  it('holds an explicit profile_dir too, because a hold creates nothing', async () => {
    const dataDir = createRuntime(tempRoot('seat-explicit-'));
    const explicit = path.join(tempRoot('seat-explicit-profile-'), 'profile');
    writeLock(explicit, process.pid);
    const session = startBroker({ dataDir, profileDir: explicit });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain(
      `The cloak browser profile ${explicit} is already in use`,
    );
    const caps = await capabilities(session);
    expect(caps).toMatchObject({
      profileSource: 'profile_dir',
      onLocked: 'fallback',
      profileFallback: null,
      hold: { state: 'waiting', profileDir: explicit },
    });
    expect(existsSync(`${explicit}-2`)).toBe(false);
  });

  it('keeps on_locked=block meta-only for the single-seat engine', async () => {
    const dataDir = createRuntime(tempRoot('seat-block-'));
    const base = path.join(dataDir, 'profiles', 'default');
    writeLock(base, process.pid);
    const session = startBroker({ dataDir, onLocked: 'block' });
    const initialized = await initialize(session);
    const instructions = initialized.result?.instructions ?? '';
    expect(instructions).toContain('The backend was not started');
    expect(instructions).not.toContain('retries automatically');
    expect(await toolNames(session)).toEqual(META_TOOLS);
    const caps = await capabilities(session);
    expect(caps.onLocked).toBe('block');
    expect(caps.hold).toBeUndefined();
    expect(String(caps.engineError)).toContain('already in use');
  });
});

describe('single-seat hold: recovery', () => {
  it('starts the backend on the next tool call and answers that call', async () => {
    const dataDir = createRuntime(tempRoot('seat-recover-'));
    await seedToolCache(dataDir);
    const base = path.join(dataDir, 'profiles', 'default');
    const lockFile = writeLock(base, process.pid);
    const session = startBroker({ dataDir });
    await initialize(session);
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
    // The other session closes: the bridge lock is gone.
    rmSync(lockFile);
    const response = await callTool(session, 'browser_navigate');
    expect(response.result?.isError).toBeFalsy();
    // The broker answered the handshake itself, so it owes the backend a replay:
    // without it the stub would never have seen initialize.
    expect(JSON.parse(callText(response))).toEqual({
      profileDir: base,
      isolated: null,
      initializeSeen: true,
    });
    // The client is told its tool list is authoritative again.
    const notes = session.notifications();
    expect(notes).toContain('notifications/tools/list_changed');
    const caps = await capabilities(session);
    expect(caps.hold).toMatchObject({ state: 'recovered', profileDir: base, attempts: 1 });
    expect(typeof (caps.hold as Record<string, unknown>).recoveredAt).toBe('string');
    const statusPayload = await status(session);
    expect(statusPayload.backendState).not.toBe('waiting-for-profile');
    expect(statusPayload.backendPid).not.toBeNull();
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
    expect(session.stderr()).toContain('the profile is free; starting the backend');
  });

  it('makes the deferred copy first when the held base frees (copy mode)', async () => {
    const dataDir = createRuntime(tempRoot('seat-recover-copy-'));
    const base = path.join(dataDir, 'profiles', 'default');
    mkdirSync(path.join(base, 'Default'), { recursive: true });
    writeFileSync(path.join(base, 'Default', 'Cookies'), 'cookie-bytes');
    const lockFile = writeLock(base, process.pid);
    const session = startBroker({ dataDir, isolation: 'copy' });
    await initialize(session);
    const held = await capabilities(session);
    expect(held.hold).toMatchObject({ state: 'waiting' });
    expect(existsSync(path.join(dataDir, 'profiles', 'cloak', '.sessions'))).toBe(false);
    rmSync(lockFile);
    const response = await callTool(session, 'browser_navigate');
    expect(response.result?.isError).toBeFalsy();
    const caps = await capabilities(session);
    expect(caps.hold).toMatchObject({ state: 'recovered' });
    const copy = caps.profileCopy as Record<string, unknown>;
    expect(copy).toMatchObject({ baseDir: base });
    expect(String(copy.sessionDir)).toContain(path.join('profiles', 'cloak', '.sessions'));
    const env = JSON.parse(callText(response)) as { profileDir: string };
    expect(env.profileDir).toBe(copy.sessionDir);
    // The base itself was read, never written: it now holds this session's lock.
    expect(readFileSync(path.join(base, 'Default', 'Cookies'), 'utf8')).toBe('cookie-bytes');
  });

  it('reports a copy that cannot be made when the base frees', async () => {
    const dataDir = createRuntime(tempRoot('seat-recover-fail-'));
    const base = path.join(dataDir, 'profiles', 'default');
    const lockFile = writeLock(base, process.pid);
    const session = startBroker({ dataDir, isolation: 'copy' });
    await initialize(session);
    // The base is freed, but it is not a usable directory any more: the deferred
    // copy refuses loudly instead of starting a session on nothing.
    rmSync(lockFile);
    rmSync(base, { recursive: true, force: true });
    writeFileSync(base, 'not a directory');
    const response = await callTool(session, 'browser_navigate');
    expect(response.result?.isError).toBe(true);
    expect(callText(response)).toContain('cannot use the base profile');
    const caps = await capabilities(session);
    expect((caps.hold as Record<string, unknown>).state).toBe('failed');
    expect((await status(session)).backendPid).toBeNull();
  });
});
