import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Unpacked extensions (2.18.0). The plugin setting is one string whose value the
// bridge's own parser accepts (a JSON string array or a comma-separated list);
// the broker resolves it to canonical absolute directories, refuses a start it
// cannot honour (a bad entry, or an isolated start, which has no persistent
// profile), passes the list to the bridge as
// CLOAK_PLAYWRIGHT_MCP_EXTENSION_PATHS only for an engine whose manifest declares
// extension support, and reports the facts additively — and only when the setting
// names something, so every unset payload and child environment is byte-identical
// to 2.17.0.
//
// No browser is launched anywhere in this suite: the backend is a stub that
// reports the environment it was started with.

interface ExtensionError {
  index: number | null;
  reason: string;
  detail: string;
}

interface ExtensionResolution {
  configured: boolean;
  source: string;
  variable: string | null;
  raw: string | null;
  entries: (string | null)[] | null;
  paths: string[] | null;
  error: ExtensionError | null;
  problem: string | null;
}

interface ExtensionModule {
  EXTENSION_PATHS_ENV_VAR: string;
  EXTENSION_PATHS_SETTING_VAR: string;
  resolveExtensionPaths: (env?: Record<string, string | undefined>) => ExtensionResolution;
  extensionPathsProblemText: (error: ExtensionError) => string;
  backendEnvironment: (
    baseEnv: Record<string, string | undefined>,
    options?: {
      engineId?: string;
      profileDir?: string | null;
      proxyServer?: string | null;
      outputDir?: string | null;
      isolated?: boolean;
      extensionPaths?: string[] | null;
    },
  ) => Record<string, string | undefined>;
}

