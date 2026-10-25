#!/usr/bin/env node
// Launcher adapter for the Camoufox native engine (mcp-camoufox).
//
// The package is fetched from PyPI at the first start and installed into a
// plugin-managed venv under ${CLAUDE_PLUGIN_DATA}; the plugin never bundles or
// redistributes it (its licence is FSL-1.1-MIT). An explicit
// CAMOUFOX_NATIVE_COMMAND wins, and a usable executable already on PATH (for
// example from `uv tool install`) is the fallback when provisioning fails.
//
// The launcher validates the profile name with the app's own rule, pins the
// daemon off and the Camoufox browser build, drops empty optional values, then
// spawns the app with inherited stdio.
//
// Rules: stdout is the MCP protocol only; every log line goes to stderr. A
// missing prerequisite is one actionable line and exit 1, so the broker's
// meta-only recovery path can answer the client instead of hanging the
// handshake.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ensurePython, ensureUv, ensureVenv, venvExecutablePath } from './lib/provision.mjs';

const PACKAGE_PIN = 'mcp-camoufox==0.4.5';
const BUILD_PIN = '156.0.1-beta.39';
const LOG_PREFIX = '[camoufox-native]';
const DEFAULT_PROFILE = 'default';
const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
// mcp-camoufox's own rule (profile_name.py): 1-64 characters, first character
// alphanumeric, then letters, digits, '.', '_' or '-'. A slash is impossible.
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Values the app reads; an empty string is not the same as unset for several of
// them, so they are dropped here exactly as launch.mjs drops its optional ones.
const EMPTY_OPTIONAL_VARS = [
  'CAMOUFOX_PROFILE',
  'CAMOUFOX_DATA_DIR',
  'CAMOUFOX_HEADLESS',
  'CAMOUFOX_BROWSER_VERSION',
  'CAMOUFOX_PROXY',
  'CAMOUFOX_VIEWPORT',
  'CAMOUFOX_FINGERPRINT_OS',
  'CAMOUFOX_LOCALE',
  'CAMOUFOX_ADDON_URLS',
  'CAMOUFOX_BUNDLED_ADDONS',
  'CAMOUFOX_AUTO_UPDATE',
  'CAMOUFOX_BINARY',
];

// mcp-camoufox has no file-path tools and no allowlist, so it never reads
// PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS (manifest ignoredSettings says
// so). The variable is still normalised here: the setting defaults to false and
// Claude Code substitutes that default as "false", so dropping anything not
// explicitly on keeps this engine's child environment byte-identical to 2.9.5.
const UNRESTRICTED_FILE_ACCESS_VAR = 'PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS';

function applyUnrestrictedFileAccess(env) {
  const value = (env[UNRESTRICTED_FILE_ACCESS_VAR] ?? '').trim().toLowerCase();
  if (value === 'true' || value === '1') {
    env[UNRESTRICTED_FILE_ACCESS_VAR] = 'true';
  } else {
    delete env[UNRESTRICTED_FILE_ACCESS_VAR];
  }
}

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

function fail(message) {
  log(message);
  process.exit(1);
}

function pluginDataDir(env) {
  return env.CLAUDE_PLUGIN_DATA !== undefined && env.CLAUDE_PLUGIN_DATA.trim() !== ''
    ? env.CLAUDE_PLUGIN_DATA.trim()
    : path.join(homedir(), '.camoufox-native-mcp-plugin');
}

function resolveOverride(env, name, fallback) {
  const value = env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : fallback;
}

function normalizeBuild(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const withoutV = value.replace(/^[vV]/, '');
  return withoutV === '' ? BUILD_PIN : withoutV;
}

// Camoufox's own OS names for the fingerprint persona. A profile whose claimed
// OS matches the host is coherent (the GPU/UA/WebGL stack it fabricates is the
// one this machine can actually render); a mismatched persona is what the
// detector flags, so the host is the safe default and an explicit value wins.
export const HOST_FINGERPRINT_OS = Object.freeze({
  darwin: 'macos',
  linux: 'linux',
  win32: 'windows',
});
const FINGERPRINT_OS_VALUES = new Set(['windows', 'linux', 'macos']);

