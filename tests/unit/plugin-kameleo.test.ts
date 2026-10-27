import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
  systemDependencies?: {
    id?: string;
    label?: string;
    required?: boolean;
    downloadUrl?: string;
    installerName?: string;
    installHint?: string;
    licenceNote?: string;
  }[];
  ignoredSettings?: string[];
  toolSupport: Record<string, string>;
  toolSupportNotes?: Record<string, string>;
  notes: string;
}

interface ProfilesDocument {
  schemaVersion: number;
  profiles: { full: { kind: string }; portable: { kind: string; tools: string[] } };
}

interface PluginDocument {
  version: string;
  userConfig: Record<
    string,
    { type?: string; title?: string; default?: unknown; description?: string; options?: string[] }
  >;
}

interface McpDocument {
  cloakbrowser: { env: Record<string, string> };
}

interface RegistryModule {
  availableProfileNames(profiles: ProfilesDocument): string[];
  findPortableGaps(manifest: Manifest, profiles: ProfilesDocument): string[];
  manifestSupport(manifest: Manifest, toolName: string): string;
  resolveLauncherName(manifest: Manifest | null): string;
  validateManifest(
    manifest: unknown,
    expectedId: string,
    profileNames: string[],
    launcherDir?: string,
  ): string | null;
}

interface AttachModule {
  buildEndpoint(template: string, profileId: string): string;
  effectiveRuntime(
    manifest: Manifest,
    env: Record<string, string | undefined>,
  ): { endpoint: string | null; endpointSource: string; profileId: string | null } | null;
  enrichToolError(result: unknown, hint: string): Record<string, unknown> | null;
  runtimeErrorHint(manifest: Manifest, env: Record<string, string | undefined>): string | null;
  runtimeStatusFields(manifest: Manifest, env: Record<string, string | undefined>): Record<string, unknown>;
  validateEndpointSetting(
    raw: unknown,
    settingName: string,
  ): { endpoint: string | null; error: string | null };
}

interface LaunchConfig {
  endpoint: string | null;
  profileId: string | null;
  source: string;
  error: string | null;
}

interface LauncherModule {
  buildChildEnv(
    source: Record<string, string | undefined>,
    endpoint?: string,
  ): Record<string, string | undefined>;
  locateMcpCli(dir: string, packageName: string): string | null;
  resolveLaunchConfig(source: Record<string, string | undefined>): LaunchConfig;
}

interface ProvisionModule {
  DEFAULT_NPM_PACKAGE: string;
  NPM_DRIVER_PIN: string;
  NPM_ENGINE_WRAPPER_PIN: string;
  ensureNpmRuntime(options: Record<string, unknown>): unknown;
}

const registry = (await import(
  new URL('../../plugins/cloakbrowser/engine-registry.mjs', import.meta.url).href
)) as unknown as RegistryModule;
const attach = (await import(
  new URL('../../plugins/cloakbrowser/lib/attach.mjs', import.meta.url).href
)) as unknown as AttachModule;
const launcher = (await import(
  new URL('../../plugins/cloakbrowser/launch-kameleo.mjs', import.meta.url).href
)) as unknown as LauncherModule;
const provision = (await import(
  new URL('../../plugins/cloakbrowser/lib/provision.mjs', import.meta.url).href
)) as unknown as ProvisionModule;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginRoot = path.join(repoRoot, 'plugins', 'cloakbrowser');
const enginesDir = path.join(pluginRoot, 'engines');
const manifestPath = path.join(enginesDir, 'kameleo.json');
const profilesPath = path.join(enginesDir, 'profiles.json');
const pluginManifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
const mcpConfigPath = path.join(pluginRoot, '.mcp.json');
const launcherPath = path.join(pluginRoot, 'launch-kameleo.mjs');
const brokerPath = path.join(pluginRoot, 'broker.mjs');
const attachPath = path.join(pluginRoot, 'lib', 'attach.mjs');
const cloakLauncherPath = path.join(pluginRoot, 'launch.mjs');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const profiles = JSON.parse(readFileSync(profilesPath, 'utf8')) as ProfilesDocument;
const plugin = JSON.parse(readFileSync(pluginManifestPath, 'utf8')) as PluginDocument;
const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8')) as McpDocument;
const launcherSource = readFileSync(launcherPath, 'utf8');
const cloakLauncherSource = readFileSync(cloakLauncherPath, 'utf8');
const profileNames = registry.availableProfileNames(profiles);

