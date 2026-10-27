import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
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
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface ProfileResolution {
  profileDir: string | null;
  defaultProfileDir: string;
  profileSource: string | null;
  account: string | null;
  accountApplies: boolean;
  error: string | null;
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
  DEFAULT_PROFILE_ISOLATION: string;
  PROFILE_FALLBACK_LAST_SUFFIX: number;
  PROFILE_LOCK_FILENAME: string;
  WORKSPACE_PROFILE_PREFIX: string;
  workspaceProfileName(cwd: string): string;
  workspaceProfileDir(engineId: string, dataDir: string, cwd: string): string;
  resolveProfileIsolation(value: string): {
    mode: string;
    source: string;
    ignored: string | null;
    placeholder: string | null;
  };
  resolveProfile(options: {
    account?: string;
    profileDir?: string;
    engineId: string;
    dataDir: string;
    launcherName?: string;
    ignoredSettings?: string[];
    profileApplies?: boolean;
    isolation?: string;
    cwd?: string;
  }): ProfileResolution;
  effectiveProfileDir(resolution: ProfileResolution): string | null;
  readProfileLock(profileDir: string): ProfileLock;
  lockBlocksStart(lock: ProfileLock): boolean;
  profileLockFix(lock: ProfileLock): string | null;
  profileLockMessage(lock: ProfileLock, options?: { fallbackExhausted?: boolean }): string;
  profileFallbackReason(lock: ProfileLock, toDir: string): string;
  selectFallbackProfile(baseDir: string, isBlocked: (candidate: string) => boolean): string | null;
}

interface RegistryModule {
  manifestProfileApplies(manifest: { profileApplies?: boolean }): boolean;
  validateManifest(
    manifest: Record<string, unknown>,
    expectedId: string,
    profileNames: string[],
  ): string | null;
}

interface JsonRpcResponse {
  id?: number;
  result?: {
    tools?: { name: string; description?: string }[];
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
const profileModulePath = new URL('../../plugins/cloakbrowser/lib/profile.mjs', import.meta.url);
const profile = (await import(profileModulePath.href)) as unknown as ProfileModule;
const registryModulePath = new URL('../../plugins/cloakbrowser/engine-registry.mjs', import.meta.url);
const registry = (await import(registryModulePath.href)) as unknown as RegistryModule;

const DATA_DIR = path.resolve('D:/scratch/pr10-data');
const CWD = 'D:\\Projects2\\StealthBrowserAutomation';
const LOCK = '.cloakbrowser-mcp-profile.lock';
const PROXY_SECRET = 'pr10-secret-token';
const PROXY_URL = `http://user:${PROXY_SECRET}@proxy.example:8080`;
const STUB_TOOLS = ['browser_navigate', 'browser_snapshot'];

const STUB_SOURCE = `#!/usr/bin/env node
// Deterministic stand-in for the Chromium launcher's CLI in the broker probes.
const readline = require('node:readline');

if (process.env.STUB_FAIL === '1') {
  process.stderr.write('fatal: stub backend exploded\\n');
  process.exit(1);
}

const TOOLS = ${JSON.stringify(STUB_TOOLS)};

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'stub-browser-mcp', version: '0.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
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
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              profileDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? null,
              proxy: process.env.PLAYWRIGHT_MCP_PROXY_SERVER ?? null,
            }),
          },
        ],
        isError: false,
      },
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

const ESM_STUB_SOURCE = `#!/usr/bin/env node
import readline from 'node:readline';

const TOOLS = ${JSON.stringify(STUB_TOOLS)};

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'stub-attach-mcp', version: '0.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
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
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              profileDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? null,
              proxy: process.env.PLAYWRIGHT_MCP_PROXY_SERVER ?? null,
            }),
          },
        ],
        isError: false,
      },
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
  // Canonicalize the fixture path: macOS TMPDIR is under /var, which is a
  // symlink to /private/var, while the broker child's process.cwd() reports the
  // physical path. Every path derived from this root (workspace name, data dir,
  // lock file) must match what the child sees.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeLock(profileDir: string, pid: number, createdAt = '2026-10-25T01:00:00.000Z'): string {
  mkdirSync(profileDir, { recursive: true });
  const file = path.join(profileDir, LOCK);
  writeFileSync(file, `${JSON.stringify({ pid, createdAt, userDataDir: profileDir }, null, 2)}\n`);
  return file;
}

