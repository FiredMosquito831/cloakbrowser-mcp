import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// profile_isolation=copy (2.12.0). A copy session runs the browser on a
// temporary whole-tree copy of the base profile, holds the base profile's
// bridge-format lock for the session, never writes to the base, and discards the
// copy on a clean shutdown. A hard kill keeps the copy (data is never lost) and
// browser_profiles / scripts/profile-copy.mjs --prune list and remove it.
// This suite pins:
//   - both plugin manifests offer the value and describe it honestly;
//   - the pure resolution (same precedence as shared, no workspace derivation);
//   - session naming, listing and explicit pruning;
//   - the base-lock writer, its format, its stale reclaim and its live refusal;
//   - the broker end to end on a stubbed runtime: copy contents and exclusions,
//     the base left untouched, the lock held, clean-exit deletion, crash
//     retention, live-base refusal for both lock kinds, non-applying engines;
//   - equality for shared/workspace/isolated (no copy keys, unchanged env).
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

interface LockResult {
  profileDir: string;
  path: string;
  state: string;
  owner: { pid: number; createdAt: string | null } | null;
  error: string | null;
}

interface CopyModule {
  PROFILE_ISOLATION_VALUES: string[];
  PROFILE_ISOLATION_COPY: string;
  SESSION_ROOT_DIRNAME: string;
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
  profileCopyNote(baseDir: string, sessionDir: string): string;
  sessionBaseName(baseDir: string): string;
  sessionCopyName(baseDir: string, options?: { pid?: number; now?: Date }): string;
  sessionCopyDir(
    engineId: string,
    dataDir: string,
    baseDir: string,
    options?: { pid?: number; now?: Date },
  ): string;
  sessionRootDir(engineId: string, dataDir: string): string;
  parseSessionCopyName(name: string): {
    name: string;
    baseName: string;
    startedAtLocal: string;
    pid: number;
  } | null;
  listSessionCopies(
    engineId: string,
    dataDir: string,
    options?: { engineLockDescriptor?: object | null; currentDir?: string | null },
  ): { root: string; copies: Record<string, unknown>[]; error?: string };
  pruneSessionCopies(
    engineId: string,
    dataDir: string,
    options?: { engineLockDescriptor?: object | null; currentDir?: string | null; dryRun?: boolean },
  ): {
    root: string;
    removed: { path: string }[];
    kept: { path: string }[];
    failed: { path: string; error: string }[];
  };
  createProfileLock(
    profileDir: string,
    options?: { pid?: number; now?: Date },
  ): {
    ok: boolean;
    path: string;
    owner: { pid: number; createdAt: string; userDataDir: string };
    identity: unknown;
    reclaimed: boolean;
    error: string | null;
  };
  releaseProfileLock(handle: unknown): { released: boolean; error: string | null };
  readProfileLock(profileDir: string): LockResult;
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
  account?: string;
  profileDir?: string;
  engine?: string;
  pluginDir?: string;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const brokerPath = path.join(pluginDir, 'broker.mjs');
const profileModulePath = new URL('../../plugins/cloakbrowser/lib/profile.mjs', import.meta.url);
const profile = (await import(profileModulePath.href)) as unknown as CopyModule;
const copyScriptPath = path.join(pluginDir, 'scripts', 'profile-copy.mjs');

const STUB_TOOLS = ['browser_navigate', 'browser_snapshot'];

const STUB_SOURCE = `#!/usr/bin/env node
const readline = require('node:readline');
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-copy', version: '0.0.0' } } });
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
const holders: { pid: number; stop: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const holder of holders.splice(0)) {
    await holder.stop();
  }
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
    'PLAYWRIGHT_MCP_USER_DATA_DIR',
    'PLAYWRIGHT_MCP_ISOLATED',
    'PLAYWRIGHT_MCP_PROXY_SERVER',
  ]) {
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
): Promise<{ profileDir: string | null; isolated: string | null; proxy: string | null }> {
  const response = await session.request('tools/call', {
    name: 'browser_navigate',
    arguments: { url: 'http://127.0.0.1:9/' },
  });
  const text = response.result?.content?.[0]?.text ?? '{}';
  return JSON.parse(text) as { profileDir: string | null; isolated: string | null; proxy: string | null };
}

function toolNames(response: JsonRpcResponse): string[] {
  return (response.result?.tools ?? []).map((tool) => tool.name).sort();
}

function engineErrorText(payload: Record<string, unknown>): string {
  return typeof payload.engineError === 'string' ? payload.engineError : '';
}

function baseProfileDir(dataDir: string, engine = 'cloak', name = 'default'): string {
  return engine === 'cloak' || engine === 'playwright'
    ? path.join(dataDir, 'profiles', name)
    : path.join(dataDir, 'profiles', engine, name);
}

// A base profile with identity files, every excluded class, a database WAL/SHM
// companion and a stale bridge lock.
function seedBaseProfile(dataDir: string, engine = 'cloak', name = 'default'): string {
  const base = baseProfileDir(dataDir, engine, name);
  writeFile(path.join(base, '.cloakbrowser-seed'), '12345\n');
  writeFile(path.join(base, 'Local State'), '{"os_crypt":{"encrypted_key":"DPAPI-TEST"}}');
  writeFile(path.join(base, 'Default', 'Network', 'Cookies'), 'COOKIE-BASE');
  writeFile(path.join(base, 'Default', 'Network', 'Cookies-journal'), '');
  writeFile(path.join(base, 'Default', 'Network', 'Cookies-wal'), 'WAL-DATA');
  writeFile(path.join(base, 'Default', 'Network', 'Cookies-shm'), 'SHM-DATA');
  writeFile(path.join(base, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'LOCALSTORAGE');
  writeFile(path.join(base, 'Default', 'Preferences'), '{"profile":{}}');
  writeFile(path.join(base, 'Default', 'History'), 'HISTORY');
  writeFile(path.join(base, 'Cache', 'data_0'), 'CACHE');
  writeFile(path.join(base, 'Default', 'DawnGraphiteCache', 'data'), 'DAWN');
  writeFile(path.join(base, 'BrowserMetrics', 'metrics.pma'), 'METRICS');
  writeFile(path.join(base, 'Default', 'thumbnails', 'thumb.png'), 'THUMB');
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

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function deadPid(): number {
  const result = spawnSync(process.execPath, ['--version'], { windowsHide: true });
  const pid = result.pid;
  if (pid === undefined) {
    throw new Error('could not obtain an exited pid');
  }
  return pid;
}

// Hold a file like the browser holds its lock. Chromium's lockfile is shared for
// readers and exclusive for writers (share "Read"); Firefox's parent.lock refuses
// readers too (share "None"). A real process with one Windows handle, started and
// stopped by exact pid.
async function holdExclusiveForRead(
  file: string,
  share: 'Read' | 'None' = 'Read',
): Promise<{ pid: number; stop: () => Promise<void> }> {
  const script =
    `$f=[System.IO.File]::Open('${file.replaceAll("'", "''")}','Open','ReadWrite','${share}');` +
    'Write-Output held; Start-Sleep -Seconds 120';
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
        let stopped = false;
        const stop = async () => {
          if (stopped) {
            return;
          }
          stopped = true;
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
        };
        const holder = { pid, stop };
        holders.push(holder);
        return holder;
      }
      throw error;
    }
  }
  child.kill();
  throw new Error('the file holder never took the lock');
}

