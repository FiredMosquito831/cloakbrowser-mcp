import {
  copyFileSync,
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

// The multi-session on_locked policy (2.16.0). One setting, three values:
//   block     the 2.15 behaviour: a busy profile stops the spawn, meta-only.
//   fallback  (default) the first free numbered sibling of a plugin-managed
//             profile, reported everywhere.
//   isolated  no profile at all, reported everywhere.
// An explicit profile_dir keeps the block behaviour under every policy, and an
// engine whose manifest declares profileApplies:false never sees the setting.
//
// Every broker below is the real plugins/cloakbrowser broker with its real core
// modules; only the engine entry point is a deterministic stdio stub, so no
// browser is launched and nothing is downloaded.

interface OnLockedResolution {
  mode: string;
  source: string;
  ignored: string | null;
  placeholder: string | null;
}

interface ProfileLock {
  profileDir: string;
  path: string;
  state: 'free' | 'live' | 'stale' | 'invalid';
  owner: { pid: number; createdAt: string | null } | null;
  error: string | null;
  fix?: string | null;
}

interface ProfileModule {
  DEFAULT_ON_LOCKED: string;
  ON_LOCKED_VALUES: string[];
  ON_LOCKED_BLOCK: string;
  ON_LOCKED_FALLBACK: string;
  ON_LOCKED_ISOLATED: string;
  PROFILE_FALLBACK_FIRST_SUFFIX: number;
  PROFILE_FALLBACK_LAST_SUFFIX: number;
  PROFILE_LOCK_FILENAME: string;
  resolveOnLocked(value: string): OnLockedResolution;
  readProfileLock(profileDir: string): ProfileLock;
  profileLockMessage(
    lock: ProfileLock,
    options?: { fallbackExhausted?: boolean; fallbackKind?: string },
  ): string;
  profileFallbackReason(lock: ProfileLock, toDir: string, kind?: string): string;
  profileOnLockedIsolatedReason(lock: ProfileLock): string;
  PROFILE_ON_LOCKED_ISOLATED_NOTE: string;
  selectFallbackProfile(baseDir: string, isBlocked: (candidate: string) => boolean): string | null;
}

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
  stderr: () => string;
  close: () => Promise<void>;
}

