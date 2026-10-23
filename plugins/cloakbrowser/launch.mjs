#!/usr/bin/env node
import { spawn } from 'node:child_process';

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

function main() {
  const env = buildChildEnv(process.env);
  const packageSpec = resolvePackage(env);
  const isWindows = process.platform === 'win32';
  const child = spawn(isWindows ? 'npx.cmd' : 'npx', ['-y', packageSpec], {
    stdio: 'inherit',
    env,
    shell: isWindows,
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