function runPrune(
  dataDir: string,
  args: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [copyScriptPath, '--prune', '--data-dir', dataDir, '--json', ...args],
    { encoding: 'utf8', windowsHide: true },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('copy as a profile_isolation value', () => {
  it('is offered by both plugin manifests with honest help text', () => {
    for (const name of ['cloakbrowser', 'camoufox']) {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'),
      ) as { userConfig: { profile_isolation: { options: string[]; description: string } } };
      const setting = manifest.userConfig.profile_isolation;
      expect(setting.options).toEqual(['shared', 'workspace', 'isolated', 'copy']);
      expect(setting.description).toContain('temporary copy');
      expect(setting.description).toContain('discarded');
      expect(setting.description).toContain('does not combine with workspace');
      expect(setting.description).toContain('scripts/profile-copy.mjs --prune');
      expect(setting.description.toLowerCase()).not.toContain('in memory');
    }
    expect(profile.PROFILE_ISOLATION_VALUES).toEqual(['shared', 'workspace', 'isolated', 'copy']);
    expect(profile.PROFILE_ISOLATION_COPY).toBe('copy');
    expect(profile.SESSION_ROOT_DIRNAME).toBe('.sessions');
  });

  it('is accepted by resolveProfileIsolation and is not a default value', () => {
    expect(profile.resolveProfileIsolation('copy')).toEqual({
      mode: 'copy',
      source: 'setting',
      ignored: null,
      placeholder: null,
    });
    expect(profile.resolveProfileIsolation('  copy  ').mode).toBe('copy');
    expect(profile.resolveProfileIsolation('${user_config.profile_isolation}').mode).toBe('shared');
    expect(profile.resolveProfileIsolation('copyish').mode).toBe('shared');
  });
});

