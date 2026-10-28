import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

// profile_isolation=isolated (2.11.0). The mode resolves no profile, creates no
// directory, takes no lock and starts both Chromium engines with their own
// isolated switch, so nothing persists. This suite pins:
//   - both plugin manifests offer the value and describe it honestly;
//   - the pure resolution (mode, ignored settings, no workspace derivation);
//   - backendEnvironment (the child env of an isolated start, and the unchanged
//     shared/workspace environment);
//   - the broker meta-tools (capabilities, status, browser_profiles), the
//     initialize sentence and the set-default note;
//   - the real launchers: an isolated start creates no profile directory, while
//     a shared start still creates profiles/default;
//   - several isolated servers at once on one plugin data directory.
// Every guard is mutation-checked by the PR (see the scratch mutation script).
interface ProfileResolution {
  profileDir: string | null;
  defaultProfileDir: string;
  profileSource: string | null;
  account: string | null;
  accountApplies: boolean;
  ignored?: { setting: string; value: string; reason: string }[];
  error: string | null;
}

interface ProfileModule {
  PROFILE_ISOLATION_VALUES: string[];
  PROFILE_ISOLATED_NOTE: string;
  PROFILE_ISOLATED_POINTER_NOTE: string;
  PROFILE_ISOLATED_NATIVE_NOTE: string;
  resolveProfileIsolation(value: string): {
    mode: string;
    source: string;
    ignored: string | null;
    placeholder: string | null;
  };
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
  backendEnvironment(
    baseEnv: Record<string, string | undefined>,
    options?: {
      engineId?: string;
      profileDir?: string | null;
      proxyServer?: string | null;
      outputDir?: string | null;
      isolated?: boolean;
    },
  ): Record<string, string | undefined>;
  profileIgnoredReason(ignored: { setting: string }[]): string | null;
}

