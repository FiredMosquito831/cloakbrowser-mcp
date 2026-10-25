import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  from: string;
  to: string;
  sourceDir: string;
  targetDir: string;
  copied: { files: number; directories: number; bytes: number };
  excluded: { entries: number; byRule: Record<string, number> };
  skipped: { symlinks: number; other: number };
  topLevel: {
    path: string;
    type: string;
    files: number;
    bytes: number;
    excluded: string | null;
  }[];
  sourceLock: { state: string; owner: { pid: number; createdAt: string | null } | null };
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
  exclusionRule(name: string, isDirectory: boolean): string | null;
  parseArguments(argv: string[]): { options: Record<string, unknown>; errors: string[] };
  runProfileCopy(options?: CopyOptions): CopyResult;
  copyPlanToTarget(plan: CopyPlan, targetDir: string, options?: { targetName?: string }): void;
  formatHumanSummary(summary: CopySummary): string;
}

const scriptPath = fileURLToPath(
  new URL('../../plugins/cloakbrowser/scripts/profile-copy.mjs', import.meta.url),
);
const profileCopy = (await import(
  new URL('../../plugins/cloakbrowser/scripts/profile-copy.mjs', import.meta.url).href
)) as unknown as ProfileCopyModule;
const camoufoxCopy = (await import(
  new URL('../../plugins/camoufox/scripts/profile-copy.mjs', import.meta.url).href
)) as unknown as ProfileCopyModule;

// A PID that is guaranteed gone: spawn a short process, wait for its exit, then
// use its PID for the stale-lock fixture.
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['--version'], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('could not spawn a short-lived process');
  }
  await new Promise<void>((resolve, reject) => {
    child.on('exit', () => resolve());
    child.on('error', reject);
  });
  return pid;
}

const DEAD_PID = await exitedPid();

const SECRET_COOKIE = 'COOKIE-SECRET-6f2a';
const SECRET_SEED = 'SEED-SECRET-9c1b';
const LOCK_FILENAME = '.cloakbrowser-mcp-profile.lock';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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

