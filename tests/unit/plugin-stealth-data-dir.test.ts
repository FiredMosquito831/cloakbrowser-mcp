import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// STEALTH_DATA_DIR (2.24.2). The plugin-manager path must stay byte-identical,
// so CLAUDE_PLUGIN_DATA wins whenever it is set; the alias only serves installs
// without a plugin manager. The same resolver is used by every JS site, and the
// Python entry and CLI scripts follow the same rule.

interface RootResolution {
  dir: string;
  source: 'env-alias' | 'plugin-data' | 'fallback';
  note: string | null;
}

interface SettingsModule {
  DATA_ROOT_SOURCES: Record<string, string>;
  resolveDataRoot(
    env: Record<string, string | undefined>,
    fallbackDir: string,
    log?: (message: string) => void,
  ): RootResolution;
}

interface ProfileDefaultModule {
  runProfileDefault(options: {
    engine?: string;
    set?: string | null;
    dataDir?: string | null;
    dryRun?: boolean;
    env: Record<string, string | undefined>;
    home: string;
    pluginRoot: string;
  }): { ok: boolean; summary?: { dataDir?: string } };
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const settings = (await import(
  new URL('../../plugins/cloakbrowser/lib/launcher-settings.mjs', import.meta.url).href
)) as unknown as SettingsModule;
const profileDefault = (await import(
  new URL('../../plugins/cloakbrowser/scripts/profile-default.mjs', import.meta.url).href
)) as unknown as ProfileDefaultModule;

const fallback = path.join(path.sep, 'opt', 'legacy-fallback');
const alias = path.join(path.sep, 'opt', 'stealth-alias');
const pluginData = path.join(path.sep, 'opt', 'plugin-data');

describe('resolveDataRoot', () => {
  it('keeps CLAUDE_PLUGIN_DATA when both variables are set and logs one line', () => {
    const log = vi.fn();
    expect(
      settings.resolveDataRoot({ CLAUDE_PLUGIN_DATA: pluginData, STEALTH_DATA_DIR: alias }, fallback, log),
    ).toEqual({
      dir: pluginData,
      source: 'plugin-data',
      note: expect.stringContaining('ignored because CLAUDE_PLUGIN_DATA is set'),
    });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('returns a Windows-shaped CLAUDE_PLUGIN_DATA string unchanged on any platform', () => {
    const windowsData = 'D:/scratch/plugin-data';
    const log = vi.fn();
    const resolution = settings.resolveDataRoot({ CLAUDE_PLUGIN_DATA: windowsData }, fallback, log);
    expect(resolution).toEqual({ dir: windowsData, source: 'plugin-data', note: null });
    expect(resolution.dir).toBe(windowsData);
    expect(path.join(resolution.dir, 'profiles', 'camoufox-native')).toBe(
      path.join(windowsData, 'profiles', 'camoufox-native'),
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('uses the alias only when no plugin manager data root exists', () => {
    const log = vi.fn();
    expect(settings.resolveDataRoot({ STEALTH_DATA_DIR: alias }, fallback, log)).toEqual({
      dir: path.resolve(alias),
      source: 'env-alias',
      note: null,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('reports the legacy fallback when neither variable is set', () => {
    const log = vi.fn();
    expect(settings.resolveDataRoot({}, fallback, log)).toEqual({
      dir: path.resolve(fallback),
      source: 'fallback',
      note: null,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['placeholder', '${user_config.data_dir}'],
    ['relative', 'relative/nonsense'],
    ['NUL', `${alias}\u0000`],
    ['newline', `${alias}\nother`],
  ])('ignores an unusable %s alias with exactly one line', (_label, value) => {
    const log = vi.fn();
    expect(settings.resolveDataRoot({ STEALTH_DATA_DIR: value }, fallback, log)).toEqual({
      dir: path.resolve(fallback),
      source: 'fallback',
      note: expect.any(String),
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('STEALTH_DATA_DIR');
  });

  it('normalises a usable alias with trim + resolve', () => {
    const resolution = settings.resolveDataRoot({ STEALTH_DATA_DIR: `  ${alias}  ` }, fallback);
    expect(resolution.dir).toBe(path.resolve(alias));
    expect(resolution.source).toBe('env-alias');
  });

  it('exposes the three reported source spellings', () => {
    expect(settings.DATA_ROOT_SOURCES).toEqual({
      ALIAS: 'env-alias',
      PLUGIN: 'plugin-data',
      FALLBACK: 'fallback',
    });
  });
});

describe('profile-default CLI data root', () => {
  const home = path.join(path.sep, 'opt', 'home');
  const call = (env: Record<string, string | undefined>, dataDir?: string) =>
    profileDefault.runProfileDefault({
      set: null,
      dataDir: dataDir ?? null,
      dryRun: true,
      env,
      home,
      pluginRoot: pluginDir,
    });

  it('uses the alias when only it is set, and CLAUDE_PLUGIN_DATA when both are', () => {
    expect(call({ STEALTH_DATA_DIR: alias }).summary?.dataDir).toBe(path.resolve(alias));
    expect(call({ CLAUDE_PLUGIN_DATA: pluginData, STEALTH_DATA_DIR: alias }).summary?.dataDir).toBe(
      pluginData,
    );
  });

  it('lets --data-dir beat every environment value', () => {
    const explicit = path.join(path.sep, 'opt', 'explicit');
    expect(call({ CLAUDE_PLUGIN_DATA: pluginData, STEALTH_DATA_DIR: alias }, explicit).summary?.dataDir).toBe(
      path.resolve(explicit),
    );
  });
});
