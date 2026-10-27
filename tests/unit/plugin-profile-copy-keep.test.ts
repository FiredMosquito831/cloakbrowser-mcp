import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// profile_isolation=copy-keep (2.13.0). Same session as "copy" plus a whole-tree
// swap on a clean close: the base becomes <base>.previous-<stamp> (retained) and
// the session copy takes the base path. A hard kill performs no swap. Previous
// trees are user data: listed (bounded), never pruned. The mode is refused when
// the base is outside the plugin data root. This suite pins:
//   - both plugin manifests offer the value and describe it honestly;
//   - the pure resolution/names/listing and the swap (success, second-rename
//     failure restore, first-rename failure, collision suffix);
//   - the broker end to end on a stubbed runtime: clean-close swap, base lock
//     handoff, hard-kill retention, outside-root refusal, native refusal,
//     bounded live-lock timeout, --prune leaving previous trees alone;
//   - equality for shared/workspace/isolated/copy (no new keys).
interface CopyKeepModule {
  PROFILE_ISOLATION_VALUES: string[];
  PROFILE_ISOLATION_COPY: string;
  PROFILE_ISOLATION_COPY_KEEP: string;
  PROFILE_ISOLATION_COPY_VALUES: string[];
  isCopyIsolation(value: string): boolean;
  resolveProfileIsolation(value: string): { mode: string };
  resolveProfile(options: Record<string, unknown>): {
    profileDir: string | null;
    profileSource: string | null;
    error: string | null;
  };
  profileCopyKeepNote(baseDir: string, sessionDir: string): string;
  profileCopyNotApplicableNote(mode: string): string;
  sessionBaseName(baseDir: string): string;
  previousTreeName(baseDir: string, options?: { now?: Date; suffix?: number }): string;
  previousTreeDir(baseDir: string, options?: { now?: Date; suffix?: number }): string;
  selectPreviousTreeDir(
    baseDir: string,
    options?: { now?: Date; exists?: (candidate: string) => boolean },
  ): string | null;
  parsePreviousTreeName(name: string): {
    name: string;
    baseName: string;
    timestamp: string;
    suffix: number;
  } | null;
  listPreviousTrees(
    baseDir: string,
    options?: { limit?: number },
  ): {
    root: string;
    baseName: string;
    trees: { name: string; path: string; timestamp: string; suffix: number }[];
    count: number;
    truncated: boolean;
    error?: string;
  };
  swapSessionCopyIntoBase(options: {
    baseDir: string;
    sessionDir: string;
    now?: Date;
    exists?: (candidate: string) => boolean;
    rename?: (from: string, to: string) => void;
    retryMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => void;
    clock?: () => number;
  }): {
    ok: boolean;
    baseDir: string;
    sessionDir: string;
    previousDir: string | null;
    retainedPreviousDir?: string;
    restored: boolean;
    retriedMs: number;
    error: string | null;
  };
  sessionCopyHasLiveLock(
    sessionDir: string,
    options?: { engineLockDescriptor?: object | null },
  ): { live: boolean };
  isPathInsideRoot(candidate: string, root: string): boolean;
  swapRecordPath(engineId: string, dataDir: string): string;
  readSwapRecord(engineId: string, dataDir: string): Record<string, unknown> | null;
  writeSwapRecord(
    engineId: string,
    dataDir: string,
    record: Record<string, unknown>,
  ): {
    written: boolean;
    error: string | null;
  };
  readProfileLock(profileDir: string): { state: string; owner: { pid: number } | null };
  profileLockPath(profileDir: string): string;
  COPY_KEEP_LOCK_WAIT_MS: number;
  SWAP_RECORD_FILENAME: string;
  PREVIOUS_TREE_LIST_LIMIT: number;
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
  pid: number | null;
  request: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<JsonRpcResponse>;
  stderr: () => string;
  endInput: () => void;
  close: () => Promise<void>;
  kill: () => void;
  exited: Promise<number | null>;
}

