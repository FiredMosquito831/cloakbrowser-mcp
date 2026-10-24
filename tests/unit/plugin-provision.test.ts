import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface RunCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

interface UvResolution {
  command: string;
  version: string;
  source: string;
  asset?: { asset: string; kind: string; sha256: string; url: string };
}

interface PythonResolution {
  python: string;
  version: string;
  source: string;
}

interface VenvResolution {
  venv: string;
  scripts: string;
  python: string;
  marker: string;
  packages: string[];
  reused: boolean;
  hash: string;
}

interface NpmResolution {
  dir: string;
  marker: string;
  cli: string | null;
  reinstalled: boolean;
}

interface ProvisionModule {
  DEFAULT_NPM_PACKAGE: string;
  NPM_DRIVER_PIN: string;
  NPM_ENGINE_WRAPPER_PIN: string;
  PROVISION_SCHEMA_VERSION: number;
  PYTHON_VERSION: string;
  UV_ASSETS: Record<string, { asset: string; kind: string; sha256: string }>;
  UV_VERSION: string;
  distInfoName(spec: string): string | null;
  ensureNpmRuntime(options: Record<string, unknown>): NpmResolution;
  ensurePython(options: Record<string, unknown>): PythonResolution;
  ensureUv(options: Record<string, unknown>): Promise<UvResolution>;
  ensureVenv(options: Record<string, unknown>): VenvResolution;
  extractUvArchive(kind: string, buffer: Buffer, destination: string, platform?: string): string;
  findOnPath(name: string, env: Record<string, string | undefined>, platform?: string): string | null;
  readTarEntries(buffer: Buffer): Map<string, Buffer>;
  readZipEntries(buffer: Buffer): Map<string, Buffer>;
  resolveUvAsset(
    platform?: string,
    arch?: string,
  ): { error?: string; asset?: string; kind?: string; sha256?: string; url?: string };
  sha256(buffer: Buffer): string;
  systemDependencies?: never;
  venvExecutablePath(venvDir: string, name: string, platform?: string): string;
  verifyChecksum(buffer: Buffer, expected: string): boolean;
}

const provision = (await import(
  new URL('../../plugins/cloakbrowser/lib/provision.mjs', import.meta.url).href
)) as unknown as ProvisionModule;

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function tempDir(prefix = 'cloakbrowser-provision-'): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function noopLog(): void {
  // Provisioning logs are asserted only where a test spies on stderr.
}

// A stored (uncompressed) zip writer: enough for readZipEntries and for the
// extraction path, and small enough to keep the test self-contained.
function createStoredZip(entries: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8');
    const nameBuffer = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBuffer);
    localOffset += local.length + nameBuffer.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

