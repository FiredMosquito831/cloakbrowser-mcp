// The one engine-lock holder for the whole suite (item 41, PR A).
//
// Six copies of a "hold the browser's lock file" helper had drifted apart: five
// Windows `powershell.exe` variants with different share modes, budgets and leak
// behaviour, plus a POSIX `chmod 0400` route. Every one of them decided "held" by
// a single local `openSync` attempt with no liveness check on the holder, no
// stderr, and a failure message that could not be justified ("the file holder
// never locked the file"). Under CPU contention a healthy but slow holder
// therefore failed a test with no evidence, and one copy leaked a 60 s
// `powershell.exe` on its timeout path.
//
// This helper replaces all six. Its contract, in order:
//
//   1. The route comes from the engine manifest's `profileLock.owner`, never from
//      the test's own idea of the platform: `exclusive-open` (Firefox's
//      `parent.lock`, held with no sharing) opens a Windows handle shared for
//      nothing; `exclusive-open-write` (Chromium's `lockfile`, shared for
//      readers, refused for writers) opens it shared for reading; on POSIX both
//      are the same mode route, `chmod 0400`, which the product's own probe
//      reads as live through `ENGINE_LOCK_LIVE_CODES` (EACCES).
//   2. "Held" is accepted only when the product's own `readEngineProfileLock()`
//      reports `live` — never because a process was spawned. The holder's
//      definition of "held" is identical to the assertion's, so a holder the
//      product cannot see fails at setup with a precise message instead of
//      producing a confusing failure downstream.
//   3. Setup retries with a bounded backoff (25 -> 50 -> 100 -> 250 ms) inside a
//      30 s budget. Retries cover fixture setup only: the product assertion
//      under test still runs exactly once.
//   4. The holder's `error` and `exit` events are watched and its stderr is
//      drained, so a holder that dies fails immediately as `holder-exited` with
//      its exit code, signal and stderr tail.
//   5. A setup failure names platform, route, pid, liveness, attempts, the last
//      product probe, the last error and the stderr tail — never a bare "never
//      locked" — and kills the holder by its exact pid.
//   6. `stop()` is idempotent and is also registered with the test context, so a
//      failing assertion can never leak the holder.
//   7. Where the platform cannot honour the lock (root ignores a file mode, a
//      filesystem ignores modes, a `pid` rule that is the file's own text) the
//      helper skips with a stated reason instead of passing on a fake lock.
//
// The one deliberate deviation from the 2026-10-28 spec sketch: vitest 5's
// `TestContext` has no `after()` member (it exposes `onTestFinished`), so the
// helper registers `t.after()` when a context provides one and otherwise
// `t.onTestFinished()`.

import { chmodSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

interface EngineProfileLockRead {
  profileDir: string;
  path: string;
  file: string | null;
  liveness: string | null;
  state: string;
  owner: { pid: number | null; createdAt: string | null } | null;
  error: string | null;
}

interface ProfileProbeModule {
  readEngineProfileLock(
    profileDir: string,
    descriptor: { file?: string; owner?: string } | null | undefined,
  ): EngineProfileLockRead;
}

// The product's own probe, from the shipped plugin copy (byte-identical to
// shared/core by `plugins:core:check`). Never a re-implementation: the holder
// must be confirmed by exactly the code the assertion uses.
const profileProbe = (await import(
  new URL('../../plugins/cloakbrowser/lib/profile.mjs', import.meta.url).href
)) as unknown as ProfileProbeModule;

/** The manifest's own lock owner rules (`ENGINE_LOCK_OWNER_RULES`). */
export const ENGINE_LOCK_OWNER_RULES = ['exclusive-open', 'exclusive-open-write', 'pid'] as const;

export interface EngineLockDescriptor {
  file: string;
  /** One of `ENGINE_LOCK_OWNER_RULES`; an unknown value skips with a stated reason. */
  owner: string;
}

export type LockHolderRoute = 'windows-share-read' | 'windows-share-none' | 'posix-mode';

export type LockHolderCause =
  | 'spawn-failed'
  | 'holder-exited'
  | 'probe-not-live'
  | 'unsupported-rule'
  | 'unsupported-platform'
  | 'mode-not-honoured'
  | 'invalid-descriptor'
  | 'descriptor-mismatch'
  | 'lock-file-missing';

export interface LockHolder {
  /** The PowerShell pid on Windows; null on the POSIX mode route. */
  pid: number | null;
  route: LockHolderRoute;
  /** Probe attempts setup needed; 1 means the product read live on the first probe. */
  attempts: number;
  setupMs: number;
  /** Idempotent: kills by exact pid, waits for exit, restores the POSIX mode. */
  stop: () => Promise<void>;
}

/**
 * The members of vitest's `TestContext` this helper uses. Vitest 5 exposes
 * `onTestFinished()`; `after()` is accepted too so a context that provides it is
 * used as the spec asked.
 */
export interface LockHolderTestContext {
  after?: (fn: () => Promise<void> | void) => void;
  onTestFinished?: (fn: () => Promise<void> | void, timeout?: number) => void;
  skip?: (note?: string) => unknown;
}

export interface HoldEngineLockOptions {
  /** Absolute path of the lock file. It must exist; `profileDir/<descriptor.file>` names it. */
  file: string;
  /** The profile directory the product probes; `profileDir/<descriptor.file>` must equal `file`. */
  profileDir: string;
  /** The engine manifest's `profileLock` value, e.g. `{ file: 'lockfile', owner: 'exclusive-open-write' }`. */
  descriptor: EngineLockDescriptor;
  /** Setup budget for the product to read the lock live. Default 30 s. */
  budgetMs?: number;
  /** What to do when this platform cannot honour the lock. Default `skip`. */
  onUnsupported?: 'skip' | 'fail';
}

export class EngineLockHolderError extends Error {
  readonly holderCause: LockHolderCause;
  readonly diagnostics: Record<string, unknown>;

  constructor(holderCause: LockHolderCause, message: string, diagnostics: Record<string, unknown>) {
    super(message);
    this.name = 'EngineLockHolderError';
    this.holderCause = holderCause;
    this.diagnostics = diagnostics;
  }
}

export const DEFAULT_HOLDER_BUDGET_MS = 30_000;

// 25 -> 50 -> 100 -> 250 ms, then 250 ms until the budget. The idle Windows path
// completes on the first few probes; only a loaded machine spends the budget.
const BACKOFF_MS = [25, 50, 100, 250];
// The holder is a synchronous PowerShell command with a sleeping body; it is
// never expected to outlive a test, but a forgotten one must not run for hours.
const HOLDER_LIFETIME_SECONDS = 120;
const STOP_GRACE_MS = 3_000;
const STDERR_TAIL_CHARS = 8_192;
const MESSAGE_STDERR_CHARS = 600;

/**
 * Read an engine manifest's `profileLock` descriptor.
 *
 * The holder's route is chosen from the manifest's owner rule, so call sites
 * pass the manifest value rather than their own hard-coded share mode.
 */
export function manifestProfileLock(
  engineId: string,
  pluginRoot: string = path.join(repoRoot, 'plugins', 'cloakbrowser'),
): EngineLockDescriptor {
  const manifestPath = path.join(pluginRoot, 'engines', `${engineId}.json`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `engine-lock-holder: cannot read the engine manifest ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const lock = (manifest as { profileLock?: unknown } | null)?.profileLock;
  if (!isEngineLockDescriptor(lock)) {
    throw new Error(
      `engine-lock-holder: the engine manifest ${manifestPath} declares no usable profileLock ` +
        `({ file, owner }); received ${JSON.stringify(lock ?? null)}`,
    );
  }
  return { file: lock.file, owner: lock.owner };
}

/**
 * Hold an engine's lock file and confirm through the product's own probe that it
 * reads `live`. See the module comment for the contract.
 */
export async function holdEngineLock(
  testContext: LockHolderTestContext,
  options: HoldEngineLockOptions,
): Promise<LockHolder> {
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? DEFAULT_HOLDER_BUDGET_MS;
  const onUnsupported = options.onUnsupported ?? 'skip';
  const file = path.resolve(options.file);
  const profileDir = path.resolve(options.profileDir);
  const descriptor = options.descriptor;
  const descriptorText = JSON.stringify(descriptor ?? null);
  const diagnostics: Record<string, unknown> = {
    platform: process.platform,
    file,
    profileDir,
    descriptor,
  };

  if (!isEngineLockDescriptor(descriptor)) {
    throw new EngineLockHolderError(
      'invalid-descriptor',
      `the engine lock holder needs the manifest's profileLock descriptor { file, owner }; ` +
        `received ${descriptorText} for ${file}`,
      diagnostics,
    );
  }
  // The product probes `path.join(profileDir, descriptor.file)`; a holder on any
  // other path would time out against a file nobody held.
  const probedPath = path.resolve(path.join(profileDir, descriptor.file));
  if (probedPath !== file) {
    throw new EngineLockHolderError(
      'descriptor-mismatch',
      `the engine lock holder was given ${file}, but the product's probe reads ${probedPath} ` +
        `(profileDir=${profileDir}, descriptor.file=${descriptor.file}). Pass the profile directory ` +
        'the descriptor belongs to.',
      { ...diagnostics, probedPath },
    );
  }
  if (!isRegularFile(file)) {
    throw new EngineLockHolderError(
      'lock-file-missing',
      `the engine lock file ${file} does not exist (or is not a regular file). Write the lock file ` +
        'before calling holdEngineLock.',
      diagnostics,
    );
  }

  const route = lockHolderRoute(descriptor.owner);
  if (route === null) {
    return unsupported(
      testContext,
      onUnsupported,
      'unsupported-rule',
      `the engine lock owner rule "${descriptor.owner}" cannot be held by a file handle: a ` +
        '"pid" lock is the file\'s own text, so only the product\'s lock writer can stand in for it. ' +
        `file=${file}`,
      { ...diagnostics, route: null },
    );
  }
  diagnostics.route = route;

  if (route === 'posix-mode') {
    return holdWithFileMode(testContext, {
      file,
      profileDir,
      descriptor,
      diagnostics,
      onUnsupported,
      startedAt,
    });
  }
  return holdWithWindowsHandle(testContext, {
    file,
    profileDir,
    descriptor,
    descriptorText,
    route,
    budgetMs,
    diagnostics,
    startedAt,
  });
}

