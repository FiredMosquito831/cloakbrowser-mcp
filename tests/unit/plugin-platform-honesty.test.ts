// Platform honesty (2.23.1): the additive `platform` key and the display-less
// Linux failure.
//
//   D6  browser_capabilities always carries `platform` (process.platform), on
//       every engine and every path, and no other key moves. The status payload
//       is deliberately unchanged.
//   D5  a headed Camoufox on a Linux machine with no DISPLAY or WAYLAND_DISPLAY
//       fails once with one actionable sentence; the value is never flipped to
//       headless.
//
// The broker runs are the real plugins/cloakbrowser broker; the engine entry
// point is a deterministic stdio stub, so no browser is launched and nothing
// downloads. The launcher helpers are imported from the shipped plugin copies
// (the core-sync suite proves they are byte-identical to shared/core).

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');

interface LauncherModule {
  DISPLAYLESS_LINUX_SENTENCE: string;
  displaylessLinuxProblem(env: Record<string, string | undefined>, platform?: string): string | null;
}

const camoufoxLauncher = (await import(
  new URL('../../plugins/cloakbrowser/launch-camoufox.mjs', import.meta.url).href
)) as unknown as LauncherModule;
const nativeLauncher = (await import(
  new URL('../../plugins/cloakbrowser/launch-camoufox-native.mjs', import.meta.url).href
)) as unknown as LauncherModule;

const SENTENCE =
  'No DISPLAY or WAYLAND_DISPLAY is set on this Linux machine, so a headed Camoufox cannot start. ' +
  'Set the Headless setting to true, or run under Xvfb.';

