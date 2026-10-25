import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Default-profile pointer (2.10.0). `profiles/<engine>/.default` holds one
// profile name; the broker reads it at start and applies it only after
// `profile_dir` and `account`. This suite pins the whole precedence matrix, the
// broken-pointer behaviour, the atomic write, the browser_profiles meta-tool
// (including the meta-only recovery start) and the CLI. Every guard is
// mutation-checked by the PR.

interface PointerRead {
  path: string;
  exists: boolean;
  name: string | null;
  state: 'missing' | 'present' | 'invalid';
  error: string | null;
}

interface ProfileResolution {
  profileDir: string | null;
  defaultProfileDir: string;
  profileSource: string | null;
  account: string | null;
  accountApplies: boolean;
  error: string | null;
}

interface ProfileModule {
  PROFILE_DEFAULT_POINTER_FILENAME: string;
  profileDefaultPointerPath(engineId: string, dataDir: string): string;
  profileDefaultPointerDir(
    engineId: string,
    dataDir: string,
    name: string,
    launcherName?: string,
  ): string | null;
  readProfileDefaultPointer(engineId: string, dataDir: string): PointerRead;
  writeProfileDefaultPointer(
    engineId: string,
    dataDir: string,
    name: string,
  ): { path: string; written: boolean; error: string | null };
  resolveProfile(options: {
    account?: string;
    profileDir?: string;
    pointer?: string | null;
    engineId: string;
    dataDir: string;
    launcherName?: string;
    ignoredSettings?: string[];
    profileApplies?: boolean;
    isolation?: string;
    cwd?: string;
  }): ProfileResolution;
  effectiveProfileDir(resolution: ProfileResolution): string | null;
}

interface CliModule {
  runProfileDefault(options: {
    engine?: string;
    set?: string | null;
    dataDir?: string | null;
    dryRun?: boolean;
    env?: Record<string, string | undefined>;
    home?: string;
    pluginRoot?: string;
  }): { ok: boolean; summary?: Record<string, unknown>; error?: { code: string; message: string } };
  parseArguments(argv: string[]): { options: Record<string, unknown>; errors: string[] };
  formatHumanSummary(summary: Record<string, unknown>): string;
}