const MISSING_PROFILE_REASON =
  'The kameleo engine needs a profile ID. Set "Kameleo profile ID" (kameleo_profile_id) ' +
  'in the cloakbrowser plugin configuration and restart Claude Code.';

const PARTIAL = ['browser_close', 'browser_start_tracing', 'browser_stop_tracing'];
const UNKNOWN = [
  'browser_annotate',
  'browser_start_recording',
  'browser_start_video',
  'browser_stop_recording',
  'browser_stop_video',
  'browser_video_chapter',
  'browser_video_hide_actions',
  'browser_video_show_actions',
];

describe('kameleo manifest', () => {
  it('declares the attach identity, launcher and portable default', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.id).toBe('kameleo');
    expect(manifest.label).toBe('Kameleo (Chroma over CDP)');
    expect(manifest.transport).toBe('launch');
    expect(manifest.contract).toBe('playwright-mcp');
    expect(manifest.defaultToolProfile).toBe('portable');
    expect(registry.resolveLauncherName(manifest)).toBe('launch-kameleo.mjs');
    expect(manifest.capabilities).toEqual({ groupSwitchesApply: true, cdpAttach: true });
  });

  it('passes the shared manifest validation against the real plugin root', () => {
    expect(registry.validateManifest(manifest, 'kameleo', profileNames, pluginRoot)).toBeNull();
  });

  it('requires the profile id with the exact actionable sentence', () => {
    expect(manifest.requiredEnv).toEqual([{ env: 'KAMELEO_PROFILE_ID', reason: MISSING_PROFILE_REASON }]);
    expect(launcherSource).toContain('The kameleo engine needs a profile ID.');
    expect(launcherSource).toContain('(kameleo_profile_id)');
    expect(launcherSource).toContain('in the cloakbrowser plugin configuration and restart Claude Code.');
    expect(MISSING_PROFILE_REASON).toContain('kameleo_profile_id');
  });

  it('describes the runtime the broker uses for the endpoint, hint and status', () => {
    expect(manifest.runtime).toEqual({
      endpointEnv: 'KAMELEO_ENDPOINT',
      profileEnv: 'KAMELEO_PROFILE_ID',
      defaultEndpoint: 'ws://127.0.0.1:5050/playwright/{profileId}',
      errorHint:
        'Kameleo is not answering at {endpoint}. Start the Kameleo app, sign in, and confirm the ' +
        'profile ID exists. Kameleo starts the profile itself when the endpoint is opened.',
      statusKeys: { endpoint: 'kameleoEndpoint', profileId: 'kameleoProfileId' },
    });
  });

  it('keeps the full contract with explicit partial and unknown support', () => {
    expect(manifest.toolSupport['*']).toBe('full');
    for (const name of PARTIAL) {
      expect(registry.manifestSupport(manifest, name)).toBe('partial');
      expect(manifest.toolSupportNotes?.[name]?.trim()).not.toBe('');
    }
    for (const name of UNKNOWN) {
      expect(registry.manifestSupport(manifest, name)).toBe('unknown');
      expect(manifest.toolSupportNotes?.[name]?.trim()).not.toBe('');
    }
    expect(Object.values(manifest.toolSupport)).not.toContain('none');
    expect(registry.findPortableGaps(manifest, profiles)).toEqual([]);
  });

  it('names the settings Kameleo cannot honour, including the window mode', () => {
    expect(manifest.ignoredSettings).toEqual([
      'humanize',
      'human_preset',
      'release_channel',
      'geoip_proxy_match',
      'profile_dir',
      'proxy_server',
      'proxy_bypass',
      'licence_key',
      'engine_version',
      'camoufox_profile',
      'camoufox_data_dir',
      'headless',
    ]);
  });

  it('declares the prerequisites and the unverified stealth status', () => {
    const requirements = (manifest.requirements ?? []).join(' ');
    expect(requirements).toContain('Kameleo desktop app');
    expect(requirements).toContain('licence');
    expect(requirements).toContain('Chroma');
    expect(requirements).toContain('Junglefox');
    expect(requirements).toContain('kameleo_profile_id');
    expect(requirements).toContain('https://kameleo.io/downloads');
    expect(requirements).toContain('Kameleo.Installer.exe');
    expect(manifest.systemDependencies).toHaveLength(1);
    expect(manifest.systemDependencies?.[0]).toMatchObject({
      id: 'kameleo',
      required: true,
      downloadUrl: 'https://kameleo.io/downloads',
      installerName: 'Kameleo.Installer.exe',
    });
    expect(manifest.notes).toContain('UNVERIFIED');
    expect(manifest.notes).toContain('Junglefox');
    expect(manifest.notes).toContain('75');
  });

  it('ships the settings, the env references and the generated engine option', () => {
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(plugin.userConfig.kameleo_profile_id).toMatchObject({ type: 'string', default: '' });
    expect(plugin.userConfig.kameleo_profile_id.title).toBe('Kameleo profile ID');
    expect(plugin.userConfig.kameleo_profile_id.description).toContain(
      'Required when the browser engine is kameleo',
    );
    expect(plugin.userConfig.kameleo_profile_id.description).toContain('Junglefox');
    expect(plugin.userConfig.kameleo_endpoint).toMatchObject({ type: 'string', default: '' });
    expect(plugin.userConfig.kameleo_endpoint.description).toContain(
      'ws://127.0.0.1:5050/playwright/<profile ID>',
    );
    expect(plugin.userConfig.kameleo_endpoint.description).toContain('loopback');
    expect(mcpConfig.cloakbrowser.env.KAMELEO_PROFILE_ID).toBe('${user_config.kameleo_profile_id}');
    expect(mcpConfig.cloakbrowser.env.KAMELEO_ENDPOINT).toBe('${user_config.kameleo_endpoint}');
    expect(plugin.userConfig.browser_engine.options).toEqual([
      'camoufox-native',
      'camoufox',
      'cloak',
      'kameleo',
      'playwright',
    ]);
    expect(plugin.userConfig.browser_engine.description).toContain('kameleo');
  });

  it('keeps every userConfig key referenced exactly once and no reference orphaned', () => {
    const keys = Object.keys(plugin.userConfig).sort();
    const references = new Set<string>();
    for (const value of Object.values(mcpConfig.cloakbrowser.env)) {
      for (const match of value.matchAll(/\$\{user_config\.([^}]+)\}/g)) {
        references.add(match[1]);
      }
    }
    expect(keys).toHaveLength(33);
    expect([...references].sort()).toEqual(keys);
  });
});

