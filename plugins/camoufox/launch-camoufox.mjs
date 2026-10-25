#!/usr/bin/env node
// Launcher adapter for the Camoufox engine.
//
// The broker starts this file for every engine whose manifest names it. It
// provisions everything it needs under the plugin data directory on the first
// start: a pinned checksum-verified `uv`, a uv-managed Python, and a venv with
// the pinned Python wrapper (plus its Camoufox dependency). It then ensures the
// pinned Camoufox browser build exists and spawns the wrapper's stdio entry
// point. An explicit UV/UV_BIN, UV_PYTHON or PYTHON override wins.
//
// Rules: stdout is the MCP protocol only; every log line goes to stderr. Missing
// prerequisites are named in one actionable line and exit 1 so the broker's
// meta-only recovery path can answer the client instead of hanging the handshake.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensurePython, ensureUv, ensureVenv } from './lib/provision.mjs';

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_PIN = 'camoufox-playwright-mcp==0.1.5';
const BUILD_PIN = 'v156.0.1-beta.39';
// The Python MCP stack beside the wrapper, exactly as the wrapper's own uv.lock
// resolves it (fastmcp 3.4.7 -> fastmcp-slim[client,server] -> mcp 1.29.0).
// The wrapper's pyproject.toml only says `fastmcp>=3.4.2`, with no upper bound,
// so an unpinned install resolves fastmcp 4.x. That major serves the
// 2026-07-28 protocol era, where every request is its own connection with a new
// session id; the wrapper keys its browser backend by that id, so it relaunches
// the browser on every tool call and the second launch fails on the profile the
// first browser still holds. A pin, not a range: every other dependency in this
// plugin is exact, and the lock is the only version set upstream actually
// tested.
const PYTHON_STACK_PINS = ['fastmcp==3.4.7', 'mcp==1.29.0'];
const BOOTSTRAP = 'camoufox_bootstrap.py';
const ENTRY = 'camoufox_entry.py';
const LOG_PREFIX = '[camoufox]';

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

// A change to the manifest, the wrapper pin or the build pin must rebuild the
// venv, so all three feed the marker hash.
function contractHash(spec, build) {
  const manifest = readFileSync(path.join(PLUGIN_ROOT, 'engines', 'camoufox.json'), 'utf8');
  return createHash('sha256')
    .update(manifest)
    .update('\n')
    .update(spec)
    .update('\n')
    .update(build)
    .digest('hex');
}

// The venv package list: the wrapper pin (or the CAMOUFOX_MCP_PACKAGE override)
// followed by the pinned MCP stack. Both feed the venv marker, so a change to
// either rebuilds an existing venv on the next start.
export function venvPackages(spec) {
  return [spec, ...PYTHON_STACK_PINS];
}

function ensureRuntime(env, spec, build) {
  const data = dataDir(env);
  return ensureUv({ env, dataDir: data, log }).then((uv) => {
    const python = ensurePython({ env, dataDir: data, uv, log });
    return ensureVenv({
      env,
      dataDir: data,
      uv,
      python,
      name: 'camoufox',
      packages: venvPackages(spec),
      extra: { build, manifest: contractHash(spec, build) },
      log,
    });
  });
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
    const tail = typeof result?.stderr === 'string' ? result.stderr.trim().slice(-400) : '';
    fail(`cannot locate the Camoufox build ${build}: ${tail}`);
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

async function main() {
  const env = buildChildEnv(process.env);
  const spec = resolveOverride(env, 'CAMOUFOX_MCP_PACKAGE', PACKAGE_PIN);
  const build = resolveOverride(env, 'CAMOUFOX_BROWSER_BUILD', BUILD_PIN);

  const paths = await ensureRuntime(env, spec, build);
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

// Run only when invoked as the launcher, so the unit suite can import the pure
// helpers without provisioning a runtime or starting a backend.
const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (invokedPath !== null && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
