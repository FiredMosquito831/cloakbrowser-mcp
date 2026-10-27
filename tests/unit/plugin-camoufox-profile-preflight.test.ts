// Camoufox profile preflight (2.9.4).
//
// The bridge's own lock file is not the only lock a persistent profile carries:
// Firefox writes <profile>/parent.lock, and the Camoufox wrapper never writes the
// bridge lock at all. A manifest can now declare its engine's lock file, and the
// broker refuses a start a live owner would fail (a 180 s hang or an
// exitCode=0 launch failure), while a leftover lock from an exited browser is
// reported as stale and allowed.
//
// The live owner is proven two ways because the real files differ. The Windows
// Firefox lock is a zero-byte file the OS refuses to open while the browser runs
// (EBUSY on this machine), so it carries no process id; a lock file that does
// carry a pid is checked with process.kill(pid, 0). Both rules are exercised.
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync as originalReadFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A lock file the OS refuses to open cannot be produced portably (Windows only),
// so the error mapping is exercised by injecting the exact error Node reported
// for the real Firefox lock: EBUSY "resource busy or locked". Every other read
// in this file goes to the real fs. The write-open probe (Chromium's lockfile)
// gets its own injected fault the same way, and a real exclusive Windows handle
// covers it end to end where the platform allows it.
const faults = vi.hoisted(() => ({
  unreadablePath: '',
  unreadableCode: '',
  unopenablePath: '',
  unopenableCode: '',
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  const readFileSync = (file: string, options: BufferEncoding): string => {
    if (faults.unreadablePath !== '' && String(file) === faults.unreadablePath) {
      const error = new Error(`Injected ${faults.unreadableCode}`);
      Object.assign(error, { code: faults.unreadableCode });
      throw error;
    }
    return original.readFileSync(file, options);
  };
  const openSync = (file: string, flags: string) => {
    if (faults.unopenablePath !== '' && String(file) === faults.unopenablePath) {
      const error = new Error(`Injected ${faults.unopenableCode}`);
      Object.assign(error, { code: faults.unopenableCode });
      throw error;
    }
    return original.openSync(file, flags);
  };
  return { ...original, readFileSync, openSync };
});

interface EngineLock {
  profileDir: string;
  path: string;
  file: string | null;
  liveness: string | null;
  state: 'free' | 'live' | 'stale' | 'unknown';
  owner: { pid: number | null; createdAt: string | null } | null;
  error: string | null;
}

interface ProfileModule {
  ENGINE_LOCK_OWNER_RULES: string[];
  readEngineProfileLock(
    profileDir: string,
    descriptor: { file?: string; owner?: string } | null | undefined,
  ): EngineLock;
  engineLockBlocksStart(lock: EngineLock): boolean;
  engineProfileLockFix(lock: EngineLock): string | null;
  engineProfileLockMessage(lock: EngineLock, options?: { trailing?: string }): string;
}

interface RegistryModule {
  validateManifest(
    manifest: unknown,
    expectedId: string,
    profileNames: string[],
    launcherDir?: string,
  ): string | null;
}

interface JsonRpcResponse {
  result?: {
    tools?: { name: string }[];
    structuredContent?: Record<string, unknown>;
    instructions?: string;
  };
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const profile = (await import(
  new URL('../../plugins/cloakbrowser/lib/profile.mjs', import.meta.url).href
)) as unknown as ProfileModule;
const registry = (await import(
  new URL('../../plugins/cloakbrowser/engine-registry.mjs', import.meta.url).href
)) as unknown as RegistryModule;

// The 2.9.3 cloak-engine payload keys, captured from a pristine broker built from
// origin/main 62c48cd with the same stub backend (.scratch/pr-camoufox-preflight/
// baseline/cloak-baseline.json). An engine that declares no profileLock must not
// gain an engineProfileLock key: the check is opt-in.
const CAPABILITIES_KEYS_293 = [
  'engine',
  'label',
  'contract',
  'transport',
  'toolProfile',
  'engineChoices',
  'engineSource',
  'engineError',
  'engineNotes',
  'howToChangeEngine',
  'backendToolCount',
  'browserToolCount',
  'localToolCount',
  'supportedToolCount',
  'supportedBrowserToolCount',
  'exposedToolCount',
  'metaToolCount',
  'metaTools',
  'backendCapabilities',
  'perToolSupport',
  'supportRules',
  'disabledTools',
  'hiddenByManifest',
  'hiddenByCollision',
  'requestedToolProfile',
  'toolProfileSource',
  'engineDefaultToolProfile',
  'availableToolProfiles',
  'portableToolNames',
  'perToolSupportNotes',
  'hiddenByProfile',
  'unavailableTools',
  'launch',
  'requirements',
  'ignoredSettings',
  'account',
  'profileDir',
  'profileSource',
  'defaultProfileDir',
  'availableAccounts',
  'availableAccountCount',
  'accountApplies',
  'proxySource',
  'proxyConfigured',
  'profileIsolation',
  'profileIsolationSource',
  'profileApplies',
  // 2.16.0 adds the resolved on_locked policy right after profileApplies on every
  // engine that uses the broker's profile model.
  'onLocked',
  'profileFallback',
  'profileLock',
];

// 2.9.5 appends four diagnostics keys to browser_capabilities for every engine:
// the server cwd, the effective artifact directory and the client roots, plus the
// reason when the roots probe could not read them. browser_engine_status is
// unchanged. The test clients declare no roots capability, so clientRootsError is
// present on every payload here.
// 2.10.0 appends the default-profile pointer facts last: the name, its source, the
// pointer file, and (only for a broken pointer) the reason. These synthetic
// engines have no pointer file, so profileDefaultError is absent here.
// 2.14.0 appends the six device-identity keys after the profile block for every
// engine; these synthetic engines cannot pin, so the note is always present.
// 2.14.1 appends the five server-heartbeat keys after them; none of these
// synthetic engines is `camoufox`, so they all report the not-applicable note.
const IDENTITY_KEYS_2140 = [
  'identityMode',
  'identityApplies',
  'identitySource',
  'identityFile',
  'identityCreatedAt',
  'identityNote',
];
const PING_TIMEOUT_KEYS_2141 = [
  'pingTimeoutApplies',
  'pingTimeoutMs',
  'pingTimeoutSource',
  'heartbeatEnabled',
  'pingTimeoutNote',
];
const CAPABILITIES_KEYS_295 = [
  ...CAPABILITIES_KEYS_293,
  ...IDENTITY_KEYS_2140,
  ...PING_TIMEOUT_KEYS_2141,
  'serverCwd',
  'outputDir',
  'clientRoots',
  'clientRootsError',
  'profileDefault',
  'profileDefaultSource',
  'profileDefaultPath',
];

const STATUS_KEYS_293 = [
  'engine',
  'label',
  'engineSource',
  'engineError',
  'transport',
  'contract',
  'toolProfile',
  'backendState',
  'backendPid',
  'backendVersion',
  'backendServerName',
  'lastError',
  'startupMs',
  'waitMs',
  'toolsListWaitMs',
  'pendingRequestCount',
  'uptimeMs',
  'backendToolCount',
  'exposedToolCount',
  'metaToolCount',
  'brokerVersion',
  'howToChangeEngine',
  'backendStderrTail',
  'account',
  'profileDir',
  'profileIsolation',
  'profileApplies',
  // 2.16.0 adds the resolved on_locked policy right after profileApplies.
  'onLocked',
  'profileFallback',
  'profileLock',
  ...IDENTITY_KEYS_2140,
  ...PING_TIMEOUT_KEYS_2141,
];

// 2.11.1 declares the Chromium lockfile for cloak and playwright, so those two
// engines gain the additive `engineProfileLock` key right after `profileLock`.
// An engine without a descriptor still produces exactly CAPABILITIES_KEYS_295 /
// STATUS_KEYS_293 (checked below with the synthetic plain engine).
function withEngineLock(keys: string[]): string[] {
  const copy = [...keys];
  copy.splice(copy.indexOf('profileLock') + 1, 0, 'engineProfileLock');
  return copy;
}

const CLOAK_CAPABILITIES_KEYS = withEngineLock(CAPABILITIES_KEYS_295);
const CLOAK_STATUS_KEYS = withEngineLock(STATUS_KEYS_293);

const tempRoots: string[] = [];
const sessions: BrokerSession[] = [];
const holders: FileHolder[] = [];

afterEach(async () => {
  faults.unreadablePath = '';
  faults.unreadableCode = '';
  faults.unopenablePath = '';
  faults.unopenableCode = '';
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

function profileWithLock(name: string, contents?: string, file = 'parent.lock'): string {
  const dir = path.join(tempRoot('pr-camoufox-preflight-'), name);
  mkdirSync(dir, { recursive: true });
  if (contents !== undefined) {
    writeFileSync(path.join(dir, file), contents);
  }
  return dir;
}

function deadPid(root: string): number {
  const file = path.join(root, 'exit-now.mjs');
  writeFileSync(file, 'process.exit(0);\n');
  const result = spawnSync(process.execPath, [file], { windowsHide: true });
  if (result.pid === undefined || result.pid <= 0) {
    throw new Error('could not obtain a dead pid');
  }
  return result.pid;
}

function injectedCode(lockPath: string, code: string): void {
  faults.unreadablePath = lockPath;
  faults.unreadableCode = code;
}

function injectedOpenCode(lockPath: string, code: string): void {
  faults.unopenablePath = lockPath;
  faults.unopenableCode = code;
}

interface FileHolder {
  pid: number;
  stop: () => Promise<void>;
}

// Hold a file the way Chromium holds its lockfile: one Windows handle opened for
// read and write with FILE_SHARE_READ, so other readers succeed while any open
// for writing is refused. Measured on this machine: the writer-open fails with
// EBUSY and the file is released the moment the holder exits. The holder is a
// real process, started and stopped by exact pid.
async function holdExclusiveForRead(file: string): Promise<FileHolder> {
  const script =
    `$f=[System.IO.File]::Open('${file.replaceAll("'", "''")}','Open','ReadWrite','Read');` +
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
      // Another error while the holder starts; keep waiting.
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

describe('engine lock reading (exclusive-open)', () => {
  const descriptor = { file: 'parent.lock', owner: 'exclusive-open' };

  it('reports free when the profile has no lock file', () => {
    const dir = profileWithLock('free');
    expect(profile.readEngineProfileLock(dir, descriptor)).toMatchObject({
      state: 'free',
      owner: null,
      error: null,
      file: 'parent.lock',
      liveness: 'exclusive-open',
      path: path.join(dir, 'parent.lock'),
    });
  });

  it('reports live when the OS refuses to open a file a browser holds (EBUSY)', () => {
    const dir = profileWithLock('live-busy', '');
    injectedCode(path.join(dir, 'parent.lock'), 'EBUSY');
    const lock = profile.readEngineProfileLock(dir, descriptor);
    expect(lock).toMatchObject({ state: 'live', owner: { pid: null, createdAt: null }, error: null });
    expect(profile.engineLockBlocksStart(lock)).toBe(true);
  });

  it('treats a permission error on the lock as a live holder', () => {
    const dir = profileWithLock('live-denied', '');
    injectedCode(path.join(dir, 'parent.lock'), 'EPERM');
    expect(profile.readEngineProfileLock(dir, descriptor)).toMatchObject({
      state: 'live',
      owner: { pid: null },
    });
  });

  it('reports stale for the zero-byte file Firefox leaves after a clean exit', () => {
    // Measured on this machine: a running Camoufox holds parent.lock unreadable
    // and 0 bytes; after exit the file stays 0 bytes and opens normally.
    const dir = profileWithLock('stale', '');
    const lock = profile.readEngineProfileLock(dir, descriptor);
    expect(lock).toMatchObject({ state: 'stale', owner: null, error: null });
    expect(profile.engineLockBlocksStart(lock)).toBe(false);
  });

  it('reports stale even when a leftover file has content', () => {
    const dir = profileWithLock('stale-content', 'leftover');
    expect(profile.readEngineProfileLock(dir, descriptor)).toMatchObject({ state: 'stale' });
  });

  it('allows the start with a note when the file cannot be read for another reason', () => {
    const dir = profileWithLock('unknown', '');
    injectedCode(path.join(dir, 'parent.lock'), 'EIO');
    const lock = profile.readEngineProfileLock(dir, descriptor);
    expect(lock.state).toBe('unknown');
    expect(String(lock.error)).toContain('The start continues');
    expect(profile.engineLockBlocksStart(lock)).toBe(false);
  });

  it('allows the start with a note when the lock path is not a regular file', () => {
    const dir = profileWithLock('directory');
    mkdirSync(path.join(dir, 'parent.lock'));
    const lock = profile.readEngineProfileLock(dir, descriptor);
    expect(lock.state).toBe('unknown');
    expect(String(lock.error)).toContain('not a regular file');
    expect(profile.engineLockBlocksStart(lock)).toBe(false);
  });
});

describe('engine lock reading (exclusive-open-write)', () => {
  const descriptor = { file: 'lockfile', owner: 'exclusive-open-write' };

  it('reports free when the profile has no lock file', () => {
    const dir = profileWithLock('write-free');
    expect(profile.readEngineProfileLock(dir, descriptor)).toMatchObject({
      state: 'free',
      owner: null,
      error: null,
      file: 'lockfile',
      liveness: 'exclusive-open-write',
      path: path.join(dir, 'lockfile'),
    });
  });

  it('reports stale for a file that opens for writing, which is a dead lock', () => {
    // Chromium removes lockfile on a clean exit and after a kill; a leftover from
    // a crash opens normally, so it must never block a start.
    const dir = profileWithLock('write-stale', 'leftover', 'lockfile');
    const lock = profile.readEngineProfileLock(dir, descriptor);
    expect(lock).toMatchObject({ state: 'stale', owner: null, error: null });
    expect(profile.engineLockBlocksStart(lock)).toBe(false);
  });

  it('reports live when the OS refuses a write-open (EBUSY)', () => {
    const dir = profileWithLock('write-live', '', 'lockfile');
    injectedOpenCode(path.join(dir, 'lockfile'), 'EBUSY');
    const lock = profile.readEngineProfileLock(dir, descriptor);
    expect(lock).toMatchObject({ state: 'live', owner: { pid: null, createdAt: null }, error: null });
    expect(profile.engineLockBlocksStart(lock)).toBe(true);
  });

  it.each(['EPERM', 'EACCES', 'ETXTBSY'])('treats an OS refusal (%s) as a live holder', (code) => {
    const dir = profileWithLock(`write-${code}`, '', 'lockfile');
    injectedOpenCode(path.join(dir, 'lockfile'), code);
    expect(profile.readEngineProfileLock(dir, descriptor)).toMatchObject({
      state: 'live',
      owner: { pid: null },
    });
  });

  it('treats a file that vanished between stat and open as free', () => {
    const dir = profileWithLock('write-vanished', '', 'lockfile');
    injectedOpenCode(path.join(dir, 'lockfile'), 'ENOENT');
    expect(profile.readEngineProfileLock(dir, descriptor)).toMatchObject({ state: 'free' });
  });

  it('allows the start with a note when the write-open fails for another reason', () => {
    const dir = profileWithLock('write-unknown', '', 'lockfile');
    injectedOpenCode(path.join(dir, 'lockfile'), 'EIO');
    const lock = profile.readEngineProfileLock(dir, descriptor);
    expect(lock.state).toBe('unknown');
    expect(String(lock.error)).toContain('for writing');
    expect(profile.engineLockBlocksStart(lock)).toBe(false);
  });

  it('allows the start with a note when the lock path is not a regular file', () => {
    const dir = profileWithLock('write-directory');
    mkdirSync(path.join(dir, 'lockfile'));
    const lock = profile.readEngineProfileLock(dir, descriptor);
    expect(lock.state).toBe('unknown');
    expect(String(lock.error)).toContain('not a regular file');
    expect(profile.engineLockBlocksStart(lock)).toBe(false);
  });

  it('never writes the lock file it probes', () => {
    const dir = profileWithLock('write-no-write', 'ORIGINAL-CONTENT', 'lockfile');
    const lockPath = path.join(dir, 'lockfile');
    const before = originalReadFileSync(lockPath);
    const beforeStat = statSync(lockPath);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(profile.readEngineProfileLock(dir, descriptor)).toMatchObject({ state: 'stale' });
    }
    expect(originalReadFileSync(lockPath)).toEqual(before);
    expect(statSync(lockPath).size).toBe(beforeStat.size);
    expect(statSync(lockPath).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it.skipIf(process.platform !== 'win32')(
    'reports live while a real process holds the file and stale after it exits',
    async () => {
      const dir = profileWithLock('write-real-holder', '', 'lockfile');
      const lockPath = path.join(dir, 'lockfile');
      const holder = await holdExclusiveForRead(lockPath);
      holders.push(holder);
      const live = profile.readEngineProfileLock(dir, descriptor);
      expect(live).toMatchObject({ state: 'live', owner: { pid: null }, error: null });
      expect(profile.engineLockBlocksStart(live)).toBe(true);
      // A plain read still succeeds while the Chromium-like holder runs: that is
      // why the read-based rule cannot see this lock and the write probe exists.
      expect(originalReadFileSync(lockPath).length).toBe(0);
      await holder.stop();
      const stale = profile.readEngineProfileLock(dir, descriptor);
      expect(stale).toMatchObject({ state: 'stale', owner: null });
      expect(profile.engineLockBlocksStart(stale)).toBe(false);
    },
  );

  it('blocks only a live owner, never stale or unknown', () => {
    expect(profile.engineLockBlocksStart({ state: 'stale' } as never)).toBe(false);
    expect(profile.engineLockBlocksStart({ state: 'unknown' } as never)).toBe(false);
    expect(profile.engineLockBlocksStart({ state: 'free' } as never)).toBe(false);
    expect(profile.engineLockBlocksStart({ state: 'live' } as never)).toBe(true);
  });
});

describe('engine lock reading (pid)', () => {
  const descriptor = { file: 'owner.lock', owner: 'pid' };

  it('reports live for the pid of a running process', () => {
    const dir = profileWithLock('pid-live', `${process.pid}\n`, 'owner.lock');
    const lock = profile.readEngineProfileLock(dir, descriptor);
    expect(lock).toMatchObject({ state: 'live', owner: { pid: process.pid, createdAt: null } });
    expect(profile.engineLockBlocksStart(lock)).toBe(true);
  });

  it('reports stale for a pid that is gone', () => {
    const pid = deadPid(tempRoot('pr-camoufox-preflight-dead-'));
    const dir = profileWithLock('pid-stale', `${pid}\n`, 'owner.lock');
    const lock = profile.readEngineProfileLock(dir, descriptor);
    expect(lock).toMatchObject({ state: 'stale', owner: { pid } });
    expect(profile.engineLockBlocksStart(lock)).toBe(false);
  });

  it('tolerates trailing text and surrounding whitespace around the pid', () => {
    const dir = profileWithLock('pid-trailing', `  ${process.pid} locked by firefox\n`, 'owner.lock');
    expect(profile.readEngineProfileLock(dir, descriptor)).toMatchObject({
      state: 'live',
      owner: { pid: process.pid },
    });
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   \n'],
    ['not a number', 'parent'],
    ['zero', '0'],
    ['negative', '-7'],
    ['fractional', '1.5'],
  ])('allows the start with a note for a %s pid', (_label, contents) => {
    const dir = profileWithLock('pid-malformed', contents, 'owner.lock');
    const lock = profile.readEngineProfileLock(dir, descriptor);
    expect(lock.state).toBe('unknown');
    expect(lock.owner).toBeNull();
    expect(String(lock.error)).toContain('does not name a process id');
    expect(profile.engineLockBlocksStart(lock)).toBe(false);
  });

  it('reports live when a pid lock file is held open, so the OS proof wins', () => {
    const dir = profileWithLock('pid-busy', '1234', 'owner.lock');
    injectedCode(path.join(dir, 'owner.lock'), 'EACCES');
    expect(profile.readEngineProfileLock(dir, descriptor)).toMatchObject({
      state: 'live',
      owner: { pid: null },
    });
  });

  it('allows the start with a note for an unusable descriptor', () => {
    const dir = profileWithLock('bad-descriptor', '1234', 'owner.lock');
    for (const descriptor of [
      null,
      {},
      { file: 'owner.lock' },
      { owner: 'pid' },
      { file: '', owner: 'pid' },
    ]) {
      const lock = profile.readEngineProfileLock(dir, descriptor as never);
      expect(lock.state).toBe('unknown');
      expect(profile.engineLockBlocksStart(lock)).toBe(false);
    }
  });

  it('declares exactly the three owner rules it implements', () => {
    expect([...profile.ENGINE_LOCK_OWNER_RULES]).toEqual(['exclusive-open', 'exclusive-open-write', 'pid']);
  });
});

describe('engine lock message', () => {
  it('names the profile dir, the owner pid and the fix for a live pid lock', () => {
    const dir = profileWithLock('message-pid', `${process.pid}\n`, 'owner.lock');
    const lock = profile.readEngineProfileLock(dir, { file: 'owner.lock', owner: 'pid' });
    const message = profile.engineProfileLockMessage(lock);
    expect(message).toContain(dir);
    expect(message).toContain(`pid ${process.pid}`);
    expect(message).toContain('profile_isolation');
    expect(message).toContain('The backend was not started.');
    expect(profile.engineProfileLockFix(lock)).toContain('Close the browser or Claude Code session');
  });

  it('names the lock file when the holder cannot be identified', () => {
    const dir = profileWithLock('message-open', '');
    injectedCode(path.join(dir, 'parent.lock'), 'EBUSY');
    const lock = profile.readEngineProfileLock(dir, { file: 'parent.lock', owner: 'exclusive-open' });
    const message = profile.engineProfileLockMessage(lock);
    expect(message).toContain(dir);
    expect(message).toContain(path.join(dir, 'parent.lock'));
    expect(message).toContain('holds the engine lock file');
    expect(message).toContain('The backend was not started.');
  });

  it('names the Chromium lock file and keeps the broker wording for the write rule', () => {
    const dir = profileWithLock('message-write', '', 'lockfile');
    injectedOpenCode(path.join(dir, 'lockfile'), 'EBUSY');
    const lock = profile.readEngineProfileLock(dir, { file: 'lockfile', owner: 'exclusive-open-write' });
    const message = profile.engineProfileLockMessage(lock);
    expect(message).toContain(dir);
    expect(message).toContain(path.join(dir, 'lockfile'));
    expect(message).toContain('another process holds the engine lock file');
    expect(message).toContain('The backend was not started.');
    // The profile copy tool reuses the same heading and fix with its own closing
    // sentence; the default message above stays byte-identical.
    const copyMessage = profile.engineProfileLockMessage(lock, {
      trailing: 'The profile was not copied.',
    });
    expect(copyMessage).toContain('The profile was not copied.');
    expect(copyMessage).not.toContain('The backend was not started.');
    expect(copyMessage.replace('The profile was not copied.', 'The backend was not started.')).toBe(message);
  });

  it('has no fix for a stale lock', () => {
    const dir = profileWithLock('message-stale', '');
    const stale = profile.readEngineProfileLock(dir, { file: 'parent.lock', owner: 'exclusive-open' });
    expect(profile.engineProfileLockFix(stale)).toBeNull();
    expect(profile.engineLockBlocksStart(stale)).toBe(false);
  });
});

describe('manifest profileLock validation', () => {
  const base = {
    schemaVersion: 1,
    id: 'alpha',
    label: 'Alpha',
    transport: 'launch',
    contract: 'playwright-mcp',
    defaultToolProfile: 'full',
    toolSupport: { '*': 'full' },
    notes: 'test',
  };

  it('accepts every owner rule and no descriptor at all', () => {
    expect(registry.validateManifest(base, 'alpha', ['full'])).toBeNull();
    expect(
      registry.validateManifest(
        { ...base, profileLock: { file: 'parent.lock', owner: 'exclusive-open' } },
        'alpha',
        ['full'],
      ),
    ).toBeNull();
    expect(
      registry.validateManifest(
        { ...base, profileLock: { file: 'lockfile', owner: 'exclusive-open-write' } },
        'alpha',
        ['full'],
      ),
    ).toBeNull();
    expect(
      registry.validateManifest({ ...base, profileLock: { file: 'owner.lock', owner: 'pid' } }, 'alpha', [
        'full',
      ]),
    ).toBeNull();
  });

  it('rejects an unsupported field, a missing file or a missing owner', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ file: 'parent.lock', owner: 'pid', mode: 'x' }, 'unsupported field "mode"'],
      [{ owner: 'pid' }, 'profileLock.file is missing'],
      [{ file: 'parent.lock' }, 'profileLock.owner is missing'],
      [{ file: '  ', owner: 'pid' }, 'profileLock.file is missing'],
    ];
    for (const [profileLock, expected] of cases) {
      expect(registry.validateManifest({ ...base, profileLock }, 'alpha', ['full'])).toContain(expected);
    }
  });

  it('rejects a path, a traversal or an unknown owner rule', () => {
    const files = ['../parent.lock', 'sub/parent.lock', '..\\parent.lock', '.', '..', 'a'.repeat(65)];
    for (const file of files) {
      expect(
        registry.validateManifest({ ...base, profileLock: { file, owner: 'pid' } }, 'alpha', ['full']),
      ).toBe('profileLock.file must be a plain file name inside the profile directory');
    }
    expect(
      registry.validateManifest({ ...base, profileLock: { file: 'parent.lock', owner: 'open' } }, 'alpha', [
        'full',
      ]),
    ).toContain('profileLock.owner must be one of');
  });

  it('rejects a descriptor on an engine that owns no plugin profile', () => {
    expect(
      registry.validateManifest(
        { ...base, profileApplies: false, profileLock: { file: 'parent.lock', owner: 'pid' } },
        'alpha',
        ['full'],
      ),
    ).toContain('profileApplies is not false');
  });
});

describe('manifest wiring', () => {
  const universal = path.join(repoRoot, 'plugins', 'cloakbrowser', 'engines');
  const camoufoxPlugin = path.join(repoRoot, 'plugins', 'camoufox', 'engines');

  it('declares parent.lock for the camoufox engine in both plugins', () => {
    for (const dir of [universal, camoufoxPlugin]) {
      const manifest = JSON.parse(originalReadFileSync(path.join(dir, 'camoufox.json'), 'utf8'));
      expect(manifest.profileLock).toEqual({ file: 'parent.lock', owner: 'exclusive-open' });
    }
    expect(originalReadFileSync(path.join(universal, 'camoufox.json'))).toEqual(
      originalReadFileSync(path.join(camoufoxPlugin, 'camoufox.json')),
    );
  });

  it('declares the Chromium lockfile for cloak and playwright', () => {
    for (const engine of ['cloak', 'playwright']) {
      const manifest = JSON.parse(originalReadFileSync(path.join(universal, `${engine}.json`), 'utf8'));
      expect(manifest.profileLock).toEqual({ file: 'lockfile', owner: 'exclusive-open-write' });
    }
  });

  it('declares no profileLock for the engines that do not need one', () => {
    for (const engine of ['camoufox-native', 'kameleo']) {
      const manifest = JSON.parse(originalReadFileSync(path.join(universal, `${engine}.json`), 'utf8'));
      expect(manifest.profileLock).toBeUndefined();
    }
  });

  it('keeps every shipped manifest valid with the new field', () => {
    const profiles = JSON.parse(originalReadFileSync(path.join(universal, 'profiles.json'), 'utf8')) as {
      profiles: Record<string, unknown>;
    };
    const profileNames = Object.keys(profiles.profiles).sort();
    for (const engine of ['cloak', 'playwright', 'camoufox', 'camoufox-native', 'kameleo']) {
      const manifest = JSON.parse(originalReadFileSync(path.join(universal, `${engine}.json`), 'utf8'));
      expect(
        registry.validateManifest(manifest, engine, profileNames, pluginDir),
        `${engine}.json`,
      ).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Broker wiring: the real plugin for the cloak engine and a scratch plugin with
// two synthetic engines, one that declares profileLock and one that does not.
// The broker reads the lock before spawning.
// ---------------------------------------------------------------------------

const STUB_TOOLS = ['browser_navigate', 'browser_snapshot'];
const STUB_SOURCE = `#!/usr/bin/env node
import readline from 'node:readline';
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-lock-mcp', version: '0.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} } })) } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '{}' }], isError: false } });
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => { if (line.trim() !== '') { try { handle(JSON.parse(line)); } catch {} } });
rl.on('close', () => process.exit(0));
`;

const CLOAK_STUB_SOURCE = `#!/usr/bin/env node
const readline = require('node:readline');
const TOOLS = ${JSON.stringify(STUB_TOOLS)};
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-browser-mcp', version: '0.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} } })) } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '{}' }], isError: false } });
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => { if (line.trim() !== '') { try { handle(JSON.parse(line)); } catch {} } });
rl.on('close', () => process.exit(0));
`;

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createLockPlugin(root: string): string {
  const plugin = path.join(root, 'plugin');
  const engines = path.join(plugin, 'engines');
  const lib = path.join(plugin, 'lib');
  mkdirSync(engines, { recursive: true });
  mkdirSync(lib, { recursive: true });
  for (const file of ['broker.mjs', 'engine-registry.mjs']) {
    copyFileSync(path.join(pluginDir, file), path.join(plugin, file));
  }
  for (const file of [
    'attach.mjs',
    'password-manager.mjs',
    'ping-timeout.mjs',
    'profile.mjs',
    'provision.mjs',
    'surface.mjs',
    'tool-cache.mjs',
  ]) {
    copyFileSync(path.join(pluginDir, 'lib', file), path.join(lib, file));
  }
  copyFileSync(path.join(pluginDir, 'engines', 'profiles.json'), path.join(engines, 'profiles.json'));
  writeJson(path.join(engines, 'lock-engine.json'), {
    schemaVersion: 1,
    id: 'lock-engine',
    label: 'Lock test engine',
    transport: 'launch',
    contract: 'playwright-mcp',
    defaultToolProfile: 'full',
    launch: { launcher: 'launch-lock-engine.mjs' },
    profileLock: { file: 'owner.lock', owner: 'pid' },
    toolSupport: { '*': 'full' },
    notes: 'Synthetic manifest for the profile-lock unit suite.',
  });
  writeJson(path.join(engines, 'plain-engine.json'), {
    schemaVersion: 1,
    id: 'plain-engine',
    label: 'Plain test engine',
    transport: 'launch',
    contract: 'playwright-mcp',
    defaultToolProfile: 'full',
    launch: { launcher: 'launch-lock-engine.mjs' },
    toolSupport: { '*': 'full' },
    notes: 'Synthetic manifest with no profileLock, for the byte-identical check.',
  });
  writeFileSync(path.join(plugin, 'launch-lock-engine.mjs'), STUB_SOURCE);
  return plugin;
}

// The stub runtime the cloak launcher finds already provisioned: it checks the
// package identities, then starts dist/cli.js.
function createCloakRuntime(dataDir: string): string {
  const runtime = path.join(dataDir, 'runtime');
  const modules = path.join(runtime, 'node_modules');
  for (const name of ['cloakbrowser', 'playwright-core', 'playwright', 'cloakbrowser-mcp']) {
    mkdirSync(path.join(modules, name), { recursive: true });
  }
  mkdirSync(path.join(modules, 'cloakbrowser-mcp', 'dist'), { recursive: true });
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
  writeFileSync(path.join(modules, 'cloakbrowser-mcp', 'dist', 'cli.js'), CLOAK_STUB_SOURCE);
  return dataDir;
}

function createSyntheticRuntime(dataDir: string): string {
  const runtime = path.join(dataDir, 'runtime');
  mkdirSync(runtime, { recursive: true });
  writeJson(path.join(runtime, '.installed.json'), {
    package: 'cloakbrowser-mcp@1.15.1',
    engine: '0.6.3',
    driver: 'patchright@1.64.1',
  });
  return dataDir;
}

interface BrokerSession {
  request: (method: string, params?: Record<string, unknown>) => Promise<JsonRpcResponse>;
  stderr: () => string;
  close: () => Promise<void>;
}

function startBroker(options: {
  dataDir: string;
  engine: string;
  pluginDir: string;
  onLocked?: string;
}): BrokerSession {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: options.dataDir,
    STEALTH_ENGINE: options.engine,
    STEALTH_TOOL_PROFILE: 'full',
    CLOAK_PLAYWRIGHT_MCP_PACKAGE: 'cloakbrowser-mcp@1.15.1',
  };
  for (const name of [
    'STEALTH_ACCOUNT',
    'STEALTH_PROFILE_ISOLATION',
    'STEALTH_ON_LOCKED',
    'PLAYWRIGHT_MCP_USER_DATA_DIR',
    'PLAYWRIGHT_MCP_PROXY_SERVER',
    'CLOAK_DISABLED_TOOLS',
  ]) {
    delete env[name];
  }
  if (options.onLocked !== undefined) env.STEALTH_ON_LOCKED = options.onLocked;
  const child = spawn(process.execPath, [path.join(options.pluginDir, 'broker.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const pending = new Map<number, (message: JsonRpcResponse) => void>();
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim() === '') return;
    let message: JsonRpcResponse & { id?: number };
    try {
      message = JSON.parse(line) as JsonRpcResponse & { id?: number };
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
  const request = (method: string, params?: Record<string, unknown>) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}; stderr=${stderr.slice(-400)}`));
      }, 8000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  };
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const session: BrokerSession = {
    request,
    stderr: () => stderr,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    },
  };
  sessions.push(session);
  return session;
}

async function initialize(session: BrokerSession): Promise<string> {
  const response = await session.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  return response.result?.instructions ?? '';
}

async function payload(session: BrokerSession, name: string): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name, arguments: {} });
  return response.result?.structuredContent ?? {};
}

async function toolNames(session: BrokerSession): Promise<string[]> {
  const list = await session.request('tools/list', {});
  return (list.result?.tools ?? []).map((tool) => tool.name);
}

describe('broker engine-lock preflight', () => {
  // The broker reads the lock once, before it reads stdin, so the fixture must
  // exist before the spawn: writing it after startBroker() is a race that a fast
  // Linux runner loses (seen on ubuntu-latest node 22 in PR #31's first run).
  function setupSynthetic(
    engine: string,
    prepare?: (profileDir: string) => void,
    onLocked?: string,
  ): { dataDir: string; profileDir: string; session: BrokerSession } {
    const root = tempRoot('pr-camoufox-preflight-broker-');
    const plugin = createLockPlugin(root);
    const dataDir = createSyntheticRuntime(path.join(root, 'data'));
    const profileDir = path.join(dataDir, 'profiles', engine, 'default');
    mkdirSync(profileDir, { recursive: true });
    if (prepare !== undefined) {
      prepare(profileDir);
    }
    const session = startBroker({ dataDir, engine, pluginDir: plugin, onLocked });
    return { dataDir, profileDir, session };
  }

  it('refuses to spawn when the engine lock names a live pid and reports it', async () => {
    // on_locked=block is the 2.15 behaviour; the 2.16.0 default would start on a
    // numbered sibling, which the on_locked suite asserts.
    const { profileDir, session } = setupSynthetic(
      'lock-engine',
      (dir) => {
        writeFileSync(path.join(dir, 'owner.lock'), `${process.pid}\n`);
      },
      'block',
    );
    const instructions = await initialize(session);
    expect(instructions).toContain(profileDir);
    expect(instructions).toContain(path.join(profileDir, 'owner.lock'));
    expect(instructions).toContain(`pid ${process.pid}`);
    expect(instructions).toContain('The backend was not started.');
    expect(await toolNames(session)).toEqual([
      'browser_capabilities',
      'browser_engine_status',
      'browser_profiles',
    ]);
    const statusPayload = await payload(session, 'browser_engine_status');
    expect(statusPayload.backendState).toBe('failed');
    expect(statusPayload.backendPid).toBeNull();
    expect(String(statusPayload.lastError)).toContain(profileDir);
    const engineLock = statusPayload.engineProfileLock as Record<string, unknown>;
    expect(engineLock).toMatchObject({
      state: 'live',
      profileDir,
      file: 'owner.lock',
      liveness: 'pid',
      owner: { pid: process.pid },
    });
    expect(String(engineLock.fix)).toContain('Close the browser or Claude Code session');
    const caps = await payload(session, 'browser_capabilities');
    expect(String(caps.engineError)).toContain(profileDir);
    expect(caps.engineProfileLock).toMatchObject({ state: 'live' });
    expect(session.stderr()).toContain('not starting a backend');
  });

  it('allows the start and reports stale when the engine lock pid is gone', async () => {
    const dead = deadPid(tempRoot('pr-camoufox-preflight-broker-dead-'));
    const { session } = setupSynthetic('lock-engine', (dir) => {
      writeFileSync(path.join(dir, 'owner.lock'), `${dead}\n`);
    });
    const instructions = await initialize(session);
    // The stale lock adds nothing; the 2.9.5 artifact sentence is the only text.
    expect(instructions).toContain('Browser artifacts (screenshots, traces, downloads) go to');
    expect(instructions).not.toContain('owner.lock');
    expect(await toolNames(session)).toContain('browser_navigate');
    const caps = await payload(session, 'browser_capabilities');
    expect(caps.engineProfileLock).toMatchObject({ state: 'stale', owner: { pid: dead } });
    expect(caps.profileLock).toMatchObject({ state: 'free' });
    expect(session.stderr()).toContain('engine profile lock');
    expect(session.stderr()).toContain('is stale');
  });

  it('starts normally with no engine lock file', async () => {
    const { profileDir, session } = setupSynthetic('lock-engine');
    await initialize(session);
    expect(await toolNames(session)).toContain('browser_navigate');
    const caps = await payload(session, 'browser_capabilities');
    expect(caps.engineProfileLock).toMatchObject({ state: 'free', profileDir });
  });

  it('allows the start with a note when the engine lock is malformed', async () => {
    const { session } = setupSynthetic('lock-engine', (dir) => {
      writeFileSync(path.join(dir, 'owner.lock'), 'not a pid\n');
    });
    await initialize(session);
    expect(await toolNames(session)).toContain('browser_navigate');
    const caps = await payload(session, 'browser_capabilities');
    expect(caps.engineProfileLock).toMatchObject({ state: 'unknown' });
    expect(String((caps.engineProfileLock as Record<string, unknown>).error)).toContain(
      'does not name a process id',
    );
    expect(session.stderr()).toContain('does not name a process id');
  });

  it('adds no engineProfileLock key for an engine without the descriptor', async () => {
    const { session } = setupSynthetic('plain-engine', (dir) => {
      writeFileSync(path.join(dir, 'owner.lock'), `${process.pid}\n`);
    });
    await initialize(session);
    expect(await toolNames(session)).toContain('browser_navigate');
    const caps = await payload(session, 'browser_capabilities');
    const statusPayload = await payload(session, 'browser_engine_status');
    expect(Object.keys(caps)).toEqual(CAPABILITIES_KEYS_295);
    expect(Object.keys(statusPayload)).toEqual(STATUS_KEYS_293);
    expect('engineProfileLock' in caps).toBe(false);
    expect('engineProfileLock' in statusPayload).toBe(false);
  });

  function setupCloak(prepare?: (profileDir: string) => void): {
    dataDir: string;
    profileDir: string;
    session: BrokerSession;
  } {
    const root = tempRoot('pr-camoufox-preflight-cloak-');
    const dataDir = createCloakRuntime(path.join(root, 'data'));
    const profileDir = path.join(dataDir, 'profiles', 'default');
    mkdirSync(profileDir, { recursive: true });
    if (prepare !== undefined) {
      prepare(profileDir);
    }
    const session = startBroker({ dataDir, engine: 'cloak', pluginDir });
    return { dataDir, profileDir, session };
  }

  it('keeps every pre-existing cloak payload key and adds engineProfileLock', async () => {
    const { profileDir, session } = setupCloak();
    await initialize(session);
    expect(await toolNames(session)).toContain('browser_navigate');
    const caps = await payload(session, 'browser_capabilities');
    const statusPayload = await payload(session, 'browser_engine_status');
    expect(Object.keys(caps)).toEqual(CLOAK_CAPABILITIES_KEYS);
    expect(Object.keys(statusPayload)).toEqual(CLOAK_STATUS_KEYS);
    expect(caps.profileLock).toMatchObject({ state: 'free' });
    expect(statusPayload.profileLock).toMatchObject({ state: 'free' });
    expect(caps.engineProfileLock).toMatchObject({
      state: 'free',
      profileDir,
      file: 'lockfile',
      liveness: 'exclusive-open-write',
    });
    expect(statusPayload.engineProfileLock).toMatchObject({ state: 'free', file: 'lockfile' });
  });

  it('allows the start and reports stale for a leftover Chromium lockfile', async () => {
    const { profileDir, session } = setupCloak((dir) => {
      writeFileSync(path.join(dir, 'lockfile'), '');
    });
    await initialize(session);
    expect(await toolNames(session)).toContain('browser_navigate');
    const caps = await payload(session, 'browser_capabilities');
    expect(caps.engineProfileLock).toMatchObject({ state: 'stale', profileDir, file: 'lockfile' });
    expect(session.stderr()).toContain('engine profile lock');
    expect(session.stderr()).toContain('is stale');
  });

  it.skipIf(process.platform !== 'win32')(
    'refuses to spawn when another process holds the Chromium lockfile',
    async () => {
      const root = tempRoot('pr-camoufox-preflight-cloak-live-');
      const dataDir = createCloakRuntime(path.join(root, 'data'));
      const profileDir = path.join(dataDir, 'profiles', 'default');
      mkdirSync(profileDir, { recursive: true });
      const lockPath = path.join(profileDir, 'lockfile');
      writeFileSync(lockPath, '');
      const holder = await holdExclusiveForRead(lockPath);
      holders.push(holder);

      const session = startBroker({ dataDir, engine: 'cloak', pluginDir, onLocked: 'block' });
      const instructions = await initialize(session);
      expect(instructions).toContain(profileDir);
      expect(instructions).toContain(lockPath);
      expect(instructions).toContain('another process holds the engine lock file');
      expect(instructions).toContain('The backend was not started.');
      expect(await toolNames(session)).toEqual([
        'browser_capabilities',
        'browser_engine_status',
        'browser_profiles',
      ]);
      const statusPayload = await payload(session, 'browser_engine_status');
      expect(statusPayload.backendState).toBe('failed');
      expect(statusPayload.backendPid).toBeNull();
      expect(statusPayload.engineProfileLock).toMatchObject({
        state: 'live',
        profileDir,
        file: 'lockfile',
        liveness: 'exclusive-open-write',
      });
      expect(String(statusPayload.lastError)).toContain(lockPath);
      expect(session.stderr()).toContain('not starting a backend');

      // The same profile starts once the holder exits: a dead lockfile is stale.
      await holder.stop();
      const next = startBroker({ dataDir, engine: 'cloak', pluginDir });
      await initialize(next);
      expect(await toolNames(next)).toContain('browser_navigate');
      const nextCaps = await payload(next, 'browser_capabilities');
      expect(nextCaps.engineProfileLock).toMatchObject({ state: 'stale', file: 'lockfile' });
    },
  );
});
