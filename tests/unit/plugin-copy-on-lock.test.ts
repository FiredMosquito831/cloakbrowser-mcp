import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
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

// Copy on lock, the identity tier and browser-scoped lifetime (2.20.0).
//
//   on_locked=copy     a temporary copy of the busy profile, no lock of its own
//   copy_contents      full (default) | identity, filtered by the manifest
//   profile_lifetime   browser (default) | server
//   seat_limit         engine-default | vendor-license | unlimited (cloakbrowser)
//
// Every broker below is the real plugins/cloakbrowser broker with its real core
// modules; the engine entry point is a deterministic stdio stub, so no browser is
// launched and nothing is downloaded.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const brokerPath = path.join(pluginDir, 'broker.mjs');
const profile = (await import(
  new URL('../../plugins/cloakbrowser/lib/profile.mjs', import.meta.url).href
)) as unknown as ProfileModule;
const registry = (await import(
  new URL('../../plugins/cloakbrowser/engine-registry.mjs', import.meta.url).href
)) as unknown as RegistryModule;

interface ProfileModule {
  COPY_CONTENTS_VALUES: string[];
  DEFAULT_COPY_CONTENTS: string;
  DEFAULT_PROFILE_LIFETIME: string;
  DEFAULT_SEAT_LIMIT: string;
  PROFILE_LIFETIME_VALUES: string[];
  SEAT_LIMIT_VALUES: string[];
  resolveCopyContents(value: string): { mode: string; source: string; ignored: string | null };
  resolveProfileLifetime(value: string): { mode: string; source: string; ignored: string | null };
  resolveSeatLimit(value: string): { mode: string; source: string; ignored: string | null };
  identityKeepIndex(relative: string, patterns: string[]): number;
  restrictPlanToIdentity(plan: Plan, patterns: string[]): Plan;
  scanLiveEngineLocks(
    engineId: string,
    dataDir: string,
    descriptor: { file: string; owner: string } | null,
  ): { count: number; live: { dir: string }[] };
  planCopy(sourceDir: string, options?: { engineLockFile?: string | null }): Plan;
  readProfileLock(dir: string): { state: string; owner: { pid: number } | null };
}

interface RegistryModule {
  manifestIdentityCopy(manifest: unknown): { keep: string[]; notes: string | null } | null;
  loadEngineConfiguration(options: Record<string, unknown>): {
    engine: unknown;
    error: string | null;
    warnings: string[];
  };
}

interface Plan {
  files: { source: string; relative: string; bytes: number }[];
  directories: string[];
  topLevel: { path: string; files: number; bytes: number; excluded: string | null }[];
  bytes: number;
  identity?: { keep: string[]; keptFiles: number; droppedFiles: number };
  excluded: Record<string, number>;
}

interface JsonRpcResponse {
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
  request: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<JsonRpcResponse>;
  stderr: () => string;
  close: () => Promise<void>;
}

interface BrokerOptions {
  dataDir: string;
  isolation?: string;
  onLocked?: string;
  lifetime?: string;
  contents?: string;
  seatLimit?: string;
  engine?: string;
  pluginDir?: string;
  cwd?: string;
}

const STUB_TOOLS = ['browser_navigate', 'browser_close'];

// The stub answers every tool call, records the profile directory it was started
// with, and can create or delete the engine lock file on request so the broker's
// latch can be exercised without a browser.
const STUB_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function engineLock(state) {
  const dir = process.env.PLAYWRIGHT_MCP_USER_DATA_DIR;
  if (!dir) return null;
  const file = path.join(dir, 'lockfile');
  try { if (state === 'create') fs.writeFileSync(file, ''); else fs.rmSync(file, { force: true }); } catch {}
  return file;
}
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-copy-on-lock', version: '0.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} } })) } });
    return;
  }
  if (message.method === 'tools/call') {
    const name = message.params && message.params.name;
    if (name === 'browser_close') {
      const file = engineLock('remove');
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ closed: true, lockfile: file }) }], isError: false } });
      return;
    }
    const file = engineLock('create');
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ profileDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? null, lockfile: file }) }], isError: false } });
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

