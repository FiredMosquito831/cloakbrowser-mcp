import { spawn, spawnSync } from 'node:child_process';
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
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Camoufox device identity (2.14.0). The entry point owns the file and the
// generated CAMOUFOX_MCP_CONFIG; the broker reports the same facts. This suite
// pins:
//   - both plugin manifests offer identity_mode (profile default, random escape
//     hatch) with honest help, and both .mcp.json files map it;
//   - the Python logic: generation, reuse, corruption, random/isolated no-ops,
//     user-config JSON merge vs INI/unreadable passthrough (tests/python);
//   - the broker meta-tools and the initialize sentence for every engine and
//     mode, with the non-applying engines saying so;
//   - profile copies of every kind carry the identity file;
//   - the entry hook runs before the wrapper and prints only to stderr.
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
  pluginDir: string;
  dataDir: string;
  engine: string;
  identityMode?: string;
  isolation?: string;
  account?: string;
  profileDir?: string;
  cwd?: string;
  env?: Record<string, string>;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const universalDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const camoufoxPluginDir = path.join(repoRoot, 'plugins', 'camoufox');
const entryPath = path.join(repoRoot, 'shared', 'core', 'camoufox_entry.py');
const pythonSuitePath = path.join(repoRoot, 'tests', 'python', 'test_camoufox_identity.py');
const profileModulePath = new URL('../../plugins/cloakbrowser/lib/profile.mjs', import.meta.url);

const STUB_SOURCE = `import readline from 'node:readline';
const TOOLS = ['browser_navigate', 'browser_snapshot', 'browser_click'];
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'stub-identity', version: '0.0.0' },
      instructions: 'stub instructions.',
    } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({
      name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} },
    })) } });
    return;
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({
      identityMode: process.env.STEALTH_IDENTITY_MODE ?? null,
      profileDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? null,
      camoufoxConfig: process.env.CAMOUFOX_MCP_CONFIG ?? null,
    }) }], isError: false } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: {} });
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

// The real broker, registry, libs, manifests and contracts with stub launchers:
// the meta-tools are the shipped ones, and no engine is provisioned or started.
function createStubPlugin(root: string): string {
  const plugin = path.join(root, 'plugin');
  const engines = path.join(plugin, 'engines');
  const lib = path.join(plugin, 'lib');
  mkdirSync(engines, { recursive: true });
  mkdirSync(lib, { recursive: true });
  mkdirSync(path.join(plugin, 'contracts'), { recursive: true });
  for (const file of ['broker.mjs', 'engine-registry.mjs']) {
    copyFileSync(path.join(universalDir, file), path.join(plugin, file));
  }
  for (const file of [
    'attach.mjs',
    'camoufox-overlay.mjs',
    'launcher-settings.mjs',
    'password-manager.mjs',
    'ping-timeout.mjs',
    'profile.mjs',
    'provision.mjs',
    'surface.mjs',
    'tool-cache.mjs',
  ]) {
    copyFileSync(path.join(universalDir, 'lib', file), path.join(lib, file));
  }
  for (const file of ['camoufox.json', 'cloak.json', 'camoufox-native.json']) {
    copyFileSync(path.join(universalDir, 'engines', file), path.join(engines, file));
  }
  copyFileSync(path.join(universalDir, 'engines', 'profiles.json'), path.join(engines, 'profiles.json'));
  copyFileSync(
    path.join(universalDir, 'contracts', 'playwright-canonical.json'),
    path.join(plugin, 'contracts', 'playwright-canonical.json'),
  );
  for (const launcher of ['launch.mjs', 'launch-camoufox.mjs', 'launch-camoufox-native.mjs']) {
    writeFileSync(path.join(plugin, launcher), STUB_SOURCE);
  }
  return plugin;
}

function startBroker(options: BrokerOptions): BrokerSession {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: options.dataDir,
    STEALTH_ENGINE: options.engine,
    STEALTH_TOOL_PROFILE: 'full',
    PLAYWRIGHT_MCP_OUTPUT_DIR: path.join(options.dataDir, 'artifacts'),
    ...(options.identityMode === undefined ? {} : { STEALTH_IDENTITY_MODE: options.identityMode }),
    ...(options.env ?? {}),
  };
  for (const name of [
    'STEALTH_ACCOUNT',
    'STEALTH_PROFILE_ISOLATION',
    'PLAYWRIGHT_MCP_USER_DATA_DIR',
    'PLAYWRIGHT_MCP_ISOLATED',
    'CAMOUFOX_MCP_CONFIG',
    'PLAYWRIGHT_MCP_CONFIG',
  ]) {
    if (!(name in (options.env ?? {}))) {
      delete env[name];
    }
  }
  if (options.isolation !== undefined) env.STEALTH_PROFILE_ISOLATION = options.isolation;
  if (options.account !== undefined) env.STEALTH_ACCOUNT = options.account;
  if (options.profileDir !== undefined) env.PLAYWRIGHT_MCP_USER_DATA_DIR = options.profileDir;
  const child = spawn(process.execPath, [path.join(options.pluginDir, 'broker.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd: options.cwd,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const pending = new Map<number, (message: JsonRpcResponse) => void>();
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim() === '') return;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id) as (value: JsonRpcResponse) => void;
      pending.delete(message.id);
      resolve(message);
    }
  });
  let nextId = 1;
  const request = (method: string, params?: Record<string, unknown>, timeoutMs = 10000) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}; stderr=${stderr.slice(-600)}`));
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

