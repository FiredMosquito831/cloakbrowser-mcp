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
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';

export const PROVISION_SCHEMA_VERSION = 2;
// The install recipe itself: bump this whenever a change makes the bytes a build
// produces different for the same pins (a new uv argument, a different site layout,
// an extra install step). It is the only way a recipe change can reach an existing
// install, because the marker deliberately hashes nothing else that is not a pin.
export const RUNTIME_RECIPE_VERSION = 1;
// Provisioning-state schema, reported by browser_capabilities and
// browser_engine_status through <plugin data>/config/provisioning/<name>.json.
export const PROVISIONING_RECORD_SCHEMA_VERSION = 1;
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

// --- runtime generations, holder probes and leases (2.22.0) ----------------
//
// A venv is addressed by a generation derived from the pins that produced it, so
// a start that needs a new one builds it beside the old one instead of emptying
// the tree another session is running from. The probe below says whether a tree
// is held; it never renames, empties or prunes one. See
// .orchestration/specs/2026-10-28-inv-provision-safety.md.
const GENERATION_PATTERN = /^[0-9a-f]{8}$/;
const LEASE_PATTERN = /^\.lease-(\d+)\.json$/;
const VENVS_DIRNAME = 'venvs';
const PROVISIONING_DIRNAME = path.join('config', 'provisioning');
const HOLDER_MESSAGE_LIMIT = 300;
// The same codes lib/profile.mjs reads as a live holder: the file exists and the
// OS refuses to open it for writing. A Windows image that is executing is opened
// by the loader in a way that refuses every other open with write access
// (measured EBUSY), while a plain read and statSync both succeed.
const HOLDER_LIVE_CODES = new Set(['EBUSY', 'EACCES', 'EPERM', 'ETXTBSY']);

// Open for writing and close at once, without writing anything: the only
// reliable liveness probe on Windows. Never call this a "free" answer for a
// missing file — a vanished file has nothing to hold.
export function defaultOpenProbe(file) {
  let handle;
  try {
    handle = openSync(file, 'r+');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { held: false };
    }
    if (HOLDER_LIVE_CODES.has(error?.code)) {
      return { held: true, code: error.code };
    }
    return { held: false, error: error?.code ?? String(error?.message ?? 'unknown') };
  }
  try {
    closeSync(handle);
  } catch {
    // The open already proved nobody holds the file.
  }
  return { held: false };
}

// Is anything running from this tree? Every `Scripts/*.exe` and every `*.dll` at
// the venv root is probed, because the image a session executes is not always
// python.exe: camoufox-native spawns Scripts/mcp-camoufox.exe. POSIX has no
// mandatory locking, so the same open succeeds while a process runs: there the
// answer is "cannot tell", never "free".
export function probeVenvHolders(venvDir, options = {}) {
  const {
    platform = process.platform,
    openProbe = defaultOpenProbe,
    readdir = readdirSyncSafe,
  } = options;
  if (platform !== 'win32') {
    return { certain: false, held: false, path: null };
  }
  const targets = [];
  const scripts = venvScriptsDir(venvDir, platform);
  for (const entry of readdir(scripts)) {
    if (entry.toLowerCase().endsWith('.exe')) {
      targets.push(path.join(scripts, entry));
    }
  }
  for (const entry of readdir(venvDir)) {
    if (entry.toLowerCase().endsWith('.dll')) {
      targets.push(path.join(venvDir, entry));
    }
  }
  // Sorted so the refusal names the same file on every filesystem.
  targets.sort();
  for (const target of targets) {
    const result = openProbe(target, 'r+');
    if (result?.held === true) {
      return { certain: true, held: true, path: target, code: result.code ?? null };
    }
  }
  return { certain: true, held: false, path: null };
}

