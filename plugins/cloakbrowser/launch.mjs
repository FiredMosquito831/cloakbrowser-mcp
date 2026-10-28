#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyLauncherSettings } from './lib/launcher-settings.mjs';
import { ensureNpmRuntime, resolveNpmPackage, writeRuntimeLease } from './lib/provision.mjs';

const EMPTY_OPTIONAL_VARS = [
  'PLAYWRIGHT_MCP_USER_DATA_DIR',
  'PLAYWRIGHT_MCP_PROXY_SERVER',
  'PLAYWRIGHT_MCP_PROXY_BYPASS',
  'PLAYWRIGHT_MCP_OUTPUT_DIR',
  'CLOAK_PLAYWRIGHT_MCP_CONTEXT_OPTIONS',
  'CLOAK_PLAYWRIGHT_MCP_EXTRA_ARGS',
  'CLOAKBROWSER_LICENSE_KEY',
  'CLOAKBROWSER_VERSION',
  'CLOAKBROWSER_CACHE_DIR',
  'CLOAKBROWSER_BINARY_PATH',
];

// Unrestricted file access is opt-in. Upstream reads this variable as true only
// for "true" or "1" (playwright-core coreBundle configFromEnv/envToBoolean; the
// Camoufox wrapper's _env_bool accepts the same spellings). The plugin setting is
// a boolean whose default is false, and Claude Code substitutes that default as
// the string "false", so anything not explicitly on is dropped: the child
// environment for the default configuration stays byte-identical to 2.9.5, when
// this variable did not exist. An explicit "true"/"1" is passed as "true".
const UNRESTRICTED_FILE_ACCESS_VAR = 'PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS';

function applyUnrestrictedFileAccess(env) {
  const value = (env[UNRESTRICTED_FILE_ACCESS_VAR] ?? '').trim().toLowerCase();
  if (value === 'true' || value === '1') {
    env[UNRESTRICTED_FILE_ACCESS_VAR] = 'true';
  } else {
    delete env[UNRESTRICTED_FILE_ACCESS_VAR];
  }
}

const TOOL_GROUPS = [
  ['vision', 'CLOAK_TOOL_GROUP_VISION'],
  ['pdf', 'CLOAK_TOOL_GROUP_PDF'],
  ['devtools', 'CLOAK_TOOL_GROUP_DEVTOOLS'],
  ['storage', 'CLOAK_TOOL_GROUP_STORAGE'],
  ['network', 'CLOAK_TOOL_GROUP_NETWORK'],
  ['testing', 'CLOAK_TOOL_GROUP_TESTING'],
  ['config', 'CLOAK_TOOL_GROUP_CONFIG'],
];

export function buildChildEnv(source) {
  const env = { ...source };
  for (const name of EMPTY_OPTIONAL_VARS) {
    const value = env[name];
    if (value !== undefined && value.trim() === '') {
      delete env[name];
    }
  }
  applyUnrestrictedFileAccess(env);
  // Launcher-side safe branches (2.21.0): headless, humanize, human_preset,
  // release_channel and the optional values are resolved here, so a missing value,
  // an empty one, an unsubstituted ${user_config.*} placeholder or an unrecognised
  // value can neither flip a stealth setting nor crash the bridge (its
  // human_preset/release_channel parsers throw). Each unusable value writes one
  // stderr line; a value the engine accepts is passed through unchanged.
  applyLauncherSettings(env, 'launch.mjs', logLine);
  return env;
}

function logLine(message) {
  process.stderr.write(`[cloakbrowser] ${message}\n`);
}

function resolvePackage(source) {
  return resolveNpmPackage(source);
}

function dataDir(env) {
  return env.CLAUDE_PLUGIN_DATA !== undefined && env.CLAUDE_PLUGIN_DATA.trim() !== ''
    ? env.CLAUDE_PLUGIN_DATA
    : path.join(homedir(), '.cloakbrowser-mcp-plugin');
}

// profile_isolation=isolated turns the engine's own isolated switch on in the
// broker, which also removes any user-data-dir. The launcher must then not create
// or apply the default profile: that profile exists to be persistent, and an
// isolated start keeps nothing. Only the spellings the engine itself treats as
// true count, so an unset or empty value is exactly the previous behaviour.
export function isIsolatedStart(source) {
  const value = (source.PLAYWRIGHT_MCP_ISOLATED ?? '').trim().toLowerCase();
  return value === 'true' || value === '1';
}

function applyDefaultProfile(env) {
  if (isIsolatedStart(env) || env.PLAYWRIGHT_MCP_USER_DATA_DIR !== undefined) {
    return;
  }
  const profile = path.join(dataDir(env), 'profiles', 'default');
  mkdirSync(profile, { recursive: true });
  env.PLAYWRIGHT_MCP_USER_DATA_DIR = profile;
}

function groupEnabled(env, name) {
  const value = (env[name] ?? 'true').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(value);
}

function applyToolGroups(env) {
  const caps = TOOL_GROUPS.filter(([, name]) => groupEnabled(env, name)).map(([group]) => group);
  if (caps.length === 0) {
    delete env.PLAYWRIGHT_MCP_CAPS;
  } else {
    env.PLAYWRIGHT_MCP_CAPS = caps.join(',');
  }
}

