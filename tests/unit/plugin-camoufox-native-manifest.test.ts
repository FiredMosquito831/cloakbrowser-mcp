import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface AliasEntry {
  canonical: string;
  native?: string;
  support: string;
  dispatch?: Record<string, string>;
  [key: string]: unknown;
}

interface NativeManifest {
  schemaVersion: number;
  id: string;
  label: string;
  transport: string;
  contract: string;
  defaultToolProfile: string;
  launch?: { launcher?: string };
  contractSchemas: string;
  nativePrefix: string;
  profileArgument: { name: string; env?: string; setting?: string; default?: string; except?: string[] };
  requirements?: string[];
  ignoredSettings?: string[];
  toolAliases: AliasEntry[];
  toolSupport: Record<string, string>;
  toolSupportNotes?: Record<string, string>;
  capabilities?: { groupSwitchesApply?: boolean };
  notes: string;
  [key: string]: unknown;
}

interface ProfilesDocument {
  schemaVersion: number;
  profiles: { full: { kind: string }; portable: { kind: string; tools: string[] } };
}

interface RegistryModule {
  availableProfileNames(profiles: ProfilesDocument): string[];
  manifestSupport(manifest: NativeManifest, toolName: string): string;
  resolveLauncherName(manifest: NativeManifest | null): string;
  validateLauncherName(value: unknown): string | null;
  validateManifest(
    manifest: unknown,
    expectedId: string,
    profileNames: string[],
    launcherDir?: string,
  ): string | null;
}

interface PluginDocument {
  version: string;
  userConfig: Record<string, { type?: string; default?: unknown; description?: string; options?: string[] }>;
}

interface McpDocument {
  cloakbrowser: { env: Record<string, string> };
}

const registry = (await import(
  new URL('../../plugins/cloakbrowser/engine-registry.mjs', import.meta.url).href
)) as unknown as RegistryModule;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginRoot = path.join(repoRoot, 'plugins', 'cloakbrowser');
const enginesDir = path.join(pluginRoot, 'engines');
const manifestPath = path.join(enginesDir, 'camoufox-native.json');
const profilesPath = path.join(enginesDir, 'profiles.json');
const pluginManifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
const mcpConfigPath = path.join(pluginRoot, '.mcp.json');
const launcherPath = path.join(pluginRoot, 'launch-camoufox-native.mjs');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as NativeManifest;
const profiles = JSON.parse(readFileSync(profilesPath, 'utf8')) as ProfilesDocument;
const plugin = JSON.parse(readFileSync(pluginManifestPath, 'utf8')) as PluginDocument;
const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8')) as McpDocument;
const launcher = readFileSync(launcherPath, 'utf8');
const profileNames = registry.availableProfileNames(profiles);

const IGNORED_SETTINGS = [
  'humanize',
  'human_preset',
  'release_channel',
  'geoip_proxy_match',
  'profile_dir',
  'proxy_server',
  'proxy_bypass',
  'licence_key',
  'engine_version',
  'output_dir',
  'allow_unrestricted_file_access',
];

const NATIVE_ONLY = [
  'get_element',
  'get_html',
  'get_network_request',
  'scroll',
  'upload_file',
  'wait_for',
  'click_at',
  'reload',
  'list_sessions',
];

const ABSENT_CANONICAL = [
  'browser_cookie_clear',
  'browser_cookie_delete',
  'browser_cookie_get',
  'browser_cookie_list',
  'browser_cookie_set',
  'browser_drag',
  'browser_file_upload',
  'browser_hover',
  'browser_network_request',
  'browser_wait_for',
];

function mutated(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...manifest, ...overrides };
}