function livePid(pid) {
  if (!Number.isInteger(pid) || pid < 1) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

// A lease is the only way a refusal can name a process: the file probe proves a
// tree is held but cannot say by whom, and the plugin starts no shell to ask. A
// live lease is reported; a lease whose process is gone is stale and ignored.
// A lease nobody can read is treated as held, because the alternative is to
// assume a session that is not there.
export function runtimeLease(target, options = {}) {
  const { pidAlive = livePid, readdir = readdirSyncSafe } = options;
  for (const entry of readdir(target)) {
    const match = LEASE_PATTERN.exec(entry);
    if (match === null) {
      continue;
    }
    const file = path.join(target, entry);
    const record = readJson(file);
    if (record === null) {
      return { path: file, pid: null, source: 'unknown' };
    }
    const pid = Number.isInteger(record.pid) ? record.pid : Number(match[1]);
    if (pidAlive(pid)) {
      return { path: file, pid: Number.isInteger(pid) ? pid : null, source: 'lease' };
    }
  }
  return null;
}

// Write this process's lease into a runtime tree and return the release. A lease
// that cannot be written is not fatal: it only costs the refusal message its pid.
export function writeRuntimeLease(target, options = {}) {
  const { pid = process.pid } = options;
  const file = path.join(target, `.lease-${pid}.json`);
  try {
    writeFileSync(file, `${JSON.stringify({ pid })}\n`);
  } catch {
    return () => {};
  }
  return () => {
    try {
      rmSync(file);
    } catch {
      // A leftover lease of a dead pid is ignored by every reader.
    }
  };
}

export function venvGenerationNames(dataDir, name, readdir = readdirSyncSafe) {
  const found = [];
  for (const entry of readdir(path.join(dataDir, VENVS_DIRNAME))) {
    if (entry === name) {
      found.push(entry);
      continue;
    }
    if (entry.startsWith(`${name}-`) && GENERATION_PATTERN.test(entry.slice(name.length + 1))) {
      found.push(entry);
    }
  }
  return found.sort();
}

export function provisioningRecordPath(dataDir, name) {
  return path.join(dataDir, PROVISIONING_DIRNAME, `${name}.json`);
}

export function readProvisioningRecord(dataDir, name) {
  return readJson(provisioningRecordPath(dataDir, name));
}

// The record the broker reports as `provisioning`. Written by the provisioner, so
// a failure is recorded before it is thrown, and rewritten on every start so it
// always describes the latest one. A record that cannot be written is not fatal:
// the start it describes is unaffected, and the broker simply reports nothing.
export function writeProvisioningRecord(dataDir, name, record) {
  const file = provisioningRecordPath(dataDir, name);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ schemaVersion: PROVISIONING_RECORD_SCHEMA_VERSION, engine: name, ...record }, null, 2)}\n`,
    );
    return file;
  } catch {
    return null;
  }
}

export function updateProvisioningRecord(dataDir, name, patch) {
  const current = readProvisioningRecord(dataDir, name);
  if (current === null) {
    return null;
  }
  return writeProvisioningRecord(dataDir, name, { ...current, ...patch });
}

// One line, because the broker forwards only the launcher's last stderr line and
// truncates it to 300 characters: the path, the pid when a lease names one, the
// fix and the fact that nothing was changed all have to fit.
function holderRefusalMessage(name, venvDir, probe, lease) {
  const file = probe?.path === null || probe?.path === undefined ? '' : ` (${path.basename(probe.path)})`;
  const leasePath = lease?.source === 'unknown' && lease?.path ? lease.path : null;
  const who = lease?.pid === null || lease?.pid === undefined ? '' : ` by pid ${lease.pid}`;
  const fix =
    leasePath === null
      ? '; close the Claude Code session using it and restart. Nothing was changed.'
      : `; close the Claude Code session using it and restart, or delete ${path.basename(leasePath)} in it if nothing runs from it. Nothing was changed.`;
  const full = `the ${name} runtime ${venvDir} is in use${who}${file}${fix}`;
  if (full.length <= HOLDER_MESSAGE_LIMIT) {
    return full;
  }
  const short = `the ${name} runtime ${path.basename(venvDir)} is in use${who}${file}${fix}`;
  return short.length <= HOLDER_MESSAGE_LIMIT ? short : `${short.slice(0, HOLDER_MESSAGE_LIMIT - 3)}...`;
}

function holderRemedy(name, probe, lease) {
  const who = lease?.pid === null || lease?.pid === undefined ? '' : ` (pid ${lease.pid})`;
  return (
    `Close the Claude Code session that is running the ${name} runtime${who}, then restart Claude Code. ` +
    'The existing runtime was left untouched.'
  );
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

// Create or refresh a venv *generation* under <data>/venvs/<name>-<8hex>.
//
// The generation is derived from the runtime-determining inputs only: the package
// pins (wrapper spec plus stack), the build, the uv version, the Python version
// and RUNTIME_RECIPE_VERSION. Nothing else may feed it — a manifest description
// edit must never rebuild a several-hundred-megabyte runtime, which is exactly the
// regression 2.20.0 shipped. The marker records those same inputs and its hash is
// the generation, so the directory name and the marker can never disagree.
//
// The order is what makes it safe: probe, build into a temporary tree beside the
// target, write the marker last *inside* the new tree, then one rename. Nothing is
// ever removed before its replacement exists and is marked, and a tree that is in
// use is never renamed, emptied or pruned. A start that needs a different
// generation leaves the running one alone; the previous generations are kept and
// reported, never pruned (a later release adds --prune).
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
    rename = renameSync,
    remove = rmSync,
    openProbe = defaultOpenProbe,
    pid = process.pid,
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
  const expected = {
    schemaVersion: PROVISION_SCHEMA_VERSION,
    recipe: RUNTIME_RECIPE_VERSION,
    name,
    uv: uv.version,
    python: python.version,
    packages: [...packages].sort(),
    ...(extra === null ? {} : { extra }),
  };
  const hash = hashJson(expected);
  const generation = hash.slice(0, 8);
  const venvsRoot = path.join(dataDir, VENVS_DIRNAME);
  const venvDir = path.join(venvsRoot, `${name}-${generation}`);
  const paths = venvPaths(venvDir, platform);
  const markerPath = path.join(venvDir, '.provision.json');
  const probeName = platform === 'win32' ? 'windows' : 'cannot-tell';
  const keptGenerations = () =>
    venvGenerationNames(dataDir, name).filter((entry) => entry !== `${name}-${generation}`);
  const reusable = () =>
    venvRebuildReason(paths.python, markerPath, { ...expected, venv: venvDir }, hash, packages, platform);

  const record = (state, reason, remedy, holder) =>
    writeProvisioningRecord(dataDir, name, {
      state,
      venv: venvDir,
      generation,
      holderProbe: probeName,
      holder: holder ?? null,
      keptGenerations: keptGenerations(),
      reason,
      remedy,
    });

  const reason = reusable();
  if (reason === null) {
    log(`reusing the plugin-managed venv ${venvDir} (the marker matches)`);
    record('reused', null, null, null);
    return {
      ...paths,
      marker: markerPath,
      packages: expected.packages,
      reused: true,
      hash,
      generation,
      keptGenerations: keptGenerations(),
      state: 'reused',
    };
  }

  log(`provisioning the plugin-managed venv ${venvDir} (${reason}; one-time)`);
  mkdirSync(venvsRoot, { recursive: true });
  const temporary = path.join(venvsRoot, `.t-${name}-${generation}-${pid}`);
  const temporaryPaths = venvPaths(temporary, platform);
  try {
    remove(temporary, { recursive: true, force: true });
  } catch {
    // A leftover staging tree of this pid: uv --clear --force empties it anyway.
  }

  const finish = (state, adoptedReason, holder) => {
    record(state, adoptedReason, null, holder ?? null);
    return {
      ...paths,
      marker: markerPath,
      packages: expected.packages,
      reused: state !== 'built',
      hash,
      generation,
      keptGenerations: keptGenerations(),
      state,
    };
  };
  const refuse = (probe) => {
    const lease = runtimeLease(venvDir);
    const message = holderRefusalMessage(name, venvDir, probe, lease);
    record('refused-held', message, holderRemedy(name, probe, lease), {
      path: probe.path,
      pid: lease?.pid ?? null,
      source: lease?.pid == null ? 'unknown' : 'lease',
    });
    return new Error(message);
  };

  // Everything below happens inside the staging tree. A failure removes the
  // staging tree and leaves every existing generation exactly as it was.
  const discardTemp = () => {
    try {
      remove(temporary, { recursive: true, force: true });
    } catch {
      // An unremovable staging tree is inert: it is adopted only when it carries a
      // valid marker and its process is gone, which a failure here cannot fake.
    }
  };

  // A crash between writing the marker and the rename leaves a complete staging
  // tree whose process is gone. The marker is written last, so a marked staging
  // tree is complete by construction: finish that rename instead of rebuilding.
  for (const entry of readdirSyncSafe(venvsRoot)) {
    const prefix = `.t-${name}-${generation}-`;
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const stagingPid = Number(entry.slice(prefix.length));
    if (!Number.isInteger(stagingPid) || stagingPid === pid || livePid(stagingPid)) {
      continue;
    }
    const stagingDir = path.join(venvsRoot, entry);
    const stagingReason = venvRebuildReason(
      venvPaths(stagingDir, platform).python,
      path.join(stagingDir, '.provision.json'),
      { ...expected, venv: stagingDir },
      hash,
      packages,
      platform,
    );
    if (stagingReason !== null) {
      continue;
    }
    try {
      rename(stagingDir, venvDir);
      log(`completed an interrupted build of ${venvDir} from ${entry}`);
      return finish('reused', 'completed an interrupted build', null);
    } catch {
      // Another start got there first, or the tree went away: build as usual.
      break;
    }
  }

  const uvEnv = uvEnvironment(env, dataDir);
  const venvArgs = ['venv', '--python', python.python, '--clear', '--force', temporary];
  if (python.source === 'managed') {
    venvArgs.splice(3, 0, '--no-python-downloads');
  }
  const created = run(uv.command, venvArgs, { env: uvEnv });
  if (created === null || created.status !== 0) {
    discardTemp();
    const message = `uv venv failed for ${venvDir}: ${stderrTail(created?.stderr)}`;
    record('failed', message, 'Check the disk and the network, then restart Claude Code to retry.', null);
    throw new Error(message);
  }
  const install = run(uv.command, ['pip', 'install', '--python', temporaryPaths.python, ...packages], {
    env: uvEnv,
  });
  if (install === null || install.status !== 0) {
    discardTemp();
    const message = `uv pip install failed for ${packages.join(', ')}: ${stderrTail(install?.stderr)}`;
    record('failed', message, 'Check the network, then restart Claude Code to retry.', null);
    throw new Error(message);
  }
  const missing = missingPackages(temporary, packages, platform);
  if (missing.length > 0) {
    discardTemp();
    const message =
      `the provisioned venv ${venvDir} does not contain ${missing.join(', ')}; ` +
      'refusing to start a mismatched runtime.';
    record('failed', message, 'Restart Claude Code to rebuild the runtime.', null);
    throw new Error(message);
  }
  // The commit point of the build, and the last byte written into the new tree. It
  // lives inside the tree it describes: a marker outside it could survive a crash
  // and make venvRebuildReason trust bytes that are not there.
  writeFileSync(path.join(temporary, '.provision.json'), `${JSON.stringify({ ...expected, hash }, null, 2)}\n`);

  // The destination name is derived from the pins, so the only trees that can be
  // there are one another start finished first or one a failed attempt left
  // half-built. Both are handled here; neither is ever removed before the new tree
  // is in place.
  let aside = null;
  if (existsSync(venvDir)) {
    if (reusable() === null) {
      log(`another start completed the ${name} generation ${generation} first; using it`);
      discardTemp();
      return finish('reused', 'another start completed this generation first', null);
    }
    const probe = probeVenvHolders(venvDir, { platform, openProbe });
    if (!probe.certain) {
      log(
        `cannot tell whether ${venvDir} is in use: this platform has no mandatory file locking, ` +
          'so the generation path is what protects a running session',
      );
    }
    if (probe.held) {
      discardTemp();
      const error = refuse(probe);
      throw error;
    }
    aside = `${venvDir}.bad-${pid}`;
    try {
      rename(venvDir, aside);
    } catch (error) {
      discardTemp();
      const message =
        `cannot move the unusable ${name} runtime ${venvDir} aside ` +
        `(${error?.code ?? error?.message ?? 'unknown error'}); it is left in place. ` +
        'Restart Claude Code to retry.';
      record('failed', message, 'Restart Claude Code to retry.', null);
      throw new Error(message);
    }
  }
  try {
    rename(temporary, venvDir);
  } catch (error) {
    if (aside !== null) {
      try {
        rename(aside, venvDir);
      } catch {
        // The destination is left as it was; the new tree is dropped below.
      }
    }
    if (reusable() === null) {
      discardTemp();
      return finish('reused', 'another start completed this generation first', null);
    }
    discardTemp();
    const message =
      `cannot move the new ${name} runtime into ${venvDir} ` +
      `(${error?.code ?? error?.message ?? 'unknown error'}); the previous generation was kept. ` +
      'Restart Claude Code to retry.';
    record('failed', message, 'Restart Claude Code to retry.', null);
    throw new Error(message);
  }
  if (aside !== null) {
    try {
      remove(aside, { recursive: true, force: true });
    } catch (error) {
      log(`the unusable tree ${aside} could not be removed (${error?.code ?? error?.message}); it is left in place`);
    }
  }
  log(`provisioned the plugin-managed venv ${venvDir}`);
  return finish('built', null, null);
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

// The identity a runtime tree must carry: this plugin's marker for the pinned set
// and the three driver packages actually present under those names. The caller's
// own entry point is deliberately not part of it — that check stays with the
// caller after the swap, with its own message.
function npmIdentityHealthy(dir, marker, desired) {
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

function npmRuntimeHealthy(dir, marker, desired, locate) {
  const cli = locate(dir, parsePackageSpec(desired.package).name);
  if (cli === null) {
    return false;
  }
  return npmIdentityHealthy(dir, marker, desired);
}

const NPM_LEFTOVER_PATTERN = /^\.(?:rt|old)-(\d+)$/;

function npmRuntimeIsHealthy(dir, desired, locate) {
  return npmRuntimeHealthy(dir, path.join(dir, '.installed.json'), desired, locate);
}

function npmLeftovers(dataDir, readdir = readdirSyncSafe) {
  const found = [];
  for (const entry of readdir(dataDir)) {
    const match = NPM_LEFTOVER_PATTERN.exec(entry);
    if (match !== null) {
      found.push({ dir: path.join(dataDir, entry), pid: Number(match[1]), name: entry });
    }
  }
  return found;
}

function npmHolderMessage(dir, lease) {
  const who = lease?.pid === null || lease?.pid === undefined ? '' : ` by another Claude Code session (pid ${lease.pid})`;
  const fix =
    lease?.source === 'unknown' && lease?.path
      ? `; delete ${path.basename(lease.path)} in it if nothing runs from it, then restart Claude Code. The existing runtime was left untouched.`
      : '; close that Claude Code session and restart. The existing runtime was left untouched.';
  const message = `the plugin runtime ${dir} is in use${who}${fix}`;
  return message.length <= HOLDER_MESSAGE_LIMIT ? message : `${message.slice(0, HOLDER_MESSAGE_LIMIT - 3)}...`;
}

// The npm runtime install shared by launch.mjs and launch-kameleo.mjs. Its
// package identity, package.json bytes, npm arguments and marker bytes are
// unchanged from 1.x; only the caller-provided entry-point lookup differs.
//
// The shape is now the safe one: a session lease is the holder signal (a file
// probe cannot see a running Node session, because Node releases an entry point
// after reading it and the delete would silently succeed), the replacement is
// built beside the runtime and verified there, and only then are two renames
// performed with a restore on failure. A failed install — an offline update is
// the routine case — leaves the previous runtime exactly as it was.
export function ensureNpmRuntime(options = {}) {
  const {
    env = process.env,
    dataDir,
    spec,
    locate,
    missingAfterInstallError = null,
    run = defaultRun,
    rename = renameSync,
    remove = rmSync,
    pid = process.pid,
    pidAlive = livePid,
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

  const pruneLeftovers = () => {
    for (const leftover of npmLeftovers(dataDir)) {
      if (pidAlive(leftover.pid) || runtimeLease(leftover.dir, { pidAlive }) !== null) {
        continue;
      }
      try {
        remove(leftover.dir, { recursive: true, force: true });
      } catch {
        // Left for a later start; a leftover tree is never adopted silently.
      }
    }
  };

  if (npmRuntimeIsHealthy(dir, desired, locate)) {
    pruneLeftovers();
    return { dir, marker, cli: locate(dir, name), reinstalled: false };
  }

  // A crash between the two renames, or a swap whose restore failed, leaves the
  // complete tree beside the runtime rather than at it. Adopt it before building:
  // this is what keeps an offline machine working after an interrupted update.
  if (!existsSync(dir)) {
    const leftovers = npmLeftovers(dataDir);
    const ordered = [
      ...leftovers.filter((entry) => entry.name.startsWith('.rt-')),
      ...leftovers.filter((entry) => entry.name.startsWith('.old-')),
    ];
    for (const candidate of ordered) {
      // A leftover whose process is still alive may be the tree a live session is
      // running from: move it back is a rename under a running process, and the
      // lease inside it is the proof. Never adopt it.
      if (pidAlive(candidate.pid) || runtimeLease(candidate.dir, { pidAlive }) !== null) {
        continue;
      }
      if (!npmRuntimeIsHealthy(candidate.dir, desired, locate)) {
        continue;
      }
      try {
        rename(candidate.dir, dir);
        return { dir, marker, cli: locate(dir, name), reinstalled: false, adopted: candidate.name };
      } catch {
        // Another start got there first; the health check below decides.
        if (npmRuntimeIsHealthy(dir, desired, locate)) {
          return { dir, marker, cli: locate(dir, name), reinstalled: false };
        }
      }
    }
  }

  const holder = runtimeLease(dir, { pidAlive });
  if (holder !== null) {
    throw new Error(npmHolderMessage(dir, holder));
  }

  // Build the whole replacement beside the runtime. The name is short on purpose:
  // every path inside node_modules gains its length, and this tree is deep.
  const temporary = path.join(dataDir, `.rt-${pid}`);
  try {
    remove(temporary, { recursive: true, force: true });
  } catch {
    // A staging tree of this exact pid: the empty tree below replaces it anyway.
  }
  mkdirSync(temporary, { recursive: true });
  writeFileSync(
    path.join(temporary, 'package.json'),
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
    cwd: temporary,
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: isWindows,
    encoding: 'utf8',
    windowsHide: true,
  });
  const discardTemporary = () => {
    try {
      remove(temporary, { recursive: true, force: true });
    } catch {
      // Never adopted unless it is fully marked and healthy; a later start prunes it.
    }
  };
  if (install === null || install.status !== 0) {
    discardTemporary();
    throw new Error(
      `npm install failed for ${spec} in ${dir} (exit ${install === null ? 'unknown' : install.status}). ` +
        'The previous runtime was left in place.',
    );
  }

  // The marker is the last byte written into the new tree, and the identity check
  // reads the tree it is about to replace the old one with.
  writeFileSync(path.join(temporary, '.installed.json'), JSON.stringify(desired) + '\n');
  if (!npmIdentityHealthy(temporary, path.join(temporary, '.installed.json'), desired)) {
    discardTemporary();
    throw new Error(
      `the npm runtime built in ${temporary} is not the pinned set (${spec}, ${NPM_DRIVER_PIN}); ` +
        'the previous runtime was left in place.',
    );
  }

  let old = null;
  if (existsSync(dir)) {
    old = path.join(dataDir, `.old-${pid}`);
    try {
      remove(old, { recursive: true, force: true });
      rename(dir, old);
    } catch (error) {
      discardTemporary();
      throw new Error(
        `cannot move the existing plugin runtime ${dir} aside (${error?.code ?? error?.message ?? 'unknown error'}); ` +
          'it is left in place. Restart Claude Code to retry.',
      );
    }
  }
  try {
    rename(temporary, dir);
  } catch (error) {
    if (old !== null) {
      try {
        rename(old, dir);
      } catch {
        // Both trees stay on disk; the message below names them.
      }
    }
    if (npmRuntimeIsHealthy(dir, desired, locate)) {
      discardTemporary();
      return { dir, marker, cli: locate(dir, name), reinstalled: false };
    }
    discardTemporary();
    throw new Error(
      `cannot move the new plugin runtime into ${dir} (${error?.code ?? error?.message ?? 'unknown error'})` +
        `${old === null ? '' : `; the complete trees are at ${dir} and ${old}`}. Restart Claude Code to retry.`,
    );
  }
  // The old tree is deleted only on a later successful, unheld start, so an
  // interrupted start always leaves a complete runtime somewhere.
  const cli = locate(dir, name);
  if (cli === null && missingAfterInstallError !== null) {
    throw new Error(missingAfterInstallError(dir, spec));
  }
  return { dir, marker, cli, reinstalled: true };
}