describe('endpoint construction and validation', () => {
  it('builds the documented default endpoint', () => {
    expect(attach.buildEndpoint('ws://127.0.0.1:5050/playwright/{profileId}', 'abc123')).toBe(
      'ws://127.0.0.1:5050/playwright/abc123',
    );
  });

  it('percent-encodes the profile id as one path segment', () => {
    expect(attach.buildEndpoint('ws://127.0.0.1:5050/playwright/{profileId}', 'a/b c ü')).toBe(
      'ws://127.0.0.1:5050/playwright/a%2Fb%20c%20%C3%BC',
    );
  });

  it.each([
    'ws://127.0.0.1:5050/playwright/abc',
    'wss://localhost:443/devtools/browser/xyz',
    'ws://[::1]:5050/playwright/abc',
    'ws://127.0.0.1:5050',
    'ws://LOCALHOST:5050/playwright/abc',
  ])('accepts a loopback endpoint: %s', (value) => {
    expect(attach.validateEndpointSetting(value, 'kameleo_endpoint')).toEqual({
      endpoint: value.trim(),
      error: null,
    });
  });

  it.each([
    ['http', 'http://127.0.0.1:5050', 'ws:// or wss://'],
    ['https', 'https://localhost:5050', 'ws:// or wss://'],
    ['a LAN host', 'ws://192.168.1.5:5050/x', 'loopback host'],
    ['0.0.0.0', 'ws://0.0.0.0:5050/x', 'loopback host'],
    ['a hostname that ends in a loopback lookalike', 'ws://127.0.0.1.example.com:5050', 'loopback host'],
    ['userinfo', 'ws://user:pass@127.0.0.1:5050/x', 'username or password'],
    ['a username only', 'ws://user@127.0.0.1:5050/x', 'username or password'],
    ['an empty host', 'ws://', 'full URL'],
    ['a port above 65535', 'ws://127.0.0.1:70000/x', 'outside 1-65535'],
    ['port zero', 'ws://127.0.0.1:0/x', 'outside 1-65535'],
    ['an empty value', '', 'is empty'],
  ])('rejects %s with the named rule', (_label, value, expected) => {
    const result = attach.validateEndpointSetting(value, 'kameleo_endpoint');
    expect(result.endpoint).toBeNull();
    expect(result.error).toContain('kameleo_endpoint');
    expect(result.error).toContain(expected);
  });

  it('resolves the default endpoint, an explicit endpoint and the missing-profile error', () => {
    expect(launcher.resolveLaunchConfig({ KAMELEO_PROFILE_ID: 'abc123' })).toEqual({
      endpoint: 'ws://127.0.0.1:5050/playwright/abc123',
      profileId: 'abc123',
      source: 'default',
      error: null,
    });
    expect(
      launcher.resolveLaunchConfig({
        KAMELEO_PROFILE_ID: 'abc123',
        KAMELEO_ENDPOINT: 'wss://localhost:443/devtools/browser/xyz',
      }),
    ).toEqual({
      endpoint: 'wss://localhost:443/devtools/browser/xyz',
      profileId: 'abc123',
      source: 'setting',
      error: null,
    });
    for (const source of [
      {},
      { KAMELEO_PROFILE_ID: '' },
      { KAMELEO_PROFILE_ID: '   ' },
      { KAMELEO_PROFILE_ID: '${user_config.kameleo_profile_id}' },
    ]) {
      const result = launcher.resolveLaunchConfig(source);
      expect(result.endpoint).toBeNull();
      expect(result.error).toBe(MISSING_PROFILE_REASON);
    }
    const bad = launcher.resolveLaunchConfig({
      KAMELEO_PROFILE_ID: 'abc123',
      KAMELEO_ENDPOINT: 'http://127.0.0.1:5050',
    });
    expect(bad.endpoint).toBeNull();
    expect(bad.error).toContain('must use the ws:// or wss:// scheme');
  });

  it('falls back to the default when the endpoint setting is an unresolved placeholder', () => {
    expect(
      launcher.resolveLaunchConfig({
        KAMELEO_PROFILE_ID: 'abc123',
        KAMELEO_ENDPOINT: '${user_config.kameleo_endpoint}',
      }),
    ).toMatchObject({
      endpoint: 'ws://127.0.0.1:5050/playwright/abc123',
      source: 'default',
    });
  });
});