describe('camoufox-native manifest', () => {
  it('declares the native identity, launcher and portable default', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.id).toBe('camoufox-native');
    expect(manifest.label.trim()).not.toBe('');
    expect(manifest.transport).toBe('launch');
    expect(manifest.contract).toBe('native-mcp');
    expect(manifest.defaultToolProfile).toBe('portable');
    expect(registry.resolveLauncherName(manifest)).toBe('launch-camoufox-native.mjs');
    expect(registry.validateLauncherName('launch-camoufox-native.mjs')).toBeNull();
    expect(existsSync(launcherPath)).toBe(true);
    expect(existsSync(path.join(pluginRoot, manifest.contractSchemas))).toBe(true);
    expect(manifest.nativePrefix).toBe('camoufox_native_');
  });

  it('passes the shared manifest validation, including the real launcher and schemas', () => {
    expect(registry.validateManifest(manifest, 'camoufox-native', profileNames, pluginRoot)).toBeNull();
  });

  it('aliases 16 canonical tools from 18 natives and leaves 9 native-only tools', () => {
    expect(manifest.toolAliases).toHaveLength(16);
    const aliased = new Set<string>();
    const canonical = new Set<string>();
    for (const alias of manifest.toolAliases) {
      expect(canonical.has(alias.canonical)).toBe(false);
      canonical.add(alias.canonical);
      expect(alias.canonical).toMatch(/^browser_/);
      expect(['full', 'partial', 'none', 'unknown']).toContain(alias.support);
      if (typeof alias.native === 'string') {
        aliased.add(alias.native);
      }
      for (const native of Object.values(alias.dispatch ?? {})) {
        aliased.add(native);
      }
    }
    expect(canonical.size).toBe(16);
    expect(aliased.size).toBe(18);
    for (const native of NATIVE_ONLY) {
      expect(aliased.has(native)).toBe(false);
      expect(manifest.toolSupport[native]).toBe('full');
    }
    expect([...aliased, ...NATIVE_ONLY]).toHaveLength(27);
  });

  it('marks the 10 absent portable tools none with a reason each', () => {
    expect(Object.keys(manifest.toolSupport).sort()).toEqual([...NATIVE_ONLY, ...ABSENT_CANONICAL].sort());
    for (const toolName of ABSENT_CANONICAL) {
      expect(registry.manifestSupport(manifest, toolName)).toBe('none');
      expect(manifest.toolSupportNotes?.[toolName]?.trim()).not.toBe('');
    }
  });

  it('injects one profile into every native call except list_sessions', () => {
    expect(manifest.profileArgument.name).toBe('profile');
    expect(manifest.profileArgument.env).toBe('CAMOUFOX_PROFILE');
    expect(manifest.profileArgument.setting).toBe('camoufox_profile');
    expect(manifest.profileArgument.default).toBe('default');
    expect(manifest.profileArgument.except).toEqual(['list_sessions']);
    expect(manifest.profileArgument.except).not.toContain('navigate');
  });

  it('declares the auto-provisioned dependencies, the fallback and the licence', () => {
    const requirements = (manifest.requirements ?? []).join(' ');
    expect(requirements).toContain('uv (pinned 0.13.5)');
    expect(requirements).toContain('Plugin-managed CPython 3.13.17');
    expect(requirements).toContain('mcp-camoufox==0.4.5');
    expect(requirements).toContain('uv tool install mcp-camoufox==0.4.5');
    expect(requirements).toContain('FSL-1.1-MIT');
    expect(requirements).toContain('156.0.1-beta.39');
    expect(requirements).toContain('never bundles or redistributes');
    expect(requirements).toContain('CAMOUFOX_NATIVE_COMMAND');
  });

  it('names the settings the native engine cannot honour', () => {
    expect(manifest.ignoredSettings).toEqual(IGNORED_SETTINGS);
    expect(manifest.capabilities?.groupSwitchesApply).toBe(false);
  });

  it('pins the package, build, profile and daemon in .mcp.json', () => {
    const env = mcpConfig.cloakbrowser.env;
    expect(env.CAMOUFOX_NATIVE_PACKAGE).toBe('mcp-camoufox==0.4.5');
    expect(env.CAMOUFOX_NATIVE_BROWSER_BUILD).toBe('156.0.1-beta.39');
    expect(env.CAMOUFOX_PROFILE).toBe('${user_config.camoufox_profile}');
    expect(env.CAMOUFOX_DATA_DIR).toBe('${user_config.camoufox_data_dir}');
    expect(env.CAMOUFOX_DAEMON).toBe('false');
    expect(manifest.requirements?.join(' ')).toContain(env.CAMOUFOX_NATIVE_PACKAGE);
  });

  it('ships the two new settings and the generated engine option', () => {
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(plugin.userConfig.camoufox_profile).toMatchObject({ type: 'string', default: 'default' });
    expect(plugin.userConfig.camoufox_data_dir).toMatchObject({ type: 'string', default: '' });
    expect(plugin.userConfig.browser_engine.options).toEqual([
      'camoufox-native',
      'camoufox',
      'cloak',
      'kameleo',
      'playwright',
    ]);
    expect(plugin.userConfig.browser_engine.description).toContain('camoufox-native');
  });

  it('provisions the package itself and pins the daemon off in the launcher', () => {
    expect(launcher).toContain('ensureUv');
    expect(launcher).toContain('ensurePython');
    expect(launcher).toContain('ensureVenv');
    expect(launcher).toContain("const VENV_NAME = 'camoufox-native'");
    expect(launcher).toContain('CAMOUFOX_NATIVE_COMMAND');
    expect(launcher).toContain("env.CAMOUFOX_DAEMON = 'false'");
    expect(launcher).toContain('mcp-camoufox.exe');
    expect(launcher).not.toContain('CamoufoxFetcher');
    expect(launcher).not.toContain('spawnSync');
    expect(launcher).toContain('PROFILE_PATTERN');
  });
});

