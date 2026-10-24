// Dependency provisioning for every engine launcher.
//
// Every local dependency is installed into ${CLAUDE_PLUGIN_DATA} at the first MCP
// server start: a pinned, checksum-verified `uv` binary; a uv-managed Python; a
// Python venv with a JSON marker; and the npm runtime the Chromium engines use.
// Nothing is installed system-wide, no shell is started, and every log line goes
// to stderr so the MCP stdout stream stays pure JSON-RPC.
//
// The pins below were read from the official uv release 0.13.5 (published
// 2026-10-22) and its `dist-manifest.json` asset checksums; the managed CPython
// 3.13.17 build is the one uv 0.13.5 offers. Do not invent a version here: bump
// the four values together after reading the release metadata, and update the
// per-asset SHA-256 values in the same commit.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';

export const PROVISION_SCHEMA_VERSION = 1;
export const UV_VERSION = '0.13.5';
// The pinned release is also the floor for any uv the plugin did not download:
// uv 0.11.x cannot install the managed CPython 3.13.17 ("No download found for
// request: cpython-3.13.17-windows-x86_64-none"), so an older uv is refused
// when it is explicit and replaced when it comes from PATH.
export const UV_MINIMUM_VERSION = UV_VERSION;
export const PYTHON_VERSION = '3.13.17';
export const UV_RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/`;
export const UV_ASSETS = Object.freeze({
  'win32-x64': Object.freeze({
    asset: 'uv-x86_64-pc-windows-msvc.zip',
    kind: 'zip',
    sha256: 'a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a',
  }),
  'win32-arm64': Object.freeze({
    asset: 'uv-aarch64-pc-windows-msvc.zip',
    kind: 'zip',
    sha256: '09f47edf90726084a70f9426f6e3ca4f46e9bf7cbf23b1716ec64d60b055fae3',
  }),
  'linux-x64': Object.freeze({
    asset: 'uv-x86_64-unknown-linux-gnu.tar.gz',
    kind: 'tar.gz',
    sha256: 'f68d291c75783122dad58ab77def0e13f3233f358731db5d6d7e8715603b928f',
  }),
  'linux-arm64': Object.freeze({
    asset: 'uv-aarch64-unknown-linux-gnu.tar.gz',
    kind: 'tar.gz',
    sha256: '4bb69cf95ed13f23713bb7bc09f241896ea0c75b7c557e615a20604b82f9c403',
  }),
  'darwin-x64': Object.freeze({
    asset: 'uv-x86_64-apple-darwin.tar.gz',
    kind: 'tar.gz',
    sha256: 'b0f52b0e3945b4107d89024ea38e625683011fbfc05a0d98f9fa2d6dcee28c66',
  }),
  'darwin-arm64': Object.freeze({
    asset: 'uv-aarch64-apple-darwin.tar.gz',
    kind: 'tar.gz',
    sha256: '743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73',
  }),
});

// Kept in sync with the runtime the plugin has installed since 1.x. A unit test
// pins these identities; the npm provisioner below is shared by launch.mjs
// (cloak, playwright) and launch-kameleo.mjs, so a drift would make one
// launcher reinstall the tree the other just validated.
export const NPM_ENGINE_WRAPPER_PIN = '0.6.3';
export const NPM_DRIVER_PIN = 'patchright@1.64.1';
export const DEFAULT_NPM_PACKAGE = 'cloakbrowser-mcp@1.15.1';

const VENV_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

function logLine(log, message) {
  log(message);
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(candidate, platform) {
  if (!isFile(candidate)) {
    return false;
  }
  if (platform === 'win32') {
    return true;
  }
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function truncate(value, max = 120) {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function stderrTail(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  return value === '' ? 'no output' : truncate(value.slice(-400), 400);
}

function lastNonEmptyLine(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length === 0 ? null : lines[lines.length - 1];
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function verifyChecksum(buffer, expected) {
  return typeof expected === 'string' && sha256(buffer) === expected.toLowerCase();
}

export function resolveUvAsset(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const entry = UV_ASSETS[key];
  if (entry === undefined) {
    return {
      error:
        `uv ${UV_VERSION} is not provisioned for platform "${platform}" architecture "${arch}". ` +
        `Supported: ${Object.keys(UV_ASSETS).join(', ')}. Set UV or UV_BIN to an existing uv executable.`,
    };
  }
  return {
    key,
    asset: entry.asset,
    kind: entry.kind,
    sha256: entry.sha256,
    url: `${UV_RELEASE_BASE}${entry.asset}`,
  };
}

export function uvExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'uv.exe' : 'uv';
}

function uvArchiveNames(platform) {
  return platform === 'win32' ? ['uv.exe', 'uvx.exe', 'uvw.exe'] : ['uv', 'uvx', 'uvw'];
}

function readCString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.toString('utf8', 0, end === -1 ? slice.length : end);
}

function parseOctal(buffer, offset, length) {
  const text = buffer
    .toString('ascii', offset, offset + length)
    .replace(/\0/g, ' ')
    .trim();
  return text === '' ? 0 : Number.parseInt(text, 8) || 0;
}

// Minimal tar reader for the official uv archives: regular files, GNU long
// names, no sparse files. The archives contain the two binaries at one level,
// so a full tar implementation would be unearned complexity.
export function readTarEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  let pendingName = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    let name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    if (prefix !== '') {
      name = `${prefix}/${name}`;
    }
    const size = parseOctal(header, 124, 12);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    if (type === 'L') {
      pendingName = buffer.toString('utf8', dataStart, dataStart + size).replace(/\0[\s\S]*$/, '');
    } else if (type === '0' || type === '7') {
      entries.set(pendingName ?? name, Buffer.from(buffer.subarray(dataStart, dataStart + size)));
      pendingName = null;
    } else {
      pendingName = null;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

// Minimal zip reader for the official uv Windows archives (deflate or stored).
// Sizes come from the central directory, so data descriptors are harmless.
export function readZipEntries(buffer) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error('the downloaded archive is not a zip file (no end-of-central-directory record)');
  }
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error('the downloaded zip file has a malformed central directory');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
      throw new Error(`the downloaded zip file has a malformed entry for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      entries.set(name, Buffer.from(compressed));
    } else if (method === 8) {
      entries.set(name, inflateRawSync(compressed));
    } else {
      throw new Error(`the downloaded zip file uses unsupported compression method ${method} for ${name}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function extractUvArchive(kind, buffer, destination, platform = process.platform) {
  const entries = kind === 'zip' ? readZipEntries(buffer) : readTarEntries(gunzipSync(buffer));
  const wanted = new Set(uvArchiveNames(platform));
  mkdirSync(destination, { recursive: true });
  for (const [name, content] of entries) {
    const base = path.posix.basename(name);
    if (!wanted.has(base)) {
      continue;
    }
    const target = path.join(destination, base);
    writeFileSync(target, content);
    if (platform !== 'win32') {
      chmodSync(target, 0o755);
    }
  }
  const binary = path.join(destination, uvExecutableName(platform));
  if (!isFile(binary)) {
    throw new Error(`the downloaded uv archive does not contain ${uvExecutableName(platform)}`);
  }
  return binary;
}

export function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

async function defaultDownload(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function uvVersionOf(command, run) {
  const result = run(command, ['--version'], {});
  if (result === null || result.status !== 0) {
    return null;
  }
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = /uv\s+(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/.exec(text);
  return match === null ? null : match[1];
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

// Parse a semver string: an optional leading "v", an optional -prerelease and an
// optional +build. Build metadata is ignored, as semver specifies; anything
// malformed returns null instead of a guessed version.
export function parseVersion(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = VERSION_PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  if (prerelease.some((identifier) => identifier === '')) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const a = left.replace(/^0+(?=\d)/, '');
    const b = right.replace(/^0+(?=\d)/, '');
    if (a.length !== b.length) {
      return a.length < b.length ? -1 : 1;
    }
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    // A release sorts after all of its own prereleases.
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const result = compareIdentifiers(left[index], right[index]);
    if (result !== 0) {
      return result;
    }
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

// Semver precedence: -1 when left sorts first, 0 when equal, 1 when left sorts
// last, and null when either side is not a version. A prerelease sorts before
// its release (0.13.5-rc.1 < 0.13.5); build metadata is ignored.
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) {
    return null;
  }
  for (const part of ['major', 'minor', 'patch']) {
    if (a[part] !== b[part]) {
      return a[part] < b[part] ? -1 : 1;
    }
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

// True only for a version that parses and is at or above the minimum: a probe
// that failed or answered something unparsable never satisfies a floor.
export function isVersionAtLeast(version, minimum) {
  const result = compareVersions(version, minimum);
  return result !== null && result >= 0;
}

export function findOnPath(name, env = process.env, platform = process.platform) {
  const raw = env.PATH ?? env.Path ?? '';
  const directories = raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const candidates = [];
  for (const directory of directories) {
    if (platform === 'win32') {
      const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((extension) => extension.trim().toLowerCase())
        .filter((extension) => extension !== '' && extension !== '.bat' && extension !== '.cmd');
      for (const extension of extensions) {
        candidates.push(path.join(directory, `${name}${extension}`));
      }
    } else {
      candidates.push(path.join(directory, name));
    }
  }
  for (const candidate of candidates) {
    if (isExecutableFile(candidate, platform)) {
      return candidate;
    }
  }
  return null;
}

function explicitUv(env, platform) {
  for (const variable of ['UV_BIN', 'UV']) {
    const value = nonEmpty(env[variable]);
    if (value === null) {
      continue;
    }
    const lower = value.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      return {
        error:
          `${variable} points at "${truncate(value)}", which is a shell script. ` +
          'The plugin starts no shell; point it at the uv executable (uv.exe) instead.',
      };
    }
    const looksLikePath = value.includes('/') || value.includes('\\') || /^[A-Za-z]:/.test(value);
    if (looksLikePath && !isFile(value)) {
      return { error: `${variable} points at "${truncate(value)}", which is not an existing file.` };
    }
    return { command: value, variable };
  }
  return null;
}

// Resolve a usable uv in this order: an explicit UV_BIN/UV override, a working
// uv on PATH, then the plugin-managed pinned copy. An explicit override is
// authoritative: a broken value fails instead of silently falling back, and so
// does one older than the pinned uv because it cannot install the managed
// Python. A PATH uv is only a suggestion: when it is missing, broken, older
// than the pin or answers with an unparsable version, the pinned copy is used.
export async function ensureUv(options = {}) {
  const {
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    dataDir,
    log = () => {},
    run = defaultRun,
    download = defaultDownload,
  } = options;
  if (nonEmpty(dataDir) === null) {
    throw new Error('ensureUv needs the plugin data directory.');
  }
  const explicit = explicitUv(env, platform);
  if (explicit !== null) {
    if (explicit.error !== undefined) {
      throw new Error(`${explicit.error} Nothing was downloaded.`);
    }
    const version = uvVersionOf(explicit.command, run);
    if (version === null) {
      throw new Error(
        `${explicit.variable} points at "${truncate(explicit.command)}", which did not answer --version. ` +
          'Point it at a working uv executable, or unset it to let the plugin provision the pinned copy.',
      );
    }
    if (!isVersionAtLeast(version, UV_MINIMUM_VERSION)) {
      throw new Error(
        `${explicit.variable} points at uv ${version} (${truncate(explicit.command)}), which is older than the ` +
          `minimum uv ${UV_MINIMUM_VERSION}: "uv python install ${PYTHON_VERSION}" fails on it. ` +
          `Update that uv to ${UV_MINIMUM_VERSION} or newer, or unset ${explicit.variable} to let the plugin ` +
          'provision its pinned copy. Nothing was downloaded.',
      );
    }
    log(`using uv ${version} from ${explicit.variable} (${explicit.command})`);
    return { command: explicit.command, version, source: 'env', variable: explicit.variable };
  }

  const onPath = findOnPath('uv', env, platform);
  if (onPath !== null) {
    const version = uvVersionOf(onPath, run);
    if (version !== null && isVersionAtLeast(version, UV_MINIMUM_VERSION)) {
      log(`using uv ${version} from PATH (${onPath})`);
      return { command: onPath, version, source: 'path' };
    }
    if (version === null) {
      log(`the uv on PATH (${onPath}) did not answer --version; provisioning the pinned copy instead`);
    } else {
      log(
        `the uv on PATH (${onPath}) is ${version}, older than the pinned uv ${UV_VERSION}; ` +
          'provisioning the pinned copy instead',
      );
    }
  }

  const asset = resolveUvAsset(platform, arch);
  if (asset.error !== undefined) {
    throw new Error(`${asset.error} Nothing was downloaded.`);
  }
  const versionDir = path.join(dataDir, 'tools', 'uv', UV_VERSION);
  const binary = path.join(versionDir, uvExecutableName(platform));
  if (isExecutableFile(binary, platform)) {
    const version = uvVersionOf(binary, run);
    if (version !== null && isVersionAtLeast(version, UV_MINIMUM_VERSION)) {
      log(`using the plugin-managed uv ${version} at ${binary}`);
      return { command: binary, version, source: 'managed', asset };
    }
    if (version !== null) {
      log(`the plugin-managed uv at ${binary} is ${version}, older than ${UV_MINIMUM_VERSION}; replacing it`);
    }
  }

  log(`downloading uv ${UV_VERSION} from ${asset.url} (one-time, about 15 MB)`);
  let buffer;
  try {
    buffer = await download(asset.url);
  } catch (error) {
    throw new Error(
      `Could not download uv ${UV_VERSION} from ${asset.url}: ${error.message}. ` +
        'Check the network connection, or set UV or UV_BIN to an existing uv executable.',
    );
  }
  if (!verifyChecksum(buffer, asset.sha256)) {
    throw new Error(
      `uv ${UV_VERSION} (${asset.asset}) failed SHA-256 verification: expected ${asset.sha256}, ` +
        `got ${sha256(buffer)}. Nothing was installed.`,
    );
  }
  const temporary = `${versionDir}.tmp-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  try {
    extractUvArchive(asset.kind, buffer, temporary, platform);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw new Error(`Could not extract the pinned uv ${UV_VERSION} archive: ${error.message}`);
  }
  rmSync(versionDir, { recursive: true, force: true });
  mkdirSync(path.dirname(versionDir), { recursive: true });
  renameSync(temporary, versionDir);
  const version = uvVersionOf(binary, run);
  if (version === null || !isVersionAtLeast(version, UV_MINIMUM_VERSION)) {
    rmSync(versionDir, { recursive: true, force: true });
    throw new Error(
      `The pinned uv ${UV_VERSION} was installed at ${versionDir} but ` +
        `${version === null ? 'did not answer --version' : `reported ${version} instead of ${UV_MINIMUM_VERSION} or newer`}. ` +
        'Nothing usable was left behind.',
    );
  }
  log(`uv ${version} installed at ${versionDir}`);
  return { command: binary, version, source: 'managed', asset };
}

export function uvEnvironment(env, dataDir) {
  return {
    ...env,
    UV_PYTHON_INSTALL_DIR: path.join(dataDir, 'tools', 'python'),
    UV_CACHE_DIR: path.join(dataDir, 'cache', 'uv'),
  };
}

function validateInterpreterOverride(variable, value) {
  const looksLikePath = value.includes('/') || value.includes('\\') || /^[A-Za-z]:/.test(value);
  if (looksLikePath && !isFile(value)) {
    throw new Error(`${variable} points at "${truncate(value)}", which is not an existing file.`);
  }
  return value;
}

// Resolve the interpreter for a venv: UV_PYTHON, then PYTHON, then a uv-managed
// CPython installed under the plugin data directory. No system Python is needed.
export function ensurePython(options = {}) {
  const {
    env = process.env,
    dataDir,
    uv,
    log = () => {},
    run = defaultRun,
    platform = process.platform,
  } = options;
  if (nonEmpty(dataDir) === null) {
    throw new Error('ensurePython needs the plugin data directory.');
  }
  const uvPython = nonEmpty(env.UV_PYTHON);
  if (uvPython !== null) {
    const python = validateInterpreterOverride('UV_PYTHON', uvPython);
    log(`using the UV_PYTHON override (${python})`);
    return { python, version: `UV_PYTHON:${python}`, source: 'uv-python' };
  }
  const pythonOverride = nonEmpty(env.PYTHON);
  if (pythonOverride !== null) {
    const python = validateInterpreterOverride('PYTHON', pythonOverride);
    log(`using the PYTHON override (${python})`);
    return { python, version: `PYTHON:${python}`, source: 'python' };
  }

  const installDir = path.join(dataDir, 'tools', 'python');
  const uvEnv = uvEnvironment(env, dataDir);
  const findArgs = ['python', 'find', '--no-project', '--managed-python', PYTHON_VERSION];
  const found = run(uv.command, findArgs, { env: uvEnv });
  const existing = found !== null && found.status === 0 ? lastNonEmptyLine(found.stdout) : null;
  if (existing !== null && isFile(existing)) {
    log(`using the plugin-managed Python ${PYTHON_VERSION} at ${existing}`);
    return { python: existing, version: PYTHON_VERSION, source: 'managed' };
  }

  log(`installing the plugin-managed Python ${PYTHON_VERSION} under ${installDir} (one-time, about 50 MB)`);
  const installArgs = [
    'python',
    'install',
    '--no-bin',
    ...(platform === 'win32' ? ['--no-registry'] : []),
    PYTHON_VERSION,
  ];
  const install = run(uv.command, installArgs, { env: uvEnv });
  if (install === null || install.status !== 0) {
    throw new Error(`uv python install ${PYTHON_VERSION} failed: ${stderrTail(install?.stderr)}`);
  }
  const after = run(uv.command, findArgs, { env: uvEnv });
  const python = after !== null && after.status === 0 ? lastNonEmptyLine(after.stdout) : null;
  if (python === null || !isFile(python)) {
    throw new Error(
      `uv installed Python ${PYTHON_VERSION} but "uv python find" did not return an interpreter: ` +
        stderrTail(after?.stderr),
    );
  }
  log(`the plugin-managed Python ${PYTHON_VERSION} is ready at ${python}`);
  return { python, version: PYTHON_VERSION, source: 'managed' };
}

export function venvPaths(venvDir, platform = process.platform) {
  const isWindows = platform === 'win32';
  const scripts = path.join(venvDir, isWindows ? 'Scripts' : 'bin');
  return {
    venv: venvDir,
    scripts,
    python: path.join(scripts, isWindows ? 'python.exe' : 'python'),
  };
}

export function venvScriptsDir(venvDir, platform = process.platform) {
  return venvPaths(venvDir, platform).scripts;
}

export function venvExecutablePath(venvDir, name, platform = process.platform) {
  const suffix = platform === 'win32' ? '.exe' : '';
  return path.join(venvScriptsDir(venvDir, platform), `${name}${suffix}`);
}

export function normalizePackageName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '_');
}