function deadPid(root: string): number {
  const file = path.join(root, 'exit-now.mjs');
  writeFileSync(file, 'process.exit(0);\n');
  const result = spawnSync(process.execPath, [file], { windowsHide: true });
  if (result.pid === undefined || result.pid <= 0) {
    throw new Error('could not obtain a dead pid');
  }
  return result.pid;
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

async function toolNames(session: BrokerSession): Promise<string[]> {
  const list = await session.request('tools/list', {});
  return (list.result?.tools ?? []).map((tool) => tool.name);
}

async function effectiveEnvironment(
  session: BrokerSession,
): Promise<{ profileDir: string | null; proxy: string | null }> {
  const response = await session.request('tools/call', {
    name: 'browser_navigate',
    arguments: { url: 'http://127.0.0.1:9/' },
  });
  const text = response.result?.content?.[0]?.text ?? '{}';
  return JSON.parse(text) as { profileDir: string | null; proxy: string | null };
}

// A plugin tree with one extra synthetic engine whose manifest declares
// profileApplies: false. It proves the applicability rule is manifest-driven and
// has no engine id branch in the broker.
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
    notes: 'Synthetic manifest for the session-safety unit suite.',
  });
  writeFileSync(path.join(plugin, 'launch-attach-test.mjs'), ESM_STUB_SOURCE);
  return plugin;
}

describe('workspace profile derivation', () => {
  it('uses Playwright-style sha256(cwd)[:7] with a ws- prefix', () => {
    expect(profile.workspaceProfileName(CWD)).toBe('ws-0b0e194');
    expect(profile.workspaceProfileName('C:\\Users\\fgghk')).toBe('ws-14ee6b1');
    expect(profile.workspaceProfileName(CWD)).toHaveLength(profile.WORKSPACE_PROFILE_PREFIX.length + 7);
  });

  it('hashes the exact cwd string, so a different spelling is a different profile', () => {
    expect(profile.workspaceProfileName('D:/Projects2/StealthBrowserAutomation')).toBe('ws-c198e3e');
    expect(profile.workspaceProfileName(CWD)).not.toBe(
      profile.workspaceProfileName('d:\\projects2\\stealthbrowserautomation'),
    );
  });

  it('builds profiles/<engine>/ws-<hash>', () => {
    expect(profile.workspaceProfileDir('cloak', DATA_DIR, CWD)).toBe(
      path.join(DATA_DIR, 'profiles', 'cloak', 'ws-0b0e194'),
    );
    expect(profile.workspaceProfileDir('camoufox', DATA_DIR, CWD)).toBe(
      path.join(DATA_DIR, 'profiles', 'camoufox', 'ws-0b0e194'),
    );
  });
});

describe('profile_isolation setting', () => {
  it('defaults to shared for unset, empty, placeholder and unknown values', () => {
    for (const value of ['', '   ']) {
      expect(profile.resolveProfileIsolation(value)).toMatchObject({ mode: 'shared', source: 'default' });
    }
    const placeholder = profile.resolveProfileIsolation('${user_config.profile_isolation}');
    expect(placeholder).toMatchObject({ mode: 'shared', source: 'default' });
    expect(placeholder.placeholder).not.toBeNull();
    const unknown = profile.resolveProfileIsolation('per-window');
    expect(unknown).toMatchObject({ mode: 'shared', source: 'default', ignored: 'per-window' });
  });

  it('accepts shared and workspace as explicit settings', () => {
    expect(profile.resolveProfileIsolation('shared')).toMatchObject({
      mode: 'shared',
      source: 'setting',
    });
    expect(profile.resolveProfileIsolation('workspace')).toMatchObject({
      mode: 'workspace',
      source: 'setting',
    });
  });
});

