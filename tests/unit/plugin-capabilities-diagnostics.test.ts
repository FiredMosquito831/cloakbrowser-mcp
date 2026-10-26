import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

// Capabilities diagnostics (2.9.5, updated for the 2.10.1 output-directory
// policy). browser_capabilities must report the server cwd, the effective
// artifact directory and the MCP roots the client advertised, because upstream's
// file-access allowlist is [output directory, workspace root] and through the
// Cloak bridge the client's roots never reach the backend. The roots probe is one
// server->client roots/list request with a 2 s bound, cached for the session.
// Since 2.10.1 the empty output_dir default depends on those roots, so the probe
// is sent on the client's initialize request, before the backend starts, rather
// than lazily on the first browser_capabilities call; a client that declares no
// roots is still never asked. Each guard is mutation-checked by the PR.

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
    serverInfo?: { name?: string; version?: string };
    roots?: unknown;
  };
  error?: { code: number; message: string };
}

type RootsBehaviour = 'answer' | 'error' | 'silent';

interface BrokerSession {
  request: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<JsonRpcMessage>;
  serverRequests: () => { id: unknown; method: string }[];
  sendRaw: (message: Record<string, unknown>) => void;
  stderr: () => string;
  close: () => Promise<void>;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const ROOTS = [
  { uri: 'file:///D:/Projects2/StealthBrowserAutomation', name: 'StealthBrowserAutomation' },
  { uri: 'file:///C:/Users/example' },
];
// The root id the broker sends; the client echoes it in its answer.
const PROBE_ID = 'cloakbrowser-broker-roots';
const fixture = JSON.parse(
  readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'capabilities-2.9.4.json'), 'utf8'),
) as Record<string, unknown>;

