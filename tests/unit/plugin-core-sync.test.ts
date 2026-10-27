import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface CheckResult {
  ok: boolean;
  plugins: string[];
  checked: number;
  errors: string[];
}

interface WriteResult {
  ok: boolean;
  written: string[];
  removed: string[];
  errors: string[];
}

interface SyncModule {
  CORE_FILES: readonly string[];
  CORE_ROOT: string;
  PLUGINS_ROOT: string;
  checkPluginCore(root: string): CheckResult;
  writePluginCore(root: string): WriteResult;
}

const sync = (await import(
  new URL('../../scripts/sync-plugin-core.mjs', import.meta.url).href
)) as unknown as SyncModule;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginsRoot = path.join(repoRoot, 'plugins');
const coreRoot = path.join(repoRoot, 'shared', 'core');

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'plugin-core-sync-'));
  tempRoots.push(root);
  cpSync(path.join(repoRoot, 'shared'), path.join(root, 'shared'), { recursive: true });
  cpSync(pluginsRoot, path.join(root, 'plugins'), { recursive: true });
  return root;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function pluginNames(): string[] {
  return readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function corePlugins(): string[] {
  return pluginNames().filter((name) =>
    existsSync(path.join(pluginsRoot, name, 'plugin-config.json'))
      ? readJson<{ core?: boolean }>(path.join(pluginsRoot, name, 'plugin-config.json')).core === true
      : false,
  );
}

function engineManifestNames(plugin: string): string[] {
  return readdirSync(path.join(pluginsRoot, plugin, 'engines'))
    .filter((file) => file.endsWith('.json') && file !== 'profiles.json')
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

describe('shared plugin core', () => {
  it('lists the canonical files explicitly and every one exists', () => {
    expect(sync.CORE_FILES).toEqual([
      'broker.mjs',
      'camoufox_bootstrap.py',
      'camoufox_entry.py',
      'contracts/playwright-canonical.json',
      'engine-registry.mjs',
      'engines/profiles.json',
      'lib/attach.mjs',
      'lib/camoufox-overlay.mjs',
      'lib/password-manager.mjs',
      'lib/ping-timeout.mjs',
      'lib/profile.mjs',
      'lib/provision.mjs',
      'lib/surface.mjs',
      'lib/tool-cache.mjs',
      'launch-camoufox-native.mjs',
      'launch-camoufox.mjs',
      'launch-kameleo.mjs',
      'launch.mjs',
      'scripts/profile-copy.mjs',
      'scripts/profile-default.mjs',
    ]);
    for (const relative of sync.CORE_FILES) {
      expect(existsSync(path.join(coreRoot, relative))).toBe(true);
    }
  });

  it('keeps every core file byte-identical across every core plugin', () => {
    const plugins = corePlugins();
    expect(plugins.length).toBeGreaterThanOrEqual(2);
    for (const relative of sync.CORE_FILES) {
      const canonical = readFileSync(path.join(coreRoot, relative));
      for (const plugin of plugins) {
        const copy = readFileSync(path.join(pluginsRoot, plugin, relative));
        expect(copy.equals(canonical)).toBe(true);
      }
    }
  });

  it('keeps the camoufox engine manifest identical in both plugins', () => {
    const universal = readFileSync(path.join(pluginsRoot, 'cloakbrowser', 'engines', 'camoufox.json'));
    const perEngine = readFileSync(path.join(pluginsRoot, 'camoufox', 'engines', 'camoufox.json'));
    expect(perEngine.equals(universal)).toBe(true);
  });

  it('declares exactly the engine manifests each plugin ships', () => {
    for (const plugin of pluginNames()) {
      const config = readJson<{ core: boolean; engines: string[] }>(
        path.join(pluginsRoot, plugin, 'plugin-config.json'),
      );
      expect(Array.isArray(config.engines)).toBe(true);
      expect([...config.engines].sort()).toEqual(engineManifestNames(plugin));
    }
    expect(engineManifestNames('camoufox')).toEqual(['camoufox']);
    expect(engineManifestNames('cloakbrowser')).toEqual([
      'camoufox',
      'camoufox-native',
      'cloak',
      'kameleo',
      'playwright',
    ]);
  });

  it('ships lockstep semver plugin versions', () => {
    const versions = pluginNames().map(
      (plugin) =>
        readJson<{ version: string }>(path.join(pluginsRoot, plugin, '.claude-plugin', 'plugin.json'))
          .version,
    );
    expect(versions.length).toBeGreaterThanOrEqual(2);
    for (const version of versions) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(new Set(versions).size).toBe(1);
  });

  it('has no Kameleo plugin directory', () => {
    expect(existsSync(path.join(pluginsRoot, 'kameleo'))).toBe(false);
  });

  it('wires the sync check into the static gate', () => {
    const packageJson = readJson<{ scripts: Record<string, string> }>(path.join(repoRoot, 'package.json'));
    expect(packageJson.scripts['plugins:core:check']).toBe('node scripts/sync-plugin-core.mjs --check');
    expect(packageJson.scripts['plugins:core:write']).toBe('node scripts/sync-plugin-core.mjs --write');
    expect(packageJson.scripts['check:static']).toContain('npm run plugins:core:check');
  });

  it('passes --check on the repository tree', () => {
    const result = sync.checkPluginCore(repoRoot);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.plugins).toEqual(['camoufox', 'cloakbrowser']);
    expect(result.checked).toBeGreaterThanOrEqual(sync.CORE_FILES.length * 2);
  });
});

describe('sync --check drift detection', () => {
  it('fails on a one-byte change in one copy and --write restores it', () => {
    const root = createTempRoot();
    expect(sync.checkPluginCore(root).ok).toBe(true);

    const target = path.join(root, 'plugins', 'camoufox', 'lib', 'surface.mjs');
    const original = readFileSync(target);
    const mutated = Buffer.from(original);
    mutated[0] = mutated[0] ^ 0x01;
    writeFileSync(target, mutated);

    const drift = sync.checkPluginCore(root);
    expect(drift.ok).toBe(false);
    expect(drift.errors.join('\n')).toContain('plugins/camoufox/lib/surface.mjs differs from');

    const repaired = sync.writePluginCore(root);
    expect(repaired.ok).toBe(true);
    expect(repaired.written).toContain('plugins/camoufox/lib/surface.mjs');
    expect(readFileSync(target).equals(original)).toBe(true);
    expect(sync.checkPluginCore(root).ok).toBe(true);
  });

  it('fails on a missing core file and --write restores it', () => {
    const root = createTempRoot();
    const target = path.join(root, 'plugins', 'camoufox', 'launch.mjs');
    rmSync(target);

    const missing = sync.checkPluginCore(root);
    expect(missing.ok).toBe(false);
    expect(missing.errors.join('\n')).toContain('plugins/camoufox/launch.mjs is missing');

    expect(sync.writePluginCore(root).ok).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(sync.checkPluginCore(root).ok).toBe(true);
  });

  it('rejects an undeclared engine manifest and --write removes it', () => {
    const root = createTempRoot();
    const extra = path.join(root, 'plugins', 'camoufox', 'engines', 'cloak.json');
    cpSync(path.join(root, 'plugins', 'cloakbrowser', 'engines', 'cloak.json'), extra);

    const drift = sync.checkPluginCore(root);
    expect(drift.ok).toBe(false);
    expect(drift.errors.join('\n')).toContain('plugins/camoufox/engines/cloak.json is not declared');

    const repaired = sync.writePluginCore(root);
    expect(repaired.ok).toBe(true);
    expect(repaired.removed).toContain('plugins/camoufox/engines/cloak.json');
    expect(existsSync(extra)).toBe(false);
    expect(sync.checkPluginCore(root).ok).toBe(true);
  });

  it('rejects an unknown engine id and a core:false plugin that declares engines', () => {
    const root = createTempRoot();
    const configPath = path.join(root, 'plugins', 'camoufox', 'plugin-config.json');
    writeFileSync(configPath, `${JSON.stringify({ core: true, engines: ['nope'] }, null, 2)}\n`);

    const unknown = sync.checkPluginCore(root);
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.join('\n')).toContain(
      'names engine "nope" but plugins/cloakbrowser/engines/nope.json',
    );

    writeFileSync(configPath, `${JSON.stringify({ core: false, engines: ['camoufox'] }, null, 2)}\n`);
    const invalid = sync.checkPluginCore(root);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join('\n')).toContain('declares engines but not "core": true');

    const refused = sync.writePluginCore(root);
    expect(refused.ok).toBe(false);
    expect(refused.written).toEqual([]);
  });
});
