import {
  existsSync,
  mkdtempSync,
  mkdirSync as originalMkdirSync,
  readFileSync as originalReadFileSync,
  realpathSync,
  writeFileSync as originalWriteFileSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareBridgeRuntime } from '@/bridge/config.js';

const faults = vi.hoisted(() => ({
  lockPath: '',
  fdPaths: new Map<number, string>(),
  openErrors: [] as Array<NodeJS.ErrnoException | undefined>,
  replacementOnOpen: '',
  writeFailure: false,
  partialWrite: '',
  replacePathOnWriteFailure: false,
  replacementContents: '',
  mutationContents: '',
  writeFileMutation: false,
  readFailure: false,
  identityMutation: false,
  identityReads: 0,
  closes: 0,
  reads: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  const openSync: typeof original.openSync = (file, flags, mode) => {
    if (file === faults.lockPath && flags === 'wx' && faults.openErrors.length > 0) {
      const error = faults.openErrors.shift();
      if (error !== undefined) {
        if (error.code === 'EEXIST' && faults.replacementOnOpen !== '') {
          original.writeFileSync(file, faults.replacementOnOpen);
          faults.replacementOnOpen = '';
        }
        throw error;
      }
    }
    const fd = original.openSync(file, flags, mode);
    if (file === faults.lockPath && flags === 'wx') {
      const lockFilePath = String(file);
      faults.fdPaths.set(fd, lockFilePath);
    }
    return fd;
  };
  const writeFileSync: typeof original.writeFileSync = (file, data, options) => {
    if (typeof file === 'number' && faults.writeFailure) {
      faults.writeFailure = false;
      const partial = faults.partialWrite;
      original.writeFileSync(file, partial);
      if (faults.replacePathOnWriteFailure) {
        const lockPath = faults.fdPaths.get(file);
        if (lockPath === undefined) throw new Error('Missing injected profile lock descriptor');
        const ownedPath = `${lockPath}.owned`;
        original.renameSync(lockPath, ownedPath);
        original.writeFileSync(lockPath, faults.replacementContents);
        faults.replacePathOnWriteFailure = false;
      }
      const error = new Error('Injected lock write failure');
      const errorCode = { code: 'EIO' };
      Object.assign(error, errorCode);
      throw error;
    }
    return original.writeFileSync(file, data, options);
  };
  const closeSync: typeof original.closeSync = (fd) => {
    faults.closes += 1;
    faults.fdPaths.delete(fd);
    return original.closeSync(fd);
  };
  const lstatHandler: ProxyHandler<typeof original.lstatSync> = {
    apply(target, _thisArg, args) {
      const file = args[0];
      if (file === faults.lockPath && faults.identityMutation) {
        faults.identityReads += 1;
        if (faults.identityReads === 2) {
          faults.identityMutation = false;
          const lockFilePath = String(file);
          const replacementPath = `${lockFilePath}.replacement`;
          original.renameSync(lockFilePath, replacementPath);
          const replacementContents = faults.replacementContents;
          original.writeFileSync(lockFilePath, replacementContents);
        }
      }
      const lstatResult: unknown = Reflect.apply(target, original, args);
      return lstatResult;
    },
  };
  const lstatSync = new Proxy(original.lstatSync, lstatHandler);
  const readFileSync = (file: string, options: BufferEncoding): string => {
    if (file === faults.lockPath) {
      faults.reads += 1;
      if (faults.readFailure) {
        faults.readFailure = false;
        const error = new Error('Injected lock read failure');
        const errorCode = { code: 'EACCES' };
        Object.assign(error, errorCode);
        throw error;
      }
      if (faults.writeFileMutation && faults.reads === 2) {
        faults.writeFileMutation = false;
        const replacementContents = faults.mutationContents;
        original.writeFileSync(file, replacementContents);
      }
    }
    return original.readFileSync(file, options);
  };
  return { ...original, openSync, writeFileSync, readFileSync, closeSync, lstatSync };
});

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  faults.lockPath = '';
  faults.fdPaths.clear();
  faults.openErrors = [];
  faults.replacementOnOpen = '';
  faults.writeFailure = false;
  faults.partialWrite = '';
  faults.replacePathOnWriteFailure = false;
  faults.replacementContents = '';
  faults.mutationContents = '';
  faults.writeFileMutation = false;
  faults.readFailure = false;
  faults.identityMutation = false;
  faults.identityReads = 0;
  faults.closes = 0;
  faults.reads = 0;
  for (const root of roots.splice(0)) {
    const cleanupOptions = { recursive: true, force: true } as const;
    rmSync(root, cleanupOptions);
  }
});