// A Chromium-shaped base profile with one file in each tier: identity files the
// identity copy must keep, and bulk it must drop.
function seedBase(baseDir: string): void {
  const write = (relative: string, text: string) => {
    const file = path.join(baseDir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write('Local State', '{"os_crypt":{"encrypted_key":"k"}}');
  write(path.join('Default', 'Preferences'), '{}');
  write(path.join('Default', 'Network', 'Cookies'), 'cookie-db-bytes');
  write(path.join('Default', 'Network', 'Cookies-wal'), 'wal-bytes');
  write(path.join('Default', 'Network', 'Cookies-shm'), 'shm-bytes');
  write(path.join('Default', 'Login Data'), 'login-db-bytes');
  write(path.join('Default', 'Local Storage', 'leveldb', '000001.log'), 'localstorage-token');
  write(path.join('Default', 'Local Storage', 'leveldb', 'LOCK'), '');
  write(path.join('Default', 'IndexedDB', 'origin.indexeddb.leveldb', '000003.log'), 'indexeddb-bulk');
  write(path.join('Default', 'Extensions', 'addon', '1.0', 'manifest.json'), '{"name":"addon"}');
  write(path.join('Default', 'Cache', 'data_0'), 'cache-bulk');
  write('shader-cache', 'shader-bulk');
  write('BrowserMetrics-spare.pma', 'metrics-bulk');
  // Neither a cache name nor an identity pattern: the identity tier reports it as
  // dropped rather than as an empty directory it created.
  write('component-crx-cache/data', 'component-bulk');
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
    'PLAYWRIGHT_MCP_USER_DATA_DIR',
    'PLAYWRIGHT_MCP_ISOLATED',
    'PLAYWRIGHT_MCP_PROXY_SERVER',
  ]) {
    delete childEnv[name];
  }
  if (options.isolation !== undefined) childEnv.STEALTH_PROFILE_ISOLATION = options.isolation;
  if (options.onLocked !== undefined) childEnv.STEALTH_ON_LOCKED = options.onLocked;
  if (options.lifetime !== undefined) childEnv.STEALTH_PROFILE_LIFETIME = options.lifetime;
  if (options.contents !== undefined) childEnv.STEALTH_COPY_CONTENTS = options.contents;
  if (options.seatLimit !== undefined) childEnv.STEALTH_SEAT_LIMIT = options.seatLimit;
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

async function profilesCurrent(session: BrokerSession): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name: 'browser_profiles', arguments: {} });
  return (response.result?.structuredContent?.current ?? {}) as Record<string, unknown>;
}

async function callTool(session: BrokerSession, name: string, args: Record<string, unknown> = {}) {
  return session.request('tools/call', { name, arguments: args });
}