// Resolve CAMOUFOX_FINGERPRINT_OS. An explicit valid value is kept (lowercased,
// which is the app's accepted spelling). An unset value defaults to the host OS.
// An invalid value falls back to the host default with a warning, never a crash;
// on a platform Camoufox has no name for, an invalid value is left unset.
export function resolveFingerprintOs(rawValue, platform) {
  const host = Object.hasOwn(HOST_FINGERPRINT_OS, platform) ? HOST_FINGERPRINT_OS[platform] : null;
  const explicit = typeof rawValue === 'string' ? rawValue.trim().toLowerCase() : '';
  if (explicit !== '') {
    if (FINGERPRINT_OS_VALUES.has(explicit)) {
      return { value: explicit, source: 'explicit', warning: null };
    }
    const echoed = rawValue.trim().slice(0, 32);
    if (host === null) {
      return {
        value: null,
        source: 'invalid',
        warning:
          `CAMOUFOX_FINGERPRINT_OS "${echoed}" is not windows, linux or macos, and ` +
          `platform "${platform}" has no Camoufox host default; leaving it unset.`,
      };
    }
    return {
      value: host,
      source: 'host-default',
      warning: `CAMOUFOX_FINGERPRINT_OS "${echoed}" is not windows, linux or macos; using the host default "${host}".`,
    };
  }
  if (host === null) {
    return {
      value: null,
      source: 'none',
      warning: `No Camoufox fingerprint OS default for platform "${platform}"; leaving CAMOUFOX_FINGERPRINT_OS unset.`,
    };
  }
  return { value: host, source: 'host-default', warning: null };
}

export function buildChildEnv(source, platform = process.platform) {
  const env = { ...source };
  for (const name of EMPTY_OPTIONAL_VARS) {
    const value = env[name];
    if (value !== undefined && value.trim() === '') {
      delete env[name];
    }
  }
  applyUnrestrictedFileAccess(env);
  const profile = env.CAMOUFOX_PROFILE?.trim();
  if (profile !== undefined && profile !== '' && !PROFILE_PATTERN.test(profile)) {
    fail(
      `CAMOUFOX_PROFILE "${profile.slice(0, 32)}" is not a valid mcp-camoufox profile name: ` +
        "use 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit.",
    );
  }
  if (profile === undefined || profile === '') {
    delete env.CAMOUFOX_PROFILE;
  } else {
    env.CAMOUFOX_PROFILE = profile;
  }
  const dataDir = source.CAMOUFOX_DATA_DIR?.trim();
  env.CAMOUFOX_DATA_DIR =
    dataDir !== undefined && dataDir !== ''
      ? dataDir
      : path.join(pluginDataDir(source), 'profiles', 'camoufox-native');
  // The app's daemon is detached and lease-driven; the broker can only own its
  // own child tree, so v2.3.0 pins the daemon off instead of claiming otherwise.
  env.CAMOUFOX_DAEMON = 'false';
  // mcp-camoufox accepts true, false or virtual. virtual is Xvfb (Linux only),
  // so a Windows user must never receive it; the plugin has a boolean switch.
  const headless = source.PLAYWRIGHT_MCP_HEADLESS?.trim().toLowerCase() === 'true';
  env.CAMOUFOX_HEADLESS = headless ? 'true' : 'false';
  env.CAMOUFOX_BROWSER_VERSION = normalizeBuild(
    source.CAMOUFOX_NATIVE_BROWSER_BUILD ?? source.CAMOUFOX_BROWSER_VERSION,
  );
  // A random persona can claim an OS this host cannot coherently render; the
  // 2026-10-24 detector run flagged exactly that (macOS persona on Windows) with
  // hasInconsistentTimingResolution. Default to the host, keep an explicit value.
  const fingerprint = resolveFingerprintOs(source.CAMOUFOX_FINGERPRINT_OS, platform);
  if (fingerprint.warning !== null) {
    log(fingerprint.warning);
  }
  if (fingerprint.value === null) {
    delete env.CAMOUFOX_FINGERPRINT_OS;
  } else {
    env.CAMOUFOX_FINGERPRINT_OS = fingerprint.value;
  }
  return env;
}

