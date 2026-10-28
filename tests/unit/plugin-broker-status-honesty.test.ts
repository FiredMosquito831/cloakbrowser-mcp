import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

// Broker status honesty (2.9.3). A backend can reject the initialize handshake
// and still answer tools/list and tool calls; the status must then stop saying
// "failed", keep the rejection visible, and stop growing waitMs. A normal
// backend must keep every previous value, and a silent one must keep growing
// waitMs until its first answer. Each guard is mutation-checked by the PR.

interface JsonRpcResponse {
  id?: number;
  result?: {
    tools?: { name: string }[];
    content?: { type: string; text?: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    instructions?: string;
    serverInfo?: { name?: string; version?: string };
  };
  error?: { code: number; message: string };
}

interface BrokerSession {
  request: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<JsonRpcResponse>;
  stderr: () => string;
  close: () => Promise<void>;
}

function structuredContent(response: JsonRpcResponse): Record<string, unknown> {
  return response.result?.structuredContent ?? {};
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginRoot = path.join(repoRoot, 'plugins', 'cloakbrowser');
const brokerPath = path.join(pluginRoot, 'broker.mjs');
const STUB_TOOLS = ['browser_navigate', 'browser_snapshot', 'browser_evaluate'];
const PROTOCOL_2026_MESSAGE =
  'connection is serving the 2026-07-28 protocol; the initialize handshake is not accepted';
const GENERIC_MESSAGE = 'initialize refused by policy';

const STUB_SOURCE = `#!/usr/bin/env node
// Deterministic stand-in for the cloakbrowser-mcp CLI. MODE decides the
// handshake: normal accepts initialize, reject-2026 refuses it with the Python
// MCP SDK's 2026-07-28 message, reject-generic refuses it with an unrelated
// message, and silent answers nothing at all. Every other mode answers
// tools/list and tool calls so a rejected-but-usable backend is reproducible.
const readline = require('node:readline');

const MODE = __MODE__;
const TOOLS = __TOOLS__;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function handle(message) {
  if (MODE === 'silent') return;
  if (message.method === 'initialize') {
    if (MODE === 'normal' || MODE === 'internal-32603') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'stub-broker-status', version: '0.0.1' },
        },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32022,
        message: MODE === 'reject-2026' ? __PROTOCOL_MESSAGE__ : __GENERIC_MESSAGE__,
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    // internal-32603 is a different transport-era failure with the same numeric
    // code; only the pinned "Not connected" wording means a dead upstream.
    if (MODE === 'internal-32603') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Internal error' } });
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
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'ok' }], isError: false },
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
  } catch {
    // Ignore malformed input, exactly as a real MCP server would not answer it.
  }
});
rl.on('close', () => process.exit(0));
`;

type StubMode = 'normal' | 'reject-2026' | 'reject-generic' | 'silent' | 'internal-32603';

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

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createRuntime(mode: StubMode): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cloakbrowser-status-honesty-'));
  tempRoots.push(root);
  const modules = path.join(root, 'runtime', 'node_modules');
  mkdirSync(path.join(modules, 'cloakbrowser'), { recursive: true });
  mkdirSync(path.join(modules, 'playwright-core'), { recursive: true });
  mkdirSync(path.join(modules, 'playwright'), { recursive: true });
  mkdirSync(path.join(modules, 'cloakbrowser-mcp', 'dist'), { recursive: true });
  writeJson(path.join(root, 'runtime', '.installed.json'), {
    package: 'cloakbrowser-mcp@1.15.1',
    engine: '0.6.3',
    driver: 'patchright@1.64.1',
  });
  writeJson(path.join(modules, 'cloakbrowser', 'package.json'), {
    name: 'cloakbrowser',
    version: '0.6.3',
  });
  writeJson(path.join(modules, 'playwright-core', 'package.json'), {
    name: 'patchright-core',
    version: '1.64.1',
  });
  writeJson(path.join(modules, 'playwright', 'package.json'), {
    name: 'patchright',
    version: '1.64.1',
  });
  const source = STUB_SOURCE.replace('__MODE__', JSON.stringify(mode))
    .replace('__TOOLS__', JSON.stringify(STUB_TOOLS))
    .replace('__PROTOCOL_MESSAGE__', JSON.stringify(PROTOCOL_2026_MESSAGE))
    .replace('__GENERIC_MESSAGE__', JSON.stringify(GENERIC_MESSAGE));
  writeFileSync(path.join(modules, 'cloakbrowser-mcp', 'dist', 'cli.js'), source);
  return root;
}

function startBroker(dataDir: string): BrokerSession {
  const child = spawn(process.execPath, [brokerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      STEALTH_ENGINE: 'cloak',
      STEALTH_TOOL_PROFILE: 'full',
      CLAUDE_PLUGIN_DATA: dataDir,
      // Keep the launcher's runtime identity deterministic even if the test
      // process inherited a different pin from the developer's environment.
      CLOAK_PLAYWRIGHT_MCP_PACKAGE: 'cloakbrowser-mcp@1.15.1',
    },
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim() === '') return;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
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
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
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
    request: (method, params, timeoutMs) => request(method, params, timeoutMs),
    stderr: () => stderr,
    close,
  };
  sessions.push(session);
  return session;
}