describe('copy_contents, profile_lifetime and seat_limit settings', () => {
  it('defaults and explicit values', () => {
    expect(profile.DEFAULT_COPY_CONTENTS).toBe('full');
    expect(profile.COPY_CONTENTS_VALUES).toEqual(['full', 'identity']);
    expect(profile.resolveCopyContents('')).toMatchObject({ mode: 'full', source: 'default' });
    expect(profile.resolveCopyContents('IDENTITY')).toMatchObject({ mode: 'identity', source: 'setting' });
    expect(profile.resolveCopyContents('half')).toMatchObject({
      mode: 'full',
      source: 'default',
      ignored: 'half',
    });
    expect(profile.resolveCopyContents('${user_config.copy_contents}')).toMatchObject({ mode: 'full' });

    expect(profile.DEFAULT_PROFILE_LIFETIME).toBe('browser');
    expect(profile.PROFILE_LIFETIME_VALUES).toEqual(['browser', 'server']);
    expect(profile.resolveProfileLifetime('')).toMatchObject({ mode: 'browser', source: 'default' });
    expect(profile.resolveProfileLifetime('server')).toMatchObject({ mode: 'server', source: 'setting' });
    expect(profile.resolveProfileLifetime('forever')).toMatchObject({
      mode: 'browser',
      ignored: 'forever',
    });

    expect(profile.DEFAULT_SEAT_LIMIT).toBe('engine-default');
    expect(profile.SEAT_LIMIT_VALUES).toEqual(['engine-default', 'vendor-license', 'unlimited']);
    expect(profile.resolveSeatLimit('')).toMatchObject({ mode: 'engine-default', source: 'default' });
    expect(profile.resolveSeatLimit('unlimited')).toMatchObject({ mode: 'unlimited', source: 'setting' });
    expect(profile.resolveSeatLimit('5')).toMatchObject({ mode: 'engine-default', ignored: '5' });
  });

  it('is declared in the plugin manifests with the documented counts and defaults', () => {
    const expected: Record<string, Record<string, { options?: string[]; default: unknown }>> = {
      cloakbrowser: {
        copy_contents: { options: ['full', 'identity'], default: 'full' },
        profile_lifetime: { options: ['browser', 'server'], default: 'browser' },
        seat_limit: { options: ['engine-default', 'vendor-license', 'unlimited'], default: 'engine-default' },
      },
      camoufox: {
        copy_contents: { options: ['full', 'identity'], default: 'full' },
        profile_lifetime: { options: ['browser', 'server'], default: 'browser' },
      },
    };
    const counts: Record<string, number> = { cloakbrowser: 36, camoufox: 23 };
    for (const [name, settings] of Object.entries(expected)) {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'),
      ) as { userConfig: Record<string, { type: string; options?: string[]; default: unknown }> };
      expect(Object.keys(manifest.userConfig)).toHaveLength(counts[name]);
      for (const [setting, facts] of Object.entries(settings)) {
        expect(manifest.userConfig[setting]).toMatchObject({ type: 'string' });
        expect(manifest.userConfig[setting].options).toEqual(facts.options);
        expect(manifest.userConfig[setting].default).toBe(facts.default);
      }
      const mcp = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, '.mcp.json'), 'utf8'),
      ) as Record<string, { env: Record<string, string> }>;
      expect(mcp[name].env.STEALTH_COPY_CONTENTS).toBe('${user_config.copy_contents}');
      expect(mcp[name].env.STEALTH_PROFILE_LIFETIME).toBe('${user_config.profile_lifetime}');
      expect(mcp[name].env.STEALTH_SEAT_LIMIT).toBe(
        name === 'cloakbrowser' ? '${user_config.seat_limit}' : undefined,
      );
    }
  });

  it('declares identityCopy for every engine whose profile the broker manages', () => {
    const configuration = registry.loadEngineConfiguration({
      enginesDir: path.join(pluginDir, 'engines'),
      profilesFile: path.join(pluginDir, 'engines', 'profiles.json'),
      engineId: 'playwright',
      launcherDir: pluginDir,
    });
    expect(configuration.error).toBeNull();
    for (const engine of ['cloak', 'playwright', 'camoufox']) {
      const loaded = registry.loadEngineConfiguration({
        enginesDir: path.join(pluginDir, 'engines'),
        profilesFile: path.join(pluginDir, 'engines', 'profiles.json'),
        engineId: engine,
        launcherDir: pluginDir,
      });
      expect(loaded.error).toBeNull();
      const descriptor = registry.manifestIdentityCopy(loaded.engine);
      expect(descriptor).not.toBeNull();
      expect((descriptor?.keep ?? []).length).toBeGreaterThan(5);
      expect(typeof descriptor?.notes).toBe('string');
    }
    for (const engine of ['camoufox-native', 'kameleo']) {
      const loaded = registry.loadEngineConfiguration({
        enginesDir: path.join(pluginDir, 'engines'),
        profilesFile: path.join(pluginDir, 'engines', 'profiles.json'),
        engineId: engine,
        launcherDir: pluginDir,
      });
      expect(loaded.error).toBeNull();
      expect(registry.manifestIdentityCopy(loaded.engine)).toBeNull();
    }
  });
});

