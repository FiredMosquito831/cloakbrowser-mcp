import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

interface ProfileResolution {
  profileDir: string | null;
  defaultProfileDir: string;
  profileSource: string | null;
  account: string | null;
  accountApplies: boolean;
  error: string | null;
}

interface ProxyReadResult {
  value: string | null;
  error: string | null;
  exists: boolean;
}

interface ProfileModule {
  ACCOUNT_NAME_PATTERN: RegExp;
  ACCOUNT_PROXY_SUFFIX: string;
  INVALID_ACCOUNT_HINT: string;
  accountNameError(value: string): string;
  validateAccountName(value: string): boolean;
  defaultProfileDir(engineId: string, dataDir: string, launcherName?: string): string;
  accountProfileDir(engineId: string, account: string, dataDir: string): string;
  resolveProfile(options: {
    account?: string;
    profileDir?: string;
    engineId: string;
    dataDir: string;
    launcherName?: string;
    ignoredSettings?: string[];
  }): ProfileResolution;
  accountProxyPath(profileDir: string): string;
  parseProxyUrl(value: string): { value: string | null; error: string | null };
  readAccountProxy(file: string): ProxyReadResult;
  redactSecrets(text: string): string;
  backendEnvironment(
    baseEnv: Record<string, string | undefined>,
    options?: { engineId?: string; profileDir?: string | null; proxyServer?: string | null },
  ): Record<string, string | undefined>;
}

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
  request: (method: string, params?: Record<string, unknown>) => Promise<JsonRpcResponse>;
  stderr: () => string;
  close: () => Promise<void>;
}

const modulePath = new URL('../../plugins/cloakbrowser/lib/profile.mjs', import.meta.url);
const profile = (await import(modulePath.href)) as unknown as ProfileModule;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const brokerPath = path.join(repoRoot, 'plugins', 'cloakbrowser', 'broker.mjs');
const DATA_DIR = path.resolve('D:/scratch/pr8-data');
const PROXY_SECRET = 's3cr3t-token-value';
const PROXY_URL = `http://user:${PROXY_SECRET}@proxy.example:8080`;
const INVALID_NAME_MESSAGE =
  'Invalid account name "../x". Use letters, digits, ".", "_" or "-", starting with a letter or digit, ' +
  'up to 64 characters, no trailing dot or space.';

const STUB_TOOLS = ['browser_navigate', 'browser_snapshot'];

