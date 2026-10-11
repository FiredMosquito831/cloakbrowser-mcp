import type { ChildProcess } from 'node:child_process';
import { mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type Cleanup = () => void | Promise<void>;
export const browserDisposalTimeout = 10000;

/** Bound the entire close operation, including PID and port observations. */
export async function withCleanupDeadline<T>(
  cleanup: () => Promise<T>,
  owner: string,
  forceTermination: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const message = `${owner} exceeded ${browserDisposalTimeout}ms`;
      try {
        forceTermination();
      } catch (cause) {
        const options = { cause };
        const error = new Error(message, options);
        reject(error);
        return;
      }
      const error = new Error(message);
      reject(error);
    }, browserDisposalTimeout);
  });
  try {
    const operation = cleanup();
    const contenders = [operation, expired];
    return await Promise.race(contenders);
  } finally {
    clearTimeout(timer);
  }
}

export function killOwnedProcess(pid: number | null | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
    throw error;
  }
}
export interface FreeBrowserRuntime {
  root: string;
  env: Record<string, string>;
  ownCleanup: (cleanup: Cleanup) => void;
  ownChild: (child: ChildProcess) => void;
  dispose: () => Promise<void>;
}

/** Own an empty temporary root and resources for a caller-verified Free binary. */
export async function createFreeBrowserRuntime(options: {
  root: string;
  freeExecutable: string;
  parentEnv?: NodeJS.ProcessEnv;
}): Promise<FreeBrowserRuntime> {
  const temporaryDirectory = tmpdir();
  const temporaryRoot = await realpath(temporaryDirectory);
  const root = await realpath(options.root);
  const relative = path.relative(temporaryRoot, root);
  const entries = await readdir(root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || entries.length) {
    throw new Error('Browser test runtime requires an empty owned temporary directory');
  }
  const executable = await realpath(options.freeExecutable);
  const cache = path.join(root, 'cloak-cache');
  const browsers = path.join(root, 'playwright-browsers');
  const env: Record<string, string> = {};
  const parentEnv = options.parentEnv ?? process.env;
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value !== undefined && !key.toUpperCase().startsWith('CLOAKBROWSER_')) env[key] = value;
  }
  env.CLOAKBROWSER_BINARY_PATH = executable;
  env.CLOAKBROWSER_CACHE_DIR = cache;
  env.CLOAKBROWSER_AUTO_UPDATE = 'false';
  env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  const removal = { recursive: true, force: true };
  const cleanups: Cleanup[] = [() => rm(root, removal)];
  let disposal: Promise<void> | undefined;
  const ownCleanup = (cleanup: Cleanup): void => {
    if (disposal) throw new Error('Browser test runtime is already disposing');
    cleanups.push(cleanup);
  };
  const ownChild = (child: ChildProcess): void => {
    ownCleanup(() => closeOwnedChild(child));
  };
  const dispose = (): Promise<void> => {
    disposal ??= disposeResources(cleanups);
    return disposal;
  };
  try {
    await mkdir(cache);
    await mkdir(browsers);
  } catch (error) {
    await dispose();
    throw error;
  }
  return { root, env, ownCleanup, ownChild, dispose };
}

async function disposeResources(cleanups: Cleanup[]): Promise<void> {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Browser test runtime cleanup failed');
}

function closeOwnedChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let forced = false;
    const finish = (error?: Error): void => {
      clearInterval(timer);
      child.off('close', onClose);
      child.off('error', finish);
      if (error) reject(error);
      else resolve();
    };
    const onClose = (): void => {
      finish();
    };
    const timer = setInterval(() => {
      if (forced) {
        const error = new Error('Owned test child did not close after termination');
        finish(error);
      } else {
        forced = true;
        child.kill('SIGKILL');
      }
    }, 2000);
    child.once('close', onClose);
    child.once('error', finish);
    child.kill();
  });
}
