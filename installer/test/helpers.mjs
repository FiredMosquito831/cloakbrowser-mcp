import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.mjs';
import { resolveTarget } from '../src/harnesses.mjs';

export const INSTALLER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_FROM = resolve(INSTALLER_ROOT, '..', 'plugins', 'cloakbrowser');
export const FIXTURES = join(INSTALLER_ROOT, 'test', 'fixtures');
const SCRATCH = resolve(INSTALLER_ROOT, '..', '..', '.scratch', 'installer-phase0', 'nodetest');

await mkdir(SCRATCH, { recursive: true });

const CLEAN = {
  toml: 'codex-valid.toml',
  json: 'antigravity-valid.json',
  jsonc: 'opencode-valid.jsonc',
  json5: 'openclaw-valid.json5',
  yaml: 'hermes-valid.yaml',
};
const FOREIGN = {
  toml: 'codex-foreign.toml',
  json: 'antigravity-foreign.json',
  jsonc: 'opencode-foreign.jsonc',
  json5: 'openclaw-foreign.json5',
  yaml: 'hermes-foreign.yaml',
};
const UNPARSEABLE = {
  toml: 'unparseable.toml',
  json: 'unparseable.json',
  jsonc: 'unparseable.json',
  json5: 'unparseable.json',
  yaml: 'unparseable.yaml',
};

export async function fixtureFor(format, variant = 'clean') {
  let name = CLEAN[format];
  if (variant === 'foreign') name = FOREIGN[format];
  if (variant === 'unparseable') name = UNPARSEABLE[format];
  if (variant === 'inline') name = 'codex-inline.toml';
  if (variant === 'alias') name = 'hermes-alias.yaml';
  if (variant === 'duplicate') name = 'json-duplicate.json';
  if (variant === 'no-trailing') name = 'opencode-no-trailing.jsonc';
  if (!name) throw new Error(`no fixture for ${format}/${variant}`);
  return readFile(join(FIXTURES, name));
}

export async function makeTree(harness, scope, variant = 'clean') {
  const root = await mkdtemp(join(SCRATCH, `${harness}-${scope}-${variant}-`));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const dataRoot = join(root, 'data');
  const envRoot = join(root, 'env-data');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(join(dataRoot, 'profiles', 'default'), { recursive: true });
  await mkdir(envRoot, { recursive: true });
  await writeFile(join(dataRoot, 'profiles', 'default', 'marker'), 'phase0');
  const target = await resolveTarget(
    harness,
    { scope },
    { platform: 'linux', env: {}, homedir: home, cwd: project },
  );
  if (target.path) {
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, await fixtureFor(target.format, variant));
  }
  return { root, home, project, dataRoot, envRoot, target };
}

export function envForHome(tree, extra = {}) {
  const temp = process.env.TEMP ?? process.env.TMP ?? SCRATCH;
  return {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    TEMP: temp,
    TMP: temp,
    TMPDIR: SCRATCH,
    HOME: tree.home,
    USERPROFILE: tree.home,
    XDG_CONFIG_HOME: join(tree.home, '.config'),
    CODEX_HOME: join(tree.home, '.codex'),
    HERMES_HOME: join(tree.home, '.hermes'),
    OPENCLAW_HOME: join(tree.home, '.openclaw'),
    OPENCLAW_STATE_DIR: join(tree.home, '.openclaw', 'state'),
    OPENCLAW_CONFIG_PATH: join(tree.home, '.openclaw', 'openclaw.json'),
    STEALTH_DATA_DIR: tree.envRoot,
    ...extra,
  };
}

export async function invoke(argv, tree, options = {}) {
  const stdout = [];
  const stderr = [];
  const sink = (chunks) => ({
    write(text) {
      chunks.push(String(text));
      return true;
    },
  });
  const code = await main(argv, {
    stdout: sink(stdout),
    stderr: sink(stderr),
    env: envForHome(tree, options.env),
    platform: options.platform ?? 'linux',
    homedir: tree.home,
    cwd: tree.project,
  });
  const out = stdout.join('');
  return {
    code,
    out,
    err: stderr.join(''),
    jsonLines: out
      .split('\n')
      .filter((line) => line.startsWith('{"schema":"sabm/1"'))
      .map((line) => JSON.parse(line)),
  };
}

export async function snapshotTree(root) {
  const entries = [];
  async function walk(current, prefix) {
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    items.sort((left, right) => left.name.localeCompare(right.name));
    for (const item of items) {
      const relative = prefix ? join(prefix, item.name) : item.name;
      const full = join(current, item.name);
      if (item.isDirectory()) {
        entries.push(`d ${relative.replace(/\\/g, '/')}`);
        await walk(full, relative);
      } else if (item.isSymbolicLink()) {
        entries.push(`l ${relative.replace(/\\/g, '/')}`);
      } else {
        const bytes = await readFile(full);
        const digest = createHash('sha256').update(bytes).digest('hex');
        entries.push(`f ${relative.replace(/\\/g, '/')} ${digest}`);
      }
    }
  }
  await walk(root, '');
  return entries;
}
