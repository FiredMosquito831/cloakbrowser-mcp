import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { holdEngineLock, manifestProfileLock } from '@tests/helpers/engine-lock-holder.js';

// profile_isolation=session (2.24.0). The user's request was Playwright's
// parallelism with this product's identity model: one MCP server per Claude Code
// session, each on its own folder, seeded from the default profile by an identity
// copy rather than an empty directory.
//
// The mode resolves its base exactly like "shared" and differs from "copy" in
// exactly three facts, each pinned below:
//   1. it NEVER takes the base profile's lock, so N sessions can run on one base
//      and a base that is already in use is copied instead of refused;
//   2. its copy is always the identity tier, because the base may be live and only
//      that tier excludes the files a live writer holds;
//   3. its copy belongs to the BROKER (the session), not the browser: a browser
//      close neither discards nor re-arms it, and a clean exit discards it.
// The suite also pins the two small fixes folded into the same release: the
// first-browser-action profile re-check (which turns "several agents start
// together" from a raw browser launch failure into the shipped copy path) and the
// kind/createdEmpty facts on the engine-lock fallback report.
interface ProfileResolution {
  profileDir: string | null;
  defaultProfileDir: string;
  profileSource: string | null;
  account: string | null;
  accountApplies: boolean;
  ignored?: { setting: string; value: string; reason: string }[];
  error: string | null;
}

interface SessionModule {
  PROFILE_ISOLATION_VALUES: string[];
  PROFILE_ISOLATION_SESSION: string;
  DEFAULT_PROFILE_ISOLATION: string;
  COPY_CONTENTS_SOURCE_SESSION: string;
  isCopyIsolation(value: string): boolean;
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
  profileSessionNote(baseDir: string, sessionDir: string): string;
  sessionCopyContentsNote(): string;
  sessionProfileLifetimeNote(): string;
  sessionOnLockedNote(): string;
  sessionParallelismNote(): string;
  sessionCopyDir(
    engineId: string,
    dataDir: string,
    baseDir: string,
    options?: { pid?: number; now?: Date },
  ): string;
  sessionRootDir(engineId: string, dataDir: string): string;
  readProfileLock(profileDir: string): { state: string; owner: { pid: number } | null };
  profileLockPath(profileDir: string): string;
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
  pid: number | null;
  request: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<JsonRpcResponse>;
  stderr: () => string;
  close: () => Promise<void>;
  kill: () => void;
  exited: Promise<number | null>;
}

