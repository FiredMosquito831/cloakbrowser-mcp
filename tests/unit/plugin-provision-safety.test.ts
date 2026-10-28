// Provisioning safety (2.22.0): a rebuild must never destroy a runtime.
//
// The contract these tests pin is the one in
// `.orchestration/specs/2026-10-28-inv-provision-safety.md` §6:
//   I1  nothing is removed before a verified, marked replacement exists;
//   I2  the marker is the last byte written into a tree, inside that tree;
//   I3  a crash leaves a complete, correctly-marked tree the next start finds;
//   I4  a held tree is never renamed, emptied or pruned;
//   I5  reuse and rebuild depend only on inputs that change the installed bytes.
// The 2.20.0 regression — a manifest description edit rebuilding every runtime —
// is pinned by `venvRequest` below.
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

interface RunCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

interface VenvResolution {
  venv: string;
  scripts: string;
  python: string;
  marker: string;
  packages: string[];
  reused: boolean;
  hash: string;
  generation: string;
  keptGenerations: string[];
  state: string;
}

interface ProvisionModule {
  PROVISION_SCHEMA_VERSION: number;
  PROVISIONING_RECORD_SCHEMA_VERSION: number;
  PYTHON_VERSION: string;
  RUNTIME_RECIPE_VERSION: number;
  ensureNpmRuntime(options: Record<string, unknown>): Record<string, unknown>;
  ensureVenv(options: Record<string, unknown>): VenvResolution;
  probeVenvHolders(
    venvDir: string,
    options?: Record<string, unknown>,
  ): {
    certain: boolean;
    held: boolean;
    path: string | null;
  };
  readProvisioningRecord(dataDir: string, name: string): Record<string, unknown> | null;
  runtimeLease(
    target: string,
    options?: Record<string, unknown>,
  ): {
    path: string;
    pid: number | null;
  } | null;
  venvGenerationNames(dataDir: string, name: string): string[];
  writeProvisioningRecord(dataDir: string, name: string, record: Record<string, unknown>): string | null;
  writeRuntimeLease(target: string, options?: Record<string, unknown>): () => void;
}

interface LauncherModule {
  venvRequest(...args: string[]): Record<string, unknown>;
}

const provision = (await import(
  new URL('../../plugins/cloakbrowser/lib/provision.mjs', import.meta.url).href
)) as unknown as ProvisionModule;
const camoufoxLauncher = (await import(
  new URL('../../plugins/cloakbrowser/launch-camoufox.mjs', import.meta.url).href
)) as unknown as LauncherModule;
const nativeLauncher = (await import(
  new URL('../../plugins/cloakbrowser/launch-camoufox-native.mjs', import.meta.url).href
)) as unknown as LauncherModule;

const tempRoots: string[] = [];
const spawned: number[] = [];

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix = 'provision-safety-'): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function noopLog(): void {
  // The log lines are asserted where they are the contract.
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// path -> content hash for every file under a tree. Byte identity, not a count.
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files[path.relative(root, full)] = sha256File(full);
      }
    }
  };
  if (existsSync(root)) {
    walk(root);
  }
  return files;
}

const uv = { command: 'uv', version: '0.13.5', source: 'path' };
const python = { python: 'python-managed', version: provision.PYTHON_VERSION, source: 'managed' };

