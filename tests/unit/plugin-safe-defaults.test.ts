import {
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
import { exposedTools } from '../helpers/exposed-tools.js';

// Safe defaults, the resolution rule and the cold-surface start (2.21.0).
//
//   on_locked        copy (was fallback)
//   copy_contents    identity (was full); copy-keep is always full ("clamped")
//   resolution rule  unset / empty / ${user_config.*} placeholder / unknown value
//                    all take the documented safe branch, with one log line and
//                    the source reported in the payload
//   cold surface     no configuration leaves the client with a tool list it
//                    cannot act on
//
// The broker runs are the real plugins/cloakbrowser broker; the engine entry point
// is a deterministic stdio stub, so no browser is launched and nothing downloads.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const brokerPath = path.join(pluginDir, 'broker.mjs');
const profile = (await import(
  new URL('../../plugins/cloakbrowser/lib/profile.mjs', import.meta.url).href
)) as unknown as ProfileModule;
const launcherSettings = (await import(
  new URL('../../plugins/cloakbrowser/lib/launcher-settings.mjs', import.meta.url).href
)) as unknown as LauncherSettingsModule;
const registry = (await import(
  new URL('../../plugins/cloakbrowser/engine-registry.mjs', import.meta.url).href
)) as unknown as RegistryModule;
const pingTimeout = (await import(
  new URL('../../plugins/cloakbrowser/lib/ping-timeout.mjs', import.meta.url).href
)) as unknown as PingTimeoutModule;
const passwordManager = (await import(
  new URL('../../plugins/cloakbrowser/lib/password-manager.mjs', import.meta.url).href
)) as unknown as PasswordManagerModule;

interface ProfileModule {
  DEFAULT_ON_LOCKED: string;
  DEFAULT_COPY_CONTENTS: string;
  DEFAULT_PROFILE_LIFETIME: string;
  DEFAULT_SEAT_LIMIT: string;
  DEFAULT_PROFILE_ISOLATION: string;
  resolveOnLocked(value: string): Resolution;
  resolveCopyContents(value: string): Resolution;
  resolveProfileLifetime(value: string): Resolution;
  resolveSeatLimit(value: string): Resolution;
  resolveProfileIsolation(value: string): Resolution;
  resolveExtensionPaths(env: Record<string, string | undefined>): Record<string, unknown>;
  accountNameError(value: string): string | null;
  validateAccountName(value: string): boolean;
}

interface Resolution {
  mode: string;
  source: string;
  ignored: string | null;
  placeholder: string | null;
}

interface LauncherSettingsModule {
  LAUNCHER_SETTINGS: Record<string, string[]>;
  LAUNCHER_SETTING_ENV: Record<string, string>;
  resolveLauncherSettings(
    env: Record<string, string | undefined>,
    launcherName: string,
  ): {
    values: Record<string, unknown>;
    report: Record<string, Record<string, unknown>>;
    notes: string[];
  };
  applyLauncherSettings(
    env: Record<string, string | undefined>,
    launcherName: string,
    log: (message: string) => void,
  ): Record<string, string | undefined>;
}

interface RegistryModule {
  resolveToolProfile(
    value: string,
    engine: { defaultToolProfile?: string } | null,
    profiles: unknown,
  ): { profile: string | null; source: string; ignored: string | null; placeholder: string | null };
}

interface PingTimeoutModule {
  resolvePingTimeout(env: Record<string, string | undefined>): {
    ms: number;
    source: string;
    problem: string | null;
  };
}

interface PasswordManagerModule {
  resolvePasswordManager(env: Record<string, string | undefined>): {
    enabled: boolean;
    problem: string | null;
  };
}

interface JsonRpcResponse {
  result?: {
    tools?: { name?: string }[];
    content?: { type: string; text?: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    instructions?: string;
  };
  error?: { code: number; message: string };
}

interface BrokerSession {
  request: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<JsonRpcResponse>;
  stderr: () => string;
  close: () => Promise<void>;
}

const STUB_TOOLS = ['browser_navigate', 'browser_close'];
const META_TOOLS = ['browser_capabilities', 'browser_engine_status', 'browser_profiles'];

const STUB_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-safe-defaults', version: '0.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} } })) } });
    return;
  }
  if (message.method === 'tools/call') {
    const name = message.params && message.params.name;
    let lockfile = null;
    const dir = process.env.PLAYWRIGHT_MCP_USER_DATA_DIR;
    if (dir) {
      const file = path.join(dir, 'lockfile');
      try { if (name === 'browser_close') fs.rmSync(file, { force: true }); else fs.writeFileSync(file, ''); lockfile = file; } catch {}
    }
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ profileDir: dir ?? null, lockfile }) }], isError: false } });
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
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createRuntime(dataDir: string, engine = 'playwright'): string {
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

function seedBase(baseDir: string): void {
  const write = (relative: string, text: string) => {
    const file = path.join(baseDir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write('Local State', '{"os_crypt":{"encrypted_key":"k"}}');
  write(path.join('Default', 'Preferences'), '{}');
  write(path.join('Default', 'Network', 'Cookies'), 'cookie-bytes');
  write(path.join('Default', 'History'), 'history-bytes');
  write(path.join('Default', 'IndexedDB', 'origin.indexeddb.leveldb', '000003.log'), 'indexeddb-bulk');
  write(path.join('Default', 'Cache', 'data_0'), 'cache-bulk');
}

interface BrokerOptions {
  dataDir: string;
  isolation?: string;
  onLocked?: string;
  lifetime?: string;
  contents?: string;
  engine?: string;
  extraEnv?: Record<string, string | undefined>;
}

function startBroker(options: BrokerOptions): BrokerSession {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: options.dataDir,
    CLOAK_PLAYWRIGHT_MCP_PACKAGE: 'cloakbrowser-mcp@1.15.1',
    STEALTH_ENGINE: options.engine ?? 'playwright',
    STEALTH_TOOL_PROFILE: 'full',
  };
  for (const name of [
    'STEALTH_ACCOUNT',
    'STEALTH_PROFILE_ISOLATION',
    'STEALTH_ON_LOCKED',
    'STEALTH_PROFILE_LIFETIME',
    'STEALTH_COPY_CONTENTS',
    'STEALTH_SEAT_LIMIT',
    'STEALTH_IDENTITY_MODE',
    'PLAYWRIGHT_MCP_USER_DATA_DIR',
    'PLAYWRIGHT_MCP_ISOLATED',
    'PLAYWRIGHT_MCP_PROXY_SERVER',
    'PLAYWRIGHT_MCP_HEADLESS',
    'CLOAK_PLAYWRIGHT_MCP_HUMANIZE',
    'CLOAK_PLAYWRIGHT_MCP_HUMAN_PRESET',
    'CLOAK_PLAYWRIGHT_MCP_RELEASE_CHANNEL',
  ]) {
    delete childEnv[name];
  }
  if (options.isolation !== undefined) childEnv.STEALTH_PROFILE_ISOLATION = options.isolation;
  if (options.onLocked !== undefined) childEnv.STEALTH_ON_LOCKED = options.onLocked;
  if (options.lifetime !== undefined) childEnv.STEALTH_PROFILE_LIFETIME = options.lifetime;
  if (options.contents !== undefined) childEnv.STEALTH_COPY_CONTENTS = options.contents;
  for (const [name, value] of Object.entries(options.extraEnv ?? {})) {
    if (value === undefined) {
      delete childEnv[name];
    } else {
      childEnv[name] = value;
    }
  }
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
    const id = (message as unknown as { id?: number }).id;
    if (id !== undefined && pending.has(id)) {
      const resolve = pending.get(id) as (response: JsonRpcResponse) => void;
      pending.delete(id);
      resolve(message);
    }
  });
  let nextId = 1;
  const request = (method: string, params?: Record<string, unknown>, timeoutMs = 8000) => {
    const id = nextId++;
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}; stderr=${stderr.slice(-800)}`));
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
      child.stdin!.end();
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

// --- 1. the four input cases, per setting ------------------------------------

const CASES = {
  unset: undefined as string | undefined,
  empty: '',
  placeholder: '${user_config.PLACEHOLDER}',
  unknown: 'not-a-documented-value',
};

// The profile settings the broker resolves itself: every case takes the
// documented safe branch (the default), and the resolution says which source won.
describe('profile settings take the safe branch for every input case (2.21.0)', () => {
  const rows: {
    key: string;
    resolve: (raw: string) => Resolution;
    safe: string;
  }[] = [
    { key: 'on_locked', resolve: (raw) => profile.resolveOnLocked(raw), safe: profile.DEFAULT_ON_LOCKED },
    {
      key: 'copy_contents',
      resolve: (raw) => profile.resolveCopyContents(raw),
      safe: profile.DEFAULT_COPY_CONTENTS,
    },
    {
      key: 'profile_lifetime',
      resolve: (raw) => profile.resolveProfileLifetime(raw),
      safe: profile.DEFAULT_PROFILE_LIFETIME,
    },
    { key: 'seat_limit', resolve: (raw) => profile.resolveSeatLimit(raw), safe: profile.DEFAULT_SEAT_LIMIT },
    {
      key: 'profile_isolation',
      resolve: (raw) => profile.resolveProfileIsolation(raw),
      safe: profile.DEFAULT_PROFILE_ISOLATION,
    },
  ];

  it('the documented defaults are the safe branches', () => {
    expect(profile.DEFAULT_ON_LOCKED).toBe('copy');
    expect(profile.DEFAULT_COPY_CONTENTS).toBe('identity');
    expect(profile.DEFAULT_PROFILE_LIFETIME).toBe('browser');
    expect(profile.DEFAULT_SEAT_LIMIT).toBe('engine-default');
    expect(profile.DEFAULT_PROFILE_ISOLATION).toBe('shared');
  });

  for (const row of rows) {
    it(`${row.key}: every unusable value resolves to "${row.safe}" with source "default"`, () => {
      // The value is reported as ignored (unknown) or as a missing substitution
      // (placeholder), so the broker can write its one log line; those facts are
      // collected and asserted once, outside the loop.
      const unresolved: string[] = [];
      for (const [name, raw] of Object.entries(CASES)) {
        const resolution = row.resolve(raw ?? '');
        expect(resolution.mode, `${row.key} ${name}`).toBe(row.safe);
        expect(resolution.source, `${row.key} ${name}`).toBe('default');
        if (name === 'placeholder' && resolution.placeholder === null) {
          unresolved.push(`${row.key}: the placeholder was not reported`);
        }
        if (name === 'unknown' && resolution.ignored !== raw) {
          unresolved.push(`${row.key}: the unknown value was not reported`);
        }
      }
      expect(unresolved).toEqual([]);
    });
  }
});

// --- 2. the launcher-side settings -------------------------------------------

const LAUNCHER_CASES = ['unset', 'empty', 'placeholder', 'unknown'] as const;

describe('launcher settings write the documented safe branch (2.21.0)', () => {
  const placeholders: Record<string, string> = {};
  for (const key of Object.keys(launcherSettings.LAUNCHER_SETTING_ENV)) {
    placeholders[key] = `\${user_config.${key}}`;
  }

  // Every other setting the same launcher resolves is given a usable value, so a
  // note can only come from the setting under test.
  const VALID_VALUES: Record<string, string> = {
    headless: 'false',
    humanize: 'true',
    human_preset: 'default',
    release_channel: 'stable',
    proxy_server: 'http://proxy.example:8080',
    proxy_bypass: 'localhost',
    engine_version: '1.2.3',
    licence_key: 'key',
    output_dir: 'D:/out',
    camoufox_profile: 'default',
    camoufox_data_dir: 'D:/data',
  };

  function resolveOne(launcher: string, key: string, raw: string | undefined) {
    const env: Record<string, string | undefined> = {};
    for (const other of launcherSettings.LAUNCHER_SETTINGS[launcher] ?? []) {
      if (other !== key) {
        env[launcherSettings.LAUNCHER_SETTING_ENV[other]] = VALID_VALUES[other];
      }
    }
    if (raw !== undefined) {
      env[launcherSettings.LAUNCHER_SETTING_ENV[key]] = raw;
    }
    return launcherSettings.resolveLauncherSettings(env, launcher);
  }

  it('headless never becomes headless by omission, for every launcher that reads it', () => {
    for (const launcher of Object.keys(launcherSettings.LAUNCHER_SETTINGS)) {
      if (!launcherSettings.LAUNCHER_SETTINGS[launcher].includes('headless')) {
        continue;
      }
      for (const name of LAUNCHER_CASES) {
        const raw =
          name === 'placeholder' ? placeholders.headless : name === 'unknown' ? 'sometimes' : CASES[name];
        const { values, notes } = resolveOne(launcher, 'headless', raw);
        expect(values.headless, `${launcher} headless ${name}`).toBe(false);
        // Exactly one line explains a value that is not a boolean or not there.
        expect(notes.length, `${launcher} headless ${name}`).toBe(1);
      }
      const explicit = resolveOne(launcher, 'headless', 'true');
      expect(explicit.values.headless).toBe(true);
      expect(explicit.notes).toEqual([]);
    }
  });

  it('humanize stays on for every unusable value, and an explicit false is kept', () => {
    for (const name of LAUNCHER_CASES) {
      const raw =
        name === 'placeholder' ? placeholders.humanize : name === 'unknown' ? 'sometimes' : CASES[name];
      const { values, notes } = resolveOne('launch.mjs', 'humanize', raw);
      expect(values.humanize, `humanize ${name}`).toBe(true);
      expect(notes.length, `humanize ${name}`).toBe(1);
    }
    expect(resolveOne('launch.mjs', 'humanize', 'false').values.humanize).toBe(false);
  });

  it('human_preset and release_channel reach the bridge with a value it accepts', () => {
    for (const project of [
      { key: 'human_preset', safe: 'default', choices: ['default', 'careful'] },
      { key: 'release_channel', safe: 'stable', choices: ['stable', 'preview'] },
    ]) {
      for (const name of LAUNCHER_CASES) {
        const raw =
          name === 'placeholder' ? placeholders[project.key] : name === 'unknown' ? 'chaotic' : CASES[name];
        const { values, report } = resolveOne('launch.mjs', project.key, raw);
        expect(values[project.key], `${project.key} ${name}`).toBe(project.safe);
        // The bridge throws on anything outside its own list; the report proves
        // the value it will receive is one of them.
        expect(project.choices).toContain(values[project.key]);
        // Nothing supplied means the bridge's own default applies with no line; a
        // value that was not used carries exactly one line saying so.
        expect(report[project.key].source, `${project.key} ${name}`).toBe('default');
        const supplied = name !== 'unset' && name !== 'empty';
        expect(typeof report[project.key].note === 'string', `${project.key} ${name} note`).toBe(supplied);
      }
      const kept = resolveOne('launch.mjs', project.key, project.choices[1]).values[project.key];
      expect(kept).toBe(project.choices[1]);
    }
  });

  it('an unsubstituted placeholder is unset for every optional launcher value', () => {
    const optional = [
      ['launch.mjs', 'proxy_server'],
      ['launch.mjs', 'proxy_bypass'],
      ['launch.mjs', 'engine_version'],
      ['launch.mjs', 'output_dir'],
      ['launch-camoufox.mjs', 'proxy_server'],
      ['launch-camoufox-native.mjs', 'camoufox_profile'],
      ['launch-camoufox-native.mjs', 'camoufox_data_dir'],
    ] as const;
    for (const [launcher, key] of optional) {
      const { values, notes } = resolveOne(launcher, key, placeholders[key]);
      expect(values[key], `${launcher} ${key} placeholder`).toBeNull();
      expect(notes.length, `${launcher} ${key} placeholder`).toBe(1);
      // A real value is used as given, with no note.
      const real = resolveOne(launcher, key, 'D:/real/value');
      expect(real.values[key]).toBe('D:/real/value');
      expect(real.notes).toEqual([]);
    }
  });

  it('never reports a proxy URL or a licence key, only whether one is configured', () => {
    const { report } = resolveOne('launch.mjs', 'proxy_server', 'http://user:secret@proxy.example:8080');
    expect(report.proxy_server).toEqual({ configured: true, source: 'setting' });
    expect(JSON.stringify(report)).not.toContain('secret');
    const key = resolveOne('launch.mjs', 'licence_key', 'LICENCE-SECRET');
    expect(key.report.licence_key).toEqual({ configured: true, source: 'setting' });
    expect(JSON.stringify(key.report)).not.toContain('LICENCE-SECRET');
  });

  it('writes the canonical env spelling, so no engine default can apply by omission', () => {
    const written: string[] = [];
    const env = launcherSettings.applyLauncherSettings(
      { PLAYWRIGHT_MCP_HEADLESS: '1', CLOAK_PLAYWRIGHT_MCP_HUMANIZE: 'yes' },
      'launch.mjs',
      (message) => written.push(message),
    );
    expect(env.PLAYWRIGHT_MCP_HEADLESS).toBe('true');
    expect(env.CLOAK_PLAYWRIGHT_MCP_HUMANIZE).toBe('true');
    expect(env.CLOAK_PLAYWRIGHT_MCP_HUMAN_PRESET).toBe('default');
    expect(env.CLOAK_PLAYWRIGHT_MCP_RELEASE_CHANNEL).toBe('stable');
    expect(written).toEqual([]);
    const unset = launcherSettings.applyLauncherSettings({}, 'launch.mjs', (message) =>
      written.push(message),
    );
    expect(unset.PLAYWRIGHT_MCP_HEADLESS).toBe('false');
    expect(unset.CLOAK_PLAYWRIGHT_MCP_HUMANIZE).toBe('true');
    // One line each for the two settings whose engine default differs.
    expect(written).toHaveLength(2);
  });
});

// --- 3. every declared setting has a row -------------------------------------

describe('every userConfig key has a documented row (a new key cannot be added silently)', () => {
  const PROFILE_KEYS = ['profile_isolation', 'on_locked', 'copy_contents', 'profile_lifetime', 'seat_limit'];
  const LAUNCHER_KEYS = Object.keys(launcherSettings.LAUNCHER_SETTING_ENV);
  // Keys whose four input cases are resolved by another suite, each named so the
  // claim is checkable (the file must exist).
  const ELSEWHERE: Record<string, { suite: string; why: string }> = {
    browser_engine: {
      suite: 'plugin-kameleo-broker.test.ts',
      why: 'an unknown engine is a loud meta-only start',
    },
    tool_profile: {
      suite: 'engine-registry.test.ts',
      why: 'resolveToolProfile: unknown means the engine default',
    },
    tools_vision: { suite: 'plugin-kameleo.test.ts', why: 'the wider surface is the safe branch' },
    tools_pdf: { suite: 'plugin-kameleo.test.ts', why: 'the wider surface is the safe branch' },
    tools_devtools: { suite: 'plugin-kameleo.test.ts', why: 'the wider surface is the safe branch' },
    tools_storage: { suite: 'plugin-kameleo.test.ts', why: 'the wider surface is the safe branch' },
    tools_network: { suite: 'plugin-kameleo.test.ts', why: 'the wider surface is the safe branch' },
    tools_testing: { suite: 'plugin-kameleo.test.ts', why: 'the wider surface is the safe branch' },
    tools_config: { suite: 'plugin-kameleo.test.ts', why: 'the wider surface is the safe branch' },
    geoip_proxy_match: {
      suite: 'config.test.ts',
      why: 'the bridge reads anything that is not true/1 as off, and off is the safe branch',
    },
    disabled_tools: { suite: 'plugin-broker-status-honesty.test.ts', why: 'unknown names are no-ops' },
    account: {
      suite: 'plugin-account.test.ts',
      why: 'an invalid name is a loud error, never a new identity',
    },
    profile_dir: {
      suite: 'plugin-session-safe-profiles.test.ts',
      why: 'an explicit path is the user’s value',
    },
    identity_mode: { suite: 'plugin-camoufox-identity.test.ts', why: 'unknown means profile' },
    ping_timeout_ms: { suite: 'plugin-camoufox-ping-timeout.test.ts', why: 'unknown means 0' },
    password_manager: { suite: 'plugin-password-manager.test.ts', why: 'unknown means off' },
    extension_paths: {
      suite: 'plugin-extensions.test.ts',
      why: 'a placeholder is unconfigured, a bad entry refuses loudly',
    },
    allow_unrestricted_file_access: {
      suite: 'plugin-unrestricted-file-access.test.ts',
      why: 'anything not on is off',
    },
    kameleo_profile_id: { suite: 'plugin-kameleo.test.ts', why: 'a missing id is a loud meta-only start' },
    kameleo_endpoint: {
      suite: 'plugin-kameleo.test.ts',
      why: 'an invalid endpoint is refused with the setting named',
    },
  };

  for (const name of ['cloakbrowser', 'camoufox']) {
    it(`covers every key of the ${name} plugin`, () => {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'),
      ) as { userConfig: Record<string, unknown> };
      const keys = Object.keys(manifest.userConfig);
      expect(keys.length).toBe(name === 'cloakbrowser' ? 36 : 23);
      const unrowed = keys.filter(
        (key) => !PROFILE_KEYS.includes(key) && !LAUNCHER_KEYS.includes(key) && ELSEWHERE[key] === undefined,
      );
      expect(unrowed, `every key of ${name} needs a row`).toEqual([]);
      for (const [key, entry] of Object.entries(ELSEWHERE)) {
        if (!keys.includes(key)) {
          continue;
        }
        expect(entry.why.length, `${key} names why it is safe`).toBeGreaterThan(0);
        expect(existsSync(path.join(repoRoot, 'tests', 'unit', entry.suite)), `${key}: ${entry.suite}`).toBe(
          true,
        );
      }
    });
  }

  it('resolves tool_profile, ping_timeout and password_manager to their safe branch too', () => {
    const engine = { defaultToolProfile: 'full' };
    const profiles = { profiles: { full: [], portable: [] } };
    for (const raw of [undefined, '', '${user_config.tool_profile}', 'everything']) {
      expect(registry.resolveToolProfile(raw ?? '', engine, profiles)).toMatchObject({
        profile: 'full',
        source: 'engine-default',
      });
    }
    for (const raw of [undefined, '', '${user_config.ping_timeout_ms}', 'later']) {
      expect(pingTimeout.resolvePingTimeout({ STEALTH_PING_TIMEOUT_MS: raw }).ms).toBe(0);
    }
    for (const raw of [undefined, '', '${user_config.password_manager}', 'maybe']) {
      expect(passwordManager.resolvePasswordManager({ STEALTH_PASSWORD_MANAGER: raw }).enabled).toBe(false);
    }
  });
});

// --- 4. the cold-surface matrix ----------------------------------------------

describe('no configuration leaves the client without a usable tool list (2.21.0)', () => {
  const ISOLATIONS = ['shared', 'workspace', 'isolated', 'copy', 'copy-keep'];
  const LIFETIMES = ['browser', 'server'];

  for (const isolation of ISOLATIONS) {
    for (const lifetime of LIFETIMES) {
      it(`profile_isolation=${isolation} + profile_lifetime=${lifetime}: real tools and a working call`, async () => {
        const root = tempRoot(`cold-${isolation}-${lifetime}-`);
        const dataDir = createRuntime(root);
        const base = path.join(dataDir, 'profiles', 'default');
        seedBase(base);
        // Nothing is cached: this is the cold surface the deadlock lived on.
        expect(existsSync(path.join(dataDir, 'cache'))).toBe(false);
        const session = startBroker({ dataDir, isolation, lifetime });
        await initialize(session);
        const client = exposedTools(session);
        const names = await client.list();
        // The client can act: the backend's own tools, not only the meta-tools.
        expect(names).toEqual([...STUB_TOOLS, ...META_TOOLS]);
        const call = await client.call('browser_navigate', { url: 'data:text/html,cold' });
        expect(call.result?.isError).toBeFalsy();
        // The surface is cached now, so the next start of this configuration is
        // lazy again.
        expect(existsSync(path.join(dataDir, 'cache', 'playwright'))).toBe(true);
        // A "browser" lifetime defers the copy, so this is the cold-surface escape
        // and it says so once; a "server" lifetime copies at start in every case.
        const deferredCopy = (isolation === 'copy' || isolation === 'copy-keep') && lifetime === 'browser';
        expect(
          session.stderr().includes('cold start: no cached tool list exists'),
          `${isolation} cold-start line`,
        ).toBe(deferredCopy);
      });
    }
  }

  for (const lifetime of LIFETIMES) {
    it(`on_locked=copy with a busy base + profile_lifetime=${lifetime}: real tools and a working call`, async () => {
      const root = tempRoot(`busy-${lifetime}-`);
      const dataDir = createRuntime(root);
      const base = path.join(dataDir, 'profiles', 'default');
      seedBase(base);
      writeJson(path.join(base, '.cloakbrowser-mcp-profile.lock'), {
        pid: process.pid,
        createdAt: '2026-10-28T09:00:00.000Z',
        userDataDir: base,
      });
      expect(existsSync(path.join(dataDir, 'cache'))).toBe(false);
      // The default policy is copy; the base stays its owner's.
      const session = startBroker({ dataDir, lifetime });
      await initialize(session);
      const client = exposedTools(session);
      expect(await client.list()).toEqual([...STUB_TOOLS, ...META_TOOLS]);
      const call = await client.call('browser_navigate', { url: 'data:text/html,busy' });
      expect(call.result?.isError).toBeFalsy();
      const environment = JSON.parse(call.result?.content?.[0]?.text ?? '{}') as { profileDir: string };
      expect(environment.profileDir).toContain(path.join('profiles', 'playwright', '.sessions'));
      // The base is untouched and still its owner's.
      expect(readFileSync(path.join(base, 'Default', 'Network', 'Cookies'), 'utf8')).toBe('cookie-bytes');
      expect(String((await capabilities(session)).onLocked)).toBe('copy');
    });
  }
});

// --- 5. the payload reports the source --------------------------------------

describe('the payload reports which source won (2.21.0)', () => {
  it('reports the safe branch and its reason for a placeholder and an unknown value', async () => {
    const root = tempRoot('payload-source-');
    const dataDir = createRuntime(root);
    seedBase(path.join(dataDir, 'profiles', 'default'));
    const session = startBroker({
      dataDir,
      extraEnv: {
        STEALTH_ON_LOCKED: 'per-window',
        STEALTH_COPY_CONTENTS: '${user_config.copy_contents}',
        STEALTH_PROFILE_LIFETIME: 'forever',
        PLAYWRIGHT_MCP_HEADLESS: '${user_config.headless}',
        CLOAK_PLAYWRIGHT_MCP_HUMAN_PRESET: '${user_config.human_preset}',
        CLOAK_PLAYWRIGHT_MCP_RELEASE_CHANNEL: 'chaotic',
        PLAYWRIGHT_MCP_PROXY_SERVER: '${user_config.proxy_server}',
      },
    });
    await session.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    const caps = await capabilities(session);
    expect(caps.onLocked).toBe('copy');
    expect(caps.copyContents).toBe('identity');
    expect(caps.copyContentsSource).toBe('default');
    expect(caps.profileLifetime).toBe('browser');
    expect(caps.profileLifetimeSource).toBe('default');
    const settings = caps.launcherSettings as Record<string, Record<string, unknown>>;
    expect(settings.launcher).toBe('launch.mjs');
    expect(settings.headless).toMatchObject({ value: false, source: 'default' });
    expect(String(settings.headless.note)).toContain('placeholder');
    expect(settings.human_preset).toMatchObject({ value: 'default', source: 'default' });
    expect(settings.release_channel).toMatchObject({ value: 'stable', source: 'default' });
    expect(String(settings.release_channel.note)).toContain('stable');
    // The broker treats a placeholder proxy exactly like an unset one, so the
    // payload never claims a proxy is configured.
    expect(caps.proxyConfigured).toBe(false);
    expect(session.stderr()).toContain('ignoring unsubstituted proxy-server placeholder');
    // One log line per value that was not used.
    expect(session.stderr()).toContain('ignoring unknown on-locked policy: per-window');
    expect(session.stderr()).toContain('ignoring unsubstituted copy-contents placeholder');
    expect(session.stderr()).toContain('ignoring unknown profile lifetime: forever');
  });

  it('keeps a supplied value and reports it as the setting', async () => {
    const root = tempRoot('payload-setting-');
    const dataDir = createRuntime(root);
    seedBase(path.join(dataDir, 'profiles', 'default'));
    const session = startBroker({
      dataDir,
      extraEnv: {
        STEALTH_ON_LOCKED: 'block',
        STEALTH_COPY_CONTENTS: 'full',
        STEALTH_PROFILE_LIFETIME: 'server',
        PLAYWRIGHT_MCP_HEADLESS: 'true',
        CLOAK_PLAYWRIGHT_MCP_HUMANIZE: 'false',
      },
    });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.onLocked).toBe('block');
    expect(caps.copyContents).toBe('full');
    expect(caps.copyContentsSource).toBe('setting');
    expect(caps.profileLifetime).toBe('server');
    const settings = caps.launcherSettings as Record<string, Record<string, unknown>>;
    expect(settings.headless).toMatchObject({ value: true, source: 'setting' });
    expect(settings.humanize).toMatchObject({ value: false, source: 'setting' });
    expect(settings.headless.note).toBeUndefined();
  });
});
