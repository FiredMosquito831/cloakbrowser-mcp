import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

interface Manifest {
  schemaVersion: number;
  id: string;
  label: string;
  transport: string;
  contract: string;
  defaultToolProfile: string;
  launch?: { launcher?: string };
  requirements?: string[];
  requiredEnv?: { env: string; reason: string }[];
  runtime?: {
    defaultEndpoint?: string;
    endpointEnv?: string;
    errorHint?: string;
    profileEnv?: string;
    statusKeys?: { endpoint?: string; profileId?: string };
  };
  capabilities?: { groupSwitchesApply?: boolean; cdpAttach?: boolean };
  ignoredSettings?: string[];
  toolSupport: Record<string, string>;
  toolSupportNotes?: Record<string, string>;
  notes: string;
}

interface ProfilesDocument {
  schemaVersion: number;
  profiles: {
    full: { kind: string };
    portable: { kind: string; tools: string[] };
  };
}

interface ScanEntry {
  id: string;
  file: string;
  manifest: Manifest | null;
  error: string | null;
}

interface ScanResult {
  entries: ScanEntry[];
  ids: string[];
  warnings: string[];
}

interface EngineConfiguration {
  engine: Manifest | null;
  profiles: ProfilesDocument | null;
  engineIds: string[];
  warnings: string[];
  error: string | null;
}

interface ProfileSelection {
  profile: string | null;
  source: string;
  requested: string | null;
  ignored: string | null;
  placeholder: string | null;
}

interface ProfilesLoadResult {
  profiles: ProfilesDocument | null;
  error: string | null;
}

interface RegistryModule {
  availableProfileNames(profiles: ProfilesDocument): string[];
  engineChangeHelp(engineIds: string[]): string;
  findPortableGaps(manifest: Manifest, profiles: ProfilesDocument): string[];
  firstMissingRequiredEnv(manifest: Manifest | null, env: Record<string, string | undefined>): string | null;
  loadEngineConfiguration(options: {
    enginesDir: string;
    profilesFile: string;
    engineId: string;
  }): EngineConfiguration;
  loadProfiles(profilesFile: string): ProfilesLoadResult;
  manifestSupport(manifest: Manifest, toolName: string): string;
  portableToolNames(profiles: ProfilesDocument): string[];
  profileAllows(
    profileName: string | null,
    profiles: ProfilesDocument | null,
    toolName: string,
    support: string,
  ): boolean;
  resolveToolProfile(
    rawValue: string | undefined,
    engine: Manifest | null,
    profiles: ProfilesDocument | null,
  ): ProfileSelection;
  resolveLauncherName(manifest: Manifest | null): string;
  validateLauncherName(value: unknown): string | null;
  scanEngines(enginesDir: string, profileNames: string[], launcherDir?: string): ScanResult;
  validateManifest(
    manifest: unknown,
    expectedId: string,
    profileNames: string[],
    launcherDir?: string,
  ): string | null;
  validateProfiles(document: unknown): string | null;
}

const registry = (await import(
  new URL('../../plugins/cloakbrowser/engine-registry.mjs', import.meta.url).href
)) as unknown as RegistryModule;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginRoot = path.join(repoRoot, 'plugins', 'cloakbrowser');
const enginesDir = path.join(pluginRoot, 'engines');
const profilesFile = path.join(enginesDir, 'profiles.json');
const pluginManifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
const generatorScript = path.join(pluginRoot, 'scripts', 'generate-engine-options.mjs');

// The binding portable list: spec §2.3's 23 tools plus browser_close
// (USER DECISIONS 2026-10-24 13:38, item 1). Sorted for comparison.
const PORTABLE_TOOLS = [
  'browser_click',
  'browser_close',
  'browser_console_messages',
  'browser_cookie_clear',
  'browser_cookie_delete',
  'browser_cookie_get',
  'browser_cookie_list',
  'browser_cookie_set',
  'browser_drag',
  'browser_evaluate',
  'browser_file_upload',
  'browser_handle_dialog',
  'browser_hover',
  'browser_navigate',
  'browser_navigate_back',
  'browser_network_request',
  'browser_network_requests',
  'browser_press_key',
  'browser_select_option',
  'browser_snapshot',
  'browser_tabs',
  'browser_take_screenshot',
  'browser_type',
  'browser_wait_for',
];