function statusPayload(response: JsonRpcResponse): Record<string, unknown> {
  return structuredContent(response);
}

async function callStatus(session: BrokerSession): Promise<Record<string, unknown>> {
  return statusPayload(await session.request('tools/call', { name: 'browser_engine_status', arguments: {} }));
}

describe('broker status after a rejected initialize that still answers', () => {
  it('reports running, keeps the rejection, adds the protocol sentence and freezes waitMs', async () => {
    const dataDir = createRuntime('reject-2026');
    const session = startBroker(dataDir);

    const initialize = await session.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(initialize.error?.message).toBe(PROTOCOL_2026_MESSAGE);

    // The rejection itself is an answer: waitMs must stop immediately and the
    // rejection must be visible, while the backend has not listed tools yet.
    const rejected = await callStatus(session);
    expect(rejected.backendState).toBe('failed');
    expect(rejected.initializeRejected).toBe(true);
    expect(rejected.waitMs).toBeNull();
    expect(String(rejected.lastError)).toContain(`Backend rejected initialize: ${PROTOCOL_2026_MESSAGE}`);
    expect(String(rejected.lastError)).toContain('2026-07-28 protocol era');
    expect(String(rejected.lastError)).toContain('update the plugin');
    expect(String(rejected.lastError)).toContain('2.9.2');

    const list = await session.request('tools/list', {});
    const names = list.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain('browser_engine_status');
    expect(names).toContain('browser_capabilities');

    const answered = await callStatus(session);
    expect(answered.backendState).toBe('running');
    expect(answered.initializeRejected).toBe(true);
    expect(answered.waitMs).toBeNull();
    expect(String(answered.lastError)).toContain(PROTOCOL_2026_MESSAGE);
    expect(answered.backendToolCount).toBe(STUB_TOOLS.length);

    // A tool call is the second proof; the state stays running and waitMs
    // stays frozen (null) after a pause.
    const call = await session.request('tools/call', {
      name: 'browser_snapshot',
      arguments: {},
    });
    expect(call.result?.isError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterCall = await callStatus(session);
    expect(afterCall.backendState).toBe('running');
    expect(afterCall.initializeRejected).toBe(true);
    expect(afterCall.waitMs).toBeNull();
    expect(afterCall.lastError).toBe(answered.lastError);
  });

  it('keeps a rejection without the 2026-07-28 message byte-identical', async () => {
    const dataDir = createRuntime('reject-generic');
    const session = startBroker(dataDir);
    const initialize = await session.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(initialize.error?.message).toBe(GENERIC_MESSAGE);
    const rejected = await callStatus(session);
    expect(rejected.lastError).toBe(`Backend rejected initialize: ${GENERIC_MESSAGE}`);
    expect(rejected.initializeRejected).toBe(true);
    await session.request('tools/list', {});
    const answered = await callStatus(session);
    expect(answered.backendState).toBe('running');
    expect(answered.lastError).toBe(`Backend rejected initialize: ${GENERIC_MESSAGE}`);
  });
});

// The additive groups every engine reports in browser_engine_status, in order.
// They carry not-applicable values for an engine that cannot use them, which is
// why they are part of the baseline rather than conditional keys.
const IDENTITY_KEYS = [
  'identityMode',
  'identityApplies',
  'identitySource',
  'identityFile',
  'identityCreatedAt',
  'identityNote',
];
const PING_TIMEOUT_KEYS = [
  'pingTimeoutApplies',
  'pingTimeoutMs',
  'pingTimeoutSource',
  'heartbeatEnabled',
  'pingTimeoutNote',
];

describe('normal backend status stays byte-identical', () => {
  it('reports running with no initializeRejected key and the usual timing values', async () => {
    const dataDir = createRuntime('normal');
    const session = startBroker(dataDir);
    const initialize = await session.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(initialize.result?.serverInfo?.name).toBe('stub-broker-status');
    // 2.9.5 appends one artifact sentence to every handshake; the stub sends no
    // instructions of its own, so that sentence opens the value.
    expect(initialize.result?.instructions).toMatch(
      /^Browser artifacts \(screenshots, traces, downloads\) go to /,
    );
    // 2.19.0 (user decision Q5) appends one URL sentence, and only that.
    expect(initialize.result?.instructions).toContain('browser_navigate takes a full URL: a bare word');

    const listed = await callStatus(session);
    expect(listed.backendState).toBe('running');
    expect(listed.lastError).toBeNull();
    expect(listed.waitMs).toBeNull();
    expect(typeof listed.startupMs).toBe('number');
    expect(Object.hasOwn(listed, 'initializeRejected')).toBe(false);
    expect(Object.hasOwn(listed, 'backendAnswered')).toBe(false);

    const list = await session.request('tools/list', {});
    expect(list.result?.tools).toHaveLength(STUB_TOOLS.length + 3);

    const call = await session.request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: 'data:text/html,ok' },
    });
    expect(call.result?.isError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = await callStatus(session);
    expect(after.backendState).toBe('running');
    expect(after.lastError).toBeNull();
    expect(after.waitMs).toBeNull();
    expect(typeof after.startupMs).toBe('number');
    expect(Object.hasOwn(after, 'initializeRejected')).toBe(false);
    // 2.19.0 adds nothing to a healthy payload: the dead-backend keys exist only
    // on the degraded path or after an automatic restart.
    expect(Object.hasOwn(after, 'backendSubstate')).toBe(false);
    expect(Object.hasOwn(after, 'backendRestart')).toBe(false);
    // The key order of a healthy status is the one 2.18.0 produced (plus the
    // 2.19.0 sentence above, which is not a status key). Every key added later
    // must be conditional, and this list is where that is enforced.
    expect(Object.keys(after)).toEqual([
      'engine',
      'label',
      'engineSource',
      'engineError',
      'transport',
      'contract',
      'toolProfile',
      'backendState',
      'backendPid',
      'backendVersion',
      'backendServerName',
      'lastError',
      'startupMs',
      'waitMs',
      'toolsListWaitMs',
      'pendingRequestCount',
      'uptimeMs',
      'backendToolCount',
      'exposedToolCount',
      'metaToolCount',
      'brokerVersion',
      'howToChangeEngine',
      'backendStderrTail',
      'account',
      'profileDir',
      'profileIsolation',
      'profileApplies',
      'onLocked',
      'profileFallback',
      'profileLock',
      // The cloak manifest declares its own profileLock (Chromium's lockfile).
      'engineProfileLock',
      ...IDENTITY_KEYS,
      ...PING_TIMEOUT_KEYS,
    ]);
  });
});