interface JsonRpcResponse {
  result?: {
    tools?: { name?: string }[];
    content?: { type: string; text?: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    instructions?: string;
  };
  error?: { code: number; message: string };
}

interface BrokerSession {
  request: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<JsonRpcResponse>;
  stderr: () => string;
  close: () => Promise<void>;
}

const STUB_TOOLS = ['browser_navigate', 'browser_close'];

// STUB_FAIL=1 makes the backend print one line and exit 1, which is exactly what
// a launcher that refuses a start does. The sentence is the 2.23.1 one, so the
// test proves the broker's existing stderr -> lastError path carries it.
const STUB_SOURCE = `#!/usr/bin/env node
const readline = require('node:readline');
if (process.env.STUB_FAIL === '1') {
  process.stderr.write(${JSON.stringify(`[camoufox] ${SENTENCE}`)} + '\\n');
  process.exit(1);
}
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-platform', version: '0.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} } })) } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '{}' }], isError: false } });
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => { if (line.trim() !== '') { try { handle(JSON.parse(line)); } catch {} } });
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
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// The stub runtime launch.mjs finds already provisioned, exactly as
// tests/unit/plugin-safe-defaults.test.ts builds it.
function createRuntime(dataDir: string): string {
  const runtime = path.join(dataDir, 'runtime');
  const modules = path.join(runtime, 'node_modules');
  for (const name of ['cloakbrowser', 'playwright-core', 'playwright', 'cloakbrowser-mcp']) {
    mkdirSync(path.join(modules, name), { recursive: true });
  }
  mkdirSync(path.join(modules, 'cloakbrowser-mcp', 'dist'), { recursive: true });
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
  writeFileSync(path.join(modules, 'cloakbrowser-mcp', 'dist', 'cli.js'), STUB_SOURCE);
  mkdirSync(path.join(dataDir, 'profiles', 'playwright'), { recursive: true });
  return dataDir;
}

function startBroker(options: { dataDir: string; failBackend?: boolean }): BrokerSession {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: options.dataDir,
    CLOAK_PLAYWRIGHT_MCP_PACKAGE: 'cloakbrowser-mcp@1.15.1',
    STEALTH_ENGINE: 'playwright',
    STEALTH_TOOL_PROFILE: 'full',
  };
  for (const name of [
    'STEALTH_ACCOUNT',
    'STEALTH_PROFILE_ISOLATION',
    'STEALTH_ON_LOCKED',
    'PLAYWRIGHT_MCP_USER_DATA_DIR',
    'STUB_FAIL',
  ]) {
    delete childEnv[name];
  }
  if (options.failBackend === true) {
    childEnv.STUB_FAIL = '1';
  }
  const child = spawn(process.execPath, [path.join(pluginDir, 'broker.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim() === '') return;
    let message: JsonRpcResponse & { id?: number };
    try {
      message = JSON.parse(line) as JsonRpcResponse & { id?: number };
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
        reject(new Error(`timeout waiting for ${method}; stderr=${stderr.slice(-800)}`));
      }, timeoutMs);
      pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  };
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const session: BrokerSession = {
    request,
    stderr: () => stderr,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    },
  };
  sessions.push(session);
  return session;
}

async function initialize(session: BrokerSession): Promise<string> {
  const response = await session.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  return response.result?.instructions ?? '';
}

async function payload(session: BrokerSession, name: string): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name, arguments: {} });
  return response.result?.structuredContent ?? {};
}

// --- D6: the platform key ---------------------------------------------------

describe('browser_capabilities carries the host platform (2.23.1)', () => {
  it('reports process.platform on a healthy start and moves no other key', async () => {
    const dataDir = createRuntime(tempRoot('platform-healthy-'));
    const session = startBroker({ dataDir });
    await initialize(session);
    await session.request('tools/list', {});
    const caps = await payload(session, 'browser_capabilities');
    expect(caps.platform).toBe(process.platform);
    expect(typeof caps.platform).toBe('string');
    // The keys this release must not disturb are still there and still first.
    expect(caps).toMatchObject({
      engine: 'playwright',
      launch: 'launch.mjs',
      toolProfile: 'full',
      metaToolCount: 3,
    });
    // The key sits right after the launcher-side settings block.
    const keys = Object.keys(caps);
    expect(keys[keys.indexOf('launcherSettings') + 1]).toBe('platform');
    // Deliberate: the status payload is unchanged, so it carries no platform key.
    const status = await payload(session, 'browser_engine_status');
    expect(Object.hasOwn(status, 'platform')).toBe(false);
    expect(status.backendState).toBe('running');
  });

  it('reports process.platform on a meta-only start after a failed backend', async () => {
    const dataDir = createRuntime(tempRoot('platform-meta-only-'));
    const session = startBroker({ dataDir, failBackend: true });
    const instructions = await initialize(session);
    expect(instructions).toContain('Backend exited (code 1)');
    const listed = await session.request('tools/list', {});
    expect((listed.result?.tools ?? []).map((tool) => tool.name)).toEqual([
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    const caps = await payload(session, 'browser_capabilities');
    expect(caps.platform).toBe(process.platform);
    const status = await payload(session, 'browser_engine_status');
    expect(status.backendState).toBe('failed');
    expect(Object.hasOwn(status, 'platform')).toBe(false);
  });
});

// --- D5: the display-less Linux sentence ------------------------------------

describe('the display-less Linux sentence (2.23.1)', () => {
  it('is the exact actionable sentence', () => {
    expect(camoufoxLauncher.DISPLAYLESS_LINUX_SENTENCE).toBe(SENTENCE);
    expect(nativeLauncher.DISPLAYLESS_LINUX_SENTENCE).toBe(SENTENCE);
    expect(SENTENCE).toContain('No DISPLAY or WAYLAND_DISPLAY is set on this Linux machine');
    expect(SENTENCE).toContain('Set the Headless setting to true, or run under Xvfb.');
  });

  it.each([
    ['launch-camoufox.mjs', camoufoxLauncher],
    ['launch-camoufox-native.mjs', nativeLauncher],
  ])('%s returns it for linux, headed, with no display', (_name, launcher) => {
    expect(launcher.displaylessLinuxProblem({ PLAYWRIGHT_MCP_HEADLESS: 'false' }, 'linux')).toBe(SENTENCE);
    // Unset and whitespace-only count as unset, exactly like the launcher's own
    // empty-value rule.
    expect(launcher.displaylessLinuxProblem({}, 'linux')).toBe(SENTENCE);
    expect(
      launcher.displaylessLinuxProblem({ PLAYWRIGHT_MCP_HEADLESS: 'false', DISPLAY: '   ' }, 'linux'),
    ).toBe(SENTENCE);
    expect(
      launcher.displaylessLinuxProblem({ PLAYWRIGHT_MCP_HEADLESS: 'false', WAYLAND_DISPLAY: '' }, 'linux'),
    ).toBe(SENTENCE);
  });

  it.each([
    ['launch-camoufox.mjs', camoufoxLauncher],
    ['launch-camoufox-native.mjs', nativeLauncher],
  ])('%s returns nothing when a display, headless or another platform applies', (_name, launcher) => {
    // A display of either kind is enough.
    expect(
      launcher.displaylessLinuxProblem({ PLAYWRIGHT_MCP_HEADLESS: 'false', DISPLAY: ':0' }, 'linux'),
    ).toBeNull();
    expect(
      launcher.displaylessLinuxProblem(
        { PLAYWRIGHT_MCP_HEADLESS: 'false', WAYLAND_DISPLAY: 'wayland-0' },
        'linux',
      ),
    ).toBeNull();
    // Headless is the documented way out, and it is never changed for the user.
    expect(launcher.displaylessLinuxProblem({ PLAYWRIGHT_MCP_HEADLESS: 'true' }, 'linux')).toBeNull();
    // Every other platform is unchanged.
    expect(launcher.displaylessLinuxProblem({ PLAYWRIGHT_MCP_HEADLESS: 'false' }, 'win32')).toBeNull();
    expect(launcher.displaylessLinuxProblem({}, 'win32')).toBeNull();
    expect(launcher.displaylessLinuxProblem({ PLAYWRIGHT_MCP_HEADLESS: 'false' }, 'darwin')).toBeNull();
  });

  it('ships the same helper in both plugins', () => {
    for (const file of ['launch-camoufox.mjs', 'launch-camoufox-native.mjs']) {
      const canonical = readFileSync(path.join(repoRoot, 'shared', 'core', file));
      for (const name of ['cloakbrowser', 'camoufox']) {
        const copy = readFileSync(path.join(repoRoot, 'plugins', name, file));
        expect(copy.equals(canonical), `${name}/${file}`).toBe(true);
        expect(copy.toString('utf8')).toContain('export function displaylessLinuxProblem');
      }
    }
  });

  it('surfaces the sentence through lastError and backendStderrTail', async () => {
    const dataDir = createRuntime(tempRoot('platform-displayless-'));
    const session = startBroker({ dataDir, failBackend: true });
    const instructions = await initialize(session);
    // The same path a real launcher refusal takes: one stderr line, exit 1, the
    // broker names it in lastError and keeps the tail.
    expect(instructions).toContain(SENTENCE);
    const status = await payload(session, 'browser_engine_status');
    expect(String(status.lastError)).toContain(SENTENCE);
    expect(String(status.backendStderrTail)).toContain(SENTENCE);
    expect(status.backendState).toBe('failed');
  });
});