describe('identity tier planning', () => {
  const patterns = [
    'Local State',
    'Default/Login Data',
    'Default/Network/Cookies',
    'Default/Local Storage/**',
    'Default/Extensions/**',
  ];

  it('matches one segment with * and any depth with **, case-insensitively', () => {
    expect(profile.identityKeepIndex('Local State', patterns)).toBe(0);
    expect(profile.identityKeepIndex('local state', patterns)).toBe(0);
    expect(profile.identityKeepIndex('Default/Login Data', patterns)).toBe(1);
    expect(
      profile.identityKeepIndex(path.join('Default', 'Local Storage', 'leveldb', 'x.log'), patterns),
    ).toBe(3);
    // '**' also matches zero segments, so the directory itself matches (the filter
    // only ever sees files, so this is harmless).
    expect(profile.identityKeepIndex(path.join('Default', 'Local Storage'), patterns)).toBe(3);
    expect(profile.identityKeepIndex('Default/Preferences', patterns)).toBe(-1);
    expect(profile.identityKeepIndex('Storage/Default/Login Data', patterns)).toBe(-1);
  });

  it('filters a plan, keeps databases paired with their WAL and reports the drop', () => {
    const root = tempRoot('identity-plan-');
    seedBase(root);
    const plan = profile.planCopy(root, { engineLockFile: 'lockfile' });
    const identity = profile.restrictPlanToIdentity(plan, patterns);
    const relatives = identity.files.map((file) => file.relative.replaceAll('\\', '/'));
    expect(relatives).toContain('Local State');
    expect(relatives).toContain('Default/Network/Cookies');
    // The WAL travels with the database it belongs to; the SHM never does.
    expect(relatives).toContain('Default/Network/Cookies-wal');
    expect(relatives).not.toContain('Default/Network/Cookies-shm');
    expect(relatives).toContain('Default/Login Data');
    expect(relatives).toContain('Default/Local Storage/leveldb/000001.log');
    expect(relatives).not.toContain('Default/Local Storage/leveldb/LOCK');
    expect(relatives).not.toContain('Default/IndexedDB/origin.indexeddb.leveldb/000003.log');
    expect(relatives).not.toContain('Default/Cache/data_0');
    expect(identity.bytes).toBeLessThan(plan.bytes);
    expect(identity.identity).toMatchObject({
      keptFiles: identity.files.length,
      droppedFiles: plan.files.length - identity.files.length,
    });
    // The copy order follows the list: Local State first, then Login Data, Cookies.
    expect(relatives[0]).toBe('Local State');
    expect(relatives.indexOf('Default/Login Data')).toBeLessThan(
      relatives.indexOf('Default/Network/Cookies'),
    );
    // Top-level entries that kept nothing are reported as dropped by the tier.
    const dropped = identity.topLevel.find((entry) => entry.path === 'component-crx-cache');
    expect(dropped?.excluded).toBe('identity');
    expect(dropped?.files).toBe(0);
    // The full plan is untouched: a file the identity tier dropped is still in it.
    expect(
      plan.files.some((file) => file.relative.replaceAll('\\', '/') === 'component-crx-cache/data'),
    ).toBe(true);
    expect(plan.identity).toBeUndefined();
  });

  it('scans live engine locks in the profiles it manages', () => {
    const dataDir = tempRoot('seat-scan-');
    const descriptor = { file: 'parent.lock', owner: 'pid' };
    const live = path.join(dataDir, 'profiles', 'camoufox', 'default');
    const stale = path.join(dataDir, 'profiles', 'camoufox', 'default-2');
    const copies = path.join(dataDir, 'profiles', 'camoufox', '.sessions', 'default-20260101-000000-1');
    for (const dir of [live, stale, copies]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'parent.lock'), '');
    }
    writeFileSync(path.join(live, 'parent.lock'), `${process.pid}\n`);
    writeFileSync(path.join(copies, 'parent.lock'), `${process.pid}\n`);
    writeFileSync(path.join(stale, 'parent.lock'), '2147483647\n');
    const scan = profile.scanLiveEngineLocks('camoufox', dataDir, descriptor);
    expect(scan.count).toBe(2);
    expect(scan.live.map((entry) => path.basename(entry.dir)).sort()).toEqual([
      'default',
      'default-20260101-000000-1',
    ]);
    expect(profile.scanLiveEngineLocks('camoufox', dataDir, null)).toMatchObject({ count: 0 });
  });
});