interface LauncherModule {
  isIsolatedStart(source: Record<string, string | undefined>): boolean;
  buildChildEnv(source: Record<string, string | undefined>): Record<string, string | undefined>;
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
  engine?: string;
  pluginDir?: string;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const brokerPath = path.join(pluginDir, 'broker.mjs');
const profileModulePath = new URL('../../plugins/cloakbrowser/lib/profile.mjs', import.meta.url);
const profile = (await import(profileModulePath.href)) as unknown as ProfileModule;
const launch = (await import(
  new URL('../../plugins/cloakbrowser/launch.mjs', import.meta.url).href
)) as unknown as LauncherModule;
const launchCamoufox = (await import(
  new URL('../../plugins/cloakbrowser/launch-camoufox.mjs', import.meta.url).href
)) as unknown as LauncherModule;

const DATA_DIR = path.resolve('D:/scratch/pr-isolated-data');
const CWD = 'D:\\Projects2\\StealthBrowserAutomation';
const STUB_TOOLS = ['browser_navigate', 'browser_snapshot'];

const STUB_SOURCE = `#!/usr/bin/env node
const readline = require('node:readline');
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-isolated', version: '0.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} } })) } });
    return;
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({
      profileDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? null,
      isolated: process.env.PLAYWRIGHT_MCP_ISOLATED ?? null,
      proxy: process.env.PLAYWRIGHT_MCP_PROXY_SERVER ?? null,
    }) }], isError: false } });
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
    'PLAYWRIGHT_MCP_ISOLATED',
    'PLAYWRIGHT_MCP_PROXY_SERVER',
  ]) {
    delete childEnv[name];
  }
  if (options.account !== undefined) childEnv.STEALTH_ACCOUNT = options.account;
  if (options.isolation !== undefined) childEnv.STEALTH_PROFILE_ISOLATION = options.isolation;
  if (options.onLocked !== undefined) childEnv.STEALTH_ON_LOCKED = options.onLocked;
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

async function status(session: BrokerSession): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', {
    name: 'browser_engine_status',
    arguments: {},
  });
  return response.result?.structuredContent ?? {};
}

async function profilesPayload(
  session: BrokerSession,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name: 'browser_profiles', arguments: args });
  return response.result?.structuredContent ?? {};
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

function pointerFile(dataDir: string, engine = 'cloak'): string {
  return path.join(dataDir, 'profiles', engine, '.default');
}

function writePointer(dataDir: string, text: string, engine = 'cloak'): string {
  const file = pointerFile(dataDir, engine);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

describe('isolated as a profile_isolation value', () => {
  it('is offered by both plugin manifests with honest help text', () => {
    for (const name of ['cloakbrowser', 'camoufox']) {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'),
      ) as { userConfig: { profile_isolation: { options: string[]; description: string } } };
      const setting = manifest.userConfig.profile_isolation;
      expect(setting.options).toEqual(['shared', 'workspace', 'isolated', 'copy', 'copy-keep']);
      expect(setting.description).toContain('no browser profile at all');
      expect(setting.description).toContain('nothing persists');
      expect(setting.description.toLowerCase()).not.toContain('in memory');
    }
    // 2.12.0 appended "copy" and 2.13.0 "copy-keep" to the same setting; this
    // suite's isolated expectations below are otherwise unchanged.
    expect(profile.PROFILE_ISOLATION_VALUES).toEqual([
      'shared',
      'workspace',
      'isolated',
      'copy',
      'copy-keep',
    ]);
  });

  it('is accepted by resolveProfileIsolation and is not a fallback value', () => {
    expect(profile.resolveProfileIsolation('isolated')).toEqual({
      mode: 'isolated',
      source: 'setting',
      ignored: null,
      placeholder: null,
    });
    expect(profile.resolveProfileIsolation(' isolated ')).toMatchObject({ mode: 'isolated' });
    // The previous fallbacks are unchanged.
    expect(profile.resolveProfileIsolation('')).toMatchObject({ mode: 'shared', source: 'default' });
    expect(profile.resolveProfileIsolation('per-window')).toMatchObject({
      mode: 'shared',
      ignored: 'per-window',
    });
  });

  it('resolves no profile and reports every supplied profile setting as ignored', () => {
    const resolved = profile.resolveProfile({
      account: 'alice',
      profileDir: 'D:\\elsewhere\\profile',
      pointer: 'work',
      engineId: 'cloak',
      dataDir: DATA_DIR,
      isolation: 'isolated',
      cwd: CWD,
    });
    expect(resolved).toMatchObject({
      profileDir: null,
      profileSource: 'isolated',
      account: null,
      accountApplies: true,
      error: null,
    });
    expect(resolved.ignored?.map((entry) => entry.setting)).toEqual([
      'profile_dir',
      'account',
      'default_profile_pointer',
    ]);
    expect(resolved.ignored?.[0]?.value).toBe('D:\\elsewhere\\profile');
    expect(resolved.ignored?.[1]?.value).toBe('alice');
    expect(resolved.ignored?.[2]?.value).toBe('work');
    for (const entry of resolved.ignored ?? []) {
      expect(entry.reason).toContain('isolated');
    }
    expect(profile.effectiveProfileDir(resolved)).toBeNull();
    expect(profile.profileIgnoredReason(resolved.ignored ?? [])).toContain(
      'the Profile directory setting, the Account profile setting and the default-profile pointer are ignored',
    );
  });

  it('never turns an invalid account value into a start error, and never claims an empty one was ignored', () => {
    const invalid = profile.resolveProfile({
      account: '../escape',
      engineId: 'cloak',
      dataDir: DATA_DIR,
      isolation: 'isolated',
    });
    expect(invalid.error).toBeNull();
    expect(invalid.ignored?.map((entry) => entry.setting)).toEqual(['account']);

    const empty = profile.resolveProfile({
      account: '',
      profileDir: '',
      pointer: null,
      engineId: 'cloak',
      dataDir: DATA_DIR,
      isolation: 'isolated',
      cwd: CWD,
    });
    expect(empty).toMatchObject({ profileSource: 'isolated', profileDir: null, error: null });
    expect(empty.ignored).toEqual([]);
    expect(profile.profileIgnoredReason(empty.ignored ?? [])).toBeNull();

    // Placeholders mean "not supplied", exactly as in every other mode.
    const placeholder = profile.resolveProfile({
      account: '${user_config.account}',
      profileDir: '${user_config.profile_dir}',
      pointer: '${user_config.account}',
      engineId: 'cloak',
      dataDir: DATA_DIR,
      isolation: 'isolated',
    });
    expect(placeholder.ignored).toEqual([]);
  });

  it('does not derive a workspace profile and stays inert for engines that own their profile', () => {
    const workspace = profile.resolveProfile({
      engineId: 'cloak',
      dataDir: DATA_DIR,
      isolation: 'isolated',
      cwd: CWD,
    });
    expect(workspace.profileSource).toBe('isolated');
    expect(workspace.profileDir).toBeNull();

    const native = profile.resolveProfile({
      account: 'alice',
      engineId: 'camoufox-native',
      dataDir: DATA_DIR,
      profileApplies: false,
      isolation: 'isolated',
    });
    expect(native).toMatchObject({ profileSource: 'engine', accountApplies: false, profileDir: null });
    expect(native.ignored).toBeUndefined();
  });

  it('leaves shared and workspace resolution objects byte-identical', () => {
    const shared = profile.resolveProfile({ engineId: 'cloak', dataDir: DATA_DIR });
    expect(shared).toEqual({
      profileDir: null,
      defaultProfileDir: path.join(DATA_DIR, 'profiles', 'default'),
      profileSource: 'default',
      account: null,
      accountApplies: true,
      error: null,
    });
    expect(Object.hasOwn(shared, 'ignored')).toBe(false);

    const workspace = profile.resolveProfile({
      engineId: 'cloak',
      dataDir: DATA_DIR,
      isolation: 'workspace',
      cwd: CWD,
    });
    expect(workspace).toEqual({
      profileDir: path.join(DATA_DIR, 'profiles', 'cloak', workspace.profileDir?.split(path.sep).pop() ?? ''),
      defaultProfileDir: path.join(DATA_DIR, 'profiles', 'default'),
      profileSource: 'workspace',
      account: null,
      accountApplies: true,
      error: null,
    });
    expect(Object.hasOwn(workspace, 'ignored')).toBe(false);

    const account = profile.resolveProfile({
      account: 'default',
      engineId: 'cloak',
      dataDir: DATA_DIR,
    });
    expect(Object.hasOwn(account, 'ignored')).toBe(false);
  });
});

describe('isolated child environment', () => {
  it('removes any user-data-dir, turns the engine switch on and keeps everything else', () => {
    const base = {
      PATH: 'C:\\bin',
      CLAUDE_PLUGIN_DATA: DATA_DIR,
      PLAYWRIGHT_MCP_USER_DATA_DIR: 'D:\\explicit\\profile',
      PLAYWRIGHT_MCP_HEADLESS: 'true',
    };
    const isolated = profile.backendEnvironment(base, { engineId: 'cloak', isolated: true });
    expect(isolated.PLAYWRIGHT_MCP_USER_DATA_DIR).toBeUndefined();
    expect(isolated.PLAYWRIGHT_MCP_ISOLATED).toBe('true');
    expect(isolated.PLAYWRIGHT_MCP_BROWSER_ENGINE).toBe('cloak');
    expect(isolated.PLAYWRIGHT_MCP_HEADLESS).toBe('true');
    expect(isolated.PATH).toBe('C:\\bin');

    // Without the flag the environment is exactly the previous one.
    const shared = profile.backendEnvironment(base, { engineId: 'cloak' });
    expect(shared).toEqual({
      ...base,
      PLAYWRIGHT_MCP_BROWSER_ENGINE: 'cloak',
    });
    expect(Object.hasOwn(shared, 'PLAYWRIGHT_MCP_ISOLATED')).toBe(false);

    // An isolated start never re-adds a profile directory passed beside it.
    const both = profile.backendEnvironment(base, {
      engineId: 'cloak',
      profileDir: 'D:\\explicit\\profile',
      isolated: true,
    });
    expect(both.PLAYWRIGHT_MCP_USER_DATA_DIR).toBeUndefined();
  });

  it('is read by both launchers with the engines own spellings', () => {
    for (const launcher of [launch, launchCamoufox]) {
      expect(launcher.isIsolatedStart({ PLAYWRIGHT_MCP_ISOLATED: 'true' })).toBe(true);
      expect(launcher.isIsolatedStart({ PLAYWRIGHT_MCP_ISOLATED: '1' })).toBe(true);
      expect(launcher.isIsolatedStart({ PLAYWRIGHT_MCP_ISOLATED: 'TRUE' })).toBe(true);
      expect(launcher.isIsolatedStart({ PLAYWRIGHT_MCP_ISOLATED: 'false' })).toBe(false);
      expect(launcher.isIsolatedStart({ PLAYWRIGHT_MCP_ISOLATED: '' })).toBe(false);
      expect(launcher.isIsolatedStart({})).toBe(false);
    }
    // The Camoufox launcher keeps the variable for its own child.
    const env = launchCamoufox.buildChildEnv({
      PLAYWRIGHT_MCP_ISOLATED: 'true',
      PLAYWRIGHT_MCP_USER_DATA_DIR: '',
    });
    expect(env.PLAYWRIGHT_MCP_ISOLATED).toBe('true');
    expect(env.PLAYWRIGHT_MCP_USER_DATA_DIR).toBeUndefined();
  });
});

describe('broker reporting for an isolated start', () => {
  it('reports the mode, no profile, no lock, the ignored settings and the honest note', async () => {
    const root = tempRoot('pr-isolated-broker-');
    const dataDir = path.join(root, 'data');
    createRuntime(dataDir);
    const explicitProfile = path.join(root, 'explicit-profile');
    writePointer(dataDir, 'work\n');

    const session = startBroker({
      dataDir,
      isolation: 'isolated',
      account: 'alice',
      profileDir: explicitProfile,
    });
    const initialized = await initialize(session);
    expect(initialized.error).toBeUndefined();
    expect(initialized.result?.instructions).toContain(
      'this session uses no browser profile, so no cookies, logins or other browser state are saved and nothing persists after it closes.',
    );

    const capabilitiesPayload = await capabilities(session);
    expect(capabilitiesPayload).toMatchObject({
      profileIsolation: 'isolated',
      profileIsolationSource: 'setting',
      profileDir: null,
      profileSource: 'isolated',
      profileLock: null,
      profileApplies: true,
      account: null,
      accountApplies: true,
    });
    expect(capabilitiesPayload.profileIgnored).toEqual([
      expect.objectContaining({ setting: 'profile_dir', value: explicitProfile }),
      expect.objectContaining({ setting: 'account', value: 'alice' }),
      expect.objectContaining({ setting: 'default_profile_pointer', value: 'work' }),
    ]);
    expect(String(capabilitiesPayload.profileIgnoredReason)).toContain('no profile directory is resolved');
    expect(capabilitiesPayload.profileIsolationNote).toContain('set-default do not affect this session');

    const statusPayload = await status(session);
    expect(statusPayload).toMatchObject({
      profileIsolation: 'isolated',
      profileDir: null,
      profileSource: 'isolated',
      profileLock: null,
    });
    expect(statusPayload.profileIgnored).toHaveLength(3);
    expect(statusPayload.profileIsolationNote).toContain('do not affect this session');

    const list = await profilesPayload(session);
    expect(list.profileIsolationNote).toContain('do not affect this session');
    expect(list.current).toMatchObject({
      profileIsolation: 'isolated',
      profileDir: null,
      profileSource: 'isolated',
      profileLock: null,
    });
    expect(list.current).toHaveProperty('profileIgnored');

    // The backend really was started with the engines isolated switch and no
    // profile directory, and the launcher created no profile directory. The
    // pointer file the fixture wrote is the only thing under profiles/.
    expect(await effectiveEnvironment(session)).toEqual({
      profileDir: null,
      isolated: 'true',
      proxy: null,
    });
    expect(existsSync(path.join(dataDir, 'profiles', 'default'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'profiles', 'cloak', 'work'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'profiles', 'cloak', 'alice'))).toBe(false);
    expect(readdirSync(path.join(dataDir, 'profiles', 'cloak'))).toEqual(['.default']);
    expect(existsSync(explicitProfile)).toBe(false);
    expect(session.stderr()).toContain('no profile directory is resolved, created or locked');
  });

  it('writes set-default and says the pointer does not affect this session', async () => {
    const root = tempRoot('pr-isolated-set-default-');
    const dataDir = path.join(root, 'data');
    createRuntime(dataDir);
    const session = startBroker({ dataDir, isolation: 'isolated' });
    await initialize(session);

    const payload = await profilesPayload(session, { action: 'set-default', name: 'work' });
    expect(payload).toMatchObject({ action: 'set-default', ok: true, name: 'work' });
    expect(String(payload.note)).toContain('uses no profile and the pointer has no effect on this session');
    expect(String(payload.note)).toContain('once profile_isolation is "shared" or "workspace"');
    expect(readFileSync(pointerFile(dataDir), 'utf8')).toBe('work\n');
    // The pointer exists now, but this session still reports no profile.
    expect(await capabilities(session)).toMatchObject({ profileDir: null, profileSource: 'isolated' });
  });

  it('lets two isolated servers run at once on one plugin data directory', async () => {
    const root = tempRoot('pr-isolated-two-');
    const dataDir = path.join(root, 'data');
    createRuntime(dataDir);
    const first = startBroker({ dataDir, isolation: 'isolated' });
    const second = startBroker({ dataDir, isolation: 'isolated' });
    const [firstInit, secondInit] = await Promise.all([initialize(first), initialize(second)]);
    expect(firstInit.error).toBeUndefined();
    expect(secondInit.error).toBeUndefined();
    for (const session of [first, second]) {
      expect(await effectiveEnvironment(session)).toMatchObject({ profileDir: null, isolated: 'true' });
      const capabilitiesPayload = await capabilities(session);
      expect(capabilitiesPayload.profileLock).toBeNull();
      expect(capabilitiesPayload.engineError).toBeNull();
    }
    expect(existsSync(path.join(dataDir, 'profiles'))).toBe(false);
  });

  it('reads no profile lock even when the default profile lock is live', async () => {
    const root = tempRoot('pr-isolated-lock-');
    const dataDir = path.join(root, 'data');
    createRuntime(dataDir);
    // A live lock on the profile a shared start would use. The isolated start has
    // no profile at all, so it must neither read nor report it and must start.
    const defaultDir = path.join(dataDir, 'profiles', 'default');
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(
      path.join(defaultDir, '.cloakbrowser-mcp-profile.lock'),
      `${JSON.stringify({ pid: process.pid, createdAt: '2026-10-26T00:00:00.000Z', userDataDir: defaultDir })}\n`,
    );

    const isolated = startBroker({ dataDir, isolation: 'isolated' });
    const isolatedInit = await initialize(isolated);
    expect(isolatedInit.error).toBeUndefined();
    expect(await capabilities(isolated)).toMatchObject({
      profileIsolation: 'isolated',
      profileDir: null,
      profileLock: null,
      engineError: null,
    });
    expect(await effectiveEnvironment(isolated)).toMatchObject({ profileDir: null, isolated: 'true' });

    // The same lock does stop a shared start, so the mode is what changed. The
    // shared control pins on_locked=block, its 2.15 shape: the 2.16.0 default is
    // "fallback", which would start on a numbered sibling instead.
    const shared = startBroker({ dataDir, onLocked: 'block' });
    await initialize(shared);
    const sharedCapabilities = await capabilities(shared);
    expect(String(sharedCapabilities.engineError)).toContain('already in use');
    expect(sharedCapabilities.profileLock).toMatchObject({ state: 'live', owner: { pid: process.pid } });
  });

  it('keeps the shared start and its payloads unchanged', async () => {
    const root = tempRoot('pr-isolated-shared-');
    const dataDir = path.join(root, 'data');
    createRuntime(dataDir);
    const session = startBroker({ dataDir });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions ?? '').not.toContain('nothing persists');
    const capabilitiesPayload = await capabilities(session);
    expect(capabilitiesPayload).toMatchObject({
      profileIsolation: 'shared',
      profileSource: 'default',
      profileDir: null,
      defaultProfileDir: path.join(dataDir, 'profiles', 'default'),
      profileLock: expect.objectContaining({ state: 'free' }),
    });
    expect(Object.hasOwn(capabilitiesPayload, 'profileIgnored')).toBe(false);
    expect(Object.hasOwn(capabilitiesPayload, 'profileIsolationNote')).toBe(false);
    const statusPayload = await status(session);
    expect(statusPayload.profileIsolation).toBe('shared');
    expect(Object.hasOwn(statusPayload, 'profileSource')).toBe(false);
    expect(Object.hasOwn(statusPayload, 'profileIgnored')).toBe(false);
    const list = await profilesPayload(session);
    expect(Object.hasOwn(list, 'profileIsolationNote')).toBe(false);
    expect(Object.hasOwn(list.current as Record<string, unknown>, 'profileIgnored')).toBe(false);
    // The shared launcher still creates and uses profiles/default.
    expect(existsSync(path.join(dataDir, 'profiles', 'default'))).toBe(true);
    expect(await effectiveEnvironment(session)).toMatchObject({
      profileDir: path.join(dataDir, 'profiles', 'default'),
      isolated: null,
    });
  });
});