interface JsonRpcResponse {
  id?: number;
  result?: {
    tools?: { name: string; description?: string }[];
    content?: { type: string; text?: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    instructions?: string;
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
  account?: string;
  profileDir?: string;
  engine?: string;
  pluginDir?: string;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const brokerPath = path.join(pluginDir, 'broker.mjs');
const profile = (await import(
  new URL('../../plugins/cloakbrowser/lib/profile.mjs', import.meta.url).href
)) as unknown as ProfileModule;
const cli = (await import(
  new URL('../../plugins/cloakbrowser/scripts/profile-default.mjs', import.meta.url).href
)) as unknown as CliModule;

const DATA_DIR = path.resolve('D:/scratch/pr-default-data');
const CWD = 'D:\\Projects2\\StealthBrowserAutomation';
const LOCK = '.cloakbrowser-mcp-profile.lock';
const STUB_TOOLS = ['browser_navigate', 'browser_snapshot'];

const STUB_SOURCE = `#!/usr/bin/env node
const readline = require('node:readline');
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-default', version: '0.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} } })) } });
    return;
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ profileDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? null, proxy: process.env.PLAYWRIGHT_MCP_PROXY_SERVER ?? null }) }], isError: false } });
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
  // Canonicalize the fixture path: macOS TMPDIR is under /var, which is a
  // symlink to /private/var, while the broker child's process.cwd() reports the
  // physical path. Every path derived from this root must match the child's.
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
  for (const name of ['STEALTH_ACCOUNT', 'STEALTH_PROFILE_ISOLATION', 'PLAYWRIGHT_MCP_USER_DATA_DIR']) {
    delete childEnv[name];
  }
  if (options.account !== undefined) childEnv.STEALTH_ACCOUNT = options.account;
  if (options.isolation !== undefined) childEnv.STEALTH_PROFILE_ISOLATION = options.isolation;
  if (options.profileDir !== undefined) childEnv.PLAYWRIGHT_MCP_USER_DATA_DIR = options.profileDir;
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

async function profilesCall(
  session: BrokerSession,
  args: Record<string, unknown> = {},
): Promise<JsonRpcResponse> {
  return session.request('tools/call', { name: 'browser_profiles', arguments: args });
}

async function profilesPayload(
  session: BrokerSession,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await profilesCall(session, args);
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

function pointerFile(dataDir: string, engine = 'cloak'): string {
  return path.join(dataDir, 'profiles', engine, '.default');
}

function writePointer(dataDir: string, text: string, engine = 'cloak'): string {
  const file = pointerFile(dataDir, engine);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

describe('default-profile pointer file', () => {
  it('is missing, present or invalid, and never throws', () => {
    const root = tempRoot('pr-default-read-');
    expect(profile.readProfileDefaultPointer('cloak', root)).toEqual({
      path: path.join(root, 'profiles', 'cloak', '.default'),
      exists: false,
      name: null,
      state: 'missing',
      error: null,
    });

    writePointer(root, 'work\n');
    expect(profile.readProfileDefaultPointer('cloak', root)).toEqual({
      path: path.join(root, 'profiles', 'cloak', '.default'),
      exists: true,
      name: 'work',
      state: 'present',
      error: null,
    });

    // CRLF, surrounding whitespace and no trailing newline are all one name.
    writePointer(root, '  alice \r\n');
    expect(profile.readProfileDefaultPointer('cloak', root)).toMatchObject({
      name: 'alice',
      state: 'present',
    });
  });

  it('reports an empty, multi-line, unreadable or invalid pointer as invalid', () => {
    const root = tempRoot('pr-default-invalid-');
    const cases: [string, RegExp][] = [
      ['', /is empty; it is ignored\.$/],
      ['\r\n   \n', /is empty; it is ignored\.$/],
      ['alice\nwork\n', /exactly one profile name; it is ignored\.$/],
      ['../escape\n', /does not name a valid profile/],
      ['CON\n', /does not name a valid profile/],
      ['alice.\n', /does not name a valid profile/],
    ];
    for (const [text, expected] of cases) {
      writePointer(root, text);
      const read = profile.readProfileDefaultPointer('cloak', root);
      expect(read.state).toBe('invalid');
      expect(read.name).toBeNull();
      expect(read.exists).toBe(true);
      expect(read.error).toMatch(expected);
    }
  });

  it('reports a non-UTF-8 pointer and a directory in its place as invalid', () => {
    const root = tempRoot('pr-default-bytes-');
    const file = pointerFile(root);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00]));
    expect(profile.readProfileDefaultPointer('cloak', root)).toMatchObject({
      state: 'invalid',
      name: null,
    });
    expect(profile.readProfileDefaultPointer('cloak', root).error).toContain('not valid UTF-8');

    rmSync(file, { force: true });
    mkdirSync(file, { recursive: true });
    const asDirectory = profile.readProfileDefaultPointer('cloak', root);
    expect(asDirectory.state).toBe('invalid');
    expect(asDirectory.error).toContain('not a regular file');
    rmSync(file, { recursive: true, force: true });
  });

  it('maps "default" to the engine default and any other name to an account dir', () => {
    expect(profile.profileDefaultPointerDir('cloak', DATA_DIR, 'default', 'launch.mjs')).toBe(
      path.join(DATA_DIR, 'profiles', 'default'),
    );
    expect(profile.profileDefaultPointerDir('cloak', DATA_DIR, 'work', 'launch.mjs')).toBe(
      path.join(DATA_DIR, 'profiles', 'cloak', 'work'),
    );
    expect(profile.profileDefaultPointerDir('camoufox', DATA_DIR, 'default', 'launch-camoufox.mjs')).toBe(
      path.join(DATA_DIR, 'profiles', 'camoufox', 'default'),
    );
    expect(profile.profileDefaultPointerDir('camoufox', DATA_DIR, 'work', 'launch-camoufox.mjs')).toBe(
      path.join(DATA_DIR, 'profiles', 'camoufox', 'work'),
    );
    expect(profile.profileDefaultPointerDir('cloak', DATA_DIR, '../x')).toBeNull();
  });

  it('writes one line atomically, creates the directory and replaces an existing pointer', () => {
    const root = tempRoot('pr-default-write-');
    const written = profile.writeProfileDefaultPointer('cloak', root, ' work ');
    expect(written).toEqual({ path: pointerFile(root), written: true, error: null });
    expect(readFileSync(pointerFile(root), 'utf8')).toBe('work\n');
    // No temporary sibling survives the rename.
    expect(existsSync(`${pointerFile(root)}.${process.pid}.tmp`)).toBe(false);

    const replaced = profile.writeProfileDefaultPointer('cloak', root, 'alice');
    expect(replaced.written).toBe(true);
    expect(readFileSync(pointerFile(root), 'utf8')).toBe('alice\n');
    expect(profile.readProfileDefaultPointer('cloak', root).name).toBe('alice');
  });

  it('refuses an invalid name without writing', () => {
    const root = tempRoot('pr-default-write-invalid-');
    for (const name of ['', '   ', '../x', 'alice/', 'CON', 'a'.repeat(65)]) {
      const result = profile.writeProfileDefaultPointer('cloak', root, name);
      expect(result.written).toBe(false);
      expect(result.error).toContain('Invalid account name');
      expect(existsSync(pointerFile(root))).toBe(false);
    }
  });
});

describe('default-profile pointer precedence', () => {
  it('keeps every existing resolution byte-identical when no pointer is set', () => {
    const options = { account: '', engineId: 'cloak', dataDir: DATA_DIR };
    expect(profile.resolveProfile(options)).toEqual({
      profileDir: null,
      defaultProfileDir: path.join(DATA_DIR, 'profiles', 'default'),
      profileSource: 'default',
      account: null,
      accountApplies: true,
      error: null,
    });
    expect(profile.resolveProfile({ ...options, pointer: null })).toEqual(profile.resolveProfile(options));
    expect(profile.resolveProfile({ ...options, pointer: '   ' })).toEqual(profile.resolveProfile(options));
    expect(profile.resolveProfile({ ...options, pointer: '${user_config.account}' })).toEqual(
      profile.resolveProfile(options),
    );
  });

  it('applies the pointer after profile_dir and account, and before workspace and the engine default', () => {
    const pointerDir = path.join(DATA_DIR, 'profiles', 'cloak', 'work');
    const base = { engineId: 'cloak', dataDir: DATA_DIR, pointer: 'work' };

    // Pointer over the engine default.
    expect(profile.resolveProfile({ ...base, account: '' })).toMatchObject({
      profileDir: pointerDir,
      profileSource: 'pointer',
      account: null,
      accountApplies: true,
      error: null,
    });

    // Pointer over workspace isolation.
    expect(
      profile.resolveProfile({ ...base, account: '', isolation: 'workspace', cwd: CWD }),
    ).toMatchObject({ profileDir: pointerDir, profileSource: 'pointer' });

    // Account over the pointer.
    expect(
      profile.resolveProfile({
        ...base,
        account: 'alice',
        isolation: 'workspace',
        cwd: CWD,
      }),
    ).toMatchObject({
      profileDir: path.join(DATA_DIR, 'profiles', 'cloak', 'alice'),
      profileSource: 'account',
      account: 'alice',
    });

    // profile_dir over everything.
    const explicit = profile.resolveProfile({
      ...base,
      account: 'alice',
      profileDir: 'D:/explicit/../profile',
      isolation: 'workspace',
      cwd: CWD,
    });
    expect(explicit).toMatchObject({ profileSource: 'profile_dir', profileDir: 'D:/explicit/../profile' });
  });

  it('maps a pointer named "default" to the engine default directory', () => {
    expect(profile.resolveProfile({ engineId: 'cloak', dataDir: DATA_DIR, pointer: 'default' })).toMatchObject({
      profileDir: path.join(DATA_DIR, 'profiles', 'default'),
      profileSource: 'pointer',
    });
    expect(
      profile.resolveProfile({
        engineId: 'camoufox',
        dataDir: DATA_DIR,
        launcherName: 'launch-camoufox.mjs',
        pointer: 'default',
      }),
    ).toMatchObject({
      profileDir: path.join(DATA_DIR, 'profiles', 'camoufox', 'default'),
      profileSource: 'pointer',
    });
  });

  it('falls back to the workspace, then the engine default, when there is no usable pointer', () => {
    expect(
      profile.resolveProfile({ engineId: 'cloak', dataDir: DATA_DIR, isolation: 'workspace', cwd: CWD }),
    ).toMatchObject({ profileSource: 'workspace' });
    expect(profile.resolveProfile({ engineId: 'cloak', dataDir: DATA_DIR })).toMatchObject({
      profileSource: 'default',
    });
    // An invalid name passed directly is ignored rather than made fatal.
    expect(profile.resolveProfile({ engineId: 'cloak', dataDir: DATA_DIR, pointer: '../x' })).toMatchObject(
      { profileSource: 'default', profileDir: null, error: null },
    );
    expect(
      profile.resolveProfile({
        engineId: 'cloak',
        dataDir: DATA_DIR,
        pointer: '../x',
        isolation: 'workspace',
        cwd: CWD,
      }),
    ).toMatchObject({ profileSource: 'workspace' });
  });

  it('is inert for an engine whose profile the broker does not own', () => {
    expect(
      profile.resolveProfile({
        engineId: 'kameleo',
        dataDir: DATA_DIR,
        pointer: 'work',
        profileApplies: false,
      }),
    ).toMatchObject({ profileSource: 'engine', accountApplies: false, profileDir: null });
  });

  it('resolves the effective directory the lock preflight reads', () => {
    const pointer = profile.resolveProfile({ engineId: 'cloak', dataDir: DATA_DIR, pointer: 'work' });
    expect(profile.effectiveProfileDir(pointer)).toBe(path.join(DATA_DIR, 'profiles', 'cloak', 'work'));
  });
});

describe('broker default-profile pointer', () => {
  it('reports the engine default when no pointer exists', async () => {
    const dataDir = createRuntime(tempRoot('pr-default-broker-none-'));
    const session = startBroker({ dataDir });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps).toMatchObject({
      profileSource: 'default',
      profileDir: null,
      defaultProfileDir: path.join(dataDir, 'profiles', 'default'),
      profileDefault: null,
      profileDefaultSource: 'none',
      profileDefaultPath: path.join(dataDir, 'profiles', 'cloak', '.default'),
    });
    expect(Object.hasOwn(caps, 'profileDefaultError')).toBe(false);
    expect(await effectiveEnvironment(session)).toEqual({
      profileDir: path.join(dataDir, 'profiles', 'default'),
      proxy: null,
    });
  });

  it('applies the pointer, passes it to the engine and creates the directory', async () => {
    const dataDir = createRuntime(tempRoot('pr-default-broker-pointer-'));
    writePointer(dataDir, 'work\n');
    const session = startBroker({ dataDir });
    await initialize(session);
    const expected = path.join(dataDir, 'profiles', 'cloak', 'work');
    const caps = await capabilities(session);
    expect(caps).toMatchObject({
      profileSource: 'pointer',
      profileDir: expected,
      profileDefault: 'work',
      profileDefaultSource: 'pointer',
      profileDefaultPath: pointerFile(dataDir),
      profileLock: { state: 'free', profileDir: expected },
    });
    expect(await effectiveEnvironment(session)).toEqual({ profileDir: expected, proxy: null });
    expect(existsSync(expected)).toBe(true);
    expect(session.stderr()).toContain(`using the default profile "work"`);
  });

  it('maps a pointer named "default" to the engine default', async () => {
    const dataDir = createRuntime(tempRoot('pr-default-broker-default-'));
    writePointer(dataDir, 'default\n');
    const session = startBroker({ dataDir });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps).toMatchObject({
      profileSource: 'pointer',
      profileDefault: 'default',
      profileDir: path.join(dataDir, 'profiles', 'default'),
    });
    expect(await effectiveEnvironment(session)).toEqual({
      profileDir: path.join(dataDir, 'profiles', 'default'),
      proxy: null,
    });
  });

  it('lets account and profile_dir override the pointer while still reporting it', async () => {
    const root = tempRoot('pr-default-broker-override-');
    const dataDir = createRuntime(root);
    writePointer(dataDir, 'work\n');

    const accountSession = startBroker({ dataDir, account: 'alice' });
    await initialize(accountSession);
    const accountCaps = await capabilities(accountSession);
    expect(accountCaps).toMatchObject({
      account: 'alice',
      profileSource: 'account',
      profileDir: path.join(dataDir, 'profiles', 'cloak', 'alice'),
      profileDefault: 'work',
      profileDefaultSource: 'pointer',
    });

    const explicit = path.join(root, 'explicit-profile');
    const explicitSession = startBroker({ dataDir, account: 'alice', profileDir: explicit });
    await initialize(explicitSession);
    // An explicit profile_dir is passed straight to the launcher, so the broker
    // reports no resolved directory (the 2.9.x behaviour); only the source and
    // the pointer facts are its own.
    expect(await capabilities(explicitSession)).toMatchObject({
      profileSource: 'profile_dir',
      profileDir: null,
      profileDefault: 'work',
    });
  });

  it('lets the pointer win over workspace isolation', async () => {
    const dataDir = createRuntime(tempRoot('pr-default-broker-workspace-'));
    const workspace = path.join(tempRoot('pr-default-workspace-cwd-'), 'project');
    mkdirSync(workspace, { recursive: true });
    writePointer(dataDir, 'work\n');
    const session = startBroker({ dataDir, isolation: 'workspace', cwd: workspace });
    await initialize(session);
    const expected = path.join(dataDir, 'profiles', 'cloak', 'work');
    expect(await capabilities(session)).toMatchObject({
      profileIsolation: 'workspace',
      profileSource: 'pointer',
      profileDir: expected,
    });
    expect(await effectiveEnvironment(session)).toEqual({ profileDir: expected, proxy: null });
  });

  it('ignores an invalid pointer: reported once, the next source applies, never fatal', async () => {
    const dataDir = createRuntime(tempRoot('pr-default-broker-invalid-'));
    writePointer(dataDir, 'alice\nwork\n');
    const session = startBroker({ dataDir });
    const initialized = await initialize(session);
    expect(initialized.error).toBeUndefined();
    const caps = await capabilities(session);
    expect(caps).toMatchObject({
      profileSource: 'default',
      profileDir: null,
      profileDefault: null,
      profileDefaultSource: 'invalid',
      profileDefaultPath: pointerFile(dataDir),
    });
    expect(String(caps.profileDefaultError)).toContain('must contain exactly one profile name');
    expect(caps.engineError).toBeNull();
    const occurrences = session.stderr().split('must contain exactly one profile name').length - 1;
    expect(occurrences).toBe(1);
    expect(await effectiveEnvironment(session)).toEqual({
      profileDir: path.join(dataDir, 'profiles', 'default'),
      proxy: null,
    });
  });

  it('falls through an invalid pointer to the workspace profile when isolation is workspace', async () => {
    const dataDir = createRuntime(tempRoot('pr-default-broker-invalid-ws-'));
    const workspace = path.join(tempRoot('pr-default-workspace-invalid-'), 'project');
    mkdirSync(workspace, { recursive: true });
    writePointer(dataDir, '../escape\n');
    const session = startBroker({ dataDir, isolation: 'workspace', cwd: workspace });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps).toMatchObject({
      profileSource: 'workspace',
      profileDefaultSource: 'invalid',
      profileFallback: null,
    });
    expect(String(caps.profileDefaultError)).toContain('does not name a valid profile');
  });

  it('uses the proxy file beside a pointer-named profile', async () => {
    const dataDir = createRuntime(tempRoot('pr-default-broker-proxy-'));
    writePointer(dataDir, 'work\n');
    writeFileSync(path.join(dataDir, 'profiles', 'cloak', 'work.proxy'), 'http://proxy.example:8080\n');
    const session = startBroker({ dataDir });
    await initialize(session);
    expect(await effectiveEnvironment(session)).toEqual({
      profileDir: path.join(dataDir, 'profiles', 'cloak', 'work'),
      proxy: 'http://proxy.example:8080',
    });
    expect(session.stderr()).toContain('beside the default-profile profile');
  });
});

describe('browser_profiles meta-tool', () => {
  it('is always listed, including the meta-only recovery start', async () => {
    const dataDir = createRuntime(tempRoot('pr-default-tool-locked-'));
    const lockDir = path.join(dataDir, 'profiles', 'default');
    writeLock(lockDir, process.pid);
    const session = startBroker({ dataDir });
    const initialized = await initialize(session);
    expect(String(initialized.result?.instructions)).toContain('Only broker meta-tools are exposed');
    expect(await toolNames(session)).toEqual([
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    const payload = await profilesPayload(session);
    expect(payload).toMatchObject({
      action: 'list',
      engine: 'cloak',
      profileApplies: true,
      applies: 'next server start',
    });
    expect((payload.current as Record<string, unknown>).profileLock).toMatchObject({ state: 'live' });
  });

  it('lists the engine, profiles, current profile, pointer and lock', async () => {
    const dataDir = createRuntime(tempRoot('pr-default-tool-list-'));
    writePointer(dataDir, 'work\n');
    mkdirSync(path.join(dataDir, 'profiles', 'cloak', 'alice'), { recursive: true });
    const session = startBroker({ dataDir });
    await initialize(session);
    const payload = await profilesPayload(session);
    expect(payload).toMatchObject({
      action: 'list',
      engine: 'cloak',
      label: 'CloakBrowser (stealth Chromium)',
      profileApplies: true,
      applies: 'next server start',
    });
    const current = payload.current as Record<string, unknown>;
    expect(current).toMatchObject({
      account: null,
      profileSource: 'pointer',
      profileDir: path.join(dataDir, 'profiles', 'cloak', 'work'),
      defaultProfileDir: path.join(dataDir, 'profiles', 'default'),
      profileIsolation: 'shared',
      profileIsolationSource: 'default',
    });
    expect(current.profileLock).toMatchObject({ state: 'free' });
    const pointer = payload.pointer as Record<string, unknown>;
    expect(pointer).toMatchObject({
      path: pointerFile(dataDir),
      exists: true,
      name: 'work',
      state: 'present',
      targetDir: path.join(dataDir, 'profiles', 'cloak', 'work'),
      targetExists: true,
    });
    const available = payload.availableProfiles as { names: string[]; count: number };
    expect(available.names).toContain('alice');
    expect(available.names).toContain('work');
    expect(available.count).toBeGreaterThanOrEqual(2);
  });

  it('writes the pointer with set-default, applies it at the next start, and never restarts the backend', async () => {
    const dataDir = createRuntime(tempRoot('pr-default-tool-set-'));
    const session = startBroker({ dataDir });
    await initialize(session);
    const before = await effectiveEnvironment(session);
    expect(before.profileDir).toBe(path.join(dataDir, 'profiles', 'default'));

    const response = await profilesCall(session, { action: 'set-default', name: 'work' });
    expect(response.result?.isError).not.toBe(true);
    const payload = response.result?.structuredContent ?? {};
    expect(payload).toMatchObject({
      action: 'set-default',
      ok: true,
      engine: 'cloak',
      name: 'work',
      applies: 'next server start',
    });
    expect(String(payload.note)).toContain('next server start');
    expect(readFileSync(pointerFile(dataDir), 'utf8')).toBe('work\n');
    // This session still runs on the profile it started with.
    expect(await effectiveEnvironment(session)).toEqual(before);
    // The list action re-reads the pointer at call time, so it sees the write.
    expect((await profilesPayload(session)).pointer).toMatchObject({ name: 'work', state: 'present' });

    const restarted = startBroker({ dataDir });
    await initialize(restarted);
    expect(await capabilities(restarted)).toMatchObject({
      profileSource: 'pointer',
      profileDir: path.join(dataDir, 'profiles', 'cloak', 'work'),
    });
    expect(await effectiveEnvironment(restarted)).toEqual({
      profileDir: path.join(dataDir, 'profiles', 'cloak', 'work'),
      proxy: null,
    });
  });

  it('refuses an invalid or missing name with an isError result and writes nothing', async () => {
    const dataDir = createRuntime(tempRoot('pr-default-tool-invalid-'));
    const session = startBroker({ dataDir });
    await initialize(session);
    for (const args of [{ action: 'set-default', name: '../escape' }, { action: 'set-default' }, { action: 'set-default', name: 'bad/name' }]) {
      const response = await profilesCall(session, args);
      expect(response.result?.isError).toBe(true);
      expect(String(response.result?.content?.[0]?.text)).toContain('browser_profiles set-default');
    }
    expect(
      String((await profilesCall(session, { action: 'set-default', name: 'bad/name' })).result?.content?.[0]?.text),
    ).toContain('Invalid account name');
    expect(existsSync(pointerFile(dataDir))).toBe(false);
    // No action at all is a read, not a write.
    const listed = await profilesCall(session, {});
    expect(listed.result?.isError).not.toBe(true);
    expect(listed.result?.structuredContent).toMatchObject({ action: 'list' });
  });

  it('rejects an unknown action with a clear error', async () => {
    const dataDir = createRuntime(tempRoot('pr-default-tool-action-'));
    const session = startBroker({ dataDir });
    await initialize(session);
    const response = await profilesCall(session, { action: 'delete' });
    expect(response.result?.isError).toBe(true);
    expect(String(response.result?.content?.[0]?.text)).toContain('Unknown browser_profiles action "delete"');
  });

  it('reports profileApplies false and refuses set-default for an engine without broker profiles', async () => {
    const dataDir = createRuntime(tempRoot('pr-default-tool-kameleo-'));
    const session = startBroker({ dataDir, engine: 'kameleo' });
    await initialize(session);
    const listed = await profilesPayload(session);
    expect(listed).toMatchObject({ profileApplies: false, pointer: null });
    expect((listed.current as Record<string, unknown>).profileDir).toBeNull();
    const response = await profilesCall(session, { action: 'set-default', name: 'work' });
    expect(response.result?.isError).toBe(true);
    expect(String(response.result?.content?.[0]?.text)).toContain('does not use broker profiles');
  });
});

describe('profile-default CLI', () => {
  it('shows, sets, dry-runs and reports JSON', () => {
    const root = tempRoot('pr-default-cli-');
    const dataDir = path.join(root, 'data');
    const show = cli.runProfileDefault({ engine: 'cloak', dataDir, env: {}, home: root });
    expect(show.ok).toBe(true);
    expect(show.summary).toMatchObject({
      action: 'show',
      engine: 'cloak',
      dataDir,
      applies: 'next server start',
    });
    expect((show.summary?.pointer as Record<string, unknown>).state).toBe('missing');

    const dry = cli.runProfileDefault({ engine: 'cloak', dataDir, set: 'work', dryRun: true, env: {}, home: root });
    expect(dry.ok).toBe(true);
    expect(dry.summary).toMatchObject({ action: 'set-default', name: 'work', dryRun: true, written: false });
    expect(existsSync(pointerFile(dataDir))).toBe(false);

    const set = cli.runProfileDefault({ engine: 'cloak', dataDir, set: 'work', env: {}, home: root });
    expect(set.ok).toBe(true);
    expect(set.summary).toMatchObject({ action: 'set-default', name: 'work', written: true });
    expect(readFileSync(pointerFile(dataDir), 'utf8')).toBe('work\n');

    const shown = cli.runProfileDefault({ engine: 'cloak', dataDir, env: {}, home: root });
    expect(shown.summary?.pointer).toMatchObject({
      name: 'work',
      state: 'present',
      targetDir: path.join(dataDir, 'profiles', 'cloak', 'work'),
      targetExists: false,
    });
    const text = cli.formatHumanSummary(shown.summary as Record<string, unknown>);
    expect(text).toContain('created on the next launch');
    expect(text).toContain('next server start');
  });

  it('falls back to CLAUDE_PLUGIN_DATA and then to the home directory', () => {
    const root = tempRoot('pr-default-cli-env-');
    const fromEnv = cli.runProfileDefault({
      engine: 'cloak',
      env: { CLAUDE_PLUGIN_DATA: path.join(root, 'env-data') },
      home: root,
    });
    expect(fromEnv.summary?.dataDir).toBe(path.join(root, 'env-data'));
    const fromHome = cli.runProfileDefault({ engine: 'cloak', env: {}, home: root });
    expect(fromHome.summary?.dataDir).toBe(path.join(root, '.cloakbrowser-mcp-plugin'));
  });

  it('refuses an invalid name, an unknown engine and an engine without broker profiles', () => {
    const root = tempRoot('pr-default-cli-refuse-');
    const dataDir = path.join(root, 'data');
    const invalid = cli.runProfileDefault({ engine: 'cloak', dataDir, set: '../escape', env: {}, home: root });
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe('invalid-name');
    expect(invalid.error?.message).toContain('Invalid account name');

    const unknown = cli.runProfileDefault({ engine: 'nope', dataDir, env: {}, home: root });
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe('unknown-engine');

    const native = cli.runProfileDefault({ engine: 'camoufox-native', dataDir, env: {}, home: root });
    expect(native.ok).toBe(false);
    expect(native.error?.code).toBe('engine-no-profiles');
    expect(native.error?.message).toContain('profileApplies: false');
  });

  it('parses arguments and rejects a conflicting pair', () => {
    expect(cli.parseArguments(['--set', 'work', '--json'])).toEqual({
      options: {
        engine: 'cloak',
        set: 'work',
        dataDir: null,
        show: false,
        dryRun: false,
        json: true,
        help: false,
      },
      errors: [],
    });
    expect(cli.parseArguments(['--set', 'work', '--show']).errors).toContain(
      '--show and --set cannot be combined.',
    );
    expect(cli.parseArguments(['--set']).errors).toContain('--set needs a value.');
    expect(cli.parseArguments(['--bogus']).errors).toContain('Unknown option "--bogus".');
    expect(cli.parseArguments(['--help']).errors).toEqual([]);
  });

  it('runs as a script with real exit codes', () => {
    const root = tempRoot('pr-default-cli-process-');
    const dataDir = path.join(root, 'data');
    const script = path.join(pluginDir, 'scripts', 'profile-default.mjs');
    const set = spawnSync(
      process.execPath,
      [script, '--set', 'work', '--json', '--data-dir', dataDir],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(set.status).toBe(0);
    const payload = JSON.parse(set.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({ action: 'set-default', name: 'work', written: true });

    const invalid = spawnSync(
      process.execPath,
      [script, '--set', '../escape', '--data-dir', dataDir],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('Invalid account name');

    const usage = spawnSync(process.execPath, [script, '--bogus'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(usage.status).toBe(2);

    const help = spawnSync(process.execPath, [script, '--help'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('CLAUDE_PLUGIN_DATA');
    expect(help.stdout).toContain('cloakbrowser-cloakbrowser-mcp');
  });
});