describe('broker on_locked=copy', () => {
  it('takes a copy of the busy base, keeps it byte-identical and never creates a sibling', async () => {
    const root = tempRoot('on-locked-copy-');
    const dataDir = createRuntime(root);
    const base = path.join(dataDir, 'profiles', 'default');
    seedBase(base);
    writeJson(path.join(base, '.cloakbrowser-mcp-profile.lock'), {
      pid: process.pid,
      createdAt: '2026-10-28T09:00:00.000Z',
      userDataDir: base,
    });
    const before = readFileSync(path.join(base, 'Default', 'Network', 'Cookies'), 'utf8');
    const session = startBroker({ dataDir, onLocked: 'copy', lifetime: 'server' });
    const initialized = await initialize(session);
    const caps = await capabilities(session);
    expect(caps.onLocked).toBe('copy');
    expect(caps.profileFallback).toMatchObject({ from: base, kind: 'copy', createdEmpty: false });
    expect(caps.profileLifetime).toBe('server');
    const copy = caps.profileCopy as Record<string, unknown>;
    expect(copy).toMatchObject({ baseDir: base, kind: 'on-locked', scope: 'full', state: 'prepared' });
    expect(String(copy.sessionDir)).toContain(path.join('profiles', 'playwright', '.sessions'));
    // A copy on lock takes no lock of its own: the base lock is still the owner's.
    expect((copy.baseLock as Record<string, unknown>).heldBy).toBe('another-session');
    expect((copy.baseLock as Record<string, unknown>).lifetime).toBe('server');
    expect(String(initialized.result?.instructions)).toContain('temporary copy taken at');
    expect(String(initialized.result?.instructions)).toContain('this session runs on a temporary copy');
    // The base is untouched and no numbered sibling was made.
    expect(readFileSync(path.join(base, 'Default', 'Network', 'Cookies'), 'utf8')).toBe(before);
    expect(profile.readProfileLock(base)).toMatchObject({ state: 'live', owner: { pid: process.pid } });
    expect(existsSync(`${base}-2`)).toBe(false);
    // The copy carries the identity files and none of the excluded classes.
    const sessionDir = String(copy.sessionDir);
    expect(existsSync(path.join(sessionDir, 'Local State'))).toBe(true);
    expect(existsSync(path.join(sessionDir, 'Default', 'Network', 'Cookies'))).toBe(true);
    expect(existsSync(path.join(sessionDir, 'Default', 'Network', 'Cookies-shm'))).toBe(false);
    expect(existsSync(path.join(sessionDir, 'Default', 'Cache'))).toBe(false);
    expect(existsSync(path.join(sessionDir, 'BrowserMetrics-spare.pma'))).toBe(false);
    // A profile copy in the same tool run reports the fallback too (2.20.0: the
    // browser_profiles blind spot).
    const current = await profilesCurrent(session);
    expect(current.profileFallback).toMatchObject({ kind: 'copy' });
    expect(current.profileCopy).toMatchObject({ kind: 'on-locked' });
    await session.close();
    // A clean shutdown discards the copy; the base never belonged to us.
    expect(existsSync(sessionDir)).toBe(false);
  });

  it('applies copy_contents=identity through the manifest list', async () => {
    const root = tempRoot('on-locked-identity-');
    const dataDir = createRuntime(root);
    const base = path.join(dataDir, 'profiles', 'default');
    seedBase(base);
    writeJson(path.join(base, '.cloakbrowser-mcp-profile.lock'), {
      pid: process.pid,
      createdAt: '2026-10-28T09:00:00.000Z',
      userDataDir: base,
    });
    const session = startBroker({ dataDir, onLocked: 'copy', contents: 'identity', lifetime: 'server' });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.copyContents).toBe('identity');
    expect(caps.identityCopy).toMatchObject({ keep: expect.any(Number) });
    const copy = caps.profileCopy as Record<string, unknown>;
    expect(copy.scope).toBe('identity');
    const sessionDir = String(copy.sessionDir);
    expect(existsSync(path.join(sessionDir, 'Local State'))).toBe(true);
    expect(existsSync(path.join(sessionDir, 'Default', 'Network', 'Cookies'))).toBe(true);
    expect(existsSync(path.join(sessionDir, 'Default', 'Network', 'Cookies-wal'))).toBe(true);
    expect(existsSync(path.join(sessionDir, 'Default', 'Login Data'))).toBe(true);
    expect(existsSync(path.join(sessionDir, 'Default', 'Local Storage', 'leveldb', '000001.log'))).toBe(true);
    expect(existsSync(path.join(sessionDir, 'Default', 'Extensions', 'addon', '1.0', 'manifest.json'))).toBe(
      true,
    );
    expect(existsSync(path.join(sessionDir, 'Default', 'IndexedDB'))).toBe(false);
    expect(existsSync(path.join(sessionDir, 'Default', 'Network', 'Cookies-shm'))).toBe(false);
  });

  it('defers the copy of a copy-mode session to the first browser action (browser lifetime)', async () => {
    const root = tempRoot('browser-lifetime-');
    const dataDir = createRuntime(root);
    const base = path.join(dataDir, 'profiles', 'default');
    seedBase(base);
    const session = startBroker({ dataDir, isolation: 'copy' });
    await initialize(session);
    const before = await capabilities(session);
    expect(before.profileLifetime).toBe('browser');
    expect(before.profileCopy).toBeNull();
    expect(before.profileDir).toBeNull();
    // Nothing is locked or copied while no browser is used.
    expect(profile.readProfileLock(base)).toMatchObject({ state: 'free' });
    expect(existsSync(path.join(dataDir, 'profiles', 'playwright', '.sessions'))).toBe(false);

    const call = await callTool(session, 'browser_navigate', { url: 'data:text/html,x' });
    expect(call.result?.isError).toBe(false);
    const after = await capabilities(session);
    const copy = after.profileCopy as Record<string, unknown>;
    expect(copy).toMatchObject({ kind: 'copy', state: 'prepared' });
    expect(after.profileDir).toBe(copy.sessionDir);
    expect((copy.baseLock as Record<string, unknown>).lifetime).toBe('browser');
    expect((copy.baseLock as Record<string, unknown>).heldByThisSession).toBe(true);

    // Closing the browser discards the copy and releases the base lock; the next
    // browser action takes a fresh copy at the same path.
    const closed = await callTool(session, 'browser_close');
    expect(closed.result?.isError).toBe(false);
    const sessionDir = String(copy.sessionDir);
    expect(existsSync(sessionDir)).toBe(false);
    expect(profile.readProfileLock(base)).toMatchObject({ state: 'free' });
    const afterClose = await profilesCurrent(session);
    expect(afterClose.profileCopy).toMatchObject({ state: 'discarded' });
    expect(afterClose.profileCopyPending).toMatchObject({ kind: 'copy' });
    expect(afterClose.browserOpen).toBe(false);
    expect(afterClose.browserOpenSource).toBe('close-tool');

    const again = await callTool(session, 'browser_navigate', { url: 'data:text/html,y' });
    expect(again.result?.isError).toBe(false);
    expect(existsSync(sessionDir)).toBe(true);
    const recopied = await profilesCurrent(session);
    expect(recopied.profileCopy).toMatchObject({ state: 'prepared' });
    expect(recopied.profileCopyPending).toBeUndefined();
  });

  it('latches the engine lock and releases the copy when the browser closes', async () => {
    const root = tempRoot('browser-latch-');
    const dataDir = createRuntime(root);
    const base = path.join(dataDir, 'profiles', 'default');
    seedBase(base);
    const session = startBroker({ dataDir, isolation: 'copy', lifetime: 'browser' });
    await initialize(session);
    await callTool(session, 'browser_navigate', { url: 'data:text/html,x' });
    const caps = await capabilities(session);
    const sessionDir = String((caps.profileCopy as Record<string, unknown>).sessionDir);
    // The stub wrote the engine lock, but nothing holds it, so the probe reads it
    // stale and the latch stays closed.
    expect((await profilesCurrent(session)).browserOpen).toBeNull();

    // Hold the copied profile's engine lock the way a browser does (no sharing),
    // so the next probe reads it live and the latch opens.
    const holder = await holdExclusiveFile(path.join(sessionDir, 'lockfile'));
    try {
      await callTool(session, 'browser_navigate', { url: 'data:text/html,y' });
      const open = await profilesCurrent(session);
      expect(open.browserOpen).toBe(true);
      expect(open.browserOpenSource).toBe('engine-lock');
    } finally {
      await holder.stop();
    }
    // The browser is gone: the poll notices within a second and the copy is
    // deleted while the broker keeps running.
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const closed = await profilesCurrent(session);
    expect(closed.browserOpen).toBe(false);
    expect(closed.browserOpenSource).toBe('engine-lock');
    expect(existsSync(sessionDir)).toBe(false);
    expect(profile.readProfileLock(base)).toMatchObject({ state: 'free' });
  });
});