describe('copy resolution', () => {
  const dataDir = path.resolve('D:/scratch/copy-resolution-data');
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
      const copy = profile.resolveProfile({ ...options, ...input, isolation: 'copy' });
      const shared = profile.resolveProfile({ ...options, ...input, isolation: 'shared' });
      expect(copy).toEqual(shared);
      expect(copy.profileSource).not.toBe('workspace');
    }
    expect(profile.resolveProfile({ ...options, isolation: 'copy' }).profileSource).toBe('default');
    expect(profile.resolveProfile({ ...options, isolation: 'copy' }).profileDir).toBeNull();
  });

  it('never derives a workspace profile, unlike workspace', () => {
    const copy = profile.resolveProfile({ ...options, isolation: 'copy', cwd: 'D:/a' });
    const workspace = profile.resolveProfile({ ...options, isolation: 'workspace', cwd: 'D:/a' });
    expect(copy.profileSource).toBe('default');
    expect(workspace.profileSource).toBe('workspace');
    expect(copy.profileDir).not.toBe(workspace.profileDir);
  });

  it('keeps the shared account-name error', () => {
    const copy = profile.resolveProfile({ ...options, isolation: 'copy', account: '../x' });
    expect(copy.error).toBe(
      profile.resolveProfile({ ...options, isolation: 'shared', account: '../x' }).error,
    );
    expect(copy.error).toContain('Invalid account name');
  });

  it('states where the session runs and that changes are discarded', () => {
    const note = profile.profileCopyNote(
      'D:/data/profiles/default',
      'D:/data/profiles/cloak/.sessions/default-x',
    );
    expect(note).toBe(
      'Profile isolation is "copy": this session runs on a temporary copy of D:/data/profiles/default at ' +
        'D:/data/profiles/cloak/.sessions/default-x, the base profile is locked and never written, and the copy ' +
        'is discarded when the session ends cleanly.',
    );
  });
});

