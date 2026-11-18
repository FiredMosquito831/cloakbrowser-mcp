import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir as systemHomedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { SabmError } from './envelope.mjs';

export const DEFAULT_DATA_ROOT_NAME = '.secret-agent-browser-mcps';

export function makeContext(overrides = {}) {
  return {
    platform: overrides.platform ?? process.platform,
    env: overrides.env ?? process.env,
    homedir: overrides.homedir ?? systemHomedir(),
    cwd: overrides.cwd ?? process.cwd(),
  };
}

export function resolveDataRoot(options = {}, context = makeContext()) {
  if (typeof options.dataRoot === 'string' && options.dataRoot.trim() !== '') {
    const input = options.dataRoot.trim();
    return {
      path: isAbsolute(input) ? resolve(input) : resolve(context.cwd, input),
      source: 'cli',
    };
  }
  const inherited = context.env.STEALTH_DATA_DIR;
  if (typeof inherited === 'string' && inherited.trim() !== '') {
    const input = inherited.trim();
    return {
      path: isAbsolute(input) ? resolve(input) : resolve(context.cwd, input),
      source: 'env:STEALTH_DATA_DIR',
    };
  }
  return { path: join(context.homedir, DEFAULT_DATA_ROOT_NAME), source: 'default' };
}

export function shimPath(dataRoot) {
  return join(resolve(dataRoot), 'bin', 'run.mjs');
}

export function shimArgs(harness, entry, dataRoot) {
  return ['node', shimPath(dataRoot), '--harness', harness, '--entry', entry];
}

export function norm(value) {
  return String(value).replace(/\\/g, '/');
}

export async function readTextFile(path, label = 'config file') {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new SabmError(
      'refused',
      'parse-error',
      `Cannot inspect ${label} ${path}: ${error?.code ?? error?.message ?? 'stat failed'}.`,
      'Check the path and its permissions, then try again.',
    );
  }
  if (info.isDirectory()) {
    throw new SabmError(
      'refused',
      'directory',
      `${path} is a directory, not a ${label}.`,
      'Point --project at a directory that contains a regular config file, or remove the directory.',
    );
  }
  if ((info.mode & 0o222) === 0) {
    throw new SabmError(
      'refused',
      'read-only-file',
      `${path} is read-only; refusing to plan a future edit against it.`,
      'Make the file writable or choose a different --project path.',
    );
  }
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new SabmError(
      'refused',
      'parse-error',
      `Cannot read ${label} ${path}: ${error?.code ?? error?.message ?? 'read failed'}.`,
      'Check the path and its permissions, then try again.',
    );
  }
}

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function modeState(path) {
  try {
    const info = await stat(path);
    return { exists: true, writableByMode: (info.mode & 0o222) !== 0, isDirectory: info.isDirectory() };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, writableByMode: null, isDirectory: false };
    return { exists: false, writableByMode: null, isDirectory: false, error: error?.code ?? 'stat-failed' };
  }
}

export async function treeSize(rootPath, depth = 0) {
  if (depth > 8) return { files: 0, bytes: 0, skipped: 1 };
  let info;
  try {
    info = await stat(rootPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
  if (!info.isDirectory()) return { files: 1, bytes: info.size, skipped: 0 };
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let entries = [];
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return { files: 0, bytes: 0, skipped: 1 };
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      skipped += 1;
      continue;
    }
    const child = await treeSize(join(rootPath, entry.name), depth + 1);
    if (child) {
      files += child.files;
      bytes += child.bytes;
      skipped += child.skipped;
    }
  }
  return { files, bytes, skipped };
}

export function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:T]/g, '').slice(0, 13);
}