describe('profile resolution precedence', () => {
  it('keeps the unset/shared result byte-identical to 2.7.1', () => {
    const resolved = profile.resolveProfile({ account: '', engineId: 'cloak', dataDir: DATA_DIR });
    expect(resolved).toEqual({
      profileDir: null,
      defaultProfileDir: path.join(DATA_DIR, 'profiles', 'default'),
      profileSource: 'default',
      account: null,
      accountApplies: true,
      error: null,
    });
    expect(
      profile.resolveProfile({ account: '', engineId: 'cloak', dataDir: DATA_DIR, isolation: 'shared' }),
    ).toEqual(resolved);
  });

  it('derives a workspace profile when isolation is workspace and nothing else is set', () => {
    const resolved = profile.resolveProfile({
      account: '',
      engineId: 'cloak',
      dataDir: DATA_DIR,
      isolation: 'workspace',
      cwd: CWD,
    });
    expect(resolved).toMatchObject({ profileSource: 'workspace', account: null });
    expect(resolved.profileDir).toBe(path.join(DATA_DIR, 'profiles', 'cloak', 'ws-0b0e194'));
  });

  it('lets an account win over the workspace profile', () => {
    const resolved = profile.resolveProfile({
      account: 'alice',
      engineId: 'cloak',
      dataDir: DATA_DIR,
      isolation: 'workspace',
      cwd: CWD,
    });
    expect(resolved).toMatchObject({ profileSource: 'account', account: 'alice' });
    expect(resolved.profileDir).toBe(path.join(DATA_DIR, 'profiles', 'cloak', 'alice'));
  });

  it('lets the default account name win over the workspace profile', () => {
    const resolved = profile.resolveProfile({
      account: 'default',
      engineId: 'cloak',
      dataDir: DATA_DIR,
      isolation: 'workspace',
      cwd: CWD,
    });
    expect(resolved.profileDir).toBe(path.join(DATA_DIR, 'profiles', 'default'));
  });

  it('lets an explicit profile_dir win over everything, unchanged', () => {
    const resolved = profile.resolveProfile({
      account: 'alice',
      profileDir: 'D:/explicit/../profile',
      engineId: 'cloak',
      dataDir: DATA_DIR,
      isolation: 'workspace',
      cwd: CWD,
    });
    expect(resolved).toMatchObject({ profileSource: 'profile_dir', account: null });
    expect(resolved.profileDir).toBe('D:/explicit/../profile');
  });

  it('is inert for an engine with profileApplies false, even with every setting set', () => {
    const resolved = profile.resolveProfile({
      account: 'alice',
      profileDir: 'D:/ignored',
      engineId: 'kameleo',
      dataDir: DATA_DIR,
      profileApplies: false,
      isolation: 'workspace',
      cwd: CWD,
    });
    expect(resolved).toMatchObject({
      profileSource: 'engine',
      accountApplies: false,
      profileDir: null,
      error: null,
    });
  });

  it('keeps the legacy ignoredSettings rule for an engine that predates profileApplies', () => {
    const resolved = profile.resolveProfile({
      account: 'alice',
      engineId: 'camoufox-native',
      dataDir: DATA_DIR,
      ignoredSettings: ['profile_dir'],
    });
    expect(resolved).toMatchObject({ profileSource: 'engine', accountApplies: false });
  });

  it('resolves the effective directory the preflight reads', () => {
    const defaults = profile.resolveProfile({ account: '', engineId: 'cloak', dataDir: DATA_DIR });
    expect(profile.effectiveProfileDir(defaults)).toBe(path.join(DATA_DIR, 'profiles', 'default'));
    const workspace = profile.resolveProfile({
      account: '',
      engineId: 'cloak',
      dataDir: DATA_DIR,
      isolation: 'workspace',
      cwd: CWD,
    });
    expect(profile.effectiveProfileDir(workspace)).toBe(workspace.profileDir);
    const explicit = profile.resolveProfile({
      account: '',
      profileDir: 'D:/p',
      engineId: 'cloak',
      dataDir: DATA_DIR,
    });
    expect(profile.effectiveProfileDir(explicit)).toBe('D:/p');
    const engine = profile.resolveProfile({
      account: '',
      engineId: 'kameleo',
      dataDir: DATA_DIR,
      profileApplies: false,
    });
    expect(profile.effectiveProfileDir(engine)).toBeNull();
  });
});