interface BrokerOptions {
  dataDir: string;
  isolation?: string;
  account?: string;
  profileDir?: string;
  engine?: string;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const brokerPath = path.join(pluginDir, 'broker.mjs');
const profileModulePath = new URL('../../plugins/cloakbrowser/lib/profile.mjs', import.meta.url);
const profile = (await import(profileModulePath.href)) as unknown as CopyKeepModule;
const copyScriptPath = path.join(pluginDir, 'scripts', 'profile-copy.mjs');

const STUB_TOOLS = ['browser_navigate', 'browser_snapshot'];

// The stub backend: answers the handshake, writes a marker file into whatever
// user-data-dir it was given on any tool call, and reports that directory. That
// is all a swap needs — a file the base did not have before the session.
const STUB_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-copy-keep', version: '0.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} } })) } });
    return;
  }
  if (message.method === 'tools/call') {
    const dir = process.env.PLAYWRIGHT_MCP_USER_DATA_DIR;
    if (typeof dir === 'string' && dir !== '') {
      fs.writeFileSync(path.join(dir, 'session-marker.txt'), 'from-session\\n');
    }
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({
      profileDir: dir ?? null,
      isolated: process.env.PLAYWRIGHT_MCP_ISOLATED ?? null,
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
  mkdirSync(path.dirname(file), { recursive: true });
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
        reject(new Error(`timeout waiting for ${method}; stderr=${stderr.slice(-800)}`));
      }, timeoutMs);
      pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  };
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const endInput = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
    }
  };
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
    endInput,
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
): Promise<{ profileDir: string | null; isolated: string | null }> {
  const response = await session.request('tools/call', {
    name: 'browser_navigate',
    arguments: { url: 'http://127.0.0.1:9/' },
  });
  const text = response.result?.content?.[0]?.text ?? '{}';
  return JSON.parse(text) as { profileDir: string | null; isolated: string | null };
}

function toolNames(response: JsonRpcResponse): string[] {
  return (response.result?.tools ?? []).map((tool) => tool.name).sort();
}

function engineErrorText(payload: Record<string, unknown>): string {
  return typeof payload.engineError === 'string' ? payload.engineError : '';
}

function baseProfileDir(dataDir: string, engine = 'cloak', name = 'default'): string {
  // "default" is the Chromium engines' legacy profiles/default for every account
  // name (account "default" maps to the same directory); any other name is an
  // account under profiles/<engine>/.
  return (engine === 'cloak' || engine === 'playwright') && name === 'default'
    ? path.join(dataDir, 'profiles', name)
    : path.join(dataDir, 'profiles', engine, name);
}

function seedBaseProfile(dataDir: string, engine = 'cloak', name = 'default'): string {
  const base = baseProfileDir(dataDir, engine, name);
  writeFile(path.join(base, '.cloakbrowser-seed'), '12345\n');
  writeFile(path.join(base, 'Local State'), '{"os_crypt":{"encrypted_key":"DPAPI-TEST"}}');
  writeFile(path.join(base, 'Default', 'Network', 'Cookies'), 'COOKIE-BASE');
  writeFile(path.join(base, 'Default', 'Preferences'), '{"profile":{}}');
  writeFile(path.join(base, 'base-marker.txt'), 'base-marker\n');
  writeFile(path.join(base, 'Cache', 'data_0'), 'CACHE');
  writeFile(path.join(base, 'lockfile'), '');
  return base;
}

const LOCK_FILE_NAMES = new Set(['.cloakbrowser-mcp-profile.lock', 'lockfile', 'parent.lock']);

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

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
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

describe('copy-keep as a profile_isolation value', () => {
  it('is offered by both plugin manifests with honest help text', () => {
    for (const name of ['cloakbrowser', 'camoufox']) {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'),
      ) as { version: string; userConfig: { profile_isolation: { options: string[]; description: string } } };
      const setting = manifest.userConfig.profile_isolation;
      expect(setting.options).toEqual(['shared', 'workspace', 'isolated', 'copy', 'copy-keep']);
      expect(setting.description).toContain('copy-keep');
      expect(setting.description).toContain('previous-');
      expect(setting.description).toContain('never deleted automatically');
      expect(setting.description).not.toContain('in memory');
      expect(manifest.version).toBe('2.17.0');
    }
    expect(profile.PROFILE_ISOLATION_VALUES).toEqual([
      'shared',
      'workspace',
      'isolated',
      'copy',
      'copy-keep',
    ]);
    expect(profile.PROFILE_ISOLATION_COPY_KEEP).toBe('copy-keep');
    expect(profile.PROFILE_ISOLATION_COPY_VALUES).toEqual(['copy', 'copy-keep']);
    expect(profile.isCopyIsolation('copy')).toBe(true);
    expect(profile.isCopyIsolation('copy-keep')).toBe(true);
    expect(profile.isCopyIsolation('shared')).toBe(false);
  });

  it('is accepted by resolveProfileIsolation and is never a default', () => {
    expect(profile.resolveProfileIsolation('copy-keep')).toEqual({
      mode: 'copy-keep',
      source: 'setting',
      ignored: null,
      placeholder: null,
    });
    expect(profile.resolveProfileIsolation('  copy-keep  ').mode).toBe('copy-keep');
    expect(profile.resolveProfileIsolation('${user_config.profile_isolation}').mode).toBe('shared');
    expect(profile.resolveProfileIsolation('copy-keepish').mode).toBe('shared');
  });
});