const STUB_SOURCE = `#!/usr/bin/env node
// Deterministic stand-in for the Chromium launcher's CLI in the broker probes.
// It answers the MCP handshake from memory and echoes the profile/proxy
// environment it received, so the tests can see what the broker passed.
const readline = require('node:readline');

const TOOLS = __TOOLS__;

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
  } catch {
    // Ignore malformed input, exactly as the real CLI would not answer it.
  }
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
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// A runtime tree that launch.mjs accepts as healthy, so the probe never runs
// npm. The identities are the ones lib/provision.mjs validates.
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
  mkdirSync(path.join(modules, 'cloakbrowser-mcp', 'dist'), { recursive: true });
  writeFileSync(
    path.join(modules, 'cloakbrowser-mcp', 'dist', 'cli.js'),
    STUB_SOURCE.replace('__TOOLS__', JSON.stringify(STUB_TOOLS)),
  );
  return dataDir;
}

function startBroker(options: {
  dataDir: string;
  account?: string;
  profileDir?: string;
  proxyServer?: string;
  engine?: string;
}): BrokerSession {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: options.dataDir,
    CLOAK_PLAYWRIGHT_MCP_PACKAGE: 'cloakbrowser-mcp@1.15.1',
    STEALTH_ENGINE: options.engine ?? 'cloak',
    STEALTH_TOOL_PROFILE: 'full',
  };
  for (const name of ['STEALTH_ACCOUNT', 'PLAYWRIGHT_MCP_USER_DATA_DIR', 'PLAYWRIGHT_MCP_PROXY_SERVER']) {
    delete childEnv[name];
  }
  if (options.account !== undefined) childEnv.STEALTH_ACCOUNT = options.account;
  if (options.profileDir !== undefined) childEnv.PLAYWRIGHT_MCP_USER_DATA_DIR = options.profileDir;
  if (options.proxyServer !== undefined) childEnv.PLAYWRIGHT_MCP_PROXY_SERVER = options.proxyServer;
  const child = spawn(process.execPath, [brokerPath], {
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

describe('account name validation', () => {
  it.each(['alice', 'work-2', 'a.b_c', 'default', 'A1', 'a'.repeat(64)])('accepts %s', (name) => {
    expect(profile.validateAccountName(name)).toBe(true);
  });

  it.each([
    '',
    ' ',
    '   ',
    '../x',
    'x/..',
    '/x',
    'C:\\x',
    '.hidden',
    'alice.',
    'alice ',
    ' alice',
    'a'.repeat(65),
    'CON',
    'com1',
    'LPT9',
    'con.txt',
    'nul',
    'a b',
    'a:b',
    '${user_config.account}',
  ])('rejects %j', (name) => {
    expect(profile.validateAccountName(name)).toBe(false);
  });

  it('reports the exact start-up sentence', () => {
    expect(profile.accountNameError('../x')).toBe(INVALID_NAME_MESSAGE);
  });
});

describe('profile resolution', () => {
  it('maps no setting to the launcher default and sets nothing', () => {
    const resolved = profile.resolveProfile({ account: '', engineId: 'cloak', dataDir: DATA_DIR });
    expect(resolved.profileSource).toBe('default');
    expect(resolved.profileDir).toBeNull();
    expect(resolved.account).toBeNull();
    expect(resolved.accountApplies).toBe(true);
    expect(resolved.defaultProfileDir).toBe(path.join(DATA_DIR, 'profiles', 'default'));
  });

  it('maps default to the existing Chromium profile', () => {
    const resolved = profile.resolveProfile({ account: 'default', engineId: 'cloak', dataDir: DATA_DIR });
    expect(resolved).toMatchObject({ profileSource: 'account', account: 'default' });
    expect(resolved.profileDir).toBe(path.join(DATA_DIR, 'profiles', 'default'));
  });

  it.each(['cloak', 'playwright'])('maps a name under profiles/%s for the Chromium engines', (engine) => {
    const resolved = profile.resolveProfile({ account: 'alice', engineId: engine, dataDir: DATA_DIR });
    expect(resolved).toMatchObject({ profileSource: 'account', account: 'alice' });
    expect(resolved.profileDir).toBe(path.join(DATA_DIR, 'profiles', engine, 'alice'));
    expect(path.isAbsolute(resolved.profileDir ?? '')).toBe(true);
  });

  it('maps a Camoufox name under profiles/camoufox and keeps its own default', () => {
    const resolved = profile.resolveProfile({
      account: 'alice',
      engineId: 'camoufox',
      dataDir: DATA_DIR,
      launcherName: 'launch-camoufox.mjs',
    });
    expect(resolved.profileDir).toBe(path.join(DATA_DIR, 'profiles', 'camoufox', 'alice'));
    const fallback = profile.resolveProfile({
      account: '',
      engineId: 'camoufox',
      dataDir: DATA_DIR,
      launcherName: 'launch-camoufox.mjs',
    });
    expect(fallback.defaultProfileDir).toBe(path.join(DATA_DIR, 'profiles', 'camoufox', 'default'));
  });

  it('keeps every engine default path stable', () => {
    expect(profile.defaultProfileDir('cloak', DATA_DIR)).toBe(path.join(DATA_DIR, 'profiles', 'default'));
    for (const engine of ['playwright', 'camoufox', 'kameleo']) {
      expect(profile.defaultProfileDir(engine, DATA_DIR, `launch-${engine}.mjs`)).toBe(
        path.join(DATA_DIR, 'profiles', engine, 'default'),
      );
    }
  });

  it('lets profile_dir win, unchanged and unnormalised', () => {
    const resolved = profile.resolveProfile({
      account: 'alice',
      profileDir: 'D:/explicit/../profile',
      engineId: 'cloak',
      dataDir: DATA_DIR,
    });
    expect(resolved).toMatchObject({ profileSource: 'profile_dir', account: null });
    expect(resolved.profileDir).toBe('D:/explicit/../profile');
    expect(resolved.error).toBeNull();
  });

  it('treats an unsubstituted profile_dir placeholder as unset', () => {
    const resolved = profile.resolveProfile({
      account: 'alice',
      profileDir: '${user_config.profile_dir}',
      engineId: 'cloak',
      dataDir: DATA_DIR,
    });
    expect(resolved.profileSource).toBe('account');
    expect(resolved.profileDir).toBe(path.join(DATA_DIR, 'profiles', 'cloak', 'alice'));
  });

  it('does not apply to an engine whose manifest ignores profile_dir', () => {
    const resolved = profile.resolveProfile({
      account: 'alice',
      profileDir: 'D:/ignored',
      engineId: 'camoufox-native',
      dataDir: DATA_DIR,
      ignoredSettings: ['profile_dir', 'proxy_server'],
    });
    expect(resolved).toMatchObject({ profileSource: 'engine', accountApplies: false, profileDir: null });
    expect(resolved.error).toBeNull();
  });

  it('rejects a traversal name with the exact message and resolves no path', () => {
    const resolved = profile.resolveProfile({ account: '../x', engineId: 'cloak', dataDir: DATA_DIR });
    expect(resolved.error).toBe(INVALID_NAME_MESSAGE);
    expect(resolved.profileDir).toBeNull();
    expect(resolved.profileSource).toBeNull();
  });

  it('builds the proxy path beside the profile', () => {
    expect(profile.accountProxyPath(path.join(DATA_DIR, 'profiles', 'cloak', 'alice'))).toBe(
      path.join(DATA_DIR, 'profiles', 'cloak', 'alice.proxy'),
    );
    expect(profile.accountProxyPath(path.join(DATA_DIR, 'profiles', 'default'))).toBe(
      path.join(DATA_DIR, 'profiles', 'default.proxy'),
    );
  });
});

describe('account proxy file', () => {
  it('returns null for a missing file', () => {
    const root = tempRoot('account-proxy-missing-');
    expect(profile.readAccountProxy(path.join(root, 'alice.proxy'))).toEqual({
      value: null,
      error: null,
      exists: false,
    });
  });

  it('returns the trimmed single line unchanged', () => {
    const root = tempRoot('account-proxy-ok-');
    const file = path.join(root, 'alice.proxy');
    writeFileSync(file, `  ${PROXY_URL}\r\n\r\n`);
    expect(profile.readAccountProxy(file)).toEqual({ value: PROXY_URL, error: null, exists: true });
  });

  it('treats a whitespace-only file as no proxy', () => {
    const root = tempRoot('account-proxy-empty-');
    const file = path.join(root, 'alice.proxy');
    writeFileSync(file, ' \r\n\t\r\n');
    expect(profile.readAccountProxy(file)).toEqual({ value: null, error: null, exists: true });
  });

  it('accepts a bare host:port and a socks5 URL unchanged', () => {
    const root = tempRoot('account-proxy-schemes-');
    const bare = path.join(root, 'bare.proxy');
    writeFileSync(bare, 'host.example:3128\n');
    expect(profile.readAccountProxy(bare).value).toBe('host.example:3128');
    const socks = path.join(root, 'socks.proxy');
    writeFileSync(socks, 'socks5://user:pass@host.example:1080\n');
    expect(profile.readAccountProxy(socks).value).toBe('socks5://user:pass@host.example:1080');
  });

  it.each([
    ['two non-empty lines', `${PROXY_URL}\nhttp://second.example:8080\n`],
    ['an unsupported scheme', 'ftp://host.example:21\n'],
    ['an unparsable value', 'http://\n'],
    ['a value with no host', 'http://user:pass@\n'],
  ])('fails closed on %s without echoing the value', (_label, content) => {
    const root = tempRoot('account-proxy-bad-');
    const file = path.join(root, 'alice.proxy');
    writeFileSync(file, content);
    const result = profile.readAccountProxy(file);
    expect(result.value).toBeNull();
    expect(result.error).toContain(file);
    expect(result.error).not.toContain(PROXY_SECRET);
    expect(result.error).not.toContain('second.example');
  });

  it('fails on invalid UTF-8', () => {
    const root = tempRoot('account-proxy-utf8-');
    const file = path.join(root, 'alice.proxy');
    writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    const result = profile.readAccountProxy(file);
    expect(result.value).toBeNull();
    expect(result.error).toContain('not valid UTF-8');
  });

  it('fails on an unreadable path without echoing anything', () => {
    const root = tempRoot('account-proxy-dir-');
    const directory = path.join(root, 'alice.proxy');
    mkdirSync(directory);
    const result = profile.readAccountProxy(directory);
    expect(result.value).toBeNull();
    expect(result.error).toContain(directory);
  });
});