function cliPath(dir, name) {
  return path.join(dir, 'node_modules', name, 'dist', 'cli.js');
}

// The install/identity logic lives in lib/provision.mjs and is shared with
// launch-kameleo.mjs. The pins, package.json bytes, npm arguments, clean
// reinstall and marker bytes are unchanged from 1.x.
function ensureRuntime(env, spec) {
  const runtime = ensureNpmRuntime({
    env,
    dataDir: dataDir(env),
    spec,
    locate: (dir, name) => {
      const candidate = cliPath(dir, name);
      return existsSync(candidate) ? candidate : null;
    },
  });
  // launch.mjs has always spawned the conventional CLI path even when the
  // install did not create it (the child then reports the failure); keep that.
  return runtime.cli ?? cliPath(runtime.dir, parseName(spec));
}

function parseName(spec) {
  const at = spec.lastIndexOf('@');
  return at <= 0 ? spec : spec.slice(0, at);
}

// --seat-status (2.20.0): the broker's layer-2 seat signal, opt-in through
// seat_limit "vendor-license". The launcher owns provisioning, which the broker
// cannot do, so this is the one adapter that resolves the engine package and asks
// the vendor's own licence API for the seats this key holds. One JSON line on
// stdout and nothing else; every failure is a status, never a crash, because the
// broker treats any non-"ok" answer as "no seat" and holds.
const SEAT_STATUS_FLAG = '--seat-status';

function printSeatStatus(status) {
  process.stdout.write(`${JSON.stringify(status)}\n`);
}

async function seatStatus() {
  const env = buildChildEnv(process.env);
  const key = (env.CLOAKBROWSER_LICENSE_KEY ?? '').trim();
  if (key === '' || key.includes('${')) {
    printSeatStatus({
      state: 'unavailable',
      active: null,
      limit: null,
      reason: 'no licence key is configured',
    });
    return 0;
  }
  const packageSpec = resolvePackage(env);
  let runtime;
  try {
    runtime = ensureNpmRuntime({
      env,
      dataDir: dataDir(env),
      spec: packageSpec,
      locate: (dir, name) => {
        const candidate = cliPath(dir, name);
        return existsSync(candidate) ? candidate : null;
      },
    });
  } catch (error) {
    printSeatStatus({
      state: 'unreachable',
      active: null,
      limit: null,
      reason: `the engine runtime is not provisioned: ${error.message}`,
    });
    return 0;
  }
  // The vendor's license module is not an exported subpath of the package, so it
  // is imported by file URL from the provisioned runtime.
  const licenseFile = path.join(runtime.dir, 'node_modules', 'cloakbrowser', 'dist', 'license.js');
  if (!existsSync(licenseFile)) {
    printSeatStatus({
      state: 'unknown',
      active: null,
      limit: null,
      reason: 'the provisioned engine package has no license module',
    });
    return 0;
  }
  let seats;
  try {
    const module = await import(pathToFileURL(licenseFile).href);
    if (typeof module.getSessionSeats !== 'function') {
      printSeatStatus({
        state: 'unknown',
        active: null,
        limit: null,
        reason: 'the provisioned engine package does not export getSessionSeats',
      });
      return 0;
    }
    seats = await module.getSessionSeats(key);
  } catch (error) {
    printSeatStatus({ state: 'unreachable', active: null, limit: null, reason: error.message });
    return 0;
  }
  printSeatStatus({
    state: typeof seats?.state === 'string' ? seats.state : 'unknown',
    active: typeof seats?.active === 'number' ? seats.active : null,
    limit: typeof seats?.limit === 'number' ? seats.limit : null,
    reason: typeof seats?.reason === 'string' ? seats.reason : null,
  });
  return 0;
}

function main() {
  const env = buildChildEnv(process.env);
  applyDefaultProfile(env);
  applyToolGroups(env);
  const packageSpec = resolvePackage(env);
  const isWindows = process.platform === 'win32';

  let cli;
  try {
    cli = ensureRuntime(env, packageSpec);
  } catch (error) {
    process.stderr.write(`[cloakbrowser] ${error.message}\n`);
    process.exit(1);
  }

  // The runtime lease is the only holder signal this tree has: Node releases an
  // entry point after reading it, so a file probe cannot tell that a session is
  // running. A later start refuses to swap the runtime out from under this pid.
  const releaseLease = writeRuntimeLease(path.join(dataDir(env), 'runtime'));
  process.on('exit', releaseLease);

  const child = spawn(process.execPath, [cli], {
    stdio: 'inherit',
    env,
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on('error', (error) => {
    process.stderr.write(`[cloakbrowser] failed to launch ${packageSpec}: ${error.message}\n`);
    process.exit(1);
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
// env helpers without provisioning a runtime or starting a backend.
const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (invokedPath !== null && import.meta.url === pathToFileURL(invokedPath).href) {
  if (process.argv.includes(SEAT_STATUS_FLAG)) {
    // Exit through exitCode, not process.exit(): the vendor call leaves a socket
    // open, and tearing the loop down under it trips a libuv assertion on Windows.
    seatStatus().then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        printSeatStatus({ state: 'unreachable', active: null, limit: null, reason: error.message });
        process.exitCode = 0;
      },
    );
  } else {
    main();
  }
}