describe('launcher environment', () => {
  const baseEnv = {
    CLAUDE_PLUGIN_DATA: 'D:/scratch/plugin-data',
    KAMELEO_PROFILE_ID: 'abc123',
    KAMELEO_ENDPOINT: '',
    PLAYWRIGHT_MCP_USER_DATA_DIR: 'D:/profiles/default',
    PLAYWRIGHT_MCP_BROWSER_ENGINE: 'kameleo',
    PLAYWRIGHT_MCP_HEADLESS: 'false',
    PLAYWRIGHT_MCP_PROXY_SERVER: 'http://proxy:8080',
    PLAYWRIGHT_MCP_PROXY_BYPASS: 'localhost',
    PLAYWRIGHT_MCP_OUTPUT_DIR: '',
    CLOAK_TOOL_GROUP_VISION: 'true',
    CLOAK_TOOL_GROUP_PDF: 'true',
    CLOAK_TOOL_GROUP_DEVTOOLS: 'true',
    CLOAK_TOOL_GROUP_STORAGE: 'true',
    CLOAK_TOOL_GROUP_NETWORK: 'true',
    CLOAK_TOOL_GROUP_TESTING: 'true',
    CLOAK_TOOL_GROUP_CONFIG: 'true',
  };

  it('drops the settings the Kameleo profile owns and keeps the endpoint', () => {
    const env = launcher.buildChildEnv(baseEnv, 'ws://127.0.0.1:5050/playwright/abc123');
    for (const name of [
      'KAMELEO_PROFILE_ID',
      'KAMELEO_ENDPOINT',
      'PLAYWRIGHT_MCP_USER_DATA_DIR',
      'PLAYWRIGHT_MCP_BROWSER_ENGINE',
      'PLAYWRIGHT_MCP_HEADLESS',
      'PLAYWRIGHT_MCP_PROXY_SERVER',
      'PLAYWRIGHT_MCP_PROXY_BYPASS',
      'PLAYWRIGHT_MCP_OUTPUT_DIR',
    ]) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe('ws://127.0.0.1:5050/playwright/abc123');
  });

  it('turns the seven group switches into PLAYWRIGHT_MCP_CAPS', () => {
    const all = launcher.buildChildEnv(baseEnv, 'ws://127.0.0.1:5050/playwright/abc');
    expect(all.PLAYWRIGHT_MCP_CAPS).toBe('vision,pdf,devtools,storage,network,testing,config');
    const noVision = launcher.buildChildEnv(
      { ...baseEnv, CLOAK_TOOL_GROUP_VISION: 'false' },
      'ws://127.0.0.1:5050/playwright/abc',
    );
    expect(noVision.PLAYWRIGHT_MCP_CAPS).toBe('pdf,devtools,storage,network,testing,config');
    const none = launcher.buildChildEnv(
      Object.fromEntries(
        Object.entries(baseEnv).map(([name, value]) =>
          name.startsWith('CLOAK_TOOL_GROUP_') ? [name, 'off'] : [name, value],
        ),
      ),
      'ws://127.0.0.1:5050/playwright/abc',
    );
    expect(none.PLAYWRIGHT_MCP_CAPS).toBeUndefined();
  });

  it('keeps a configured artifacts directory', () => {
    const env = launcher.buildChildEnv(
      { ...baseEnv, PLAYWRIGHT_MCP_OUTPUT_DIR: 'D:/artifacts' },
      'ws://127.0.0.1:5050/playwright/abc',
    );
    expect(env.PLAYWRIGHT_MCP_OUTPUT_DIR).toBe('D:/artifacts');
  });

  it('starts the pinned Playwright MCP CLI in attach mode, never patchright mcp', () => {
    expect(launcherSource).toContain('--cdp-endpoint');
    expect(launcherSource).toContain('@playwright');
    expect(launcherSource).not.toContain('patchright mcp');
    expect(launcherSource).not.toContain('PLAYWRIGHT_MCP_USER_DATA_DIR =');
    expect(launcherSource).not.toContain('applyDefaultProfile');
    expect(launcherSource).toContain('resolveNpmPackage');
  });

  it('keeps the launcher endpoint template and env names equal to the manifest runtime', () => {
    expect(launcherSource).toContain(`'${manifest.runtime?.defaultEndpoint}'`);
    expect(launcherSource).toContain(`'${manifest.runtime?.endpointEnv}'`);
    expect(launcherSource).toContain(`'${manifest.runtime?.profileEnv}'`);
  });

  it('keeps the shared runtime identities in one module used by both launchers', () => {
    expect(provision.NPM_ENGINE_WRAPPER_PIN).toBe('0.6.3');
    expect(provision.NPM_DRIVER_PIN).toBe('patchright@1.64.1');
    expect(provision.DEFAULT_NPM_PACKAGE).toBe('cloakbrowser-mcp@1.15.1');
    expect(launcherSource).toContain('ensureNpmRuntime');
    expect(cloakLauncherSource).toContain('ensureNpmRuntime');
    for (const source of [launcherSource, cloakLauncherSource]) {
      expect(source).not.toContain("const ENGINE_WRAPPER_PIN = '");
      expect(source).not.toContain("const DRIVER_PIN = '");
      expect(source).not.toContain("const DEFAULT_PACKAGE = '");
    }
  });
});

