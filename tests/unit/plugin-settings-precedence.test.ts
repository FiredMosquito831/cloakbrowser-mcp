import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 2.26.0: D0 byte-identity and the positive document path. The real plugin
// broker runs against a deterministic stdio stub, so no browser is started.

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync), readFileSync: vi.fn(actual.readFileSync) };
});

type Json = Record<string, unknown>;

interface Rpc {
  id?: number;
  result?: Json;
  error?: Json;
}

interface Session {
  request(method: string, params?: Json): Promise<Rpc>;
  sendRaw(message: Json): void;
  stderr(): string;
  close(): Promise<void>;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const brokerPath = path.join(pluginDir, 'broker.mjs');
const settingsModule = (await import(
  new URL('../../plugins/cloakbrowser/lib/settings-precedence.mjs', import.meta.url).href
)) as unknown as {
  readSettingsDocuments(options: Json): Json;
  settingsDocumentsEnabled(env: Json, level: string): boolean;
};

const STUB_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
if (process.env.STUB_ENV_CAPTURE) fs.writeFileSync(process.env.STUB_ENV_CAPTURE, JSON.stringify(process.env));
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-settings', version: '0.0.0' } } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
  } else {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }], isError: false } });
  }
});
rl.on('close', () => process.exit(0));
`;

const ALL_DOCUMENT_SETTINGS = {
  profile_isolation: 'session',
  on_locked: 'block',
  copy_contents: 'full',
  profile_lifetime: 'server',
  seat_limit: 'unlimited',
  identity_mode: 'random',
  ping_timeout_ms: '1200',
  password_manager: 'true',
  headless: 'true',
  humanize: 'false',
  human_preset: 'careful',
  release_channel: 'preview',
  proxy_bypass: 'localhost',
  engine_version: '9.9.9',
  output_dir: '<ROOT>/artifacts',
  tool_profile: 'full',
};

const ENV_FOR_KEY: Record<string, string> = {
  profile_isolation: 'STEALTH_PROFILE_ISOLATION',
  on_locked: 'STEALTH_ON_LOCKED',
  copy_contents: 'STEALTH_COPY_CONTENTS',
  profile_lifetime: 'STEALTH_PROFILE_LIFETIME',
  seat_limit: 'STEALTH_SEAT_LIMIT',
  identity_mode: 'STEALTH_IDENTITY_MODE',
  ping_timeout_ms: 'STEALTH_PING_TIMEOUT_MS',
  password_manager: 'STEALTH_PASSWORD_MANAGER',
  headless: 'PLAYWRIGHT_MCP_HEADLESS',
  humanize: 'CLOAK_PLAYWRIGHT_MCP_HUMANIZE',
  human_preset: 'CLOAK_PLAYWRIGHT_MCP_HUMAN_PRESET',
  release_channel: 'CLOAK_PLAYWRIGHT_MCP_RELEASE_CHANNEL',
  proxy_bypass: 'PLAYWRIGHT_MCP_PROXY_BYPASS',
  engine_version: 'CLOAKBROWSER_VERSION',
  output_dir: 'PLAYWRIGHT_MCP_OUTPUT_DIR',
  tool_profile: 'STEALTH_TOOL_PROFILE',
};

const roots: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'settings-broker-')));
  roots.push(root);
  return root;
}

function writeJson(file: string, value: Json): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createRuntime(dataDir: string): void {
  const modules = path.join(dataDir, 'runtime', 'node_modules');
  for (const name of ['cloakbrowser', 'playwright-core', 'playwright', 'cloakbrowser-mcp/dist']) {
    mkdirSync(path.join(modules, name), { recursive: true });
  }
  mkdirSync(path.join(dataDir, 'profiles', 'playwright'), { recursive: true });
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
}

function writeDocuments(dataDir: string, root: string): void {
  const settings = { ...ALL_DOCUMENT_SETTINGS, output_dir: path.join(root, 'artifacts') };
  mkdirSync(path.join(dataDir, 'settings.d'), { recursive: true });
  writeJson(path.join(dataDir, 'settings.json'), { version: 1, settings });
  writeJson(path.join(dataDir, 'settings.d', 'claude-code.json'), {
    version: 1,
    settings: { headless: 'false', on_locked: 'fallback' },
  });
}

interface BrokerOptions {
  dataDir: string;
  captureFile: string;
  pluginPath?: boolean;
  extraEnv?: Record<string, string | undefined>;
}

function startBroker(options: BrokerOptions): Session {
  const env: Record<string, string | undefined> = {
    ...process.env,
    STEALTH_ENGINE: 'playwright',
    CLOAK_PLAYWRIGHT_MCP_PACKAGE: 'cloakbrowser-mcp@1.15.1',
    STEALTH_TOOL_PROFILE: 'full',
    STUB_ENV_CAPTURE: options.captureFile,
  };
  for (const name of [
    'STEALTH_SETTINGS_LEVEL',
    'STEALTH_PROFILE_ISOLATION',
    'STEALTH_ON_LOCKED',
    'STEALTH_COPY_CONTENTS',
    'STEALTH_PROFILE_LIFETIME',
    'STEALTH_SEAT_LIMIT',
    'STEALTH_IDENTITY_MODE',
    'STEALTH_PING_TIMEOUT_MS',
    'STEALTH_PASSWORD_MANAGER',
    'PLAYWRIGHT_MCP_HEADLESS',
    'CLOAK_PLAYWRIGHT_MCP_HUMANIZE',
    'CLOAK_PLAYWRIGHT_MCP_HUMAN_PRESET',
    'CLOAK_PLAYWRIGHT_MCP_RELEASE_CHANNEL',
    'PLAYWRIGHT_MCP_PROXY_BYPASS',
    'CLOAKBROWSER_VERSION',
    'PLAYWRIGHT_MCP_OUTPUT_DIR',
    'PLAYWRIGHT_MCP_USER_DATA_DIR',
  ]) {
    delete env[name];
  }
  if (options.pluginPath !== false) {
    delete env.STEALTH_DATA_DIR;
    env.CLAUDE_PLUGIN_DATA = options.dataDir;
  } else {
    delete env.CLAUDE_PLUGIN_DATA;
    env.STEALTH_DATA_DIR = options.dataDir;
  }
  for (const [name, value] of Object.entries(options.extraEnv ?? {})) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  const child = spawn(process.execPath, [brokerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const pending = new Map<number, (response: Rpc) => void>();
  let nextId = 1;
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) return;
    let message: Rpc;
    try {
      message = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id) as (response: Rpc) => void;
      pending.delete(message.id);
      resolve(message);
    }
  });
  const session: Session = {
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`broker timeout: ${method}; stderr=${stderr}`)),
          20_000,
        );
        pending.set(id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    sendRaw(message) {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    },
    stderr: () => stderr,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
  sessions.push(session);
  return session;
}

async function run(
  options: BrokerOptions,
  root: string,
): Promise<{ env: Json; capabilities: Json; stderr: string }> {
  const session = startBroker(options);
  await session.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'settings-test', version: '0' },
  });
  session.sendRaw({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  const response = await session.request('tools/call', { name: 'browser_capabilities', arguments: {} });
  const content = response.result?.content as { text?: string }[] | undefined;
  const capabilities = JSON.parse((content?.[0]?.text ?? '{}').replaceAll(root, '<ROOT>')) as Json;
  const env = JSON.parse(readFileSync(options.captureFile, 'utf8')) as Json;
  for (const name of ['STUB_ENV_CAPTURE', 'CLAUDE_PLUGIN_DATA', 'STEALTH_DATA_DIR']) {
    delete env[name];
  }
  return { env, capabilities, stderr: session.stderr().replaceAll(root, '<ROOT>') };
}

describe('D0 gate on the plugin path', () => {
  it('reads no document and changes no byte, even with valid documents present', async () => {
    const root = tempRoot();
    const dataDir = path.join(root, 'data');
    createRuntime(dataDir);
    const capture = path.join(root, 'env.json');
    const clean = await run({ dataDir, captureFile: capture }, root);
    writeDocuments(dataDir, root);
    const withDocs = await run({ dataDir, captureFile: capture }, root);
    expect(withDocs.env).toEqual(clean.env);
    expect(withDocs.capabilities).toEqual(clean.capabilities);
    expect(withDocs.stderr).toBe(clean.stderr);
    expect(JSON.stringify(withDocs.capabilities)).not.toContain('"document"');
    expect(Object.hasOwn(withDocs.capabilities, 'precedenceNote')).toBe(false);
    expect(Object.keys(withDocs.capabilities.precedence as Json)).toEqual(['harness', 'profile']);
  }, 60_000);

  it('makes zero stat/read probes through the gated reader', () => {
    const root = tempRoot();
    writeDocuments(root, root);
    vi.mocked(fs.statSync).mockClear();
    vi.mocked(fs.readFileSync).mockClear();
    const result = settingsModule.readSettingsDocuments({
      env: { CLAUDE_PLUGIN_DATA: root },
      dataDir: root,
      harnessId: 'claude-code',
      settingsLevel: 'auto',
    });
    expect(result).toEqual({ enabled: false, documents: { global: null, harness: null } });
    expect(vi.mocked(fs.statSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled();
  });

  it('applies an explicit opt-in and the alias path without changing credentials or tool keys', async () => {
    const root = tempRoot();
    const dataDir = path.join(root, 'data');
    createRuntime(dataDir);
    writeDocuments(dataDir, root);
    const capture = path.join(root, 'env.json');
    const optedIn = await run(
      { dataDir, captureFile: capture, extraEnv: { STEALTH_SETTINGS_LEVEL: 'global' } },
      root,
    );
    for (const key of Object.keys(ALL_DOCUMENT_SETTINGS)) {
      const expected =
        key === 'output_dir'
          ? path.join(root, 'artifacts')
          : ALL_DOCUMENT_SETTINGS[key as keyof typeof ALL_DOCUMENT_SETTINGS];
      expect(optedIn.env[ENV_FOR_KEY[key]], `child env for ${key}`).toBe(expected);
    }
    const precedence = optedIn.capabilities.precedence as Json;
    expect(Object.keys(precedence)).toEqual(['harness', 'profile', 'documents', 'settingsLevel', 'settings']);
    expect(precedence.settingsLevel).toEqual({ value: 'global', source: 'env' });
    const settings = precedence.settings as Json;
    for (const key of Object.keys(ALL_DOCUMENT_SETTINGS)) {
      expect(settings[key], `precedence for ${key}`).toMatchObject({
        level: 'global',
        source: 'document',
        skipped: [],
      });
    }
    expect(settings.proxy_server).toEqual({ level: 'session', configured: false, source: 'default' });
    expect((optedIn.capabilities.launcherSettings as Json).headless).toMatchObject({ source: 'document' });
    expect((optedIn.capabilities as Json).profileIsolationSource).toBe('document');

    const aliased = await run({ dataDir, captureFile: capture, pluginPath: false }, root);
    expect(aliased.env.PLAYWRIGHT_MCP_HEADLESS).toBe('true');
    expect(aliased.capabilities.dataDirSource).toBe('env-alias');
    const aliasPrecedence = aliased.capabilities.precedence as Json;
    expect(Object.keys(aliasPrecedence)).toEqual([
      'harness',
      'profile',
      'documents',
      'settingsLevel',
      'settings',
    ]);
    expect(aliasPrecedence.harness).toEqual({ id: null, source: 'unset', error: null });
    expect((aliasPrecedence.profile as Json).harness).toMatchObject({ state: 'not-applicable' });
    expect((aliasPrecedence.documents as Json).harness).toMatchObject({ state: 'not-applicable' });
    expect((aliasPrecedence.documents as Json).global).toMatchObject({ state: 'present' });
    expect(aliasPrecedence.settingsLevel).toEqual({ value: 'auto', source: 'default' });
    const aliasSettings = aliasPrecedence.settings as Json;
    expect(aliasSettings.on_locked).toMatchObject({ level: 'global', source: 'document' });
  }, 60_000);
});