describe('native manifest validation mutations', () => {
  it('rejects a duplicate canonical name', () => {
    const duplicate = {
      ...manifest,
      toolAliases: [
        ...manifest.toolAliases,
        { canonical: 'browser_navigate', native: 'reload', support: 'full' },
      ],
    };
    expect(registry.validateManifest(duplicate, 'camoufox-native', profileNames)).toContain('more than once');
  });

  it('rejects a native tool that is both aliased and native-only', () => {
    const both = mutated({ toolSupport: { ...manifest.toolSupport, navigate: 'full' } });
    expect(registry.validateManifest(both, 'camoufox-native', profileNames)).toContain('aliased native tool');
  });

  it('rejects a missing contractSchemas file', () => {
    const missing = mutated({ contractSchemas: 'contracts/missing.json' });
    expect(registry.validateManifest(missing, 'camoufox-native', profileNames, pluginRoot)).toContain(
      'does not exist',
    );
  });

  it('rejects an unknown transform', () => {
    const unknown = {
      ...manifest,
      toolAliases: [{ canonical: 'browser_click', native: 'click', support: 'full', transform: 'magic' }],
    };
    expect(registry.validateManifest(unknown, 'camoufox-native', profileNames)).toContain('not one of');
  });

  it('rejects a canonical-looking native prefix', () => {
    const badPrefix = mutated({ nativePrefix: 'browser_native_' });
    expect(registry.validateManifest(badPrefix, 'camoufox-native', profileNames)).toContain(
      'must not start with "browser_"',
    );
  });

  it('rejects a none entry without a reason', () => {
    const missingNote = mutated({ toolSupportNotes: { browser_hover: '' } });
    expect(registry.validateManifest(missingNote, 'camoufox-native', profileNames)).toContain(
      'must be a non-empty string',
    );
    const absentNote = {
      ...manifest,
      toolSupportNotes: Object.fromEntries(
        Object.entries(manifest.toolSupportNotes ?? {}).filter(([name]) => name !== 'browser_drag'),
      ),
    };
    expect(registry.validateManifest(absentNote, 'camoufox-native', profileNames)).toContain(
      'no toolSupportNotes reason',
    );
  });
});
