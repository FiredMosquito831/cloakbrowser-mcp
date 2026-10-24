// npm registry reads for the pin decision. The workflow and the local dry run
// both use `npm view`, which needs no API token. Tests inject `spawn`, so no
// unit test touches the network.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseVersion } from '../lib/semver.mjs';

const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Resolve a shell-free way to run npm on this platform.
 *
 * Windows cannot spawn `npm.cmd` without a shell. The npm CLI next to the
 * running node executable can be run directly with that executable, so the
 * common case stays shell-free and argument-safe; the shell fallback is only
 * for an unusual install layout and only carries validated arguments.
 *
 * @param {string} platform Node platform value.
 * @param {string} execPath Running node executable.
 * @returns {{command: string, prefix: string[], shell: boolean}} Invocation.
 */
export function npmInvocation(platform, execPath = process.execPath) {
  if (platform !== 'win32') {
    return { command: 'npm', prefix: [], shell: false };
  }
  const cli = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) {
    return { command: execPath, prefix: [cli], shell: false };
  }
  return { command: 'npm.cmd', prefix: [], shell: true };
}

/**
 * Parse the JSON string printed by `npm view <pkg> dist-tags.latest --json`.
 *
 * @param {string} stdout Command output.
 * @returns {string} The latest version.
 */
export function parseNpmViewVersion(stdout) {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    throw new Error('npm view printed no version');
  }
  let value = trimmed;
  if (trimmed.startsWith('"')) {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== 'string') {
      throw new Error('npm view printed a non-string version');
    }
    value = parsed;
  }
  parseVersion(value);
  return value.trim();
}

/**
 * Read the latest dist-tag of a package from the npm registry.
 *
 * @param {{packageName: string, cwd?: string, retries?: number, spawn?: typeof spawnSync, platform?: string, execPath?: string}} options Read options.
 * @returns {string} The latest stable-or-whatever version the registry returns.
 */
export function npmViewDistTagLatest({
  packageName,
  cwd = process.cwd(),
  retries = 3,
  spawn = spawnSync,
  platform = process.platform,
  execPath = process.execPath,
}) {
  if (!PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new Error(`refusing to query an invalid npm package name: ${packageName}`);
  }
  const invocation = npmInvocation(platform, execPath);
  const args = [...invocation.prefix, 'view', packageName, 'dist-tags.latest', '--json'];
  let lastError = 'unknown error';
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const result = spawn(invocation.command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      shell: invocation.shell,
    });
    if (result.error !== undefined) {
      lastError = result.error.message;
    } else if (result.status !== 0) {
      lastError = (result.stderr ?? '').trim() || `exit ${result.status}`;
    } else {
      return parseNpmViewVersion(result.stdout ?? '');
    }
    if (attempt + 1 < retries) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  }
  throw new Error(`npm view ${packageName} failed after ${retries} attempts: ${lastError}`);
}
