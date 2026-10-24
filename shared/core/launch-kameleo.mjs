#!/usr/bin/env node
// Launcher adapter for the Kameleo engine.
//
// Kameleo owns the browser: the plugin never starts the Kameleo app and never
// launches a Chromium of its own. It opens Kameleo's local CDP WebSocket for a
// profile and starts the pinned @playwright/mcp CLI in attach mode, so the
// official 72-tool contract is served over Kameleo's Chromium (Chroma)
// profile. A Junglefox (Firefox) profile cannot be attached this way.
//
// The runtime is the one the plugin already installs for the cloak engine
// (cloakbrowser-mcp with its Playwright dependency aliased to Patchright). The
// launcher reuses a healthy runtime and otherwise provisions it with the same
// identities as launch.mjs; launch.mjs itself is not imported or changed.
//
// Rules: stdout is the MCP protocol only; every log line goes to stderr. A
// missing prerequisite is one actionable line and exit 1, so the broker's
// meta-only recovery path can answer the client instead of hanging the
// handshake.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildEndpoint, validateEndpointSetting } from './lib/attach.mjs';
import { ensureNpmRuntime, resolveNpmPackage } from './lib/provision.mjs';

const LOG_PREFIX = '[kameleo]';
const PROFILE_ENV = 'KAMELEO_PROFILE_ID';
const ENDPOINT_ENV = 'KAMELEO_ENDPOINT';
const ENDPOINT_SETTING = 'kameleo_endpoint';
const DEFAULT_ENDPOINT_TEMPLATE = 'ws://127.0.0.1:5050/playwright/{profileId}';
// The exact sentence the manifest also carries in requiredEnv.reason; a unit
// test keeps the two in sync.
const MISSING_PROFILE_REASON =
  'The kameleo engine needs a profile ID. Set "Kameleo profile ID" (kameleo_profile_id) ' +
  'in the cloakbrowser plugin configuration and restart Claude Code.';

const TOOL_GROUPS = [
  ['vision', 'CLOAK_TOOL_GROUP_VISION'],
  ['pdf', 'CLOAK_TOOL_GROUP_PDF'],
  ['devtools', 'CLOAK_TOOL_GROUP_DEVTOOLS'],
  ['storage', 'CLOAK_TOOL_GROUP_STORAGE'],
  ['network', 'CLOAK_TOOL_GROUP_NETWORK'],
  ['testing', 'CLOAK_TOOL_GROUP_TESTING'],
  ['config', 'CLOAK_TOOL_GROUP_CONFIG'],
];

// Settings that must not reach the Playwright MCP CLI in attach mode: the
// profile, its window mode, its proxy and the plugin's user-data directory
// belong to Kameleo. Empty optional values are dropped for the same reason
// launch.mjs drops them: an empty string is not "unset" to the CLI.
const DROPPED_VARS = [
  PROFILE_ENV,
  ENDPOINT_ENV,
  'PLAYWRIGHT_MCP_USER_DATA_DIR',
  'PLAYWRIGHT_MCP_BROWSER_ENGINE',
  'PLAYWRIGHT_MCP_HEADLESS',
  'PLAYWRIGHT_MCP_PROXY_SERVER',
  'PLAYWRIGHT_MCP_PROXY_BYPASS',
];
const EMPTY_OPTIONAL_VARS = ['PLAYWRIGHT_MCP_OUTPUT_DIR'];

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
    : path.join(homedir(), '.cloakbrowser-mcp-plugin');
}

function runtimeDir(env) {
  return path.join(pluginDataDir(env), 'runtime');
}

function resolvePackage(env) {
  return resolveNpmPackage(env);
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

// The endpoint this launch will use. The broker already refuses to spawn an
// engine whose required environment is missing, but the launcher is also
// invoked directly in tests and by the broker's own spawn path, so it repeats
// the check with the same sentence.
export function resolveLaunchConfig(source) {
  const profile = typeof source[PROFILE_ENV] === 'string' ? source[PROFILE_ENV].trim() : '';
  if (profile === '' || profile.includes('${')) {
    return { endpoint: null, profileId: null, source: 'missing-profile', error: MISSING_PROFILE_REASON };
  }
  const explicit = typeof source[ENDPOINT_ENV] === 'string' ? source[ENDPOINT_ENV].trim() : '';
  if (explicit !== '' && !explicit.includes('${')) {
    const validated = validateEndpointSetting(explicit, ENDPOINT_SETTING);
    if (validated.error !== null) {
      return { endpoint: null, profileId: profile, source: 'setting', error: validated.error };
    }
    return { endpoint: validated.endpoint, profileId: profile, source: 'setting', error: null };
  }
  return {
    endpoint: buildEndpoint(DEFAULT_ENDPOINT_TEMPLATE, profile),
    profileId: profile,
    source: 'default',
    error: null,
  };
}

// Build the environment for the Playwright MCP CLI. Pure and exported so the
// unit suite can assert the dropped settings, the group switches and the
// endpoint without spawning anything.
export function buildChildEnv(source, endpoint) {
  const env = { ...source };
  for (const name of EMPTY_OPTIONAL_VARS) {
    const value = env[name];
    if (value !== undefined && value.trim() === '') {
      delete env[name];
    }
  }
  for (const name of DROPPED_VARS) {
    delete env[name];
  }
  applyToolGroups(env);
  if (typeof endpoint === 'string' && endpoint !== '') {
    // Both spellings are passed: the flag is the documented CLI contract and
    // the environment variable keeps the value visible to a child process the
    // CLI may start.
    env.PLAYWRIGHT_MCP_CDP_ENDPOINT = endpoint;
  }
  return env;
}

// Resolve the installed @playwright/mcp entry point. The package is a
// dependency of the bridge, so npm may hoist it to the runtime root or nest it
// under the bridge; both are accepted, mirroring launch.mjs.
export function locateMcpCli(dir, packageName) {
  const candidates = [
    path.join(dir, 'node_modules', '@playwright', 'mcp', 'cli.js'),
    path.join(dir, 'node_modules', packageName, 'node_modules', '@playwright', 'mcp', 'cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Same identities and the same clean-install rule as launch.mjs; both call the
// shared provisioner. Kameleo validates the @playwright/mcp entry point after
// an install and names that exact failure, as it always has.
function ensureRuntime(env, spec) {
  const runtime = ensureNpmRuntime({
    env,
    dataDir: pluginDataDir(env),
    spec,
    locate: locateMcpCli,
    missingAfterInstallError: (dir) =>
      `The plugin runtime in ${dir} does not contain @playwright/mcp/cli.js after installing ${spec}. ` +
      'Remove that runtime directory and restart Claude Code, or switch the engine to cloak once to reprovision it.',
  });
  return runtime.cli;
}

function main() {
  const launch = resolveLaunchConfig(process.env);
  if (launch.error !== null) {
    fail(launch.error);
  }
  const env = buildChildEnv(process.env, launch.endpoint);
  const packageSpec = resolvePackage(env);

  let cli;
  try {
    cli = ensureRuntime(env, packageSpec);
  } catch (error) {
    fail(error.message);
  }

  log(
    `attaching to ${launch.endpoint} profile=${launch.profileId} source=${launch.source} ` +
      `caps=${env.PLAYWRIGHT_MCP_CAPS ?? 'none'} runtime=${runtimeDir(env)}`,
  );
  const child = spawn(process.execPath, [cli, '--cdp-endpoint', launch.endpoint], {
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
    fail(`failed to start the Playwright MCP CLI at ${cli}: ${error.message}`);
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
// helpers without starting a runtime or a backend.
const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (invokedPath !== null && import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
