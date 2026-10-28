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
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

// Output-directory policy (2.10.1). When `output_dir` is empty the effective
// artifact directory is `.playwright-mcp` inside the client's first usable
// `file://` root, or `<plugin data>/output/<engine>` when no file root is
// available. An explicit `output_dir` is untouched. The value must reach the
// engine in its environment, because that is the only way the cloak bridge, the
// Camoufox wrapper and the kameleo CLI all honour it, and it is resolved before
// the backend starts (the spawn is deferred to the client's initialize, whose
// roots probe the broker answers within the same handshake). Every guard here is
// mutation-checked by the PR.

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: {
    tools?: { name: string }[];
    content?: { type: string; text?: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    instructions?: string;
    serverInfo?: { name?: string };
  };
  error?: { code: number; message: string };
}

type RootsBehaviour = 'answer' | 'error' | 'silent';

interface BrokerSession {
  request: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<JsonRpcMessage>;
  notify: (method: string) => void;
  serverRequests: () => { id: unknown; method: string }[];
  sendRaw: (message: Record<string, unknown>) => void;
  stderr: () => string;
  close: () => Promise<void>;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const PROBE_ID = 'cloakbrowser-broker-roots';

const STUB_SOURCE = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const readline = require('node:readline');
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
if (process.env.STUB_ENV) {
  writeFileSync(process.env.STUB_ENV, JSON.stringify({
    PLAYWRIGHT_MCP_OUTPUT_DIR: process.env.PLAYWRIGHT_MCP_OUTPUT_DIR ?? null,
    PLAYWRIGHT_MCP_BROWSER_ENGINE: process.env.PLAYWRIGHT_MCP_BROWSER_ENGINE ?? null,
    pid: process.pid,
  }));
}
function handle(message) {
  if (process.env.STUB_LINES) appendFileSync(process.env.STUB_LINES, JSON.stringify(message) + '\\n');
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-output', version: '0.0.1' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'browser_navigate', description: 'stub', inputSchema: { type: 'object', properties: {} } }] } });
    return;
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }], isError: false } });
    return;
  }
  if (message.id !== undefined && message.method !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
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
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// The provisioned cloak runtime the launcher finds, plus the profile directories
// the launcher expects.
function createRuntime(root: string): string {
  const dataDir = path.join(root, 'data');
  const modules = path.join(dataDir, 'runtime', 'node_modules');
  for (const name of ['cloakbrowser', 'playwright-core', 'playwright']) {
    mkdirSync(path.join(modules, name), { recursive: true });
  }
  mkdirSync(path.join(modules, 'cloakbrowser-mcp', 'dist'), { recursive: true });
  writeJson(path.join(dataDir, 'runtime', '.installed.json'), {
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
  mkdirSync(path.join(dataDir, 'profiles', 'default'), { recursive: true });
  return dataDir;
}

function startBroker(options: {
  dataDir: string;
  cwd: string;
  roots?: RootsBehaviour;
  rootsDelayMs?: number;
  rootsList?: { uri: string; name?: string }[];
  outputDir?: string;
  stubLines?: string;
  stubEnv?: string;
}): BrokerSession {
  const env: Record<string, string | undefined> = {
    ...process.env,
    STEALTH_ENGINE: 'cloak',
    STEALTH_TOOL_PROFILE: 'full',
    CLAUDE_PLUGIN_DATA: options.dataDir,
    CLOAK_PLAYWRIGHT_MCP_PACKAGE: 'cloakbrowser-mcp@1.15.1',
    PLAYWRIGHT_MCP_OUTPUT_DIR: options.outputDir ?? '',
    ...(options.stubLines === undefined ? {} : { STUB_LINES: options.stubLines }),
    ...(options.stubEnv === undefined ? {} : { STUB_ENV: options.stubEnv }),
  };
  for (const name of ['STEALTH_ACCOUNT', 'STEALTH_PROFILE_ISOLATION', 'PLAYWRIGHT_MCP_USER_DATA_DIR']) {
    delete env[name];
  }
  const child = spawn(process.execPath, [path.join(pluginDir, 'broker.mjs')], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const pending = new Map<number | string, (message: JsonRpcMessage) => void>();
  const serverRequests: { id: unknown; method: string }[] = [];
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim() === '') return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    // A server->client request: the broker's roots probe. The fake client
    // answers (optionally late), refuses with -32601, or stays silent.
    if (typeof message.method === 'string' && message.id !== undefined) {
      serverRequests.push({ id: message.id, method: message.method });
      if (message.method === 'roots/list' && options.roots !== 'silent') {
        const answer =
          options.roots === 'error'
            ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
            : {
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  roots: options.rootsList ?? [{ uri: pathToFileURL(options.cwd).href, name: 'workspace' }],
                },
              };
        const write = () => {
          if (child.stdin.writable) child.stdin.write(`${JSON.stringify(answer)}\n`);
        };
        if (options.rootsDelayMs === undefined || options.rootsDelayMs <= 0) write();
        else setTimeout(write, options.rootsDelayMs);
      }
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id) as (value: JsonRpcMessage) => void;
      pending.delete(message.id);
      resolve(message);
    }
  });
  let nextId = 1;
  const write = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params?: Record<string, unknown>, timeoutMs = 12000) => {
    const id = nextId++;
    write({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}; stderr=${stderr.slice(-500)}`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  };
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
  const session: BrokerSession = {
    request,
    notify: (method) => write({ jsonrpc: '2.0', method }),
    serverRequests: () => [...serverRequests],
    sendRaw: write,
    stderr: () => stderr,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    },
  };
  sessions.push(session);
  return session;
}

function initializeParams(declareRoots: boolean): Record<string, unknown> {
  return {
    protocolVersion: '2025-06-18',
    capabilities: declareRoots ? { roots: { listChanged: true } } : {},
    clientInfo: { name: 'test', version: '1' },
  };
}

async function capabilities(session: BrokerSession): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name: 'browser_capabilities', arguments: {} });
  return response.result?.structuredContent ?? {};
}

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    // budget: 25 ms poll interval under the caller's waitForFile deadline (5 s at the call site)
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return existsSync(file);
}

async function waitForText(file: string, needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file) && readFileSync(file, 'utf8').includes(needle)) return true;
    // budget: 25 ms poll interval under the caller's waitForText deadline
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return existsSync(file) && readFileSync(file, 'utf8').includes(needle);
}

function stubEnv(file: string): { PLAYWRIGHT_MCP_OUTPUT_DIR: string | null } {
  return JSON.parse(readFileSync(file, 'utf8')) as { PLAYWRIGHT_MCP_OUTPUT_DIR: string | null };
}

describe('artifact directory policy', () => {
  it('defaults to .playwright-mcp inside the client’s first file root and gives it to the engine', async () => {
    const root = tempRoot('output-root-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    const project = path.join(root, 'project');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    const stubEnvFile = path.join(root, 'stub-env.json');
    const session = startBroker({
      dataDir,
      cwd,
      roots: 'answer',
      rootsList: [{ uri: pathToFileURL(project).href, name: 'project' }],
      stubEnv: stubEnvFile,
    });

    const initialized = await session.request('initialize', initializeParams(true));
    expect(initialized.error).toBeUndefined();
    const expected = path.join(project, '.playwright-mcp');
    expect(String(initialized.result?.instructions)).toContain(
      `Browser artifacts (screenshots, traces, downloads) go to ${expected} because the output_dir setting is ` +
        `empty and the client's first file root is ${project}; set that setting to change it.`,
    );

    const payload = await capabilities(session);
    expect(payload.outputDir).toBe(expected);

    // The engine received the same directory in its environment at spawn.
    expect(await waitForFile(stubEnvFile, 5000)).toBe(true);
    expect(stubEnv(stubEnvFile).PLAYWRIGHT_MCP_OUTPUT_DIR).toBe(expected);

    // The broker creates nothing: the engine creates the directory when it
    // first needs it.
    expect(existsSync(expected)).toBe(false);
    expect(existsSync(path.join(dataDir, 'output'))).toBe(false);
    expect(session.serverRequests().filter((entry) => entry.method === 'roots/list')).toHaveLength(1);
  });

  it('uses the first usable file root and ignores non-file or malformed roots', async () => {
    const root = tempRoot('output-first-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const first = path.join(root, 'first-project');
    const second = path.join(root, 'second-project');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const session = startBroker({
      dataDir,
      cwd,
      roots: 'answer',
      rootsList: [
        { uri: 'https://example.com/project' },
        { uri: 'not a uri' },
        { uri: 'file://%' },
        { uri: pathToFileURL(first).href },
        { uri: pathToFileURL(second).href },
      ],
    });

    await session.request('initialize', initializeParams(true));
    const payload = await capabilities(session);
    expect(payload.outputDir).toBe(path.join(first, '.playwright-mcp'));
  });

  it('converts a file URI with a drive letter and percent-encoded spaces', async () => {
    const root = tempRoot('output-uri-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const uri = 'file:///C:/Users/Some%20User/My%20Project';
    const session = startBroker({ dataDir, cwd, roots: 'answer', rootsList: [{ uri }] });

    await session.request('initialize', initializeParams(true));
    const payload = await capabilities(session);
    const expected = path.join(fileURLToPath(uri), '.playwright-mcp');
    expect(payload.outputDir).toBe(expected);
    expect(String(payload.outputDir)).toContain('Some User');
    expect(String(payload.outputDir)).toContain('My Project');
    // A Windows runner must end up with the native drive-letter form; other
    // platforms keep the same conversion fileURLToPath documents for them.
    const nativeForm =
      process.platform === 'win32' ? 'C:\\Users\\Some User\\My Project\\.playwright-mcp' : expected;
    expect(payload.outputDir).toBe(nativeForm);
  });

  it('falls back to <plugin data>/output/<engine> when every root is not a file root', async () => {
    const root = tempRoot('output-nofile-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const stubEnvFile = path.join(root, 'stub-env.json');
    const session = startBroker({
      dataDir,
      cwd,
      roots: 'answer',
      rootsList: [{ uri: 'https://example.com/project' }],
      stubEnv: stubEnvFile,
    });

    const initialized = await session.request('initialize', initializeParams(true));
    const expected = path.join(dataDir, 'output', 'cloak');
    expect(String(initialized.result?.instructions)).toContain(
      `Browser artifacts (screenshots, traces, downloads) go to ${expected} because the output_dir setting is ` +
        'empty and no file root was available from the client; set that setting to change it.',
    );
    expect((await capabilities(session)).outputDir).toBe(expected);
    expect(await waitForFile(stubEnvFile, 5000)).toBe(true);
    expect(stubEnv(stubEnvFile).PLAYWRIGHT_MCP_OUTPUT_DIR).toBe(expected);
    expect(existsSync(expected)).toBe(false);
  });

  it('falls back when the client declares no roots, without sending a probe', async () => {
    const root = tempRoot('output-declared-none-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const stubEnvFile = path.join(root, 'stub-env.json');
    const session = startBroker({ dataDir, cwd, roots: 'answer', stubEnv: stubEnvFile });

    await session.request('initialize', initializeParams(false));
    expect(session.serverRequests().filter((entry) => entry.method === 'roots/list')).toHaveLength(0);
    const payload = await capabilities(session);
    expect(payload.clientRoots).toBeNull();
    expect(payload.clientRootsError).toBe('the client did not advertise the roots capability');
    expect(payload.outputDir).toBe(path.join(dataDir, 'output', 'cloak'));
    expect(await waitForFile(stubEnvFile, 5000)).toBe(true);
    expect(stubEnv(stubEnvFile).PLAYWRIGHT_MCP_OUTPUT_DIR).toBe(path.join(dataDir, 'output', 'cloak'));
  });

  it('falls back when the client refuses the roots request, and reports why', async () => {
    const root = tempRoot('output-refused-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const session = startBroker({ dataDir, cwd, roots: 'error' });

    await session.request('initialize', initializeParams(true));
    const payload = await capabilities(session);
    expect(payload.clientRoots).toBeNull();
    expect(payload.clientRootsError).toBe('-32601: Method not found');
    expect(payload.outputDir).toBe(path.join(dataDir, 'output', 'cloak'));
  });

  it('bounds a silent client at about 2 s and still starts the engine with the fallback', async () => {
    const root = tempRoot('output-silent-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const stubEnvFile = path.join(root, 'stub-env.json');
    const stubLines = path.join(root, 'stub-lines.log');
    const session = startBroker({ dataDir, cwd, roots: 'silent', stubEnv: stubEnvFile, stubLines });

    const startedAt = Date.now();
    const initialized = await session.request('initialize', initializeParams(true));
    const elapsed = Date.now() - startedAt;
    expect(initialized.error).toBeUndefined();
    // budget: the broker's silent-client bound is 2 s, so 1.9 s is the least that proves it waited for the probe
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    // budget: upper half of the same band; 8 s is the loosest bound the 15 s test timeout allows
    expect(elapsed).toBeLessThan(8000);
    expect(session.serverRequests().filter((entry) => entry.method === 'roots/list')).toHaveLength(1);

    const payload = await capabilities(session);
    expect(payload.clientRoots).toBeNull();
    expect(payload.clientRootsError).toBe('no answer within 2000 ms');
    expect(payload.outputDir).toBe(path.join(dataDir, 'output', 'cloak'));
    expect(await waitForFile(stubEnvFile, 5000)).toBe(true);
    expect(stubEnv(stubEnvFile).PLAYWRIGHT_MCP_OUTPUT_DIR).toBe(path.join(dataDir, 'output', 'cloak'));

    // A late answer is neither cached nor relayed to the engine.
    session.sendRaw({ jsonrpc: '2.0', id: PROBE_ID, result: { roots: [{ uri: pathToFileURL(cwd).href }] } });
    // budget: 300 ms gives the broker time to receive and drop the late probe answer; the product's bound is 2 s
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readFileSync(stubLines, 'utf8')).not.toContain(PROBE_ID);
    expect((await capabilities(session)).outputDir).toBe(path.join(dataDir, 'output', 'cloak'));
  }, 30_000);

  it('replays every buffered client line in order, even when the roots answer is late', async () => {
    const root = tempRoot('output-replay-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    const project = path.join(root, 'project');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    const stubLines = path.join(root, 'stub-lines.log');
    const session = startBroker({
      dataDir,
      cwd,
      roots: 'answer',
      rootsDelayMs: 400,
      rootsList: [{ uri: pathToFileURL(project).href }],
      stubLines,
    });

    // initialize, the initialized notification and tools/list are written
    // back-to-back while the broker is still waiting for the roots answer. The
    // ids are strings so they cannot collide with the harness's own counter.
    session.sendRaw({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: initializeParams(true) });
    session.notify('notifications/initialized');
    session.sendRaw({ jsonrpc: '2.0', id: 'list-1', method: 'tools/list', params: {} });

    await waitForText(stubLines, 'tools/list', 8000);
    const lines = readFileSync(stubLines, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { method?: string });
    expect(lines.map((entry) => entry.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);

    // The engine that received them is the one started with the resolved value.
    expect((await capabilities(session)).outputDir).toBe(path.join(project, '.playwright-mcp'));
  });

  it('keeps the roots default when the 2026-era discover probe arrives first, as a real client sends it', async () => {
    const root = tempRoot('output-discover-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    const project = path.join(root, 'project');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    const stubLines = path.join(root, 'stub-lines.log');
    const session = startBroker({
      dataDir,
      cwd,
      roots: 'answer',
      rootsDelayMs: 300,
      rootsList: [{ uri: pathToFileURL(project).href }],
      stubLines,
    });

    // Claude Code 2.1.310 sends server/discover immediately before initialize.
    // It must not force the plugin-data fallback.
    session.sendRaw({ jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {} });
    session.sendRaw({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: initializeParams(true) });

    await waitForText(stubLines, 'initialize', 8000);
    const methods = readFileSync(stubLines, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as { method?: string }).method);
    expect(methods).toEqual(['server/discover', 'initialize']);
    expect((await capabilities(session)).outputDir).toBe(path.join(project, '.playwright-mcp'));
  });

  it('starts the engine at process start and passes an explicit output_dir through unchanged', async () => {
    const root = tempRoot('output-setting-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const stubEnvFile = path.join(root, 'stub-env.json');
    const session = startBroker({
      dataDir,
      cwd,
      roots: 'answer',
      outputDir: 'artifacts-out',
      stubEnv: stubEnvFile,
    });

    // Nothing is deferred and no probe is sent: the engine is already running
    // before the client has initialized, exactly as in 2.10.0.
    expect(await waitForFile(stubEnvFile, 8000)).toBe(true);
    expect(session.serverRequests().filter((entry) => entry.method === 'roots/list')).toHaveLength(0);
    expect(stubEnv(stubEnvFile).PLAYWRIGHT_MCP_OUTPUT_DIR).toBe('artifacts-out');

    const initialized = await session.request('initialize', initializeParams(true));
    expect(String(initialized.result?.instructions)).toContain(path.join(cwd, 'artifacts-out'));
    expect(String(initialized.result?.instructions)).toContain('while it is empty they default to');
    const payload = await capabilities(session);
    expect(payload.outputDir).toBe(path.join(cwd, 'artifacts-out'));
    // The probe was not needed for the directory, but browser_capabilities still
    // reports the client's roots through the existing diagnostic probe.
    expect(session.serverRequests().filter((entry) => entry.method === 'roots/list')).toHaveLength(1);
  });

  it('passes an absolute output_dir through unchanged, resolved like the bridge does', async () => {
    const root = tempRoot('output-absolute-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const absoluteDir = path.join(root, 'absolute-artifacts');
    const stubEnvFile = path.join(root, 'stub-env.json');
    const session = startBroker({
      dataDir,
      cwd,
      roots: 'answer',
      rootsList: [{ uri: pathToFileURL(cwd).href }],
      outputDir: absoluteDir,
      stubEnv: stubEnvFile,
    });

    await session.request('initialize', initializeParams(true));
    expect(await waitForFile(stubEnvFile, 5000)).toBe(true);
    expect(stubEnv(stubEnvFile).PLAYWRIGHT_MCP_OUTPUT_DIR).toBe(absoluteDir);
    expect((await capabilities(session)).outputDir).toBe(absoluteDir);
    expect(existsSync(absoluteDir)).toBe(false);
  });
});
