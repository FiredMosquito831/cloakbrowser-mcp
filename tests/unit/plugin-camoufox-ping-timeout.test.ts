import { spawn } from 'node:child_process';
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
import { afterEach, describe, expect, it, vi } from 'vitest';

// Camoufox server-heartbeat timeout (2.14.1). The wrapper pings its client every
// 3 s and closes the browser when an answer is more than 5 s late; the plugin now
// disables that heartbeat by default (`ping_timeout_ms` 0) because one late
// answer lost the browser, while an explicit `PLAYWRIGHT_MCP_PING_TIMEOUT_MS`
// still wins as the operator escape hatch. This suite pins:
//   - the setting in both manifests (number, default 0, honest help) and its
//     environment mapping;
//   - the shared helper's precedence and validation;
//   - the camoufox launcher's child environment: 0 by default, a positive
//     setting, the explicit value, one stderr line for an unusable value;
//   - that every other launcher neither adds nor rewrites the variable;
//   - the meta-tool report and its not-applicable wording for other engines.
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
  cwd?: string;
  env?: Record<string, string>;
}

interface PingHelperModule {
  PING_TIMEOUT_DEFAULT_MS: number;
  PING_TIMEOUT_ENGINE_ID: string;
  PING_TIMEOUT_ENV_VAR: string;
  PING_TIMEOUT_SETTING_VAR: string;
  applyPingTimeout(env: Record<string, string | undefined>): Resolution;
  pingTimeoutProblemNote(resolution: Resolution): string | null;
  resolvePingTimeout(env?: Record<string, string | undefined>): Resolution;
}

interface Resolution {
  ms: number;
  source: 'env' | 'setting' | 'default';
  variable: string | null;
  raw: string | null;
  problem: 'invalid' | 'placeholder' | null;
}