function executableNames() {
  return process.platform === 'win32' ? ['mcp-camoufox.exe'] : ['mcp-camoufox'];
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function searchDirectories(env) {
  const directories = (env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  // uv tool and pipx install console scripts here; a pip --user install lands in
  // the Python Scripts directory when it is not already on PATH.
  directories.push(path.join(homedir(), '.local', 'bin'));
  if (env.APPDATA !== undefined && env.APPDATA.trim() !== '') {
    directories.push(path.join(env.APPDATA.trim(), 'Python', 'Scripts'));
  }
  return [...new Set(directories)];
}

// A .cmd/.bat shim is refused because a shell string is not an executable and
// the plugin starts no shell.
function locateOnPath(env) {
  for (const directory of searchDirectories(env)) {
    for (const name of executableNames()) {
      const candidate = path.join(directory, name);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function explicitCommand(env) {
  const override = env.CAMOUFOX_NATIVE_COMMAND?.trim();
  if (override === undefined || override === '') {
    return null;
  }
  if (!isFile(override)) {
    fail(
      `CAMOUFOX_NATIVE_COMMAND points at "${override}", which is not an existing file. ` +
        'Point it at the mcp-camoufox executable, or unset it to let the plugin provision it.',
    );
  }
  return override;
}

function manifestHash() {
  try {
    return createHash('sha256')
      .update(readFileSync(path.join(PLUGIN_ROOT, 'engines', 'camoufox-native.json'), 'utf8'))
      .digest('hex');
  } catch {
    return null;
  }
}

// Fetch mcp-camoufox from PyPI into <plugin data>/venvs/camoufox-native with the
// shared uv/Python/venv provisioner. The package is installed from the index,
// never bundled with the plugin.
async function provisionCommand(env, spec) {
  const data = pluginDataDir(env);
  const uv = await ensureUv({ env, dataDir: data, log });
  const python = ensurePython({ env, dataDir: data, uv, log });
  const venv = ensureVenv({
    env,
    dataDir: data,
    uv,
    python,
    name: 'camoufox-native',
    packages: [spec],
    extra: { build: BUILD_PIN, manifest: manifestHash() },
    log,
  });
  const command = venvExecutablePath(venv.venv, 'mcp-camoufox', process.platform);
  if (!isFile(command)) {
    throw new Error(
      `the provisioned venv ${venv.venv} does not contain the mcp-camoufox console script. ` +
        'Remove that venv and restart Claude Code to reprovision it.',
    );
  }
  log(`provisioned ${spec} from PyPI into ${venv.venv}`);
  return command;
}

function provisioningHelp(env, spec, error) {
  return (
    `mcp-camoufox could not be provisioned (${error.message}) and no mcp-camoufox executable was found ` +
    `on PATH or in ~/.local/bin. Set CAMOUFOX_NATIVE_COMMAND to the executable, or install it yourself ` +
    `with "uv tool install ${spec}" (or "pipx install ${spec}"), then restart Claude Code. ` +
    'The plugin fetches this package from PyPI at first start; it never bundles or redistributes it ' +
    '(licence FSL-1.1-MIT).'
  );
}

async function main() {
  const env = buildChildEnv(process.env);
  const spec = resolveOverride(env, 'CAMOUFOX_NATIVE_PACKAGE', PACKAGE_PIN);

  let command = explicitCommand(env);
  if (command === null) {
    try {
      command = await provisionCommand(env, spec);
    } catch (error) {
      log(`could not provision ${spec}: ${error.message}`);
      command = locateOnPath(env);
      if (command === null) {
        fail(provisioningHelp(env, spec, error));
      }
      log(`falling back to the user-installed ${command}`);
    }
  }

  const profile = env.CAMOUFOX_PROFILE ?? DEFAULT_PROFILE;
  log(
    `starting ${command} build=${env.CAMOUFOX_BROWSER_VERSION} profile=${profile} ` +
      `headless=${env.CAMOUFOX_HEADLESS} os=${env.CAMOUFOX_FINGERPRINT_OS ?? 'unset'} ` +
      `data=${env.CAMOUFOX_DATA_DIR} daemon=off`,
  );
  const child = spawn(command, [], {
    stdio: 'inherit',
    env,
    windowsHide: true,
    detached: false,
    shell: false,
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
  child.on('error', (error) => {
    fail(`failed to start ${command}: ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
}

// Run only when invoked as the launcher, so the unit suite can import the pure
// env helpers without starting a backend.
const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (invokedPath !== null && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