describe('F1 — only the pinned dead-upstream answer is classified', () => {
  it('relays a plain -32603 with another message byte-for-byte and keeps running', async () => {
    const dataDir = createRuntime('internal-32603');
    const session = startBroker(dataDir);
    await session.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    const list = await session.request('tools/list', {});
    // The same numeric code with a different message is a backend error, not a
    // death: it is relayed unchanged and no degraded state is recorded.
    expect(list.error).toEqual({ code: -32603, message: 'Internal error' });
    const payload = await callStatus(session);
    expect(payload.backendState).toBe('running');
    expect(payload.lastError).toBeNull();
    expect(Object.hasOwn(payload, 'backendSubstate')).toBe(false);
    expect(Object.hasOwn(payload, 'backendRestart')).toBe(false);
    expect(session.stderr()).not.toContain('dead-backend recovery');
  });
});

describe('a backend that never answers keeps the growth behaviour', () => {
  it('grows waitMs until the first answer and reports the starting state', async () => {
    const dataDir = createRuntime('silent');
    const session = startBroker(dataDir);
    // No initialize is sent: the meta-tool answers locally while the backend
    // has answered nothing at all.
    const first = await callStatus(session);
    expect(first.backendState).toBe('starting');
    expect(typeof first.waitMs).toBe('number');
    expect(Number(first.waitMs)).toBeGreaterThanOrEqual(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await callStatus(session);
    expect(typeof second.waitMs).toBe('number');
    expect(Number(second.waitMs)).toBeGreaterThan(Number(first.waitMs));
    expect(Object.hasOwn(second, 'initializeRejected')).toBe(false);
  });
});