interface ChildEnvLauncher {
  buildChildEnv(source: Record<string, string | undefined>): Record<string, string | undefined>;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const universalDir = path.join(repoRoot, 'plugins', 'cloakbrowser');

async function loadHelper(): Promise<PingHelperModule> {
  return (await import(
    new URL('../../shared/core/lib/ping-timeout.mjs', import.meta.url).href
  )) as unknown as PingHelperModule;
}

const helper = await loadHelper();
const camoufoxLauncher = (await import(
  new URL('../../shared/core/launch-camoufox.mjs', import.meta.url).href
)) as unknown as ChildEnvLauncher;
const cloakLauncher = (await import(
  new URL('../../shared/core/launch.mjs', import.meta.url).href
)) as unknown as ChildEnvLauncher;
const nativeLauncher = (await import(
  new URL('../../shared/core/launch-camoufox-native.mjs', import.meta.url).href
)) as unknown as ChildEnvLauncher;
const kameleoLauncher = (await import(
  new URL('../../shared/core/launch-kameleo.mjs', import.meta.url).href
)) as unknown as ChildEnvLauncher;

const STUB_SOURCE = `import readline from 'node:readline';
const TOOLS = ['browser_navigate', 'browser_snapshot'];
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'stub-ping-timeout', version: '0.0.0' },
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
  vi.restoreAllMocks();
});

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
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
  for (const file of ['attach.mjs', 'ping-timeout.mjs', 'profile.mjs', 'provision.mjs', 'surface.mjs']) {
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
    ...(options.env ?? {}),
  };
  for (const name of [
    'STEALTH_ACCOUNT',
    'STEALTH_PROFILE_ISOLATION',
    'STEALTH_IDENTITY_MODE',
    'STEALTH_PING_TIMEOUT_MS',
    'PLAYWRIGHT_MCP_PING_TIMEOUT_MS',
    'PLAYWRIGHT_MCP_USER_DATA_DIR',
    'PLAYWRIGHT_MCP_ISOLATED',
    'CAMOUFOX_MCP_CONFIG',
    'PLAYWRIGHT_MCP_CONFIG',
  ]) {
    if (!(name in (options.env ?? {}))) {
      delete env[name];
    }
  }
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

async function payload(session: BrokerSession, tool: string): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name: tool, arguments: {} });
  return response.result?.structuredContent ?? {};
}

const REPORT_KEYS = ['pingTimeoutApplies', 'pingTimeoutMs', 'pingTimeoutSource', 'heartbeatEnabled'] as const;

function pingReport(payloadValue: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(REPORT_KEYS.map((key) => [key, payloadValue[key]]));
}

describe('ping_timeout_ms in the shipped manifests', () => {
  const manifests = ['cloakbrowser', 'camoufox'] as const;

  it('declares a numeric deadline with 0 as the default and honest help', () => {
    for (const name of manifests) {
      const plugin = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'),
      ) as {
        userConfig: Record<
          string,
          { type?: string; default?: unknown; options?: string[]; description?: string }
        >;
      };
      const setting = plugin.userConfig.ping_timeout_ms;
      expect(setting, `${name} declares ping_timeout_ms`).toBeDefined();
      expect(setting.type).toBe('number');
      expect(setting.default).toBe(0);
      expect(Object.hasOwn(setting, 'options')).toBe(false);
      const description = setting.description ?? '';
      expect(description).toContain('camoufox');
      expect(description).toContain('3 s');
      expect(description).toContain('5 s');
      expect(description).toContain('0');
      expect(description).toContain('positive value re-enables');
      expect(description).toContain('PLAYWRIGHT_MCP_PING_TIMEOUT_MS');
      expect(description.toLowerCase()).toContain('non-negative integer');
    }
  });

  it('says in the universal plugin that other engines ignore the setting', () => {
    const universal = JSON.parse(
      readFileSync(path.join(universalDir, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { userConfig: Record<string, { description?: string }> };
    const description = universal.userConfig.ping_timeout_ms.description ?? '';
    expect(description).toContain('other engines');
    expect(description).toContain('ignore');
    expect(description).toContain('browser_capabilities');
  });

  it('maps the setting to one environment reference per plugin', () => {
    for (const name of manifests) {
      const mcp = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, '.mcp.json'), 'utf8'),
      ) as Record<string, { env?: Record<string, string> }>;
      const env = mcp[name].env ?? {};
      expect(env.STEALTH_PING_TIMEOUT_MS).toBe('${user_config.ping_timeout_ms}');
      expect(Object.values(env).filter((value) => value === '${user_config.ping_timeout_ms}')).toHaveLength(
        1,
      );
      // The wrapper's own variable is never hard-coded by the plugin environment:
      // an operator value must reach the resolver untouched.
      expect(Object.hasOwn(env, helper.PING_TIMEOUT_ENV_VAR)).toBe(false);
    }
  });

  it('documents the default and the wrapper variable in the canonical manifest notes', () => {
    for (const name of manifests) {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, 'engines', 'camoufox.json'), 'utf8'),
      ) as { notes: string };
      expect(manifest.notes).toContain('ping_timeout_ms');
      expect(manifest.notes).toContain('PLAYWRIGHT_MCP_PING_TIMEOUT_MS');
      expect(manifest.notes).toContain('3 s');
      expect(manifest.notes).toContain('5 s');
    }
  });
});

describe('the shared ping-timeout helper', () => {
  it('defaults to 0, the disabled heartbeat, when nothing supplies a value', () => {
    expect(helper.PING_TIMEOUT_DEFAULT_MS).toBe(0);
    expect(helper.PING_TIMEOUT_ENGINE_ID).toBe('camoufox');
    expect(helper.PING_TIMEOUT_ENV_VAR).toBe('PLAYWRIGHT_MCP_PING_TIMEOUT_MS');
    expect(helper.PING_TIMEOUT_SETTING_VAR).toBe('STEALTH_PING_TIMEOUT_MS');
    expect(helper.resolvePingTimeout({})).toEqual({
      ms: 0,
      source: 'default',
      variable: null,
      raw: null,
      problem: null,
    });
    expect(helper.resolvePingTimeout()).toEqual(helper.resolvePingTimeout({}));
  });

  it('reads a positive setting as the deadline', () => {
    expect(helper.resolvePingTimeout({ STEALTH_PING_TIMEOUT_MS: '15000' })).toEqual({
      ms: 15000,
      source: 'setting',
      variable: 'STEALTH_PING_TIMEOUT_MS',
      raw: '15000',
      problem: null,
    });
    expect(helper.resolvePingTimeout({ STEALTH_PING_TIMEOUT_MS: ' 0 ' })).toMatchObject({
      ms: 0,
      source: 'setting',
      problem: null,
    });
  });

  it('lets an explicit wrapper value win over the setting', () => {
    expect(
      helper.resolvePingTimeout({
        STEALTH_PING_TIMEOUT_MS: '15000',
        PLAYWRIGHT_MCP_PING_TIMEOUT_MS: '7000',
      }),
    ).toEqual({
      ms: 7000,
      source: 'env',
      variable: 'PLAYWRIGHT_MCP_PING_TIMEOUT_MS',
      raw: '7000',
      problem: null,
    });
    // An empty explicit value is not a value: the setting still applies.
    expect(
      helper.resolvePingTimeout({ STEALTH_PING_TIMEOUT_MS: '15000', PLAYWRIGHT_MCP_PING_TIMEOUT_MS: '  ' }),
    ).toMatchObject({ ms: 15000, source: 'setting' });
  });

  it.each(['abc', '-1', '-0x1', '1.5', '1e3', '12abc', '0x10', 'NaN', 'Infinity', '9007199254740992'])(
    'refuses %j as not a non-negative integer of milliseconds',
    (raw) => {
      const resolution = helper.resolvePingTimeout({ STEALTH_PING_TIMEOUT_MS: raw });
      expect(resolution).toEqual({
        ms: 0,
        source: 'default',
        variable: 'STEALTH_PING_TIMEOUT_MS',
        raw,
        problem: 'invalid',
      });
      expect(helper.pingTimeoutProblemNote(resolution)).toContain(raw);
      expect(helper.pingTimeoutProblemNote(resolution)).toContain('not a non-negative integer');
    },
  );

  it('does not fall through to the setting when the explicit value is wrong', () => {
    expect(
      helper.resolvePingTimeout({
        STEALTH_PING_TIMEOUT_MS: '15000',
        PLAYWRIGHT_MCP_PING_TIMEOUT_MS: 'soon',
      }),
    ).toMatchObject({
      ms: 0,
      source: 'default',
      variable: 'PLAYWRIGHT_MCP_PING_TIMEOUT_MS',
      problem: 'invalid',
    });
  });

  it('recognises an unsubstituted placeholder and says so', () => {
    const resolution = helper.resolvePingTimeout({
      STEALTH_PING_TIMEOUT_MS: '${user_config.ping_timeout_ms}',
    });
    expect(resolution).toMatchObject({ ms: 0, source: 'default', problem: 'placeholder' });
    expect(helper.pingTimeoutProblemNote(resolution)).toContain('placeholder');
    expect(helper.pingTimeoutProblemNote(resolution)).toContain('${user_config.ping_timeout_ms}');
  });

  it('has no note for a usable or absent value', () => {
    expect(helper.pingTimeoutProblemNote(helper.resolvePingTimeout({}))).toBeNull();
    expect(
      helper.pingTimeoutProblemNote(helper.resolvePingTimeout({ STEALTH_PING_TIMEOUT_MS: '5000' })),
    ).toBeNull();
  });

  it('always writes the deadline, including 0, and never mutates the source', () => {
    const env: Record<string, string | undefined> = { STEALTH_PING_TIMEOUT_MS: '2500', KEEP: '1' };
    const resolution = helper.applyPingTimeout(env);
    expect(env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS).toBe('2500');
    expect(env.STEALTH_PING_TIMEOUT_MS).toBe('2500');
    expect(env.KEEP).toBe('1');
    expect(resolution).toMatchObject({ ms: 2500, source: 'setting' });

    const empty: Record<string, string | undefined> = {};
    helper.applyPingTimeout(empty);
    expect(empty.PLAYWRIGHT_MCP_PING_TIMEOUT_MS).toBe('0');
  });
});

describe('the camoufox launcher child environment', () => {
  it('passes 0 by default, so the wrapper installs no heartbeat', () => {
    const source = { PLAYWRIGHT_MCP_HEADLESS: 'true' };
    const env = camoufoxLauncher.buildChildEnv(source);
    expect(env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS).toBe('0');
    expect(source).not.toHaveProperty('PLAYWRIGHT_MCP_PING_TIMEOUT_MS');
    expect(source).toEqual({ PLAYWRIGHT_MCP_HEADLESS: 'true' });
  });

  it('passes a positive setting through', () => {
    const env = camoufoxLauncher.buildChildEnv({ STEALTH_PING_TIMEOUT_MS: '15000' });
    expect(env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS).toBe('15000');
  });

  it('keeps an explicit operator value', () => {
    const env = camoufoxLauncher.buildChildEnv({
      STEALTH_PING_TIMEOUT_MS: '15000',
      PLAYWRIGHT_MCP_PING_TIMEOUT_MS: '7000',
    });
    expect(env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS).toBe('7000');
    const emptySetting = camoufoxLauncher.buildChildEnv({ PLAYWRIGHT_MCP_PING_TIMEOUT_MS: '1' });
    expect(emptySetting.PLAYWRIGHT_MCP_PING_TIMEOUT_MS).toBe('1');
  });

  it.each(['abc', '-1', '1.5'])('falls back to 0 with exactly one stderr line for %j', (raw) => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const env = camoufoxLauncher.buildChildEnv({ STEALTH_PING_TIMEOUT_MS: raw });
    const lines = write.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.includes('Ping timeout'));
    expect(env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS).toBe('0');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(raw);
    expect(lines[0]).toContain('STEALTH_PING_TIMEOUT_MS');
    expect(lines[0]).toContain('[camoufox]');
    write.mockRestore();
  });

  it('logs nothing for an empty setting value', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const env = camoufoxLauncher.buildChildEnv({ STEALTH_PING_TIMEOUT_MS: '' });
    const lines = write.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.includes('Ping timeout'));
    expect(env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS).toBe('0');
    expect(lines).toHaveLength(0);
    write.mockRestore();
  });

  it('never writes the wrapper variable when it cannot parse the source value', () => {
    const env = camoufoxLauncher.buildChildEnv({ PLAYWRIGHT_MCP_PING_TIMEOUT_MS: 'later' });
    expect(env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS).toBe('0');
  });
});

describe('every other launcher stays inert', () => {
  const others = [
    { name: 'cloak', launcher: cloakLauncher },
    { name: 'camoufox-native', launcher: nativeLauncher },
    { name: 'kameleo', launcher: kameleoLauncher },
  ];

  it.each(others)('keeps $name from adding or rewriting the wrapper variable', ({ launcher }) => {
    const base = { PLAYWRIGHT_MCP_HEADLESS: 'true', STEALTH_PING_TIMEOUT_MS: '15000' };
    const env = launcher.buildChildEnv(base);
    expect(Object.hasOwn(env, 'PLAYWRIGHT_MCP_PING_TIMEOUT_MS')).toBe(false);
    const explicit = launcher.buildChildEnv({ ...base, PLAYWRIGHT_MCP_PING_TIMEOUT_MS: '7000' });
    expect(explicit.PLAYWRIGHT_MCP_PING_TIMEOUT_MS).toBe('7000');
    // The setting variable is not a launcher concern for these engines.
    expect(env.STEALTH_PING_TIMEOUT_MS).toBe('15000');
  });

  it.each(['launch.mjs', 'launch-camoufox-native.mjs', 'launch-kameleo.mjs'])(
    'keeps %s free of the helper and the variable',
    (file) => {
      const source = readFileSync(path.join(universalDir, file), 'utf8');
      expect(source).not.toContain('ping-timeout.mjs');
      expect(source).not.toContain('PLAYWRIGHT_MCP_PING_TIMEOUT_MS');
    },
  );

  it('wires only the camoufox launcher to the helper', () => {
    const camoufoxSource = readFileSync(path.join(universalDir, 'launch-camoufox.mjs'), 'utf8');
    expect(camoufoxSource).toContain("from './lib/ping-timeout.mjs'");
    expect(camoufoxSource).toContain('applyPingTimeout(env)');
  });

  it('keeps the broker and launcher resolutions equal', () => {
    for (const source of [
      {},
      { STEALTH_PING_TIMEOUT_MS: '0' },
      { STEALTH_PING_TIMEOUT_MS: '5000' },
      { STEALTH_PING_TIMEOUT_MS: '5000', PLAYWRIGHT_MCP_PING_TIMEOUT_MS: '250' },
      { STEALTH_PING_TIMEOUT_MS: 'bad' },
    ]) {
      const env = camoufoxLauncher.buildChildEnv(source);
      expect(env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS).toBe(String(helper.resolvePingTimeout(source).ms));
    }
  });
});

describe('the meta-tool report', () => {
  async function camoufoxSession(env: Record<string, string>) {
    const root = tempRoot('ping-timeout-broker-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    const session = startBroker({ pluginDir: plugin, dataDir, engine: 'camoufox', env });
    await initialize(session);
    return session;
  }

  it('reports the default: no heartbeat, source default, no note', async () => {
    const session = await camoufoxSession({});
    const capabilities = await payload(session, 'browser_capabilities');
    expect(pingReport(capabilities)).toEqual({
      pingTimeoutApplies: true,
      pingTimeoutMs: 0,
      pingTimeoutSource: 'default',
      heartbeatEnabled: false,
    });
    expect(Object.hasOwn(capabilities, 'pingTimeoutNote')).toBe(false);
    expect(pingReport(await payload(session, 'browser_engine_status'))).toEqual(pingReport(capabilities));
  });

  it('reports a positive setting and its source', async () => {
    const session = await camoufoxSession({ STEALTH_PING_TIMEOUT_MS: '15000' });
    const capabilities = await payload(session, 'browser_capabilities');
    expect(pingReport(capabilities)).toEqual({
      pingTimeoutApplies: true,
      pingTimeoutMs: 15000,
      pingTimeoutSource: 'setting',
      heartbeatEnabled: true,
    });
    expect(Object.hasOwn(capabilities, 'pingTimeoutNote')).toBe(false);
    expect(pingReport(await payload(session, 'browser_engine_status'))).toEqual(pingReport(capabilities));
  });

  it('reports the explicit operator value as the source', async () => {
    const session = await camoufoxSession({
      STEALTH_PING_TIMEOUT_MS: '15000',
      PLAYWRIGHT_MCP_PING_TIMEOUT_MS: '7000',
    });
    const capabilities = await payload(session, 'browser_capabilities');
    expect(pingReport(capabilities)).toEqual({
      pingTimeoutApplies: true,
      pingTimeoutMs: 7000,
      pingTimeoutSource: 'env',
      heartbeatEnabled: true,
    });
  });

  it('reports an ignored value as disabled with the same note the launcher logs', async () => {
    const session = await camoufoxSession({ STEALTH_PING_TIMEOUT_MS: 'nope' });
    const capabilities = await payload(session, 'browser_capabilities');
    expect(pingReport(capabilities)).toEqual({
      pingTimeoutApplies: true,
      pingTimeoutMs: 0,
      pingTimeoutSource: 'default',
      heartbeatEnabled: false,
    });
    expect(String(capabilities.pingTimeoutNote)).toBe(
      helper.pingTimeoutProblemNote(helper.resolvePingTimeout({ STEALTH_PING_TIMEOUT_MS: 'nope' })),
    );
    expect(pingReport(await payload(session, 'browser_engine_status'))).toEqual(pingReport(capabilities));
  });

  it('says the setting does not apply on engines without a server heartbeat', async () => {
    const root = tempRoot('ping-timeout-inert-');
    const plugin = createStubPlugin(root);
    for (const engine of ['cloak', 'camoufox-native']) {
      const session = startBroker({
        pluginDir: plugin,
        dataDir: path.join(root, `${engine}-data`),
        engine,
      });
      const initialized = await initialize(session);
      expect(initialized.result?.instructions ?? '').not.toContain('Ping timeout');
      for (const tool of ['browser_capabilities', 'browser_engine_status']) {
        const report = await payload(session, tool);
        expect(pingReport(report), `${engine}/${tool}`).toEqual({
          pingTimeoutApplies: false,
          pingTimeoutMs: null,
          pingTimeoutSource: null,
          heartbeatEnabled: null,
        });
        expect(String(report.pingTimeoutNote), `${engine}/${tool}`).toContain(
          'applies only to the camoufox engine',
        );
        expect(String(report.pingTimeoutNote), `${engine}/${tool}`).toContain('no server heartbeat');
      }
    }
  });

  it('leaves the initialize instructions without a heartbeat sentence', async () => {
    const session = await camoufoxSession({ STEALTH_PING_TIMEOUT_MS: '15000' });
    const initialized = await session.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(initialized.result?.instructions ?? '').not.toContain('Ping timeout');
    expect(initialized.result?.instructions ?? '').not.toContain('heartbeat');
  });
});

describe('the shared copies', () => {
  it.each(['cloakbrowser', 'camoufox'])('ships %s a byte-identical helper', (name) => {
    const canonical = readFileSync(path.join(repoRoot, 'shared', 'core', 'lib', 'ping-timeout.mjs'));
    const copy = path.join(repoRoot, 'plugins', name, 'lib', 'ping-timeout.mjs');
    expect(existsSync(copy)).toBe(true);
    expect(readFileSync(copy).equals(canonical)).toBe(true);
  });
});