describe('broker seat gate and the copy modes', () => {
  it('holds instead of copying when the only seat is taken, and copies when it frees', async () => {
    const root = tempRoot('seat-gate-');
    const dataDir = createRuntime(root, 'cloak');
    const base = path.join(dataDir, 'profiles', 'default');
    seedBase(base);
    writeJson(path.join(base, '.cloakbrowser-mcp-profile.lock'), {
      pid: process.pid,
      createdAt: '2026-10-28T09:00:00.000Z',
      userDataDir: base,
    });
    // One live engine lock in a sibling profile occupies the single seat. The
    // cloak manifest's descriptor is exclusive-open-write, so the probe opens the
    // file for writing; a plain file reads as stale, and a lock naming a live pid
    // is what the `pid` rule would read — so the seat scan is exercised with a
    // scratch manifest that declares the pid rule for the same engine id.
    const plugin = createSeatPlugin(root);
    const seatDir = path.join(dataDir, 'profiles', 'cloak', 'default-2');
    mkdirSync(seatDir, { recursive: true });
    writeFileSync(path.join(seatDir, 'parent.lock'), `${process.pid}\n`);
    const session = startBroker({
      dataDir,
      engine: 'cloak',
      pluginDir: plugin,
      onLocked: 'copy',
      lifetime: 'server',
    });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.seatLimit).toBe(1);
    expect(caps.seatLimitSource).toBe('manifest');
    expect(caps.seatsInUse).toBe(1);
    expect(caps.seatFree).toBe(false);
    expect(caps.profileCopy).toBeUndefined();
    expect(caps.hold).toMatchObject({
      state: 'waiting',
      seat: { seatLimit: 1, seatsInUse: 1, seatFree: false },
    });
    expect(existsSync(path.join(dataDir, 'profiles', 'cloak', '.sessions'))).toBe(false);
  });

  it('lets seat_limit=unlimited copy while another profile holds a live lock', async () => {
    const root = tempRoot('seat-unlimited-');
    const dataDir = createRuntime(root, 'cloak');
    const base = path.join(dataDir, 'profiles', 'default');
    seedBase(base);
    writeJson(path.join(base, '.cloakbrowser-mcp-profile.lock'), {
      pid: process.pid,
      createdAt: '2026-10-28T09:00:00.000Z',
      userDataDir: base,
    });
    const plugin = createSeatPlugin(root);
    const seatDir = path.join(dataDir, 'profiles', 'cloak', 'default-2');
    mkdirSync(seatDir, { recursive: true });
    writeFileSync(path.join(seatDir, 'parent.lock'), `${process.pid}\n`);
    const session = startBroker({
      dataDir,
      engine: 'cloak',
      pluginDir: plugin,
      onLocked: 'copy',
      lifetime: 'server',
      seatLimit: 'unlimited',
    });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.seatLimit).toBe('unlimited');
    expect(caps.seatLimitSource).toBe('setting');
    expect(caps.seatFree).toBe(true);
    expect(caps.profileCopy).toMatchObject({ kind: 'on-locked', state: 'prepared' });
  });
});