describe('secret redaction', () => {
  it('hides credentials but leaves ordinary URLs and text alone', () => {
    expect(profile.redactSecrets('http://u:p@h:1')).toBe('http://***@h:1');
    expect(profile.redactSecrets('socks5://u:p@h')).toBe('socks5://***@h');
    expect(profile.redactSecrets('https://example.com/a@b')).toBe('https://example.com/a@b');
    expect(profile.redactSecrets('started in 12:34:56, 2026-10-24')).toBe('started in 12:34:56, 2026-10-24');
    expect(profile.redactSecrets(`${PROXY_URL} failed`)).toBe('http://***@proxy.example:8080 failed');
  });
});

describe('backend environment', () => {
  it('is exactly the base plus the engine id when nothing was resolved', () => {
    const base = { A: '1', PATH: '/bin', EMPTY: '' };
    expect(profile.backendEnvironment(base, { engineId: 'cloak' })).toEqual({
      A: '1',
      PATH: '/bin',
      EMPTY: '',
      PLAYWRIGHT_MCP_BROWSER_ENGINE: 'cloak',
    });
    expect(base).not.toHaveProperty('PLAYWRIGHT_MCP_BROWSER_ENGINE');
  });

  it('adds the resolved profile and file proxy only', () => {
    const env = profile.backendEnvironment(
      { A: '1' },
      { engineId: 'cloak', profileDir: 'D:/p/alice', proxyServer: PROXY_URL },
    );
    expect(env.PLAYWRIGHT_MCP_USER_DATA_DIR).toBe('D:/p/alice');
    expect(env.PLAYWRIGHT_MCP_PROXY_SERVER).toBe(PROXY_URL);
  });
});