interface BrokerOptions {
  dataDir: string;
  cwd?: string;
  isolation?: string;
  onLocked?: string;
  account?: string;
  profileDir?: string;
  engine?: string;
  profileLifetime?: string;
  copyContents?: string;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const brokerPath = path.join(pluginDir, 'broker.mjs');
const profileModulePath = new URL('../../plugins/cloakbrowser/lib/profile.mjs', import.meta.url);
const profile = (await import(profileModulePath.href)) as unknown as SessionModule;

const STUB_TOOLS = ['browser_navigate', 'browser_snapshot'];

// The stub backend reports the profile directory and the isolated flag it was
// started with, so the suite can prove which directory the browser would use.
const STUB_SOURCE = `#!/usr/bin/env node
const readline = require('node:readline');
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-session', version: '0.0.0' } } });
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
      pid: process.pid,
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

function writeFile(file: string, content = 'x'): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
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
    'STEALTH_PROFILE_LIFETIME',
    'STEALTH_COPY_CONTENTS',
    'PLAYWRIGHT_MCP_USER_DATA_DIR',
    'PLAYWRIGHT_MCP_ISOLATED',
    'PLAYWRIGHT_MCP_PROXY_SERVER',
  ]) {
    delete childEnv[name];
  }
  if (options.account !== undefined) childEnv.STEALTH_ACCOUNT = options.account;
  if (options.isolation !== undefined) childEnv.STEALTH_PROFILE_ISOLATION = options.isolation;
  if (options.onLocked !== undefined) childEnv.STEALTH_ON_LOCKED = options.onLocked;
  if (options.profileLifetime !== undefined) childEnv.STEALTH_PROFILE_LIFETIME = options.profileLifetime;
  if (options.copyContents !== undefined) childEnv.STEALTH_COPY_CONTENTS = options.copyContents;
  if (options.profileDir !== undefined) childEnv.PLAYWRIGHT_MCP_USER_DATA_DIR = options.profileDir;
  const child = spawn(process.execPath, [brokerPath], {
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
      child.stdin.end();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  };
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  };
  const session: BrokerSession = {
    pid: child.pid ?? null,
    request,
    stderr: () => stderr,
    close,
    kill,
    exited,
  };
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

async function profilesPayload(
  session: BrokerSession,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name: 'browser_profiles', arguments: args });
  return response.result?.structuredContent ?? {};
}

async function effectiveEnvironment(
  session: BrokerSession,
): Promise<{ profileDir: string | null; isolated: string | null; proxy: string | null; pid: number }> {
  const response = await session.request('tools/call', {
    name: 'browser_navigate',
    arguments: { url: 'http://127.0.0.1:9/' },
  });
  const text = response.result?.content?.[0]?.text ?? '{}';
  return JSON.parse(text) as {
    profileDir: string | null;
    isolated: string | null;
    proxy: string | null;
    pid: number;
  };
}

function baseProfileDir(dataDir: string, engine = 'cloak', name = 'default'): string {
  return engine === 'cloak' || engine === 'playwright'
    ? path.join(dataDir, 'profiles', name)
    : path.join(dataDir, 'profiles', engine, name);
}

// A base profile with the identity files a session copy must carry and every
// excluded class it must leave behind.
function seedBaseProfile(dataDir: string, engine = 'cloak', name = 'default'): string {
  const base = baseProfileDir(dataDir, engine, name);
  writeFile(path.join(base, '.cloakbrowser-seed'), '12345\n');
  writeFile(path.join(base, 'Local State'), '{"os_crypt":{"encrypted_key":"DPAPI-TEST"}}');
  writeFile(path.join(base, 'Default', 'Network', 'Cookies'), 'COOKIE-BASE');
  writeFile(path.join(base, 'Default', 'Network', 'Cookies-wal'), 'WAL-DATA');
  writeFile(path.join(base, 'Default', 'Network', 'Cookies-shm'), 'SHM-DATA');
  writeFile(path.join(base, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'LOCALSTORAGE');
  writeFile(path.join(base, 'Default', 'Preferences'), '{"profile":{}}');
  writeFile(path.join(base, 'Default', 'History'), 'HISTORY');
  writeFile(path.join(base, 'Cache', 'data_0'), 'CACHE');
  writeFile(path.join(base, 'BrowserMetrics', 'metrics.pma'), 'METRICS');
  writeFile(path.join(base, 'notes.tmp'), 'TMP');
  writeFile(path.join(base, 'logs', 'debug.log'), 'LOG');
  writeFile(path.join(base, 'lockfile'), '');
  return base;
}

const LOCK_FILE_NAMES = new Set(['.cloakbrowser-mcp-profile.lock', 'lockfile', 'parent.lock']);

// A stable hash of a directory tree, path and bytes, skipping the lock files the
// broker legitimately reclaims and replaces.
function hashTree(root: string, prefix = ''): string {
  const hash = createHash('sha256');
  const entries = readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (LOCK_FILE_NAMES.has(entry.name.toLowerCase())) {
      continue;
    }
    if (entry.isDirectory()) {
      hash.update(`D ${relative}\n`);
      hash.update(hashTree(root, relative));
    } else if (entry.isFile()) {
      hash.update(`F ${relative} ${readFileSync(path.join(root, relative)).toString('base64')}\n`);
    }
  }
  return hash.digest('hex');
}

function listFiles(root: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.map((file) => file.split(path.sep).join('/')).sort();
}

// The broker's own layout: profiles/<engine>/.sessions for every engine, the
// Chromium ones included (sessionCopyDir joins the engine id unconditionally).
function sessionCopies(dataDir: string, engine = 'cloak'): string[] {
  const resolved = path.join(dataDir, 'profiles', engine, '.sessions');
  try {
    return readdirSync(resolved, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(resolved, entry.name))
      .sort();
  } catch {
    return [];
  }
}

describe('session as a profile_isolation value', () => {
  it('is offered by both plugin manifests with honest help text', () => {
    for (const name of ['cloakbrowser', 'camoufox']) {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'),
      ) as { version: string; userConfig: { profile_isolation: { options: string[]; description: string } } };
      const setting = manifest.userConfig.profile_isolation;
      expect(setting.options).toEqual(['shared', 'workspace', 'isolated', 'copy', 'copy-keep', 'session']);
      expect(setting.description).toContain('  - session');
      // The block shape the other options use: a lead clause, continuation lines
      // on a four-space indent, and the shared Default/Notes sections after it.
      expect(setting.description).toMatch(/\n {4}\S/u);
      expect(setting.description).toContain('Default: shared');
      expect(setting.description).toContain('Notes:');
      // The facts a user must be able to read before choosing it.
      expect(setting.description).toContain('never locks that base profile');
      expect(setting.description).toContain('identity tier');
      expect(setting.description).toContain('subagents inside one session share it');
      expect(setting.description).toContain('seat limit');
      expect(setting.description).toContain('not applicable');
      expect(setting.description.toLowerCase()).not.toContain('in memory');
      expect(manifest.version).toBe('2.24.0');
    }
    expect(profile.PROFILE_ISOLATION_VALUES).toEqual([
      'shared',
      'workspace',
      'isolated',
      'copy',
      'copy-keep',
      'session',
    ]);
    expect(profile.PROFILE_ISOLATION_SESSION).toBe('session');
    expect(profile.DEFAULT_PROFILE_ISOLATION).toBe('shared');
    expect(profile.COPY_CONTENTS_SOURCE_SESSION).toBe('session');
  });

  it('is accepted by resolveProfileIsolation and is never a default', () => {
    expect(profile.resolveProfileIsolation('session')).toEqual({
      mode: 'session',
      source: 'setting',
      ignored: null,
      placeholder: null,
    });
    expect(profile.resolveProfileIsolation('  session  ').mode).toBe('session');
    expect(profile.resolveProfileIsolation('').mode).toBe('shared');
    expect(profile.resolveProfileIsolation('${user_config.profile_isolation}').mode).toBe('shared');
    expect(profile.resolveProfileIsolation('sessionish').mode).toBe('shared');
    expect(profile.resolveProfileIsolation('sessionish').ignored).toBe('sessionish');
  });

  it('is deliberately NOT a copy mode: that helper answers "does this hold the base lock"', () => {
    expect(profile.isCopyIsolation('session')).toBe(false);
    expect(profile.isCopyIsolation('copy')).toBe(true);
    expect(profile.isCopyIsolation('copy-keep')).toBe(true);
  });

  it('shares one honest sentence per inapplicable setting', () => {
    const note = profile.profileSessionNote('D:/base', 'D:/copy');
    expect(note).toContain('"session"');
    expect(note).toContain('D:/base');
    expect(note).toContain('D:/copy');
    expect(note).toContain('never locked');
    expect(note).toContain('discarded');
    expect(profile.sessionCopyContentsNote()).toContain('identity tier');
    expect(profile.sessionProfileLifetimeNote()).toContain('not applied');
    expect(profile.sessionOnLockedNote()).toContain('copied rather than refused');
    // The subagent limitation is stated, and the seat caveat with it.
    expect(profile.sessionParallelismNote()).toContain('subagents inside one session share');
    expect(profile.sessionParallelismNote()).toContain('seat limit');
  });
});

describe('session resolution', () => {
  const dataDir = path.resolve('D:/scratch/session-resolution-data');
  const options = {
    engineId: 'cloak',
    dataDir,
    launcherName: 'launch.mjs',
    cwd: 'D:\\Projects2\\StealthBrowserAutomation',
  };

  it('resolves exactly like shared: profile_dir, account, pointer, engine default', () => {
    const cases: Record<string, unknown>[] = [
      {},
      { profileDir: 'D:/profiles/explicit' },
      { account: 'alice' },
      { pointer: 'work' },
      { pointer: 'default' },
      { account: '${user_config.account}', pointer: null },
    ];
    for (const input of cases) {
      const session = profile.resolveProfile({ ...options, ...input, isolation: 'session' });
      const shared = profile.resolveProfile({ ...options, ...input, isolation: 'shared' });
      expect(session).toEqual(shared);
      expect(session.profileSource).not.toBe('workspace');
    }
    expect(profile.resolveProfile({ ...options, isolation: 'session' }).profileSource).toBe('default');
    expect(profile.resolveProfile({ ...options, isolation: 'session' }).profileDir).toBeNull();
  });

  it('never derives a workspace profile, unlike workspace', () => {
    const session = profile.resolveProfile({ ...options, isolation: 'session', cwd: 'D:/a' });
    const workspace = profile.resolveProfile({ ...options, isolation: 'workspace', cwd: 'D:/a' });
    expect(session.profileSource).toBe('default');
    expect(workspace.profileSource).toBe('workspace');
    expect(session.profileDir).not.toBe(workspace.profileDir);
  });

  it('keeps the shared account-name error', () => {
    const session = profile.resolveProfile({ ...options, isolation: 'session', account: '../x' });
    expect(session.error).toBe(
      profile.resolveProfile({ ...options, isolation: 'shared', account: '../x' }).error,
    );
  });

  it('names its copy per process in the shared .sessions layout', () => {
    const dir = profile.sessionCopyDir('cloak', dataDir, 'D:/base', {
      pid: 4321,
      now: new Date(2026, 10, 10, 18, 27, 0),
    });
    expect(dir).toBe(path.join(profile.sessionRootDir('cloak', dataDir), 'base-20261110-182700-4321'));
  });
});

// The tool-list cache is keyed by the surface (engine, tool profile, group
// switches, MCP pin, manifest support), never by the profile mode, so one warm
// start writes the cache every later start of the same surface reads. Without it
// the 2.21.0 cold-surface rule takes the copy before tools/list is answered —
// correct, but it hides the lazy path this suite also has to pin.
async function warmToolCache(dataDir: string, engine = 'cloak'): Promise<void> {
  const warm = startBroker({ dataDir, isolation: 'shared', engine });
  await initialize(warm);
  await warm.request('tools/list', {});
  await warm.close();
  sessions.splice(sessions.indexOf(warm), 1);
}

describe('session mode end to end', () => {
  it('runs on an identity copy of the base and never locks it', async () => {
    const dataDir = createRuntime(tempRoot('session-basic-'));
    const base = seedBaseProfile(dataDir);
    const before = hashTree(base);
    await warmToolCache(dataDir);

    const session = startBroker({ dataDir, isolation: 'session' });
    await initialize(session);

    const caps = await capabilities(session);
    expect(caps.profileIsolation).toBe('session');
    // The two settings that cannot apply are reported as such, with a reason.
    expect(caps.onLocked).toBeNull();
    expect(caps.onLockedSource).toBe('session');
    expect(String(caps.onLockedNote)).toContain('copied rather than refused');
    expect(caps.profileLifetime).toBeNull();
    expect(caps.profileLifetimeSource).toBe('session');
    expect(String(caps.profileLifetimeNote)).toContain('not applied');
    // The tier is the identity one whatever the setting says, and the payload
    // says the setting was not applied.
    expect(caps.copyContents).toBe('identity');
    expect(caps.copyContentsSource).toBe('session');
    expect(String(caps.copyContentsNote)).toContain('identity tier');

    // Nothing is copied or locked while no browser is used.
    expect(sessionCopies(dataDir)).toEqual([]);
    expect(profile.readProfileLock(base).state).toBe('free');

    // Before the copy is taken, the payload names the base (the profile the
    // session would use) and the copy it owes; after it, the copy directory.
    const pending = await profilesPayload(session);
    const current = pending.current as Record<string, unknown>;
    expect(current.profileIsolation).toBe('session');
    expect(current.profileCopyPending).toMatchObject({ kind: 'session', baseDir: base });
    expect(current.profileDir).toBe(base);

    // The first browser action takes the copy and starts the backend on it.
    const environment = await effectiveEnvironment(session);
    const copies = sessionCopies(dataDir);
    expect(copies).toHaveLength(1);
    expect(environment.profileDir).toBe(copies[0]);
    expect(environment.isolated).toBeNull();

    // The copy carries the identity core and leaves every excluded class behind.
    const copied = listFiles(copies[0]);
    expect(copied).toContain('Default/Network/Cookies');
    expect(copied).toContain('Default/Network/Cookies-wal');
    expect(copied).toContain('Local State');
    expect(copied).not.toContain('Default/Network/Cookies-shm');
    expect(copied).not.toContain('Cache/data_0');
    expect(copied).not.toContain('BrowserMetrics/metrics.pma');
    expect(copied).not.toContain('notes.tmp');
    expect(copied).not.toContain('logs/debug.log');
    expect(copied).not.toContain('lockfile');

    // The base is byte-identical and still unlocked: the mode's whole point.
    expect(hashTree(base)).toBe(before);
    expect(profile.readProfileLock(base).state).toBe('free');
    expect(existsSync(profile.profileLockPath(base))).toBe(false);

    const taken = await profilesPayload(session);
    const takenCurrent = taken.current as Record<string, unknown>;
    expect(takenCurrent.profileCopy).toMatchObject({ kind: 'session', state: 'prepared' });
    expect((takenCurrent.profileCopy as Record<string, unknown>).baseLock).toMatchObject({
      state: 'free',
      heldByThisSession: false,
      lifetimeReason: 'base-owner',
    });
  });

  it('copies a LIVE base instead of refusing it (the copy mode refuses)', async (t) => {
    // The playwright engine: no seat limit, so a live base is the only thing in
    // the way, and the point of the mode is that it is copied rather than refused.
    // (Camoufox would prove the same but provisions uv on first start.)
    const dataDir = createRuntime(tempRoot('session-live-base-'));
    const base = seedBaseProfile(dataDir, 'playwright');
    const before = hashTree(base);
    await warmToolCache(dataDir, 'playwright');
    const holder = await holdEngineLock(t, {
      file: path.join(base, 'lockfile'),
      profileDir: base,
      descriptor: manifestProfileLock('playwright'),
    });
    try {
      const session = startBroker({ dataDir, isolation: 'session', engine: 'playwright' });
      await initialize(session);
      const caps = await capabilities(session);
      expect(caps.profileIsolation).toBe('session');
      expect(caps.engineError ?? null).toBeNull();
      expect(caps.profileFallback).toMatchObject({ from: base, kind: 'copy', createdEmpty: false });
      expect(String((caps.profileFallback as Record<string, unknown>).reason)).toContain('"session"');

      const environment = await effectiveEnvironment(session);
      const copies = sessionCopies(dataDir, 'playwright');
      expect(copies).toHaveLength(1);
      expect(environment.profileDir).toBe(copies[0]);
      expect(listFiles(copies[0])).toContain('Default/Network/Cookies');
      // The base is untouched and the holder's lock is still the only one.
      expect(hashTree(base)).toBe(before);
      expect(profile.readProfileLock(base).state).toBe('free');
    } finally {
      await holder.stop();
    }
  });

  it('keeps its copy when the browser closes and discards it on a clean exit', async () => {
    const dataDir = createRuntime(tempRoot('session-lifetime-'));
    seedBaseProfile(dataDir);
    await warmToolCache(dataDir);

    const session = startBroker({ dataDir, isolation: 'session', profileLifetime: 'browser' });
    await initialize(session);
    await effectiveEnvironment(session);
    const copies = sessionCopies(dataDir);
    expect(copies).toHaveLength(1);

    // browser_close is a close signal; the copy must survive it, because its
    // lifetime is the broker's, not the browser's (USER DECISION D2).
    const closed = await session.request('tools/call', { name: 'browser_close', arguments: {} });
    expect(closed.result?.isError).not.toBe(true);
    expect(sessionCopies(dataDir)).toEqual(copies);

    // A clean exit discards it, exactly like copy mode.
    await session.close();
    sessions.splice(sessions.indexOf(session), 1);
    expect(sessionCopies(dataDir)).toEqual([]);
  });

  it('keeps the copy after a crash, and it is listed as a leftover', async () => {
    const dataDir = createRuntime(tempRoot('session-crash-'));
    seedBaseProfile(dataDir);
    await warmToolCache(dataDir);

    const session = startBroker({ dataDir, isolation: 'session' });
    await initialize(session);
    await effectiveEnvironment(session);
    const copies = sessionCopies(dataDir);
    expect(copies).toHaveLength(1);

    session.kill();
    await session.exited;
    sessions.splice(sessions.indexOf(session), 1);
    // Data is never lost: the tree stays, with the broker's owner marker.
    expect(sessionCopies(dataDir)).toEqual(copies);
    expect(existsSync(path.join(copies[0], '.session-owner.json'))).toBe(true);
  });

  it('reports the copy on every surface and one honest initialize sentence', async () => {
    const dataDir = createRuntime(tempRoot('session-payloads-'));
    const base = seedBaseProfile(dataDir);
    await warmToolCache(dataDir);
    const session = startBroker({ dataDir, isolation: 'session' });
    const handshake = await initialize(session);
    const instructions = handshake.result?.instructions ?? '';
    expect(instructions).toContain('"session"');
    expect(instructions).toContain('identity copy');
    expect(instructions).toContain(base);

    const caps = await capabilities(session);
    expect(caps.profileIsolation).toBe('session');
    const statusPayload = await status(session);
    expect(statusPayload.profileIsolation).toBe('session');
    expect(statusPayload.onLockedSource).toBe('session');
    const listed = await profilesPayload(session, { action: 'list' });
    expect(listed.profileCopySupported).toBe(true);
    const current = listed.current as Record<string, unknown>;
    expect(current.profileCopyPending).toMatchObject({ kind: 'session', baseDir: base });
  });

  it('applies the cloak seat gate exactly as on_locked=copy does', async (t) => {
    const dataDir = createRuntime(tempRoot('session-seat-'));
    const base = seedBaseProfile(dataDir);
    // A warm cache keeps the copy deferred, so the seat is read at take time.
    await warmToolCache(dataDir);
    // A live browser on another profile of the same engine occupies the one seat
    // the free tier allows, so this session must hold rather than copy.
    const other = path.join(dataDir, 'profiles', 'other');
    writeFile(path.join(other, 'lockfile'), '');
    const holder = await holdEngineLock(t, {
      file: path.join(other, 'lockfile'),
      profileDir: other,
      descriptor: manifestProfileLock('cloak'),
    });
    try {
      const session = startBroker({ dataDir, isolation: 'session' });
      await initialize(session);
      const response = await session.request('tools/call', {
        name: 'browser_navigate',
        arguments: { url: 'http://127.0.0.1:9/' },
      });
      expect(response.result?.isError).toBe(true);
      expect(String(response.result?.content?.[0]?.text)).toContain('seat limit');
      // No copy was taken and nothing was started on the base.
      expect(sessionCopies(dataDir)).toEqual([]);
      expect(profile.readProfileLock(base).state).toBe('free');
    } finally {
      await holder.stop();
    }
  });

  it('is engine-neutral: the playwright engine takes the same path', async () => {
    const dataDir = createRuntime(tempRoot('session-playwright-'));
    const base = seedBaseProfile(dataDir, 'playwright');
    const before = hashTree(base);
    await warmToolCache(dataDir, 'playwright');
    const session = startBroker({ dataDir, isolation: 'session', engine: 'playwright' });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.profileIsolation).toBe('session');
    expect(caps.copyContentsSource).toBe('session');
    const pending = await profilesPayload(session);
    expect((pending.current as Record<string, unknown>).profileCopyPending).toMatchObject({
      kind: 'session',
      baseDir: base,
    });
    expect(hashTree(base)).toBe(before);
    expect(profile.readProfileLock(base).state).toBe('free');
  });

  it('refuses an engine that owns its own profile, like the copy modes', async () => {
    const dataDir = createRuntime(tempRoot('session-native-'));
    const session = startBroker({ dataDir, isolation: 'session', engine: 'camoufox-native' });
    await initialize(session);
    const caps = await capabilities(session);
    expect(String(caps.engineError)).toContain('profile_isolation "session" does not apply');
  });
});

describe('first-browser-action profile re-check (2.24.0)', () => {
  it('takes the copy path when the base becomes busy AFTER the session started', async (t) => {
    // The playwright engine, because the cloak seat gate would (correctly) hold
    // instead of copying when the base's own browser is what occupies the one
    // seat; the cloak half of that rule is pinned by the seat test above.
    const dataDir = createRuntime(tempRoot('recheck-busy-'));
    const base = seedBaseProfile(dataDir, 'playwright');
    const before = hashTree(base);
    await warmToolCache(dataDir, 'playwright');

    // The session starts while the base is free, so it owes no copy.
    const session = startBroker({ dataDir, isolation: 'shared', onLocked: 'copy', engine: 'playwright' });
    await initialize(session);
    const startCaps = await capabilities(session);
    expect(startCaps.profileFallback).toBeNull();
    const startProfiles = await profilesPayload(session);
    expect((startProfiles.current as Record<string, unknown>).profileCopyPending).toBeUndefined();

    // Another session's browser opens on the base between our start and our first
    // browser action: exactly the "several agents launch together" case.
    const holder = await holdEngineLock(t, {
      file: path.join(base, 'lockfile'),
      profileDir: base,
      descriptor: manifestProfileLock('playwright'),
    });
    try {
      const environment = await effectiveEnvironment(session);
      const copies = sessionCopies(dataDir, 'playwright');
      expect(copies).toHaveLength(1);
      // The session moved to the copy instead of launching on the busy base.
      expect(environment.profileDir).toBe(copies[0]);
      const caps = await capabilities(session);
      expect(caps.profileFallback).toMatchObject({ from: base, to: copies[0], kind: 'copy' });
      expect(hashTree(base)).toBe(before);
    } finally {
      await holder.stop();
    }
  });

  it('holds on the cloak engine instead of starting a second CloakBrowser', async (t) => {
    // The seat rule is absolute: a base that turns busy on the one-seat engine
    // makes this session wait, never copy-and-run a second browser.
    const dataDir = createRuntime(tempRoot('recheck-cloak-seat-'));
    const base = seedBaseProfile(dataDir);
    await warmToolCache(dataDir);
    const session = startBroker({ dataDir, isolation: 'shared', onLocked: 'copy' });
    await initialize(session);
    const holder = await holdEngineLock(t, {
      file: path.join(base, 'lockfile'),
      profileDir: base,
      descriptor: manifestProfileLock('cloak'),
    });
    try {
      const response = await session.request('tools/call', {
        name: 'browser_navigate',
        arguments: { url: 'http://127.0.0.1:9/' },
      });
      expect(response.result?.isError).toBe(true);
      expect(String(response.result?.content?.[0]?.text)).toContain('seat limit');
      expect(sessionCopies(dataDir)).toEqual([]);
      const caps = await capabilities(session);
      expect(caps.hold).toMatchObject({ state: 'waiting', seat: { seatFree: false } });
    } finally {
      await holder.stop();
    }
  });

  it('is byte-identical on the uncontended path: no new key, no fallback, no copy', async () => {
    const dataDir = createRuntime(tempRoot('recheck-free-'));
    const base = seedBaseProfile(dataDir);
    const before = hashTree(base);
    await warmToolCache(dataDir);

    const session = startBroker({ dataDir, isolation: 'shared', onLocked: 'copy' });
    await initialize(session);
    const environment = await effectiveEnvironment(session);
    expect(environment.profileDir).toBe(base);
    expect(sessionCopies(dataDir)).toEqual([]);
    const caps = await capabilities(session);
    expect(caps.profileFallback).toBeNull();
    expect(caps).not.toHaveProperty('profileCopy');
    expect(hashTree(base)).toBe(before);
  });

  it('holds instead of launching when the policy is block and the base turns busy', async (t) => {
    const dataDir = createRuntime(tempRoot('recheck-block-'));
    const base = seedBaseProfile(dataDir);
    await warmToolCache(dataDir);
    const session = startBroker({ dataDir, isolation: 'shared', onLocked: 'block' });
    await initialize(session);
    const holder = await holdEngineLock(t, {
      file: path.join(base, 'lockfile'),
      profileDir: base,
      descriptor: manifestProfileLock('cloak'),
    });
    try {
      const response = await session.request('tools/call', {
        name: 'browser_navigate',
        arguments: { url: 'http://127.0.0.1:9/' },
      });
      // block has no copy and no sibling: the call is refused, the session stays.
      expect(response.result?.isError).toBe(true);
      expect(sessionCopies(dataDir)).toEqual([]);
    } finally {
      await holder.stop();
    }
  });
});

describe('engine-lock fallback report (2.24.0)', () => {
  it('carries kind and createdEmpty, like the bridge-lock path always has', async (t) => {
    const dataDir = createRuntime(tempRoot('engine-fallback-'));
    // Camoufox never writes the bridge lock, so its fallback can only ever come
    // from the engine-lock pass; that is the path this pins.
    const base = seedBaseProfile(dataDir, 'camoufox');
    writeFile(path.join(base, 'parent.lock'), '');
    const holder = await holdEngineLock(t, {
      file: path.join(base, 'parent.lock'),
      profileDir: base,
      descriptor: manifestProfileLock('camoufox'),
    });
    try {
      const session = startBroker({
        dataDir,
        isolation: 'shared',
        onLocked: 'fallback',
        engine: 'camoufox',
      });
      await initialize(session);
      const caps = await capabilities(session);
      const fallback = caps.profileFallback as Record<string, unknown>;
      expect(fallback).toMatchObject({ from: base, to: `${base}-2`, kind: 'sibling' });
      expect(fallback.createdEmpty).toBe(true);
      expect(String(fallback.reason)).toContain('created empty');
    } finally {
      await holder.stop();
    }
  });

  it('says createdEmpty false when the sibling already exists', async (t) => {
    const dataDir = createRuntime(tempRoot('engine-fallback-existing-'));
    const base = seedBaseProfile(dataDir, 'camoufox');
    writeFile(path.join(base, 'parent.lock'), '');
    writeFile(path.join(`${base}-2`, 'prefs.js'), '// existing sibling');
    const holder = await holdEngineLock(t, {
      file: path.join(base, 'parent.lock'),
      profileDir: base,
      descriptor: manifestProfileLock('camoufox'),
    });
    try {
      const session = startBroker({
        dataDir,
        isolation: 'shared',
        onLocked: 'fallback',
        engine: 'camoufox',
      });
      await initialize(session);
      const caps = await capabilities(session);
      const fallback = caps.profileFallback as Record<string, unknown>;
      expect(fallback).toMatchObject({ to: `${base}-2`, kind: 'sibling', createdEmpty: false });
      expect(String(fallback.reason)).not.toContain('created empty');
    } finally {
      await holder.stop();
    }
  });
});