// A minimal ustar writer; readTarEntries does not verify the checksum.
function createTarGz(entries: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000755\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.write('        ', 148, 'ascii');
    header.write('0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    blocks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) {
      blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function createExecutable(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
}

describe('pinned uv asset resolution', () => {
  it('pins a release and a checksum for every supported platform', () => {
    expect(provision.UV_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(provision.PYTHON_VERSION).toMatch(/^3\.1[23]\.\d+$/);
    const keys = Object.keys(provision.UV_ASSETS).sort();
    expect(keys).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]);
    for (const key of keys) {
      const [platform, arch] = key.split('-');
      const resolution = provision.resolveUvAsset(platform, arch);
      expect(resolution.error).toBeUndefined();
      expect(resolution.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(resolution.url).toBe(
        `https://github.com/astral-sh/uv/releases/download/${provision.UV_VERSION}/${resolution.asset}`,
      );
      expect(resolution.url).toContain('github.com/astral-sh/uv/releases/download/');
    }
  });

  it('fails closed on an unknown platform with the override in the message', () => {
    const resolution = provision.resolveUvAsset('freebsd', 'x64');
    expect(resolution.error).toContain('not provisioned');
    expect(resolution.error).toContain('freebsd');
    expect(resolution.error).toContain('UV or UV_BIN');
  });

  it('verifies a checksum in constant form and rejects a changed byte', () => {
    const buffer = Buffer.from('the archive');
    expect(provision.verifyChecksum(buffer, provision.sha256(buffer))).toBe(true);
    expect(provision.verifyChecksum(buffer, provision.sha256(buffer).toUpperCase())).toBe(true);
    const tampered = Buffer.from(buffer);
    tampered[0] ^= 0xff;
    expect(provision.verifyChecksum(tampered, provision.sha256(buffer))).toBe(false);
  });
});

describe('archive extraction', () => {
  it('reads and extracts a zip archive by binary name', () => {
    const root = tempDir();
    const archive = createStoredZip({
      'uv.exe': 'uv-binary',
      'uvx.exe': 'uvx-binary',
      'readme.txt': 'ignored',
    });
    expect([...provision.readZipEntries(archive).keys()].sort()).toEqual(['readme.txt', 'uv.exe', 'uvx.exe']);
    const destination = path.join(root, 'uv');
    const binary = provision.extractUvArchive('zip', archive, destination, 'win32');
    expect(binary).toBe(path.join(destination, 'uv.exe'));
    expect(readFileSync(binary, 'utf8')).toBe('uv-binary');
    expect(readFileSync(path.join(destination, 'uvx.exe'), 'utf8')).toBe('uvx-binary');
    expect(statSync(destination).isDirectory()).toBe(true);
  });

  it('reads and extracts a tar.gz archive by binary name', () => {
    const root = tempDir();
    const archive = createTarGz({
      'uv-x86_64-unknown-linux-gnu/uv': 'uv-binary',
      'uv-x86_64-unknown-linux-gnu/uvx': 'uvx-binary',
      'uv-x86_64-unknown-linux-gnu/README.md': 'ignored',
    });
    expect([...provision.readTarEntries(gunzipSync(archive)).keys()].length).toBe(3);
    const destination = path.join(root, 'uv');
    const binary = provision.extractUvArchive('tar.gz', archive, destination, 'linux');
    expect(binary).toBe(path.join(destination, 'uv'));
    expect(readFileSync(binary, 'utf8')).toBe('uv-binary');
    expect(readFileSync(path.join(destination, 'uvx'), 'utf8')).toBe('uvx-binary');
  });

  it('names the missing binary instead of succeeding silently', () => {
    const root = tempDir();
    const archive = createStoredZip({ 'other.exe': 'x' });
    expect(() => provision.extractUvArchive('zip', archive, path.join(root, 'uv'), 'win32')).toThrow(
      /does not contain uv\.exe/,
    );
  });
});

describe('ensureUv precedence', () => {
  const versionRun = (calls: RunCall[]) => (command: string, args: string[], options: RunCall['options']) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: 'uv 0.13.5 (abc 2026-10-21)', stderr: '' };
  };

  it('uses UV_BIN before UV, PATH and the managed copy, without downloading', async () => {
    const calls: RunCall[] = [];
    const download = vi.fn(async () => Buffer.from('unused'));
    const resolution = await provision.ensureUv({
      env: { UV_BIN: 'uv-bin-command', UV: 'uv-command', PATH: '' },
      platform: 'win32',
      arch: 'x64',
      dataDir: tempDir(),
      log: noopLog,
      run: versionRun(calls),
      download,
    });
    expect(resolution).toMatchObject({ command: 'uv-bin-command', version: '0.13.5', source: 'env' });
    expect(download).not.toHaveBeenCalled();
    expect(calls[0].args).toEqual(['--version']);
  });

  it('uses UV when UV_BIN is unset', async () => {
    const calls: RunCall[] = [];
    const resolution = await provision.ensureUv({
      env: { UV: 'uv-command', PATH: '' },
      platform: 'win32',
      arch: 'x64',
      dataDir: tempDir(),
      log: noopLog,
      run: versionRun(calls),
      download: async () => Buffer.from('unused'),
    });
    expect(resolution).toMatchObject({ command: 'uv-command', source: 'env' });
  });

  it('fails on a broken explicit override instead of falling back', async () => {
    const calls: RunCall[] = [];
    const download = vi.fn(async () => Buffer.from('unused'));
    const missing = path.join(tempDir(), 'missing-uv.exe');
    await expect(
      provision.ensureUv({
        env: { UV_BIN: missing, PATH: '' },
        platform: 'win32',
        arch: 'x64',
        dataDir: tempDir(),
        log: noopLog,
        run: versionRun(calls),
        download,
      }),
    ).rejects.toThrow(/UV_BIN points at .*not an existing file/);
    expect(download).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('uses a working uv on PATH before the managed copy', async () => {
    const root = tempDir();
    const binDir = path.join(root, 'bin');
    createExecutable(path.join(binDir, 'uv.exe'));
    const calls: RunCall[] = [];
    const resolution = await provision.ensureUv({
      env: { PATH: binDir, PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      arch: 'x64',
      dataDir: tempDir(),
      log: noopLog,
      run: versionRun(calls),
      download: async () => Buffer.from('unused'),
    });
    expect(resolution.source).toBe('path');
    expect(resolution.command).toBe(path.join(binDir, 'uv.exe'));
  });

  it('reuses the managed copy with no download when it already runs', async () => {
    const dataDir = tempDir();
    const binary = path.join(dataDir, 'tools', 'uv', provision.UV_VERSION, 'uv.exe');
    createExecutable(binary);
    const download = vi.fn(async () => Buffer.from('unused'));
    const calls: RunCall[] = [];
    const resolution = await provision.ensureUv({
      env: { PATH: '' },
      platform: 'win32',
      arch: 'x64',
      dataDir,
      log: noopLog,
      run: versionRun(calls),
      download,
    });
    expect(resolution).toMatchObject({ command: binary, source: 'managed', version: '0.13.5' });
    expect(download).not.toHaveBeenCalled();
  });

  it('fails closed on a checksum mismatch and writes nothing', async () => {
    const dataDir = tempDir();
    await expect(
      provision.ensureUv({
        env: { PATH: '' },
        platform: 'win32',
        arch: 'x64',
        dataDir,
        log: noopLog,
        run: versionRun([]),
        download: async () => Buffer.from('tampered archive'),
      }),
    ).rejects.toThrow(/failed SHA-256 verification.*Nothing was installed/s);
    expect(() => statSync(path.join(dataDir, 'tools', 'uv', provision.UV_VERSION))).toThrow();
  });

  it('fails on an unknown platform before any download', async () => {
    const download = vi.fn(async () => Buffer.from('unused'));
    await expect(
      provision.ensureUv({
        env: { PATH: '' },
        platform: 'freebsd',
        arch: 'x64',
        dataDir: tempDir(),
        log: noopLog,
        run: versionRun([]),
        download,
      }),
    ).rejects.toThrow(/not provisioned for platform "freebsd"/);
    expect(download).not.toHaveBeenCalled();
  });
});

describe('ensurePython', () => {
  const uv = { command: 'uv', version: '0.13.5', source: 'path' };

  it('lets UV_PYTHON win over PYTHON and the managed interpreter', () => {
    const calls: RunCall[] = [];
    const resolution = provision.ensurePython({
      env: { UV_PYTHON: '3.12', PYTHON: 'python3' },
      dataDir: tempDir(),
      uv,
      log: noopLog,
      run: (command: string, args: string[], options: RunCall['options']) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(resolution).toMatchObject({ python: '3.12', source: 'uv-python' });
    expect(calls).toHaveLength(0);
  });

  it('uses PYTHON when UV_PYTHON is unset and validates a path', () => {
    const root = tempDir();
    const python = path.join(root, 'python.exe');
    writeFileSync(python, '');
    expect(
      provision.ensurePython({
        env: { PYTHON: python },
        dataDir: root,
        uv,
        log: noopLog,
        run: () => ({ status: 0, stdout: '', stderr: '' }),
      }),
    ).toMatchObject({ python, source: 'python' });
    expect(() =>
      provision.ensurePython({
        env: { PYTHON: path.join(root, 'missing-python.exe') },
        dataDir: root,
        uv,
        log: noopLog,
        run: () => ({ status: 0, stdout: '', stderr: '' }),
      }),
    ).toThrow(/PYTHON points at .*not an existing file/);
  });

  it('installs the pinned Python under the plugin data directory with no PATH or registry change', () => {
    const dataDir = tempDir();
    const managed = path.join(
      dataDir,
      'tools',
      'python',
      'cpython-3.13.17-windows-x86_64-none',
      'python.exe',
    );
    createExecutable(managed);
    const calls: RunCall[] = [];
    const resolution = provision.ensurePython({
      env: { PATH: '' },
      dataDir,
      uv,
      log: noopLog,
      platform: 'win32',
      run: (command: string, args: string[], options: RunCall['options']) => {
        calls.push({ command, args, options });
        if (args[1] === 'find') {
          const installed = calls.filter((call) => call.args[1] === 'find').length > 1;
          return { status: installed ? 0 : 1, stdout: installed ? `${managed}\n` : '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(resolution).toEqual({
      python: managed,
      version: provision.PYTHON_VERSION,
      source: 'managed',
    });
    const install = calls.find((call) => call.args[1] === 'install');
    expect(install?.args).toEqual([
      'python',
      'install',
      '--no-bin',
      '--no-registry',
      provision.PYTHON_VERSION,
    ]);
    expect(install?.options.env).toMatchObject({
      UV_PYTHON_INSTALL_DIR: path.join(dataDir, 'tools', 'python'),
      UV_CACHE_DIR: path.join(dataDir, 'cache', 'uv'),
    });
  });

  it('does not install again when the managed interpreter is already present', () => {
    const dataDir = tempDir();
    const managed = path.join(dataDir, 'tools', 'python', 'python.exe');
    createExecutable(managed);
    const calls: RunCall[] = [];
    const resolution = provision.ensurePython({
      env: { PATH: '' },
      dataDir,
      uv,
      log: noopLog,
      run: (command: string, args: string[], options: RunCall['options']) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: `${managed}\n`, stderr: '' };
      },
    });
    expect(resolution.source).toBe('managed');
    expect(calls).toHaveLength(1);
    expect(calls[0].args[1]).toBe('find');
  });
});

describe('ensureVenv marker reuse and rebuild', () => {
  const uv = { command: 'uv', version: '0.13.5', source: 'path' };
  const python = { python: 'python-managed', version: provision.PYTHON_VERSION, source: 'managed' };

  function fakeRunner(venvDir: string) {
    const calls: RunCall[] = [];
    const run = (command: string, args: string[], options: RunCall['options']) => {
      calls.push({ command, args, options });
      if (args[0] === 'venv') {
        createExecutable(path.join(venvDir, 'Scripts', 'python.exe'));
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'pip') {
        for (const spec of args.slice(4)) {
          const marker = spec.indexOf('==');
          const name = spec.slice(0, marker).replace(/[-_.]+/g, '_');
          const version = spec.slice(marker + 2);
          mkdirSync(path.join(venvDir, 'Lib', 'site-packages', `${name}-${version}.dist-info`), {
            recursive: true,
          });
        }
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    return { calls, run };
  }

  function options(dataDir: string, packages: string[], overrides: Record<string, unknown> = {}) {
    const venvDir = path.join(dataDir, 'venvs', 'camoufox');
    const fake = fakeRunner(venvDir);
    return {
      dataDir,
      venvDir,
      ...fake,
      options: {
        env: { PATH: '' },
        dataDir,
        uv,
        python,
        name: 'camoufox',
        packages,
        extra: { build: 'v1' },
        log: noopLog,
        run: fake.run,
        platform: 'win32',
        ...overrides,
      } as Record<string, unknown>,
    };
  }

  it('creates the venv, installs the pins and writes a marker', () => {
    const dataDir = tempDir();
    const { options: call } = options(dataDir, ['mcp-camoufox==0.4.5']);
    const resolution = provision.ensureVenv(call);
    expect(resolution.reused).toBe(false);
    expect(resolution.marker).toBe(path.join(dataDir, 'venvs', 'camoufox', '.provision.json'));
    const marker = JSON.parse(readFileSync(resolution.marker, 'utf8')) as Record<string, unknown>;
    expect(marker).toMatchObject({
      schemaVersion: provision.PROVISION_SCHEMA_VERSION,
      name: 'camoufox',
      uv: '0.13.5',
      python: provision.PYTHON_VERSION,
      packages: ['mcp-camoufox==0.4.5'],
      extra: { build: 'v1' },
    });
    expect(marker.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('passes the managed-Python and install arguments exactly', () => {
    const dataDir = tempDir();
    const { options: call, calls } = options(dataDir, ['mcp-camoufox==0.4.5']);
    provision.ensureVenv(call);
    const venv = calls.find((entry) => entry.args[0] === 'venv');
    expect(venv?.args).toEqual([
      'venv',
      '--python',
      'python-managed',
      '--no-python-downloads',
      '--clear',
      '--force',
      path.join(dataDir, 'venvs', 'camoufox'),
    ]);
    const pip = calls.find((entry) => entry.args[0] === 'pip');
    expect(pip?.args.slice(0, 4)).toEqual([
      'pip',
      'install',
      '--python',
      path.join(dataDir, 'venvs', 'camoufox', 'Scripts', 'python.exe'),
    ]);
    expect(pip?.args.slice(4)).toEqual(['mcp-camoufox==0.4.5']);
  });

  it('reuses a matching marker without running uv', () => {
    const dataDir = tempDir();
    const first = options(dataDir, ['mcp-camoufox==0.4.5']);
    provision.ensureVenv(first.options);
    const second = options(dataDir, ['mcp-camoufox==0.4.5']);
    const resolution = provision.ensureVenv(second.options);
    expect(resolution.reused).toBe(true);
    expect(second.calls).toHaveLength(0);
  });

  it('rebuilds when any marker input differs', () => {
    const variants: ((dir: string) => ReturnType<typeof options>)[] = [
      (dir) => options(dir, ['mcp-camoufox==0.4.6']),
      (dir) => options(dir, ['mcp-camoufox==0.4.5'], { extra: { build: 'v2' } }),
      (dir) =>
        options(dir, ['mcp-camoufox==0.4.5'], { uv: { command: 'uv', version: '0.14.0', source: 'path' } }),
      (dir) =>
        options(dir, ['mcp-camoufox==0.4.5'], {
          python: { python: 'python-managed', version: '3.12.9', source: 'managed' },
        }),
    ];
    for (const makeOptions of variants) {
      const dataDir = tempDir();
      const first = options(dataDir, ['mcp-camoufox==0.4.5']);
      provision.ensureVenv(first.options);
      const second = makeOptions(dataDir);
      const resolution = provision.ensureVenv(second.options);
      expect(resolution.reused).toBe(false);
      expect(second.calls.length).toBeGreaterThan(0);
    }
  });

  it('rebuilds when a pinned package directory disappeared under a matching marker', () => {
    const dataDir = tempDir();
    const first = options(dataDir, ['mcp-camoufox==0.4.5']);
    const created = provision.ensureVenv(first.options);
    rmSync(path.join(created.venv, 'Lib', 'site-packages', 'mcp_camoufox-0.4.5.dist-info'), {
      recursive: true,
      force: true,
    });
    const second = options(dataDir, ['mcp-camoufox==0.4.5']);
    const resolution = provision.ensureVenv(second.options);
    expect(resolution.reused).toBe(false);
    expect(second.calls.some((entry) => entry.args[0] === 'pip')).toBe(true);
  });

  it('rebuilds when the marker is unreadable or differs', () => {
    const dataDir = tempDir();
    const first = options(dataDir, ['mcp-camoufox==0.4.5']);
    const created = provision.ensureVenv(first.options);
    writeFileSync(created.marker, '{not json');
    const second = options(dataDir, ['mcp-camoufox==0.4.5']);
    expect(provision.ensureVenv(second.options).reused).toBe(false);

    const third = options(dataDir, ['mcp-camoufox==0.4.5']);
    const current = JSON.parse(readFileSync(created.marker, 'utf8')) as Record<string, unknown>;
    writeFileSync(created.marker, JSON.stringify({ ...current, hash: 'f'.repeat(64) }));
    expect(provision.ensureVenv(third.options).reused).toBe(false);
  });

  it('rejects a venv name that could escape the venvs directory', () => {
    for (const name of ['../escape', 'Bad Name', '', 'a/b']) {
      expect(() =>
        provision.ensureVenv({
          env: {},
          dataDir: tempDir(),
          uv,
          python,
          name,
          packages: ['x==1'],
          log: noopLog,
          run: () => ({ status: 0, stdout: '', stderr: '' }),
          platform: 'win32',
        }),
      ).toThrow(/not a valid venv name/);
    }
  });
});

describe('ensureNpmRuntime', () => {
  const spec = 'cloakbrowser-mcp@1.15.1';
  const cliRelative = path.join('node_modules', 'cloakbrowser-mcp', 'dist', 'cli.js');

  function writeHealthyRuntime(dataDir: string): string {
    const runtime = path.join(dataDir, 'runtime');
    const modules = path.join(runtime, 'node_modules');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(path.join(runtime, 'package.json'), '{}');
    writeFileSync(
      path.join(runtime, '.installed.json'),
      `${JSON.stringify({ package: spec, engine: '0.6.3', driver: 'patchright@1.64.1' })}\n`,
    );
    mkdirSync(path.dirname(path.join(runtime, cliRelative)), { recursive: true });
    writeFileSync(path.join(runtime, cliRelative), '// stub');
    for (const [directory, name, version] of [
      ['cloakbrowser', 'cloakbrowser', '0.6.3'],
      ['playwright-core', 'patchright-core', '1.64.1'],
      ['playwright', 'patchright', '1.64.1'],
    ]) {
      mkdirSync(path.join(modules, directory), { recursive: true });
      writeFileSync(path.join(modules, directory, 'package.json'), JSON.stringify({ name, version }));
    }
    return runtime;
  }

  it('reuses a healthy runtime without running npm', () => {
    const dataDir = tempDir();
    const runtime = writeHealthyRuntime(dataDir);
    const calls: RunCall[] = [];
    const resolution = provision.ensureNpmRuntime({
      env: {},
      dataDir,
      spec,
      locate: (dir: string, name: string) =>
        dir === runtime && name === 'cloakbrowser-mcp' ? path.join(dir, cliRelative) : null,
      run: (command: string, args: string[], options: RunCall['options']) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(resolution.reinstalled).toBe(false);
    expect(resolution.dir).toBe(runtime);
    expect(calls).toHaveLength(0);
  });

  it('reinstalls cleanly with the unchanged pins, package.json and marker', () => {
    const dataDir = tempDir();
    const runtime = path.join(dataDir, 'runtime');
    const calls: RunCall[] = [];
    const resolution = provision.ensureNpmRuntime({
      env: {},
      dataDir,
      spec,
      locate: (dir: string, name: string) => {
        const candidate = path.join(dir, cliRelative);
        return name === 'cloakbrowser-mcp' && statExists(candidate) ? candidate : null;
      },
      run: (command: string, args: string[], options: RunCall['options']) => {
        calls.push({ command, args, options });
        mkdirSync(path.dirname(path.join(runtime, cliRelative)), { recursive: true });
        writeFileSync(path.join(runtime, cliRelative), '// stub');
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(resolution.reinstalled).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['install', '--omit=dev', '--no-audit', '--no-fund']);
    expect(calls[0].options.cwd).toBe(runtime);
    const packageJson = JSON.parse(readFileSync(path.join(runtime, 'package.json'), 'utf8')) as {
      private: boolean;
      dependencies: Record<string, string>;
      overrides: Record<string, string>;
    };
    expect(packageJson).toEqual({
      private: true,
      dependencies: { 'cloakbrowser-mcp': '1.15.1' },
      overrides: {
        cloakbrowser: '0.6.3',
        playwright: 'npm:patchright@1.64.1',
        'playwright-core': 'npm:patchright-core@1.64.1',
      },
    });
    expect(JSON.parse(readFileSync(path.join(runtime, '.installed.json'), 'utf8')) as unknown).toEqual({
      package: spec,
      engine: '0.6.3',
      driver: 'patchright@1.64.1',
    });
  });

  it('fails with the exit status when npm install fails', () => {
    const dataDir = tempDir();
    expect(() =>
      provision.ensureNpmRuntime({
        env: {},
        dataDir,
        spec,
        locate: () => null,
        run: () => ({ status: 3, stdout: '', stderr: '' }),
      }),
    ).toThrow(/npm install failed for cloakbrowser-mcp@1\.15\.1 .*\(exit 3\)/);
  });

  it('uses the caller-specific missing-entry error after a successful install', () => {
    expect(() =>
      provision.ensureNpmRuntime({
        env: {},
        dataDir: tempDir(),
        spec,
        locate: () => null,
        missingAfterInstallError: (dir: string) => `custom missing entry point in ${dir}`,
        run: () => ({ status: 0, stdout: '', stderr: '' }),
      }),
    ).toThrow(/custom missing entry point/);
  });
});

function statExists(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

describe('helpers', () => {
  it('normalizes distribution names for marker checks', () => {
    expect(provision.distInfoName('mcp-camoufox==0.4.5')).toBe('mcp_camoufox-0.4.5.dist-info');
    expect(provision.distInfoName('camoufox-playwright-mcp==0.1.5')).toBe(
      'camoufox_playwright_mcp-0.1.5.dist-info',
    );
    expect(provision.distInfoName('unpinned')).toBeNull();
  });

  it('builds the venv console-script path per platform', () => {
    expect(provision.venvExecutablePath('/data/venvs/x', 'mcp-camoufox', 'win32')).toBe(
      path.join('/data/venvs/x', 'Scripts', 'mcp-camoufox.exe'),
    );
    expect(provision.venvExecutablePath('/data/venvs/x', 'mcp-camoufox', 'linux')).toBe(
      path.join('/data/venvs/x', 'bin', 'mcp-camoufox'),
    );
  });
});