function isEngineLockDescriptor(value: unknown): value is EngineLockDescriptor {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const descriptor = value as { file?: unknown; owner?: unknown };
  return (
    typeof descriptor.file === 'string' &&
    descriptor.file.trim() !== '' &&
    typeof descriptor.owner === 'string' &&
    descriptor.owner.trim() !== ''
  );
}

function isRegularFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// The route follows the manifest's owner rule; the platform only decides the
// mechanism (a Windows handle or a POSIX file mode), never the share mode.
function lockHolderRoute(owner: string): LockHolderRoute | null {
  if (owner !== 'exclusive-open' && owner !== 'exclusive-open-write') {
    return null;
  }
  if (process.platform !== 'win32') {
    return 'posix-mode';
  }
  // A real Chromium holder shares reads and refuses writers, so the holder must
  // do the same: a plain read still succeeds and `r+` fails, which is exactly
  // what `exclusive-open-write` reads. Firefox's `parent.lock` is held with no
  // sharing at all, so every other open must fail.
  return owner === 'exclusive-open-write' ? 'windows-share-read' : 'windows-share-none';
}

interface FileModeOptions {
  file: string;
  profileDir: string;
  descriptor: EngineLockDescriptor;
  diagnostics: Record<string, unknown>;
  onUnsupported: 'skip' | 'fail';
  startedAt: number;
}

// POSIX has no mandatory locking; the equivalent the product reads as live is a
// file it cannot open for writing (mode 0400 -> EACCES, one of
// `ENGINE_LOCK_LIVE_CODES`). A chmod is synchronous, so one probe settles both
// "held" and "the mode was honoured"; retrying could not change the answer.
async function holdWithFileMode(
  testContext: LockHolderTestContext,
  options: FileModeOptions,
): Promise<LockHolder> {
  const { file, profileDir, descriptor, diagnostics, onUnsupported, startedAt } = options;
  const originalMode = statSync(file).mode & 0o777;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      chmodSync(file, originalMode);
    } catch {
      // The file may be gone; restoring a mode on a deleted file is not an error.
    }
  };
  registerHolderStop(testContext, stop);

  chmodSync(file, 0o400);
  const probe = profileProbe.readEngineProfileLock(profileDir, descriptor);
  if (probe.state !== 'live') {
    await stop();
    return unsupported(
      testContext,
      onUnsupported,
      'mode-not-honoured',
      `the engine lock ${file} was chmod 0400 but the product still reads it as ${probe.state}` +
        `${probe.error === null ? '' : ` (${probe.error})`}: this platform does not enforce the file ` +
        `mode for this user (root and CAP_DAC_OVERRIDE ignore it). platform=${process.platform} ` +
        'route=posix-mode',
      { ...diagnostics, lastProbe: probe.state, lastError: probe.error },
    );
  }
  const setupMs = Date.now() - startedAt;
  return { pid: null, route: 'posix-mode', attempts: 1, setupMs, stop };
}