interface JsonRpcResponse {
  id?: number;
  result?: {
    tools?: { name: string }[];
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
  engine?: string;
  isolation?: string;
  onLocked?: string;
  setting?: string;
  environment?: string;
}

interface ChildFacts {
  engine: string | null;
  profileDir: string | null;
  isolated: string | null;
  extensionPaths: string | null;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const brokerPath = path.join(pluginDir, 'broker.mjs');
const extensions = (await import(
  new URL('../../plugins/cloakbrowser/lib/profile.mjs', import.meta.url).href
)) as unknown as ExtensionModule;
const registry = (await import(
  new URL('../../plugins/cloakbrowser/engine-registry.mjs', import.meta.url).href
)) as unknown as {
  manifestExtensionPaths: (manifest: Record<string, unknown> | null) => boolean;
  validateManifest: (
    manifest: unknown,
    expectedId: string,
    profileNames: string[],
    launcherDir?: string,
  ) => string | null;
};

const ENV_VAR = extensions.EXTENSION_PATHS_ENV_VAR;
const SETTING_VAR = extensions.EXTENSION_PATHS_SETTING_VAR;
const LOCK = '.cloakbrowser-mcp-profile.lock';
const STUB_TOOLS = ['browser_navigate', 'browser_snapshot'];
const META_TOOLS = ['browser_capabilities', 'browser_engine_status', 'browser_profiles'];

// The stand-in backend reports exactly what it was started with, so a test can
// prove which extension list (or none) reached the engine.
const STUB_SOURCE = `#!/usr/bin/env node
const readline = require('node:readline');
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-extensions', version: '0.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} } })) } });
    return;
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({
      engine: process.env.PLAYWRIGHT_MCP_BROWSER_ENGINE ?? null,
      profileDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? null,
      isolated: process.env.PLAYWRIGHT_MCP_ISOLATED ?? null,
      extensionPaths: process.env.CLOAK_PLAYWRIGHT_MCP_EXTENSION_PATHS ?? null
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

function extensionDirectory(root: string, name: string): string {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, 'manifest.json'), { manifest_version: 3, name, version: '1.0.0' });
  return directory;
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
    'CLOAK_PLAYWRIGHT_MCP_EXTENSION_PATHS',
    'STEALTH_EXTENSION_PATHS',
  ]) {
    delete childEnv[name];
  }
  if (options.isolation !== undefined) childEnv.STEALTH_PROFILE_ISOLATION = options.isolation;
  if (options.onLocked !== undefined) childEnv.STEALTH_ON_LOCKED = options.onLocked;
  if (options.setting !== undefined) childEnv.STEALTH_EXTENSION_PATHS = options.setting;
  if (options.environment !== undefined) childEnv.CLOAK_PLAYWRIGHT_MCP_EXTENSION_PATHS = options.environment;
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
    let message: JsonRpcResponse & { method?: string };
    try {
      message = JSON.parse(line) as JsonRpcResponse & { method?: string };
    } catch {
      return;
    }
    if (typeof message.method === 'string' && message.id === undefined) {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id) as (response: JsonRpcResponse) => void;
      pending.delete(message.id);
      resolve(message);
    }
  });
  let nextId = 1;
  const request = (method: string, params?: Record<string, unknown>, timeoutMs = 15000) => {
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
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
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
  const response = await session.request('tools/call', { name: 'browser_capabilities', arguments: {} });
  return response.result?.structuredContent ?? {};
}

async function status(session: BrokerSession): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name: 'browser_engine_status', arguments: {} });
  return response.result?.structuredContent ?? {};
}

async function toolNames(session: BrokerSession): Promise<string[]> {
  const list = await session.request('tools/list', {});
  return (list.result?.tools ?? []).map((tool) => tool.name);
}

function engineErrorText(payload: Record<string, unknown>): string {
  const value = payload.engineError;
  return typeof value === 'string' ? value : '';
}

async function childFacts(session: BrokerSession): Promise<ChildFacts> {
  const response = await session.request('tools/call', {
    name: 'browser_navigate',
    arguments: { url: 'http://127.0.0.1:9/' },
  });
  const text = response.result?.content?.[0]?.text ?? '{}';
  return JSON.parse(text) as ChildFacts;
}

describe('extension path list parsing', () => {
  it('accepts a JSON string array and canonicalises every entry', () => {
    const root = tempRoot('ext-json-');
    const first = extensionDirectory(root, 'one');
    const second = extensionDirectory(root, 'two');
    const resolution = extensions.resolveExtensionPaths({
      [SETTING_VAR]: JSON.stringify([first, ` ${second} `]),
    });
    expect(resolution.configured).toBe(true);
    expect(resolution.source).toBe('setting');
    expect(resolution.entries).toEqual([first, second]);
    expect(resolution.paths).toEqual([realpathSync(first), realpathSync(second)]);
    expect(resolution.error).toBeNull();
  });

  it('accepts a comma-separated list exactly like the bridge does', () => {
    const root = tempRoot('ext-list-');
    const first = extensionDirectory(root, 'one');
    const second = extensionDirectory(root, 'two');
    const resolution = extensions.resolveExtensionPaths({
      [SETTING_VAR]: `${first}, ${second}`,
    });
    expect(resolution.configured).toBe(true);
    expect(resolution.paths).toEqual([first, second]);
  });

  it('treats an empty, blank or empty-array value as nothing configured', () => {
    for (const value of ['', '   ', '[]']) {
      const resolution = extensions.resolveExtensionPaths({ [SETTING_VAR]: value });
      expect(resolution.configured).toBe(false);
      expect(resolution.error).toBeNull();
      expect(resolution.paths).toBeNull();
    }
    expect(extensions.resolveExtensionPaths({}).configured).toBe(false);
  });

  it('treats an unsubstituted placeholder as unset instead of a path', () => {
    const resolution = extensions.resolveExtensionPaths({
      [SETTING_VAR]: '${user_config.extension_paths}',
    });
    expect(resolution.configured).toBe(false);
    expect(resolution.problem).toBe('placeholder');
    expect(resolution.error).toBeNull();
  });

  it('refuses a relative path without touching the filesystem', () => {
    const resolution = extensions.resolveExtensionPaths({ [SETTING_VAR]: 'extensions/one' });
    expect(resolution.configured).toBe(true);
    expect(resolution.paths).toBeNull();
    expect(resolution.error?.reason).toBe('relative');
    expect(resolution.error?.index).toBe(0);
    expect(resolution.error?.detail).toContain('is not an absolute path');
  });

  it('refuses a directory that does not exist', () => {
    const root = tempRoot('ext-missing-');
    const missing = path.join(root, 'absent');
    const resolution = extensions.resolveExtensionPaths({ [SETTING_VAR]: missing });
    expect(resolution.error?.reason).toBe('missing');
    expect(resolution.error?.detail).toContain('does not exist');
    expect(resolution.paths).toBeNull();
  });

  it('refuses a path that is a file, not a directory', () => {
    const root = tempRoot('ext-file-');
    const file = path.join(root, 'manifest.json');
    writeJson(file, { manifest_version: 3 });
    const resolution = extensions.resolveExtensionPaths({ [SETTING_VAR]: file });
    expect(resolution.error?.reason).toBe('not-directory');
    expect(resolution.error?.detail).toContain('is not a directory');
  });

  it('refuses a path containing a comma, which the wrapper cannot join', () => {
    const root = tempRoot('ext-comma-');
    const directory = extensionDirectory(root, 'one,two');
    const resolution = extensions.resolveExtensionPaths({
      [SETTING_VAR]: JSON.stringify([directory]),
    });
    expect(resolution.error?.reason).toBe('comma');
    expect(resolution.error?.detail).toContain('joins the list with commas');
  });

  it('refuses two spellings of the same directory as a duplicate', () => {
    const root = tempRoot('ext-dup-');
    const directory = extensionDirectory(root, 'one');
    const resolution = extensions.resolveExtensionPaths({
      [SETTING_VAR]: `${directory},${path.join(directory, '.')}`,
    });
    expect(resolution.error?.reason).toBe('duplicate');
    expect(resolution.error?.detail).toContain('repeats entry 1');
    expect(resolution.paths).toBeNull();
  });

  it('refuses a malformed JSON array instead of splitting it as a list', () => {
    const resolution = extensions.resolveExtensionPaths({ [SETTING_VAR]: '[C:\\ext' });
    expect(resolution.configured).toBe(true);
    expect(resolution.entries).toBeNull();
    expect(resolution.error?.reason).toBe('invalid');
    expect(resolution.error?.index).toBeNull();
    expect(resolution.error?.detail).toContain('not valid JSON');
  });

  it('refuses a JSON member that is not a string', () => {
    const root = tempRoot('ext-not-string-');
    const directory = extensionDirectory(root, 'one');
    const resolution = extensions.resolveExtensionPaths({
      [SETTING_VAR]: `[${JSON.stringify(directory)}, 7]`,
    });
    expect(resolution.entries).toEqual([directory, null]);
    expect(resolution.error?.reason).toBe('not-string');
    expect(resolution.error?.index).toBe(1);
  });

  it('reports the first bad entry and keeps no partial list', () => {
    const root = tempRoot('ext-index-');
    const first = extensionDirectory(root, 'one');
    const resolution = extensions.resolveExtensionPaths({
      [SETTING_VAR]: `${first},relative-two,${path.join(root, 'three')}`,
    });
    expect(resolution.error?.index).toBe(1);
    expect(resolution.error?.detail).toContain('entry 2');
    expect(resolution.paths).toBeNull();
  });

  it('lets an explicit environment variable win over the setting', () => {
    const root = tempRoot('ext-env-');
    const fromEnv = extensionDirectory(root, 'from-env');
    const fromSetting = extensionDirectory(root, 'from-setting');
    const resolution = extensions.resolveExtensionPaths({
      [ENV_VAR]: fromEnv,
      [SETTING_VAR]: fromSetting,
    });
    expect(resolution.source).toBe('environment');
    expect(resolution.paths).toEqual([fromEnv]);
  });

  it('builds one complete sentence for a bad value', () => {
    const root = tempRoot('ext-text-');
    const resolution = extensions.resolveExtensionPaths({ [SETTING_VAR]: path.join(root, 'absent') });
    const text = extensions.extensionPathsProblemText(resolution.error!);
    expect(text).toContain('Unpacked extensions: entry 1');
    expect(text).toContain('absolute unpacked-extension directories');
  });
});

describe('the child environment', () => {
  const base = { PATH: '/bin', HOME: '/home/user' };

  it('is unchanged when no list is configured', () => {
    const env = extensions.backendEnvironment(base, { engineId: 'cloak' });
    expect(env).toEqual({ ...base, PLAYWRIGHT_MCP_BROWSER_ENGINE: 'cloak' });
    expect(Object.hasOwn(env, ENV_VAR)).toBe(false);
    const empty = extensions.backendEnvironment(base, { engineId: 'cloak', extensionPaths: [] });
    expect(empty).toEqual({ ...base, PLAYWRIGHT_MCP_BROWSER_ENGINE: 'cloak' });
    const nulled = extensions.backendEnvironment(base, { engineId: 'cloak', extensionPaths: null });
    expect(nulled).toEqual({ ...base, PLAYWRIGHT_MCP_BROWSER_ENGINE: 'cloak' });
  });

  it('carries the list as a JSON string array, which the bridge parses', () => {
    const env = extensions.backendEnvironment(base, {
      engineId: 'cloak',
      extensionPaths: ['C:\\ext\\one', 'C:\\ext\\two'],
    });
    expect(env[ENV_VAR]).toBe('["C:\\\\ext\\\\one","C:\\\\ext\\\\two"]');
    expect(JSON.parse(String(env[ENV_VAR]))).toEqual(['C:\\ext\\one', 'C:\\ext\\two']);
  });

  it('never carries extensions on an isolated start', () => {
    const env = extensions.backendEnvironment(
      { ...base, [ENV_VAR]: '["C:\\\\ext"]' },
      { engineId: 'cloak', isolated: true, extensionPaths: ['C:\\ext'] },
    );
    expect(Object.hasOwn(env, ENV_VAR)).toBe(false);
    expect(env.PLAYWRIGHT_MCP_ISOLATED).toBe('true');
  });
});

describe('the engine manifest declares support', () => {
  it('is true only for the cloak engine', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (name: string) =>
      JSON.parse(readFileSync(path.join(pluginDir, 'engines', `${name}.json`), 'utf8')) as Record<
        string,
        unknown
      >;
    expect(registry.manifestExtensionPaths(read('cloak'))).toBe(true);
    for (const name of ['playwright', 'camoufox', 'camoufox-native', 'kameleo']) {
      expect(registry.manifestExtensionPaths(read(name))).toBe(false);
    }
    expect(registry.manifestExtensionPaths(null)).toBe(false);
    expect(registry.manifestExtensionPaths({ extensionPaths: 'yes' })).toBe(false);
  });

  it('validates the field as an optional boolean', () => {
    const manifest = {
      schemaVersion: 1,
      id: 'probe',
      label: 'Probe',
      transport: 'launch',
      contract: 'playwright-mcp',
      defaultToolProfile: 'full',
      toolSupport: { '*': 'full' },
      notes: 'probe',
      extensionPaths: 'yes',
    };
    expect(registry.validateManifest(manifest, 'probe', ['full'])).toBe('extensionPaths must be a boolean');
    expect(registry.validateManifest({ ...manifest, extensionPaths: true }, 'probe', ['full'])).toBeNull();
    expect(
      registry.validateManifest({ ...manifest, extensionPaths: undefined }, 'probe', ['full']),
    ).toBeNull();
  });
});

describe('broker: the setting is not configured', () => {
  it('adds no key, passes nothing to the child and keeps the meta-tools unchanged', async () => {
    const dataDir = createRuntime(tempRoot('ext-unset-'));
    const session = startBroker({ dataDir });
    await initialize(session);
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
    const facts = await childFacts(session);
    expect(facts.extensionPaths).toBeNull();
    const caps = await capabilities(session);
    const state = await status(session);
    for (const payload of [caps, state]) {
      expect(Object.keys(payload).filter((key) => key.startsWith('extension'))).toEqual([]);
    }
  });

  it('ignores a placeholder the host did not substitute', async () => {
    const dataDir = createRuntime(tempRoot('ext-placeholder-'));
    const session = startBroker({ dataDir, setting: '${user_config.extension_paths}' });
    await initialize(session);
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
    const caps = await capabilities(session);
    expect(Object.keys(caps).filter((key) => key.startsWith('extension'))).toEqual([]);
    expect(session.stderr()).toContain('ignoring unsubstituted extension-paths placeholder');
  });
});

describe('broker: a configured list reaches the cloak backend', () => {
  it('passes the canonical directories as a JSON array and reports them', async () => {
    const root = tempRoot('ext-apply-');
    const dataDir = createRuntime(root);
    const first = extensionDirectory(root, 'one');
    const second = extensionDirectory(root, 'two');
    const session = startBroker({ dataDir, setting: `${first},${second}` });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions ?? '').not.toContain('Unpacked extensions');
    const facts = await childFacts(session);
    expect(facts.extensionPaths).toBe(JSON.stringify([first, second]));
    const caps = await capabilities(session);
    expect(caps.extensionPathsSupported).toBe(true);
    expect(caps.extensionPaths).toEqual({
      configured: true,
      count: 2,
      source: 'setting',
      applies: true,
      paths: [first, second],
    });
    const state = await status(session);
    expect(state.extensionPaths).toEqual(caps.extensionPaths);
    expect(state.extensionPathsSupported).toBe(true);
  });

  it('takes the list from an explicit environment variable first', async () => {
    const root = tempRoot('ext-precedence-');
    const dataDir = createRuntime(root);
    const fromEnv = extensionDirectory(root, 'from-env');
    const fromSetting = extensionDirectory(root, 'from-setting');
    const session = startBroker({
      dataDir,
      setting: fromSetting,
      environment: JSON.stringify([fromEnv]),
    });
    await initialize(session);
    const facts = await childFacts(session);
    expect(facts.extensionPaths).toBe(JSON.stringify([fromEnv]));
    const caps = await capabilities(session);
    expect(caps.extensionPaths).toMatchObject({ source: 'environment', count: 1, applies: true });
  });
});

describe('broker: a list it cannot honour refuses the start', () => {
  async function refused(options: BrokerOptions): Promise<{
    session: BrokerSession;
    caps: Record<string, unknown>;
    state: Record<string, unknown>;
    instructions: string;
  }> {
    const session = startBroker(options);
    const initialized = await initialize(session);
    const names = await toolNames(session);
    expect(names).toEqual(META_TOOLS);
    const caps = await capabilities(session);
    const state = await status(session);
    return { session, caps, state, instructions: initialized.result?.instructions ?? '' };
  }

  it('names the entry that is not an absolute path and spawns no backend', async () => {
    const dataDir = createRuntime(tempRoot('ext-refuse-relative-'));
    const { caps, state, instructions } = await refused({ dataDir, setting: 'extensions/one' });
    const sentence = engineErrorText(caps);
    expect(sentence).toContain('Unpacked extensions: entry 1');
    expect(sentence).toContain('is not an absolute path');
    expect(sentence).toContain('The backend was not started.');
    expect(instructions).toContain('The cloak backend is unavailable');
    expect(state.backendState).toBe('failed');
    expect(state.backendPid).toBeNull();
    expect(caps.extensionPaths).toMatchObject({ configured: true, count: 1, applies: false });
    expect(String(caps.extensionPaths && (caps.extensionPaths as Record<string, unknown>).error)).toContain(
      'entry 1',
    );
  });

  it('names a directory that does not exist', async () => {
    const root = tempRoot('ext-refuse-missing-');
    const dataDir = createRuntime(root);
    const { caps } = await refused({ dataDir, setting: path.join(root, 'absent') });
    expect(engineErrorText(caps)).toContain('does not exist');
  });

  it('names a duplicate entry', async () => {
    const root = tempRoot('ext-refuse-duplicate-');
    const dataDir = createRuntime(root);
    const directory = extensionDirectory(root, 'one');
    const { caps } = await refused({
      dataDir,
      setting: `${directory},${path.join(directory, '.')}`,
    });
    expect(engineErrorText(caps)).toContain('repeats entry 1');
  });

  it('refuses an isolated start, because extensions need a persistent profile', async () => {
    const root = tempRoot('ext-refuse-isolated-');
    const dataDir = createRuntime(root);
    const directory = extensionDirectory(root, 'one');
    const { caps, state, instructions } = await refused({
      dataDir,
      setting: directory,
      isolation: 'isolated',
    });
    expect(engineErrorText(caps)).toContain('Unpacked extensions need a persistent browser profile');
    expect(engineErrorText(caps)).toContain('The backend was not started.');
    expect(instructions).toContain('persistent browser profile');
    expect(state.backendPid).toBeNull();
    expect(caps.extensionPaths).toMatchObject({ configured: true, applies: false });
    expect(String((caps.extensionPaths as Record<string, unknown>).note)).toContain('isolated');
  });

  it('refuses a start that became isolated through on_locked', async () => {
    const root = tempRoot('ext-refuse-on-locked-');
    const dataDir = createRuntime(root);
    const directory = extensionDirectory(root, 'one');
    const base = path.join(dataDir, 'profiles', 'default');
    mkdirSync(base, { recursive: true });
    writeFileSync(
      path.join(base, LOCK),
      `${JSON.stringify({ pid: process.pid, createdAt: '2026-10-28T00:00:00.000Z', userDataDir: base }, null, 2)}\n`,
    );
    const { caps } = await refused({
      dataDir,
      setting: directory,
      onLocked: 'isolated',
    });
    expect(engineErrorText(caps)).toContain('persistent browser profile');
    expect(caps.onLocked).toBe('isolated');
    expect(caps.profileSource).toBe('isolated');
  });
});

describe('broker: an engine without extension support', () => {
  it('starts normally and reports the setting as not applicable', async () => {
    const root = tempRoot('ext-playwright-');
    const dataDir = createRuntime(root);
    const directory = extensionDirectory(root, 'one');
    const session = startBroker({ dataDir, engine: 'playwright', setting: directory });
    await initialize(session);
    expect(await toolNames(session)).toEqual([...STUB_TOOLS, ...META_TOOLS]);
    const facts = await childFacts(session);
    expect(facts.engine).toBe('playwright');
    expect(facts.extensionPaths).toBeNull();
    const caps = await capabilities(session);
    expect(caps.engineError).toBeNull();
    expect(caps.extensionPathsSupported).toBe(false);
    expect(caps.extensionPaths).toMatchObject({ configured: true, count: 1, applies: false });
    expect(String((caps.extensionPaths as Record<string, unknown>).note)).toContain(
      'does not declare unpacked-extension support',
    );
    expect(Object.hasOwn(caps.extensionPaths as Record<string, unknown>, 'paths')).toBe(false);
  });
});

describe('documentation and manifests', () => {
  it('declares the setting in the universal plugin only', async () => {
    const { readFileSync } = await import('node:fs');
    const universal = JSON.parse(
      readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as {
      version: string;
      userConfig: Record<string, { type?: string; default?: unknown; description?: string }>;
    };
    expect(universal.version).toBe('2.21.0');
    const setting = universal.userConfig.extension_paths;
    expect(setting).toBeDefined();
    expect(setting.type).toBe('string');
    expect(setting.default).toBe('');
    const description = String(setting.description);
    for (const token of [
      'unpacked',
      'JSON string array',
      'comma-separated',
      'Web Store',
      'disabled_tools',
      'signature check',
      'profile copies',
      'copy-keep',
      'cloak engine only',
      'persistent profile',
      'CLOAK_PLAYWRIGHT_MCP_EXTENSION_PATHS',
    ]) {
      expect(description.toLowerCase()).toContain(token.toLowerCase());
    }
    const camoufoxPlugin = JSON.parse(
      readFileSync(path.join(repoRoot, 'plugins', 'camoufox', '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { version: string; userConfig: Record<string, unknown> };
    expect(camoufoxPlugin.version).toBe('2.21.0');
    expect(Object.hasOwn(camoufoxPlugin.userConfig, 'extension_paths')).toBe(false);
  });

  it('documents the setting, the warning and the profile modes', async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(path.join(pluginDir, 'README.md'), 'utf8');
    expect(readme).toContain('### Unpacked extensions');
    expect(readme).toContain('| Unpacked extensions | empty |');
    for (const token of [
      'Chrome Web Store',
      'bypasses `disabled_tools`',
      'no signature check',
      'no automatic update',
      '`copy` discards',
      '`copy-keep`',
      'only these directories are enabled',
      '`chrome://extensions`',
      'isolated',
    ]) {
      expect(readme).toContain(token);
    }
    const enginesReadme = readFileSync(path.join(pluginDir, 'engines', 'README.md'), 'utf8');
    expect(enginesReadme).toContain('`extensionPaths`');
  });
});
