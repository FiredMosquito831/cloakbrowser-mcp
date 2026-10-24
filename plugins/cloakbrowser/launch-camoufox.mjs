#!/usr/bin/env node
// Launcher adapter for the Camoufox engine.
//
// The broker starts this file for every engine whose manifest names it. It
// provisions a vendored venv under the plugin data directory with `uv`, installs
// the pinned Python wrapper plus its Camoufox dependency, ensures the pinned
// Camoufox browser build exists, then spawns the wrapper's stdio entry point.
//
// Rules: stdout is the MCP protocol only; every log line goes to stderr. Missing
// prerequisites are named in one actionable line and exit 1 so the broker's
// meta-only recovery path can answer the client instead of hanging the handshake.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_PIN = 'camoufox-playwright-mcp==0.1.5';
const BUILD_PIN = 'v156.0.1-beta.39';
const BOOTSTRAP = 'camoufox_bootstrap.py';
const ENTRY = 'camoufox_entry.py';
const LOG_PREFIX = '[camoufox]';
const MINIMUM_PYTHON = [3, 12];

const EMPTY_OPTIONAL_VARS = [
  'PLAYWRIGHT_MCP_USER_DATA_DIR',
  'PLAYWRIGHT_MCP_PROXY_SERVER',
  'PLAYWRIGHT_MCP_PROXY_BYPASS',
  'PLAYWRIGHT_MCP_OUTPUT_DIR',
  'PLAYWRIGHT_MCP_HEADLESS',
];

const TOOL_GROUPS = [
  ['vision', 'CLOAK_TOOL_GROUP_VISION'],
  ['pdf', 'CLOAK_TOOL_GROUP_PDF'],
  ['devtools', 'CLOAK_TOOL_GROUP_DEVTOOLS'],
  ['storage', 'CLOAK_TOOL_GROUP_STORAGE'],
  ['network', 'CLOAK_TOOL_GROUP_NETWORK'],
  ['testing', 'CLOAK_TOOL_GROUP_TESTING'],
  ['config', 'CLOAK_TOOL_GROUP_CONFIG'],
];

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

function fail(message) {
  log(message);
  process.exit(1);
}

function buildChildEnv(source) {
  const env = { ...source };
  for (const name of EMPTY_OPTIONAL_VARS) {
    const value = env[name];
    if (value !== undefined && value.trim() === '') {
      delete env[name];
    }
  }
  return env;
}

function dataDir(env) {
  return env.CLAUDE_PLUGIN_DATA !== undefined && env.CLAUDE_PLUGIN_DATA.trim() !== ''
    ? env.CLAUDE_PLUGIN_DATA
    : path.join(homedir(), '.camoufox-mcp-plugin');
}

function resolveOverride(env, name, fallback) {
  const value = env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : fallback;
}

function groupEnabled(env, name) {
  const value = (env[name] ?? 'true').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(value);
}

function applyToolGroups(env) {
  const caps = TOOL_GROUPS.filter(([, name]) => groupEnabled(env, name)).map(([group]) => group);
  if (caps.length === 0) {
    delete env.CAMOUFOX_MCP_CAPS;
  } else {
    env.CAMOUFOX_MCP_CAPS = caps.join(',');
  }
}

function applyDefaultProfile(env) {
  if (env.PLAYWRIGHT_MCP_USER_DATA_DIR !== undefined) {
    return;
  }
  const profile = path.join(dataDir(env), 'profiles', 'camoufox', 'default');
  mkdirSync(profile, { recursive: true });
  env.PLAYWRIGHT_MCP_USER_DATA_DIR = profile;
}

function runVersionCommand(command, args) {
  return spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  });
}