describe('session copy names and listing', () => {
  const dataDir = path.resolve('D:/scratch/copy-sessions-data');
  const now = new Date(2026, 9, 26, 15, 30, 5); // local time, month is 0-based

  it('derives a collision-free, path-safe name from the base', () => {
    expect(profile.sessionBaseName('D:/data/profiles/default')).toBe('default');
    expect(profile.sessionBaseName('D:/data/profiles/cloak/alice')).toBe('alice');
    expect(profile.sessionBaseName('D:/profiles/my profile!')).toBe('my-profile');
    expect(profile.sessionBaseName('D:/profiles/...')).toBe('profile');
    const name = profile.sessionCopyName('D:/data/profiles/default', { pid: 4321, now });
    expect(name).toBe('default-20261026-153005-4321');
    expect(profile.parseSessionCopyName(name)).toEqual({
      name,
      baseName: 'default',
      startedAtLocal: '20261026-153005',
      pid: 4321,
    });
    expect(profile.sessionCopyDir('cloak', dataDir, 'D:/data/profiles/default', { pid: 4321, now })).toBe(
      path.join(dataDir, 'profiles', 'cloak', '.sessions', name),
    );
    expect(profile.sessionRootDir('cloak', dataDir)).toBe(
      path.join(dataDir, 'profiles', 'cloak', '.sessions'),
    );
  });

  it('ignores names it did not create', () => {
    for (const name of [
      'default',
      '.sessions',
      'default-20261026-153005',
      'default-20261026-153005-0',
      'default-20261326-153005-10',
      'default-20261026-153005-abc',
      'default-20261026-250005-10',
    ]) {
      expect(profile.parseSessionCopyName(name)).toBeNull();
    }
  });

  it('lists leftover, active and current copies and prunes only leftovers', () => {
    const root = tempRoot('copy-sessions-');
    const sessionsRoot = path.join(root, 'profiles', 'cloak', '.sessions');
    const leftover = path.join(sessionsRoot, 'default-20260101-010101-100');
    const active = path.join(sessionsRoot, 'default-20260101-010102-101');
    const current = path.join(sessionsRoot, 'default-20260101-010103-102');
    for (const dir of [leftover, active, current]) {
      writeFile(path.join(dir, 'Default', 'Network', 'Cookies'), 'c');
    }
    // "active" holds a bridge lock naming this live test process.
    writeJson(path.join(active, '.cloakbrowser-mcp-profile.lock'), {
      pid: process.pid,
      createdAt: '2026-01-01T00:00:00.000Z',
      userDataDir: active,
    });
    // A name the plugin did not create is not listed.
    writeFile(path.join(sessionsRoot, 'not-a-session', 'x'), 'x');

    const listed = profile.listSessionCopies('cloak', root, { currentDir: current });
    expect(listed.root).toBe(sessionsRoot);
    expect(listed.copies.map((copy) => [path.basename(String(copy.path)), copy.state])).toEqual([
      ['default-20260101-010101-100', 'leftover'],
      ['default-20260101-010102-101', 'active'],
      ['default-20260101-010103-102', 'current'],
    ]);
    expect(existsSync(leftover)).toBe(true);

    const dry = profile.pruneSessionCopies('cloak', root, { currentDir: current, dryRun: true });
    expect(dry.removed.map((copy) => copy.path)).toEqual([leftover]);
    expect(dry.kept.map((copy) => copy.path)).toEqual([active, current]);
    expect(existsSync(leftover)).toBe(true);

    const pruned = profile.pruneSessionCopies('cloak', root, { currentDir: current });
    expect(pruned.removed.map((copy) => copy.path)).toEqual([leftover]);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(current)).toBe(true);
    expect(existsSync(path.join(sessionsRoot, 'not-a-session'))).toBe(true);
  });

  it('keeps a copy whose owner marker names a live process, and prunes a dead one', () => {
    const root = tempRoot('copy-owner-');
    const sessionsRoot = path.join(root, 'profiles', 'cloak', '.sessions');
    const live = path.join(sessionsRoot, 'default-20260101-010101-400');
    const dead = path.join(sessionsRoot, 'default-20260101-010102-401');
    for (const dir of [live, dead]) {
      writeFile(path.join(dir, 'x'), 'x');
    }
    writeJson(path.join(live, '.session-owner.json'), {
      pid: process.pid,
      createdAt: '2026-01-01T00:00:00.000Z',
      baseDir: 'b',
    });
    writeJson(path.join(dead, '.session-owner.json'), {
      pid: deadPid(),
      createdAt: '2026-01-01T00:00:00.000Z',
      baseDir: 'b',
    });
    const listed = profile.listSessionCopies('cloak', root);
    expect(listed.copies.map((copy) => [path.basename(String(copy.path)), copy.state])).toEqual([
      ['default-20260101-010101-400', 'active'],
      ['default-20260101-010102-401', 'leftover'],
    ]);
    const pruned = profile.pruneSessionCopies('cloak', root);
    expect(pruned.removed.map((copy) => copy.path)).toEqual([dead]);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(dead)).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('keeps a copy whose engine lock is held live', async () => {
    const root = tempRoot('copy-active-engine-');
    const sessionsRoot = path.join(root, 'profiles', 'cloak', '.sessions');
    const active = path.join(sessionsRoot, 'default-20260101-010101-200');
    writeFile(path.join(active, 'Default', 'Network', 'Cookies'), 'c');
    writeFile(path.join(active, 'lockfile'), '');
    const holder = await holdExclusiveForRead(path.join(active, 'lockfile'), 'Read');
    try {
      const listed = profile.listSessionCopies('cloak', root, {
        engineLockDescriptor: { file: 'lockfile', owner: 'exclusive-open-write' },
      });
      expect(listed.copies.map((copy) => copy.state)).toEqual(['active']);
      const pruned = profile.pruneSessionCopies('cloak', root, {
        engineLockDescriptor: { file: 'lockfile', owner: 'exclusive-open-write' },
      });
      expect(pruned.removed).toEqual([]);
      expect(existsSync(active)).toBe(true);
    } finally {
      await holder.stop();
    }
  });
});