interface WindowsHolderState {
  pid: number | null;
  child: ChildProcess;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  error: Error | null;
  stderr: string;
}

interface WindowsHolder {
  pid: number | null;
  stop: () => Promise<void>;
  spawnError: () => Error | null;
  exitInfo: () => { code: number | null; signal: NodeJS.Signals | null } | null;
  alive: () => boolean;
  stderrTail: () => string;
}

// A real Windows process holding one handle, started and stopped by exact pid.
// The handle's share mode is the manifest's owner rule (see `lockHolderRoute`).
function startWindowsHolder(file: string, route: LockHolderRoute): WindowsHolder {
  const share = route === 'windows-share-read' ? 'Read' : 'None';
  const script =
    `$f=[System.IO.File]::Open('${file.replaceAll("'", "''")}','Open','ReadWrite','${share}');` +
    `Write-Output held; Start-Sleep -Seconds ${HOLDER_LIFETIME_SECONDS}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state: WindowsHolderState = {
    pid: typeof child.pid === 'number' ? child.pid : null,
    child,
    exit: null,
    error: null,
    stderr: '',
  };
  let stopped = false;

  child.once('exit', (code, signal) => {
    state.exit = { code, signal };
  });
  child.once('error', (error) => {
    state.error = error;
  });
  // `held` on stdout is not a criterion; the product probe is. Draining it keeps
  // the pipe from filling on a long-lived holder.
  child.stdout?.resume();
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    state.stderr = `${state.stderr}${chunk}`;
    if (state.stderr.length > STDERR_TAIL_CHARS) {
      state.stderr = state.stderr.slice(-STDERR_TAIL_CHARS);
    }
  });
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (state.pid !== null && state.exit === null && state.error === null) {
      try {
        process.kill(state.pid);
      } catch {
        // Already gone.
      }
    }
    await waitForExit(state);
  };

  return {
    pid: state.pid,
    stop,
    spawnError: () => state.error,
    exitInfo: () => state.exit,
    alive: () => state.error === null && state.exit === null,
    stderrTail: () => state.stderr,
  };
}

function waitForExit(state: WindowsHolderState): Promise<void> {
  if (state.exit !== null || state.error !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, STOP_GRACE_MS);
    timer.unref();
    // A failed spawn emits 'error' and never 'exit'.
    state.child.once('exit', finish);
    state.child.once('error', finish);
  });
}

// A spawn that produced no pid has not necessarily emitted 'error' yet; wait for
// that event, bounded, so the failure can name the real reason instead of
// "no pid".
async function waitForSpawnFailure(holder: WindowsHolder): Promise<Error | null> {
  const deadline = Date.now() + 2_000;
  while (holder.spawnError() === null && Date.now() < deadline) {
    await sleep(25);
  }
  return holder.spawnError();
}

interface WindowsOptions {
  file: string;
  profileDir: string;
  descriptor: EngineLockDescriptor;
  descriptorText: string;
  route: LockHolderRoute;
  budgetMs: number;
  diagnostics: Record<string, unknown>;
  startedAt: number;
}

async function holdWithWindowsHandle(
  testContext: LockHolderTestContext,
  options: WindowsOptions,
): Promise<LockHolder> {
  const { file, profileDir, descriptor, descriptorText, route, budgetMs, diagnostics, startedAt } = options;
  const holder = startWindowsHolder(file, route);
  // Registered before the first probe: a failing setup or assertion must never
  // leak a sleeping `powershell.exe`.
  registerHolderStop(testContext, holder.stop);

  const pid = holder.pid;
  if (pid === null) {
    const spawnError = await waitForSpawnFailure(holder);
    await holder.stop();
    throw new EngineLockHolderError(
      'spawn-failed',
      `the engine lock holder could not start${spawnError === null ? '' : `: ${spawnError.message}`}. ` +
        `platform=${process.platform} route=${route} file=${file}`,
      { ...diagnostics, spawnError: spawnError === null ? null : spawnError.message },
    );
  }

  let attempts = 0;
  try {
    for (;;) {
      attempts += 1;
      const lastProbe = profileProbe.readEngineProfileLock(profileDir, descriptor);
      if (lastProbe.state === 'live') {
        break;
      }
      const spawnError = holder.spawnError();
      if (spawnError !== null) {
        throw new EngineLockHolderError(
          'spawn-failed',
          `the engine lock holder could not start: ${spawnError.message}. platform=${process.platform} ` +
            `route=${route} attempts=${attempts} lastProbe=${lastProbe.state} file=${file}`,
          { ...diagnostics, attempts, lastProbe: lastProbe.state, lastError: spawnError.message },
        );
      }
      const exit = holder.exitInfo();
      if (exit !== null) {
        throw new EngineLockHolderError(
          'holder-exited',
          `the engine lock holder exited before the product read ${file} live: ` +
            `platform=${process.platform} route=${route} pid=${pid} exitCode=${String(exit.code)} ` +
            `signal=${String(exit.signal)} attempts=${attempts} lastProbe=${lastProbe.state} ` +
            `lastError=${lastProbe.error ?? 'none'} stderr="${oneLine(holder.stderrTail(), MESSAGE_STDERR_CHARS)}" ` +
            `file=${file}`,
          {
            ...diagnostics,
            pid,
            attempts,
            exit,
            lastProbe: lastProbe.state,
            lastError: lastProbe.error,
            stderrTail: holder.stderrTail(),
          },
        );
      }
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= budgetMs) {
        throw new EngineLockHolderError(
          'probe-not-live',
          `the engine lock holder did not make the product read ${file} live within ${budgetMs} ms: ` +
            `platform=${process.platform} route=${route} pid=${pid} alive=${String(holder.alive())} ` +
            `attempts=${attempts} lastProbe=${lastProbe.state} lastError=${lastProbe.error ?? 'none'} ` +
            `stderr="${oneLine(holder.stderrTail(), MESSAGE_STDERR_CHARS)}" file=${file} ` +
            `profileDir=${profileDir} descriptor=${descriptorText}`,
          {
            ...diagnostics,
            pid,
            alive: holder.alive(),
            attempts,
            lastProbe: lastProbe.state,
            lastError: lastProbe.error,
            stderrTail: holder.stderrTail(),
          },
        );
      }
      await sleep(Math.min(backoffFor(attempts), budgetMs - elapsedMs));
    }
  } catch (error) {
    await holder.stop();
    throw error;
  }

  const setupMs = Date.now() - startedAt;
  if (attempts > 1) {
    // A flaky-looking pass must be visible in the log, never silent.
    console.warn(
      `[engine-lock-holder] ${path.basename(file)} was read live after ${attempts} probe attempts in ` +
        `${setupMs} ms (route=${route} pid=${pid})`,
    );
  }
  return { pid, route, attempts, setupMs, stop: holder.stop };
}

function unsupported(
  testContext: LockHolderTestContext,
  onUnsupported: 'skip' | 'fail',
  cause: LockHolderCause,
  reason: string,
  diagnostics: Record<string, unknown>,
): never {
  const message = `engine-lock-holder: ${reason}`;
  if (onUnsupported === 'skip' && typeof testContext.skip === 'function') {
    // Vitest's `skip()` throws, so nothing after this call runs. If a context's
    // skip ever returns, the named error below is the honest outcome.
    testContext.skip(message);
  }
  throw new EngineLockHolderError(cause, message, diagnostics);
}

function registerHolderStop(testContext: LockHolderTestContext, stop: () => Promise<void>): void {
  if (typeof testContext.after === 'function') {
    testContext.after(stop);
    return;
  }
  if (typeof testContext.onTestFinished === 'function') {
    testContext.onTestFinished(stop);
  }
}

function backoffFor(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt - 1, 0), BACKOFF_MS.length - 1)];
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function oneLine(text: string, limit: number): string {
  const collapsed = text.replaceAll(/\s+/gu, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}
