#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Bridge 1.15.1 rejects cloakbrowser 0.6.4 when humanize is enabled; 0.6.3 is
// the newest wrapper its compatibility check accepts. Remove this pin after the
// bridge adds 0.6.4 to its allowlist.
const ENGINE_WRAPPER_PIN = '0.6.3';

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

function runtimeDir(env) {
  const base =
    env.CLAUDE_PLUGIN_DATA !== undefined && env.CLAUDE_PLUGIN_DATA.trim() !== ''
      ? env.CLAUDE_PLUGIN_DATA
      : path.join(homedir(), '.cloakbrowser-mcp-plugin');
  return path.join(base, 'runtime');
}

function cliPath(dir, name) {
  return path.join(dir, 'node_modules', name, 'dist', 'cli.js');
}

function ensureRuntime(env, spec) {
  const { name, version } = parsePackageSpec(spec);
  const dir = runtimeDir(env);
  const marker = path.join(dir, '.installed.json');
  const desired = { package: spec, engine: ENGINE_WRAPPER_PIN };
  const cli = cliPath(dir, name);

  if (existsSync(cli) && existsSync(marker)) {
    try {
      const current = JSON.parse(readFileSync(marker, 'utf8'));
      if (current.package === desired.package && current.engine === desired.engine) {
        return cli;
      }
    } catch {
      // A corrupt marker falls through to a reinstall.
    }
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        private: true,
        dependencies: { [name]: version },
        overrides: { cloakbrowser: ENGINE_WRAPPER_PIN },
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
