import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface CopySummary {
  ok: boolean;
  dryRun: boolean;
  engine: string;
  engineSource: 'path' | 'setting';
  from: string;
  to: string;
  sourceDir: string;
  targetDir: string;
  // 2.21.0: the effective tier and where it came from (option, setting, default).
  contents?: string;
  contentsSource?: string;
  copied: { files: number; directories: number; bytes: number };
  excluded: {
    entries: number;
    byRule: Record<string, number>;
    names: { name: string; rule: string; count: number }[];
  };
  skipped: { symlinks: number; other: number };
  topLevel: {
    path: string;
    type: string;
    files: number;
    bytes: number;
    excluded: string | null;
  }[];
  sourceLock: { state: string; owner: { pid: number; createdAt: string | null } | null };
  sourceEngineLock: {
    state: string;
    path: string;
    file: string | null;
    liveness: string | null;
    owner: { pid: number | null; createdAt: string | null } | null;
    error: string | null;
  } | null;
}

interface CopyResult {
  ok: boolean;
  summary?: CopySummary;
  error?: { code: string; message: string };
}

interface CopyOptions {
  engine?: string;
  from?: string;
  to?: string;
  dataDir?: string | null;
  dryRun?: boolean;
  contents?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  pluginRoot?: string;
}

interface CopyPlan {
  directories: string[];
  files: { source: string; relative: string }[];
}

interface ProfileCopyModule {
  DEFAULT_COPY_ENGINE: string;
  exclusionRule(name: string, isDirectory: boolean, engineLockFile?: string | null): string | null;
  detectEngineFromProfilePath(profileDir: string, dataDir: string, engineIds: string[]): string | null;
  resolveCopyEngine(options: {
    requestedEngine?: string;
    sourceDir: string;
    dataDir: string;
    engineIds: string[];
  }): { engineId: string | null; source: string | null; error: string | null };
  parseArguments(argv: string[]): { options: Record<string, unknown>; errors: string[] };
  runProfileCopy(options?: CopyOptions): CopyResult;
  copyPlanToTarget(plan: CopyPlan, targetDir: string, options?: { targetName?: string }): void;
  formatHumanSummary(summary: CopySummary): string;
}

const scriptPath = fileURLToPath(
  new URL('../../plugins/cloakbrowser/scripts/profile-copy.mjs', import.meta.url),
);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const realEnginesDir = path.join(repoRoot, 'plugins', 'cloakbrowser', 'engines');
const profileCopy = (await import(
  new URL('../../plugins/cloakbrowser/scripts/profile-copy.mjs', import.meta.url).href
)) as unknown as ProfileCopyModule;
const camoufoxCopy = (await import(
  new URL('../../plugins/camoufox/scripts/profile-copy.mjs', import.meta.url).href
)) as unknown as ProfileCopyModule;

// A PID that is guaranteed gone: spawn a short process, wait for its exit, then
// use its PID for the stale-lock fixture.
// A PID no process can have on any supported platform: Linux caps pids at
// 4194304 by default, macOS at ~99999, and Windows rejects 2^31-1 with ESRCH.
// A pid from an exited child can still be reported live while its kernel
// process object lingers (observed on hosted Windows runners), which made the
// stale-lock fixtures flaky; this constant cannot collide.
const DEAD_PID = 2_147_483_647;

const SECRET_COOKIE = 'COOKIE-SECRET-6f2a';
const SECRET_SEED = 'SEED-SECRET-9c1b';
const LOCK_FILENAME = '.cloakbrowser-mcp-profile.lock';

const tempRoots: string[] = [];
const holders: FileHolder[] = [];

