// Engine bundle, shim materialisation and current.json/manifest ownership.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SabmError } from './envelope.mjs';
import { atomicWriteText } from './writers.mjs';

export const CLI_VERSION = '1.1.0';
export const CURRENT_SCHEMA = 'sabm-current/1';
export const MANIFEST_SCHEMA = 'sabm-manifest/1';
export const INSTALLER_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_FROM = resolve(INSTALLER_ROOT, '..', 'plugins', 'cloakbrowser');
const SHIM_SOURCES = ['run.mjs', 'shim-runtime.mjs', 'envelope.mjs', 'vendor'];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function loadBundle(options = {}, context = {}) {
  const from = options.from ? resolve(context.cwd ?? process.cwd(), options.from) : null;
  if (from) {
    const manifest = JSON.parse(await readFile(join(from, '.claude-plugin', 'plugin.json'), 'utf8'));
    return {
      from,
      pluginVersion: manifest.version,
      cliVersion: CLI_VERSION,
      engineDir: from,
      files: null,
      bundled: false,
    };
  }
  const bundlePath = join(INSTALLER_ROOT, 'dist', 'bundle.json');
  let bundle;
  try {
    bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
  } catch (error) {
    throw new SabmError(
      'refused',
      'bundle-missing',
      `No bundled engine tree at ${bundlePath}: ${error?.code ?? 'invalid bundle.json'}.`,
      'Run `npm --prefix installer run build`, or pass --from <plugin tree>.',
    );
  }
  if (bundle.cliVersion !== CLI_VERSION || !bundle.pluginVersion || !bundle.files) {
    throw new SabmError(
      'verification_failed',
      'invalid-bundle',
      'The bundled engine manifest is incomplete.',
      'Rebuild the installer package.',
    );
  }
  return {
    from: bundlePath,
    pluginVersion: bundle.pluginVersion,
    cliVersion: bundle.cliVersion,
    engineDir: join(INSTALLER_ROOT, 'dist', 'engine', bundle.pluginVersion),
    files: bundle.files,
    bundled: true,
  };
}

export async function verifyEngineTree(engineDir, files, log = () => {}) {
  if (!files) return { ok: false, checked: 0, problems: ['no bundle hashes (--from tree)'], total: 0 };
  const problems = [];
  let checked = 0;
  for (const [relative, expected] of Object.entries(files)) {
    let bytes;
    try {
      bytes = await readFile(join(engineDir, relative));
    } catch (error) {
      problems.push(`${relative}: missing (${error?.code ?? 'read failed'})`);
      continue;
    }
    checked += 1;
    const actual = sha256(bytes);
    if (actual !== expected) problems.push(`${relative}: hash mismatch`);
  }
  if (problems.length > 0) log(`engine tree verification: ${problems.length} problem(s)`);
  return { ok: problems.length === 0, checked, total: Object.keys(files).length, problems };
}

export async function materialise({ dataRoot, bundle, hooks = {} }) {
  const target = join(resolve(dataRoot), 'engine', bundle.pluginVersion);
  await mkdir(target, { recursive: true });
  await cp(bundle.engineDir, target, { recursive: true, force: true, errorOnExist: false });
  const binDir = join(resolve(dataRoot), 'bin');
  await mkdir(binDir, { recursive: true });
  const distBin = join(INSTALLER_ROOT, 'dist', 'bin');
  for (const name of SHIM_SOURCES) {
    const source = join(distBin, name);
    const destination = join(binDir, name);
    try {
      await cp(source, destination, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const fallback = {
        'run.mjs': join(INSTALLER_ROOT, 'src', 'bin', 'run.mjs'),
        'shim-runtime.mjs': join(INSTALLER_ROOT, 'src', 'shim-runtime.mjs'),
        'envelope.mjs': join(INSTALLER_ROOT, 'src', 'envelope.mjs'),
        vendor: join(INSTALLER_ROOT, 'vendor'),
      };
      await cp(fallback[name] ?? join(INSTALLER_ROOT, 'src', name), destination, {
        recursive: true,
        force: true,
      });
    }
  }
  const verification = await verifyEngineTree(target, bundle.files);
  const current = {
    schema: CURRENT_SCHEMA,
    cliVersion: CLI_VERSION,
    pluginVersion: bundle.pluginVersion,
    sha256: hashTree(bundle.files ?? {}),
  };
  const write = await atomicWriteText(
    join(dataRoot, 'current.json'),
    null,
    `${JSON.stringify(current, null, 2)}\n`,
    {
      backupRoot: dataRoot,
      hooks,
      action: 'create',
      label: 'current.json',
      validate: (text) => {
        const parsed = JSON.parse(text);
        if (
          parsed.schema !== CURRENT_SCHEMA ||
          !parsed.cliVersion ||
          !parsed.pluginVersion ||
          !parsed.sha256
        ) {
          throw new Error('current.json must carry schema, cliVersion, pluginVersion and sha256');
        }
        if ('version' in parsed) throw new Error('current.json must not carry an ambiguous version field');
        return true;
      },
    },
  );
  return { path: target, current, write, verification };
}

function hashTree(files) {
  const sorted = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  return sha256(sorted.map(([path, hash]) => `${path}  ${hash}`).join('\n'));
}

export async function readCurrent(dataRoot) {
  try {
    const parsed = JSON.parse(await readFile(join(resolve(dataRoot), 'current.json'), 'utf8'));
    if (parsed.schema !== CURRENT_SCHEMA || !parsed.pluginVersion || !parsed.sha256) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeManifest(dataRoot, entries, engines, hooks = {}) {
  const path = join(resolve(dataRoot), 'manifest.json');
  let text = null;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const manifest = {
    schema: MANIFEST_SCHEMA,
    cliVersion: CLI_VERSION,
    entries: [...new Set(entries)].sort(),
    engines: [...new Set(engines)].sort(),
  };
  const write = await atomicWriteText(path, text, `${JSON.stringify(manifest, null, 2)}\n`, {
    backupRoot: dataRoot,
    hooks,
    action: text === null ? 'create' : 'modify',
    label: 'manifest.json',
    validate: (candidate) => {
      const parsed = JSON.parse(candidate);
      if (parsed.schema !== MANIFEST_SCHEMA) throw new Error('bad manifest schema');
      return true;
    },
  });
  return { manifest, write };
}

export async function readManifest(dataRoot) {
  try {
    return JSON.parse(await readFile(join(resolve(dataRoot), 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

export async function pruneEngines(dataRoot, keep) {
  const root = join(resolve(dataRoot), 'engine');
  let entries = [];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  entries.sort().reverse();
  const removed = [];
  for (const name of entries.slice(Math.max(0, keep))) {
    await rm(join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export async function shimFilesPresent(dataRoot) {
  const bin = join(resolve(dataRoot), 'bin');
  const results = {};
  for (const name of SHIM_SOURCES) {
    try {
      await stat(join(bin, name));
      results[name] = true;
    } catch {
      results[name] = false;
    }
  }
  return results;
}