function createRoot(): string {
  const prefix = path.join(tmpdir(), 'cloak-profile-lock-');
  const root = realpathSync.native(mkdtempSync(prefix));
  roots.push(root);
  const profile = path.join(root, 'profile');
  originalMkdirSync(profile);
  return root;
}

function createOptions(root: string): import('@/bridge/config.js').PrepareBridgeRuntimeOptions {
  const profile = path.join(root, 'profile');
  const output = path.join(root, 'output');
  const env = {
    PLAYWRIGHT_MCP_BROWSER_ENGINE: 'playwright',
    PLAYWRIGHT_MCP_OUTPUT_DIR: output,
    CLOAK_PLAYWRIGHT_MCP_CONSOLE_FALLBACK: 'false',
  };
  return { tempRoot: root, userDataDir: profile, env };
}

function lockPathFor(root: string): string {
  return path.join(root, 'profile', '.cloakbrowser-mcp-profile.lock');
}

function nodeError(code: string): NodeJS.ErrnoException {
  const error = new Error(`Injected ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function spawnDeadPid(): number {
  const script = 'process.exit(0)';
  const args = ['-e', script];
  const spawned = spawnSync(process.execPath, args);
  const childPid = spawned.pid;
  if (childPid === undefined) throw new Error('The test child process did not expose its process ID');
  let error: unknown;
  try {
    process.kill(childPid, 0);
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
    throw new Error('The spawned test process is not confirmed dead');
  }
  return childPid;
}

async function expectRejection(promise: Promise<unknown>, message: string): Promise<void> {
  await expect(promise).rejects.toThrow(message);
}

describe('persistent profile lock recovery', () => {
  it('reclaims a dead process lock and retries exclusive creation once', async () => {
    const root = createRoot();
    const options = createOptions(root);
    const lockPath = lockPathFor(root);
    faults.lockPath = lockPath;
    const deadPid = spawnDeadPid();
    const oldLock = { pid: deadPid, createdAt: 'old' };
    const oldContents = JSON.stringify(oldLock);
    originalWriteFileSync(lockPath, oldContents);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === deadPid && signal === 0) throw nodeError('ESRCH');
      return true;
    });

    const runtime = await prepareBridgeRuntime(options);
    try {
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(deadPid, 0);
      const lockExists = existsSync(lockPath);
      expect(lockExists).toBe(true);
      const currentLockContents = originalReadFileSync(lockPath, 'utf8');
      const currentLock = JSON.parse(currentLockContents);
      const expectedLock = { pid: process.pid };
      expect(currentLock).toMatchObject(expectedLock);
    } finally {
      runtime.dispose();
    }
  });

  it('preserves a lock owned by the current live process', async () => {
    const root = createRoot();
    const options = createOptions(root);
    const lockPath = lockPathFor(root);
    faults.lockPath = lockPath;
    const liveLock = { pid: process.pid, createdAt: 'live' };
    const contents = JSON.stringify(liveLock);
    originalWriteFileSync(lockPath, contents);

    const preparing = prepareBridgeRuntime(options);
    const expectedError = 'already active';
    await expectRejection(preparing, expectedError);
    const actualContents = originalReadFileSync(lockPath, 'utf8');
    expect(actualContents).toBe(contents);
  });

  it('preserves a lock when reading its snapshot fails', async () => {
    const root = createRoot();
    const options = createOptions(root);
    const lockPath = lockPathFor(root);
    faults.lockPath = lockPath;
    faults.readFailure = true;
    const deadPid = spawnDeadPid();
    const unreadableLock = { pid: deadPid, createdAt: 'unreadable' };
    const contents = JSON.stringify(unreadableLock);
    originalWriteFileSync(lockPath, contents);

    const preparing = prepareBridgeRuntime(options);
    const expectedError = 'already active';
    await expectRejection(preparing, expectedError);
    expect(faults.reads).toBeGreaterThan(0);
    const actualContents = originalReadFileSync(lockPath, 'utf8');
    expect(actualContents).toBe(contents);
  });

  const deniedSignals = ['EPERM', 'EACCES', 'EINVAL'];
  it.each(deniedSignals)('preserves a lock when process liveness check returns %s', async (code) => {
    const root = createRoot();
    const options = createOptions(root);
    const lockPath = lockPathFor(root);
    faults.lockPath = lockPath;
    const unknownLock = { pid: process.pid, createdAt: 'unknown' };
    const contents = JSON.stringify(unknownLock);
    originalWriteFileSync(lockPath, contents);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw nodeError(code);
    });

    const preparing = prepareBridgeRuntime(options);
    const expectedError = 'already active';
    await expectRejection(preparing, expectedError);
    expect(kill).toHaveBeenCalledTimes(1);
    const actualContents = originalReadFileSync(lockPath, 'utf8');
    expect(actualContents).toBe(contents);
  });

  const missingPidLock = { createdAt: 'old' };
  const zeroPidLock = { pid: 0 };
  const negativePidLock = { pid: -1 };
  const fractionalPidLock = { pid: 1.5 };
  const unsafePid = Number.MAX_SAFE_INTEGER + 1;
  const unsafePidLock = { pid: unsafePid };
  const stringPidLock = { pid: '123' };
  const missingPidContents = JSON.stringify(missingPidLock);
  const zeroPidContents = JSON.stringify(zeroPidLock);
  const negativePidContents = JSON.stringify(negativePidLock);
  const fractionalPidContents = JSON.stringify(fractionalPidLock);
  const unsafePidContents = JSON.stringify(unsafePidLock);
  const stringPidContents = JSON.stringify(stringPidLock);
  const invalidLockValues: Array<[string, string]> = [
    ['malformed JSON', '{'],
    ['missing PID', missingPidContents],
    ['zero PID', zeroPidContents],
    ['negative PID', negativePidContents],
    ['fractional PID', fractionalPidContents],
    ['unsafe PID', unsafePidContents],
    ['string PID', stringPidContents],
  ];
  it.each(invalidLockValues)('preserves a lock with %s', async (_label, contents) => {
    const root = createRoot();
    const options = createOptions(root);
    const lockPath = lockPathFor(root);
    faults.lockPath = lockPath;
    originalWriteFileSync(lockPath, contents);
    const kill = vi.spyOn(process, 'kill');

    const preparing = prepareBridgeRuntime(options);
    const expectedError = 'already active';
    await expectRejection(preparing, expectedError);
    expect(kill).not.toHaveBeenCalled();
    const actualContents = originalReadFileSync(lockPath, 'utf8');
    expect(actualContents).toBe(contents);
  });

  it('denies reclamation when lock contents change after the initial snapshot', async () => {
    const root = createRoot();
    const options = createOptions(root);
    const lockPath = lockPathFor(root);
    faults.lockPath = lockPath;
    faults.writeFileMutation = true;
    const deadPid = spawnDeadPid();
    const staleLock = { pid: deadPid, createdAt: 'old' };
    const oldContents = JSON.stringify(staleLock);
    const replacementLock = { pid: process.pid, createdAt: 'replacement' };
    faults.mutationContents = JSON.stringify(replacementLock);
    originalWriteFileSync(lockPath, oldContents);
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === deadPid) throw nodeError('ESRCH');
      return true;
    });

    const preparing = prepareBridgeRuntime(options);
    const expectedError = 'already active';
    await expectRejection(preparing, expectedError);
    const replacementContents = originalReadFileSync(lockPath, 'utf8');
    const replacement = JSON.parse(replacementContents);
    const expectedReplacement = { createdAt: 'replacement' };
    expect(replacement).toMatchObject(expectedReplacement);
  });

  it('denies reclamation when the lock file identity changes after the initial snapshot', async () => {
    const root = createRoot();
    const options = createOptions(root);
    const lockPath = lockPathFor(root);
    faults.lockPath = lockPath;
    faults.identityMutation = true;
    const deadPid = spawnDeadPid();
    const oldLock = { pid: deadPid, createdAt: 'old' };
    const oldContents = JSON.stringify(oldLock);
    faults.replacementContents = oldContents;
    originalWriteFileSync(lockPath, oldContents);
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === deadPid) throw nodeError('ESRCH');
      return true;
    });

    const preparing = prepareBridgeRuntime(options);
    const expectedError = 'already active';
    await expectRejection(preparing, expectedError);
    const lockExists = existsSync(lockPath);
    expect(lockExists).toBe(true);
    const survivingContents = originalReadFileSync(lockPath, 'utf8');
    expect(survivingContents).toBe(oldContents);
  });

  it('does not reclaim another lock after the one permitted retry also gets EEXIST', async () => {
    const root = createRoot();
    const options = createOptions(root);
    const lockPath = lockPathFor(root);
    faults.lockPath = lockPath;
    const deadPid = spawnDeadPid();
    const oldLock = { pid: deadPid, createdAt: 'old' };
    const oldContents = JSON.stringify(oldLock);
    originalWriteFileSync(lockPath, oldContents);
    faults.openErrors = [undefined, nodeError('EEXIST')];
    const competingLock = { pid: process.pid, createdAt: 'competitor' };
    const competingContents = JSON.stringify(competingLock);
    faults.replacementOnOpen = competingContents;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === deadPid) throw nodeError('ESRCH');
      return true;
    });

    const preparing = prepareBridgeRuntime(options);
    const expectedError = 'already active';
    await expectRejection(preparing, expectedError);
    expect(kill).toHaveBeenCalledTimes(1);
    const lockExists = existsSync(lockPath);
    expect(lockExists).toBe(true);
    const actualContents = originalReadFileSync(lockPath, 'utf8');
    expect(actualContents).toBe(competingContents);
  });

  it('closes and removes its newly created lock when writing fails, then allows a retry', async () => {
    const root = createRoot();
    const options = createOptions(root);
    const lockPath = lockPathFor(root);
    faults.lockPath = lockPath;
    faults.writeFailure = true;
    faults.partialWrite = '{"pid":';
    const preparing = prepareBridgeRuntime(options);
    const expectedError = 'Could not create profile lock';
    await expectRejection(preparing, expectedError);
    const lockExists = existsSync(lockPath);
    expect(lockExists).toBe(false);
    const closeCount = faults.closes;
    expect(closeCount).toBe(1);

    const runtime = await prepareBridgeRuntime(options);
    runtime.dispose();
    const lockExistsAfterRetry = existsSync(lockPath);
    expect(lockExistsAfterRetry).toBe(false);
  });

  it('preserves a competing file when its path replaces the lock during a failed write', async () => {
    const root = createRoot();
    const options = createOptions(root);
    const lockPath = lockPathFor(root);
    faults.lockPath = lockPath;
    faults.writeFailure = true;
    faults.partialWrite = '{"pid":';
    faults.replacePathOnWriteFailure = true;
    const competingLock = { pid: process.pid, createdAt: 'competitor' };
    const competingContents = JSON.stringify(competingLock);
    faults.replacementContents = competingContents;

    const preparing = prepareBridgeRuntime(options);
    const expectedError = 'Could not create profile lock';
    await expectRejection(preparing, expectedError);
    const lockExists = existsSync(lockPath);
    expect(lockExists).toBe(true);
    const survivingContents = originalReadFileSync(lockPath, 'utf8');
    expect(survivingContents).toBe(competingContents);
    const closeCount = faults.closes;
    expect(closeCount).toBe(1);
  });
});