describe('base profile lock writer', () => {
  it('writes the bridge lock format and reads back as live for this process', () => {
    const root = tempRoot('copy-lock-');
    const base = path.join(root, 'profiles', 'default');
    mkdirSync(base, { recursive: true });
    const held = profile.createProfileLock(base);
    expect(held.ok).toBe(true);
    expect(held.reclaimed).toBe(false);
    const onDisk = JSON.parse(readFileSync(profile.profileLockPath(base), 'utf8')) as {
      pid: number;
      createdAt: string;
      userDataDir: string;
    };
    expect(onDisk.pid).toBe(process.pid);
    expect(typeof onDisk.createdAt).toBe('string');
    expect(path.resolve(onDisk.userDataDir)).toBe(path.resolve(base));
    const read = profile.readProfileLock(base);
    expect(read.state).toBe('live');
    expect(read.owner?.pid).toBe(process.pid);
    const released = profile.releaseProfileLock(held);
    expect(released.released).toBe(true);
    expect(existsSync(profile.profileLockPath(base))).toBe(false);
  });

  it('reclaims a lock naming a dead process and refuses a live one', () => {
    const root = tempRoot('copy-lock-reclaim-');
    const base = path.join(root, 'profiles', 'default');
    mkdirSync(base, { recursive: true });
    const dead = deadPid();
    writeJson(profile.profileLockPath(base), {
      pid: dead,
      createdAt: '2026-01-01T00:00:00.000Z',
      userDataDir: base,
    });
    expect(profile.readProfileLock(base).state).toBe('stale');
    const reclaimed = profile.createProfileLock(base);
    expect(reclaimed.ok).toBe(true);
    expect(reclaimed.reclaimed).toBe(true);
    expect(profile.readProfileLock(base).owner?.pid ?? null).toBe(process.pid);
    profile.releaseProfileLock(reclaimed);

    writeJson(profile.profileLockPath(base), {
      pid: process.pid,
      createdAt: '2026-01-01T00:00:00.000Z',
      userDataDir: base,
    });
    const refused = profile.createProfileLock(base);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(`live pid ${process.pid}`);
  });

  it('refuses an unreadable lock instead of overwriting it', () => {
    const root = tempRoot('copy-lock-invalid-');
    const base = path.join(root, 'profiles', 'default');
    mkdirSync(base, { recursive: true });
    writeFile(profile.profileLockPath(base), 'not json');
    const refused = profile.createProfileLock(base);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('not valid JSON');
    expect(readFileSync(profile.profileLockPath(base), 'utf8')).toBe('not json');
  });

  it('releases only the file this session created', () => {
    const root = tempRoot('copy-lock-identity-');
    const base = path.join(root, 'profiles', 'default');
    mkdirSync(base, { recursive: true });
    const held = profile.createProfileLock(base);
    // A different writer replaces the lock (new inode).
    writeJson(profile.profileLockPath(base), {
      pid: process.pid,
      createdAt: '2026-01-02T00:00:00.000Z',
      userDataDir: base,
    });
    const released = profile.releaseProfileLock(held);
    expect(released.released).toBe(false);
    expect(released.error).toContain('no longer the file this session created');
    expect(existsSync(profile.profileLockPath(base))).toBe(true);
  });
});