describe('profile lock reading', () => {
  it('reports free when no lock file exists', () => {
    const root = tempRoot('pr10-lock-free-');
    const result = profile.readProfileLock(path.join(root, 'missing'));
    expect(result.state).toBe('free');
    expect(result.owner).toBeNull();
    expect(profile.lockBlocksStart(result)).toBe(false);
  });

  it('reports live for a valid lock naming an existing process', () => {
    const root = tempRoot('pr10-lock-live-');
    const lockDir = path.join(root, 'profile');
    writeLock(lockDir, process.pid, '2026-10-25T01:02:03.000Z');
    const result = profile.readProfileLock(lockDir);
    expect(result.state).toBe('live');
    expect(result.owner).toEqual({ pid: process.pid, createdAt: '2026-10-25T01:02:03.000Z' });
    expect(result.path).toBe(path.join(lockDir, profile.PROFILE_LOCK_FILENAME));
    expect(profile.lockBlocksStart(result)).toBe(true);
    const fix = profile.profileLockFix(result);
    expect(fix).toContain('Close the Claude Code session');
    expect(fix).toContain('profile_isolation');
    expect(fix).toContain('workspace');
    expect(profile.profileLockMessage(result)).toContain(`pid ${process.pid}`);
    expect(profile.profileLockMessage(result)).toContain(lockDir);
    expect(profile.profileLockMessage(result)).toContain('The backend was not started.');
  });

  it('reports stale for a lock naming a process that is gone', () => {
    const root = tempRoot('pr10-lock-stale-');
    const lockDir = path.join(root, 'profile');
    writeLock(lockDir, deadPid(root));
    const result = profile.readProfileLock(lockDir);
    expect(result.state).toBe('stale');
    expect(result.owner?.pid).toBeGreaterThan(0);
    expect(profile.lockBlocksStart(result)).toBe(false);
    expect(profile.profileLockFix(result)).toBeNull();
  });

  it.each([
    ['invalid JSON', 'not-json', 'not valid JSON'],
    ['a JSON array', '[]', 'not a JSON object'],
    ['a missing pid', '{"createdAt":"2026-10-25T00:00:00Z"}', 'does not name a process id'],
    ['a zero pid', '{"pid":0}', 'does not name a process id'],
    ['a string pid', '{"pid":"123"}', 'does not name a process id'],
  ])('reports invalid for %s', (_label, contents, expected) => {
    const root = tempRoot('pr10-lock-invalid-');
    const lockDir = path.join(root, 'profile');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, LOCK), contents);
    const result = profile.readProfileLock(lockDir);
    expect(result.state).toBe('invalid');
    expect(result.error).toContain(expected);
    expect(profile.lockBlocksStart(result)).toBe(true);
    expect(profile.profileLockFix(result)).toContain('delete the lock file');
  });

  it('reports invalid when the lock path is not a regular file', () => {
    const root = tempRoot('pr10-lock-dir-');
    const lockDir = path.join(root, 'profile');
    mkdirSync(path.join(lockDir, LOCK), { recursive: true });
    const result = profile.readProfileLock(lockDir);
    expect(result.state).toBe('invalid');
    expect(result.error).toContain('not a regular file');
  });
});