// Deterministic stand-in for the cloakbrowser-mcp CLI. It answers initialize and
// tools/list, and appends every line it receives to STUB_LINES so a test can
// prove the broker never relays the client's roots answer to the backend.
const STUB_SOURCE = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const readline = require('node:readline');
const TOOLS = __TOOLS__;
const INSTRUCTIONS = __INSTRUCTIONS__;
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (process.env.STUB_LINES) appendFileSync(process.env.STUB_LINES, JSON.stringify(message) + '\\n');
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-capabilities', version: '0.0.1' }, ...(INSTRUCTIONS === null ? {} : { instructions: INSTRUCTIONS }) } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} } })) } });
    return;
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }], isError: false } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: {} });
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => { if (line.trim() !== '') { try { handle(JSON.parse(line)); } catch {} } });
rl.on('close', () => process.exit(0));
`;

const STUB_TOOLS = ['browser_navigate', 'browser_snapshot', 'browser_evaluate'];

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
  // macOS tmpdir is a symlink (/var -> /private/var) and the broker reports its
  // physical cwd, so the fixture path must be physical too.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function stubSource(instructions: string | null = null): string {
  return STUB_SOURCE.replace('__TOOLS__', JSON.stringify(STUB_TOOLS)).replace(
    '__INSTRUCTIONS__',
    JSON.stringify(instructions),
  );
}

// The provisioned cloak runtime the launcher finds, plus the profile directories
// the equality baseline was captured with.
function createRuntime(root: string, instructions: string | null = null): string {
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
  writeFileSync(path.join(modules, 'cloakbrowser-mcp', 'dist', 'cli.js'), stubSource(instructions));
  mkdirSync(path.join(dataDir, 'profiles', 'default'), { recursive: true });
  mkdirSync(path.join(dataDir, 'profiles', 'cloak', 'alice'), { recursive: true });
  return dataDir;
}

// A synthetic plugin whose manifest declares that it does not read output_dir,
// so the general manifest rule can be proven without launching a real engine.
function createPlainPlugin(root: string): string {
  const plugin = path.join(root, 'plugin');
  mkdirSync(path.join(plugin, 'engines'), { recursive: true });
  mkdirSync(path.join(plugin, 'lib'), { recursive: true });
  cpSync(path.join(pluginDir, 'broker.mjs'), path.join(plugin, 'broker.mjs'));
  cpSync(path.join(pluginDir, 'engine-registry.mjs'), path.join(plugin, 'engine-registry.mjs'));
  cpSync(path.join(pluginDir, 'lib'), path.join(plugin, 'lib'), { recursive: true });
  cpSync(path.join(pluginDir, 'engines', 'profiles.json'), path.join(plugin, 'engines', 'profiles.json'));
  writeJson(path.join(plugin, 'engines', 'plain-engine.json'), {
    schemaVersion: 1,
    id: 'plain-engine',
    label: 'Plain test engine',
    transport: 'launch',
    contract: 'playwright-mcp',
    defaultToolProfile: 'full',
    launch: { launcher: 'launch-plain.mjs' },
    ignoredSettings: ['output_dir'],
    profileApplies: false,
    toolSupport: { '*': 'full' },
    notes: 'Synthetic manifest that ignores output_dir.',
  });
  writeFileSync(path.join(plugin, 'launch-plain.mjs'), stubSource());
  return plugin;
}

function startBroker(options: {
  dataDir: string;
  cwd: string;
  roots?: RootsBehaviour;
  outputDir?: string;
  engine?: string;
  plugin?: string;
  stubLines?: string;
}): BrokerSession {
  const env: Record<string, string | undefined> = {
    ...process.env,
    STEALTH_ENGINE: options.engine ?? 'cloak',
    STEALTH_TOOL_PROFILE: 'full',
    CLAUDE_PLUGIN_DATA: options.dataDir,
    CLOAK_PLAYWRIGHT_MCP_PACKAGE: 'cloakbrowser-mcp@1.15.1',
    PLAYWRIGHT_MCP_OUTPUT_DIR: options.outputDir ?? '',
    ...(options.stubLines === undefined ? {} : { STUB_LINES: options.stubLines }),
  };
  for (const name of ['STEALTH_ACCOUNT', 'STEALTH_PROFILE_ISOLATION', 'PLAYWRIGHT_MCP_USER_DATA_DIR']) {
    delete env[name];
  }
  const child = spawn(process.execPath, [path.join(options.plugin ?? pluginDir, 'broker.mjs')], {
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
    // A server->client request: the broker's lazy roots probe. The fake client
    // answers, refuses with -32601, or stays silent.
    if (typeof message.method === 'string' && message.id !== undefined) {
      serverRequests.push({ id: message.id, method: message.method });
      if (message.method === 'roots/list' && options.roots !== 'silent') {
        child.stdin.write(
          `${JSON.stringify(
            options.roots === 'error'
              ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
              : { jsonrpc: '2.0', id: message.id, result: { roots: ROOTS } },
          )}\n`,
        );
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
  const request = (method: string, params?: Record<string, unknown>, timeoutMs = 8000) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
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
    request: (method, params, timeoutMs) => request(method, params, timeoutMs),
    serverRequests: () => [...serverRequests],
    sendRaw: (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
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

async function initialize(session: BrokerSession, declareRoots: boolean): Promise<JsonRpcMessage> {
  return session.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: declareRoots ? { roots: { listChanged: true } } : {},
    clientInfo: { name: 'test', version: '1' },
  });
}

async function capabilities(session: BrokerSession): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name: 'browser_capabilities', arguments: {} });
  return response.result?.structuredContent ?? {};
}

// Every absolute path a payload carries is replaced by <ROOT> before it is
// compared with the captured 2.9.4 baseline.
function normalize(value: unknown, root: string): unknown {
  if (typeof value === 'string') {
    const escaped = JSON.stringify(root).slice(1, -1);
    return value.split(escaped).join('<ROOT>').split(root).join('<ROOT>');
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalize(entry, root));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry, root)]));
  }
  return value;
}

// The baseline was captured on Windows. Two facts are platform-dependent and are
// compared set-wise instead: path separators, and engineChoices, which follows
// directory discovery order. Both sides get the same treatment.
function comparable(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.split('\\').join('/');
  }
  if (Array.isArray(value)) {
    return value.map((entry) => comparable(entry));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, comparable(entry)]));
  }
  return value;
}

describe('browser_capabilities artifact diagnostics', () => {
  it('reports serverCwd, the client-root outputDir and the roots the client answered', async () => {
    const root = tempRoot('capabilities-roots-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const session = startBroker({ dataDir, cwd, roots: 'answer' });

    const initialized = await initialize(session, true);
    expect(initialized.result?.serverInfo?.name).toBe('stub-capabilities');
    // 2.10.1: with output_dir empty the first usable file root hosts the
    // artifacts directory, and the sentence says which default was applied.
    const firstRoot = fileURLToPath(new URL(ROOTS[0].uri));
    const expectedDir = path.join(firstRoot, '.playwright-mcp');
    const sentence = `Browser artifacts (screenshots, traces, downloads) go to ${expectedDir}`;
    expect(String(initialized.result?.instructions)).toContain(sentence);
    expect(String(initialized.result?.instructions)).toContain(
      `the client's first file root is ${firstRoot}; set that setting to change it.`,
    );

    const payload = await capabilities(session);
    expect(payload.serverCwd).toBe(cwd);
    expect(payload.outputDir).toBe(expectedDir);
    expect(payload.clientRoots).toEqual(ROOTS);
    expect(Object.hasOwn(payload, 'clientRootsError')).toBe(false);
    expect(session.serverRequests().filter((request) => request.method === 'roots/list')).toHaveLength(1);
    expect(session.serverRequests()[0]?.id).toBe(PROBE_ID);

    // The probe changes no tool filtering: the surface is still the three stub
    // tools plus the three meta-tools, and a tool call still works.
    const list = await session.request('tools/list', {});
    expect(list.result?.tools?.map((tool) => tool.name)).toEqual([
      ...STUB_TOOLS,
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    const call = await session.request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: 'data:text/html,ok' },
    });
    expect(call.result?.isError).toBe(false);
  });

  it('reports the output_dir setting, resolved against the server cwd', async () => {
    const root = tempRoot('capabilities-output-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });

    const relative = startBroker({ dataDir, cwd, roots: 'silent', outputDir: 'artifacts-out' });
    const relativeInitialize = await initialize(relative, false);
    expect(String(relativeInitialize.result?.instructions)).toContain(path.join(cwd, 'artifacts-out'));
    expect(String(relativeInitialize.result?.instructions)).toContain('while it is empty');
    const relativePayload = await capabilities(relative);
    expect(relativePayload.outputDir).toBe(path.join(cwd, 'artifacts-out'));

    const absoluteDir = path.join(root, 'absolute-artifacts');
    const absolute = startBroker({ dataDir, cwd, roots: 'silent', outputDir: absoluteDir });
    await initialize(absolute, false);
    expect((await capabilities(absolute)).outputDir).toBe(absoluteDir);
    expect((await capabilities(absolute)).serverCwd).toBe(cwd);
  });

  it('answers at once with the reason when the client did not advertise roots, without a probe', async () => {
    const root = tempRoot('capabilities-noroots-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const session = startBroker({ dataDir, cwd, roots: 'silent' });
    await initialize(session, false);

    const startedAt = Date.now();
    const payload = await capabilities(session);
    const elapsed = Date.now() - startedAt;
    expect(payload.clientRoots).toBeNull();
    expect(payload.clientRootsError).toBe('the client did not advertise the roots capability');
    expect(payload.outputDir).toBe(path.join(dataDir, 'output', 'cloak'));
    expect(session.serverRequests().filter((request) => request.method === 'roots/list')).toHaveLength(0);
    expect(elapsed).toBeLessThan(1000);
  });

  it('reports a -32601 refusal as a short reason', async () => {
    const root = tempRoot('capabilities-refusal-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const session = startBroker({ dataDir, cwd, roots: 'error' });
    await initialize(session, true);

    const payload = await capabilities(session);
    expect(payload.clientRoots).toBeNull();
    expect(payload.clientRootsError).toBe('-32601: Method not found');
    expect(payload.outputDir).toBe(path.join(dataDir, 'output', 'cloak'));
    expect(session.stderr()).toContain('client roots unavailable: -32601: Method not found');
  });

  it('bounds a silent client at about 2 s and falls back to the plugin-data directory', async () => {
    const root = tempRoot('capabilities-silent-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const stubLines = path.join(root, 'stub-lines.log');
    const session = startBroker({ dataDir, cwd, roots: 'silent', stubLines });

    // 2.10.1: the empty output_dir default needs the roots, so the probe is sent
    // on the initialize request and the handshake waits for its bound.
    const initializeStartedAt = Date.now();
    const initialized = await initialize(session, true);
    const initializeMs = Date.now() - initializeStartedAt;
    expect(initialized.error).toBeUndefined();
    expect(initializeMs).toBeGreaterThanOrEqual(1900);
    expect(initializeMs).toBeLessThan(8000);
    expect(session.serverRequests().filter((request) => request.method === 'roots/list')).toHaveLength(1);

    const listStartedAt = Date.now();
    await session.request('tools/list', {});
    const listMs = Date.now() - listStartedAt;

    // The probe is cached, so the capabilities call does not wait again.
    const startedAt = Date.now();
    const payload = await capabilities(session);
    const elapsed = Date.now() - startedAt;
    expect(payload.clientRoots).toBeNull();
    expect(payload.clientRootsError).toBe('no answer within 2000 ms');
    expect(payload.outputDir).toBe(path.join(dataDir, 'output', 'cloak'));
    expect(elapsed).toBeLessThan(1000);
    expect(listMs).toBeLessThan(8000);

    // After the bound, the session is still healthy: tools/list and a tool call
    // are as fast as before, and a late probe answer is neither cached nor
    // relayed to the backend (only the initialize, tools/list and tool call
    // lines the client itself sent can be in the stub log).
    const laterListStartedAt = Date.now();
    await session.request('tools/list', {});
    expect(Date.now() - laterListStartedAt).toBeLessThan(8000);
    const call = await session.request('tools/call', {
      name: 'browser_snapshot',
      arguments: {},
    });
    expect(call.result?.isError).toBe(false);

    session.sendRaw({ jsonrpc: '2.0', id: PROBE_ID, result: { roots: ROOTS } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const relayed = readFileSync(stubLines, 'utf8');
    expect(relayed).not.toContain(PROBE_ID);
    expect((await capabilities(session)).clientRoots).toBeNull();
    expect((await capabilities(session)).outputDir).toBe(path.join(dataDir, 'output', 'cloak'));
  });

  it('caches the probe for the session', async () => {
    const root = tempRoot('capabilities-cache-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const session = startBroker({ dataDir, cwd, roots: 'answer' });
    await initialize(session, true);

    const firstRoot = fileURLToPath(new URL(ROOTS[0].uri));
    expect((await capabilities(session)).clientRoots).toEqual(ROOTS);
    const startedAt = Date.now();
    expect((await capabilities(session)).clientRoots).toEqual(ROOTS);
    expect((await capabilities(session)).outputDir).toBe(path.join(firstRoot, '.playwright-mcp'));
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(session.serverRequests().filter((request) => request.method === 'roots/list')).toHaveLength(1);
  });

  it('keeps every pre-existing capability key and value unchanged', async () => {
    const root = tempRoot('capabilities-equality-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const session = startBroker({ dataDir, cwd, roots: 'silent' });
    await initialize(session, false);
    await session.request('tools/list', {});
    const actual = normalize(await capabilities(session), root) as Record<string, unknown>;

    // 2.10.0 appends the default-profile pointer facts after the artifact keys.
    // 2.10.1 changes only the *value* of outputDir when output_dir is empty, so
    // that key is compared separately below against the new policy. 2.11.1 adds
    // the additive `engineProfileLock` key right after `profileLock` for the
    // Chromium engines, which now declare their own lock file.
    const newKeys = [
      'serverCwd',
      'outputDir',
      'clientRoots',
      'clientRootsError',
      'profileDefault',
      'profileDefaultSource',
      'profileDefaultPath',
    ];
    const expectedKeys = [...Object.keys(fixture)];
    expectedKeys.splice(expectedKeys.indexOf('profileLock') + 1, 0, 'engineProfileLock');
    expect(Object.keys(actual)).toEqual([...expectedKeys, ...newKeys]);
    const payload = comparable(actual) as Record<string, unknown>;
    const baseline = comparable(fixture) as Record<string, unknown>;
    for (const record of [payload, baseline]) {
      record.engineChoices = [...(record.engineChoices as string[])].sort();
    }
    // 2.10.0 adds one broker meta-tool. The three baseline values that count the
    // surface change with it, so they are asserted exactly against the 2.9.4
    // values instead of compared blindly. outputDir changed value in 2.10.1 for
    // the empty setting, and is asserted exactly under the new policy.
    const metaCountKeys = ['metaToolCount', 'metaTools', 'exposedToolCount', 'outputDir'];
    for (const [key, value] of Object.entries(baseline)) {
      if (metaCountKeys.includes(key)) {
        continue;
      }
      expect(payload[key], `capability "${key}" changed`).toEqual(value);
    }
    expect(payload.metaToolCount).toBe(3);
    expect(payload.metaTools).toEqual(['browser_capabilities', 'browser_engine_status', 'browser_profiles']);
    expect(payload.exposedToolCount).toBe((baseline.exposedToolCount as number) + 1);
    expect(payload.serverCwd).toBe('<ROOT>/cwd');
    // A client that declared no roots: the plugin-data fallback, engine-scoped.
    expect(payload.outputDir).toBe('<ROOT>/data/output/cloak');
    expect(payload.profileDefault).toBeNull();
    expect(payload.profileDefaultSource).toBe('none');
    expect(payload.profileDefaultPath).toBe('<ROOT>/data/profiles/cloak/.default');
    expect(payload.engineProfileLock).toMatchObject({
      state: 'free',
      file: 'lockfile',
      liveness: 'exclusive-open-write',
    });
  });

  it('reports no artifact directory for an engine that ignores output_dir', async () => {
    const root = tempRoot('capabilities-plain-');
    const plugin = createPlainPlugin(root);
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const session = startBroker({
      dataDir,
      cwd,
      roots: 'silent',
      engine: 'plain-engine',
      plugin,
      outputDir: path.join(root, 'ignored-artifacts'),
    });
    const initialized = await initialize(session, false);
    expect(String(initialized.result?.instructions)).toContain(
      "This engine manages its own artifact files, so the plugin's output_dir setting does not apply to it.",
    );
    const payload = await capabilities(session);
    expect(payload.outputDir).toBeNull();
    expect(payload.serverCwd).toBe(cwd);
    expect(payload.clientRoots).toBeNull();
  });

  it('writes the artifact sentence as the whole instructions when the backend sends none', async () => {
    const root = tempRoot('capabilities-instructions-');
    const dataDir = createRuntime(root);
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const session = startBroker({ dataDir, cwd, roots: 'silent' });
    const initialized = await initialize(session, false);
    // Declared no roots, so no probe and no wait: the plugin-data default.
    expect(String(initialized.result?.instructions)).toBe(
      `Browser artifacts (screenshots, traces, downloads) go to ${path.join(dataDir, 'output', 'cloak')} because ` +
        'the output_dir setting is empty and no file root was available from the client; set that setting to change it.',
    );
  });

  it('appends the artifact sentence after the instructions the backend sent', async () => {
    const root = tempRoot('capabilities-instructions-append-');
    const dataDir = createRuntime(root, 'Backend instructions stay first.');
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const session = startBroker({ dataDir, cwd, roots: 'silent' });
    const initialized = await initialize(session, false);
    expect(String(initialized.result?.instructions)).toBe(
      `Backend instructions stay first. Browser artifacts (screenshots, traces, downloads) go to ${path.join(
        dataDir,
        'output',
        'cloak',
      )} because the output_dir setting is empty and no file root was available from the client; set that setting to change it.`,
    );
  });
});