describe('copy-keep resolution and notes', () => {
  const dataDir = path.resolve('D:/scratch/copy-keep-resolution-data');
  const options = {
    engineId: 'cloak',
    dataDir,
    launcherName: 'launch.mjs',
    cwd: 'D:\\Projects2\\StealthBrowserAutomation',
  };

  it('resolves exactly like shared and copy, and never derives a workspace profile', () => {
    const cases: Record<string, unknown>[] = [
      {},
      { profileDir: 'D:/profiles/explicit' },
      { account: 'alice' },
      { pointer: 'work' },
      { pointer: 'default' },
      { account: '${user_config.account}', pointer: null },
    ];
    for (const input of cases) {
      const keep = profile.resolveProfile({ ...options, ...input, isolation: 'copy-keep' });
      const shared = profile.resolveProfile({ ...options, ...input, isolation: 'shared' });
      const copy = profile.resolveProfile({ ...options, ...input, isolation: 'copy' });
      expect(keep).toEqual(shared);
      expect(keep).toEqual(copy);
      expect(keep.profileSource).not.toBe('workspace');
    }
    expect(profile.resolveProfile({ ...options, isolation: 'copy-keep' }).profileSource).toBe('default');
    const workspace = profile.resolveProfile({ ...options, isolation: 'workspace', cwd: 'D:/a' });
    expect(workspace.profileSource).toBe('workspace');
  });

  it('states that changes are kept and the previous tree is retained', () => {
    const note = profile.profileCopyKeepNote(
      'D:/data/profiles/default',
      'D:/data/profiles/cloak/.sessions/default-x',
    );
    expect(note).toBe(
      'Profile isolation is "copy-keep": this session runs on a temporary copy of D:/data/profiles/default at ' +
        'D:/data/profiles/cloak/.sessions/default-x, and changes are kept: the base is replaced on a clean close ' +
        'and the previous tree is retained beside it.',
    );
    expect(note).toContain('changes are kept');
    expect(note).toContain('the base is replaced on a clean close');
    expect(note).toContain('the previous tree is retained');
    expect(profile.profileCopyNotApplicableNote('copy-keep')).toBe(
      'This engine manages its own browser profile, so profile_isolation "copy-keep" does not apply to it.',
    );
    expect(profile.profileCopyNotApplicableNote('copy')).toBe(
      'This engine manages its own browser profile, so profile_isolation "copy" does not apply to it.',
    );
  });
});

describe('previous trees', () => {
  const now = new Date(2026, 9, 26, 15, 30, 5);

  it('names a retained sibling and handles a same-second collision', () => {
    expect(profile.previousTreeName('D:/data/profiles/default', { now })).toBe(
      'default.previous-20261026-153005',
    );
    expect(profile.previousTreeName('D:/data/profiles/default', { now, suffix: 1 })).toBe(
      'default.previous-20261026-153005-2',
    );
    // The sibling lives in the base's parent directory, resolved the same way on
    // every platform (the base string itself is only data here).
    const aliceBase = path.resolve('D:/data/profiles/cloak/alice');
    expect(profile.previousTreeDir('D:/data/profiles/cloak/alice', { now })).toBe(
      path.join(path.dirname(aliceBase), 'alice.previous-20261026-153005'),
    );
    const defaultParent = path.dirname(path.resolve('D:/data/profiles/default'));
    expect(
      profile.selectPreviousTreeDir('D:/data/profiles/default', {
        now,
        exists: (candidate) => candidate.endsWith('20261026-153005'),
      }),
    ).toBe(path.join(defaultParent, 'default.previous-20261026-153005-2'));
    expect(profile.selectPreviousTreeDir('D:/data/profiles/default', { now, exists: () => true })).toBeNull();
  });

  it('parses only names it could have written', () => {
    expect(profile.parsePreviousTreeName('default.previous-20261026-153005')).toEqual({
      name: 'default.previous-20261026-153005',
      baseName: 'default',
      timestamp: '20261026-153005',
      suffix: 0,
    });
    expect(profile.parsePreviousTreeName('alice.previous-20261026-153005-2')).toMatchObject({
      baseName: 'alice',
      suffix: 2,
    });
    for (const name of [
      'default',
      'default.previous-20261026-153005-1',
      'default.previous-20261026-1530',
      'default.previous-20261326-153005',
      'default.previous-20261026-250005',
      '.previous-20261026-153005',
    ]) {
      expect(profile.parsePreviousTreeName(name)).toBeNull();
    }
  });

  it('lists the trees beside one base, newest first and bounded', () => {
    const root = tempRoot('keep-previous-');
    const base = path.join(root, 'profiles', 'cloak', 'alice');
    mkdirSync(base, { recursive: true });
    const older = path.join(root, 'profiles', 'cloak', 'alice.previous-20260101-010101');
    const newer = path.join(root, 'profiles', 'cloak', 'alice.previous-20260102-010101');
    const otherBase = path.join(root, 'profiles', 'cloak', 'bob.previous-20260103-010101');
    for (const dir of [older, newer, otherBase]) {
      writeFile(path.join(dir, 'x'), 'x');
    }
    writeFileSync(path.join(root, 'profiles', 'cloak', 'alice.previous-20260104-010101'), 'file-not-dir');
    const listed = profile.listPreviousTrees(base);
    expect(listed.root).toBe(path.join(root, 'profiles', 'cloak'));
    expect(listed.baseName).toBe('alice');
    expect(listed.trees.map((tree) => tree.name)).toEqual([
      'alice.previous-20260102-010101',
      'alice.previous-20260101-010101',
    ]);
    expect(listed.count).toBe(2);
    expect(listed.truncated).toBe(false);
    const bounded = profile.listPreviousTrees(base, { limit: 1 });
    expect(bounded.trees).toHaveLength(1);
    expect(bounded.count).toBe(2);
    expect(bounded.truncated).toBe(true);
    expect(profile.listPreviousTrees(path.join(root, 'missing', 'default')).trees).toEqual([]);
  });
});