describe('runtime hint and status', () => {
  const env = { KAMELEO_PROFILE_ID: 'abc123' };

  it('formats the exact prerequisite sentence with the effective endpoint', () => {
    expect(attach.runtimeErrorHint(manifest, env)).toBe(
      'Kameleo is not answering at ws://127.0.0.1:5050/playwright/abc123. Start the Kameleo app, ' +
        'sign in, and confirm the profile ID exists. Kameleo starts the profile itself when the ' +
        'endpoint is opened.',
    );
    expect(
      attach.runtimeErrorHint(manifest, {
        KAMELEO_PROFILE_ID: 'abc123',
        KAMELEO_ENDPOINT: 'ws://localhost:5051/playwright/abc123',
      }),
    ).toContain('at ws://localhost:5051/playwright/abc123.');
  });

  it('adds no hint or status for an engine without a runtime block', () => {
    const cloak = JSON.parse(readFileSync(path.join(enginesDir, 'cloak.json'), 'utf8')) as Manifest;
    expect(attach.runtimeErrorHint(cloak, env)).toBeNull();
    expect(attach.runtimeStatusFields(cloak, env)).toEqual({});
  });

  it('reports the manifest-named status fields', () => {
    expect(attach.runtimeStatusFields(manifest, env)).toEqual({
      kameleoEndpoint: 'ws://127.0.0.1:5050/playwright/abc123',
      kameleoProfileId: 'abc123',
    });
    expect(attach.runtimeStatusFields(manifest, {})).toEqual({
      kameleoEndpoint: null,
      kameleoProfileId: null,
    });
  });

  it('appends the hint to the text content of an isError result only', () => {
    const hint = 'Kameleo is not answering at ws://127.0.0.1:5050/playwright/abc123.';
    const enriched = attach.enrichToolError(
      { content: [{ type: 'text', text: 'connect ECONNREFUSED' }], isError: true },
      hint,
    ) as { content: { type: string; text: string }[]; isError: boolean };
    expect(enriched.isError).toBe(true);
    expect(enriched.content[0].text).toBe(`connect ECONNREFUSED ${hint}`);
    expect(enriched.content[0].text.endsWith(hint)).toBe(true);

    const appended = attach.enrichToolError(
      { content: [{ type: 'image', data: 'x' }], isError: true },
      hint,
    ) as { content: { type: string; text: string }[] };
    expect(appended.content).toEqual([
      { type: 'image', data: 'x' },
      { type: 'text', text: hint },
    ]);

    expect(attach.enrichToolError({ content: [], isError: false }, hint)).toBeNull();
    expect(attach.enrichToolError({ content: [] }, hint)).toBeNull();
    expect(attach.enrichToolError(null, hint)).toBeNull();
  });

  it('preserves structuredContent when it enriches a result', () => {
    const result = {
      content: [{ type: 'text', text: 'failed' }],
      structuredContent: { code: 'ECONNREFUSED' },
      isError: true,
    };
    const enriched = attach.enrichToolError(result, 'Kameleo is not answering.')!;
    expect(enriched.structuredContent).toEqual({ code: 'ECONNREFUSED' });
  });
});

