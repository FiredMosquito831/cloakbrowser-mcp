#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Bridge 1.15.1 rejects cloakbrowser 0.6.4 when humanize is enabled; 0.6.3 is
// the newest wrapper its compatibility check accepts. Remove this pin after the
// bridge adds 0.6.4 to its allowlist.
const ENGINE_WRAPPER_PIN = '0.6.3';
const DRIVER_PIN = 'patchright@1.64.1';

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

const DEFAULT_PACKAGE = 'cloakbrowser-mcp@1.15.1';

const TOOL_GROUPS = [
  ['vision', 'CLOAK_TOOL_GROUP_VISION'],
  ['pdf', 'CLOAK_TOOL_GROUP_PDF'],
  ['devtools', 'CLOAK_TOOL_GROUP_DEVTOOLS'],
  ['storage', 'CLOAK_TOOL_GROUP_STORAGE'],
  ['network', 'CLOAK_TOOL_GROUP_NETWORK'],
  ['testing', 'CLOAK_TOOL_GROUP_TESTING'],
  ['config', 'CLOAK_TOOL_GROUP_CONFIG'],
];

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

function resolvePackage(source) {
  const value = source.CLOAK_PLAYWRIGHT_MCP_PACKAGE;
  return value !== undefined && value.trim() !== '' ? value.trim() : DEFAULT_PACKAGE;
}

function parsePackageSpec(spec) {
  const at = spec.lastIndexOf('@');
  if (at <= 0) {
    return { name: spec, version: 'latest' };
  }
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
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

function runtimeDir(env) {
  return path.join(dataDir(env), 'runtime');
}

function cliPath(dir, name) {
  return path.join(dir, 'node_modules', name, 'dist', 'cli.js');
}

function readPackage(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return { name: data.name, version: data.version };
  } catch {
    return null;
  }
}

function runtimeHealthy(dir, marker, desired, cli) {
  if (!existsSync(cli) || !existsSync(marker)) {
    return false;
  }
  try {
    const current = JSON.parse(readFileSync(marker, 'utf8'));
    if (
      current.package !== desired.package ||
      current.engine !== desired.engine ||
      current.driver !== desired.driver
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const core = readPackage(path.join(dir, 'node_modules', 'playwright-core', 'package.json'));
  const nested = readPackage(
    path.join(dir, 'node_modules', '@playwright', 'mcp', 'node_modules', 'playwright', 'package.json'),
  );
  const topLevel = readPackage(path.join(dir, 'node_modules', 'playwright', 'package.json'));
  const playwrightPackage = nested ?? topLevel;
  const engine = readPackage(path.join(dir, 'node_modules', 'cloakbrowser', 'package.json'));
  return (
    core?.name === 'patchright-core' &&
    playwrightPackage?.name === 'patchright' &&
    engine?.version === ENGINE_WRAPPER_PIN
  );
}

function ensureRuntime(env, spec) {
  const { name, version } = parsePackageSpec(spec);
  const dir = runtimeDir(env);
  const marker = path.join(dir, '.installed.json');
  const desired = {
    package: spec,
    engine: ENGINE_WRAPPER_PIN,
    driver: DRIVER_PIN,
  };
  const cli = cliPath(dir, name);

  if (runtimeHealthy(dir, marker, desired, cli)) {
    return cli;
  }

  // A previous install may be a mixed tree (stock playwright-core with a
  // nested patchright). npm will not fix that in place, so start clean.
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
          cloakbrowser: ENGINE_WRAPPER_PIN,
          playwright: `npm:patchright@${DRIVER_PIN.split('@')[1]}`,
          'playwright-core': `npm:patchright-core@${DRIVER_PIN.split('@')[1]}`,
        },
      },
      null,
      2,
    ) + '\n',
  );

  const isWindows = process.platform === 'win32';
  const install = spawnSync(
    isWindows ? 'npm.cmd' : 'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund'],
    {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: isWindows,
    },
  );
  if (install.status !== 0) {
    throw new Error(`npm install failed for ${spec} in ${dir} (exit ${install.status})`);
  }

  writeFileSync(marker, JSON.stringify(desired) + '\n');
  return cli;
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

main();