describe('whole-tree swap', () => {
  function fixture(): { base: string; session: string; now: Date } {
    const root = tempRoot('keep-swap-');
    const base = path.join(root, 'profiles', 'cloak', 'alice');
    const session = path.join(root, 'profiles', 'cloak', '.sessions', 'alice-20260101-010101-1');
    writeFile(path.join(base, 'old.txt'), 'old-base\n');
    writeFile(path.join(session, 'new.txt'), 'new-session\n');
    writeFile(path.join(session, 'old.txt'), 'old-base\n');
    return { base, session, now: new Date(2026, 9, 26, 15, 30, 5) };
  }

  it('moves the base aside and the session copy into its path', () => {
    const { base, session, now } = fixture();
    const result = profile.swapSessionCopyIntoBase({ baseDir: base, sessionDir: session, now });
    expect(result).toEqual({
      ok: true,
      baseDir: path.resolve(base),
      sessionDir: path.resolve(session),
      previousDir: path.join(path.dirname(base), 'alice.previous-20261026-153005'),
      restored: false,
      retriedMs: 0,
      error: null,
    });
    expect(existsSync(session)).toBe(false);
    expect(listFiles(base)).toEqual(['new.txt', 'old.txt']);
    expect(readFileSync(path.join(base, 'new.txt'), 'utf8')).toBe('new-session\n');
    expect(listFiles(result.previousDir!)).toEqual(['old.txt']);
    expect(readFileSync(path.join(result.previousDir!, 'old.txt'), 'utf8')).toBe('old-base\n');
  });

  it('restores the base and keeps the session copy when the second rename fails', () => {
    const { base, session, now } = fixture();
    const baseHashBefore = hashTree(base);
    let calls = 0;
    const result = profile.swapSessionCopyIntoBase({
      baseDir: base,
      sessionDir: session,
      now,
      rename: (from, to) => {
        calls += 1;
        if (calls === 2) {
          throw new Error('mutation: second rename refused');
        }
        renameSync(from, to);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.restored).toBe(true);
    expect(result.previousDir).toBeNull();
    expect(result.error).toContain('Cannot move the session copy');
    expect(result.error).toContain(path.resolve(base));
    expect(result.error).toContain(path.resolve(session));
    expect(result.error).toContain('The base was restored');
    expect(hashTree(base)).toBe(baseHashBefore);
    expect(existsSync(session)).toBe(true);
    expect(listFiles(session)).toEqual(['new.txt', 'old.txt']);
    expect(readdirSync(path.dirname(base)).filter((name) => name.includes('.previous-'))).toEqual([]);
  });

  it('reports both paths when the base cannot be restored either', () => {
    const { base, session, now } = fixture();
    let calls = 0;
    const result = profile.swapSessionCopyIntoBase({
      baseDir: base,
      sessionDir: session,
      now,
      rename: (from, to) => {
        calls += 1;
        if (calls >= 2) {
          throw new Error('mutation: rename refused');
        }
        renameSync(from, to);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.restored).toBe(false);
    expect(result.previousDir).toBe(path.join(path.dirname(base), 'alice.previous-20261026-153005'));
    expect(existsSync(result.previousDir!)).toBe(true);
    expect(result.error).toContain('could not be restored');
    expect(existsSync(session)).toBe(true);
    expect(existsSync(base)).toBe(false);
  });

  it('leaves both trees alone when the first rename fails', () => {
    const { base, session, now } = fixture();
    const baseHashBefore = hashTree(base);
    const result = profile.swapSessionCopyIntoBase({
      baseDir: base,
      sessionDir: session,
      now,
      rename: () => {
        throw new Error('mutation: first rename refused');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.restored).toBe(false);
    expect(result.previousDir).toBeNull();
    expect(result.error).toContain('Cannot move the base profile');
    expect(result.error).toContain(path.resolve(session));
    expect(hashTree(base)).toBe(baseHashBefore);
    expect(existsSync(session)).toBe(true);
  });

  it('refuses a missing base or session and a same-path swap', () => {
    const { base, session, now } = fixture();
    expect(
      profile.swapSessionCopyIntoBase({ baseDir: path.join(base, 'nope'), sessionDir: session, now }).error,
    ).toContain('disappeared before the swap');
    expect(
      profile.swapSessionCopyIntoBase({ baseDir: base, sessionDir: path.join(session, 'nope'), now }).error,
    ).toContain('disappeared before the swap');
    expect(profile.swapSessionCopyIntoBase({ baseDir: base, sessionDir: base, now }).ok).toBe(false);
    // A session copy inside the base would move with it: refused.
    const inside = profile.swapSessionCopyIntoBase({
      baseDir: base,
      sessionDir: path.join(base, 'inner'),
      now,
    });
    expect(inside.ok).toBe(false);
    expect(inside.error).toContain('inside the base');
  });

  it('retries a transiently refused rename within the bounded window', () => {
    const { base, session, now } = fixture();
    let fakeNow = 0;
    let attempts = 0;
    // No retryMs override: the production default window applies.
    const result = profile.swapSessionCopyIntoBase({
      baseDir: base,
      sessionDir: session,
      now,
      pollMs: 10,
      sleep: (ms) => {
        fakeNow += ms;
      },
      clock: () => fakeNow,
      rename: (from, to) => {
        attempts += 1;
        // Windows refuses a directory rename while a dying browser still holds a
        // handle: EPERM for the first two attempts, then the handle is gone.
        if (attempts <= 2) {
          const error = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        renameSync(from, to);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.retriedMs).toBe(20);
    expect(existsSync(session)).toBe(false);
    expect(readFileSync(path.join(base, 'new.txt'), 'utf8')).toBe('new-session\n');
  });

  it('stops retrying a refused rename at the bound and keeps both trees', () => {
    const { base, session, now } = fixture();
    let fakeNow = 0;
    const baseHashBefore = hashTree(base);
    const result = profile.swapSessionCopyIntoBase({
      baseDir: base,
      sessionDir: session,
      now,
      retryMs: 50,
      pollMs: 10,
      sleep: (ms) => {
        fakeNow += ms;
      },
      clock: () => fakeNow,
      rename: () => {
        const error = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('after retrying the rename for 50 ms');
    expect(result.error).toContain(path.resolve(base));
    expect(result.error).toContain(path.resolve(session));
    expect(hashTree(base)).toBe(baseHashBefore);
    expect(existsSync(session)).toBe(true);
  });

  it('uses the next free previous-tree name when one already exists', () => {
    const { base, session, now } = fixture();
    const taken = path.join(path.dirname(base), 'alice.previous-20261026-153005');
    writeFile(path.join(taken, 'existing.txt'), 'keep me\n');
    const result = profile.swapSessionCopyIntoBase({ baseDir: base, sessionDir: session, now });
    expect(result.ok).toBe(true);
    expect(result.previousDir).toBe(path.join(path.dirname(base), 'alice.previous-20261026-153005-2'));
    // The retained tree is never overwritten, and a second swap in the same
    // second takes the next free name again.
    expect(readFileSync(path.join(taken, 'existing.txt'), 'utf8')).toBe('keep me\n');
    expect(profile.selectPreviousTreeDir(base, { now })).toBe(
      path.join(path.dirname(base), 'alice.previous-20261026-153005-3'),
    );
  });
});

describe('isolation root guard', () => {
  it('accepts only paths strictly inside the root', () => {
    expect(profile.isPathInsideRoot('D:/data/profiles/default', 'D:/data')).toBe(true);
    expect(profile.isPathInsideRoot('D:/data', 'D:/data')).toBe(false);
    expect(profile.isPathInsideRoot('D:/data-other/x', 'D:/data')).toBe(false);
    expect(profile.isPathInsideRoot('C:/elsewhere', 'D:/data')).toBe(false);
    expect(profile.isPathInsideRoot('', 'D:/data')).toBe(false);
  });
});

describe('broker copy-keep mode', () => {
  it('swaps the session copy into the base on a clean close and lists the previous tree', async () => {
    const dataDir = tempRoot('keep-broker-clean-');
    createRuntime(dataDir);
    const base = seedBaseProfile(dataDir, 'cloak', 'keepbase');
    const baseHashBefore = hashTree(base);

    const session = startBroker({ dataDir, isolation: 'copy-keep', account: 'keepbase' });
    const initialized = await initialize(session);
    expect(String(initialized.result?.instructions)).toContain('Profile isolation is "copy-keep"');
    expect(String(initialized.result?.instructions)).toContain('changes are kept');
    const tools = toolNames(await session.request('tools/list', {}));
    expect(tools).toContain('browser_capabilities');
    const env = await effectiveEnvironment(session);
    if (env.profileDir === null) {
      throw new Error('the copy-keep start reported no user-data-dir');
    }
    const sessionDir = path.resolve(env.profileDir);
    expect(path.dirname(sessionDir)).toBe(path.join(dataDir, 'profiles', 'cloak', '.sessions'));
    expect(existsSync(sessionDir)).toBe(true);
    expect(hashTree(base)).toBe(baseHashBefore);
    expect(profile.readProfileLock(base)).toMatchObject({ state: 'live', owner: { pid: session.pid } });

    const caps = await capabilities(session);
    expect(caps.profileIsolation).toBe('copy-keep');
    expect(caps.profileCopy).toMatchObject({
      baseDir: base,
      sessionDir,
      baseLock: { state: 'live', heldByThisSession: true },
      swap: { state: 'pending', previousDir: null },
    });
    expect(String(caps.profileCopyNote)).toContain('changes are kept');
    const statusPayload = await status(session);
    expect(statusPayload.profileCopy).toMatchObject({ baseDir: base, sessionDir });

    session.endInput();
    expect(await session.exited).toBe(0);
    expect(await waitFor(() => !existsSync(sessionDir))).toBe(true);

    // The base is now the session copy, with the session's file and the old
    // base's files; the old base is retained beside it; the lock is gone from
    // both the new base and the retained tree.
    expect(listFiles(base)).toEqual([
      '.cloakbrowser-seed',
      'Default/Network/Cookies',
      'Default/Preferences',
      'Local State',
      'base-marker.txt',
      'session-marker.txt',
    ]);
    expect(readFileSync(path.join(base, 'session-marker.txt'), 'utf8')).toBe('from-session\n');
    expect(readFileSync(path.join(base, 'base-marker.txt'), 'utf8')).toBe('base-marker\n');
    const previousName = readdirSync(path.join(dataDir, 'profiles', 'cloak')).find((name) =>
      name.startsWith('keepbase.previous-'),
    );
    expect(previousName).toBeDefined();
    const previousDir = path.join(dataDir, 'profiles', 'cloak', previousName!);
    // The retained tree is the base exactly as it was: caches and lock artifacts
    // included, because the plugin never rewrites a profile it moves aside.
    expect(listFiles(previousDir)).toEqual([
      '.cloakbrowser-seed',
      'Cache/data_0',
      'Default/Network/Cookies',
      'Default/Preferences',
      'Local State',
      'base-marker.txt',
      'lockfile',
    ]);
    expect(hashTree(previousDir)).toBe(baseHashBefore);
    expect(existsSync(profile.profileLockPath(base))).toBe(false);
    expect(existsSync(profile.profileLockPath(previousDir))).toBe(false);
    expect(existsSync(path.join(base, '.session-owner.json'))).toBe(false);
    const record = profile.readSwapRecord('cloak', dataDir);
    expect(record).toMatchObject({
      isolation: 'copy-keep',
      state: 'swapped',
      baseDir: base,
      sessionDir,
      previousDir,
      restored: false,
    });

    // A later session reports the retained tree and the swap result.
    const baseHashAfterSwap = hashTree(base);
    const lister = startBroker({ dataDir, isolation: 'copy', account: 'keepbase' });
    await initialize(lister);
    await lister.request('tools/list', {});
    const profiles = await profilesPayload(lister);
    const listedTrees = profiles.previousTrees as { count: number; trees: { name: string; path: string }[] };
    expect(listedTrees.count).toBe(1);
    expect(listedTrees.trees[0]).toMatchObject({ name: previousName, path: previousDir });
    expect(profiles.lastSwap).toMatchObject({ state: 'swapped', previousDir });
    const listerCaps = await capabilities(lister);
    expect(listerCaps.lastSwap).toMatchObject({ state: 'swapped', previousDir });
    await lister.close();
    // The lister ran in copy mode: it never wrote the swapped base.
    expect(hashTree(base)).toBe(baseHashAfterSwap);
  });

  it('performs no swap on a hard kill: base identical, session tree retained', async () => {
    const dataDir = tempRoot('keep-broker-crash-');
    createRuntime(dataDir);
    const base = seedBaseProfile(dataDir, 'cloak', 'keepbase');
    const baseHashBefore = hashTree(base);

    const session = startBroker({ dataDir, isolation: 'copy-keep', account: 'keepbase' });
    await initialize(session);
    const env = await effectiveEnvironment(session);
    if (env.profileDir === null) {
      throw new Error('the copy-keep start reported no user-data-dir');
    }
    const sessionDir = path.resolve(env.profileDir);
    session.kill();
    const exitCode = await session.exited;
    expect(exitCode === null || exitCode !== 0).toBe(true);
    expect(await waitFor(() => existsSync(sessionDir))).toBe(true);
    expect(hashTree(base)).toBe(baseHashBefore);
    expect(
      readdirSync(path.join(dataDir, 'profiles', 'cloak')).some((name) => name.includes('.previous-')),
    ).toBe(false);
    expect(profile.readSwapRecord('cloak', dataDir)).toBeNull();

    const lister = startBroker({ dataDir, isolation: 'shared', account: 'keepbase' });
    await initialize(lister);
    const profiles = await profilesPayload(lister);
    const copies = (profiles.sessionCopies as { copies: { path: string; state: string }[] }).copies;
    const leftover = copies.find((copy) => path.resolve(copy.path) === sessionDir);
    expect(leftover?.state).toBe('leftover');
    expect(Object.hasOwn(profiles, 'previousTrees')).toBe(false);
    await lister.close();
  });

  it('refuses copy-keep outside the plugin data directory but keeps copy allowed there', async () => {
    const dataDir = tempRoot('keep-broker-outside-');
    createRuntime(dataDir);
    const outside = path.join(tempRoot('keep-outside-profile-'), 'real-profile');
    writeFile(path.join(outside, 'keep.txt'), 'outside\n');
    const outsideHash = hashTree(outside);

    const refused = startBroker({ dataDir, isolation: 'copy-keep', profileDir: outside });
    await initialize(refused);
    const caps = await capabilities(refused);
    const error = engineErrorText(caps);
    expect(error).toContain('copy-keep');
    expect(error).toContain('outside it');
    expect(error).toContain('The backend was not started.');
    expect(error).toContain('copy');
    expect(toolNames(await refused.request('tools/list', {}))).toEqual([
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    expect(existsSync(path.join(dataDir, 'profiles', 'cloak', '.sessions'))).toBe(false);
    expect(hashTree(outside)).toBe(outsideHash);
    expect(existsSync(profile.profileLockPath(outside))).toBe(false);
    await refused.close();

    const allowed = startBroker({ dataDir, isolation: 'copy', profileDir: outside });
    await initialize(allowed);
    const allowedCaps = await capabilities(allowed);
    expect(engineErrorText(allowedCaps)).toBe('');
    const env = await effectiveEnvironment(allowed);
    if (env.profileDir === null) {
      throw new Error('the copy start reported no user-data-dir');
    }
    expect(
      path.resolve(env.profileDir).startsWith(path.join(dataDir, 'profiles', 'cloak', '.sessions')),
    ).toBe(true);
    expect(profile.readProfileLock(outside).state).toBe('live');
    await allowed.close();
    expect(await waitFor(() => !existsSync(profile.profileLockPath(outside)))).toBe(true);
    expect(hashTree(outside)).toBe(outsideHash);
  });

  it('refuses a base that contains the session copy root', async () => {
    const dataDir = tempRoot('keep-broker-engine-root-');
    createRuntime(dataDir);
    const engineFolder = path.join(dataDir, 'profiles', 'cloak');
    const session = startBroker({ dataDir, isolation: 'copy-keep', profileDir: engineFolder });
    await initialize(session);
    const caps = await capabilities(session);
    const error = engineErrorText(caps);
    expect(error).toContain('contains this session');
    expect(error).toContain('The backend was not started.');
    expect(existsSync(path.join(engineFolder, '.sessions'))).toBe(false);
    expect(existsSync(path.join(engineFolder, '.cloakbrowser-mcp-profile.lock'))).toBe(false);
    await session.close();
  });

  it('refuses copy-keep on engines that own their profile', async () => {
    const dataDir = tempRoot('keep-broker-native-');
    const session = startBroker({ dataDir, isolation: 'copy-keep', engine: 'camoufox-native' });
    const initialized = await initialize(session);
    const caps = await capabilities(session);
    expect(caps.profileIsolation).toBe('copy-keep');
    expect(caps.profileApplies).toBe(false);
    expect(caps.profileCopySupported).toBe(false);
    expect(String(caps.profileCopyNote)).toBe(
      'This engine manages its own browser profile, so profile_isolation "copy-keep" does not apply to it.',
    );
    expect(engineErrorText(caps)).toContain('does not apply to it');
    expect(String(initialized.result?.instructions)).toContain('backend is unavailable');
    expect(existsSync(path.join(dataDir, 'profiles'))).toBe(false);
    await session.close();

    // Kameleo declares the same profileApplies: false.
    const kameleo = JSON.parse(readFileSync(path.join(pluginDir, 'engines', 'kameleo.json'), 'utf8')) as {
      profileApplies: boolean;
    };
    expect(kameleo.profileApplies).toBe(false);
  });

  it('keeps everything when the session copy is still locked, after a bounded wait', async () => {
    const dataDir = tempRoot('keep-broker-timeout-');
    createRuntime(dataDir);
    const base = seedBaseProfile(dataDir, 'cloak', 'keepbase');
    const baseHashBefore = hashTree(base);
    const session = startBroker({ dataDir, isolation: 'copy-keep', account: 'keepbase' });
    await initialize(session);
    const env = await effectiveEnvironment(session);
    if (env.profileDir === null) {
      throw new Error('the copy-keep start reported no user-data-dir');
    }
    const sessionDir = path.resolve(env.profileDir);
    // A live bridge lock inside the copy, owned by this test process: the broker
    // cannot prove the copy is free and must keep both trees.
    writeJson(profile.profileLockPath(sessionDir), {
      pid: process.pid,
      createdAt: '2026-01-01T00:00:00.000Z',
      userDataDir: sessionDir,
    });
    const startedAt = Date.now();
    session.endInput();
    expect(await session.exited).toBe(0);
    const waited = Date.now() - startedAt;
    expect(waited).toBeGreaterThanOrEqual(profile.COPY_KEEP_LOCK_WAIT_MS - 250);
    expect(waited).toBeLessThan(profile.COPY_KEEP_LOCK_WAIT_MS + 5000);
    expect(existsSync(sessionDir)).toBe(true);
    expect(hashTree(base)).toBe(baseHashBefore);
    // The base lock is released only after a successful swap; here it is kept
    // and reads as stale for the next start.
    expect(existsSync(profile.profileLockPath(base))).toBe(true);
    const record = profile.readSwapRecord('cloak', dataDir);
    expect(record).toMatchObject({ state: 'failed', previousDir: null, restored: false });
    expect(String(record?.error)).toContain('still locked');
    expect(
      readdirSync(path.join(dataDir, 'profiles', 'cloak')).some((name) => name.includes('.previous-')),
    ).toBe(false);
  }, 30000);

  it('never removes retained previous trees with --prune', () => {
    const dataDir = tempRoot('keep-prune-');
    const profilesRoot = path.join(dataDir, 'profiles', 'cloak');
    const previousTree = path.join(profilesRoot, 'keepbase.previous-20260101-010101');
    writeFile(path.join(previousTree, 'old.txt'), 'old-base\n');
    const leftover = path.join(profilesRoot, '.sessions', 'keepbase-20260101-010102-999');
    writeFile(path.join(leftover, 'x'), 'x');
    const dry = runPrune(dataDir, ['--dry-run']);
    expect(dry.status).toBe(0);
    const dryPayload = JSON.parse(dry.stdout) as { removed: { path: string }[] };
    expect(dryPayload.removed.map((copy) => path.resolve(copy.path))).toEqual([leftover]);
    expect(existsSync(previousTree)).toBe(true);
    const pruned = runPrune(dataDir);
    expect(pruned.status).toBe(0);
    const prunedPayload = JSON.parse(pruned.stdout) as { removed: { path: string }[] };
    expect(prunedPayload.removed.map((copy) => path.resolve(copy.path))).toEqual([leftover]);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(previousTree)).toBe(true);
    expect(readFileSync(path.join(previousTree, 'old.txt'), 'utf8')).toBe('old-base\n');
    // The help text states the retention rule.
    const help = spawnSync(process.execPath, [copyScriptPath, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('copy-keep');
    expect(help.stdout).toContain('previous-');
  });

  it('leaves shared, workspace, isolated and copy payloads without copy-keep keys', async () => {
    for (const isolation of ['shared', 'workspace', 'isolated', 'copy']) {
      const dataDir = tempRoot(`keep-broker-eq-${isolation}-`);
      createRuntime(dataDir);
      const session = startBroker({ dataDir, isolation, account: 'eqbase' });
      await initialize(session);
      const caps = await capabilities(session);
      expect(caps.profileIsolation).toBe(isolation);
      expect(Object.hasOwn(caps, 'lastSwap')).toBe(false);
      expect(Object.hasOwn(caps, 'previousTrees')).toBe(false);
      const copyPayload = caps.profileCopy as Record<string, unknown> | undefined;
      // copy mode reports profileCopy but no swap key; the other modes report no
      // profileCopy at all.
      expect(copyPayload === undefined).toBe(isolation !== 'copy');
      expect(copyPayload !== undefined && Object.hasOwn(copyPayload, 'swap')).toBe(false);
      const statusPayload = await status(session);
      expect(Object.hasOwn(statusPayload, 'lastSwap')).toBe(false);
      const profiles = await profilesPayload(session);
      expect(Object.hasOwn(profiles, 'lastSwap')).toBe(false);
      expect(Object.hasOwn(profiles, 'previousTrees')).toBe(false);
      await session.close();
    }
  });
});