interface BrokerOptions {
  dataDir: string;
  cwd?: string;
  isolation?: string;
  onLocked?: string;
  account?: string;
  profileDir?: string;
  proxyServer?: string;
  engine?: string;
  pluginDir?: string;
  failBackend?: boolean;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const brokerPath = path.join(pluginDir, 'broker.mjs');
const profile = (await import(
  new URL('../../plugins/cloakbrowser/lib/profile.mjs', import.meta.url).href
)) as unknown as ProfileModule;

const LOCK = '.cloakbrowser-mcp-profile.lock';
const STUB_TOOLS = ['browser_navigate', 'browser_snapshot'];
const META_TOOLS = ['browser_capabilities', 'browser_engine_status', 'browser_profiles'];

// The stand-in backend reports what it was actually started with, so a test can
// prove which profile directory (or isolated start) reached the engine.
const STUB_SOURCE = `#!/usr/bin/env node
const readline = require('node:readline');
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
if (process.env.STUB_FAIL === '1') {
  process.stderr.write('fatal: stub backend exploded\\n');
  process.exit(1);
}
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-on-locked', version: '0.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} } })) } });
    return;
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ profileDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? null, isolated: process.env.PLAYWRIGHT_MCP_ISOLATED ?? null, proxy: process.env.PLAYWRIGHT_MCP_PROXY_SERVER ?? null }) }], isError: false } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: {} });
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => { if (line.trim() === '') return; try { handle(JSON.parse(line)); } catch {} });
rl.on('close', () => process.exit(0));
`;

const ESM_STUB_SOURCE = `#!/usr/bin/env node
import readline from 'node:readline';
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-attach', version: '0.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} } })) } });
    return;
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ profileDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? null, isolated: null, proxy: null }) }], isError: false } });
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
  // Canonicalize the fixture path: macOS TMPDIR is under /var, a symlink to
  // /private/var, while the broker child's process.cwd() reports the physical
  // path, and the workspace profile name is derived from the exact cwd string.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeLock(profileDir: string, pid: number, createdAt = '2026-10-27T09:00:00.000Z'): string {
  mkdirSync(profileDir, { recursive: true });
  const file = path.join(profileDir, LOCK);
  writeFileSync(file, `${JSON.stringify({ pid, createdAt, userDataDir: profileDir }, null, 2)}\n`);
  return file;
}

// A pid that certainly names no live process: 2^31-1 is above the Windows pid
// range and impossible on Linux/macOS, so a "stale" fixture cannot flake.
const DEAD_PID = 2 ** 31 - 1;

function createRuntime(dataDir: string, engine = 'cloak'): string {
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
  mkdirSync(path.join(dataDir, 'profiles', engine), { recursive: true });
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
    'PLAYWRIGHT_MCP_PROXY_SERVER',
    'STUB_FAIL',
  ]) {
    delete childEnv[name];
  }
  if (options.account !== undefined) childEnv.STEALTH_ACCOUNT = options.account;
  if (options.isolation !== undefined) childEnv.STEALTH_PROFILE_ISOLATION = options.isolation;
  if (options.onLocked !== undefined) childEnv.STEALTH_ON_LOCKED = options.onLocked;
  if (options.profileDir !== undefined) childEnv.PLAYWRIGHT_MCP_USER_DATA_DIR = options.profileDir;
  if (options.proxyServer !== undefined) childEnv.PLAYWRIGHT_MCP_PROXY_SERVER = options.proxyServer;
  if (options.failBackend === true) childEnv.STUB_FAIL = '1';
  const broker = options.pluginDir === undefined ? brokerPath : path.join(options.pluginDir, 'broker.mjs');
  const child = spawn(process.execPath, [broker], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
    cwd: options.cwd,
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
  const session: BrokerSession = { request, stderr: () => stderr, close };
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
  const response = await session.request('tools/call', {
    name: 'browser_capabilities',
    arguments: {},
  });
  return response.result?.structuredContent ?? {};
}

async function status(session: BrokerSession): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', {
    name: 'browser_engine_status',
    arguments: {},
  });
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

async function effectiveEnvironment(
  session: BrokerSession,
): Promise<{ profileDir: string | null; isolated: string | null; proxy: string | null }> {
  const response = await session.request('tools/call', {
    name: 'browser_navigate',
    arguments: { url: 'http://127.0.0.1:9/' },
  });
  const text = response.result?.content?.[0]?.text ?? '{}';
  return JSON.parse(text) as { profileDir: string | null; isolated: string | null; proxy: string | null };
}

// A plugin tree with one extra synthetic engine: `lock-engine` declares a
// pid-rule engine lock (the same code path as Camoufox's parent.lock), and
// `attach-test` declares profileApplies: false. Both prove the policy is
// manifest-driven and has no engine-id branch in the broker.
function createScratchPlugin(root: string): string {
  const plugin = path.join(root, 'plugin');
  const engines = path.join(plugin, 'engines');
  const lib = path.join(plugin, 'lib');
  mkdirSync(engines, { recursive: true });
  mkdirSync(lib, { recursive: true });
  for (const file of ['broker.mjs', 'engine-registry.mjs']) {
    copyFileSync(path.join(pluginDir, file), path.join(plugin, file));
  }
  for (const file of [
    'attach.mjs',
    'password-manager.mjs',
    'ping-timeout.mjs',
    'profile.mjs',
    'provision.mjs',
    'surface.mjs',
  ]) {
    copyFileSync(path.join(pluginDir, 'lib', file), path.join(lib, file));
  }
  copyFileSync(path.join(pluginDir, 'engines', 'profiles.json'), path.join(engines, 'profiles.json'));
  writeJson(path.join(engines, 'lock-engine.json'), {
    schemaVersion: 1,
    id: 'lock-engine',
    label: 'Lock engine',
    transport: 'launch',
    contract: 'playwright-mcp',
    defaultToolProfile: 'full',
    launch: { launcher: 'launch-lock-engine.mjs' },
    profileLock: { file: 'owner.lock', owner: 'pid' },
    toolSupport: { '*': 'full' },
    notes: 'Synthetic engine for the on_locked suite.',
  });
  writeJson(path.join(engines, 'attach-test.json'), {
    schemaVersion: 1,
    id: 'attach-test',
    label: 'Attach test engine',
    transport: 'launch',
    contract: 'playwright-mcp',
    defaultToolProfile: 'full',
    launch: { launcher: 'launch-attach-test.mjs' },
    profileApplies: false,
    toolSupport: { '*': 'full' },
    notes: 'Synthetic engine with its own profile for the on_locked suite.',
  });
  writeFileSync(path.join(plugin, 'launch-lock-engine.mjs'), ESM_STUB_SOURCE);
  writeFileSync(path.join(plugin, 'launch-attach-test.mjs'), ESM_STUB_SOURCE);
  return plugin;
}

// A copy-keep-capable base: enough profile state that a copy is meaningful.
function seedBase(baseDir: string): void {
  mkdirSync(path.join(baseDir, 'Default'), { recursive: true });
  writeFileSync(path.join(baseDir, 'Local State'), '{}');
  writeFileSync(path.join(baseDir, '.cloakbrowser-seed'), '12345\n');
  writeFileSync(path.join(baseDir, 'Default', 'Cookies'), 'cookie-bytes');
}

describe('on_locked setting values', () => {
  it('defaults to fallback for unset, empty, placeholder and unknown values', () => {
    for (const value of ['', '   ', undefined as unknown as string]) {
      expect(profile.resolveOnLocked(value)).toMatchObject({ mode: 'fallback', source: 'default' });
    }
    const placeholder = profile.resolveOnLocked('${user_config.on_locked}');
    expect(placeholder).toMatchObject({ mode: 'fallback', source: 'default' });
    expect(placeholder.placeholder).not.toBeNull();
    const unknown = profile.resolveOnLocked('per-window');
    expect(unknown).toMatchObject({ mode: 'fallback', source: 'default', ignored: 'per-window' });
  });

  it('accepts the three documented values', () => {
    for (const value of ['block', 'fallback', 'isolated']) {
      expect(profile.resolveOnLocked(value)).toMatchObject({ mode: value, source: 'setting' });
    }
    expect(profile.ON_LOCKED_VALUES).toEqual(['block', 'fallback', 'isolated']);
    expect(profile.DEFAULT_ON_LOCKED).toBe('fallback');
    expect(profile.ON_LOCKED_BLOCK).toBe('block');
    expect(profile.ON_LOCKED_FALLBACK).toBe('fallback');
    expect(profile.ON_LOCKED_ISOLATED).toBe('isolated');
  });

  it('is offered by both plugin manifests, wired to one environment variable', () => {
    for (const name of ['cloakbrowser', 'camoufox']) {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'),
      ) as {
        userConfig: Record<string, { type: string; options: string[]; default: string; description: string }>;
      };
      const setting = manifest.userConfig.on_locked;
      expect(setting.type).toBe('string');
      expect(setting.options).toEqual(['block', 'fallback', 'isolated']);
      expect(setting.default).toBe('fallback');
      expect(setting.description).toContain('separate cookies, logins and fingerprint seed');
      expect(setting.description).toContain('an explicit Profile directory is never duplicated');
      expect(setting.description).toContain('nothing is saved and nothing persists');
      const mcp = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, '.mcp.json'), 'utf8'),
      ) as Record<string, { env: Record<string, string> }>;
      expect(mcp[name].env.STEALTH_ON_LOCKED).toBe('${user_config.on_locked}');
    }
  });
});

describe('on_locked sentences', () => {
  const liveLock = {
    profileDir: 'D:/data/profiles/default',
    path: 'D:/data/profiles/default/.lock',
    state: 'live' as const,
    owner: { pid: 4321, createdAt: '2026-10-27T09:00:00.000Z' },
    error: null,
  };

  it('keeps the workspace fallback sentence byte-identical', () => {
    expect(profile.profileFallbackReason(liveLock, 'D:/data/profiles/ws-abc-2')).toBe(
      'The workspace profile D:/data/profiles/default was already in use (pid 4321, started ' +
        '2026-10-27T09:00:00.000Z), so this session uses D:/data/profiles/ws-abc-2 instead. ' +
        'It has separate cookies, logins and fingerprint seed.',
    );
  });

  it('names the profile (not the workspace) for the on_locked fallback', () => {
    expect(profile.profileFallbackReason(liveLock, 'D:/data/profiles/default-2', 'on-locked')).toBe(
      'The profile D:/data/profiles/default was already in use (pid 4321, started ' +
        '2026-10-27T09:00:00.000Z), so this session uses D:/data/profiles/default-2 instead. ' +
        'It has separate cookies, logins and fingerprint seed.',
    );
  });

  it('says an isolated switch keeps nothing', () => {
    expect(profile.profileOnLockedIsolatedReason(liveLock)).toBe(
      'The profile D:/data/profiles/default was already in use (pid 4321, started ' +
        '2026-10-27T09:00:00.000Z), and on_locked is "isolated", so this session started with no profile ' +
        'at all: its cookies, logins and fingerprint are not saved and nothing persists after it closes.',
    );
    expect(profile.PROFILE_ON_LOCKED_ISOLATED_NOTE).toContain('on_locked is "isolated"');
  });

  it('keeps the workspace exhaustion sentence and names sibling profiles otherwise', () => {
    const workspace = profile.profileLockMessage(liveLock, { fallbackExhausted: true });
    expect(workspace).toContain(
      'The numbered workspace fallbacks (suffixes 2 to 5) are also in use. The backend was not started.',
    );
    const onLocked = profile.profileLockMessage(liveLock, {
      fallbackExhausted: true,
      fallbackKind: 'on-locked',
    });
    expect(onLocked).toContain(
      'The numbered sibling profiles (suffixes 2 to 5) are also in use. The backend was not started.',
    );
    expect(onLocked).toContain('The browser profile D:/data/profiles/default is already in use by pid 4321');
  });
});

describe('broker on_locked: a live profile lock', () => {
  // Each source resolves a different plugin-managed profile directory; the
  // policy must act the same way for all of them.
  interface Source {
    name: string;
    base: (dataDir: string, workspace: string) => string;
    options: (dataDir: string, workspace: string) => BrokerOptions;
    // profile_isolation=workspace keeps its own numbered fallback under every
    // on_locked value, including block: that is the 2.15 behaviour, byte for byte.
    workspaceRule?: boolean;
  }

  const workspaceSource: Source = {
    name: 'workspace',
    workspaceRule: true,
    base: (dataDir, workspace) => path.join(dataDir, 'profiles', 'cloak', profileWorkspaceName(workspace)),
    options: (dataDir, workspace) => ({ dataDir, isolation: 'workspace', cwd: workspace }),
  };

  const sources: Source[] = [
    {
      name: 'default',
      base: (dataDir) => path.join(dataDir, 'profiles', 'default'),
      options: (dataDir) => ({ dataDir }),
    },
    {
      name: 'account',
      base: (dataDir) => path.join(dataDir, 'profiles', 'cloak', 'alice'),
      options: (dataDir) => ({ dataDir, account: 'alice' }),
    },
    {
      name: 'pointer',
      base: (dataDir) => path.join(dataDir, 'profiles', 'cloak', 'work'),
      options: (dataDir) => {
        mkdirSync(path.join(dataDir, 'profiles', 'cloak'), { recursive: true });
        writeFileSync(path.join(dataDir, 'profiles', 'cloak', '.default'), 'work\n');
        return { dataDir };
      },
    },
    workspaceSource,
  ];

  function profileWorkspaceName(cwd: string): string {
    // The same derivation the broker uses; the module owns it and is imported
    // through the typed surface above only for the functions this suite needs.
    return (profile as unknown as { workspaceProfileName(cwd: string): string }).workspaceProfileName(cwd);
  }

  // profile_isolation=workspace keeps its own numbered fallback under every
  // on_locked value, including block: that is the 2.15 behaviour, byte for byte,
  // so it is asserted separately from the sources that block under "block".
  const blockingSources = sources.filter((source) => source.workspaceRule !== true);

  for (const source of blockingSources) {
    it(`blocks the ${source.name} profile under on_locked=block, byte-identically to 2.15`, async () => {
      const dataDir = createRuntime(tempRoot(`on-locked-${source.name}-block-`));
      const workspace = path.join(tempRoot(`on-locked-${source.name}-cwd-`), 'project');
      mkdirSync(workspace, { recursive: true });
      const base = source.base(dataDir, workspace);
      writeLock(base, process.pid);
      const session = startBroker({ ...source.options(dataDir, workspace), onLocked: 'block' });
      const initialized = await initialize(session);
      const instructions = initialized.result?.instructions ?? '';
      expect(instructions).toContain(base);
      expect(instructions).toContain(`pid ${process.pid}`);
      expect(instructions).toContain('The backend was not started');
      expect(instructions).not.toContain('separate cookies, logins and fingerprint seed');
      expect(await toolNames(session)).toEqual(META_TOOLS);
      const caps = await capabilities(session);
      expect(caps.onLocked).toBe('block');
      expect(caps.profileFallback).toBeNull();
      expect(caps.profileLock).toMatchObject({ state: 'live', profileDir: base });
      expect(caps.engineError).toBe(profile.profileLockMessage(profile.readProfileLock(base)));
      const statusPayload = await status(session);
      expect(statusPayload.onLocked).toBe('block');
      expect(statusPayload.backendState).toBe('failed');
      expect(session.stderr()).toContain('not starting a backend');
      // Nothing was created beside the busy profile.
      expect(existsSync(`${base}-2`)).toBe(false);
    });
  }

  it('keeps the workspace rule under on_locked=block: its own sibling, its own sentence', async () => {
    const source = workspaceSource;
    const dataDir = createRuntime(tempRoot('on-locked-workspace-block-'));
    const workspace = path.join(tempRoot('on-locked-workspace-block-cwd-'), 'project');
    mkdirSync(workspace, { recursive: true });
    const base = source.base(dataDir, workspace);
    writeLock(base, process.pid);
    const session = startBroker({ ...source.options(dataDir, workspace), onLocked: 'block' });
    const initialized = await initialize(session);
    const instructions = initialized.result?.instructions ?? '';
    expect(instructions).toContain('The workspace profile');
    expect(instructions).toContain('separate cookies, logins and fingerprint seed');
    const caps = await capabilities(session);
    expect(caps.onLocked).toBe('block');
    expect(caps.profileFallback).toMatchObject({ from: base, to: `${base}-2` });
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
  });

  for (const source of sources) {
    describe(`${source.name} profile`, () => {
      it('starts on the first free numbered sibling under the default policy', async () => {
        const dataDir = createRuntime(tempRoot(`on-locked-${source.name}-fallback-`));
        const workspace = path.join(tempRoot(`on-locked-${source.name}-cwd2-`), 'project');
        mkdirSync(workspace, { recursive: true });
        const base = source.base(dataDir, workspace);
        writeLock(base, process.pid);
        // -2 is live-locked too, so the first free sibling is -3.
        writeLock(`${base}-2`, process.pid);
        const session = startBroker(source.options(dataDir, workspace));
        const initialized = await initialize(session);
        const instructions = initialized.result?.instructions ?? '';
        expect(instructions).toContain(base);
        expect(instructions).toContain(`${base}-3`);
        expect(instructions).toContain('separate cookies, logins and fingerprint seed');
        expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
        const caps = await capabilities(session);
        expect(caps.onLocked).toBe('fallback');
        expect(caps.profileFallback).toMatchObject({ from: base, to: `${base}-3` });
        expect(String((caps.profileFallback as Record<string, unknown>).reason)).toContain(
          `pid ${process.pid}`,
        );
        expect(caps.profileDir).toBe(`${base}-3`);
        expect(caps.profileLock).toMatchObject({ state: 'free', profileDir: `${base}-3` });
        expect(await effectiveEnvironment(session)).toMatchObject({
          profileDir: `${base}-3`,
          isolated: null,
        });
        // The busy profile is untouched: its lock still names the live owner.
        expect(profile.readProfileLock(base)).toMatchObject({ state: 'live', owner: { pid: process.pid } });
        const statusPayload = await status(session);
        expect(statusPayload.onLocked).toBe('fallback');
        expect(statusPayload.profileFallback).toMatchObject({ from: base, to: `${base}-3` });
        const profiles = await profilesPayload(session);
        expect((profiles.current as Record<string, unknown>).onLocked).toBe('fallback');
        expect((profiles.current as Record<string, unknown>).profileDir).toBe(`${base}-3`);
        expect(session.stderr()).toContain('so this session uses');
      });

      it('starts with no profile under on_locked=isolated and creates nothing', async () => {
        const dataDir = createRuntime(tempRoot(`on-locked-${source.name}-isolated-`));
        const workspace = path.join(tempRoot(`on-locked-${source.name}-cwd3-`), 'project');
        mkdirSync(workspace, { recursive: true });
        const base = source.base(dataDir, workspace);
        writeLock(base, process.pid);
        const session = startBroker({ ...source.options(dataDir, workspace), onLocked: 'isolated' });
        const initialized = await initialize(session);
        const instructions = initialized.result?.instructions ?? '';
        expect(instructions).toContain(base);
        expect(instructions).toContain('on_locked is "isolated"');
        expect(instructions).toContain('no profile at all');
        // The profile_isolation setting did not change, so no surface may claim
        // it is "isolated".
        expect(instructions).not.toContain('Profile isolation is "isolated"');
        expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
        const caps = await capabilities(session);
        expect(caps.onLocked).toBe('isolated');
        expect(caps.profileDir).toBeNull();
        expect(caps.profileSource).toBe('isolated');
        expect(caps.profileLock).toBeNull();
        expect(caps.profileFallback).toMatchObject({ from: base, to: null });
        expect(String(caps.profileIsolationNote)).toContain('on_locked is "isolated"');
        expect(await effectiveEnvironment(session)).toEqual({
          profileDir: null,
          isolated: 'true',
          proxy: null,
        });
        expect(existsSync(`${base}-2`)).toBe(false);
        // The isolated start reports the settings it ignored, with their values.
        const profiles = await profilesPayload(session);
        expect((profiles.current as Record<string, unknown>).onLocked).toBe('isolated');
        expect((profiles.current as Record<string, unknown>).profileIsolationNote).toContain(
          'on_locked is "isolated"',
        );
      });
    });
  }

  it('never duplicates an explicit profile_dir: every policy blocks', async () => {
    for (const policy of ['block', 'fallback', 'isolated', '']) {
      const dataDir = createRuntime(tempRoot('on-locked-explicit-'));
      const explicit = path.join(tempRoot('on-locked-explicit-profile-'), 'profile');
      writeLock(explicit, process.pid);
      const session = startBroker({
        dataDir,
        profileDir: explicit,
        ...(policy === '' ? {} : { onLocked: policy }),
      });
      const initialized = await initialize(session);
      const instructions = initialized.result?.instructions ?? '';
      expect(instructions).toContain(explicit);
      expect(instructions).toContain('The backend was not started');
      expect(await toolNames(session)).toEqual(META_TOOLS);
      const caps = await capabilities(session);
      expect(caps.file).toBeUndefined();
      expect(caps.profileSource).toBe('profile_dir');
      expect(caps.profileFallback).toBeNull();
      expect(caps.profileLock).toMatchObject({ state: 'live', profileDir: explicit });
      expect(existsSync(`${explicit}-2`)).toBe(false);
      await session.close();
    }
  });
});

describe('broker on_locked: free and stale locks', () => {
  for (const policy of ['block', 'fallback', 'isolated']) {
    it(`starts on the resolved profile unchanged with a free lock (${policy})`, async () => {
      const dataDir = createRuntime(tempRoot('on-locked-free-'));
      const session = startBroker({ dataDir, onLocked: policy });
      await initialize(session);
      const caps = await capabilities(session);
      expect(caps).toMatchObject({
        onLocked: policy,
        profileSource: 'default',
        profileDir: null,
        profileFallback: null,
        profileLock: { state: 'free' },
      });
      expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
      expect(await effectiveEnvironment(session)).toMatchObject({
        profileDir: path.join(dataDir, 'profiles', 'default'),
        isolated: null,
      });
    });

    it(`keeps a stale lock on the resolved profile (${policy})`, async () => {
      const dataDir = createRuntime(tempRoot('on-locked-stale-'));
      const base = path.join(dataDir, 'profiles', 'default');
      writeLock(base, DEAD_PID);
      const session = startBroker({ dataDir, onLocked: policy });
      await initialize(session);
      const caps = await capabilities(session);
      expect(caps.profileLock).toMatchObject({ state: 'stale' });
      expect(caps.profileFallback).toBeNull();
      expect(caps.profileDir).toBeNull();
      expect(await effectiveEnvironment(session)).toMatchObject({ profileDir: base, isolated: null });
      expect(session.stderr()).toContain('is stale');
    });
  }

  it('produces the same payload for every policy when the profile is free', async () => {
    const payloads: Record<string, Record<string, unknown>> = {};
    for (const policy of ['block', 'fallback', 'isolated']) {
      const dataDir = createRuntime(tempRoot('on-locked-equal-'));
      const session = startBroker({ dataDir, onLocked: policy });
      await initialize(session);
      await session.request('tools/list', {});
      const payload = await capabilities(session);
      payloads[policy] = JSON.parse(
        JSON.stringify(payload).split(JSON.stringify(dataDir).slice(1, -1)).join('<DATA>'),
      ) as Record<string, unknown>;
      await session.close();
    }
    const without = (payload: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'onLocked'));
    expect(without(payloads.fallback)).toEqual(without(payloads.block));
    expect(without(payloads.isolated)).toEqual(without(payloads.block));
  });
});

describe('broker on_locked: sibling selection and exhaustion', () => {
  it('uses a sibling that only holds a stale lock', async () => {
    const dataDir = createRuntime(tempRoot('on-locked-stale-sibling-'));
    const base = path.join(dataDir, 'profiles', 'default');
    writeLock(base, process.pid);
    writeLock(`${base}-2`, DEAD_PID);
    const session = startBroker({ dataDir });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.profileFallback).toMatchObject({ from: base, to: `${base}-2` });
    expect(caps.profileLock).toMatchObject({ state: 'stale', profileDir: `${base}-2` });
  });

  it('blocks loudly with the sibling wording when -2 to -5 are all in use', async () => {
    const dataDir = createRuntime(tempRoot('on-locked-exhausted-'));
    const base = path.join(dataDir, 'profiles', 'default');
    for (const suffix of ['', '-2', '-3', '-4', '-5']) {
      writeLock(`${base}${suffix}`, process.pid);
    }
    const session = startBroker({ dataDir });
    const initialized = await initialize(session);
    const instructions = initialized.result?.instructions ?? '';
    expect(instructions).toContain('The numbered sibling profiles (suffixes 2 to 5) are also in use.');
    expect(instructions).toContain('The backend was not started');
    expect(await toolNames(session)).toEqual(META_TOOLS);
    const caps = await capabilities(session);
    expect(caps.profileFallback).toBeNull();
    expect(caps.profileLock).toMatchObject({ state: 'live', profileDir: base });
    expect(String(caps.engineError)).toContain('numbered sibling profiles (suffixes 2 to 5)');
  });

  it('treats an unknown value as fallback and logs it once', async () => {
    const dataDir = createRuntime(tempRoot('on-locked-unknown-'));
    const base = path.join(dataDir, 'profiles', 'default');
    writeLock(base, process.pid);
    const session = startBroker({ dataDir, onLocked: 'per-window' });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.onLocked).toBe('fallback');
    expect(caps.profileFallback).toMatchObject({ from: base, to: `${base}-2` });
    expect(session.stderr()).toContain('ignoring unknown on-locked policy: per-window');
  });
});

describe('broker on_locked: the engine profile lock', () => {
  function setupEngineLock(policy: string | undefined, prepare: (profileDir: string) => void): BrokerSession {
    const root = tempRoot('on-locked-engine-');
    const plugin = createScratchPlugin(root);
    const dataDir = createRuntime(path.join(root, 'data'), 'lock-engine');
    const base = path.join(dataDir, 'profiles', 'lock-engine', 'default');
    mkdirSync(base, { recursive: true });
    prepare(base);
    return startBroker({ dataDir, engine: 'lock-engine', pluginDir: plugin, onLocked: policy });
  }

  it('moves to a sibling when another process holds the engine lock (default policy)', async () => {
    const session = setupEngineLock(undefined, (base) => {
      writeFileSync(path.join(base, 'owner.lock'), `${process.pid}\n`);
    });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.onLocked).toBe('fallback');
    expect(caps.profileFallback).toMatchObject({ to: expect.stringContaining('-2') });
    expect(caps.engineProfileLock).toMatchObject({ state: 'free' });
    const reason = String((caps.profileFallback as Record<string, unknown>).reason);
    expect(reason).toContain(String((caps.profileFallback as Record<string, unknown>).from));
    expect(reason).toContain('was already in use');
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
  });

  it('blocks under on_locked=block exactly as before', async () => {
    const session = setupEngineLock('block', (base) => {
      writeFileSync(path.join(base, 'owner.lock'), `${process.pid}\n`);
    });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain('The backend was not started.');
    expect(await toolNames(session)).toEqual(META_TOOLS);
    const caps = await capabilities(session);
    expect(caps.profileFallback).toBeNull();
    expect(caps.engineProfileLock).toMatchObject({ state: 'live' });
  });

  it('reports engine-lock exhaustion with the sibling wording', async () => {
    const session = setupEngineLock(undefined, (base) => {
      for (const suffix of ['', '-2', '-3', '-4', '-5']) {
        mkdirSync(`${base}${suffix}`, { recursive: true });
        writeFileSync(path.join(`${base}${suffix}`, 'owner.lock'), `${process.pid}\n`);
      }
    });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain(
      'The numbered sibling profiles (suffixes 2 to 5) are also in use.',
    );
    expect(await toolNames(session)).toEqual(META_TOOLS);
    const caps = await capabilities(session);
    expect(caps.profileFallback).toBeNull();
    expect(caps.engineProfileLock).toMatchObject({ state: 'live' });
  });
});

describe('broker on_locked: copy and copy-keep use the sibling base', () => {
  it('copies the sibling base, never the live one (copy)', async () => {
    const dataDir = createRuntime(tempRoot('on-locked-copy-'));
    const base = path.join(dataDir, 'profiles', 'default');
    seedBase(base);
    writeLock(base, process.pid);
    const session = startBroker({ dataDir, isolation: 'copy' });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain(`${base}-2`);
    const caps = await capabilities(session);
    expect(caps.onLocked).toBe('fallback');
    expect(caps.profileFallback).toMatchObject({ from: base, to: `${base}-2` });
    const copy = caps.profileCopy as Record<string, unknown>;
    expect(copy).toMatchObject({ baseDir: `${base}-2` });
    expect(String(copy.sessionDir)).toContain(path.join('profiles', 'cloak', '.sessions'));
    expect(String(copy.sessionDir)).toContain('default-2-');
    expect((copy.baseLock as Record<string, unknown>).heldByThisSession).toBe(true);
    // The live base keeps its bytes and its owner's lock.
    expect(readFileSync(path.join(base, 'Default', 'Cookies'), 'utf8')).toBe('cookie-bytes');
    expect(profile.readProfileLock(base)).toMatchObject({ state: 'live', owner: { pid: process.pid } });
    expect(session.stderr()).toContain('so this session uses');
  });

  it('swaps the session copy into the sibling base on a clean close (copy-keep)', async () => {
    const dataDir = createRuntime(tempRoot('on-locked-copy-keep-'));
    const base = path.join(dataDir, 'profiles', 'default');
    seedBase(base);
    writeLock(base, process.pid);
    const session = startBroker({ dataDir, isolation: 'copy-keep' });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.profileFallback).toMatchObject({ from: base, to: `${base}-2` });
    const copy = caps.profileCopy as Record<string, unknown>;
    expect(copy.baseDir).toBe(`${base}-2`);
    expect((copy.swap as Record<string, unknown>).state).toBe('pending');
    await session.close();
    // The swap targets the sibling: the old base lives beside it and the live
    // base the other session owns is untouched.
    expect(readFileSync(path.join(base, 'Default', 'Cookies'), 'utf8')).toBe('cookie-bytes');
    expect(existsSync(`${base}-2`)).toBe(true);
    const record = JSON.parse(
      readFileSync(path.join(dataDir, 'profiles', 'cloak', '.last-swap.json'), 'utf8'),
    ) as { state: string; baseDir: string; previousDir: string };
    expect(record.state).toBe('swapped');
    expect(record.baseDir).toBe(`${base}-2`);
    expect(record.previousDir.startsWith(`${base}-2.previous-`)).toBe(true);
    expect(existsSync(record.previousDir)).toBe(true);
  });
});

describe('broker on_locked: engines and isolation that cannot use it', () => {
  it('adds no onLocked key for a profileApplies:false engine', async () => {
    const root = tempRoot('on-locked-attach-');
    const plugin = createScratchPlugin(root);
    const dataDir = createRuntime(path.join(root, 'data'), 'attach-test');
    const base = path.join(dataDir, 'profiles', 'attach-test', 'default');
    writeLock(base, process.pid);
    const session = startBroker({ dataDir, engine: 'attach-test', pluginDir: plugin });
    await initialize(session);
    const caps = await capabilities(session);
    const statusPayload = await status(session);
    expect('onLocked' in caps).toBe(false);
    expect('onLocked' in statusPayload).toBe(false);
    expect(caps).toMatchObject({ profileApplies: false, profileSource: 'engine', profileFallback: null });
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
  });

  it('is inert for profile_isolation=isolated: no lock is read and no switch is reported', async () => {
    const dataDir = createRuntime(tempRoot('on-locked-configured-isolated-'));
    const base = path.join(dataDir, 'profiles', 'default');
    writeLock(base, process.pid);
    const session = startBroker({ dataDir, isolation: 'isolated' });
    const initialized = await initialize(session);
    const caps = await capabilities(session);
    expect(caps).toMatchObject({
      onLocked: 'fallback',
      profileIsolation: 'isolated',
      profileSource: 'isolated',
      profileDir: null,
      profileFallback: null,
      profileLock: null,
    });
    expect(String(initialized.result?.instructions)).not.toContain('on_locked is');
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
  });
});

describe('broker on_locked: additional guards and edge paths', () => {
  it('keeps the base profile .proxy file when it moves to a sibling', async () => {
    const dataDir = createRuntime(tempRoot('on-locked-proxy-'));
    const base = path.join(dataDir, 'profiles', 'cloak', 'alice');
    writeLock(base, process.pid);
    writeFileSync(path.join(dataDir, 'profiles', 'cloak', 'alice.proxy'), 'http://proxy.example:8080\n');
    const session = startBroker({ dataDir, account: 'alice' });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.profileFallback).toMatchObject({ from: base, to: `${base}-2` });
    // The proxy is configuration, not identity: the sibling inherits the base's
    // file rather than looking for alice-2.proxy.
    expect(await effectiveEnvironment(session)).toMatchObject({
      profileDir: `${base}-2`,
      proxy: 'http://proxy.example:8080',
    });
    expect(session.stderr()).toContain('using the account proxy file for account "alice"');
  });

  it('skips a sibling whose engine lock is live as well', async () => {
    const root = tempRoot('on-locked-engine-skip-');
    const plugin = createScratchPlugin(root);
    const dataDir = createRuntime(path.join(root, 'data'), 'lock-engine');
    const base = path.join(dataDir, 'profiles', 'lock-engine', 'default');
    mkdirSync(base, { recursive: true });
    mkdirSync(`${base}-2`, { recursive: true });
    writeFileSync(path.join(base, 'owner.lock'), `${process.pid}\n`);
    writeFileSync(path.join(`${base}-2`, 'owner.lock'), `${process.pid}\n`);
    const session = startBroker({ dataDir, engine: 'lock-engine', pluginDir: plugin });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.profileFallback).toMatchObject({ to: `${base}-3` });
    expect(caps.engineProfileLock).toMatchObject({ state: 'free', profileDir: `${base}-3` });
  });

  it('skips a sibling whose engine lock is live when the bridge lock is the busy one', async () => {
    const root = tempRoot('on-locked-bridge-engine-skip-');
    const plugin = createScratchPlugin(root);
    const dataDir = createRuntime(path.join(root, 'data'), 'lock-engine');
    const base = path.join(dataDir, 'profiles', 'lock-engine', 'default');
    // The base holds a live bridge lock and the first sibling's engine lock is
    // live: a sibling is chosen only when both of its locks are free.
    writeLock(base, process.pid);
    mkdirSync(`${base}-2`, { recursive: true });
    writeFileSync(path.join(`${base}-2`, 'owner.lock'), `${process.pid}\n`);
    const session = startBroker({ dataDir, engine: 'lock-engine', pluginDir: plugin });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.profileFallback).toMatchObject({ from: base, to: `${base}-3` });
    expect(caps.engineProfileLock).toMatchObject({ state: 'free', profileDir: `${base}-3` });
  });

  it('reads the engine lock of the sibling a busy base moved it to', async () => {
    const root = tempRoot('on-locked-both-locks-');
    const plugin = createScratchPlugin(root);
    const dataDir = createRuntime(path.join(root, 'data'), 'lock-engine');
    const base = path.join(dataDir, 'profiles', 'lock-engine', 'default');
    // The realistic case: the other session's browser holds the bridge lock and
    // the engine's own lock on the same profile. The sibling is free by both.
    writeLock(base, process.pid);
    mkdirSync(base, { recursive: true });
    writeFileSync(path.join(base, 'owner.lock'), `${process.pid}\n`);
    const session = startBroker({ dataDir, engine: 'lock-engine', pluginDir: plugin });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.profileFallback).toMatchObject({ from: base, to: `${base}-2` });
    expect(caps.engineProfileLock).toMatchObject({ state: 'free', profileDir: `${base}-2` });
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
  });

  it('reports the profile settings an isolated switch made inert', async () => {
    const dataDir = createRuntime(tempRoot('on-locked-ignored-'));
    mkdirSync(path.join(dataDir, 'profiles', 'cloak'), { recursive: true });
    writeFileSync(path.join(dataDir, 'profiles', 'cloak', '.default'), 'work\n');
    const base = path.join(dataDir, 'profiles', 'cloak', 'alice');
    writeLock(base, process.pid);
    const session = startBroker({ dataDir, account: 'alice', onLocked: 'isolated' });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.profileFallback).toMatchObject({ from: base, to: null });
    const ignored = caps.profileIgnored as { setting: string; value: string }[];
    // account won the resolution, but the isolated switch made both inert.
    expect(ignored.map((entry) => entry.setting).sort()).toEqual(['account', 'default_profile_pointer']);
    expect(String(caps.profileIgnoredReason)).toContain('profile_isolation is "isolated"');
  });

  it('makes no copy under copy mode when the switch is isolated', async () => {
    const dataDir = createRuntime(tempRoot('on-locked-copy-isolated-'));
    const base = path.join(dataDir, 'profiles', 'default');
    seedBase(base);
    writeLock(base, process.pid);
    const session = startBroker({ dataDir, isolation: 'copy', onLocked: 'isolated' });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain('on_locked is "isolated"');
    const caps = await capabilities(session);
    expect(caps).toMatchObject({ onLocked: 'isolated', profileSource: 'isolated', profileDir: null });
    expect('profileCopy' in caps).toBe(false);
    expect(existsSync(path.join(dataDir, 'profiles', 'cloak', '.sessions'))).toBe(false);
    expect(await effectiveEnvironment(session)).toEqual({ profileDir: null, isolated: 'true', proxy: null });
    expect(profile.readProfileLock(base)).toMatchObject({ state: 'live', owner: { pid: process.pid } });
  });

  it('says an isolated switch keeps nothing when the backend then fails', async () => {
    const dataDir = createRuntime(tempRoot('on-locked-meta-isolated-'));
    const base = path.join(dataDir, 'profiles', 'default');
    writeLock(base, process.pid);
    const session = startBroker({ dataDir, onLocked: 'isolated', failBackend: true });
    const initialized = await initialize(session);
    const instructions = initialized.result?.instructions ?? '';
    expect(instructions).toContain('backend is unavailable');
    expect(instructions).toContain('on_locked is "isolated"');
    // The meta-only path must not claim profile_isolation changed either.
    expect(instructions).not.toContain('Profile isolation is "isolated"');
    expect(await toolNames(session)).toEqual(META_TOOLS);
    const statusPayload = await status(session);
    expect(String(statusPayload.lastError)).toContain('Backend exited (code 1)');
  });
});