describe('workspace fallback selection', () => {
  const base = path.join(DATA_DIR, 'profiles', 'cloak', 'ws-0b0e194');

  it('picks the first free numbered sibling', () => {
    expect(profile.selectFallbackProfile(base, () => false)).toBe(`${base}-2`);
    const blocked = new Set([`${base}-2`]);
    expect(profile.selectFallbackProfile(base, (candidate) => blocked.has(candidate))).toBe(`${base}-3`);
    for (const suffix of [2, 3, 4]) {
      blocked.add(`${base}-${suffix}`);
    }
    expect(profile.selectFallbackProfile(base, (candidate) => blocked.has(candidate))).toBe(`${base}-5`);
  });

  it('returns null when every sibling is in use', () => {
    expect(profile.selectFallbackProfile(base, () => true)).toBeNull();
  });

  it('normalises a trailing separator and stops at the manifest limit', () => {
    expect(profile.selectFallbackProfile(`${base}\\`, () => false)).toBe(`${base}-2`);
    const seen: string[] = [];
    expect(
      profile.selectFallbackProfile(base, (candidate) => {
        seen.push(candidate);
        return true;
      }),
    ).toBeNull();
    expect(seen).toHaveLength(profile.PROFILE_FALLBACK_LAST_SUFFIX - 1);
    expect(seen[seen.length - 1]).toBe(`${base}-${profile.PROFILE_FALLBACK_LAST_SUFFIX}`);
  });

  it('names both directories and the owner in the fallback reason', () => {
    const lock: ProfileLock = {
      profileDir: base,
      path: path.join(base, LOCK),
      state: 'live',
      owner: { pid: 4242, createdAt: '2026-10-25T01:00:00.000Z' },
      error: null,
    };
    const reason = profile.profileFallbackReason(lock, `${base}-2`);
    expect(reason).toContain(base);
    expect(reason).toContain(`${base}-2`);
    expect(reason).toContain('pid 4242');
    expect(reason).toContain('separate cookies, logins and fingerprint seed');
  });
});

describe('manifest profile applicability', () => {
  it('is true unless the manifest opts out', () => {
    expect(registry.manifestProfileApplies({})).toBe(true);
    expect(registry.manifestProfileApplies({ profileApplies: true })).toBe(true);
    expect(registry.manifestProfileApplies({ profileApplies: false })).toBe(false);
  });

  it('marks the attach engine and the native engine as not applying', () => {
    const read = (id: string) =>
      JSON.parse(readFileSync(path.join(pluginDir, 'engines', `${id}.json`), 'utf8')) as {
        profileApplies?: boolean;
      };
    expect(read('kameleo').profileApplies).toBe(false);
    expect(read('camoufox-native').profileApplies).toBe(false);
    for (const id of ['cloak', 'playwright', 'camoufox']) {
      expect(registry.manifestProfileApplies(read(id))).toBe(true);
    }
  });

  it('validates the field as a boolean', () => {
    const base = {
      schemaVersion: 1,
      id: 'alpha',
      label: 'Alpha',
      transport: 'launch',
      contract: 'playwright-mcp',
      defaultToolProfile: 'full',
      toolSupport: { '*': 'full' },
      notes: 'test',
    };
    expect(registry.validateManifest({ ...base, profileApplies: true }, 'alpha', ['full'])).toBeNull();
    expect(registry.validateManifest({ ...base, profileApplies: false }, 'alpha', ['full'])).toBeNull();
    expect(registry.validateManifest({ ...base, profileApplies: 'yes' }, 'alpha', ['full'])).toBe(
      'profileApplies must be a boolean',
    );
  });
});