// The stub answers from the argv the provisioner actually passed: `uv venv` creates
// the tree where it was told to, and `uv pip install --python` lands the pins in
// that interpreter's site-packages. `failing` names a command that exits non-zero.
function fakeRunner(options: { failing?: string; installNothing?: boolean } = {}) {
  const calls: RunCall[] = [];
  const run = (command: string, args: string[], callOptions: RunCall['options']) => {
    calls.push({ command, args, options: callOptions });
    if (args[0] === options.failing) {
      return { status: 1, stdout: '', stderr: `${args[0]} refused in this test` };
    }
    if (args[0] === 'venv') {
      const dir = String(args[args.length - 1]);
      mkdirSync(path.join(dir, 'Scripts'), { recursive: true });
      writeFileSync(path.join(dir, 'Scripts', 'python.exe'), '');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'pip' && options.installNothing !== true) {
      const pythonPath = String(args[args.indexOf('--python') + 1]);
      const venvDir = path.dirname(path.dirname(pythonPath));
      for (const spec of args.slice(args.indexOf('--python') + 2)) {
        const at = spec.indexOf('==');
        const name = spec.slice(0, at).replace(/[-_.]+/g, '_');
        const version = spec.slice(at + 2);
        mkdirSync(path.join(venvDir, 'Lib', 'site-packages', `${name}-${version}.dist-info`), {
          recursive: true,
        });
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

function venvOptions(
  dataDir: string,
  overrides: Record<string, unknown> = {},
  runner: ReturnType<typeof fakeRunner> = fakeRunner(),
) {
  return {
    calls: runner.calls,
    options: {
      env: { PATH: '' },
      dataDir,
      uv,
      python,
      name: 'camoufox',
      packages: ['camoufox==1.0.0'],
      extra: { build: 'v1' },
      log: noopLog,
      run: runner.run,
      platform: 'win32',
      ...overrides,
    } as Record<string, unknown>,
  };
}

describe('I4 — a held tree is refused, never renamed, emptied or pruned', () => {
  it('refuses with one actionable line and leaves the tree byte-identical', () => {
    const dataDir = tempDir();
    const built = provision.ensureVenv(venvOptions(dataDir).options);
    // Make the generation need a rebuild, which is the only case in which the
    // provisioner may ever touch an existing tree at the target path.
    rmSync(path.join(built.venv, 'Lib', 'site-packages', 'camoufox-1.0.0.dist-info'), {
      recursive: true,
      force: true,
    });
    provision.writeRuntimeLease(built.venv, { pid: process.pid });
    const before = snapshot(built.venv);

    const touched: string[] = [];
    const refusal = venvOptions(dataDir, {
      openProbe: () => ({ held: true, code: 'EBUSY' }),
      rename: (from: string, to: string) => {
        touched.push(`rename:${from}->${to}`);
      },
      remove: (target: string, removeOptions: Record<string, unknown>) => {
        touched.push(`remove:${target}`);
        rmSync(target, removeOptions);
      },
    });
    let error: Error | null = null;
    try {
      provision.ensureVenv(refusal.options);
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).not.toBeNull();
    const message = String(error?.message);
    expect(message).toContain(built.venv);
    expect(message).toContain(`pid ${process.pid}`);
    expect(message).toContain('Nothing was changed');
    expect(message.length).toBeLessThanOrEqual(300);
    // The held tree was never the source or the target of a destructive step.
    expect(touched.filter((entry) => entry.includes(built.venv))).toEqual([]);
    expect(snapshot(built.venv)).toEqual(before);
    // The refusal is recorded, so browser_capabilities can report it.
    expect(provision.readProvisioningRecord(dataDir, 'camoufox')).toMatchObject({
      state: 'refused-held',
      generation: built.generation,
      holder: { pid: process.pid, source: 'lease' },
    });
  });

  it('refuses without a pid when no lease can name it, and says so', () => {
    const dataDir = tempDir();
    const built = provision.ensureVenv(venvOptions(dataDir).options);
    rmSync(path.join(built.venv, 'Lib', 'site-packages', 'camoufox-1.0.0.dist-info'), {
      recursive: true,
      force: true,
    });
    const before = snapshot(built.venv);
    expect(() =>
      provision.ensureVenv(
        venvOptions(dataDir, { openProbe: () => ({ held: true, code: 'EBUSY' }) }).options,
      ),
    ).toThrow(/is in use \(python\.exe\); close the Claude Code session using it and restart/);
    expect(snapshot(built.venv)).toEqual(before);
    const record = provision.readProvisioningRecord(dataDir, 'camoufox');
    expect(record).toMatchObject({ state: 'refused-held', holder: { pid: null, source: 'unknown' } });
    expect(String((record?.remedy as string | undefined) ?? '')).toContain('left untouched');
  });

  it('probes every Scripts executable and the venv-root DLLs, never just python.exe', () => {
    const root = tempDir();
    const venvDir = path.join(root, 'venvs', 'camoufox-00000000');
    mkdirSync(path.join(venvDir, 'Scripts'), { recursive: true });
    mkdirSync(path.join(venvDir, 'Lib', 'site-packages'), { recursive: true });
    for (const name of ['python.exe', 'pythonw.exe', 'mcp-camoufox.exe']) {
      writeFileSync(path.join(venvDir, 'Scripts', name), '');
    }
    writeFileSync(path.join(venvDir, 'python313.dll'), '');
    writeFileSync(path.join(venvDir, 'pyvenv.cfg'), '');
    const probed: string[] = [];
    const result = provision.probeVenvHolders(venvDir, {
      platform: 'win32',
      openProbe: (file: string) => {
        probed.push(path.basename(file));
        return file.endsWith('pythonw.exe') ? { held: true, code: 'EBUSY' } : { held: false };
      },
    });
    expect(result).toMatchObject({ certain: true, held: true });
    expect(path.basename(String(result.path))).toBe('pythonw.exe');
    // Every Scripts executable is probed, in a stable order, until one is held.
    expect(probed).toEqual(['mcp-camoufox.exe', 'python.exe', 'pythonw.exe']);
  });

  it('reports "cannot tell" on POSIX instead of pretending a tree is free', () => {
    const root = tempDir();
    mkdirSync(path.join(root, 'Scripts'), { recursive: true });
    writeFileSync(path.join(root, 'Scripts', 'python'), '');
    expect(provision.probeVenvHolders(root, { platform: 'linux' })).toEqual({
      certain: false,
      held: false,
      path: null,
    });
  });
});

describe('I2/I1 — ordering: build, verify, marker inside the new tree, one rename', () => {
  it('writes the marker into the staging tree before the rename and never deletes first', () => {
    const dataDir = tempDir();
    const events: string[] = [];
    const markerAtRename: boolean[] = [];
    const runner = fakeRunner();
    const options = venvOptions(
      dataDir,
      {
        run: (command: string, args: string[], callOptions: RunCall['options']) => {
          events.push(`run:${args[0]}`);
          return runner.run(command, args, callOptions);
        },
        rename: (from: string, to: string) => {
          events.push(`rename:${path.basename(from)}->${path.basename(to)}`);
          // The commit marker must already be inside the tree being moved.
          if (path.basename(from).startsWith('.t-')) {
            markerAtRename.push(existsSync(path.join(from, '.provision.json')));
          }
          rmSync(to, { recursive: true, force: true });
          renameSync(from, to);
        },
        remove: (target: string, removeOptions: Record<string, unknown>) => {
          events.push(`remove:${path.basename(target)}`);
          rmSync(target, removeOptions);
        },
      },
      runner,
    );
    const resolution = provision.ensureVenv(options.options);
    expect(resolution.state).toBe('built');
    const steps = events.filter((entry) => entry.startsWith('run:') || entry.startsWith('rename:'));
    expect(steps).toEqual([
      'run:venv',
      'run:pip',
      `rename:.t-camoufox-${resolution.generation}-${process.pid}->camoufox-${resolution.generation}`,
    ]);
    // No delete of anything that existed before the build. The only removal is the
    // no-op clear of this process's own staging path.
    expect(events.filter((entry) => entry.startsWith('remove:') && !entry.includes('.t-'))).toEqual([]);
    expect(markerAtRename).toEqual([true]);
  });

  it('never writes the marker into a tree that is still being filled', () => {
    const dataDir = tempDir();
    const runner = fakeRunner();
    const markerStates: boolean[] = [];
    provision.ensureVenv(
      venvOptions(
        dataDir,
        {
          run: (command: string, args: string[], callOptions: RunCall['options']) => {
            const result = runner.run(command, args, callOptions);
            if (args[0] === 'pip') {
              const pythonPath = String(args[args.indexOf('--python') + 1]);
              markerStates.push(
                existsSync(path.join(path.dirname(path.dirname(pythonPath)), '.provision.json')),
              );
            }
            return result;
          },
        },
        runner,
      ).options,
    );
    expect(markerStates).toEqual([false]);
  });
});

// A tiny indirection so the ordering test reads as a rename without importing it
// twice under different names.

describe('I1 — every failure leaves the previous generation byte-identical', () => {
  function twoGenerations(dataDir: string) {
    const previous = provision.ensureVenv(venvOptions(dataDir, { packages: ['camoufox==1.0.0'] }).options);
    const before = snapshot(previous.venv);
    return { previous, before };
  }

  it('records "uv venv failed" and keeps the previous generation', () => {
    const dataDir = tempDir();
    const { previous, before } = twoGenerations(dataDir);
    expect(() =>
      provision.ensureVenv(
        venvOptions(dataDir, { packages: ['camoufox==2.0.0'] }, fakeRunner({ failing: 'venv' })).options,
      ),
    ).toThrow(/uv venv failed for .*camoufox-[0-9a-f]{8}: venv refused in this test/);
    expect(snapshot(previous.venv)).toEqual(before);
    expect(provision.readProvisioningRecord(dataDir, 'camoufox')).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('uv venv failed'),
    });
  });

  it('records "uv pip install failed" and keeps the previous generation', () => {
    const dataDir = tempDir();
    const { previous, before } = twoGenerations(dataDir);
    expect(() =>
      provision.ensureVenv(
        venvOptions(dataDir, { packages: ['camoufox==2.0.0'] }, fakeRunner({ failing: 'pip' })).options,
      ),
    ).toThrow(/uv pip install failed for camoufox==2\.0\.0/);
    expect(snapshot(previous.venv)).toEqual(before);
  });

  it('refuses a tree without the pinned packages and says which are missing', () => {
    const dataDir = tempDir();
    const { previous, before } = twoGenerations(dataDir);
    expect(() =>
      provision.ensureVenv(
        venvOptions(dataDir, { packages: ['camoufox==2.0.0'] }, fakeRunner({ installNothing: true })).options,
      ),
    ).toThrow(/does not contain camoufox==2\.0\.0; refusing to start a mismatched runtime/);
    expect(snapshot(previous.venv)).toEqual(before);
  });

  it('reports a rename that cannot move the unusable tree aside, and keeps it', () => {
    const dataDir = tempDir();
    const built = provision.ensureVenv(venvOptions(dataDir).options);
    writeFileSync(built.marker, '{broken');
    const before = snapshot(built.venv);
    const rename = (from: string, to: string) => {
      if (to.includes('.bad-')) {
        const error = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      rmSync(to, { recursive: true, force: true });
      renameSync(from, to);
    };
    expect(() => provision.ensureVenv(venvOptions(dataDir, { rename }).options)).toThrow(
      /cannot move the unusable camoufox runtime .* aside \(EPERM\); it is left in place/,
    );
    expect(snapshot(built.venv)).toEqual(before);
  });

  it('reports a rename that cannot move the new tree into place, and keeps the old one', () => {
    const dataDir = tempDir();
    const built = provision.ensureVenv(venvOptions(dataDir).options);
    writeFileSync(built.marker, '{broken');
    const before = snapshot(built.venv);
    const rename = (from: string, to: string) => {
      if (path.basename(from).startsWith('.t-')) {
        const error = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      rmSync(to, { recursive: true, force: true });
      renameSync(from, to);
    };
    expect(() => provision.ensureVenv(venvOptions(dataDir, { rename }).options)).toThrow(
      /cannot move the new camoufox runtime into .* \(EPERM\); the previous generation was kept/,
    );
    expect(snapshot(built.venv)).toEqual(before);
  });

  it('reports both paths when the tree cannot be put back either', () => {
    const dataDir = tempDir();
    const built = provision.ensureVenv(venvOptions(dataDir).options);
    writeFileSync(built.marker, '{broken');
    const rename = (from: string, to: string) => {
      if (path.basename(from).startsWith('.t-') || to === built.venv) {
        const error = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      renameSync(from, to);
    };
    let error: Error | null = null;
    try {
      provision.ensureVenv(venvOptions(dataDir, { rename }).options);
    } catch (caught) {
      error = caught as Error;
    }
    expect(String(error?.message)).toMatch(/cannot move the new camoufox runtime into .* \(EPERM\)/);
    const aside = `${built.venv}.bad-${process.pid}`;
    expect(existsSync(aside)).toBe(true);
    expect(existsSync(path.join(aside, '.provision.json'))).toBe(true);
  });
});

describe('I3 — crash recovery', () => {
  it('completes an interrupted build from a marked staging tree whose process is gone', () => {
    const dataDir = tempDir();
    const first = venvOptions(dataDir);
    const built = provision.ensureVenv(first.options);
    // Simulate the crash: move the finished generation back to its staging name
    // with a pid that cannot be alive, and remove the target.
    const staging = path.join(dataDir, 'venvs', `.t-camoufox-${built.generation}-2147483647`);
    moveTree(built.venv, staging);
    const second = venvOptions(dataDir);
    const resolution = provision.ensureVenv(second.options);
    expect(resolution.venv).toBe(built.venv);
    expect(resolution.generation).toBe(built.generation);
    expect(second.calls).toEqual([]);
    expect(existsSync(staging)).toBe(false);
    expect(provision.readProvisioningRecord(dataDir, 'camoufox')).toMatchObject({
      state: 'reused',
      reason: 'completed an interrupted build',
    });
  });

  it('ignores a staging tree whose process is still alive', () => {
    const dataDir = tempDir();
    const first = venvOptions(dataDir);
    const built = provision.ensureVenv(first.options);
    // A live, unrelated pid: the parent process of this worker is guaranteed to be
    // running and is not this process, so the staging tree cannot be "ours".
    const staging = path.join(dataDir, 'venvs', `.t-camoufox-${built.generation}-${process.ppid}`);
    moveTree(built.venv, staging);
    const second = venvOptions(dataDir);
    const resolution = provision.ensureVenv(second.options);
    expect(resolution.venv).toBe(built.venv);
    expect(second.calls.length).toBeGreaterThan(0);
    expect(existsSync(staging)).toBe(true);
  });

  it('keeps every older generation and never prunes on a start', () => {
    const dataDir = tempDir();
    const older = provision.ensureVenv(venvOptions(dataDir, { packages: ['camoufox==1.0.0'] }).options);
    const newer = provision.ensureVenv(venvOptions(dataDir, { packages: ['camoufox==2.0.0'] }).options);
    expect(newer.keptGenerations).toContain(path.basename(older.venv));
    expect(provision.venvGenerationNames(dataDir, 'camoufox')).toEqual(
      [path.basename(older.venv), path.basename(newer.venv)].sort(),
    );
    expect(existsSync(older.marker)).toBe(true);
  });

  it('does not mistake one engine for another with a shared prefix', () => {
    const dataDir = tempDir();
    provision.ensureVenv(venvOptions(dataDir).options);
    provision.ensureVenv(venvOptions(dataDir, { name: 'camoufox-native' }).options);
    expect(provision.venvGenerationNames(dataDir, 'camoufox')).toHaveLength(1);
    expect(provision.venvGenerationNames(dataDir, 'camoufox-native')).toHaveLength(1);
  });
});

describe('I5 — reuse depends only on inputs that change the installed bytes', () => {
  it('keeps the same generation for a manifest description edit (the 2.20.0 regression)', () => {
    // The launchers no longer read engines/*.json into the venv inputs. A manifest
    // hash re-added to `extra` fails this deep equality, which is exactly the
    // change that rebuilt every user's runtime in 2.20.0.
    expect(camoufoxLauncher.venvRequest('camoufox-playwright-mcp==0.1.5', 'v156.0.1-beta.39')).toEqual({
      name: 'camoufox',
      packages: ['camoufox-playwright-mcp==0.1.5', 'fastmcp==3.4.7', 'mcp==1.29.0'],
      extra: { build: 'v156.0.1-beta.39' },
    });
    expect(nativeLauncher.venvRequest('mcp-camoufox==0.4.5')).toEqual({
      name: 'camoufox-native',
      packages: ['mcp-camoufox==0.4.5'],
      extra: { build: '156.0.1-beta.39' },
    });
  });

  it('writes a manifest description anywhere and still reuses the tree', () => {
    const dataDir = tempDir();
    const built = provision.ensureVenv(venvOptions(dataDir).options);
    // The generation is a function of the request, not of any file on disk.
    const manifest = path.join(tempDir(), 'camoufox.json');
    writeFileSync(manifest, JSON.stringify({ notes: 'a description edit' }));
    expect(readFileSync(manifest, 'utf8')).toContain('description edit');
    const again = venvOptions(dataDir);
    const resolution = provision.ensureVenv(again.options);
    expect(resolution.generation).toBe(built.generation);
    expect(resolution.reused).toBe(true);
    expect(again.calls).toEqual([]);
  });

  it('changes the generation when the wrapper pin, the stack or the build changes', () => {
    const dataDir = tempDir();
    const base = provision.ensureVenv(venvOptions(dataDir).options);
    for (const overrides of [
      { packages: ['camoufox==2.0.0'] },
      { packages: ['camoufox==1.0.0', 'fastmcp==3.4.8'] },
      { extra: { build: 'v2' } },
    ]) {
      expect(provision.ensureVenv(venvOptions(dataDir, overrides).options).generation).not.toBe(
        base.generation,
      );
    }
  });

  it('writes a self-describing record the broker can report', () => {
    const dataDir = tempDir();
    const built = provision.ensureVenv(venvOptions(dataDir).options);
    expect(provision.readProvisioningRecord(dataDir, 'camoufox')).toEqual({
      schemaVersion: provision.PROVISIONING_RECORD_SCHEMA_VERSION,
      engine: 'camoufox',
      state: 'built',
      venv: built.venv,
      generation: built.generation,
      holderProbe: 'windows',
      holder: null,
      keptGenerations: [],
      reason: null,
      remedy: null,
    });
  });
});

const HOLDER_MODE: 'windows' | 'none' = process.platform === 'win32' ? 'windows' : 'none';

describe.skipIf(HOLDER_MODE === 'none')('a real Windows holder (I4)', () => {
  it('refuses while a live process runs the tree, and rebuilds once it exits', async () => {
    const dataDir = tempDir();
    const built = provision.ensureVenv(venvOptions(dataDir).options);
    // The image a session actually executes: a real executable at Scripts/python.exe.
    copyFileSync(process.execPath, path.join(built.venv, 'Scripts', 'python.exe'));
    // Make the generation need a rebuild, so the target path is the one that must
    // be inspected before anything may touch it.
    rmSync(path.join(built.venv, 'Lib', 'site-packages', 'camoufox-1.0.0.dist-info'), {
      recursive: true,
      force: true,
    });
    const child = spawn(
      path.join(built.venv, 'Scripts', 'python.exe'),
      ['-e', 'setTimeout(() => {}, 600000)'],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    const pid = child.pid;
    expect(pid).toBeTypeOf('number');
    if (pid === undefined) {
      return;
    }
    spawned.push(pid);
    await waitForHolder(path.join(built.venv, 'Scripts', 'python.exe'));
    provision.writeRuntimeLease(built.venv, { pid });

    const exe = path.join(built.venv, 'Scripts', 'python.exe');
    const before = snapshot(built.venv);
    // The lesson, pinned: a stat is not a liveness detector. The held image stats
    // fine and a plain read succeeds; only an open with write access is refused.
    expect(statSync(exe).isFile()).toBe(true);
    expect(readFileSync(exe).length).toBeGreaterThan(0);
    expect(provision.probeVenvHolders(built.venv, { platform: 'win32' })).toMatchObject({
      certain: true,
      held: true,
    });

    let refusal: Error | null = null;
    try {
      provision.ensureVenv(venvOptions(dataDir).options);
    } catch (caught) {
      refusal = caught as Error;
    }
    expect(String(refusal?.message)).toContain(String(pid));
    expect(String(refusal?.message).length).toBeLessThanOrEqual(300);
    expect(snapshot(built.venv)).toEqual(before);

    // Kill the holder by its exact pid, then the same call succeeds.
    process.kill(pid);
    spawned.splice(spawned.indexOf(pid), 1);
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });
    const after = provision.ensureVenv(venvOptions(dataDir).options);
    expect(after.state).toBe('built');
    expect(existsSync(after.marker)).toBe(true);
    const marker = JSON.parse(readFileSync(after.marker, 'utf8')) as Record<string, unknown>;
    expect(marker.hash).toBe(after.hash);
    expect(statExists(path.join(built.venv, 'Lib', 'site-packages', 'camoufox-1.0.0.dist-info'))).toBe(true);
  }, 30000);
});

function statExists(candidate: string): boolean {
  try {
    return statSync(candidate).isFile() || statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function moveTree(from: string, to: string): void {
  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
}

async function waitForHolder(file: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const handle = openSync(file, 'r+');
      closeSync(handle);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EBUSY') {
        return;
      }
      throw error;
    }
  }
  throw new Error(`the holder never made ${file} exclusive`);
}

// --- npm runtime: the same shape, with the lease as the holder signal ---------
describe('the npm runtime is replaced beside, never deleted first', () => {
  const spec = 'cloakbrowser-mcp@1.15.1';
  const cliRelative = path.join('node_modules', 'cloakbrowser-mcp', 'dist', 'cli.js');

  function writeHealthyRuntime(dir: string, packageSpec = spec): string {
    const modules = path.join(dir, 'node_modules');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), '{}');
    writeFileSync(
      path.join(dir, '.installed.json'),
      `${JSON.stringify({ package: packageSpec, engine: '0.6.3', driver: 'patchright@1.64.1' })}\n`,
    );
    mkdirSync(path.dirname(path.join(dir, cliRelative)), { recursive: true });
    writeFileSync(path.join(dir, cliRelative), '// stub');
    for (const [directory, name, version] of [
      ['cloakbrowser', 'cloakbrowser', '0.6.3'],
      ['playwright-core', 'patchright-core', '1.64.1'],
      ['playwright', 'patchright', '1.64.1'],
    ]) {
      mkdirSync(path.join(modules, directory), { recursive: true });
      writeFileSync(path.join(modules, directory, 'package.json'), JSON.stringify({ name, version }));
    }
    return dir;
  }

  function installStub(calls: RunCall[]) {
    return (command: string, args: string[], options: RunCall['options']) => {
      calls.push({ command, args, options });
      writeHealthyRuntime(String(options.cwd));
      return { status: 0, stdout: '', stderr: '' };
    };
  }

  const locate = (dir: string, name: string): string | null => {
    const candidate = path.join(dir, cliRelative);
    return name === 'cloakbrowser-mcp' && statExists(candidate) ? candidate : null;
  };

  it('refuses while a session leases the runtime, and leaves it byte-identical', () => {
    const dataDir = tempDir();
    const runtime = path.join(dataDir, 'runtime');
    writeHealthyRuntime(runtime, 'cloakbrowser-mcp@1.14.0');
    provision.writeRuntimeLease(runtime, { pid: process.pid });
    const before = snapshot(runtime);
    const calls: RunCall[] = [];
    let error: Error | null = null;
    try {
      provision.ensureNpmRuntime({ env: {}, dataDir, spec, locate, run: installStub(calls) });
    } catch (caught) {
      error = caught as Error;
    }
    expect(String(error?.message)).toContain(`pid ${process.pid}`);
    expect(String(error?.message)).toContain('left untouched');
    expect(String(error?.message).length).toBeLessThanOrEqual(300);
    expect(calls).toEqual([]);
    expect(snapshot(runtime)).toEqual(before);
  });

  it('builds beside, marks last, then swaps in two renames and keeps the old tree', () => {
    const dataDir = tempDir();
    const runtime = path.join(dataDir, 'runtime');
    writeHealthyRuntime(runtime, 'cloakbrowser-mcp@1.14.0');
    const events: string[] = [];
    const markerBeforeInstall: boolean[] = [];
    const markerAtRename: boolean[] = [];
    const calls: RunCall[] = [];
    const run = installStub(calls);
    const resolution = provision.ensureNpmRuntime({
      env: {},
      dataDir,
      spec,
      locate,
      // A pid that cannot be alive, so the *later* start may prune the old tree.
      pid: 2147483647,
      run: (command: string, args: string[], options: RunCall['options']) => {
        events.push(`run:${args[0]}`);
        // The commit marker must not exist before npm has filled the tree.
        markerBeforeInstall.push(existsSync(path.join(String(options.cwd), '.installed.json')));
        return run(command, args, options);
      },
      rename: (from: string, to: string) => {
        events.push(`rename:${path.basename(from)}->${path.basename(to)}`);
        if (path.basename(from).startsWith('.rt-')) {
          markerAtRename.push(existsSync(path.join(from, '.installed.json')));
        }
        renameSync(from, to);
      },
    });
    expect(events).toEqual([
      'run:install',
      'rename:runtime->.old-2147483647',
      'rename:.rt-2147483647->runtime',
    ]);
    expect(resolution.reinstalled).toBe(true);
    expect(markerBeforeInstall).toEqual([false]);
    expect(markerAtRename).toEqual([true]);
    expect(statExists(path.join(runtime, cliRelative))).toBe(true);
    // The previous tree survives this start; it is deleted only on a later one.
    expect(statExists(path.join(dataDir, '.old-2147483647', cliRelative))).toBe(true);

    const later: RunCall[] = [];
    provision.ensureNpmRuntime({ env: {}, dataDir, spec, locate, run: installStub(later) });
    expect(later).toEqual([]);
    expect(existsSync(path.join(dataDir, '.old-2147483647'))).toBe(false);
  });

  it('leaves the old runtime startable when the install fails', () => {
    const dataDir = tempDir();
    const runtime = path.join(dataDir, 'runtime');
    writeHealthyRuntime(runtime, 'cloakbrowser-mcp@1.14.0');
    const before = snapshot(runtime);
    expect(() =>
      provision.ensureNpmRuntime({
        env: {},
        dataDir,
        spec,
        locate,
        run: () => ({ status: 1, stdout: '', stderr: 'ENOTFOUND registry.npmjs.org' }),
      }),
    ).toThrow(/npm install failed .*The previous runtime was left in place/);
    expect(snapshot(runtime)).toEqual(before);
    expect(statExists(path.join(runtime, cliRelative))).toBe(true);
  });

  it('adopts a complete leftover when the runtime is missing', () => {
    for (const prefix of ['.rt-', '.old-']) {
      const dataDir = tempDir();
      const leftover = path.join(dataDir, `${prefix}2147483647`);
      writeHealthyRuntime(leftover);
      const calls: RunCall[] = [];
      const resolution = provision.ensureNpmRuntime({
        env: {},
        dataDir,
        spec,
        locate,
        run: installStub(calls),
      });
      expect(calls).toEqual([]);
      expect(resolution.reinstalled).toBe(false);
      expect(statExists(path.join(dataDir, 'runtime', cliRelative))).toBe(true);
      expect(existsSync(leftover)).toBe(false);
    }
  });

  it('does not adopt a leftover that is not this plugin’s pinned tree', () => {
    const dataDir = tempDir();
    writeHealthyRuntime(path.join(dataDir, '.old-2147483647'), 'cloakbrowser-mcp@1.14.0');
    const calls: RunCall[] = [];
    provision.ensureNpmRuntime({ env: {}, dataDir, spec, locate, run: installStub(calls) });
    expect(calls.length).toBeGreaterThan(0);
    expect(existsSync(path.join(dataDir, '.old-2147483647'))).toBe(true);
  });

  it('does not adopt a leftover whose process is alive', () => {
    const dataDir = tempDir();
    const leftover = path.join(dataDir, `.old-${process.ppid}`);
    writeHealthyRuntime(leftover);
    const calls: RunCall[] = [];
    provision.ensureNpmRuntime({ env: {}, dataDir, spec, locate, run: installStub(calls) });
    expect(calls.length).toBeGreaterThan(0);
    expect(existsSync(leftover)).toBe(true);
  });
});

// --- the additive `provisioning` block ---------------------------------------
describe('browser_capabilities reports provisioning for the Python engines only', () => {
  const pluginDir = path.resolve('plugins/cloakbrowser');

  // A minimal MCP client over the broker's stdio. The launcher is made to fail
  // before it can provision anything (an explicit UV_BIN that does not exist), so
  // no network, no uv run and no runtime is created: the broker answers from its
  // meta-tools, which is exactly the degraded start a refusal produces.
  async function capabilities(dataDir: string, engine: string): Promise<Record<string, unknown>> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDir,
      STEALTH_ENGINE: engine,
      STEALTH_TOOL_PROFILE: 'full',
      UV_BIN: path.join(dataDir, 'no-such-uv.exe'),
    };
    for (const name of [
      'STEALTH_ACCOUNT',
      'STEALTH_PROFILE_ISOLATION',
      'STEALTH_IDENTITY_MODE',
      'STEALTH_PING_TIMEOUT_MS',
      'PLAYWRIGHT_MCP_USER_DATA_DIR',
    ]) {
      delete env[name];
    }
    const child = spawn(process.execPath, [path.join(pluginDir, 'broker.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });
    const pending = new Map<number, (value: Record<string, unknown>) => void>();
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line === '') continue;
        try {
          const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
          const id = message.id;
          const resolve = id === undefined ? undefined : pending.get(id);
          if (resolve !== undefined && id !== undefined) {
            pending.delete(id);
            resolve(message);
          }
        } catch {
          // Not a JSON-RPC line.
        }
      }
    });
    child.stderr.resume();
    let nextId = 1;
    const request = (method: string, params: Record<string, unknown> = {}) => {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    };
    try {
      await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'provision-safety-test', version: '1' },
      });
      const answer = await request('tools/call', { name: 'browser_capabilities', arguments: {} });
      return (answer.result as Record<string, unknown> | undefined)?.structuredContent as Record<
        string,
        unknown
      >;
    } finally {
      child.stdin.end();
      child.kill();
    }
  }

  it('adds the block for camoufox and reports the recorded generation', async () => {
    const dataDir = tempDir();
    provision.writeProvisioningRecord(dataDir, 'camoufox', {
      state: 'refused-held',
      venv: path.join(dataDir, 'venvs', 'camoufox-1a2b3c4d'),
      generation: '1a2b3c4d',
      holderProbe: 'windows',
      holder: {
        path: path.join(dataDir, 'venvs', 'camoufox-1a2b3c4d', 'Scripts', 'python.exe'),
        pid: 4321,
        source: 'lease',
      },
      keptGenerations: ['camoufox'],
      reason: 'the camoufox runtime is in use by pid 4321 (python.exe); close it and restart.',
      remedy:
        'Close the Claude Code session that is running the camoufox runtime (pid 4321), then restart Claude Code.',
    });
    const payload = await capabilities(dataDir, 'camoufox');
    expect(payload.provisioning).toMatchObject({
      venv: path.join(dataDir, 'venvs', 'camoufox-1a2b3c4d'),
      generation: '1a2b3c4d',
      state: 'refused-held',
      holderProbe: 'windows',
      holder: { pid: 4321, source: 'lease' },
      keptGenerations: ['camoufox'],
      reason: expect.stringContaining('pid 4321'),
      remedy: expect.stringContaining('Close the Claude Code session'),
    });
  });

  it('adds no key when no start has written a record', async () => {
    const dataDir = tempDir();
    const payload = await capabilities(dataDir, 'camoufox');
    expect(Object.keys(payload)).not.toContain('provisioning');
  });

  it('declares no record for the engines that provision nothing', () => {
    const registry = ['cloak', 'playwright', 'kameleo'];
    for (const engine of registry) {
      const manifest = JSON.parse(
        readFileSync(path.join(pluginDir, 'engines', `${engine}.json`), 'utf8'),
      ) as Record<string, unknown>;
      expect(manifest.provisioning).toBeUndefined();
      expect(
        JSON.parse(readFileSync(path.join(pluginDir, 'engines', 'camoufox.json'), 'utf8')).provisioning,
      ).toEqual({ record: 'camoufox' });
    }
  });
});
