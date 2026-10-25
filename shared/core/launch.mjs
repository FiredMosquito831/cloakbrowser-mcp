#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureNpmRuntime, resolveNpmPackage } from './lib/provision.mjs';

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
  return env;
}

function resolvePackage(source) {
  return resolveNpmPackage(source);
}

function dataDir(env) {
  return env.CLAUDE_PLUGIN_DATA !== undefined && env.CLAUDE_PLUGIN_DATA.trim() !== ''
    ? env.CLAUDE_PLUGIN_DATA
    : path.join(homedir(), '.cloakbrowser-mcp-plugin');
}

function applyDefaultProfile(env) {
  if (env.PLAYWRIGHT_MCP_USER_DATA_DIR !== undefined) {
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
  main();
}