describe('broker profile preflight', () => {
  it('keeps the shared default healthy start byte-identical', async () => {
    const dataDir = createRuntime(tempRoot('pr10-broker-default-'));
    const session = startBroker({ dataDir });
    await initialize(session);
    expect(await toolNames(session)).toEqual([
      ...STUB_TOOLS,
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    const caps = await capabilities(session);
    expect(caps).toMatchObject({
      account: null,
      profileDir: null,
      profileSource: 'default',
      defaultProfileDir: path.join(dataDir, 'profiles', 'default'),
      profileIsolation: 'shared',
      profileIsolationSource: 'default',
      profileApplies: true,
      profileFallback: null,
    });
    expect(caps.profileLock).toMatchObject({ state: 'free' });
    expect(await effectiveEnvironment(session)).toEqual({
      profileDir: path.join(dataDir, 'profiles', 'default'),
      proxy: null,
    });
    const statusPayload = await status(session);
    expect(statusPayload.profileIsolation).toBe('shared');
    expect(statusPayload.profileApplies).toBe(true);
  });

  it('reports the explicit shared setting without changing the path', async () => {
    const dataDir = createRuntime(tempRoot('pr10-broker-shared-'));
    const session = startBroker({ dataDir, isolation: 'shared' });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps).toMatchObject({
      profileIsolation: 'shared',
      profileIsolationSource: 'setting',
      profileSource: 'default',
      profileDir: null,
    });
    expect(await effectiveEnvironment(session)).toEqual({
      profileDir: path.join(dataDir, 'profiles', 'default'),
      proxy: null,
    });
  });

  it('refuses to spawn when a live owner holds the shared profile and names it', async () => {
    const dataDir = createRuntime(tempRoot('pr10-broker-locked-'));
    const lockDir = path.join(dataDir, 'profiles', 'default');
    writeLock(lockDir, process.pid, '2026-10-25T01:09:50.197Z');
    // on_locked=block is the 2.15 behaviour; the default since 2.16.0 is
    // "fallback", which is asserted separately below.
    const session = startBroker({ dataDir, onLocked: 'block' });
    const initialized = await initialize(session);
    const instructions = initialized.result?.instructions ?? '';
    expect(instructions).toContain(lockDir);
    expect(instructions).toContain(`pid ${process.pid}`);
    expect(instructions).toContain('2026-10-25T01:09:50.197Z');
    expect(instructions).toContain('The backend was not started');
    expect(instructions).toContain('profile_isolation');
    expect(await toolNames(session)).toEqual([
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    const statusPayload = await status(session);
    expect(statusPayload.backendState).toBe('failed');
    expect(statusPayload.backendPid).toBeNull();
    expect(String(statusPayload.lastError)).toContain(lockDir);
    expect(statusPayload.profileLock).toMatchObject({
      state: 'live',
      owner: { pid: process.pid, createdAt: '2026-10-25T01:09:50.197Z' },
      profileDir: lockDir,
    });
    expect(String((statusPayload.profileLock as Record<string, unknown>).fix)).toContain(
      'Close the Claude Code session',
    );
    const caps = await capabilities(session);
    expect(String(caps.engineError)).toContain(lockDir);
    expect(caps.profileLock).toMatchObject({ state: 'live' });
    expect(caps.profileFallback).toBeNull();
    expect(session.stderr()).toContain('not starting a backend');
  });

  it('does not block on a stale lock (the backend reclaims it)', async () => {
    const dataDir = createRuntime(tempRoot('pr10-broker-stale-'));
    const root = tempRoot('pr10-broker-stale-pid-');
    writeLock(path.join(dataDir, 'profiles', 'default'), deadPid(root));
    const session = startBroker({ dataDir });
    await initialize(session);
    expect(await toolNames(session)).toContain('browser_navigate');
    const caps = await capabilities(session);
    expect(caps.profileLock).toMatchObject({ state: 'stale' });
    expect(caps.profileFallback).toBeNull();
    expect(session.stderr()).toContain('is stale');
  });

  it('derives and uses the workspace profile when isolation is workspace', async () => {
    const dataDir = createRuntime(tempRoot('pr10-broker-workspace-'));
    const workspace = path.join(tempRoot('pr10-workspace-cwd-'), 'project');
    mkdirSync(workspace, { recursive: true });
    const session = startBroker({ dataDir, isolation: 'workspace', cwd: workspace });
    const initialized = await initialize(session);
    // A healthy start carries no profile text; the artifact sentence is the only
    // instruction. This harness declares no roots capability, so since 2.10.1 the
    // empty output_dir takes the plugin-data default (not the workspace cwd).
    expect(initialized.result?.instructions).toContain(
      `Browser artifacts (screenshots, traces, downloads) go to ${path.join(dataDir, 'output', 'cloak')}`,
    );
    expect(initialized.result?.instructions).not.toContain('profile_isolation');
    expect(await toolNames(session)).toContain('browser_navigate');
    const expected = path.join(dataDir, 'profiles', 'cloak', profile.workspaceProfileName(workspace));
    const caps = await capabilities(session);
    expect(caps).toMatchObject({
      profileIsolation: 'workspace',
      profileIsolationSource: 'setting',
      profileSource: 'workspace',
      profileDir: expected,
      profileFallback: null,
    });
    expect(await effectiveEnvironment(session)).toEqual({ profileDir: expected, proxy: null });
  });

  it('falls back to the first free numbered sibling and reports it', async () => {
    const dataDir = createRuntime(tempRoot('pr10-broker-fallback-'));
    const workspace = path.join(tempRoot('pr10-workspace-fallback-'), 'project');
    mkdirSync(workspace, { recursive: true });
    const base = path.join(dataDir, 'profiles', 'cloak', profile.workspaceProfileName(workspace));
    writeLock(base, process.pid, '2026-10-25T01:20:00.000Z');
    // -2 is also owned by a live process, so it is skipped. -3 holds a stale
    // lock only, which does not block the start; the bridge reclaims it.
    writeLock(`${base}-2`, process.pid);
    writeLock(`${base}-3`, deadPid(tempRoot('pr10-fallback-dead-')));
    const session = startBroker({ dataDir, isolation: 'workspace', cwd: workspace });
    const initialized = await initialize(session);
    const instructions = initialized.result?.instructions ?? '';
    expect(instructions).toContain(base);
    expect(instructions).toContain(`${base}-3`);
    expect(instructions).toContain('separate cookies, logins and fingerprint seed');
    expect(await toolNames(session)).toContain('browser_navigate');
    const caps = await capabilities(session);
    const fallback = caps.profileFallback as Record<string, unknown>;
    expect(fallback).toMatchObject({ from: base, to: `${base}-3` });
    expect(String(fallback.reason)).toContain(`pid ${process.pid}`);
    expect(caps.profileDir).toBe(`${base}-3`);
    // The chosen sibling already held a stale lock; it does not block and the
    // bridge reclaims it, so the state is reported honestly as stale.
    expect(caps.profileLock).toMatchObject({ state: 'stale', profileDir: `${base}-3` });
    expect(await effectiveEnvironment(session)).toEqual({ profileDir: `${base}-3`, proxy: null });
    const statusPayload = await status(session);
    expect(statusPayload.profileFallback).toMatchObject({ from: base, to: `${base}-3` });
    expect(session.stderr()).toContain('so this session uses');
  });

  it('refuses to spawn when every workspace sibling is in use', async () => {
    const dataDir = createRuntime(tempRoot('pr10-broker-exhausted-'));
    const workspace = path.join(tempRoot('pr10-workspace-exhausted-'), 'project');
    mkdirSync(workspace, { recursive: true });
    const base = path.join(dataDir, 'profiles', 'cloak', profile.workspaceProfileName(workspace));
    for (const suffix of ['', '-2', '-3', '-4', '-5']) {
      writeLock(`${base}${suffix}`, process.pid);
    }
    const session = startBroker({ dataDir, isolation: 'workspace', cwd: workspace });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain('numbered workspace fallbacks');
    expect(await toolNames(session)).toEqual([
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    const caps = await capabilities(session);
    expect(caps.profileFallback).toBeNull();
    expect(caps.profileLock).toMatchObject({ state: 'live', profileDir: base });
    expect(String(caps.engineError)).toContain('numbered workspace fallbacks');
  });

  it('keeps an account above the workspace derivation and does not fall it back under block', async () => {
    const dataDir = createRuntime(tempRoot('pr10-broker-account-'));
    const workspace = path.join(tempRoot('pr10-workspace-account-'), 'project');
    mkdirSync(workspace, { recursive: true });
    const accountDir = path.join(dataDir, 'profiles', 'cloak', 'alice');
    writeLock(accountDir, process.pid);
    const session = startBroker({
      dataDir,
      isolation: 'workspace',
      cwd: workspace,
      account: 'alice',
      onLocked: 'block',
    });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain(accountDir);
    expect(await toolNames(session)).toEqual([
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    const caps = await capabilities(session);
    expect(caps).toMatchObject({
      account: 'alice',
      profileSource: 'account',
      profileFallback: null,
      profileLock: { state: 'live', profileDir: accountDir },
    });
  });

  it('keeps an explicit profile_dir above the workspace and does not fall it back', async () => {
    const dataDir = createRuntime(tempRoot('pr10-broker-explicit-'));
    const workspace = path.join(tempRoot('pr10-workspace-explicit-'), 'project');
    mkdirSync(workspace, { recursive: true });
    const explicit = path.join(tempRoot('pr10-explicit-profile-'), 'profile');
    writeLock(explicit, process.pid);
    const session = startBroker({
      dataDir,
      isolation: 'workspace',
      cwd: workspace,
      account: 'alice',
      profileDir: explicit,
    });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain(explicit);
    expect(await toolNames(session)).toEqual([
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    const caps = await capabilities(session);
    expect(caps).toMatchObject({ profileSource: 'profile_dir', profileFallback: null });
    expect(caps.profileLock).toMatchObject({ state: 'live', profileDir: explicit });
  });

  it('never leaks a proxy credential into a payload or a log', async () => {
    const dataDir = createRuntime(tempRoot('pr10-broker-secret-'));
    const workspace = path.join(tempRoot('pr10-workspace-secret-'), 'project');
    mkdirSync(workspace, { recursive: true });
    const base = path.join(dataDir, 'profiles', 'cloak', profile.workspaceProfileName(workspace));
    writeLock(base, process.pid);
    const session = startBroker({
      dataDir,
      isolation: 'workspace',
      cwd: workspace,
      proxyServer: PROXY_URL,
    });
    await initialize(session);
    const caps = await capabilities(session);
    const statusPayload = await status(session);
    const blob = `${JSON.stringify(caps)}${JSON.stringify(statusPayload)}${session.stderr()}`;
    expect(blob).not.toContain(PROXY_SECRET);
    expect(caps.profileFallback).not.toBeNull();
    expect((await effectiveEnvironment(session)).proxy).toBe(PROXY_URL);
  });

  it('surfaces the last stderr line for an engine without a runtime hint', async () => {
    const dataDir = createRuntime(tempRoot('pr10-broker-stderr-'));
    const session = startBroker({ dataDir, failBackend: true });
    const initialized = await initialize(session);
    const instructions = initialized.result?.instructions ?? '';
    expect(instructions).toContain('Backend exited (code 1)');
    expect(instructions).toContain('fatal: stub backend exploded');
    const statusPayload = await status(session);
    expect(String(statusPayload.lastError)).toContain('fatal: stub backend exploded');
    expect(String(statusPayload.backendStderrTail)).toContain('fatal: stub backend exploded');
  });

  it('advertises the profile diagnostic in both meta-tool descriptions', async () => {
    const dataDir = createRuntime(tempRoot('pr10-broker-meta-'));
    const session = startBroker({ dataDir });
    const list = await session.request('tools/list', {});
    for (const name of ['browser_capabilities', 'browser_engine_status']) {
      const tool = (list.result?.tools ?? []).find((entry) => entry.name === name);
      expect(tool?.description).toContain('the profile directory, the owning process and the fix');
    }
  });
});

describe('broker manifest applicability', () => {
  it('does not preflight or resolve a profile for a profileApplies:false engine', async () => {
    const root = tempRoot('pr10-broker-attach-');
    const plugin = createScratchPlugin(root);
    const dataDir = createRuntime(path.join(root, 'data'));
    const profileDir = path.join(dataDir, 'profiles', 'attach-test', 'default');
    writeLock(profileDir, process.pid);
    const session = startBroker({ dataDir, engine: 'attach-test', pluginDir: plugin });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps).toMatchObject({
      engine: 'attach-test',
      profileApplies: false,
      profileSource: 'engine',
      profileFallback: null,
      profileLock: null,
    });
    // The stub backend was started despite the live lock file: the preflight is
    // manifest-scoped, not engine-id-scoped.
    expect(await toolNames(session)).toEqual([
      ...STUB_TOOLS,
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    expect(await effectiveEnvironment(session)).toEqual({ profileDir: null, proxy: null });
  });
});
