// Atomic, source-preserving writes: splice our own span, re-parse the whole
// file, back up the previous bytes, fsync a temp file and rename once.
import { randomBytes } from 'node:crypto';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { SabmError } from './envelope.mjs';
import { stamp } from './paths.mjs';
import { parseText } from './parsers.mjs';
import { spliceText } from './spans.mjs';

const MAX_BACKUPS = 3;

function refused(kind, message, remedy) {
  throw new SabmError('refused', kind, message, remedy);
}

export async function resolveWritableFile(path, label = 'config file') {
  let real;
  try {
    real = await realpath(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: resolve(path), exists: false, realPath: null };
    refused(
      'parse-error',
      `Cannot inspect ${label} ${path}: ${error?.code ?? error.message}.`,
      'Check the path and permissions.',
    );
  }
  let info;
  try {
    info = await stat(real);
  } catch (error) {
    refused(
      'parse-error',
      `Cannot inspect ${label} ${path}: ${error?.code ?? error.message}.`,
      'Check the path and permissions.',
    );
  }
  if (info.isDirectory()) {
    refused('directory', `${path} is a directory, not a ${label}.`, 'Point at a regular file and try again.');
  }
  if ((info.mode & 0o222) === 0) {
    refused(
      'read-only-file',
      `${path} is read-only; refusing to write it.`,
      'Make the file writable and try again.',
    );
  }
  return { path: resolve(path), exists: true, realPath: real };
}

export async function pruneBackups(backupDir, prefix) {
  let names;
  try {
    names = await readdir(backupDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const mine = await Promise.all(
    names
      .filter((name) => name.startsWith(`${prefix}.sabm-backup-`))
      .map(async (name) => ({ name, mtime: (await stat(join(backupDir, name))).mtimeMs })),
  );
  mine.sort((left, right) => right.mtime - left.mtime || right.name.localeCompare(left.name));
  for (const { name } of mine.slice(MAX_BACKUPS)) {
    await import('node:fs/promises').then((fs) => fs.rm(join(backupDir, name), { force: true }));
  }
}

export async function atomicWriteText(path, originalText, nextText, options = {}) {
  const { backupRoot, validate, hooks = {}, action = 'modify', label = 'config file' } = options;
  const target = await resolveWritableFile(path, label);
  const writePath = target.realPath ?? target.path;
  const original = originalText === null ? null : Buffer.from(originalText);
  let backup = null;
  if (original !== null && backupRoot) {
    const backupDir = join(resolve(backupRoot), 'backups');
    await mkdir(backupDir, { recursive: true });
    const name = `${basename(writePath)}.sabm-backup-${stamp()}-${process.pid}-${randomBytes(3).toString('hex')}`;
    const backupPath = join(backupDir, name);
    await writeFile(backupPath, original);
    await pruneBackups(backupDir, basename(writePath));
    backup = backupPath;
  }
  await mkdir(dirname(writePath), { recursive: true });
  const tempPath = `${writePath}.sabm-tmp-${process.pid}`;
  let handle;
  try {
    handle = await open(tempPath, 'w');
    await handle.writeFile(nextText, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (typeof hooks.afterTemp === 'function') {
      await hooks.afterTemp({ path: writePath, tempPath, backup });
    }
    if (typeof validate === 'function') {
      const checked = await validate(nextText, writePath);
      if (checked === false) {
        refused(
          'parse-error',
          `${writePath} failed full re-validation after the splice; nothing was renamed.`,
          'Fix the file and try again.',
        );
      }
    }
    await rename(tempPath, writePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    const { rm } = await import('node:fs/promises');
    await rm(tempPath, { force: true }).catch(() => {});
    if (backup && original) await copyFile(backup, writePath).catch(() => {});
    if (error instanceof SabmError) throw error;
    refused(
      'write-failed',
      `Could not atomically write ${writePath}: ${error?.message ?? error}.`,
      'Check permissions and disk space, then try again.',
    );
  }
  return { path: writePath, action, backup };
}

// Read -> splice -> validate -> atomic write for a harness config entry.
export async function applyEntryEdit({ target, name, edit, dataRoot, hooks = {} }) {
  let text = null;
  try {
    text = await readFile(target.path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const nextText = spliceText(text ?? '', edit(text ?? ''));
  const format = target.format;
  const write = await atomicWriteText(target.path, text, nextText, {
    backupRoot: dataRoot,
    hooks,
    action: edit.action ?? 'modify',
    validate: async (candidate) => {
      parseText(format, candidate);
      return true;
    },
  });
  return { write, text: nextText };
}