afterEach(async () => {
  for (const holder of holders.splice(0)) {
    await holder.stop();
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface FileHolder {
  pid: number;
  stop: () => Promise<void>;
}

// Hold a file like the browser holds its lock. Chromium's lockfile is shared for
// readers and exclusive for writers (share "Read": reads succeed, r+ fails);
// Firefox's parent.lock refuses readers too (share "None": read and r+ both fail
// with EBUSY). A real process with one Windows handle, started and stopped by
// exact pid.
async function holdExclusiveForRead(file: string, share: 'Read' | 'None' = 'Read'): Promise<FileHolder> {
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
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const handle = openSync(file, 'r+');
      closeSync(handle);
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
            const timer = setTimeout(resolve, 3000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
          });
        };
        return { pid, stop };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
  throw new Error('the file holder never locked the file');
}

// A scratch plugin root whose engines directory is the real one, with one
// engine's lock descriptor replaced by a pid rule. The copy tool reads the
// manifest from `pluginRoot` but imports its code from the installed plugin, so
// this exercises the whole descriptor wiring on every platform without needing
// an OS-level exclusive handle.
function createPidLockPluginRoot(root: string, engine: 'cloak' | 'camoufox'): string {
  const engines = path.join(root, 'engines');
  mkdirSync(engines, { recursive: true });
  // Validation requires the default launcher and every named launcher to exist;
  // the copy tool never runs them.
  writeFileSync(path.join(root, 'launch.mjs'), '');
  for (const name of readdirSync(realEnginesDir)) {
    if (!name.endsWith('.json')) {
      continue;
    }
    copyFileSync(path.join(realEnginesDir, name), path.join(engines, name));
    const copied = JSON.parse(readFileSync(path.join(engines, name), 'utf8')) as {
      launch?: { launcher?: string };
    };
    const launcher = copied.launch?.launcher;
    if (typeof launcher === 'string') {
      writeFileSync(path.join(root, launcher), '');
    }
  }
  const manifestPath = path.join(engines, `${engine}.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.profileLock = { file: 'owner.lock', owner: 'pid' };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'profile-copy-'));
  tempRoots.push(root);
  return root;
}

function write(profileDir: string, relative: string, content: string): void {
  const target = path.join(profileDir, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writeLock(profileDir: string, pid: number): void {
  writeFileSync(
    path.join(profileDir, LOCK_FILENAME),
    `${JSON.stringify({ pid, createdAt: '2026-10-25T00:00:00.000Z' })}\n`,
  );
}

// The full cloak fixture: identity files that must survive (including the
// database's WAL/SHM companions), and every excluded class. Returns the expected
// kept byte count.
function createCloakFixture(dataDir: string, lockPid: number = DEAD_PID): number {
  const profile = path.join(dataDir, 'profiles', 'default');
  write(profile, 'Cookies', `SQLite format 3\0${SECRET_COOKIE}`);
  write(profile, 'Default/Network/Cookies', `SQLite format 3\0${SECRET_COOKIE}-nested`);
  write(profile, 'Default/Login Data', 'SQLite format 3\0login-db');
  write(profile, 'Default/Preferences', '{"homepage":"about:blank"}');
  write(profile, 'Local State', '{"profile":{"info_cache":{}}}');
  write(profile, 'Preferences', '{"account_id":"fixture"}');
  write(profile, '.cloakbrowser-seed', SECRET_SEED);
  // Kept: the WAL is part of the database and travels with it. Excluded since
  // 2.20.0: the -shm index, which refuses a read while a writer holds it and is
  // rebuilt by SQLite.
  write(profile, 'Default/Network/Cookies.sqlite-wal', 'wal-part-of-db');
  write(profile, 'Default/Network/Cookies.sqlite-shm', 'shm-part-of-db');
  // Excluded: caches at the root and below Default, including Chromium 146's
  // Dawn shader caches, plus the crash metrics dump.
  write(profile, 'Cache/data_0', 'cache');
  write(profile, 'Default/Cache/data_1', 'cache');
  write(profile, 'Code Cache/js/index', 'code-cache');
  write(profile, 'GPUCache/data_0', 'gpu');
  write(profile, 'Default/GPUCache/data_0', 'gpu');
  write(profile, 'GrShaderCache/data_0', 'gr');
  write(profile, 'GraphiteDawnCache/data_0', 'graphite');
  write(profile, 'Default/DawnCache/data_0', 'dawn');
  write(profile, 'Default/DawnGraphiteCache/data_0', 'dawn-graphite');
  write(profile, 'Default/DawnWebGPUCache/data_0', 'dawn-webgpu');
  write(profile, 'ShaderCache/data_0', 'shader');
  write(profile, 'Crashpad/reports/one.dmp', 'crash');
  write(profile, 'BrowserMetrics/metrics.pma', 'metrics-dump');
  // Excluded: temporary entry, log directory, Chromium singletons, profile lock,
  // and the engine's own lock file.
  write(profile, 'scratch.tmp', 'temporary');
  write(profile, 'logs/browser.log', 'log-line');
  write(profile, 'SingletonLock', 'host-12345');
  write(profile, 'SingletonSocket', 'socket');
  write(profile, 'SingletonCookie', '123456789');
  write(profile, 'lockfile', '');
  writeLock(profile, lockPid);

  return [
    `SQLite format 3\0${SECRET_COOKIE}`,
    `SQLite format 3\0${SECRET_COOKIE}-nested`,
    'SQLite format 3\0login-db',
    '{"homepage":"about:blank"}',
    '{"profile":{"info_cache":{}}}',
    '{"account_id":"fixture"}',
    SECRET_SEED,
    'wal-part-of-db',
  ].reduce((total, content) => total + Buffer.byteLength(content), 0);
}

// A Firefox-shaped profile for the camoufox engine: its own lock, caches and
// thumbnails are excluded, and the cookie database's WAL/SHM companions are kept.
function createCamoufoxFixture(dataDir: string): void {
  const profile = path.join(dataDir, 'profiles', 'camoufox', 'default');
  write(profile, 'cookies.sqlite', 'SQLite format 3\0ff-cookies');
  write(profile, 'cookies.sqlite-wal', 'ff-wal');
  write(profile, 'cookies.sqlite-shm', 'ff-shm');
  write(profile, 'prefs.js', 'user_pref("browser.startup.page", 1);');
  write(profile, '.cloakbrowser-seed', SECRET_SEED);
  write(profile, 'cache2/entries/one', 'ff-cache');
  write(profile, 'startupCache/scriptCache.bin', 'ff-startup-cache');
  write(profile, 'thumbnails/one.png', 'ff-thumbnail');
  write(profile, 'parent.lock', '');
}

function run(options: CopyOptions): CopyResult {
  return profileCopy.runProfileCopy(options);
}

function expectFailure(result: CopyResult, code: string): string {
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe(code);
  return result.error?.message ?? '';
}

function runCli(
  args: string[],
  environment: Record<string, string | undefined> = {},
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('profile-copy CLI arguments', () => {
  it('defaults the engine to cloak and requires both names', () => {
    expect(profileCopy.DEFAULT_COPY_ENGINE).toBe('cloak');
    const parsed = profileCopy.parseArguments([]);
    expect(parsed.errors).toEqual(['--from is required.', '--to is required.']);
    expect(parsed.options.engine).toBe('cloak');
  });

  it('parses every documented option, including --name=value', () => {
    const parsed = profileCopy.parseArguments([
      '--engine=camoufox',
      '--from',
      'default',
      '--to=alice',
      '--data-dir',
      'D:/data',
      '--dry-run',
      '--json',
    ]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.options).toMatchObject({
      engine: 'camoufox',
      from: 'default',
      to: 'alice',
      dataDir: 'D:/data',
      dryRun: true,
      json: true,
    });
  });

  it('rejects a missing option value, an unknown option and a positional argument', () => {
    expect(profileCopy.parseArguments(['--from']).errors).toEqual([
      '--from needs a value.',
      '--to is required.',
    ]);
    expect(profileCopy.parseArguments(['--from', '--to', 'alice']).errors).toEqual(['--from needs a value.']);
    expect(profileCopy.parseArguments(['--wat']).errors).toContain('Unknown option "--wat".');
    expect(profileCopy.parseArguments(['alice']).errors).toContain('Unknown option "alice".');
  });

  it('treats --help as success and ignores other arguments', () => {
    const parsed = profileCopy.parseArguments(['--help', '--wat']);
    expect(parsed.options.help).toBe(true);
    expect(parsed.errors).toEqual([]);
    const cli = runCli(['--help']);
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain('Usage: node scripts/profile-copy.mjs');
    expect(cli.stdout).toContain('--dry-run');
    // The engine-specific exclusions and the session-cookie truth are stated.
    expect(cli.stdout).toContain('lockfile');
    expect(cli.stdout).toContain('parent.lock');
    expect(cli.stdout).toContain('DawnGraphiteCache');
    expect(cli.stdout).toContain('DawnWebGPUCache');
    expect(cli.stdout).toContain('BrowserMetrics');
    expect(cli.stdout).toContain('cache2');
    expect(cli.stdout).toContain('startupCache');
    expect(cli.stdout).toContain('thumbnails');
    expect(cli.stdout).toContain('*.sqlite-wal');
    expect(cli.stdout).toContain('session cookies');
    expect(cli.stdout).toContain('Chromium deletes its session cookies');
    expect(cli.stdout).toContain('Firefox keeps them in memory');
    expect(cli.stderr).toBe('');
  });

  it('exits 2 on a usage error', () => {
    const cli = runCli(['--from', 'default']);
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain('--to is required.');
  });
});

describe('exclusion rules', () => {
  it('names every rule and leaves identity files alone', () => {
    expect(profileCopy.exclusionRule(LOCK_FILENAME, false)).toBe('profileLock');
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      expect(profileCopy.exclusionRule(name, false)).toBe('singleton');
    }
    for (const name of [
      'Cache',
      'Code Cache',
      'GPUCache',
      'GrShaderCache',
      'GraphiteDawnCache',
      'DawnCache',
      'DawnGraphiteCache',
      'DawnWebGPUCache',
      'ShaderCache',
      'Crashpad',
      'cache2',
      'startupCache',
    ]) {
      expect(profileCopy.exclusionRule(name, true)).toBe('cache');
    }
    expect(profileCopy.exclusionRule('BrowserMetrics', true)).toBe('metrics');
    expect(profileCopy.exclusionRule('thumbnails', true)).toBe('thumbnails');
    expect(profileCopy.exclusionRule('scratch.tmp', false)).toBe('temporary');
    expect(profileCopy.exclusionRule('logs', true)).toBe('logs');
    expect(profileCopy.exclusionRule('Log', true)).toBe('logs');
    for (const name of ['Cookies', 'Local State', 'Preferences', '.cloakbrowser-seed', 'History']) {
      expect(profileCopy.exclusionRule(name, false)).toBeNull();
    }
    // A cache name is excluded whatever its kind; "logs" only as a directory.
    expect(profileCopy.exclusionRule('GPUCache', false)).toBe('cache');
    expect(profileCopy.exclusionRule('logs', false)).toBeNull();
  });

  it('excludes the engine lock file only when the manifest names it', () => {
    for (const [name, descriptor] of [
      ['lockfile', 'lockfile'],
      ['parent.lock', 'parent.lock'],
      ['LockFile', 'lockfile'],
    ]) {
      expect(profileCopy.exclusionRule(name, false, descriptor)).toBe('engineLock');
    }
    // Without a descriptor nothing named lockfile/parent.lock is excluded, so the
    // rule is driven by the engine's manifest rather than by a guessed name.
    expect(profileCopy.exclusionRule('lockfile', false, null)).toBeNull();
    expect(profileCopy.exclusionRule('parent.lock', false, '')).toBeNull();
    expect(profileCopy.exclusionRule('parent.lock', false, 'lockfile')).toBeNull();
  });

  it('keeps every database WAL and excludes only its SHM index', () => {
    // 2.20.0: the -wal carries the newest committed rows and is always kept; the
    // -shm is an index SQLite rebuilds, and on Windows it refuses a read while
    // the writer holds it, so a live copy could never be taken with it.
    for (const name of [
      'cookies.sqlite-wal',
      'webappsstore.sqlite-wal',
      'Cookies.sqlite-wal',
      'Local Storage.sqlite-wal',
    ]) {
      for (const descriptor of [null, 'lockfile', 'parent.lock']) {
        expect(profileCopy.exclusionRule(name, false, descriptor)).toBeNull();
      }
    }
    for (const name of ['cookies.sqlite-shm', 'Cookies.sqlite-shm', 'Local Storage.sqlite-shm']) {
      for (const descriptor of [null, 'lockfile', 'parent.lock']) {
        expect(profileCopy.exclusionRule(name, false, descriptor)).toBe('shm');
      }
    }
    // A directory whose name ends in -shm is not a SQLite index.
    expect(profileCopy.exclusionRule('odd-shm', true, null)).toBeNull();
  });

  it('excludes a LevelDB LOCK file and the two name gaps of 2.12-2.19', () => {
    for (const descriptor of [null, 'lockfile', 'parent.lock']) {
      expect(profileCopy.exclusionRule('LOCK', false, descriptor)).toBe('lock');
      expect(profileCopy.exclusionRule('lock', false, descriptor)).toBe('lock');
      expect(profileCopy.exclusionRule('shader-cache', true, descriptor)).toBe('cache');
      expect(profileCopy.exclusionRule('BrowserMetrics-spare.pma', false, descriptor)).toBe('metrics');
    }
    // A directory named LOCK is not a LevelDB lock file.
    expect(profileCopy.exclusionRule('LOCK', true, null)).toBeNull();
  });
});

describe('profile-copy refusals', () => {
  it('rejects invalid account names for both sides', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    const fromMessage = expectFailure(run({ from: '../x', to: 'alice', dataDir }), 'invalid-name');
    expect(fromMessage).toContain('Invalid account name "../x"');
    const toMessage = expectFailure(run({ from: 'default', to: 'CON', dataDir }), 'invalid-name');
    expect(toMessage).toContain('Invalid account name "CON"');
    expect(existsSync(path.join(dataDir, 'profiles', 'cloak', 'alice'))).toBe(false);
  });

  it('refuses a missing source and creates nothing', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    const message = expectFailure(run({ from: 'nobody', to: 'alice', dataDir }), 'source-missing');
    expect(message).toContain('The source profile "nobody" does not exist:');
    expect(existsSync(path.join(dataDir, 'profiles', 'cloak', 'alice'))).toBe(false);
  });

  it('refuses an existing destination without overwriting or merging it', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    const targetDir = path.join(dataDir, 'profiles', 'cloak', 'alice');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'keep.txt'), 'pre-existing');

    const message = expectFailure(run({ from: 'default', to: 'alice', dataDir }), 'destination-exists');
    expect(message).toContain('already exists');
    expect(readdirSync(targetDir)).toEqual(['keep.txt']);
    expect(readFileSync(path.join(targetDir, 'keep.txt'), 'utf8')).toBe('pre-existing');
  });

  it('refuses the same profile as source and destination', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    expectFailure(run({ from: 'default', to: 'default', dataDir }), 'same-profile');
  });

  it('refuses a source whose lock names a live process', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir, process.pid);
    const message = expectFailure(run({ from: 'default', to: 'alice', dataDir }), 'source-locked');
    expect(message).toContain(`pid ${process.pid}`);
    expect(message).toContain('Close the browser');
    expect(message).toContain('The profile was not copied.');
    expect(existsSync(path.join(dataDir, 'profiles', 'cloak', 'alice'))).toBe(false);
  });

  it('refuses a lock file that cannot be read', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    writeFileSync(path.join(dataDir, 'profiles', 'default', LOCK_FILENAME), 'not json');
    const message = expectFailure(run({ from: 'default', to: 'alice', dataDir }), 'source-locked');
    expect(message).toContain('has a lock file that cannot be read');
    expect(message).toContain(LOCK_FILENAME);
    expect(existsSync(path.join(dataDir, 'profiles', 'cloak', 'alice'))).toBe(false);
  });

  it('refuses an engine that has no account profiles', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    const message = expectFailure(
      run({ engine: 'kameleo', from: 'default', to: 'alice', dataDir }),
      'engine-no-profiles',
    );
    expect(message).toContain('profileApplies: false');
  });

  it('refuses an unknown engine and lists the supported ones', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    const message = expectFailure(
      run({ engine: 'no-such-engine', from: 'default', to: 'alice', dataDir }),
      'unknown-engine',
    );
    expect(message).toContain('Supported engines:');
    expect(message).toContain('cloak');
  });
});

describe('profile-copy behaviour', () => {
  it('copies identity files and leaves every excluded class behind', () => {
    const dataDir = tempRoot();
    const expectedBytes = createCloakFixture(dataDir);
    const result = run({ from: 'default', to: 'alice', dataDir, contents: 'full' });
    expect(result.ok).toBe(true);
    const summary = result.summary!;
    expect(summary).toMatchObject({
      ok: true,
      dryRun: false,
      engine: 'cloak',
      engineSource: 'setting',
      from: 'default',
      to: 'alice',
      // 2.20.0: the fixture's database -shm is no longer copied (the WAL still is),
      // so one planned file moves from "copied" to "excluded".
      copied: { files: 8, directories: 2, bytes: expectedBytes },
      excluded: {
        entries: 21,
        byRule: {
          profileLock: 1,
          engineLock: 1,
          singleton: 3,
          cache: 12,
          metrics: 1,
          thumbnails: 0,
          temporary: 1,
          logs: 1,
          lock: 0,
          shm: 1,
        },
      },
      skipped: { symlinks: 0, other: 0 },
      sourceLock: { state: 'stale', owner: { pid: DEAD_PID } },
      sourceEngineLock: {
        state: 'stale',
        file: 'lockfile',
        liveness: 'exclusive-open-write',
        owner: null,
      },
    });
    expect(summary.sourceEngineLock?.path).toBe(path.join(dataDir, 'profiles', 'default', 'lockfile'));

    const targetDir = summary.targetDir;
    for (const relative of [
      'Cookies',
      path.join('Default', 'Network', 'Cookies'),
      path.join('Default', 'Network', 'Cookies.sqlite-wal'),
      path.join('Default', 'Login Data'),
      path.join('Default', 'Preferences'),
      'Local State',
      'Preferences',
      '.cloakbrowser-seed',
    ]) {
      expect(existsSync(path.join(targetDir, relative))).toBe(true);
    }
    expect(readFileSync(path.join(targetDir, 'Cookies'), 'utf8')).toContain(SECRET_COOKIE);
    expect(readFileSync(path.join(targetDir, '.cloakbrowser-seed'), 'utf8')).toBe(SECRET_SEED);
    expect(readFileSync(path.join(targetDir, 'Default', 'Network', 'Cookies.sqlite-wal'), 'utf8')).toBe(
      'wal-part-of-db',
    );

    for (const relative of [
      LOCK_FILENAME,
      'lockfile',
      'SingletonLock',
      'SingletonSocket',
      'SingletonCookie',
      'Cache',
      'Code Cache',
      'GPUCache',
      'GrShaderCache',
      'GraphiteDawnCache',
      'DawnCache',
      'ShaderCache',
      'Crashpad',
      'BrowserMetrics',
      'scratch.tmp',
      'logs',
      path.join('Default', 'Cache'),
      path.join('Default', 'GPUCache'),
      path.join('Default', 'DawnCache'),
      path.join('Default', 'DawnGraphiteCache'),
      path.join('Default', 'DawnWebGPUCache'),
      path.join('Default', 'Network', 'Cookies.sqlite-shm'),
    ]) {
      expect(existsSync(path.join(targetDir, relative))).toBe(false);
    }
    // The engine-specific report names what this engine's tree carried, merging
    // the same name at different depths.
    expect(summary.excluded.names).toEqual([
      { name: 'lockfile', rule: 'engineLock', count: 1 },
      { name: 'Cache', rule: 'cache', count: 2 },
      { name: 'Code Cache', rule: 'cache', count: 1 },
      { name: 'Crashpad', rule: 'cache', count: 1 },
      { name: 'DawnCache', rule: 'cache', count: 1 },
      { name: 'DawnGraphiteCache', rule: 'cache', count: 1 },
      { name: 'DawnWebGPUCache', rule: 'cache', count: 1 },
      { name: 'GPUCache', rule: 'cache', count: 2 },
      { name: 'GraphiteDawnCache', rule: 'cache', count: 1 },
      { name: 'GrShaderCache', rule: 'cache', count: 1 },
      { name: 'ShaderCache', rule: 'cache', count: 1 },
      { name: 'BrowserMetrics', rule: 'metrics', count: 1 },
    ]);
    // The source is never touched by the copy.
    expect(existsSync(path.join(dataDir, 'profiles', 'default', 'Cookies'))).toBe(true);
    expect(existsSync(path.join(dataDir, 'profiles', 'default', LOCK_FILENAME))).toBe(true);
    expect(existsSync(path.join(dataDir, 'profiles', 'default', 'lockfile'))).toBe(true);
  });

  it('plans a dry run without creating anything, with the same counts as the copy', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    const targetDir = path.join(dataDir, 'profiles', 'cloak', 'alice');

    const dry = run({ from: 'default', to: 'alice', dataDir, dryRun: true, contents: 'full' }).summary!;
    expect(dry.dryRun).toBe(true);
    expect(dry.targetDir).toBe(targetDir);
    expect(existsSync(targetDir)).toBe(false);
    expect(dry.topLevel.some((entry) => entry.path === 'Cache' && entry.excluded === 'cache')).toBe(true);
    expect(dry.topLevel.some((entry) => entry.path === 'Cookies' && entry.excluded === null)).toBe(true);

    const real = run({ from: 'default', to: 'alice', dataDir, contents: 'full' }).summary!;
    expect(real.copied).toEqual(dry.copied);
    expect(real.excluded).toEqual(dry.excluded);
    expect(real.topLevel).toEqual(dry.topLevel);
    expect(existsSync(targetDir)).toBe(true);
  });

  it('reports the default data root from CLAUDE_PLUGIN_DATA and lets --data-dir win', () => {
    const dataDir = tempRoot();
    const otherDir = tempRoot();
    createCloakFixture(dataDir);
    createCloakFixture(otherDir);

    const fromEnv = run({
      from: 'default',
      to: 'from-env',
      dataDir: null,
      env: { CLAUDE_PLUGIN_DATA: dataDir },
      home: otherDir,
    });
    expect(fromEnv.ok).toBe(true);
    expect(fromEnv.summary?.targetDir).toBe(path.join(dataDir, 'profiles', 'cloak', 'from-env'));

    const explicit = run({
      from: 'default',
      to: 'explicit-wins',
      dataDir: otherDir,
      env: { CLAUDE_PLUGIN_DATA: dataDir },
      home: dataDir,
    });
    expect(explicit.ok).toBe(true);
    expect(explicit.summary?.targetDir).toBe(path.join(otherDir, 'profiles', 'cloak', 'explicit-wins'));
    expect(existsSync(path.join(dataDir, 'profiles', 'cloak', 'explicit-wins'))).toBe(false);
  });

  it('maps "default" exactly as the broker does, per engine', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    // The shared launcher keeps profiles/default for cloak and playwright.
    const cloak = run({ engine: 'playwright', from: 'default', to: 'pw', dataDir });
    expect(cloak.ok).toBe(true);
    expect(cloak.summary?.sourceDir).toBe(path.join(dataDir, 'profiles', 'default'));
    expect(cloak.summary?.targetDir).toBe(path.join(dataDir, 'profiles', 'playwright', 'pw'));

    // Camoufox has its own launcher, so its default is profiles/camoufox/default.
    const camoufoxData = tempRoot();
    write(path.join(camoufoxData, 'profiles', 'camoufox', 'default'), 'Cookies', 'cookie-jar');
    write(path.join(camoufoxData, 'profiles', 'camoufox', 'default'), '.cloakbrowser-seed', 'seed');
    const camoufox = run({ engine: 'camoufox', from: 'default', to: 'alice', dataDir: camoufoxData });
    expect(camoufox.ok).toBe(true);
    expect(camoufox.summary?.sourceDir).toBe(path.join(camoufoxData, 'profiles', 'camoufox', 'default'));
    expect(camoufox.summary?.targetDir).toBe(path.join(camoufoxData, 'profiles', 'camoufox', 'alice'));
  });

  it('works from the camoufox plugin and refuses its absent default engine', () => {
    const dataDir = tempRoot();
    write(path.join(dataDir, 'profiles', 'camoufox', 'default'), 'Cookies', 'cookie-jar');
    write(path.join(dataDir, 'profiles', 'camoufox', 'default'), '.cloakbrowser-seed', 'seed');

    const wrong = camoufoxCopy.runProfileCopy({ from: 'default', to: 'alice', dataDir });
    expect(wrong.ok).toBe(false);
    expect(wrong.error?.code).toBe('unknown-engine');
    expect(wrong.error?.message).toContain('Supported engines: camoufox');

    const right = camoufoxCopy.runProfileCopy({
      engine: 'camoufox',
      from: 'default',
      to: 'alice',
      dataDir,
      contents: 'full',
    });
    expect(right.ok).toBe(true);
    expect(right.summary?.targetDir).toBe(path.join(dataDir, 'profiles', 'camoufox', 'alice'));
    expect(existsSync(path.join(dataDir, 'profiles', 'camoufox', 'alice', 'Cookies'))).toBe(true);
  });
});

describe('engine identification', () => {
  const ids = ['cloak', 'playwright', 'camoufox'];

  it('detects the engine only when the path proves it', () => {
    const dataDir = path.resolve(tempRoot(), 'data');
    const under = (...segments: string[]) => path.join(dataDir, 'profiles', ...segments);
    expect(profileCopy.detectEngineFromProfilePath(under('cloak', 'alice'), dataDir, ids)).toBe('cloak');
    expect(profileCopy.detectEngineFromProfilePath(under('camoufox', 'default'), dataDir, ids)).toBe(
      'camoufox',
    );
    expect(profileCopy.detectEngineFromProfilePath(under('playwright', 'ws-abc1234'), dataDir, ids)).toBe(
      'playwright',
    );
    // The legacy shared Chromium default has no engine segment.
    expect(profileCopy.detectEngineFromProfilePath(under('default'), dataDir, ids)).toBeNull();
    expect(profileCopy.detectEngineFromProfilePath(under('ws-abc1234'), dataDir, ids)).toBeNull();
    // The profiles root itself, an unknown first segment and anything outside
    // the data root are never guessed.
    expect(profileCopy.detectEngineFromProfilePath(under(), dataDir, ids)).toBeNull();
    expect(profileCopy.detectEngineFromProfilePath(under('nope', 'alice'), dataDir, ids)).toBeNull();
    expect(
      profileCopy.detectEngineFromProfilePath(
        path.join(dataDir, 'elsewhere', 'cloak', 'alice'),
        dataDir,
        ids,
      ),
    ).toBeNull();
    expect(profileCopy.detectEngineFromProfilePath(dataDir, dataDir, ids)).toBeNull();
    // Missing inputs are not an error, they are "no proof".
    expect(profileCopy.detectEngineFromProfilePath('', dataDir, ids)).toBeNull();
    expect(profileCopy.detectEngineFromProfilePath(under('cloak', 'alice'), '', ids)).toBeNull();
    expect(
      profileCopy.detectEngineFromProfilePath(under('cloak', 'alice'), dataDir, null as never),
    ).toBeNull();
  });

  it('confirms the explicit engine with the path and refuses a disagreement', () => {
    const dataDir = path.resolve(tempRoot(), 'data');
    const matching = profileCopy.resolveCopyEngine({
      requestedEngine: 'cloak',
      sourceDir: path.join(dataDir, 'profiles', 'cloak', 'alice'),
      dataDir,
      engineIds: ids,
    });
    expect(matching).toEqual({ engineId: 'cloak', source: 'path', error: null });
    const legacy = profileCopy.resolveCopyEngine({
      requestedEngine: 'cloak',
      sourceDir: path.join(dataDir, 'profiles', 'default'),
      dataDir,
      engineIds: ids,
    });
    expect(legacy).toEqual({ engineId: 'cloak', source: 'setting', error: null });
    const mismatch = profileCopy.resolveCopyEngine({
      requestedEngine: 'cloak',
      sourceDir: path.join(dataDir, 'profiles', 'camoufox', 'alice'),
      dataDir,
      engineIds: ids,
    });
    expect(mismatch.engineId).toBeNull();
    expect(mismatch.source).toBeNull();
    expect(String(mismatch.error)).toContain('is a "camoufox" profile');
    expect(String(mismatch.error)).toContain('--engine is "cloak"');
    expect(String(mismatch.error)).toContain('--engine camoufox');
    // The default engine is cloak when none is supplied.
    expect(
      profileCopy.resolveCopyEngine({
        sourceDir: path.join(dataDir, 'profiles', 'default'),
        dataDir,
        engineIds: ids,
      }).engineId,
    ).toBe('cloak');
  });

  it('reports how the engine was identified in the summary', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    write(path.join(dataDir, 'profiles', 'cloak', 'alice'), 'Cookies', 'named-account');
    const legacy = run({ from: 'default', to: 'legacy-copy', dataDir });
    expect(legacy.ok).toBe(true);
    expect(legacy.summary?.engineSource).toBe('setting');
    const account = run({ from: 'alice', to: 'alice-copy', dataDir });
    expect(account.ok).toBe(true);
    expect(account.summary?.engineSource).toBe('path');
    expect(account.summary?.sourceDir).toBe(path.join(dataDir, 'profiles', 'cloak', 'alice'));
  });
});

describe('camoufox exclusions', () => {
  it('excludes Firefox caches, thumbnails and parent.lock, keeps the WAL and drops the SHM', () => {
    const dataDir = tempRoot();
    createCamoufoxFixture(dataDir);
    const result = run({ engine: 'camoufox', from: 'default', to: 'alice', dataDir, contents: 'full' });
    expect(result.ok).toBe(true);
    const summary = result.summary!;
    expect(summary).toMatchObject({
      engine: 'camoufox',
      engineSource: 'path',
      // 2.20.0: cookies.sqlite-shm is excluded (the -wal beside it is kept).
      copied: { files: 4, directories: 0 },
      excluded: {
        entries: 5,
        byRule: { engineLock: 1, cache: 2, thumbnails: 1, lock: 0, shm: 1 },
      },
      sourceEngineLock: {
        state: 'stale',
        file: 'parent.lock',
        liveness: 'exclusive-open',
        owner: null,
      },
    });
    expect(summary.excluded.names).toEqual([
      { name: 'parent.lock', rule: 'engineLock', count: 1 },
      { name: 'cache2', rule: 'cache', count: 1 },
      { name: 'startupCache', rule: 'cache', count: 1 },
      { name: 'thumbnails', rule: 'thumbnails', count: 1 },
    ]);
    const targetDir = summary.targetDir;
    for (const kept of ['cookies.sqlite', 'cookies.sqlite-wal', 'prefs.js', '.cloakbrowser-seed']) {
      expect(existsSync(path.join(targetDir, kept))).toBe(true);
    }
    for (const gone of ['parent.lock', 'cache2', 'startupCache', 'thumbnails', 'cookies.sqlite-shm']) {
      expect(existsSync(path.join(targetDir, gone))).toBe(false);
    }
    const human = profileCopy.formatHumanSummary(summary);
    expect(human).toContain(
      'engine-specific exclusions: parent.lock 1, cache2 1, startupCache 1, thumbnails 1',
    );
  });
});

describe('live engine-lock refusals', () => {
  it('refuses a Chromium source whose lock descriptor names a live pid', () => {
    const dataDir = tempRoot();
    const pluginRoot = createPidLockPluginRoot(tempRoot(), 'cloak');
    createCloakFixture(dataDir);
    write(path.join(dataDir, 'profiles', 'default'), 'owner.lock', `${process.pid}\n`);

    const message = expectFailure(
      run({ from: 'default', to: 'alice', dataDir, pluginRoot }),
      'source-locked',
    );
    expect(message).toContain('is already in use');
    expect(message).toContain(`pid ${process.pid}`);
    expect(message).toContain('The profile was not copied.');
    expect(message).not.toContain('The backend was not started.');
    expect(existsSync(path.join(dataDir, 'profiles', 'cloak', 'alice'))).toBe(false);
  });

  it('refuses a Camoufox source whose lock descriptor names a live pid', () => {
    const dataDir = tempRoot();
    const pluginRoot = createPidLockPluginRoot(tempRoot(), 'camoufox');
    createCamoufoxFixture(dataDir);
    write(path.join(dataDir, 'profiles', 'camoufox', 'default'), 'owner.lock', `${process.pid}\n`);

    const message = expectFailure(
      run({ engine: 'camoufox', from: 'default', to: 'alice', dataDir, pluginRoot }),
      'source-locked',
    );
    expect(message).toContain(`pid ${process.pid}`);
    expect(message).toContain('The profile was not copied.');
    expect(existsSync(path.join(dataDir, 'profiles', 'camoufox', 'alice'))).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')(
    'refuses a Chromium profile while a real process holds lockfile, then copies once it exits',
    async () => {
      const dataDir = tempRoot();
      createCloakFixture(dataDir);
      const lockPath = path.join(dataDir, 'profiles', 'default', 'lockfile');
      const holder = await holdExclusiveForRead(lockPath);
      holders.push(holder);

      const message = expectFailure(run({ from: 'default', to: 'alice', dataDir }), 'source-locked');
      expect(message).toContain(lockPath);
      expect(message).toContain('another process holds the engine lock file');
      expect(message).toContain('The profile was not copied.');
      expect(existsSync(path.join(dataDir, 'profiles', 'cloak', 'alice'))).toBe(false);

      await holder.stop();
      const after = run({ from: 'default', to: 'alice', dataDir });
      expect(after.ok).toBe(true);
      expect(after.summary?.sourceEngineLock?.state).toBe('stale');
      expect(existsSync(path.join(after.summary!.targetDir, 'lockfile'))).toBe(false);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'refuses a Camoufox profile while a real process holds parent.lock, then copies once it exits',
    async () => {
      const dataDir = tempRoot();
      createCamoufoxFixture(dataDir);
      const lockPath = path.join(dataDir, 'profiles', 'camoufox', 'default', 'parent.lock');
      const holder = await holdExclusiveForRead(lockPath, 'None');
      holders.push(holder);

      const message = expectFailure(
        run({ engine: 'camoufox', from: 'default', to: 'alice', dataDir }),
        'source-locked',
      );
      expect(message).toContain(lockPath);
      expect(message).toContain('another process holds the engine lock file');
      expect(message).toContain('The profile was not copied.');
      expect(existsSync(path.join(dataDir, 'profiles', 'camoufox', 'alice'))).toBe(false);

      await holder.stop();
      const after = run({ engine: 'camoufox', from: 'default', to: 'alice', dataDir });
      expect(after.ok).toBe(true);
      expect(after.summary?.sourceEngineLock?.state).toBe('stale');
      expect(existsSync(path.join(after.summary!.targetDir, 'parent.lock'))).toBe(false);
    },
  );
});

describe('behaviour-preserving equality', () => {
  it('copies an ordinary unlocked profile with no new exclusions', () => {
    const dataDir = tempRoot();
    const profile = path.join(dataDir, 'profiles', 'default');
    write(profile, 'Cookies', 'SQLite format 3\0plain-cookies');
    write(profile, 'Local State', '{"plain":true}');
    write(profile, 'Preferences', '{"plain":true}');
    write(profile, '.cloakbrowser-seed', '12345');
    writeLock(profile, DEAD_PID);
    const expectedBytes = [
      'SQLite format 3\0plain-cookies',
      '{"plain":true}',
      '{"plain":true}',
      '12345',
    ].reduce((total, content) => total + Buffer.byteLength(content), 0);

    const result = run({ from: 'default', to: 'alice', dataDir, contents: 'full' });
    expect(result.ok).toBe(true);
    const summary = result.summary!;
    expect(summary.copied).toEqual({ files: 4, directories: 0, bytes: expectedBytes });
    expect(summary.excluded).toEqual({
      entries: 1,
      byRule: {
        profileLock: 1,
        engineLock: 0,
        singleton: 0,
        cache: 0,
        metrics: 0,
        thumbnails: 0,
        temporary: 0,
        logs: 0,
        lock: 0,
        shm: 0,
      },
      names: [],
    });
    expect(summary.sourceEngineLock).toMatchObject({ state: 'free', file: 'lockfile' });
    const human = profileCopy.formatHumanSummary(summary);
    expect(human).toContain('engine-specific exclusions: none');
  });
});

describe('profile-copy failure cleanup', () => {
  it('removes the destination and the parent directories this run created', () => {
    const root = tempRoot();
    const targetDir = path.join(root, 'profiles', 'cloak', 'alice');
    const plan: CopyPlan = {
      directories: ['Default'],
      files: [{ source: path.join(root, 'gone', 'missing.txt'), relative: path.join('Default', 'x') }],
    };
    expect(() => profileCopy.copyPlanToTarget(plan, targetDir)).toThrow(/Copying the profile failed/);
    expect(existsSync(targetDir)).toBe(false);
    expect(existsSync(path.join(root, 'profiles', 'cloak'))).toBe(false);
    expect(existsSync(path.join(root, 'profiles'))).toBe(false);
  });

  it('keeps a pre-existing parent and its other entries', () => {
    const root = tempRoot();
    const parent = path.join(root, 'profiles', 'cloak');
    mkdirSync(parent, { recursive: true });
    writeFileSync(path.join(parent, 'someone-else.txt'), 'keep');
    const targetDir = path.join(parent, 'alice');
    const plan: CopyPlan = {
      directories: [],
      files: [{ source: path.join(root, 'gone.txt'), relative: 'x' }],
    };
    expect(() => profileCopy.copyPlanToTarget(plan, targetDir)).toThrow(/Copying the profile failed/);
    expect(existsSync(targetDir)).toBe(false);
    expect(readdirSync(parent)).toEqual(['someone-else.txt']);
  });

  it('never deletes a destination another writer created', () => {
    const root = tempRoot();
    const targetDir = path.join(root, 'profiles', 'cloak', 'alice');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'other.txt'), 'keep');
    expect(() => profileCopy.copyPlanToTarget({ directories: [], files: [] }, targetDir)).toThrow(
      /already exists/,
    );
    expect(readdirSync(targetDir)).toEqual(['other.txt']);
  });
});

describe('the identity tier is the default (2.21.0)', () => {
  it('copies the identity core by default and reports where the tier came from', () => {
    const dataDir = tempRoot();
    const expectedBytes = createCloakFixture(dataDir);
    const result = run({ from: 'default', to: 'alice', dataDir });
    expect(result.ok).toBe(true);
    const summary = result.summary!;
    // The default is the identity tier, and the summary says so.
    expect(summary.contents).toBe('identity');
    expect(summary.contentsSource).toBe('default');
    // It copies strictly fewer files than the full plan of the same fixture.
    const full = run({ from: 'default', to: 'alice-full', dataDir, contents: 'full' });
    expect(full.summary?.contents).toBe('full');
    expect(full.summary?.contentsSource).toBe('option');
    expect(summary.copied.files).toBeLessThan(full.summary!.copied.files);
    expect(summary.copied.files).toBeGreaterThan(0);
    expect(expectedBytes).toBeGreaterThan(0);
  });

  it('honours --contents and the copy_contents setting, in that order', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    const fromSetting = run({
      from: 'default',
      to: 'alice',
      dataDir,
      env: { STEALTH_COPY_CONTENTS: 'full' },
    });
    expect(fromSetting.summary?.contents).toBe('full');
    expect(fromSetting.summary?.contentsSource).toBe('setting');
    const fromOption = run({
      from: 'default',
      to: 'bob',
      dataDir,
      contents: 'identity',
      env: { STEALTH_COPY_CONTENTS: 'full' },
    });
    expect(fromOption.summary?.contents).toBe('identity');
    expect(fromOption.summary?.contentsSource).toBe('option');
  });
});

describe('profile-copy output', () => {
  it('prints a machine-readable JSON summary and nothing else', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    const cli = runCli([
      '--from',
      'default',
      '--to',
      'json-target',
      '--data-dir',
      dataDir,
      '--contents',
      'full',
      '--json',
    ]);
    expect(cli.status).toBe(0);
    expect(cli.stderr).toBe('');
    const parsed = JSON.parse(cli.stdout) as CopySummary;
    expect(parsed).toMatchObject({ ok: true, dryRun: false, engine: 'cloak', from: 'default' });
    // 2.20.0: the database -shm is excluded, so one planned file fewer is copied.
    expect(parsed.copied.files).toBe(8);
    expect(parsed.excluded.byRule.cache).toBe(12);
    expect(parsed.excluded.byRule.engineLock).toBe(1);
    expect(parsed.excluded.byRule.metrics).toBe(1);
    expect(parsed.excluded.byRule.shm).toBe(1);
  });

  it('prints a JSON error object with a non-zero exit code', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    const cli = runCli(['--from', 'nobody', '--to', 'alice', '--data-dir', dataDir, '--json']);
    expect(cli.status).toBe(1);
    expect(cli.stderr).toBe('');
    const parsed = JSON.parse(cli.stdout) as CopyResult;
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe('source-missing');
  });

  it('never prints file contents or a URL credential', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    const summary = run({ from: 'default', to: 'alice', dataDir, contents: 'full' }).summary!;
    const human = profileCopy.formatHumanSummary(summary);
    const json = JSON.stringify(summary);
    for (const text of [human, json]) {
      expect(text).not.toContain(SECRET_COOKIE);
      expect(text).not.toContain(SECRET_SEED);
    }
    expect(human).toContain('Copied profile "default" to "alice" (engine cloak).');
    expect(human).toContain(`files: 8 (${summary.copied.bytes} bytes`);
    expect(human).toContain(
      'engine-specific exclusions: lockfile 1, Cache 2, Code Cache 1, Crashpad 1, DawnCache 1',
    );
    expect(human).toContain('stale engine lock ignored');
    expect(human).toContain('A copy carries no session cookies');
    expect(human).toContain('stale lock ignored');
    expect(human).toContain('The per-account <name>.proxy file was not copied');

    const cli = runCli(['--from', 'default', '--to', 'other', '--data-dir', dataDir, '--contents', 'full']);
    expect(cli.status).toBe(0);
    expect(cli.stdout).not.toContain(SECRET_COOKIE);
    expect(cli.stdout).not.toContain(SECRET_SEED);

    const secretName = 'http://user:TOPSECRET@host/path';
    const invalid = run({ from: secretName, to: 'alice', dataDir });
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.message).not.toContain('TOPSECRET');
    expect(invalid.error?.message).toContain('http://***@host');
  });
});