function storedIdentity(createdAt = '2026-10-26T01:02:03Z'): Record<string, unknown> {
  return {
    version: 1,
    engine: 'camoufox',
    createdAt,
    build: 'v156.0.1-beta.39',
    os: 'windows',
    fingerprint: fingerprintRecord(),
  };
}

function fingerprintRecord(): Record<string, unknown> {
  return {
    os: 'Windows',
    navigator: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0',
      platform: 'Win32',
      hardwareConcurrency: 8,
    },
    screen: { width: 1920, height: 1080, colorDepth: 24 },
  };
}

function profileIdentityFile(dataDir: string, engine = 'camoufox', name = 'default'): string {
  return path.join(dataDir, 'profiles', engine, name, '.camoufox-identity.json');
}

function writeIdentity(dataDir: string, value: unknown, engine = 'camoufox', name = 'default'): string {
  const file = profileIdentityFile(dataDir, engine, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

describe('identity_mode in the shipped manifests', () => {
  const manifests = ['cloakbrowser', 'camoufox'] as const;

  it('offers profile (default) and random with honest help in both plugins', () => {
    for (const name of manifests) {
      const plugin = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'),
      ) as {
        version: string;
        userConfig: Record<
          string,
          { type?: string; default?: unknown; options?: string[]; description?: string }
        >;
      };
      const setting = plugin.userConfig.identity_mode;
      expect(setting, `${name} declares identity_mode`).toBeDefined();
      expect(setting.options).toEqual(['profile', 'random']);
      expect(setting.default).toBe('profile');
      expect(setting.description).toContain('.camoufox-identity.json');
      expect(setting.description).toContain('random');
      expect(setting.description).toContain('isolated');
      expect(plugin.version).toBe('2.22.0');
    }
    const universal = JSON.parse(
      readFileSync(path.join(universalDir, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { userConfig: Record<string, { description?: string }> };
    for (const engine of ['cloak', 'playwright', 'camoufox-native', 'kameleo']) {
      expect(universal.userConfig.identity_mode.description?.toLowerCase()).toContain(engine);
    }
    const camoufox = JSON.parse(
      readFileSync(path.join(camoufoxPluginDir, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { userConfig: Record<string, { description?: string }> };
    expect(camoufox.userConfig.identity_mode.description).toContain('CAMOUFOX_MCP_CONFIG');
  });

  it('maps the setting to one environment reference per plugin', () => {
    for (const name of manifests) {
      const mcp = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, '.mcp.json'), 'utf8'),
      ) as Record<string, { env?: Record<string, string> }>;
      const env = mcp[name].env ?? {};
      expect(env.STEALTH_IDENTITY_MODE).toBe('${user_config.identity_mode}');
      expect(Object.values(env).filter((value) => value === '${user_config.identity_mode}')).toHaveLength(1);
    }
  });

  it('keeps both plugin copies of the entry point identical to the shared core', () => {
    const canonical = readFileSync(entryPath);
    for (const name of manifests) {
      expect(readFileSync(path.join(repoRoot, 'plugins', name, 'camoufox_entry.py')).equals(canonical)).toBe(
        true,
      );
    }
  });
});

describe('the entry point identity hook', () => {
  const source = readFileSync(entryPath, 'utf8');

  function mainBody(): { index: number; text: string; indent: number }[] {
    const lines = source.split('\n').map((text, index) => ({
      index,
      text,
      indent: text.length - text.trimStart().length,
    }));
    const start = lines.findIndex((line) => line.text.trimStart().startsWith('def main()'));
    expect(start).toBeGreaterThanOrEqual(0);
    const body = [];
    for (const line of lines.slice(start + 1)) {
      if (line.text.trim() !== '' && line.indent === 0) break;
      body.push(line);
    }
    return body;
  }

  it('applies the identity before the wrapper is imported, and never prints to stdout', () => {
    const body = mainBody();
    const hook = body.filter((line) => line.text.trim() === '_apply_identity_safely()');
    const wrapper = body.filter((line) => line.text.trim() === 'wrapper_main()');
    expect(hook).toHaveLength(1);
    expect(wrapper).toHaveLength(1);
    expect(hook[0].indent).toBe(4);
    expect(hook[0].index).toBeLessThan(wrapper[0].index);
    expect(body.filter((line) => line.text.includes('print('))).toHaveLength(1);
    expect(body.find((line) => line.text.includes('print('))?.text).toContain('file=sys.stderr');
  });

  it('wraps the hook so a failure can never stop the server', () => {
    expect(source).toContain('def _apply_identity_safely() -> None:');
    const safe = source.slice(source.indexOf('def _apply_identity_safely'));
    const block = safe.slice(0, safe.indexOf('\ndef '));
    expect(block).toContain('try:');
    expect(block).toContain('except Exception');
    expect(block).toContain('_log(');
    // _log is the only writer and always targets stderr.
    const logger = source.slice(source.indexOf('def _log('));
    expect(logger.slice(0, logger.indexOf('\ndef '))).toContain('file=sys.stderr');
  });
});

describe('the Python identity logic', () => {
  function findPython(): string | null {
    const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
    for (const candidate of candidates) {
      const result = spawnSync(candidate, ['--version'], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      if (result.status !== 0) {
        continue;
      }
      const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
      const match = /Python 3\.(\d+)/u.exec(text);
      if (match !== null && Number(match[1]) >= 8) {
        return candidate;
      }
    }
    return null;
  }

  const python = findPython();

  it('generates, reuses, regenerates and passes configs through as specified', (context) => {
    if (python === null) {
      context.skip();
      return;
    }
    const result = spawnSync(python, ['-I', pythonSuitePath], {
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(output).toContain('RESULT');
    expect(output).toContain('0 failed');
    expect(result.status).toBe(0);
  });
});

describe('broker reporting and instructions', () => {
  it('reports the stored identity of a persistent Camoufox profile', async () => {
    const root = tempRoot('identity-profile-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    const file = writeIdentity(dataDir, storedIdentity());
    const session = startBroker({ pluginDir: plugin, dataDir, engine: 'camoufox' });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain(
      'Device identity: this profile keeps one device identity',
    );
    expect(initialized.result?.instructions).toContain(file);

    const payload = await capabilities(session);
    expect(payload).toMatchObject({
      identityMode: 'profile',
      identityApplies: true,
      identitySource: 'profile-file',
      identityFile: file,
      identityCreatedAt: '2026-10-26T01:02:03Z',
    });
    expect(Object.hasOwn(payload, 'identityNote')).toBe(false);
    const statusPayload = await status(session);
    expect(statusPayload).toMatchObject({
      identityMode: 'profile',
      identityApplies: true,
      identitySource: 'profile-file',
      identityFile: file,
      identityCreatedAt: '2026-10-26T01:02:03Z',
    });
    // The identity file is never rewritten by a read.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(storedIdentity());
  });

  it('reports a profile whose identity file does not exist yet', async () => {
    const root = tempRoot('identity-missing-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    const session = startBroker({ pluginDir: plugin, dataDir, engine: 'camoufox' });
    await initialize(session);
    const payload = await capabilities(session);
    expect(payload.identitySource).toBe('profile-file');
    expect(payload.identityFile).toBe(profileIdentityFile(dataDir));
    expect(payload.identityCreatedAt).toBeNull();
    expect(existsSync(payload.identityFile as string)).toBe(false);
  });

  it('reports identity_mode=random and keeps today’s launch path', async () => {
    const root = tempRoot('identity-random-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    writeIdentity(dataDir, storedIdentity());
    const session = startBroker({ pluginDir: plugin, dataDir, engine: 'camoufox', identityMode: 'random' });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain('identity_mode is "random"');
    const payload = await capabilities(session);
    expect(payload).toMatchObject({
      identityMode: 'random',
      identityApplies: true,
      identitySource: 'random',
      identityFile: null,
      identityCreatedAt: null,
    });
    expect(payload.identityNote).toContain('identity_mode is "random"');
  });

  it('reports an isolated start and its sentence', async () => {
    const root = tempRoot('identity-isolated-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    const session = startBroker({ pluginDir: plugin, dataDir, engine: 'camoufox', isolation: 'isolated' });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain('this isolated start has no profile');
    const payload = await capabilities(session);
    expect(payload).toMatchObject({
      identityMode: 'profile',
      identityApplies: true,
      identitySource: 'isolated',
      identityFile: null,
      identityCreatedAt: null,
    });
    expect(payload.identityNote).toContain('isolated');
    expect(payload.profileIsolationNote).toBeDefined();
  });

  it('reports a corrupt identity file and a regenerated one', async () => {
    const root = tempRoot('identity-corrupt-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    writeIdentity(dataDir, '{not json');
    const session = startBroker({ pluginDir: plugin, dataDir, engine: 'camoufox' });
    await initialize(session);
    const payload = await capabilities(session);
    expect(payload.identitySource).toBe('profile-file');
    expect(payload.identityCreatedAt).toBeNull();
    expect(payload.identityNote).toContain('is unreadable');

    writeIdentity(dataDir, { ...storedIdentity(), regeneratedAt: '2026-10-26T04:05:06Z' });
    const next = await capabilities(session);
    expect(next.identityCreatedAt).toBe('2026-10-26T01:02:03Z');
    expect(next.identityNote).toContain('was corrupt and was regenerated at 2026-10-26T04:05:06Z');
  });

  it('reports an INI or unreadable user config as not pinned', async () => {
    const root = tempRoot('identity-ini-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    const ini = path.join(root, 'user.ini');
    writeFileSync(ini, 'browser = camoufox\n');
    const session = startBroker({
      pluginDir: plugin,
      dataDir,
      engine: 'camoufox',
      env: { CAMOUFOX_MCP_CONFIG: ini },
    });
    await initialize(session);
    const payload = await capabilities(session);
    expect(payload).toMatchObject({ identitySource: 'random', identityFile: null, identityCreatedAt: null });
    expect(payload.identityNote).toContain('INI or unreadable');
    expect(payload.identityNote).toContain(ini);
  });

  it('reports a JSON user config as pinned (the entry merges a copy)', async () => {
    const root = tempRoot('identity-json-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    const theirs = path.join(root, 'user.json');
    writeJson(theirs, { browser: { camoufoxOptions: { headless: false } } });
    const session = startBroker({
      pluginDir: plugin,
      dataDir,
      engine: 'camoufox',
      env: { CAMOUFOX_MCP_CONFIG: theirs },
    });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain('keeps one device identity');
    const payload = await capabilities(session);
    expect(payload.identitySource).toBe('profile-file');
    expect(payload.identityFile).toBe(profileIdentityFile(dataDir));
  });

  it('treats a null browser section as absent, like the entry does', async () => {
    const root = tempRoot('identity-json-null-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    const theirs = path.join(root, 'user-null.json');
    writeJson(theirs, { browser: null });
    const session = startBroker({
      pluginDir: plugin,
      dataDir,
      engine: 'camoufox',
      env: { CAMOUFOX_MCP_CONFIG: theirs },
    });
    await initialize(session);
    expect((await capabilities(session)).identitySource).toBe('profile-file');
  });

  it('gives a workspace profile its own identity file', async () => {
    const root = tempRoot('identity-workspace-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    const cwd = path.join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const session = startBroker({
      pluginDir: plugin,
      dataDir,
      engine: 'camoufox',
      isolation: 'workspace',
      cwd,
    });
    await initialize(session);
    const payload = await capabilities(session);
    expect(payload.identityFile).toMatch(
      /profiles[\\/]camoufox[\\/]ws-[0-9a-f]{7}[\\/]\.camoufox-identity\.json$/u,
    );
    expect(payload.identityFile).not.toBe(profileIdentityFile(dataDir));
  });

  it('reports the session copy of a copy-mode start, which carries the file', async () => {
    const root = tempRoot('identity-copy-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    const baseFile = writeIdentity(dataDir, storedIdentity());
    // profile_lifetime "server" keeps the 2.19 timing for this test: the copy is
    // taken at start, so it already exists when the meta-tool answers.
    const session = startBroker({
      pluginDir: plugin,
      dataDir,
      engine: 'camoufox',
      isolation: 'copy',
      env: { STEALTH_PROFILE_LIFETIME: 'server' },
    });
    await initialize(session);
    const payload = await capabilities(session);
    const copy = payload.profileCopy as { sessionDir: string } | undefined;
    expect(copy?.sessionDir).toBeTruthy();
    const expected = path.join(copy?.sessionDir ?? '', '.camoufox-identity.json');
    expect(payload.identityFile).toBe(expected);
    expect(payload.identityCreatedAt).toBe('2026-10-26T01:02:03Z');
    // The copy carries the base's identity byte for byte.
    expect(readFileSync(expected, 'utf8')).toBe(readFileSync(baseFile, 'utf8'));
  });

  it('reports copy-keep the same way while the session runs', async () => {
    const root = tempRoot('identity-copy-keep-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    writeIdentity(dataDir, storedIdentity());
    const session = startBroker({ pluginDir: plugin, dataDir, engine: 'camoufox', isolation: 'copy-keep' });
    await initialize(session);
    const payload = await capabilities(session);
    expect(payload.profileIsolation).toBe('copy-keep');
    expect(payload.identitySource).toBe('profile-file');
    expect(payload.identityFile).toContain(`${path.sep}.sessions${path.sep}`);
  });

  it('says the setting is inert on engine that cannot pin', async () => {
    const root = tempRoot('identity-inert-');
    const plugin = createStubPlugin(root);
    const cloak = startBroker({ pluginDir: plugin, dataDir: path.join(root, 'cloak-data'), engine: 'cloak' });
    const cloakInit = await initialize(cloak);
    expect(cloakInit.result?.instructions ?? '').not.toContain('Device identity');
    expect(await capabilities(cloak)).toMatchObject({
      identityMode: 'profile',
      identityApplies: false,
      identitySource: 'not-applicable',
      identityFile: null,
      identityCreatedAt: null,
    });
    expect((await capabilities(cloak)).identityNote).toContain('applies only to the camoufox engine');

    const native = startBroker({
      pluginDir: plugin,
      dataDir: path.join(root, 'native-data'),
      engine: 'camoufox-native',
    });
    const nativeInit = await initialize(native);
    expect(nativeInit.result?.instructions ?? '').not.toContain('Device identity');
    const nativePayload = await capabilities(native);
    expect(nativePayload).toMatchObject({
      identityApplies: false,
      identitySource: 'native-unavailable',
      identityFile: null,
    });
    expect(nativePayload.identityNote).toContain('no fingerprint input');
    expect(nativePayload.identityNote).toContain('identity_mode has no effect');
  });

  it('passes the resolved mode to the engine through the launcher environment', async () => {
    const root = tempRoot('identity-env-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    const session = startBroker({ pluginDir: plugin, dataDir, engine: 'camoufox', identityMode: 'random' });
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: 'http://127.0.0.1:9/' },
    });
    const echoed = JSON.parse(response.result?.content?.[0]?.text ?? '{}') as { identityMode: string | null };
    expect(echoed.identityMode).toBe('random');
  });

  it('keeps an empty identity_mode on the documented default', async () => {
    const root = tempRoot('identity-empty-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    const session = startBroker({ pluginDir: plugin, dataDir, engine: 'camoufox', identityMode: '' });
    await initialize(session);
    expect((await capabilities(session)).identityMode).toBe('profile');
    expect((await capabilities(session)).identitySource).toBe('profile-file');
  });
});

describe('the identity file travels with every profile copy', () => {
  it('is included by the shared copy plan and copied byte for byte', async () => {
    const profile = (await import(profileModulePath.href)) as unknown as {
      planCopy: (
        source: string,
        options?: { engineLockFile?: string | null },
      ) => { files: { relative: string; source: string }[]; excluded: Record<string, number> };
      copyPlanToTarget: (plan: unknown, target: string) => void;
    };
    const root = tempRoot('identity-copy-plan-');
    const base = path.join(root, 'base');
    mkdirSync(path.join(base, 'storage'), { recursive: true });
    const file = path.join(base, '.camoufox-identity.json');
    writeFileSync(file, `${JSON.stringify(storedIdentity(), null, 2)}\n`);
    writeFileSync(path.join(base, 'prefs.js'), 'user_pref("x", 1);\n');
    const plan = profile.planCopy(base, { engineLockFile: 'parent.lock' });
    const relatives = plan.files.map((entry) => entry.relative.split(path.sep).join('/'));
    expect(relatives).toContain('.camoufox-identity.json');
    expect(plan.excluded.engineLock).toBe(0);
    const target = path.join(root, 'copy');
    profile.copyPlanToTarget(plan, target);
    expect(readFileSync(path.join(target, '.camoufox-identity.json'), 'utf8')).toBe(
      readFileSync(file, 'utf8'),
    );
  });
});
