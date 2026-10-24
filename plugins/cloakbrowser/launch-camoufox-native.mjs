#!/usr/bin/env node
// Launcher adapter for the Camoufox native engine (mcp-camoufox).
//
// The package is a user-installed dependency: this plugin does not bundle,
// download or redistribute it (its licence is FSL-1.1-MIT). The launcher finds
// the console script the user installed, validates the profile name with the
// app's own rule, pins the daemon off and the Camoufox browser build, drops
// empty optional values, then spawns the app with inherited stdio.
//
// Rules: stdout is the MCP protocol only; every log line goes to stderr. A
// missing prerequisite is one actionable line and exit 1, so the broker's
// meta-only recovery path can answer the client instead of hanging the
// handshake.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PACKAGE_PIN = 'mcp-camoufox==0.4.5';
const BUILD_PIN = '156.0.1-beta.39';
const LOG_PREFIX = '[camoufox-native]';
const DEFAULT_PROFILE = 'default';
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

function normalizeBuild(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const withoutV = value.replace(/^[vV]/, '');
  return withoutV === '' ? BUILD_PIN : withoutV;
}

function buildChildEnv(source) {
  const env = { ...source };
  for (const name of EMPTY_OPTIONAL_VARS) {
    const value = env[name];
    if (value !== undefined && value.trim() === '') {
      delete env[name];
    }
  }
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
  const directories = (env.PATH ?? '')
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

// The app is looked up, never installed. A .cmd/.bat shim is refused because a
// shell string is not an executable and the plugin starts no shell.
function locateCommand(env) {
  const override = env.CAMOUFOX_NATIVE_COMMAND?.trim();
  if (override !== undefined && override !== '') {
    if (!isFile(override)) {
      fail(
        `CAMOUFOX_NATIVE_COMMAND points at "${override}", which is not an existing file. ` +
          'Point it at the mcp-camoufox executable, or unset it and put the executable on PATH.',
      );
    }
    return override;
  }
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

function installHelp(env) {
  const spec =
    env.CAMOUFOX_NATIVE_PACKAGE !== undefined && env.CAMOUFOX_NATIVE_PACKAGE.trim() !== ''
      ? env.CAMOUFOX_NATIVE_PACKAGE.trim()
      : PACKAGE_PIN;
  return (
    `mcp-camoufox is not installed (looked for ${executableNames().join(' or ')} on PATH and in ~/.local/bin). ` +
    `Install it yourself with "uv tool install ${spec}" or "pipx install ${spec}", then restart Claude Code. ` +
    'The plugin does not bundle or download this package; its licence is FSL-1.1-MIT.'
  );
}

function main() {
  const env = buildChildEnv(process.env);
  const command = locateCommand(env);
  if (command === null) {
    fail(installHelp(env));
  }
  const profile = env.CAMOUFOX_PROFILE ?? DEFAULT_PROFILE;
  log(
    `starting ${command} build=${env.CAMOUFOX_BROWSER_VERSION} profile=${profile} ` +
      `headless=${env.CAMOUFOX_HEADLESS} data=${env.CAMOUFOX_DATA_DIR} daemon=off`,
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

main();
