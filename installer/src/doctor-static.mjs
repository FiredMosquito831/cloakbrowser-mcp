// Read-only profile lock scan for doctor --static. It reports descriptors;
// it never opens, writes or changes a lock.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_NAMES = new Set(['lockfile', 'parent.lock', '.parentlock', 'SingletonLock', 'SingletonCookie']);

export async function scanLocksForDoctor(dataRoot) {
  const found = [];
  const profiles = join(dataRoot, 'profiles');
  async function walk(current, prefix, depth) {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, relative, depth + 1);
      else if (entry.isFile() && LOCK_NAMES.has(entry.name)) found.push(relative);
    }
  }
  try {
    const info = await stat(profiles).catch(() => null);
    if (info?.isDirectory()) await walk(profiles, '', 0);
    return [
      {
        name: 'profile-lock',
        status: found.length > 0 ? 'warning' : 'ok',
        message: found.length
          ? `Found ${found.length} lock descriptor(s), read-only and not changed: ${found.join(', ')}.`
          : 'No profile lock descriptors found (read-only scan).',
        details: { locks: found },
      },
    ];
  } catch (error) {
    return [
      { name: 'profile-lock', status: 'warning', message: `Lock scan failed: ${error.message}`, details: {} },
    ];
  }
}