// A copy of the plugin tree whose cloak manifest uses the pid owner rule, so the
// seat scan can be exercised with a live pid instead of an exclusive handle.
function createSeatPlugin(root: string): string {
  const plugin = path.join(root, 'plugin');
  mkdirSync(path.join(plugin, 'engines'), { recursive: true });
  const cloak = JSON.parse(readFileSync(path.join(pluginDir, 'engines', 'cloak.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  cloak.profileLock = { file: 'parent.lock', owner: 'pid' };
  writeJson(path.join(plugin, 'engines', 'cloak.json'), cloak);
  for (const entry of readdirSync(pluginDir)) {
    if (entry.endsWith('.mjs')) {
      writeFileSync(path.join(plugin, entry), readFileSync(path.join(pluginDir, entry)));
    }
  }
  mkdirSync(path.join(plugin, 'lib'), { recursive: true });
  for (const entry of readdirSync(path.join(pluginDir, 'lib'))) {
    writeFileSync(path.join(plugin, 'lib', entry), readFileSync(path.join(pluginDir, 'lib', entry)));
  }
  mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  writeFileSync(
    path.join(plugin, 'scripts', 'profile-copy.mjs'),
    readFileSync(path.join(pluginDir, 'scripts', 'profile-copy.mjs')),
  );
  writeFileSync(
    path.join(plugin, 'engines', 'profiles.json'),
    readFileSync(path.join(pluginDir, 'engines', 'profiles.json')),
  );
  return plugin;
}

// Hold a file open with no sharing, the way a browser holds its engine lock: the
// OS then refuses every other open, which is what `exclusive-open-write` reads.
// Windows only; the caller skips elsewhere.
async function holdExclusiveFile(file: string): Promise<{ stop: () => Promise<void> }> {
  const script =
    `$f=[System.IO.File]::Open('${file.replaceAll("'", "''")}','Open','ReadWrite','None');` +
    'Write-Output held; Start-Sleep -Seconds 60';
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('could not start the file holder');
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const handle = openSync(file, 'r+');
      closeSync(handle);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EBUSY') {
        return {
          stop: async () => {
            try {
              process.kill(pid);
            } catch {
              // Already gone.
            }
            await new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) {
                resolve();
                return;
              }
              child.once('exit', () => resolve());
              setTimeout(() => resolve(), 3000);
            });
          },
        };
      }
      throw error;
    }
  }
  throw new Error(`the file holder never made ${file} exclusive`);
}