describe('broker copy mode', () => {
  it('runs on a session copy, holds the base lock and discards on a clean shutdown', async () => {
    const dataDir = tempRoot('copy-broker-clean-');
    createRuntime(dataDir);
    const base = seedBaseProfile(dataDir);
    const staleLockPath = profile.profileLockPath(base);
    writeJson(staleLockPath, { pid: deadPid(), createdAt: '2026-01-01T00:00:00.000Z', userDataDir: base });
    writeFile(path.join(base, 'lockfile'), '');
    const baseHashBefore = hashTree(base);
    const baseFilesBefore = listFiles(base);

    const session = startBroker({ dataDir, isolation: 'copy' });
    const initialized = await initialize(session);
    expect(initialized.result?.instructions).toContain('Profile isolation is "copy"');
    const tools = toolNames(await session.request('tools/list', {}));
    expect(tools).toContain('browser_capabilities');
    const env = await effectiveEnvironment(session);
    if (env.profileDir === null) {
      throw new Error('the copy start reported no user-data-dir');
    }
    const sessionDir = path.resolve(env.profileDir);
    expect(path.dirname(sessionDir)).toBe(path.join(dataDir, 'profiles', 'cloak', '.sessions'));
    expect(path.basename(sessionDir)).toMatch(/^default-\d{8}-\d{6}-\d+$/);
    expect(env.isolated).toBeNull();
    expect(existsSync(sessionDir)).toBe(true);

    // The base lock is held by this broker and the base's stale one is gone.
    const heldLock = profile.readProfileLock(base);
    expect(heldLock.state).toBe('live');
    expect(heldLock.owner?.pid).toBe(session.pid);

    // The copy carries identity files, keeps WAL/SHM and excludes every class.
    const copied = listFiles(sessionDir);
    for (const kept of [
      '.cloakbrowser-seed',
      'Local State',
      'Default/Network/Cookies',
      'Default/Network/Cookies-journal',
      'Default/Network/Cookies-wal',
      'Default/Network/Cookies-shm',
      'Default/Local Storage/leveldb/000003.log',
      'Default/Preferences',
      'Default/History',
    ]) {
      expect(copied).toContain(kept);
    }
    for (const name of copied) {
      const lower = path.basename(name).toLowerCase();
      expect(lower).not.toBe('.cloakbrowser-mcp-profile.lock');
      expect(lower).not.toBe('lockfile');
      expect(name.startsWith('Cache/')).toBe(false);
      expect(name.startsWith('BrowserMetrics/')).toBe(false);
      expect(name.startsWith('Default/DawnGraphiteCache/')).toBe(false);
      expect(name.startsWith('Default/thumbnails/')).toBe(false);
      expect(name.startsWith('logs/')).toBe(false);
      expect(lower.endsWith('.tmp')).toBe(false);
    }
    expect(readFileSync(path.join(sessionDir, '.cloakbrowser-seed'), 'utf8')).toBe('12345\n');
    expect(readFileSync(path.join(sessionDir, 'Default', 'Network', 'Cookies-wal'), 'utf8')).toBe('WAL-DATA');

    // The base is unchanged while the session runs (lock files aside).
    expect(hashTree(base)).toBe(baseHashBefore);
    expect(listFiles(base).sort()).toEqual(baseFilesBefore.sort());

    // Reporting: capabilities, status and browser_profiles all name the copy.
    const caps = await capabilities(session);
    expect(caps.profileIsolation).toBe('copy');
    expect(caps.profileDir).toBe(sessionDir);
    expect(caps.profileCopy).toMatchObject({
      baseDir: base,
      sessionDir,
      baseCreated: false,
      baseLock: { state: 'live', heldByThisSession: true },
    });
    expect(String(caps.profileCopyNote)).toContain('discarded');
    const statusPayload = await status(session);
    expect(statusPayload.profileIsolation).toBe('copy');
    expect(statusPayload.profileCopy).toMatchObject({ baseDir: base, sessionDir });
    const profiles = await profilesPayload(session);
    expect(profiles.current).toMatchObject({ profileIsolation: 'copy', profileDir: sessionDir });
    const sessionCopies = profiles.sessionCopies as {
      currentDir: string;
      copies: { name: string; state: string }[];
    };
    expect(sessionCopies.currentDir).toBe(sessionDir);
    expect(sessionCopies.copies.some((copy) => copy.state === 'current')).toBe(true);
    const available = profiles.availableProfiles as { names: string[] };
    expect(available.names).not.toContain('.sessions');

    // A clean shutdown deletes the copy and releases the base lock.
    await session.close();
    expect(await waitFor(() => !existsSync(sessionDir))).toBe(true);
    expect(existsSync(profile.profileLockPath(base))).toBe(false);
    expect(hashTree(base)).toBe(baseHashBefore);
    expect(session.stderr()).toContain('discarded session copy');
  });

  it('holds the base so a concurrent shared start is refused, and releases it on exit', async () => {
    const dataDir = tempRoot('copy-broker-concurrent-');
    createRuntime(dataDir);
    const base = seedBaseProfile(dataDir);
    const baseHashBefore = hashTree(base);

    const copy = startBroker({ dataDir, isolation: 'copy' });
    await initialize(copy);
    const copyEnv = await effectiveEnvironment(copy);
    expect(copyEnv.profileDir).not.toBeNull();
    expect(profile.readProfileLock(base).owner?.pid).toBe(copy.pid);

    // A second, shared window on the same data dir is refused by the base lock
    // this session holds; it names the copy broker and copies nothing.
    const shared = startBroker({ dataDir, isolation: 'shared' });
    await initialize(shared);
    const sharedCaps = await capabilities(shared);
    const error = engineErrorText(sharedCaps);
    expect(error).toContain(`already in use by pid ${copy.pid}`);
    expect(error).toContain('The backend was not started.');
    expect(toolNames(await shared.request('tools/list', {}))).toEqual([
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    expect(hashTree(base)).toBe(baseHashBefore);
    await shared.close();

    // The copy session is unaffected and still reports itself.
    const copyCaps = await capabilities(copy);
    expect(copyCaps.profileCopy).toMatchObject({ baseDir: base, baseLock: { heldByThisSession: true } });
    await copy.close();
    expect(await waitFor(() => !existsSync(profile.profileLockPath(base)))).toBe(true);

    // With the copy gone, a shared window starts on the base again.
    const later = startBroker({ dataDir, isolation: 'shared' });
    await initialize(later);
    const laterEnv = await effectiveEnvironment(later);
    expect(laterEnv.profileDir).toBe(base);
    await later.close();
    expect(hashTree(base)).toBe(baseHashBefore);
  });

  it('keeps the copy and its stale base lock after a hard kill, lists it and prunes it', async () => {
    const dataDir = tempRoot('copy-broker-crash-');
    createRuntime(dataDir);
    const base = seedBaseProfile(dataDir);
    const baseHashBefore = hashTree(base);

    const session = startBroker({ dataDir, isolation: 'copy' });
    await initialize(session);
    const env = await effectiveEnvironment(session);
    if (env.profileDir === null) {
      throw new Error('the copy start reported no user-data-dir');
    }
    const sessionDir = path.resolve(env.profileDir);
    session.kill();
    const exitCode = await session.exited;
    expect(exitCode === null || exitCode !== 0).toBe(true);
    expect(existsSync(sessionDir)).toBe(true);

    // The base lock survives with a dead pid and is reported as stale.
    const stale = profile.readProfileLock(base);
    expect(stale.state).toBe('stale');
    expect(stale.owner?.pid).toBe(session.pid);
    expect(hashTree(base)).toBe(baseHashBefore);

    // A later broker (even in shared mode) lists the leftover copy.
    const shared = startBroker({ dataDir, isolation: 'shared' });
    await initialize(shared);
    const profiles = await profilesPayload(shared);
    const listed = profiles.sessionCopies as {
      copies: { name: string; path: string; state: string }[];
    };
    const leftover = listed.copies.find((copy) => path.resolve(copy.path) === sessionDir);
    expect(leftover).toBeDefined();
    expect(leftover?.state).toBe('leftover');
    expect(hashTree(base)).toBe(baseHashBefore);
    await shared.close();

    // A dry-run prune reports it without removing anything; the real prune
    // removes exactly it, and the base profile is untouched.
    const dry = runPrune(dataDir, ['--dry-run']);
    expect(dry.status).toBe(0);
    const dryPayload = JSON.parse(dry.stdout) as { dryRun: boolean; removed: { path: string }[] };
    expect(dryPayload.dryRun).toBe(true);
    expect(dryPayload.removed.map((copy) => path.resolve(copy.path))).toEqual([sessionDir]);
    expect(existsSync(sessionDir)).toBe(true);

    const pruned = runPrune(dataDir);
    expect(pruned.status).toBe(0);
    const prunedPayload = JSON.parse(pruned.stdout) as {
      removed: { path: string }[];
      kept: { path: string }[];
    };
    expect(prunedPayload.removed.map((copy) => path.resolve(copy.path))).toEqual([sessionDir]);
    expect(prunedPayload.kept).toEqual([]);
    expect(existsSync(sessionDir)).toBe(false);
    expect(hashTree(base)).toBe(baseHashBefore);
    // The stale base lock is left in place (the tool never edits a profile) and
    // the next start reclaims it by pid liveness.
    expect(profile.readProfileLock(base).state).toBe('stale');
  });

  it('refuses a live bridge lock loudly and copies nothing', async () => {
    const dataDir = tempRoot('copy-broker-lived-bridge-');
    createRuntime(dataDir);
    const base = seedBaseProfile(dataDir);
    writeJson(profile.profileLockPath(base), {
      pid: process.pid,
      createdAt: '2026-01-01T00:00:00.000Z',
      userDataDir: base,
    });
    const baseHashBefore = hashTree(base);
    const session = startBroker({ dataDir, isolation: 'copy' });
    const initialized = await initialize(session);
    const caps = await capabilities(session);
    const error = engineErrorText(caps);
    expect(error).toContain(`already in use by pid ${process.pid}`);
    expect(error).toContain('Profile isolation is "copy", so the base profile was not copied.');
    expect(error).toContain('The backend was not started.');
    expect(String(initialized.result?.instructions)).toContain('backend is unavailable');
    expect(toolNames(await session.request('tools/list', {}))).toEqual([
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    expect(existsSync(path.join(dataDir, 'profiles', 'cloak', '.sessions'))).toBe(false);
    expect(hashTree(base)).toBe(baseHashBefore);
    expect(profile.readProfileLock(base).owner?.pid).toBe(process.pid);
    await session.close();
  });

  it.skipIf(process.platform !== 'win32')(
    'refuses a live Chromium engine lock loudly and copies nothing',
    async () => {
      const dataDir = tempRoot('copy-broker-lived-engine-');
      createRuntime(dataDir);
      const base = seedBaseProfile(dataDir);
      const holder = await holdExclusiveForRead(path.join(base, 'lockfile'), 'Read');
      try {
        const session = startBroker({ dataDir, isolation: 'copy' });
        await initialize(session);
        const caps = await capabilities(session);
        const error = engineErrorText(caps);
        expect(error).toContain('another process holds the engine lock file');
        expect(error).toContain('Profile isolation is "copy", so the base profile was not copied.');
        expect(existsSync(path.join(dataDir, 'profiles', 'cloak', '.sessions'))).toBe(false);
        await session.close();
      } finally {
        await holder.stop();
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'refuses a live Camoufox parent.lock loudly and copies nothing',
    async () => {
      const dataDir = tempRoot('copy-broker-lived-camoufox-');
      const base = baseProfileDir(dataDir, 'camoufox');
      writeFile(path.join(base, '.cloakbrowser-seed'), '99999\n');
      writeFile(path.join(base, 'parent.lock'), '');
      const holder = await holdExclusiveForRead(path.join(base, 'parent.lock'), 'None');
      try {
        const session = startBroker({ dataDir, isolation: 'copy', engine: 'camoufox' });
        await initialize(session);
        const caps = await capabilities(session);
        const error = engineErrorText(caps);
        expect(error).toContain('another process holds the engine lock file');
        expect(error).toContain('parent.lock');
        expect(error).toContain('Profile isolation is "copy"');
        expect(existsSync(path.join(dataDir, 'profiles', 'camoufox', '.sessions'))).toBe(false);
        await session.close();
      } finally {
        await holder.stop();
      }
    },
  );

  it('refuses copy mode on an engine that owns its profile', async () => {
    const dataDir = tempRoot('copy-broker-native-');
    const session = startBroker({ dataDir, isolation: 'copy', engine: 'camoufox-native' });
    const initialized = await initialize(session);
    const caps = await capabilities(session);
    expect(caps.profileIsolation).toBe('copy');
    expect(caps.profileApplies).toBe(false);
    expect(caps.profileCopySupported).toBe(false);
    expect(String(caps.profileCopyNote)).toContain('does not apply');
    expect(engineErrorText(caps)).toContain('does not apply to it');
    expect(String(initialized.result?.instructions)).toContain('backend is unavailable');
    expect(toolNames(await session.request('tools/list', {}))).toEqual([
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    expect(existsSync(path.join(dataDir, 'profiles'))).toBe(false);
    await session.close();
  });

  it('prefers profile_dir, account and the pointer as the base', async () => {
    const dataDir = tempRoot('copy-broker-base-');
    createRuntime(dataDir);
    const accountBase = path.join(dataDir, 'profiles', 'cloak', 'alice');
    writeFile(path.join(accountBase, 'marker'), 'alice');
    const session = startBroker({ dataDir, isolation: 'copy', account: 'alice' });
    await initialize(session);
    const caps = await capabilities(session);
    expect(caps.profileSource).toBe('account');
    expect((caps.profileCopy as { baseDir: string }).baseDir).toBe(accountBase);
    expect((caps.profileDir as string).startsWith(path.join(dataDir, 'profiles', 'cloak', '.sessions'))).toBe(
      true,
    );
    await session.close();
  });

  it('creates a missing base profile empty and reports it', async () => {
    const dataDir = tempRoot('copy-broker-missing-base-');
    createRuntime(dataDir);
    const session = startBroker({ dataDir, isolation: 'copy' });
    await initialize(session);
    const caps = await capabilities(session);
    const base = path.join(dataDir, 'profiles', 'default');
    expect(existsSync(base)).toBe(true);
    expect(caps.profileCopy).toMatchObject({ baseDir: base, baseCreated: true });
    await session.close();
  });

  it('leaves shared, workspace and isolated payloads without copy keys', async () => {
    for (const isolation of ['shared', 'workspace', 'isolated']) {
      const dataDir = tempRoot(`copy-broker-eq-${isolation}-`);
      createRuntime(dataDir);
      const session = startBroker({ dataDir, isolation });
      await initialize(session);
      const caps = await capabilities(session);
      expect(caps.profileIsolation).toBe(isolation);
      expect(Object.hasOwn(caps, 'profileCopy')).toBe(false);
      expect(Object.hasOwn(caps, 'profileCopyNote')).toBe(false);
      expect(Object.hasOwn(caps, 'profileCopySupported')).toBe(false);
      expect(Object.hasOwn(caps, 'sessionCopies')).toBe(false);
      const statusPayload = await status(session);
      expect(Object.hasOwn(statusPayload, 'profileCopy')).toBe(false);
      expect(Object.hasOwn(statusPayload, 'sessionCopies')).toBe(false);
      const profiles = await profilesPayload(session);
      expect(Object.hasOwn(profiles, 'sessionCopies')).toBe(false);
      expect(Object.hasOwn(profiles, 'profileCopyNote')).toBe(false);
      const env = await effectiveEnvironment(session);
      const sharedDefault = path.join(dataDir, 'profiles', 'default');
      expect(env.profileDir === sharedDefault).toBe(isolation === 'shared');
      expect(env.isolated).toBe(isolation === 'isolated' ? 'true' : null);
      expect(env.profileDir === null).toBe(isolation === 'isolated');
      await session.close();
    }
  });

  it('keeps --prune explicit: a plain copy run never touches session copies', () => {
    const dataDir = tempRoot('copy-prune-explicit-');
    const sessionsRoot = path.join(dataDir, 'profiles', 'cloak', '.sessions');
    const leftover = path.join(sessionsRoot, 'default-20260101-010101-300');
    writeFile(path.join(leftover, 'x'), 'x');
    // A plain copy invocation (no --prune) neither lists nor removes sessions.
    const result = spawnSync(process.execPath, [copyScriptPath, '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--prune');
    expect(existsSync(leftover)).toBe(true);
  });
});