export function distInfoName(spec) {
  const marker = spec.indexOf('==');
  if (marker <= 0) {
    return null;
  }
  const name = spec.slice(0, marker);
  const version = spec.slice(marker + 2);
  if (name === '' || version === '') {
    return null;
  }
  return `${normalizePackageName(name)}-${version}.dist-info`;
}

function readdirSyncSafe(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function sitePackagesDirs(venvDir, platform) {
  if (platform === 'win32') {
    return [path.join(venvDir, 'Lib', 'site-packages')];
  }
  const lib = path.join(venvDir, 'lib');
  return readdirSyncSafe(lib)
    .filter((entry) => entry.startsWith('python'))
    .map((entry) => path.join(lib, entry, 'site-packages'));
}

export function missingPackages(venvDir, packages, platform = process.platform) {
  const present = new Set();
  for (const directory of sitePackagesDirs(venvDir, platform)) {
    for (const entry of readdirSyncSafe(directory)) {
      present.add(entry.toLowerCase());
    }
  }
  return packages.filter((spec) => {
    const expected = distInfoName(spec);
    return expected !== null && !present.has(expected.toLowerCase());
  });
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function venvRebuildReason(binary, markerPath, expected, hash, packages, platform) {
  if (!isFile(binary)) {
    return 'the interpreter is missing';
  }
  const marker = readJson(markerPath);
  if (marker === null) {
    return 'there is no readable marker';
  }
  if (marker.hash !== hash) {
    return 'the marker differs';
  }
  if (missingPackages(expected.venv, packages, platform).length > 0) {
    return 'a pinned package is missing';
  }
  return null;
}

// Create or refresh the named venv under <data>/venvs/<name>. The JSON marker
// records the uv version, the Python version, the package pins and a hash over
// all of them; a matching marker plus an intact package set means reuse.
export function ensureVenv(options = {}) {
  const {
    env = process.env,
    dataDir,
    uv,
    python,
    name,
    packages,
    extra = null,
    log = () => {},
    run = defaultRun,
    platform = process.platform,
  } = options;
  if (nonEmpty(dataDir) === null) {
    throw new Error('ensureVenv needs the plugin data directory.');
  }
  if (typeof name !== 'string' || !VENV_NAME_PATTERN.test(name)) {
    throw new Error(
      `"${truncate(String(name))}" is not a valid venv name; use 1-64 lowercase letters, digits, '.', '_' or '-'.`,
    );
  }
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error(`ensureVenv needs at least one pinned package for the "${name}" venv.`);
  }
  const venvDir = path.join(dataDir, 'venvs', name);
  const paths = venvPaths(venvDir, platform);
  const markerPath = path.join(venvDir, '.provision.json');
  const expected = {
    schemaVersion: PROVISION_SCHEMA_VERSION,
    name,
    uv: uv.version,
    python: python.version,
    packages: [...packages].sort(),
    ...(extra === null ? {} : { extra }),
  };
  const hash = hashJson(expected);
  const reason = venvRebuildReason(
    paths.python,
    markerPath,
    { ...expected, venv: venvDir },
    hash,
    packages,
    platform,
  );
  if (reason === null) {
    log(`reusing the plugin-managed venv ${venvDir} (the marker matches)`);
    return { ...paths, marker: markerPath, packages: expected.packages, reused: true, hash };
  }

  log(`provisioning the plugin-managed venv ${venvDir} (${reason}; one-time)`);
  const uvEnv = uvEnvironment(env, dataDir);
  const venvArgs = ['venv', '--python', python.python, '--clear', '--force', venvDir];
  if (python.source === 'managed') {
    venvArgs.splice(3, 0, '--no-python-downloads');
  }
  const created = run(uv.command, venvArgs, { env: uvEnv });
  if (created === null || created.status !== 0) {
    throw new Error(`uv venv failed for ${venvDir}: ${stderrTail(created?.stderr)}`);
  }
  const install = run(uv.command, ['pip', 'install', '--python', paths.python, ...packages], { env: uvEnv });
  if (install === null || install.status !== 0) {
    throw new Error(`uv pip install failed for ${packages.join(', ')}: ${stderrTail(install?.stderr)}`);
  }
  const missing = missingPackages(venvDir, packages, platform);
  if (missing.length > 0) {
    throw new Error(
      `the provisioned venv ${venvDir} does not contain ${missing.join(', ')}; ` +
        'refusing to start a mismatched runtime.',
    );
  }
  writeFileSync(markerPath, `${JSON.stringify({ ...expected, hash }, null, 2)}\n`);
  return { ...paths, marker: markerPath, packages: expected.packages, reused: false, hash };
}

export function parsePackageSpec(spec) {
  const at = spec.lastIndexOf('@');
  if (at <= 0) {
    return { name: spec, version: 'latest' };
  }
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

export function readPackageJson(file) {
  const data = readJson(file);
  return data === null ? null : { name: data.name, version: data.version };
}

export function resolveNpmPackage(env, fallback = DEFAULT_NPM_PACKAGE) {
  const value = env.CLOAK_PLAYWRIGHT_MCP_PACKAGE;
  return nonEmpty(value) ?? fallback;
}

function npmRuntimeHealthy(dir, marker, desired, locate) {
  const cli = locate(dir, parsePackageSpec(desired.package).name);
  if (cli === null) {
    return false;
  }
  const current = readJson(marker);
  if (
    current === null ||
    current.package !== desired.package ||
    current.engine !== desired.engine ||
    current.driver !== desired.driver
  ) {
    return false;
  }
  const core = readPackageJson(path.join(dir, 'node_modules', 'playwright-core', 'package.json'));
  const nested = readPackageJson(
    path.join(dir, 'node_modules', '@playwright', 'mcp', 'node_modules', 'playwright', 'package.json'),
  );
  const topLevel = readPackageJson(path.join(dir, 'node_modules', 'playwright', 'package.json'));
  const playwrightPackage = nested ?? topLevel;
  const engine = readPackageJson(path.join(dir, 'node_modules', 'cloakbrowser', 'package.json'));
  return (
    core?.name === 'patchright-core' &&
    playwrightPackage?.name === 'patchright' &&
    engine?.version === NPM_ENGINE_WRAPPER_PIN
  );
}

// The npm runtime install shared by launch.mjs and launch-kameleo.mjs. Its
// package identity, package.json bytes, npm arguments, clean-reinstall rule and
// marker bytes are unchanged from the 1.x launcher; only the caller-provided
// entry-point lookup differs between the two launchers.
export function ensureNpmRuntime(options = {}) {
  const {
    env = process.env,
    dataDir,
    spec,
    locate,
    missingAfterInstallError = null,
    run = defaultRun,
  } = options;
  if (nonEmpty(dataDir) === null) {
    throw new Error('ensureNpmRuntime needs the plugin data directory.');
  }
  if (typeof locate !== 'function') {
    throw new Error('ensureNpmRuntime needs a locate callback for the runtime entry point.');
  }
  const { name, version } = parsePackageSpec(spec);
  const dir = path.join(dataDir, 'runtime');
  const marker = path.join(dir, '.installed.json');
  const desired = { package: spec, engine: NPM_ENGINE_WRAPPER_PIN, driver: NPM_DRIVER_PIN };
  if (npmRuntimeHealthy(dir, marker, desired, locate)) {
    return { dir, marker, cli: locate(dir, name), reinstalled: false };
  }

  // A previous install may be a mixed tree (stock playwright-core with a nested
  // patchright). npm will not fix that in place, so start clean.
  rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  rmSync(path.join(dir, 'package-lock.json'), { force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        private: true,
        dependencies: { [name]: version },
        overrides: {
          cloakbrowser: NPM_ENGINE_WRAPPER_PIN,
          playwright: `npm:patchright@${NPM_DRIVER_PIN.split('@')[1]}`,
          'playwright-core': `npm:patchright-core@${NPM_DRIVER_PIN.split('@')[1]}`,
        },
      },
      null,
      2,
    ) + '\n',
  );

  const isWindows = process.platform === 'win32';
  const install = run(isWindows ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: isWindows,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (install === null || install.status !== 0) {
    throw new Error(
      `npm install failed for ${spec} in ${dir} (exit ${install === null ? 'unknown' : install.status})`,
    );
  }

  writeFileSync(marker, JSON.stringify(desired) + '\n');
  const cli = locate(dir, name);
  if (cli === null && missingAfterInstallError !== null) {
    throw new Error(missingAfterInstallError(dir, spec));
  }
  return { dir, marker, cli, reinstalled: true };
}