const profiles = JSON.parse(readFileSync(profilesFile, 'utf8')) as ProfilesDocument;
const profileNames = registry.availableProfileNames(profiles);
const cloak = JSON.parse(readFileSync(path.join(enginesDir, 'cloak.json'), 'utf8')) as Manifest;
const playwright = JSON.parse(readFileSync(path.join(enginesDir, 'playwright.json'), 'utf8')) as Manifest;
const camoufox = JSON.parse(readFileSync(path.join(enginesDir, 'camoufox.json'), 'utf8')) as Manifest;
const camoufoxNative = JSON.parse(
  readFileSync(path.join(enginesDir, 'camoufox-native.json'), 'utf8'),
) as Manifest;
const kameleo = JSON.parse(readFileSync(path.join(enginesDir, 'kameleo.json'), 'utf8')) as Manifest;

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cloakbrowser-engine-registry-'));
  tempRoots.push(root);
  return root;
}

function createEngineFixture(files: Record<string, unknown>): {
  enginesDirectory: string;
  profilesPath: string;
} {
  const root = createTempRoot();
  const enginesDirectory = path.join(root, 'engines');
  mkdirSync(enginesDirectory, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    const body = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
    writeFileSync(path.join(enginesDirectory, fileName), body);
  }
  const profilesPath = path.join(enginesDirectory, 'profiles.json');
  if (!Object.hasOwn(files, 'profiles.json')) {
    writeFileSync(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`);
  }
  return { enginesDirectory, profilesPath };
}

function manifestWith(overrides: Partial<Manifest>): Manifest {
  return { ...cloak, ...overrides };
}

describe('shared profiles.json', () => {
  it('declares schemaVersion 1 with an all-supported full profile', () => {
    expect(profiles.schemaVersion).toBe(1);
    expect(profiles.profiles.full.kind).toBe('all-supported');
    expect(profiles.profiles.portable.kind).toBe('explicit');
  });

  it('ships exactly the binding 24-tool portable list', () => {
    expect(registry.portableToolNames(profiles)).toEqual(PORTABLE_TOOLS);
    expect(profiles.profiles.portable.tools).toHaveLength(24);
    expect(new Set(profiles.profiles.portable.tools).size).toBe(24);
    for (const toolName of profiles.profiles.portable.tools) {
      expect(toolName).toMatch(/^browser_/);
    }
  });

  it('loads the shipped file without error', () => {
    const loaded = registry.loadProfiles(profilesFile);
    expect(loaded.error).toBeNull();
    expect(loaded.profiles).not.toBeNull();
  });

  it.each([
    ['a non-object document', []],
    ['a future schemaVersion', { schemaVersion: 2, profiles: profiles.profiles }],
    [
      'an unknown profile',
      { schemaVersion: 1, profiles: { ...profiles.profiles, minimal: { kind: 'explicit', tools: [] } } },
    ],
    [
      'a wrong full kind',
      { schemaVersion: 1, profiles: { ...profiles.profiles, full: { kind: 'explicit' } } },
    ],
    [
      'portable without a tool array',
      { schemaVersion: 1, profiles: { ...profiles.profiles, portable: { kind: 'explicit' } } },
    ],
    [
      'a duplicate portable tool',
      {
        schemaVersion: 1,
        profiles: {
          ...profiles.profiles,
          portable: { kind: 'explicit', tools: ['browser_click', 'browser_click'] },
        },
      },
    ],
    [
      'an empty portable tool name',
      { schemaVersion: 1, profiles: { ...profiles.profiles, portable: { kind: 'explicit', tools: [''] } } },
    ],
  ])('rejects %s', (_label, document) => {
    expect(registry.validateProfiles(document)).not.toBeNull();
  });
});

describe('engine manifests', () => {
  it('discovers every shipped engine in deterministic file-name order', () => {
    const scan = registry.scanEngines(enginesDir, profileNames);
    expect(scan.ids).toEqual(['camoufox-native', 'camoufox', 'cloak', 'kameleo', 'playwright']);
    expect(scan.warnings).toEqual([]);
    expect(scan.entries.map((entry) => entry.id)).toEqual([
      'camoufox-native',
      'camoufox',
      'cloak',
      'kameleo',
      'playwright',
    ]);
  });

  it.each([cloak, playwright, camoufox, camoufoxNative, kameleo])(
    'validates $id and keeps its id equal to the file name',
    (manifest) => {
      expect(registry.validateManifest(manifest, manifest.id, profileNames)).toBeNull();
    },
  );

  it('keeps full as the default profile for both Chromium engines', () => {
    expect(cloak.defaultToolProfile).toBe('full');
    expect(playwright.defaultToolProfile).toBe('full');
  });

  it('keeps portable as the default profile for the Camoufox and Kameleo engines', () => {
    expect(camoufox.defaultToolProfile).toBe('portable');
    expect(camoufoxNative.defaultToolProfile).toBe('portable');
    expect(kameleo.defaultToolProfile).toBe('portable');
  });

  it.each([cloak, playwright, camoufox, camoufoxNative, kameleo])(
    'uses only allowed support values ($id)',
    (manifest) => {
      const allowed = new Set(['full', 'partial', 'none', 'unknown']);
      for (const support of Object.values(manifest.toolSupport)) {
        expect(allowed.has(support)).toBe(true);
      }
      for (const note of Object.values(manifest.toolSupportNotes ?? {})) {
        expect(note.trim()).not.toBe('');
      }
      expect(manifest.notes).toBeTypeOf('string');
    },
  );

  it.each([cloak, playwright, camoufox, kameleo])('exposes every portable tool ($id)', (manifest) => {
    expect(registry.findPortableGaps(manifest, profiles)).toEqual([]);
    for (const toolName of PORTABLE_TOOLS) {
      expect(registry.manifestSupport(manifest, toolName)).not.toBe('none');
    }
  });

  it('reports the native engine portable gaps as none instead of hiding them', () => {
    expect(registry.findPortableGaps(camoufoxNative, profiles)).toEqual([
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
    ]);
    for (const toolName of registry.findPortableGaps(camoufoxNative, profiles)) {
      expect(camoufoxNative.toolSupportNotes?.[toolName]?.trim()).not.toBe('');
    }
  });

  it('falls back to the "*" rule and then to unknown', () => {
    expect(registry.manifestSupport(cloak, 'browser_anything')).toBe('full');
    expect(registry.manifestSupport(manifestWith({ toolSupport: {} }), 'browser_anything')).toBe('unknown');
    expect(
      registry.manifestSupport(
        manifestWith({ toolSupport: { '*': 'full', browser_click: 'none' } }),
        'browser_click',
      ),
    ).toBe('none');
  });

  it('detects a portable entry a manifest marks none', () => {
    const gapped = manifestWith({ toolSupport: { '*': 'full', browser_click: 'none' } });
    expect(registry.findPortableGaps(gapped, profiles)).toEqual(['browser_click']);
  });
});

describe('manifest discovery and rejection', () => {
  it('lists engines sorted by file name and ignores the shared profiles file', () => {
    const { enginesDirectory, profilesPath } = createEngineFixture({
      'zeta.json': manifestWith({ id: 'zeta' }),
      'alpha.json': manifestWith({ id: 'alpha' }),
      'profiles.json': profiles,
    });
    const scan = registry.scanEngines(enginesDirectory, profileNames);
    expect(scan.ids).toEqual(['alpha', 'zeta']);
    expect(scan.entries.map((entry) => entry.id)).toEqual(['alpha', 'zeta']);
    expect(scan.warnings).toEqual([]);
    const configuration = registry.loadEngineConfiguration({
      enginesDir: enginesDirectory,
      profilesFile: profilesPath,
      engineId: 'alpha',
    });
    expect(configuration.engine?.id).toBe('alpha');
    expect(configuration.engineIds).toEqual(['alpha', 'zeta']);
    expect(configuration.error).toBeNull();
  });

  it('names the discovered ids when the selected engine is unknown', () => {
    const { enginesDirectory, profilesPath } = createEngineFixture({
      'alpha.json': manifestWith({ id: 'alpha' }),
      'zeta.json': manifestWith({ id: 'zeta' }),
    });
    const configuration = registry.loadEngineConfiguration({
      enginesDir: enginesDirectory,
      profilesFile: profilesPath,
      engineId: 'nope',
    });
    expect(configuration.error).toBe('Unknown engine "nope". Supported engines: alpha, zeta.');
    expect(configuration.engineIds).toEqual(['alpha', 'zeta']);
  });

  it.each([
    ['an id mismatch', { id: 'other' }, 'does not match engine "alpha"'],
    ['a bad support value', { toolSupport: { '*': 'mostly' } }, 'unsupported value "mostly"'],
    ['a missing label', { label: '' }, 'label is missing'],
    ['an unknown transport', { transport: 'cdp' }, 'unsupported transport: cdp'],
    ['an unknown contract', { contract: 'native' }, 'unsupported contract: native'],
    ['a missing default profile', { defaultToolProfile: 'minimal' }, 'unsupported defaultToolProfile'],
    ['notes missing', { notes: undefined }, 'notes is missing'],
    ['an empty support note', { toolSupportNotes: { browser_click: '' } }, 'must be a non-empty string'],
  ])('rejects %s', (_label, overrides, expected) => {
    const manifest = { ...manifestWith({ id: 'alpha' }), ...overrides } as unknown;
    const error = registry.validateManifest(manifest, 'alpha', profileNames);
    expect(error).toContain(expected);
  });

  it('reports an unreadable manifest and excludes it from the ids', () => {
    const { enginesDirectory, profilesPath } = createEngineFixture({
      'alpha.json': manifestWith({ id: 'alpha' }),
      'broken.json': '{',
    });
    const scan = registry.scanEngines(enginesDirectory, profileNames);
    expect(scan.ids).toEqual(['alpha']);
    expect(scan.warnings.join('\n')).toContain('Cannot read');
    expect(scan.warnings.join('\n')).toContain('broken.json');
    const configuration = registry.loadEngineConfiguration({
      enginesDir: enginesDirectory,
      profilesFile: profilesPath,
      engineId: 'alpha',
    });
    expect(configuration.engine?.id).toBe('alpha');
    expect(configuration.warnings.length).toBe(1);
  });

  it('reports a selected manifest that fails validation', () => {
    const { enginesDirectory, profilesPath } = createEngineFixture({
      'alpha.json': manifestWith({ id: 'other' }),
    });
    const configuration = registry.loadEngineConfiguration({
      enginesDir: enginesDirectory,
      profilesFile: profilesPath,
      engineId: 'alpha',
    });
    expect(configuration.engine).toBeNull();
    expect(configuration.error).toContain('Invalid engine manifest');
    expect(configuration.error).toContain('does not match engine "alpha"');
  });

  it('rejects a malformed profiles file through the invalid-configuration path', () => {
    const { enginesDirectory, profilesPath } = createEngineFixture({
      'alpha.json': manifestWith({ id: 'alpha' }),
      'profiles.json': { schemaVersion: 2, profiles: profiles.profiles },
    });
    const configuration = registry.loadEngineConfiguration({
      enginesDir: enginesDirectory,
      profilesFile: profilesPath,
      engineId: 'alpha',
    });
    expect(configuration.engine).toBeNull();
    expect(configuration.error).toContain('Invalid tool profiles');
    expect(configuration.error).toContain('unsupported schemaVersion: 2');
  });

  it('rejects a missing profiles file', () => {
    const { enginesDirectory } = createEngineFixture({
      'alpha.json': manifestWith({ id: 'alpha' }),
    });
    const configuration = registry.loadEngineConfiguration({
      enginesDir: enginesDirectory,
      profilesFile: path.join(enginesDirectory, 'missing.json'),
      engineId: 'alpha',
    });
    expect(configuration.engine).toBeNull();
    expect(configuration.error).toContain('Cannot read');
  });
});

describe('manifest launcher, requirements and ignored settings', () => {
  it('defaults to launch.mjs when a manifest names no launcher', () => {
    expect(registry.resolveLauncherName(cloak)).toBe('launch.mjs');
    expect(registry.resolveLauncherName(playwright)).toBe('launch.mjs');
    expect(registry.resolveLauncherName(null)).toBe('launch.mjs');
    expect(registry.resolveLauncherName(manifestWith({ launch: {} }))).toBe('launch.mjs');
  });

  it('resolves the launcher the Camoufox manifest names', () => {
    expect(registry.resolveLauncherName(camoufox)).toBe('launch-camoufox.mjs');
  });

  it.each([
    ['a directory path', 'launch-camoufox.mjs/../launch.mjs'],
    ['a backslash path', 'sub\\launch.mjs'],
    ['a command', 'node launch.mjs'],
    ['a shell string', 'launch.mjs && calc'],
    ['a non-launcher file', 'broker.mjs'],
    ['an empty string', ''],
  ])('rejects %s as a launcher', (_label, value) => {
    expect(registry.validateLauncherName(value)).not.toBeNull();
  });

  it.each(['launch.mjs', 'launch-camoufox.mjs', 'launch-kameleo-cdp.mjs'])(
    'accepts %s as a launcher',
    (value) => {
      expect(registry.validateLauncherName(value)).toBeNull();
    },
  );

  it('rejects a launcher field with an unsupported key', () => {
    const manifest = { ...manifestWith({ id: 'alpha' }), launch: { launcher: 'launch.mjs', argv: [] } };
    const error = registry.validateManifest(manifest, 'alpha', profileNames);
    expect(error).toContain('unsupported field "argv"');
  });

  it('rejects a launcher that does not exist in the plugin root', () => {
    const missing = manifestWith({ id: 'alpha', launch: { launcher: 'launch-nothing.mjs' } });
    const error = registry.validateManifest(missing, 'alpha', profileNames, pluginRoot);
    expect(error).toContain('launcher "launch-nothing.mjs" does not exist');
  });

  it('accepts the shipped engines against the real plugin root', () => {
    for (const manifest of [cloak, playwright, camoufox, camoufoxNative, kameleo]) {
      expect(registry.validateManifest(manifest, manifest.id, profileNames, pluginRoot)).toBeNull();
    }
  });

  it('resolves the Kameleo launcher and keeps the attach facts in its manifest', () => {
    expect(registry.resolveLauncherName(kameleo)).toBe('launch-kameleo.mjs');
    expect(kameleo.transport).toBe('launch');
    expect(kameleo.contract).toBe('playwright-mcp');
    expect(kameleo.capabilities).toEqual({ groupSwitchesApply: true, cdpAttach: true });
  });

  it.each([
    ['requirements not an array', { requirements: 'Python 3.12+' }, 'requirements must be an array'],
    ['an empty requirement', { requirements: [''] }, 'requirements must contain only non-empty strings'],
    ['ignoredSettings not an array', { ignoredSettings: 'humanize' }, 'ignoredSettings must be an array'],
    [
      'an empty ignored setting',
      { ignoredSettings: [''] },
      'ignoredSettings must contain only non-empty strings',
    ],
  ])('rejects %s', (_label, overrides, expected) => {
    const manifest = { ...manifestWith({ id: 'alpha' }), ...overrides } as unknown;
    expect(registry.validateManifest(manifest, 'alpha', profileNames)).toContain(expected);
  });
});

describe('requiredEnv, runtime and capability facts', () => {
  it('reports the Kameleo profile requirement with the manifest sentence', () => {
    expect(kameleo.requiredEnv).toEqual([
      {
        env: 'KAMELEO_PROFILE_ID',
        reason:
          'The kameleo engine needs a profile ID. Set "Kameleo profile ID" (kameleo_profile_id) ' +
          'in the cloakbrowser plugin configuration and restart Claude Code.',
      },
    ]);
    expect(registry.firstMissingRequiredEnv(kameleo, {})).toContain('needs a profile ID');
    expect(registry.firstMissingRequiredEnv(kameleo, { KAMELEO_PROFILE_ID: '' })).toContain(
      'kameleo_profile_id',
    );
    expect(
      registry.firstMissingRequiredEnv(kameleo, {
        KAMELEO_PROFILE_ID: '${user_config.kameleo_profile_id}',
      }),
    ).toContain('needs a profile ID');
    expect(registry.firstMissingRequiredEnv(kameleo, { KAMELEO_PROFILE_ID: '   ' })).toContain(
      'needs a profile ID',
    );
    expect(registry.firstMissingRequiredEnv(kameleo, { KAMELEO_PROFILE_ID: 'abc123' })).toBeNull();
  });

  it('adds no requirement to an engine that declares none', () => {
    expect(registry.firstMissingRequiredEnv(cloak, {})).toBeNull();
    expect(registry.firstMissingRequiredEnv(camoufoxNative, {})).toBeNull();
    expect(registry.firstMissingRequiredEnv(null, {})).toBeNull();
  });

  it.each([
    ['requiredEnv not an array', { requiredEnv: 'KAMELEO_PROFILE_ID' }, 'requiredEnv must be an array'],
    ['a missing env name', { requiredEnv: [{ reason: 'x' }] }, 'requiredEnv[0].env is missing'],
    [
      'a missing reason',
      { requiredEnv: [{ env: 'KAMELEO_PROFILE_ID' }] },
      'requiredEnv[0].reason is missing',
    ],
    [
      'an unknown field',
      { requiredEnv: [{ env: 'A', reason: 'x', defaultValue: 'y' }] },
      'unsupported field "defaultValue"',
    ],
    [
      'a duplicate variable',
      {
        requiredEnv: [
          { env: 'A', reason: 'x' },
          { env: 'A', reason: 'y' },
        ],
      },
      'more than once',
    ],
  ])('rejects %s in requiredEnv', (_label, overrides, expected) => {
    const manifest = { ...manifestWith({ id: 'alpha' }), ...overrides } as unknown;
    expect(registry.validateManifest(manifest, 'alpha', profileNames)).toContain(expected);
  });

  it.each([
    [
      'a default endpoint without the placeholder',
      { defaultEndpoint: 'ws://127.0.0.1:5050', profileEnv: 'A' },
      'must contain the "{profileId}" placeholder',
    ],
    [
      'a default endpoint without a profileEnv',
      { defaultEndpoint: 'ws://127.0.0.1:5050/{profileId}' },
      'runtime.profileEnv is required',
    ],
    ['an unknown runtime field', { setting: 'x' }, 'unsupported field "setting"'],
    ['an unknown status key', { statusKeys: { endpoint: 'e', port: 'p' } }, 'unsupported field "port"'],
    [
      'an empty status key',
      { statusKeys: { endpoint: '' } },
      'runtime.statusKeys.endpoint must be a non-empty string',
    ],
  ])('rejects %s in runtime', (_label, runtime, expected) => {
    const manifest = { ...manifestWith({ id: 'alpha' }), runtime } as unknown;
    expect(registry.validateManifest(manifest, 'alpha', profileNames)).toContain(expected);
  });

  it('rejects an unknown or non-boolean capability fact', () => {
    const unknown = { ...manifestWith({ id: 'alpha' }), capabilities: { cdpAttach: true, ports: 2 } };
    expect(registry.validateManifest(unknown, 'alpha', profileNames)).toContain('unsupported field "ports"');
    const nonBoolean = { ...manifestWith({ id: 'alpha' }), capabilities: { cdpAttach: 'yes' } };
    expect(registry.validateManifest(nonBoolean, 'alpha', profileNames)).toContain(
      'capabilities.cdpAttach must be a boolean',
    );
    const valid = { ...manifestWith({ id: 'alpha' }), capabilities: { cdpAttach: true } };
    expect(registry.validateManifest(valid, 'alpha', profileNames)).toBeNull();
  });
});

describe('tool profile resolution', () => {
  it('uses the manifest default when nothing is set', () => {
    expect(registry.resolveToolProfile(undefined, cloak, profiles)).toEqual({
      profile: 'full',
      source: 'engine-default',
      requested: null,
      ignored: null,
      placeholder: null,
    });
  });

  it('treats "default" as no override', () => {
    expect(registry.resolveToolProfile('default', cloak, profiles)).toEqual({
      profile: 'full',
      source: 'engine-default',
      requested: null,
      ignored: null,
      placeholder: null,
    });
  });

  it('honours an explicit portable or full choice', () => {
    expect(registry.resolveToolProfile('portable', cloak, profiles)).toMatchObject({
      profile: 'portable',
      source: 'user',
      requested: 'portable',
    });
    expect(registry.resolveToolProfile('full', cloak, profiles)).toMatchObject({
      profile: 'full',
      source: 'user',
      requested: 'full',
    });
  });

  it('follows a portable manifest default when the engine asks for it', () => {
    const portableDefault = manifestWith({ defaultToolProfile: 'portable' });
    expect(registry.resolveToolProfile(undefined, portableDefault, profiles)).toMatchObject({
      profile: 'portable',
      source: 'engine-default',
    });
  });

  it('ignores an unsubstituted placeholder and an unknown value', () => {
    expect(registry.resolveToolProfile('${user_config.tool_profile}', cloak, profiles)).toMatchObject({
      profile: 'full',
      source: 'engine-default',
      placeholder: '${user_config.tool_profile}',
    });
    expect(registry.resolveToolProfile('everything', cloak, profiles)).toMatchObject({
      profile: 'full',
      source: 'engine-default',
      ignored: 'everything',
    });
  });

  it('applies the profile before the support rule', () => {
    expect(registry.profileAllows('full', profiles, 'browser_pdf_save', 'full')).toBe(true);
    expect(registry.profileAllows('portable', profiles, 'browser_pdf_save', 'full')).toBe(false);
    expect(registry.profileAllows('portable', profiles, 'browser_click', 'full')).toBe(true);
    expect(registry.profileAllows('portable', profiles, 'browser_unknown', 'unknown')).toBe(false);
    expect(registry.profileAllows('full', profiles, 'browser_unknown', 'unknown')).toBe(true);
    expect(registry.profileAllows('portable', profiles, 'browser_click', 'none')).toBe(false);
    expect(registry.profileAllows('full', profiles, 'browser_click', 'none')).toBe(false);
  });
});

describe('generated browser_engine options', () => {
  it('match the discovered manifests', () => {
    const scan = registry.scanEngines(enginesDir, profileNames);
    const plugin = JSON.parse(readFileSync(pluginManifestPath, 'utf8')) as {
      userConfig: { browser_engine: { options: string[] } };
    };
    expect(plugin.userConfig.browser_engine.options).toEqual(scan.ids);
    expect(plugin.userConfig.browser_engine.options).toContain('cloak');
    expect(plugin.userConfig.browser_engine.options).toEqual([...scan.ids]);
  });

  it('pass the --check gate on the shipped tree', () => {
    const result = spawnSync(process.execPath, [generatorScript, '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('in sync');
  });

  it('fail --check when plugin.json is out of sync and --write repairs it', () => {
    const root = createTempRoot();
    const copy = path.join(root, 'cloakbrowser');
    cpSync(pluginRoot, copy, { recursive: true });
    const copiedManifest = path.join(copy, '.claude-plugin', 'plugin.json');
    const document = JSON.parse(readFileSync(copiedManifest, 'utf8')) as {
      userConfig: { browser_engine: { options: string[] } };
    };
    document.userConfig.browser_engine.options = ['cloak'];
    writeFileSync(copiedManifest, `${JSON.stringify(document, null, 2)}\n`);

    const script = path.join(copy, 'scripts', 'generate-engine-options.mjs');
    const check = spawnSync(process.execPath, [script, '--check'], { cwd: repoRoot, encoding: 'utf8' });
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('out of sync');

    const write = spawnSync(process.execPath, [script, '--write'], { cwd: repoRoot, encoding: 'utf8' });
    expect(write.status).toBe(0);
    expect(write.stdout).toContain('updated browser_engine.options');
    const repaired = JSON.parse(readFileSync(copiedManifest, 'utf8')) as {
      userConfig: { browser_engine: { options: string[] } };
    };
    expect(repaired.userConfig.browser_engine.options).toEqual([
      'camoufox-native',
      'camoufox',
      'cloak',
      'kameleo',
      'playwright',
    ]);

    const recheck = spawnSync(process.execPath, [script, '--check'], { cwd: repoRoot, encoding: 'utf8' });
    expect(recheck.status).toBe(0);
  });

  it('refuse to generate options from an invalid manifest', () => {
    const root = createTempRoot();
    const copy = path.join(root, 'cloakbrowser');
    cpSync(pluginRoot, copy, { recursive: true });
    const badManifest = path.join(copy, 'engines', 'cloak.json');
    const document = JSON.parse(readFileSync(badManifest, 'utf8')) as Manifest;
    document.toolSupport = { '*': 'mostly' };
    writeFileSync(badManifest, `${JSON.stringify(document, null, 2)}\n`);

    const script = path.join(copy, 'scripts', 'generate-engine-options.mjs');
    const result = spawnSync(process.execPath, [script, '--check'], { cwd: repoRoot, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to generate options');
    expect(result.stderr).toContain('unsupported value "mostly"');
  });

  it('keeps the 2.0.0 engine-change help text for the two shipped engines', () => {
    expect(registry.engineChangeHelp(['cloak', 'playwright'])).toBe(
      'Set the "Browser engine" (browser_engine) option in the cloakbrowser plugin configuration to ' +
        "'cloak' or 'playwright', then restart Claude Code. The engine is resolved when the MCP server starts; " +
        'it cannot be switched inside a running session.',
    );
  });
});