describe('documentation', () => {
  const readme = readFileSync(path.join(pluginRoot, 'README.md'), 'utf8');
  const enginesReadme = readFileSync(path.join(enginesDir, 'README.md'), 'utf8');

  it('documents the engine, the setup, the endpoint rules and the unverified status', () => {
    expect(readme).toContain('### Kameleo engine');
    expect(readme).toContain('kameleo_profile_id');
    expect(readme).toContain('Kameleo CDP endpoint');
    expect(readme).toContain('ws://127.0.0.1:5050/playwright/<profile ID>');
    expect(readme).toContain('Junglefox');
    expect(readme).toContain('UNVERIFIED');
    expect(readme).toContain('connect ECONNREFUSED 127.0.0.1:5050');
    expect(readme).toContain('| `kameleo` | `portable` | 75 | 27');
    expect(readme).toContain(plugin.version);
    for (const line of readme.split(/\r?\n/)) {
      if (line.toLowerCase().includes('kameleo') && line.includes('isBot: false')) {
        throw new Error(`README claims a Kameleo stealth result: ${line}`);
      }
    }
  });

  it('documents the generic attach fields in the add-an-engine recipe', () => {
    expect(enginesReadme).toContain('requiredEnv');
    expect(enginesReadme).toContain('runtime');
    expect(enginesReadme).toContain('cdpAttach');
    expect(enginesReadme).toContain('launch-kameleo.mjs');
  });
});

describe('modularity', () => {
  it('keeps the kameleo engine id and environment names out of the broker', () => {
    const broker = readFileSync(brokerPath, 'utf8');
    const attachCode = readFileSync(attachPath, 'utf8');
    for (const source of [broker, attachCode]) {
      expect(source.toLowerCase()).not.toContain('kameleo');
    }
  });

  it('keeps the launcher specific to its own setting names', () => {
    expect(launcherSource).toContain('KAMELEO_PROFILE_ID');
    expect(launcherSource).toContain('KAMELEO_ENDPOINT');
    expect(launcherSource).toContain('kameleo_endpoint');
  });
});