describe('broker account profiles', () => {
  it('changes nothing when the account and profile_dir are unset', async () => {
    const dataDir = createRuntime(tempRoot('account-broker-default-'));
    const session = startBroker({ dataDir });
    await initialize(session);
    const list = await session.request('tools/list', {});
    expect(list.result?.tools?.map((tool) => tool.name)).toEqual([
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
      accountApplies: true,
      proxySource: 'none',
      proxyConfigured: false,
      defaultProfileDir: path.join(dataDir, 'profiles', 'default'),
    });
    expect(await effectiveEnvironment(session)).toEqual({
      profileDir: path.join(dataDir, 'profiles', 'default'),
      proxy: null,
    });
    const statusPayload = await status(session);
    expect(statusPayload.account).toBeNull();
    expect(statusPayload.profileDir).toBeNull();
  });

  it('uses and creates profiles/cloak/<name> for a named account', async () => {
    const dataDir = createRuntime(tempRoot('account-broker-alice-'));
    const session = startBroker({ dataDir, account: 'alice' });
    await initialize(session);
    const list = await session.request('tools/list', {});
    expect(list.result?.tools?.map((tool) => tool.name)).toEqual([
      ...STUB_TOOLS,
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    const caps = await capabilities(session);
    const expected = path.join(dataDir, 'profiles', 'cloak', 'alice');
    expect(caps).toMatchObject({
      account: 'alice',
      profileDir: expected,
      profileSource: 'account',
      availableAccounts: ['alice'],
      availableAccountCount: 1,
      accountApplies: true,
      proxySource: 'none',
      proxyConfigured: false,
    });
    expect(await effectiveEnvironment(session)).toEqual({ profileDir: expected, proxy: null });
    const statusPayload = await status(session);
    expect(statusPayload.account).toBe('alice');
    expect(statusPayload.profileDir).toBe(expected);
  });

  it('lets an explicit profile_dir win over the account', async () => {
    const root = tempRoot('account-broker-dir-');
    const dataDir = createRuntime(root);
    const explicit = path.join(root, 'explicit-profile');
    const session = startBroker({ dataDir, account: 'alice', profileDir: explicit });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps).toMatchObject({ account: null, profileDir: null, profileSource: 'profile_dir' });
    expect(await effectiveEnvironment(session)).toEqual({ profileDir: explicit, proxy: null });
    expect(readdirSyncSafe(path.join(dataDir, 'profiles'))).not.toContain('cloak');
  });

  it('rejects a traversal name before spawning anything', async () => {
    const dataDir = createRuntime(tempRoot('account-broker-invalid-'));
    const session = startBroker({ dataDir, account: '../x' });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain(INVALID_NAME_MESSAGE);
    const list = await session.request('tools/list', {});
    expect(list.result?.tools?.map((tool) => tool.name)).toEqual([
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    const statusPayload = await status(session);
    expect(statusPayload.lastError).toBe(INVALID_NAME_MESSAGE);
    expect(statusPayload.backendPid).toBeNull();
    expect(statusPayload.backendState).toBe('failed');
    const caps = await capabilities(session);
    expect(caps.engineError).toBe(INVALID_NAME_MESSAGE);
    expect(readdirSyncSafe(path.join(dataDir, 'profiles'))).toEqual([]);
  });

  it('uses the account proxy file when proxy_server is empty and never logs it', async () => {
    const dataDir = createRuntime(tempRoot('account-broker-proxy-'));
    mkdirSync(path.join(dataDir, 'profiles', 'cloak'), { recursive: true });
    writeFileSync(path.join(dataDir, 'profiles', 'cloak', 'alice.proxy'), `${PROXY_URL}\n`);
    const session = startBroker({ dataDir, account: 'alice' });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps).toMatchObject({ proxySource: 'account-file', proxyConfigured: true });
    expect(JSON.stringify(caps)).not.toContain(PROXY_SECRET);
    expect(JSON.stringify(await status(session))).not.toContain(PROXY_SECRET);
    expect(session.stderr()).not.toContain(PROXY_SECRET);
    expect(await effectiveEnvironment(session)).toEqual({
      profileDir: path.join(dataDir, 'profiles', 'cloak', 'alice'),
      proxy: PROXY_URL,
    });
  });

  it('lets proxy_server win and says the file is ignored', async () => {
    const dataDir = createRuntime(tempRoot('account-broker-proxy-setting-'));
    mkdirSync(path.join(dataDir, 'profiles', 'cloak'), { recursive: true });
    writeFileSync(path.join(dataDir, 'profiles', 'cloak', 'alice.proxy'), `${PROXY_URL}\n`);
    const setting = 'http://setting.example:9090';
    const session = startBroker({ dataDir, account: 'alice', proxyServer: setting });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps).toMatchObject({ proxySource: 'setting', proxyConfigured: true });
    expect(session.stderr()).toContain('ignoring the account proxy file');
    expect(session.stderr()).not.toContain(PROXY_SECRET);
    expect(JSON.stringify(caps)).not.toContain(setting);
    expect((await effectiveEnvironment(session)).proxy).toBe(setting);
  });

  it('fails closed on a malformed proxy file without spawning or leaking it', async () => {
    const dataDir = createRuntime(tempRoot('account-broker-proxy-bad-'));
    mkdirSync(path.join(dataDir, 'profiles', 'cloak'), { recursive: true });
    const file = path.join(dataDir, 'profiles', 'cloak', 'alice.proxy');
    writeFileSync(file, 'not-a-proxy @@ s3cr3t-token-value\n');
    const session = startBroker({ dataDir, account: 'alice' });
    await initialize(session);
    const list = await session.request('tools/list', {});
    expect(list.result?.tools?.map((tool) => tool.name)).toEqual([
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    const statusPayload = await status(session);
    expect(statusPayload.backendPid).toBeNull();
    expect(statusPayload.backendState).toBe('failed');
    expect(String(statusPayload.lastError)).toContain(file);
    const caps = await capabilities(session);
    expect(caps.proxySource).toBe('error');
    expect(caps.proxyConfigured).toBe(false);
    expect(JSON.stringify(caps)).not.toContain(PROXY_SECRET);
    expect(session.stderr()).not.toContain(PROXY_SECRET);
  });

  it('reads profiles/default.proxy only when the file exists', async () => {
    const dataDir = createRuntime(tempRoot('account-broker-default-proxy-'));
    mkdirSync(path.join(dataDir, 'profiles'), { recursive: true });
    writeFileSync(path.join(dataDir, 'profiles', 'default.proxy'), `${PROXY_URL}\n`);
    const session = startBroker({ dataDir });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps).toMatchObject({
      profileSource: 'default',
      proxySource: 'account-file',
      proxyConfigured: true,
    });
    expect((await effectiveEnvironment(session)).proxy).toBe(PROXY_URL);
  });
});

function readdirSyncSafe(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}