function parsePythonVersion(result) {
  if (result === null || result.status !== 0) {
    return null;
  }
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = /Python\s+(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

// Never install or download Python: find an interpreter the user already has and
// name the requirement when there is none.
function findPython() {
  for (const candidate of ['python', 'python3']) {
    const result = runVersionCommand(candidate, ['--version']);
    const version = parsePythonVersion(result);
    if (version === null) {
      continue;
    }
    if (version.major > MINIMUM_PYTHON[0] || (version.major === MINIMUM_PYTHON[0] && version.minor >= MINIMUM_PYTHON[1])) {
      return { command: candidate, version };
    }
    return { command: candidate, version, tooOld: true };
  }
  return null;
}

function requirePrerequisites() {
  const python = findPython();
  if (python === null) {
    fail(
      'Python 3.12+ is required but no "python" interpreter was found. ' +
        'Install Python 3.12 or newer and restart Claude Code.',
    );
  }
  if (python.tooOld === true) {
    const { major, minor, patch } = python.version;
    fail(
      `Python 3.12+ is required; found ${major}.${minor}.${patch}. ` +
        'Install Python 3.12 or newer and restart Claude Code.',
    );
  }
  const uv = runVersionCommand('uv', ['--version']);
  if (uv === null || uv.status !== 0) {
    fail(
      'uv is required but was not found on PATH. Install uv from ' +
        'https://docs.astral.sh/uv/getting-started/installation/ and restart Claude Code.',
    );
  }
  return python;
}

function runtimeRoot(env) {
  return path.join(dataDir(env), 'runtime-camoufox');
}

function venvPaths(env) {
  const root = runtimeRoot(env);
  const venv = path.join(root, '.venv');
  const isWindows = process.platform === 'win32';
  return {
    root,
    venv,
    python: path.join(venv, isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python'),
    marker: path.join(root, '.installed.json'),
  };
}

function packageVersion(spec) {
  const at = spec.indexOf('==');
  return at === -1 ? spec : spec.slice(at + 2);
}

function sitePackageDirs(paths) {
  // Windows venvs use Lib/site-packages; POSIX venvs use lib/pythonX.Y/site-packages.
  const base = path.join(paths.venv, process.platform === 'win32' ? 'Lib' : 'lib');
  const directories = [];
  for (const entry of readdirSyncSafe(base)) {
    const directory = path.join(base, entry);
    if (entry === 'site-packages' || entry.startsWith('python')) {
      directories.push(entry.startsWith('python') ? path.join(directory, 'site-packages') : directory);
    }
  }
  directories.push(base);
  return directories.filter((directory) => existsSync(directory));
}

function wrapperInstalled(paths, spec) {
  const expected = `camoufox_playwright_mcp-${packageVersion(spec)}.dist-info`;
  return sitePackageDirs(paths).some((directory) => readdirSyncSafe(directory).includes(expected));
}

function readdirSyncSafe(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function readMarker(marker) {
  try {
    return JSON.parse(readFileSync(marker, 'utf8'));
  } catch {
    return null;
  }
}

function runtimeHealthy(paths, spec, build, pythonLabel) {
  if (!existsSync(paths.python)) {
    return false;
  }
  const marker = readMarker(paths.marker);
  if (
    marker === null ||
    marker.package !== spec ||
    marker.build !== build ||
    marker.python !== pythonLabel
  ) {
    return false;
  }
  return wrapperInstalled(paths, spec);
}

function stderrTail(text) {
  return typeof text === 'string' ? text.trim().slice(-400) : '';
}

function ensureRuntime(env, spec, build) {
  const python = requirePrerequisites();
  const pythonLabel = `${python.version.major}.${python.version.minor}.${python.version.patch}`;
  const paths = venvPaths(env);

  if (!runtimeHealthy(paths, spec, build, pythonLabel)) {
    // A stale or partial venv is rebuilt from scratch; the marker is written last.
    rmSync(paths.marker, { force: true });
    mkdirSync(paths.root, { recursive: true });
    log(`provisioning the vendored venv at ${paths.venv} (one-time)`);
    const venv = spawnSync(
      'uv',
      ['venv', '--python', python.command, '--no-python-downloads', '--clear', '--force', paths.venv],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true },
    );
    if (venv === null || venv.status !== 0) {
      fail(`uv venv failed: ${stderrTail(venv?.stderr)}`);
    }
    const install = spawnSync('uv', ['pip', 'install', '--python', paths.python, spec], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
    });
    if (install === null || install.status !== 0) {
      fail(`uv pip install failed for ${spec}: ${stderrTail(install?.stderr)}`);
    }
    if (!wrapperInstalled(paths, spec)) {
      fail(`the installed venv does not contain ${spec}; refusing to start a mismatched runtime.`);
    }
    writeFileSync(
      paths.marker,
      `${JSON.stringify({ package: spec, build, python: pythonLabel }, null, 2)}\n`,
    );
  }
  return paths;
}

function ensureBuild(env, paths, build) {
  const bootstrap = path.join(PLUGIN_ROOT, BOOTSTRAP);
  // fd 1 is mapped to this process's stderr: the helper's progress output must
  // never reach the MCP protocol stream.
  const result = spawnSync(paths.python, ['-I', bootstrap, 'ensure-build', build], {
    stdio: ['ignore', 2, 2],
    env,
    windowsHide: true,
  });
  if (result === null || result.status !== 0) {
    fail(`Camoufox build ${build} is not available: see the error above. Restart Claude Code to retry.`);
  }
}

function resolveBinary(env, paths, build) {
  const bootstrap = path.join(PLUGIN_ROOT, BOOTSTRAP);
  const result = spawnSync(paths.python, ['-I', bootstrap, 'binary-path', build], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  if (result === null || result.status !== 0) {
    fail(`cannot locate the Camoufox build ${build}: ${stderrTail(result?.stderr)}`);
  }
  const lines = `${result.stdout ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const binary = lines.length === 0 ? '' : lines[lines.length - 1];
  if (binary === '' || !existsSync(binary)) {
    fail(`the Camoufox launcher printed no existing executable for build ${build}.`);
  }
  return binary;
}

function main() {
  const env = buildChildEnv(process.env);
  const spec = resolveOverride(env, 'CAMOUFOX_MCP_PACKAGE', PACKAGE_PIN);
  const build = resolveOverride(env, 'CAMOUFOX_BROWSER_BUILD', BUILD_PIN);

  const paths = ensureRuntime(env, spec, build);
  ensureBuild(env, paths, build);
  const binary = resolveBinary(env, paths, build);

  applyDefaultProfile(env);
  applyToolGroups(env);
  env.CAMOUFOX_EXECUTABLE_PATH = binary;

  log(`starting process pinned to build ${build.replace(/^v/, '')}; executable ${binary}`);
  const entry = path.join(PLUGIN_ROOT, ENTRY);
  const child = spawn(paths.python, ['-I', entry], { stdio: 'inherit', env, windowsHide: true });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on('error', (error) => {
    fail(`failed to launch ${spec}: ${error.message}`);
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