// The full cloak fixture: identity files that must survive, and every excluded
// class. Returns the expected kept byte count.
function createCloakFixture(dataDir: string, lockPid: number = DEAD_PID): number {
  const profile = path.join(dataDir, 'profiles', 'default');
  write(profile, 'Cookies', `SQLite format 3\0${SECRET_COOKIE}`);
  write(profile, 'Default/Network/Cookies', `SQLite format 3\0${SECRET_COOKIE}-nested`);
  write(profile, 'Default/Login Data', 'SQLite format 3\0login-db');
  write(profile, 'Default/Preferences', '{"homepage":"about:blank"}');
  write(profile, 'Local State', '{"profile":{"info_cache":{}}}');
  write(profile, 'Preferences', '{"account_id":"fixture"}');
  write(profile, '.cloakbrowser-seed', SECRET_SEED);
  // Excluded: caches at the root and below Default.
  write(profile, 'Cache/data_0', 'cache');
  write(profile, 'Default/Cache/data_1', 'cache');
  write(profile, 'Code Cache/js/index', 'code-cache');
  write(profile, 'GPUCache/data_0', 'gpu');
  write(profile, 'Default/GPUCache/data_0', 'gpu');
  write(profile, 'GrShaderCache/data_0', 'gr');
  write(profile, 'GraphiteDawnCache/data_0', 'graphite');
  write(profile, 'Default/DawnCache/data_0', 'dawn');
  write(profile, 'ShaderCache/data_0', 'shader');
  write(profile, 'Crashpad/reports/one.dmp', 'crash');
  // Excluded: temporary entry, log directory, Chromium singletons, profile lock.
  write(profile, 'scratch.tmp', 'temporary');
  write(profile, 'logs/browser.log', 'log-line');
  write(profile, 'SingletonLock', 'host-12345');
  write(profile, 'SingletonSocket', 'socket');
  write(profile, 'SingletonCookie', '123456789');
  writeLock(profile, lockPid);

  return [
    `SQLite format 3\0${SECRET_COOKIE}`,
    `SQLite format 3\0${SECRET_COOKIE}-nested`,
    'SQLite format 3\0login-db',
    '{"homepage":"about:blank"}',
    '{"profile":{"info_cache":{}}}',
    '{"account_id":"fixture"}',
    SECRET_SEED,
  ].reduce((total, content) => total + Buffer.byteLength(content), 0);
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
      'ShaderCache',
      'Crashpad',
    ]) {
      expect(profileCopy.exclusionRule(name, true)).toBe('cache');
    }
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
    const result = run({ from: 'default', to: 'alice', dataDir });
    expect(result.ok).toBe(true);
    const summary = result.summary!;
    expect(summary).toMatchObject({
      ok: true,
      dryRun: false,
      engine: 'cloak',
      from: 'default',
      to: 'alice',
      copied: { files: 7, directories: 2, bytes: expectedBytes },
      excluded: {
        entries: 16,
        byRule: { profileLock: 1, singleton: 3, cache: 10, temporary: 1, logs: 1 },
      },
      skipped: { symlinks: 0, other: 0 },
      sourceLock: { state: 'stale', owner: { pid: DEAD_PID } },
    });

    const targetDir = summary.targetDir;
    for (const relative of [
      'Cookies',
      path.join('Default', 'Network', 'Cookies'),
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

    for (const relative of [
      LOCK_FILENAME,
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
      'scratch.tmp',
      'logs',
      path.join('Default', 'Cache'),
      path.join('Default', 'GPUCache'),
      path.join('Default', 'DawnCache'),
    ]) {
      expect(existsSync(path.join(targetDir, relative))).toBe(false);
    }
    // The source is never touched by the copy.
    expect(existsSync(path.join(dataDir, 'profiles', 'default', 'Cookies'))).toBe(true);
    expect(existsSync(path.join(dataDir, 'profiles', 'default', LOCK_FILENAME))).toBe(true);
  });

  it('plans a dry run without creating anything, with the same counts as the copy', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    const targetDir = path.join(dataDir, 'profiles', 'cloak', 'alice');

    const dry = run({ from: 'default', to: 'alice', dataDir, dryRun: true }).summary!;
    expect(dry.dryRun).toBe(true);
    expect(dry.targetDir).toBe(targetDir);
    expect(existsSync(targetDir)).toBe(false);
    expect(dry.topLevel.some((entry) => entry.path === 'Cache' && entry.excluded === 'cache')).toBe(true);
    expect(dry.topLevel.some((entry) => entry.path === 'Cookies' && entry.excluded === null)).toBe(true);

    const real = run({ from: 'default', to: 'alice', dataDir }).summary!;
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

    const right = camoufoxCopy.runProfileCopy({ engine: 'camoufox', from: 'default', to: 'alice', dataDir });
    expect(right.ok).toBe(true);
    expect(right.summary?.targetDir).toBe(path.join(dataDir, 'profiles', 'camoufox', 'alice'));
    expect(existsSync(path.join(dataDir, 'profiles', 'camoufox', 'alice', 'Cookies'))).toBe(true);
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

describe('profile-copy output', () => {
  it('prints a machine-readable JSON summary and nothing else', () => {
    const dataDir = tempRoot();
    createCloakFixture(dataDir);
    const cli = runCli(['--from', 'default', '--to', 'json-target', '--data-dir', dataDir, '--json']);
    expect(cli.status).toBe(0);
    expect(cli.stderr).toBe('');
    const parsed = JSON.parse(cli.stdout) as CopySummary;
    expect(parsed).toMatchObject({ ok: true, dryRun: false, engine: 'cloak', from: 'default' });
    expect(parsed.copied.files).toBe(7);
    expect(parsed.excluded.byRule.cache).toBe(10);
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
    const summary = run({ from: 'default', to: 'alice', dataDir }).summary!;
    const human = profileCopy.formatHumanSummary(summary);
    const json = JSON.stringify(summary);
    for (const text of [human, json]) {
      expect(text).not.toContain(SECRET_COOKIE);
      expect(text).not.toContain(SECRET_SEED);
    }
    expect(human).toContain('Copied profile "default" to "alice" (engine cloak).');
    expect(human).toContain(`files: 7 (${summary.copied.bytes} bytes`);
    expect(human).toContain('stale lock ignored');
    expect(human).toContain('The per-account <name>.proxy file was not copied');

    const cli = runCli(['--from', 'default', '--to', 'other', '--data-dir', dataDir]);
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
