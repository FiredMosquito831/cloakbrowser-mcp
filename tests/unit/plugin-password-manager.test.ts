import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Camoufox saved logins, autofill and search engines (2.17.0). The pinned build
// locks Firefox's login manager off through its own enterprise policy, replaces
// the stock search-engine list with one dummy engine, and has no readable
// per-user policy directory on Windows, so the engine always runs on a
// plugin-owned overlay build: hardlinks/junctions to the machine-wide build with
// a modified distribution/policies.json, run via CAMOUFOX_EXECUTABLE_PATH. This
// suite pins:
//   - both plugin manifests (2.17.0, the overlay help text), the environment
//     mapping and the settings counts;
//   - the overlay mechanics: plan, hardlink/junction recipe, copy fallback,
//     free-space and junction guards, marker, integrity, swap, removal, pruning;
//   - the policy transform: the search block is replaced by exactly
//     { Default: "Google", PreventInstalls: false } and the two password values
//     are flipped only when password_manager is on, with every other byte kept;
//   - the apply flow: the overlay is always on for camoufox, creation,
//     verification, caching, every failure path, the prefs-only path, the
//     one-time search migration (backup + marker) and the off path (no password
//     keys, overlay still on);
//   - the entry point's three prefs, the user executable_path strip and the
//     overlay state (tests/python);
//   - the broker report: off adds no password key anywhere, search keys appear
//     for the camoufox engine only, on reports what happened and the engines that
//     cannot apply it say so.
interface JsonRpcResponse {
  id?: number;
  result?: {
    tools?: { name: string; description?: string }[];
    content?: { type: string; text?: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    instructions?: string;
    serverInfo?: { name?: string; version?: string };
  };
  error?: { code: number; message: string };
}

interface BrokerSession {
  request: (method: string, params?: Record<string, unknown>) => Promise<JsonRpcResponse>;
  stderr: () => string;
  close: () => Promise<void>;
}

interface Resolution {
  enabled: boolean;
  raw: string | null;
  problem: 'placeholder' | 'ignored' | null;
}

interface ApplyResult {
  status: string;
  note: string | null;
  policyFile: string | null;
  overlay: string | null;
  overlayMode: string | null;
  executable: string | null;
  searchSource?: string | null;
  searchDefault?: string | null;
  searchMigration?: string | null;
  searchBackupFile?: string | null;
}

interface PasswordModule {
  PASSWORD_MANAGER_ENGINE_ID: string;
  PASSWORD_MANAGER_SETTING_VAR: string;
  PASSWORD_MANAGER_STATE_VAR: string;
  PASSWORD_MANAGER_STATE_OVERLAY: string;
  PASSWORD_MANAGER_STATE_PREFS: string;
  PASSWORD_MANAGER_STATE_APPLIED: string;
  PASSWORD_MANAGER_PREFS: Record<string, boolean>;
  PASSWORD_MANAGER_APPLIED_SENTENCE: string;
  PASSWORD_MANAGER_PREFS_SENTENCE: string;
  PASSWORD_MANAGER_WINDOWS_DEAD_PATH_NOTE: string;
  CAMOUFOX_OVERLAY_STATE_VAR: string;
  CAMOUFOX_OVERLAY_STATE_APPLIED: string;
  CAMOUFOX_OVERLAY_STATE_BLOCKED: string;
  CAMOUFOX_OVERLAY_STATE_STOCK: string;
  SEARCH_ENGINE_DEFAULT: string;
  SEARCH_ENGINES_POLICY: Record<string, unknown>;
  SEARCH_PROFILE_FILENAME: string;
  SEARCH_MIGRATION_MARKER_FILENAME: string;
  resolvePasswordManager(env?: Record<string, string | undefined>): Resolution;
  passwordManagerProblemNote(resolution: Resolution): string | null;
  passwordPolicyLocked(buildPolicy: unknown): boolean;
  searchPolicyApplies(buildPolicy: unknown): boolean;
  searchPolicyLockFree(managed: unknown): { ok: boolean; reason: string | null };
  managedPolicy(buildPolicy: unknown, options?: Record<string, unknown>): Record<string, unknown> | null;
  probePolicy(managed: unknown): Record<string, unknown> | null;
  policyBytes(policy: unknown): string;
  sha256(text: string): string;
  sha256File(file: string): string | null;
  writeFileAtomic(target: string, text: string): void;
  readPasswordPolicyRecord(pluginDataDir: string): Record<string, unknown> | null;
  writePasswordPolicyRecord(pluginDataDir: string, record: Record<string, unknown>): void;
  passwordUserConfigProblem(env: Record<string, string | undefined>): string | null;
  hasFirefoxLoginStore(profileDir: string): boolean;
  searchMigrationMarkerPath(profileDir: string): string;
  readSearchMigrationMarker(profileDir: string): Record<string, unknown> | null;
  migrateSearchProfile(options: Record<string, unknown>): {
    status: string;
    backup: string | null;
    note: string | null;
  };
  applyPasswordManager(options: Record<string, unknown>): Promise<ApplyResult>;
  applyCamoufoxOverlay(options: Record<string, unknown>): Promise<ApplyResult>;
  applyPerUserPolicyFile(options: Record<string, unknown>): Promise<ApplyResult>;
}

interface OverlayMarker {
  version: number;
  engine: string;
  pluginOverlayFormat: number;
  sourceBuild: string;
  sourcePolicySha256: string;
  managedPolicySha256: string;
  probePolicySha256: string;
  mode: 'hardlink' | 'copy';
  files: { name: string; size: number; mtimeMs: number; link: boolean }[];
  junctions: { name: string; target: string }[];
  createdAt: string;
  verifiedAt: string | null;
}

interface OverlayModule {
  OVERLAY_MARKER_FILENAME: string;
  OVERLAY_FORMAT: number;
  OVERLAY_MARKER_VERSION: number;
  OVERLAY_ROOT_NAME: string;
  overlayRoot(pluginDataDir: string): string;
  overlayTarget(pluginDataDir: string, buildDir: string): string;
  overlayPolicyPath(overlayDir: string): string;
  overlayExecutablePath(overlayDir: string): string;
  isPathInsideOverlayRoot(root: string, candidate: string): boolean;
  isRealDirectory(candidate: string): boolean;
  readOverlayMarker(target: string): {
    state: 'missing' | 'foreign' | 'ours';
    marker: OverlayMarker | null;
    reason: string | null;
  };
  planOverlay(sourceDir: string): {
    files: { name: string; size: number; mtimeMs: number }[];
    directories: { name: string }[];
    distribution: boolean;
    totalBytes: number;
  };
  createOverlay(options: Record<string, unknown>): OverlayMarker;
  inspectOverlay(options: Record<string, unknown>): {
    ok: boolean;
    reason: string | null;
    needsFinalPolicy?: boolean;
  };
  swapOverlay(options: Record<string, unknown>): { reused: boolean };
  removeOverlay(options: Record<string, unknown>): { removed: boolean; reason: string | null };
  pruneOverlays(options: Record<string, unknown>): {
    removed: string[];
    kept: string[];
    failed: { name: string; reason: string }[];
  };
  cleanStaleTemps(options: Record<string, unknown>): { removed: string[] };
}

interface ChildEnvLauncher {
  buildChildEnv(source: Record<string, string | undefined>): Record<string, string | undefined>;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const universalDir = path.join(repoRoot, 'plugins', 'cloakbrowser');
const camoufoxDir = path.join(repoRoot, 'plugins', 'camoufox');
const pythonSuitePath = path.join(repoRoot, 'tests', 'python', 'test_camoufox_password_manager.py');
const library = (await import(
  new URL('../../shared/core/lib/password-manager.mjs', import.meta.url).href
)) as unknown as PasswordModule;
const overlays = (await import(
  new URL('../../shared/core/lib/camoufox-overlay.mjs', import.meta.url).href
)) as unknown as OverlayModule;
const camoufoxLauncher = (await import(
  new URL('../../shared/core/launch-camoufox.mjs', import.meta.url).href
)) as unknown as ChildEnvLauncher;

const STUB_SOURCE = `import readline from 'node:readline';
const TOOLS = ['browser_navigate', 'browser_snapshot'];
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'stub-password-manager', version: '0.0.0' },
      instructions: 'stub instructions.',
    } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({
      name, description: 'stub ' + name, inputSchema: { type: 'object', properties: {} },
    })) } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: {} });
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => { if (line.trim() !== '') { try { handle(JSON.parse(line)); } catch {} } });
rl.on('close', () => process.exit(0));
`;

const tempRoots: string[] = [];
const sessions: BrokerSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close();
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

// The shipped build's own policy shape (2026-10-27), including the search block
// that hides every stock engine, points the default at the dummy `None` engine
// and adds that dummy. The overlay replaces only these subtrees.
const BUILD_POLICY = {
  '__COMMENT__ More Information': 'https://example.invalid/policy-templates',
  policies: {
    AppUpdateURL: 'https://localhost',
    DisableAppUpdate: true,
    DisableTelemetry: true,
    DisableFormHistory: true,
    PasswordManagerEnabled: false,
    OfferToSaveLogins: false,
    Extensions: { Uninstall: ['formautofill@mozilla.org', 'screenshots@mozilla.org'] },
    SearchEngines: {
      PreventInstalls: true,
      Remove: ['Google', 'DuckDuckGo', 'Bing', 'Amazon.com', 'eBay', 'Twitter', 'Wikipedia (en)'],
      Default: 'None',
      Add: [
        {
          Name: 'None',
          Description: 'None',
          Alias: '',
          Method: 'POST',
          URLTemplate: 'http://127.0.0.1',
          PostData: '',
        },
      ],
    },
  },
};
const BUILD_POLICY_TEXT = `${JSON.stringify(BUILD_POLICY, null, 2)}\n`;
// The managed document with the password keys (the default test environment sets
// password_manager=true) and the search-only one the off path writes.
const MANAGED_TEXT = library.policyBytes(library.managedPolicy(BUILD_POLICY, { passwordOn: true }));
const SEARCH_MANAGED_TEXT = library.policyBytes(library.managedPolicy(BUILD_POLICY));
const PROBE_TEXT = library.policyBytes(
  library.probePolicy(library.managedPolicy(BUILD_POLICY, { passwordOn: true })),
);
const SEARCH_PROBE_TEXT = library.policyBytes(library.probePolicy(library.managedPolicy(BUILD_POLICY)));

interface Fixture {
  root: string;
  buildDir: string;
  binary: string;
  pluginData: string;
  target: string;
  build: string;
}

// The real Camoufox cache layout shape, with a small stand-in tree: one
// executable, three data files, three directories and the build's policy.
function buildFixture(
  options: {
    policyText?: string | null;
    extraFiles?: Record<string, string>;
    extraDirectories?: string[];
  } = {},
): Fixture {
  const root = tempRoot('camoufox-overlay-');
  const buildDir = path.join(root, 'cache', 'Cache', 'browsers', 'official', '156.0.1-beta.39-b38343bc');
  const build = 'v156.0.1-beta.39';
  mkdirSync(path.join(buildDir, 'distribution'), { recursive: true });
  const files: Record<string, string> = {
    'camoufox.exe': 'fake-executable',
    'xul.dll': 'fake-xul-bytes',
    'application.ini': '[App]\nName=Camoufox\n',
    'version.json': '{"version":"156.0.1"}\n',
    ...(options.extraFiles ?? {}),
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(buildDir, name), content);
  }
  for (const dir of ['browser', 'defaults', 'fonts', ...(options.extraDirectories ?? [])]) {
    mkdirSync(path.join(buildDir, dir), { recursive: true });
    writeFileSync(path.join(buildDir, dir, 'contents.txt'), dir);
  }
  if (options.policyText !== null) {
    writeFileSync(
      path.join(buildDir, 'distribution', 'policies.json'),
      options.policyText ?? BUILD_POLICY_TEXT,
    );
  }
  const pluginData = path.join(root, 'plugin-data');
  return {
    root,
    buildDir,
    binary: path.join(buildDir, 'camoufox.exe'),
    pluginData,
    target: overlays.overlayTarget(pluginData, buildDir),
    build,
  };
}

interface RunResult {
  result: ApplyResult;
  env: Record<string, string | undefined>;
  probeCalls: number;
  probeBinaries: string[];
  logs: string[];
}

async function runApply(
  fixture: Fixture,
  options: {
    env?: Record<string, string | undefined>;
    platform?: string;
    probe?: () => Promise<Record<string, unknown>>;
    pluginDataDir?: string;
    binary?: string;
    build?: string;
    overlayOps?: Record<string, unknown>;
    profileDir?: string;
    step?: (options: Record<string, unknown>) => Promise<ApplyResult>;
  } = {},
): Promise<RunResult> {
  const env: Record<string, string | undefined> = {
    STEALTH_PASSWORD_MANAGER: 'true',
    ...(options.env ?? {}),
  };
  let probeCalls = 0;
  const probeBinaries: string[] = [];
  const logs: string[] = [];
  const step =
    options.step ?? ((stepOptions: Record<string, unknown>) => library.applyCamoufoxOverlay(stepOptions));
  const result = await step({
    env,
    pluginDataDir: options.pluginDataDir ?? fixture.pluginData,
    binary: options.binary ?? fixture.binary,
    build: options.build ?? fixture.build,
    python: 'python',
    bootstrap: 'camoufox_bootstrap.py',
    platform: options.platform ?? 'win32',
    profileDir: options.profileDir ?? null,
    log: (message: unknown) => logs.push(String(message)),
    probe: async (probeOptions: Record<string, unknown>) => {
      probeCalls += 1;
      probeBinaries.push(String(probeOptions.binary));
      return options.probe === undefined ? { state: 'denied' } : options.probe();
    },
    overlayOps: options.overlayOps ?? {},
  });
  return { result, env, probeCalls, probeBinaries, logs };
}

function record(fixture: Fixture, pluginDataDir?: string): Record<string, unknown> | null {
  return library.readPasswordPolicyRecord(pluginDataDir ?? fixture.pluginData);
}

function markerBase(fixture: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: overlays.OVERLAY_MARKER_VERSION,
    engine: 'camoufox',
    sourceBuild: path.resolve(fixture.buildDir),
    sourceExe: fixture.binary,
    sourcePolicySha256: library.sha256(BUILD_POLICY_TEXT),
    managedPolicySha256: library.sha256(MANAGED_TEXT),
    probePolicySha256: library.sha256(PROBE_TEXT),
    createdAt: '2026-10-26T18:20:50Z',
    verifiedAt: null,
    pluginOverlayFormat: overlays.OVERLAY_FORMAT,
    ...overrides,
  };
}

function createFixtureOverlay(
  fixture: Fixture,
  options: {
    tempName?: string;
    markerOverrides?: Record<string, unknown>;
    link?: (source: string, destination: string) => void;
    junction?: (target: string, destination: string, type: string) => void;
    freeBytes?: () => number | null;
    policyText?: string;
  } = {},
): { marker: OverlayMarker; tempDir: string } {
  const tempDir = path.join(
    fixture.pluginData,
    overlays.OVERLAY_ROOT_NAME,
    options.tempName ?? 'build.tmp-1-abcdef',
  );
  const marker = overlays.createOverlay({
    sourceDir: fixture.buildDir,
    tempDir,
    probePolicyText: options.policyText ?? PROBE_TEXT,
    markerBase: markerBase(fixture, options.markerOverrides),
    ...(options.link === undefined ? {} : { link: options.link }),
    ...(options.junction === undefined ? {} : { junction: options.junction }),
    ...(options.freeBytes === undefined ? {} : { freeBytes: options.freeBytes }),
  });
  return { marker, tempDir };
}

// --- the shipped manifests -------------------------------------------------
describe('password_manager in the shipped manifests', () => {
  const plugins = ['cloakbrowser', 'camoufox'] as const;

  it.each(plugins)('declares a boolean, off by default, with the overlay and security text (%s)', (name) => {
    const plugin = JSON.parse(
      readFileSync(path.join(repoRoot, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as {
      version: string;
      userConfig: Record<string, { type?: string; default?: unknown; description?: string }>;
    };
    expect(plugin.version).toBe('2.17.0');
    const setting = plugin.userConfig.password_manager;
    expect(setting, `${name} declares password_manager`).toBeDefined();
    expect(setting.type).toBe('boolean');
    expect(setting.default).toBe(false);
    expect(Object.hasOwn(setting, 'options')).toBe(false);
    const description = setting.description ?? '';
    for (const phrase of [
      'Off by default',
      'logins.db',
      'key4.db',
      'prompt-injected',
      'browser_snapshot',
      'plain HTTP stays off',
      'copy-keep',
      'profile-copy.mjs',
      'PasswordManagerEnabled',
      'OfferToSaveLogins',
      'plugin-owned overlay',
      'hardlinks',
      'junctions',
      'blocked-by-overlay',
      'blocked-by-existing-overlay',
      'search engines',
      'Google as the default',
      'turning it off removes only those',
      ...(name === 'cloakbrowser' ? ['native-unavailable'] : []),
      'never reads, logs or transmits',
      '2FA',
    ]) {
      expect(description, `${name} help text names ${phrase}`).toContain(phrase);
    }
  });

  it.each(plugins)('maps the setting to exactly one environment reference (%s)', (name) => {
    const mcp = JSON.parse(readFileSync(path.join(repoRoot, 'plugins', name, '.mcp.json'), 'utf8')) as Record<
      string,
      { env?: Record<string, string> }
    >;
    const env = mcp[name].env ?? {};
    expect(env.STEALTH_PASSWORD_MANAGER).toBe('${user_config.password_manager}');
    expect(Object.values(env).filter((value) => value === '${user_config.password_manager}')).toHaveLength(1);
  });

  it('keeps the settings counts at 32 and 21', () => {
    for (const [name, count] of [
      ['cloakbrowser', 32],
      ['camoufox', 21],
    ] as const) {
      const plugin = JSON.parse(
        readFileSync(path.join(repoRoot, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'),
      ) as { userConfig: Record<string, unknown> };
      expect(Object.keys(plugin.userConfig), `${name}`).toHaveLength(count);
    }
  });

  it('documents the setting in both READMEs and keeps the credential-form rule', () => {
    for (const dir of [universalDir, camoufoxDir]) {
      const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
      expect(readme).toContain('password_manager');
      expect(readme).toContain('Saved logins and autofill');
      expect(readme).toContain('Never automate the Google credential form');
      expect(readme).toContain('logins.db');
      expect(readme).toContain('key4.db');
      expect(readme).toContain('camoufox-overlay');
      expect(readme).toContain('blocked-by-overlay');
      expect(readme).toContain('passwordManagerOverlay');
      expect(readme).toContain('searchEnginesSource');
      expect(readme).toContain('searchEnginesNote');
      expect(readme).toContain('search.json.mozlz4');
    }
    expect(readFileSync(path.join(universalDir, 'README.md'), 'utf8')).toContain('native-unavailable');
    expect(readFileSync(path.join(camoufoxDir, 'README.md'), 'utf8')).toContain('2.17.0');
  });
});

// --- the shared helpers ----------------------------------------------------
describe('the shared password-manager helpers', () => {
  it('is off unless the value is an explicit true spelling', () => {
    expect(library.PASSWORD_MANAGER_ENGINE_ID).toBe('camoufox');
    expect(library.PASSWORD_MANAGER_SETTING_VAR).toBe('STEALTH_PASSWORD_MANAGER');
    expect(library.PASSWORD_MANAGER_STATE_VAR).toBe('STEALTH_PASSWORD_MANAGER_STATE');
    expect(library.PASSWORD_MANAGER_STATE_OVERLAY).toBe('overlay');
    expect(library.PASSWORD_MANAGER_STATE_PREFS).toBe('prefs');
    expect(library.PASSWORD_MANAGER_PREFS).toEqual({
      'signon.rememberSignons': true,
      'signon.autofillForms': true,
      'signon.autofillForms.http': false,
    });
    expect(Object.keys(library.PASSWORD_MANAGER_PREFS)).not.toContain('toolkit.policies.perUserDir');
    for (const value of [undefined, '', 'false', '0', 'no', 'off', ' FALSE ']) {
      expect(library.resolvePasswordManager({ STEALTH_PASSWORD_MANAGER: value }), `${String(value)}`).toEqual(
        {
          enabled: false,
          raw: value === undefined || String(value).trim() === '' ? null : String(value).trim(),
          problem: null,
        },
      );
    }
    for (const value of ['true', '1', 'yes', 'on', ' TRUE ']) {
      expect(library.resolvePasswordManager({ STEALTH_PASSWORD_MANAGER: value }).enabled, `${value}`).toBe(
        true,
      );
    }
  });

  it('treats an unsubstituted placeholder and an unknown value as off with one note', () => {
    const placeholder = library.resolvePasswordManager({
      STEALTH_PASSWORD_MANAGER: '${user_config.password_manager}',
    });
    expect(placeholder).toMatchObject({ enabled: false, problem: 'placeholder' });
    expect(library.passwordManagerProblemNote(placeholder)).toContain('placeholder');
    const ignored = library.resolvePasswordManager({ STEALTH_PASSWORD_MANAGER: 'sometimes' });
    expect(ignored).toMatchObject({ enabled: false, problem: 'ignored' });
    expect(library.passwordManagerProblemNote(ignored)).toContain('not a boolean');
    expect(library.passwordManagerProblemNote(library.resolvePasswordManager({}))).toBeNull();
    expect(
      library.passwordManagerProblemNote(
        library.resolvePasswordManager({ STEALTH_PASSWORD_MANAGER: 'true' }),
      ),
    ).toBeNull();
  });

  it('replaces only the search block and the two password keys, and never mutates the source', () => {
    const before = JSON.stringify(BUILD_POLICY);
    const managed = library.managedPolicy(BUILD_POLICY, { passwordOn: true }) as {
      policies: Record<string, unknown>;
    };
    expect(managed).not.toBeNull();
    expect(JSON.stringify(BUILD_POLICY), 'the build document is never mutated').toBe(before);
    expect(managed.policies.PasswordManagerEnabled).toBe(true);
    expect(managed.policies.OfferToSaveLogins).toBe(true);
    // The shipped block (Remove/Default None/Add) is replaced by exactly the two
    // documented keys: no engine entries are added and nothing is locked.
    expect(managed.policies.SearchEngines).toEqual({ Default: 'Google', PreventInstalls: false });
    expect(Object.keys(managed.policies.SearchEngines as object).sort()).toEqual([
      'Default',
      'PreventInstalls',
    ]);
    const expected = {
      ...BUILD_POLICY,
      policies: {
        ...BUILD_POLICY.policies,
        PasswordManagerEnabled: true,
        OfferToSaveLogins: true,
        SearchEngines: { Default: 'Google', PreventInstalls: false },
      },
    };
    expect(managed).toEqual(expected);
    for (const [key, value] of Object.entries(BUILD_POLICY.policies)) {
      if (key === 'PasswordManagerEnabled' || key === 'OfferToSaveLogins' || key === 'SearchEngines') {
        continue;
      }
      expect(managed.policies[key], `${key}`).toEqual(value);
    }
    expect((managed as Record<string, unknown>)['__COMMENT__ More Information']).toBe(
      BUILD_POLICY['__COMMENT__ More Information'],
    );
    // Re-deriving from the same source is stable (idempotent, no drift).
    expect(library.managedPolicy(BUILD_POLICY, { passwordOn: true })).toEqual(managed);
    // The serialized search subtree is exactly two keys and carries no lock.
    const searchText = JSON.stringify(managed.policies.SearchEngines);
    expect(searchText).toBe('{"Default":"Google","PreventInstalls":false}');
    for (const lockKey of ['Locked', 'Allow', 'DefaultPrivate', 'Remove', 'Add']) {
      expect(searchText).not.toContain(lockKey);
      expect(managed.policies).not.toHaveProperty(lockKey);
    }
    // Password off (2.17.0): the search block is still replaced, the password
    // values are untouched.
    const searchOnly = library.managedPolicy(BUILD_POLICY) as { policies: Record<string, unknown> };
    expect(searchOnly.policies.SearchEngines).toEqual({ Default: 'Google', PreventInstalls: false });
    expect(searchOnly.policies.PasswordManagerEnabled).toBe(false);
    expect(searchOnly.policies.OfferToSaveLogins).toBe(false);
    expect(library.managedPolicy({})).toBeNull();
    expect(library.managedPolicy(null)).toBeNull();
    expect(library.managedPolicy({ policies: [] })).toBeNull();
  });

  it('decides when the search transform applies and asserts it is lock-free', () => {
    expect(library.SEARCH_ENGINE_DEFAULT).toBe('Google');
    expect(library.SEARCH_ENGINES_POLICY).toEqual({ Default: 'Google', PreventInstalls: false });
    expect(library.searchPolicyApplies(BUILD_POLICY)).toBe(true);
    expect(library.searchPolicyApplies({ policies: { SearchEngines: {} } })).toBe(true);
    expect(library.searchPolicyApplies({ policies: {} })).toBe(false);
    expect(library.searchPolicyApplies({})).toBe(false);
    expect(library.searchPolicyApplies(null)).toBe(false);
    // A document without the block is left alone: stock already, nothing added.
    const noSearch = library.managedPolicy(
      { policies: { PasswordManagerEnabled: false, OfferToSaveLogins: false } },
      { passwordOn: false },
    ) as { policies: Record<string, unknown> };
    expect(noSearch.policies).not.toHaveProperty('SearchEngines');
    const ok = library.searchPolicyLockFree(library.managedPolicy(BUILD_POLICY));
    expect(ok).toEqual({ ok: true, reason: null });
    expect(library.searchPolicyLockFree({ policies: { SearchEngines: { Default: 'None' } } }).ok).toBe(false);
    expect(
      library.searchPolicyLockFree({
        policies: { SearchEngines: { Default: 'Google', PreventInstalls: true, Locked: true } },
      }).ok,
    ).toBe(false);
    expect(library.searchPolicyLockFree({ policies: {} }).ok).toBe(false);
  });

  it('adds only the geolocation probe policy to the verification document', () => {
    const managed = library.managedPolicy(BUILD_POLICY, { passwordOn: true }) as {
      policies: Record<string, unknown>;
    };
    const probe = library.probePolicy(managed) as { policies: Record<string, unknown> };
    expect(probe.policies.Permissions).toEqual({ Location: { BlockNewRequests: true } });
    expect(probe.policies.PasswordManagerEnabled).toBe(true);
    expect(probe.policies.OfferToSaveLogins).toBe(true);
    expect(probe.policies.SearchEngines).toEqual({ Default: 'Google', PreventInstalls: false });
    expect(managed.policies.Permissions).toBeUndefined();
    const searchOnly = library.probePolicy(library.managedPolicy(BUILD_POLICY)) as {
      policies: Record<string, unknown>;
    };
    expect(searchOnly.policies.Permissions).toEqual({ Location: { BlockNewRequests: true } });
    expect(searchOnly.policies.PasswordManagerEnabled).toBe(false);
    expect(library.policyBytes(searchOnly)).toBe(SEARCH_PROBE_TEXT);
    const withPermissions = library.managedPolicy({
      policies: {
        Permissions: { Camera: { BlockNewRequests: true }, Location: { BlockNewRequests: false } },
      },
    });
    const merged = library.probePolicy(withPermissions) as {
      policies: { Permissions: Record<string, unknown> };
    };
    expect(merged.policies.Permissions).toEqual({
      Camera: { BlockNewRequests: true },
      Location: { BlockNewRequests: true },
    });
  });

  it('decides whether the build locks the manager off', () => {
    expect(library.passwordPolicyLocked(BUILD_POLICY)).toBe(true);
    expect(
      library.passwordPolicyLocked({ policies: { PasswordManagerEnabled: false, OfferToSaveLogins: true } }),
    ).toBe(true);
    expect(
      library.passwordPolicyLocked({ policies: { PasswordManagerEnabled: true, OfferToSaveLogins: true } }),
    ).toBe(false);
    expect(library.passwordPolicyLocked({ policies: {} })).toBe(false);
    expect(library.passwordPolicyLocked({})).toBe(true);
    expect(library.passwordPolicyLocked(null)).toBe(true);
  });

  it('keeps the record in plugin data and refuses unknown shapes', () => {
    const root = tempRoot('password-record-');
    expect(library.readPasswordPolicyRecord(root)).toBeNull();
    const good = {
      version: 1,
      engine: 'camoufox',
      status: 'applied',
      build: 'v1',
      overlay: null,
      managedPolicyHash: 'abc',
      verified: true,
    };
    library.writePasswordPolicyRecord(root, good);
    expect(library.readPasswordPolicyRecord(root)).toEqual(good);
    for (const status of [
      'prefs',
      'stock',
      'blocked-by-overlay',
      'blocked-by-existing-overlay',
      'blocked-by-build-policy',
      'blocked-config',
      'blocked-by-existing-policy',
    ]) {
      library.writePasswordPolicyRecord(root, { ...good, status });
      expect(library.readPasswordPolicyRecord(root)).toMatchObject({ status });
    }
    library.writePasswordPolicyRecord(root, { ...good, status: 'nonsense' });
    expect(library.readPasswordPolicyRecord(root)).toBeNull();
    library.writePasswordPolicyRecord(root, { ...good, status: 'setting' });
    expect(library.readPasswordPolicyRecord(root)).toBeNull();
    library.writePasswordPolicyRecord(root, { ...good, version: 2 });
    expect(library.readPasswordPolicyRecord(root)).toBeNull();
    writeFileSync(path.join(root, 'config', 'camoufox', 'password-manager.json'), '{not json');
    expect(library.readPasswordPolicyRecord(root)).toBeNull();
  });

  it('recognises the user config shapes the entry point refuses', () => {
    const root = tempRoot('password-config-');
    expect(library.passwordUserConfigProblem({})).toBeNull();
    const json = path.join(root, 'user.json');
    writeFileSync(json, JSON.stringify({ browser: { camoufoxOptions: { firefox_user_prefs: {} } } }));
    expect(library.passwordUserConfigProblem({ CAMOUFOX_MCP_CONFIG: json })).toBeNull();
    const ini = path.join(root, 'user.ini');
    writeFileSync(ini, 'browser = camoufox\n');
    expect(library.passwordUserConfigProblem({ CAMOUFOX_MCP_CONFIG: ini })).toContain('not JSON');
    expect(
      library.passwordUserConfigProblem({ CAMOUFOX_MCP_CONFIG: path.join(root, 'absent.json') }),
    ).toContain('does not exist');
    const badPrefs = path.join(root, 'bad-prefs.json');
    writeFileSync(badPrefs, JSON.stringify({ browser: { camoufoxOptions: { firefox_user_prefs: [] } } }));
    expect(library.passwordUserConfigProblem({ CAMOUFOX_MCP_CONFIG: badPrefs })).toContain(
      'firefox_user_prefs',
    );
    const badBrowser = path.join(root, 'bad-browser.json');
    writeFileSync(badBrowser, JSON.stringify({ browser: 'nope' }));
    expect(library.passwordUserConfigProblem({ CAMOUFOX_MCP_CONFIG: badBrowser })).toContain('"browser"');
  });

  it('reports the login store by file existence only', () => {
    const root = tempRoot('password-store-');
    expect(library.hasFirefoxLoginStore('')).toBe(false);
    expect(library.hasFirefoxLoginStore(root)).toBe(false);
    writeFileSync(path.join(root, 'logins.db'), 'not a database');
    expect(library.hasFirefoxLoginStore(root)).toBe(true);
    const other = tempRoot('password-store-dir-');
    mkdirSync(path.join(other, 'logins.db'));
    expect(library.hasFirefoxLoginStore(other)).toBe(true);
  });
});

// --- the overlay mechanics -------------------------------------------------
describe('the one-time search migration', () => {
  it('renames search.json.mozlz4 once, keeps the bytes as a backup and writes a marker', () => {
    const profile = tempRoot('search-migration-');
    const original = 'mozlz4-bytes-of-the-old-policy';
    writeFileSync(path.join(profile, library.SEARCH_PROFILE_FILENAME), original);
    const logs: string[] = [];
    const first = library.migrateSearchProfile({
      profileDir: profile,
      log: (line: string) => logs.push(line),
    });
    expect(first.status).toBe('renamed');
    expect(first.backup).toMatch(/^search\.json\.mozlz4\.backup-\d{8}T\d{6}Z$/u);
    expect(existsSync(path.join(profile, library.SEARCH_PROFILE_FILENAME))).toBe(false);
    expect(readFileSync(path.join(profile, first.backup!), 'utf8')).toBe(original);
    const marker = library.readSearchMigrationMarker(profile);
    expect(marker).toMatchObject({
      version: 1,
      engine: 'camoufox',
      migrated: true,
      backup: first.backup,
      reason: 'overlay-search-policy',
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('backup');
    // A second start does nothing and reports it honestly.
    const second = library.migrateSearchProfile({ profileDir: profile });
    expect(second).toMatchObject({ status: 'already', backup: null, note: null });
    expect(existsSync(path.join(profile, library.SEARCH_PROFILE_FILENAME))).toBe(false);
    // Firefox writing a fresh file after the migration is not renamed again.
    writeFileSync(path.join(profile, library.SEARCH_PROFILE_FILENAME), 'new stock file');
    expect(library.migrateSearchProfile({ profileDir: profile }).status).toBe('already');
    expect(existsSync(path.join(profile, library.SEARCH_PROFILE_FILENAME))).toBe(true);
  });

  it('reports no file and no profile without writing a marker', () => {
    const profile = tempRoot('search-migration-empty-');
    expect(library.migrateSearchProfile({ profileDir: profile })).toEqual({
      status: 'no-file',
      backup: null,
      note: null,
    });
    expect(existsSync(library.searchMigrationMarkerPath(profile))).toBe(false);
    expect(library.migrateSearchProfile({ profileDir: null })).toEqual({
      status: 'no-profile',
      backup: null,
      note: null,
    });
    expect(library.migrateSearchProfile({ profileDir: path.join(profile, 'absent') }).status).toBe(
      'no-profile',
    );
  });

  it('is never fatal when the rename or the marker write fails', () => {
    // A marker path that is a directory makes the marker write fail after a
    // successful rename: the outcome stays `renamed`, the note says the next
    // start may rename again, and nothing throws.
    const profile = tempRoot('search-migration-marker-');
    writeFileSync(path.join(profile, library.SEARCH_PROFILE_FILENAME), 'old');
    mkdirSync(library.searchMigrationMarkerPath(profile));
    const result = library.migrateSearchProfile({ profileDir: profile });
    expect(result.status).toBe('renamed');
    expect(String(result.note)).toContain('could not write');
    expect(String(result.note)).toContain('may move it aside once more');
    expect(existsSync(path.join(profile, result.backup!))).toBe(true);
    expect(library.readSearchMigrationMarker(profile)).toBeNull();
    // A profile path that is a file, not a directory, is reported as no profile
    // and never throws.
    const file = path.join(tempRoot('search-migration-file-'), 'profile-file');
    writeFileSync(file, 'x');
    expect(() => library.migrateSearchProfile({ profileDir: file })).not.toThrow();
    expect(library.migrateSearchProfile({ profileDir: file }).status).toBe('no-file');
  });

  it.skipIf(process.platform === 'win32')(
    'reports a failed rename and keeps the file (POSIX write-protected profile)',
    () => {
      // Windows has no portable way to deny a rename for the same user, so the
      // failure branch is exercised on the POSIX CI runners.
      const locked = tempRoot('search-migration-locked-');
      writeFileSync(path.join(locked, library.SEARCH_PROFILE_FILENAME), 'old');
      chmodSync(locked, 0o500);
      try {
        const failed = library.migrateSearchProfile({ profileDir: locked });
        expect(failed.status).toBe('failed');
        expect(String(failed.note)).toContain('could not be moved aside');
        expect(readFileSync(path.join(locked, library.SEARCH_PROFILE_FILENAME), 'utf8')).toBe('old');
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );
});

describe('the overlay build mechanics', () => {
  it('plans a build without the whole tree and refuses an unusable source', () => {
    const fixture = buildFixture();
    const plan = overlays.planOverlay(fixture.buildDir);
    expect(plan.distribution).toBe(true);
    expect(plan.files.map((file) => file.name).sort()).toEqual(
      ['application.ini', 'camoufox.exe', 'version.json', 'xul.dll'].sort(),
    );
    expect(plan.directories.map((dir) => dir.name).sort()).toEqual(['browser', 'defaults', 'fonts']);
    expect(plan.totalBytes).toBe(
      ['camoufox.exe', 'xul.dll', 'application.ini', 'version.json'].reduce(
        (sum, name) => sum + statSync(path.join(fixture.buildDir, name)).size,
        0,
      ),
    );
    const noDistribution = buildFixture({ policyText: null });
    rmSync(path.join(noDistribution.buildDir, 'distribution'), { recursive: true, force: true });
    expect(() => overlays.planOverlay(noDistribution.buildDir)).toThrow(/no distribution/);
    const noExe = buildFixture();
    rmSync(path.join(noExe.buildDir, 'camoufox.exe'));
    expect(() => overlays.planOverlay(noExe.buildDir)).toThrow(/camoufox\.exe/);
    const collision = buildFixture();
    writeFileSync(path.join(collision.buildDir, overlays.OVERLAY_MARKER_FILENAME), '{}');
    expect(() => overlays.planOverlay(collision.buildDir)).toThrow(/marker/);
  });

  it('creates the hardlink and junction recipe with a real distribution directory', () => {
    const fixture = buildFixture();
    const { marker, tempDir } = createFixtureOverlay(fixture);
    expect(marker.mode).toBe('hardlink');
    expect(marker.files.every((file) => file.link === true)).toBe(true);
    // Files are hardlinks: same inode and link count > 1.
    for (const file of planNames(fixture)) {
      const source = statSync(path.join(fixture.buildDir, file));
      const dest = statSync(path.join(tempDir, file));
      expect(`${dest.dev}:${dest.ino}`).toBe(`${source.dev}:${source.ino}`);
      expect(dest.nlink).toBeGreaterThan(1);
    }
    // Directories are junctions to the build, not copies.
    for (const dir of ['browser', 'defaults', 'fonts']) {
      const stats = lstatSync(path.join(tempDir, dir));
      expect(stats.isSymbolicLink()).toBe(true);
      expect(readlinkSync(path.join(tempDir, dir)).toLowerCase()).toBe(
        path.join(fixture.buildDir, dir).toLowerCase(),
      );
      expect(existsSync(path.join(tempDir, dir, 'contents.txt'))).toBe(true);
    }
    // distribution is a REAL directory holding the probe policy.
    const distribution = lstatSync(path.join(tempDir, 'distribution'));
    expect(distribution.isDirectory()).toBe(true);
    expect(distribution.isSymbolicLink()).toBe(false);
    expect(readFileSync(overlays.overlayPolicyPath(tempDir), 'utf8')).toBe(PROBE_TEXT);
    // The marker is written, names the source build and lists every entry.
    const stored = JSON.parse(
      readFileSync(path.join(tempDir, overlays.OVERLAY_MARKER_FILENAME), 'utf8'),
    ) as OverlayMarker;
    expect(stored).toEqual(marker);
    expect(stored.sourceBuild).toBe(path.resolve(fixture.buildDir));
    expect(stored.files).toHaveLength(4);
    expect(stored.junctions).toHaveLength(3);
    // The source build is untouched: same bytes and no extra entries.
    expect(readFileSync(path.join(fixture.buildDir, 'xul.dll'), 'utf8')).toBe('fake-xul-bytes');
    expect(readdirSync(fixture.buildDir).sort()).toEqual([
      'application.ini',
      'browser',
      'camoufox.exe',
      'defaults',
      'distribution',
      'fonts',
      'version.json',
      'xul.dll',
    ]);
  });

  it('falls back to copies across volumes and keeps the mtime for the integrity check', () => {
    const fixture = buildFixture();
    const { marker, tempDir } = createFixtureOverlay(fixture, {
      link: () => {
        const error = new Error('cross-device link not permitted') as NodeJS.ErrnoException;
        error.code = 'EXDEV';
        throw error;
      },
      freeBytes: () => 4 * 1024 * 1024 * 1024,
    });
    expect(marker.mode).toBe('copy');
    expect(marker.files.every((file) => file.link === false)).toBe(true);
    for (const file of planNames(fixture)) {
      const source = statSync(path.join(fixture.buildDir, file));
      const dest = statSync(path.join(tempDir, file));
      expect(dest.ino).not.toBe(source.ino);
      expect(readFileSync(path.join(tempDir, file))).toEqual(readFileSync(path.join(fixture.buildDir, file)));
      expect(Math.abs(dest.mtimeMs - source.mtimeMs)).toBeLessThanOrEqual(2);
    }
  });

  it('guards a copy with free space and refuses without junctions', () => {
    const fixture = buildFixture();
    expect(() =>
      createFixtureOverlay(fixture, {
        link: () => {
          const error = new Error('cross-device link not permitted') as NodeJS.ErrnoException;
          error.code = 'EXDEV';
          throw error;
        },
        freeBytes: () => 1024,
      }),
    ).toThrow(/not enough free space/);
    expect(() =>
      createFixtureOverlay(fixture, {
        junction: () => {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        },
      }),
    ).toThrow(/junctions/);
    // Neither failed build left a usable target: only the temp trees exist.
    expect(overlays.readOverlayMarker(fixture.target).state).toBe('missing');
  });

  it('verifies a fresh overlay and detects every integrity change', () => {
    const fixture = buildFixture();
    const { marker, tempDir } = createFixtureOverlay(fixture);
    // The probe policy is recognised as ours and asks for the final document.
    const probeState = overlays.inspectOverlay({
      target: tempDir,
      marker,
      sourceDir: fixture.buildDir,
      sourcePolicyHash: library.sha256(BUILD_POLICY_TEXT),
      managedPolicyHash: library.sha256(MANAGED_TEXT),
      probePolicyHash: library.sha256(PROBE_TEXT),
    });
    expect(probeState).toMatchObject({ ok: true, needsFinalPolicy: true });
    library.writeFileAtomic(overlays.overlayPolicyPath(tempDir), MANAGED_TEXT);
    const good = overlays.inspectOverlay({
      target: tempDir,
      marker,
      sourceDir: fixture.buildDir,
      sourcePolicyHash: library.sha256(BUILD_POLICY_TEXT),
      managedPolicyHash: library.sha256(MANAGED_TEXT),
      probePolicyHash: library.sha256(PROBE_TEXT),
    });
    expect(good).toMatchObject({ ok: true, needsFinalPolicy: false });
    // A changed policy document.
    library.writeFileAtomic(overlays.overlayPolicyPath(tempDir), '{"policies":{"Foreign":true}}\n');
    const changed = overlays.inspectOverlay({
      target: tempDir,
      marker,
      sourceDir: fixture.buildDir,
      sourcePolicyHash: library.sha256(BUILD_POLICY_TEXT),
      managedPolicyHash: library.sha256(MANAGED_TEXT),
      probePolicyHash: library.sha256(PROBE_TEXT),
    });
    expect(changed.ok).toBe(false);
    expect(changed.reason).toContain('policy file changed');
    library.writeFileAtomic(overlays.overlayPolicyPath(tempDir), MANAGED_TEXT);

    // A missing file.
    rmSync(path.join(tempDir, 'xul.dll'));
    expect(
      overlays.inspectOverlay({
        target: tempDir,
        marker,
        sourceDir: fixture.buildDir,
        sourcePolicyHash: library.sha256(BUILD_POLICY_TEXT),
        managedPolicyHash: library.sha256(MANAGED_TEXT),
        probePolicyHash: library.sha256(PROBE_TEXT),
      }).reason,
    ).toContain('missing');

    // A changed size.
    const sizeFixture = buildFixture();
    const sizeOverlay = createFixtureOverlay(sizeFixture);
    library.writeFileAtomic(overlays.overlayPolicyPath(sizeOverlay.tempDir), MANAGED_TEXT);
    writeFileSync(path.join(sizeOverlay.tempDir, 'xul.dll'), 'longer-than-before');
    expect(
      overlays.inspectOverlay({
        target: sizeOverlay.tempDir,
        marker: sizeOverlay.marker,
        sourceDir: sizeFixture.buildDir,
        sourcePolicyHash: library.sha256(BUILD_POLICY_TEXT),
        managedPolicyHash: library.sha256(MANAGED_TEXT),
        probePolicyHash: library.sha256(PROBE_TEXT),
      }).reason,
    ).toContain('changed');

    // A changed mtime.
    const timeFixture = buildFixture();
    const timeOverlay = createFixtureOverlay(timeFixture);
    library.writeFileAtomic(overlays.overlayPolicyPath(timeOverlay.tempDir), MANAGED_TEXT);
    const future = new Date(Date.now() + 60_000);
    utimesSync(path.join(timeOverlay.tempDir, 'application.ini'), future, future);
    expect(
      overlays.inspectOverlay({
        target: timeOverlay.tempDir,
        marker: timeOverlay.marker,
        sourceDir: timeFixture.buildDir,
        sourcePolicyHash: library.sha256(BUILD_POLICY_TEXT),
        managedPolicyHash: library.sha256(MANAGED_TEXT),
        probePolicyHash: library.sha256(PROBE_TEXT),
      }).reason,
    ).toContain('changed');

    // A broken junction.
    const linkFixture = buildFixture();
    const linkOverlay = createFixtureOverlay(linkFixture);
    library.writeFileAtomic(overlays.overlayPolicyPath(linkOverlay.tempDir), MANAGED_TEXT);
    rmSync(path.join(linkOverlay.tempDir, 'browser'), { recursive: true });
    mkdirSync(path.join(linkOverlay.tempDir, 'browser'));
    expect(
      overlays.inspectOverlay({
        target: linkOverlay.tempDir,
        marker: linkOverlay.marker,
        sourceDir: linkFixture.buildDir,
        sourcePolicyHash: library.sha256(BUILD_POLICY_TEXT),
        managedPolicyHash: library.sha256(MANAGED_TEXT),
        probePolicyHash: library.sha256(PROBE_TEXT),
      }).reason,
    ).toContain('no longer a junction');
  });

  it('detects a source file re-extracted in place through the link identity', () => {
    const fixture = buildFixture();
    const { marker, tempDir } = createFixtureOverlay(fixture);
    library.writeFileAtomic(overlays.overlayPolicyPath(tempDir), MANAGED_TEXT);
    // Replace the source file with a new inode of the same bytes.
    const original = statSync(path.join(fixture.buildDir, 'xul.dll'));
    rmSync(path.join(fixture.buildDir, 'xul.dll'));
    writeFileSync(path.join(fixture.buildDir, 'xul.dll'), 'fake-xul-bytes');
    utimesSync(path.join(fixture.buildDir, 'xul.dll'), original.atime, original.mtime);
    const inspection = overlays.inspectOverlay({
      target: tempDir,
      marker,
      sourceDir: fixture.buildDir,
      sourcePolicyHash: library.sha256(BUILD_POLICY_TEXT),
      managedPolicyHash: library.sha256(MANAGED_TEXT),
      probePolicyHash: library.sha256(PROBE_TEXT),
    });
    expect(inspection.ok).toBe(false);
    expect(inspection.reason).toContain('no longer shares');
  });

  it('recognises only its own marker and never follows a link root', () => {
    const root = tempRoot('overlay-marker-');
    expect(overlays.readOverlayMarker(path.join(root, 'absent')).state).toBe('missing');
    mkdirSync(path.join(root, 'empty'));
    expect(overlays.readOverlayMarker(path.join(root, 'empty'))).toMatchObject({ state: 'foreign' });
    const otherEngine = path.join(root, 'other');
    mkdirSync(otherEngine);
    writeFileSync(
      path.join(otherEngine, overlays.OVERLAY_MARKER_FILENAME),
      JSON.stringify({ version: 1, engine: 'cloak', pluginOverlayFormat: 1 }),
    );
    expect(overlays.readOverlayMarker(otherEngine).state).toBe('foreign');
    const noVersion = path.join(root, 'noversion');
    mkdirSync(noVersion);
    writeFileSync(
      path.join(noVersion, overlays.OVERLAY_MARKER_FILENAME),
      JSON.stringify({ engine: 'camoufox', pluginOverlayFormat: 1 }),
    );
    expect(overlays.readOverlayMarker(noVersion).state).toBe('foreign');
    const linkRoot = path.join(root, 'linkroot');
    mkdirSync(path.join(root, 'target'));
    symlinkDirectory(path.join(root, 'target'), linkRoot);
    expect(overlays.readOverlayMarker(linkRoot)).toMatchObject({ state: 'foreign' });
    const fileRoot = path.join(root, 'file');
    writeFileSync(fileRoot, 'x');
    expect(overlays.readOverlayMarker(fileRoot)).toMatchObject({ state: 'foreign' });
  });

  it('removes only trees inside the overlay root with its own marker', () => {
    const fixture = buildFixture();
    const { tempDir } = createFixtureOverlay(fixture);
    renameSync(tempDir, `${fixture.target}.old-1`);
    renameSync(`${fixture.target}.old-1`, fixture.target);
    // Ours: removed, and the junction targets survive.
    const result = overlays.removeOverlay({ target: fixture.target, pluginDataDir: fixture.pluginData });
    expect(result.removed).toBe(true);
    expect(existsSync(fixture.target)).toBe(false);
    expect(existsSync(path.join(fixture.buildDir, 'browser', 'contents.txt'))).toBe(true);
    // Missing target counts as removed (nothing to do).
    expect(
      overlays.removeOverlay({ target: fixture.target, pluginDataDir: fixture.pluginData }).removed,
    ).toBe(true);
    // Outside the root: refused and untouched.
    const outside = path.join(fixture.root, 'outside');
    mkdirSync(outside);
    expect(overlays.removeOverlay({ target: outside, pluginDataDir: fixture.pluginData })).toMatchObject({
      removed: false,
    });
    expect(existsSync(outside)).toBe(true);
    // The overlay root itself: refused.
    expect(
      overlays.removeOverlay({
        target: overlays.overlayRoot(fixture.pluginData),
        pluginDataDir: fixture.pluginData,
      }).removed,
    ).toBe(false);
    // A foreign tree: refused and untouched.
    mkdirSync(fixture.target, { recursive: true });
    writeFileSync(path.join(fixture.target, 'keep.txt'), 'keep');
    expect(
      overlays.removeOverlay({ target: fixture.target, pluginDataDir: fixture.pluginData }).removed,
    ).toBe(false);
    expect(readFileSync(path.join(fixture.target, 'keep.txt'), 'utf8')).toBe('keep');
    // An in-use tree: reported, not forced.
    const inUseFixture = buildFixture();
    const inUse = createFixtureOverlay(inUseFixture);
    renameSync(inUse.tempDir, inUseFixture.target);
    const failed = overlays.removeOverlay({
      target: inUseFixture.target,
      pluginDataDir: inUseFixture.pluginData,
      rm: () => {
        const error = new Error('resource busy') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      },
    });
    expect(failed.removed).toBe(false);
    expect(failed.reason).toContain('EBUSY');
    expect(existsSync(inUseFixture.target)).toBe(true);
  });

  it('swaps atomically and reports a tree it cannot move aside', () => {
    const fixture = buildFixture();
    const first = createFixtureOverlay(fixture);
    renameSync(first.tempDir, fixture.target);
    const second = createFixtureOverlay(fixture, { tempName: 'build.tmp-2-fedcba' });
    const swap = overlays.swapOverlay({ tempDir: second.tempDir, target: fixture.target });
    expect(swap.reused).toBe(false);
    expect(overlays.readOverlayMarker(fixture.target).state).toBe('ours');
    expect(readdirSync(path.dirname(fixture.target)).filter((name) => name.includes('.old-'))).toEqual([]);
    // A tree that cannot be moved aside (reported as present, but missing) is an error.
    const third = createFixtureOverlay(fixture, { tempName: 'build.tmp-3-abcdef' });
    const ghost = path.join(fixture.pluginData, overlays.OVERLAY_ROOT_NAME, 'ghost');
    expect(() =>
      overlays.swapOverlay({
        tempDir: third.tempDir,
        target: ghost,
        readMarker: () => ({ state: 'ours', marker: null, reason: null }),
      }),
    ).toThrow(/in use/);
  });

  it('prunes older overlays only when their marker is ours and keeps one previous', () => {
    const fixture = buildFixture();
    const root = overlays.overlayRoot(fixture.pluginData);
    mkdirSync(root, { recursive: true });
    const names = ['current', 'previous', 'older'];
    for (const [index, name] of names.entries()) {
      const dir = path.join(root, name);
      mkdirSync(dir);
      writeFileSync(
        path.join(dir, overlays.OVERLAY_MARKER_FILENAME),
        JSON.stringify({
          version: 1,
          engine: 'camoufox',
          pluginOverlayFormat: 1,
          createdAt: `2026-10-2${names.length - index}T00:00:00Z`,
        }),
      );
    }
    mkdirSync(path.join(root, 'foreign'));
    writeFileSync(path.join(root, 'foreign', 'keep.txt'), 'keep');
    mkdirSync(path.join(root, 'stale.tmp-1-abcdef'));
    const result = overlays.pruneOverlays({ pluginDataDir: fixture.pluginData, currentName: 'current' });
    expect(result.kept).toEqual(['previous']);
    expect(result.removed).toEqual(['older']);
    expect(existsSync(path.join(root, 'current'))).toBe(true);
    expect(existsSync(path.join(root, 'previous'))).toBe(true);
    expect(existsSync(path.join(root, 'older'))).toBe(false);
    expect(readFileSync(path.join(root, 'foreign', 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(path.join(root, 'stale.tmp-1-abcdef'))).toBe(true);
    // An in-use older tree is reported and left.
    mkdirSync(path.join(root, 'older2'));
    writeFileSync(
      path.join(root, 'older2', overlays.OVERLAY_MARKER_FILENAME),
      JSON.stringify({
        version: 1,
        engine: 'camoufox',
        pluginOverlayFormat: 1,
        createdAt: '2026-10-20T00:00:00Z',
      }),
    );
    const failed = overlays.pruneOverlays({
      pluginDataDir: fixture.pluginData,
      currentName: 'current',
      rm: () => {
        const error = new Error('resource busy') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      },
    });
    expect(failed.removed).toEqual([]);
    expect(failed.failed.map((entry) => entry.name).sort()).toEqual(['older2']);
    expect(existsSync(path.join(root, 'older2'))).toBe(true);
  });

  it('cleans only its own stale temp trees', () => {
    const fixture = buildFixture();
    const root = overlays.overlayRoot(fixture.pluginData);
    mkdirSync(root, { recursive: true });
    const stale = path.join(root, 'build.tmp-1-abcdef');
    const fresh = path.join(root, 'build.tmp-2-abcdef');
    mkdirSync(stale);
    mkdirSync(fresh);
    writeFileSync(
      path.join(stale, 'overlay.json'),
      JSON.stringify({ version: 1, engine: 'camoufox', pluginOverlayFormat: 1 }),
    );
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    const result = overlays.cleanStaleTemps({ pluginDataDir: fixture.pluginData });
    expect(result.removed).toEqual(['build.tmp-1-abcdef']);
    expect(existsSync(fresh)).toBe(true);
    mkdirSync(path.join(root, 'not-a-temp'));
    expect(overlays.cleanStaleTemps({ pluginDataDir: fixture.pluginData }).removed).not.toContain(
      'not-a-temp',
    );
  });
});

function planNames(_fixture: Fixture): string[] {
  return ['application.ini', 'camoufox.exe', 'version.json', 'xul.dll'];
}

function symlinkDirectory(target: string, link: string): void {
  // A Windows junction needs no privilege; POSIX treats the type as a directory link.
  symlinkSync(target, link, 'junction');
}

// --- the apply flow --------------------------------------------------------
describe('applyPasswordManager', () => {
  it('is always on for camoufox: password off still builds the search overlay, with no password key', async () => {
    for (const value of [undefined, '', 'false', '0', 'no', 'off']) {
      const fixture = buildFixture();
      const run = await runApply(fixture, { env: { STEALTH_PASSWORD_MANAGER: value } });
      expect(run.result.status, `${String(value)}`).toBe('applied');
      expect(run.probeCalls, `${String(value)}`).toBe(1);
      // The overlay is in use for the search transform; the password state
      // variable (which makes the entry merge signon prefs) is never set.
      expect(run.env.STEALTH_PASSWORD_MANAGER_STATE).toBeUndefined();
      expect(run.env.STEALTH_CAMOUFOX_OVERLAY_STATE).toBe('applied');
      expect(run.result.executable).toBe(overlays.overlayExecutablePath(fixture.target));
      expect(readFileSync(overlays.overlayPolicyPath(fixture.target), 'utf8')).toBe(SEARCH_MANAGED_TEXT);
      const stored = record(fixture)!;
      expect(stored).toMatchObject({
        status: 'applied',
        passwordOn: false,
        searchSource: 'overlay',
        searchDefault: 'Google',
        searchMigration: 'no-profile',
      });
      expect(readFileSync(overlays.overlayPolicyPath(fixture.target), 'utf8')).toContain(
        '"Default": "Google"',
      );
      expect(readFileSync(overlays.overlayPolicyPath(fixture.target), 'utf8')).toContain(
        '"PasswordManagerEnabled": false',
      );
    }
  });

  it('builds the search overlay even when the user config cannot carry the signon prefs', async () => {
    // password_manager off: the INI config never blocks the search restore.
    const fixture = buildFixture();
    const ini = path.join(fixture.root, 'user.ini');
    writeFileSync(ini, 'browser = camoufox\n');
    const off = await runApply(fixture, {
      env: { STEALTH_PASSWORD_MANAGER: 'false', CAMOUFOX_MCP_CONFIG: ini },
    });
    expect(off.result.status).toBe('applied');
    expect(readFileSync(ini, 'utf8')).toBe('browser = camoufox\n');
    // password_manager on: the setting is all-or-nothing, so the prefs path
    // blocks before anything is created (unchanged 2.16 behaviour).
    const second = buildFixture();
    const ini2 = path.join(second.root, 'user.ini');
    writeFileSync(ini2, 'browser = camoufox\n');
    const on = await runApply(second, { env: { CAMOUFOX_MCP_CONFIG: ini2 } });
    expect(on.result.status).toBe('blocked-config');
    expect(existsSync(overlays.overlayRoot(second.pluginData))).toBe(false);
  });

  it('creates the overlay, proves it with one probe and records ownership', async () => {
    const fixture = buildFixture();
    const run = await runApply(fixture);
    expect(run.result.status).toBe('applied');
    expect(run.result.executable).toBe(overlays.overlayExecutablePath(fixture.target));
    expect(run.result.overlay).toBe(fixture.target);
    expect(run.result.overlayMode).toBe('hardlink');
    expect(run.result.policyFile).toBe(overlays.overlayPolicyPath(fixture.target));
    expect(run.env.STEALTH_PASSWORD_MANAGER_STATE).toBe('overlay');
    expect(run.probeCalls).toBe(1);
    expect(run.probeBinaries).toEqual([overlays.overlayExecutablePath(fixture.target)]);
    // The final policy, never the temporary verification document.
    expect(readFileSync(overlays.overlayPolicyPath(fixture.target), 'utf8')).toBe(MANAGED_TEXT);
    expect(readFileSync(overlays.overlayPolicyPath(fixture.target), 'utf8')).not.toContain('Permissions');
    const stored = record(fixture)!;
    expect(stored).toMatchObject({
      version: 1,
      engine: 'camoufox',
      status: 'applied',
      build: fixture.build,
      overlay: fixture.target,
      policyFile: overlays.overlayPolicyPath(fixture.target),
      sourcePolicyHash: library.sha256(BUILD_POLICY_TEXT),
      managedPolicyHash: library.sha256(MANAGED_TEXT),
      probePolicyHash: library.sha256(PROBE_TEXT),
      overlayFormat: overlays.OVERLAY_FORMAT,
      mode: 'hardlink',
      verified: true,
    });
    expect(typeof stored.verifiedAt).toBe('string');
    expect(stored).toMatchObject({
      passwordOn: true,
      searchSource: 'overlay',
      searchDefault: 'Google',
      searchMigration: 'no-profile',
    });
    const marker = JSON.parse(
      readFileSync(path.join(fixture.target, overlays.OVERLAY_MARKER_FILENAME), 'utf8'),
    ) as OverlayMarker;
    expect(marker.verifiedAt).toBe(stored.verifiedAt);
    expect(run.logs.join('\n')).toContain('camoufox overlay enabled');
    expect(run.logs.join('\n')).toContain('search block replaced');
    // The source build is untouched.
    expect(readFileSync(path.join(fixture.buildDir, 'distribution', 'policies.json'), 'utf8')).toBe(
      BUILD_POLICY_TEXT,
    );
  });

  it('reuses a verified overlay on the next start without another probe', async () => {
    const fixture = buildFixture();
    expect((await runApply(fixture)).probeCalls).toBe(1);
    const before = readFileSync(overlays.overlayPolicyPath(fixture.target), 'utf8');
    const second = await runApply(fixture);
    expect(second.result.status).toBe('applied');
    expect(second.probeCalls).toBe(0);
    expect(second.result.executable).toBe(overlays.overlayExecutablePath(fixture.target));
    expect(readFileSync(overlays.overlayPolicyPath(fixture.target), 'utf8')).toBe(before);
  });

  it('rebuilds when the build policy changes and verifies the new document', async () => {
    const fixture = buildFixture();
    await runApply(fixture);
    const changed = {
      ...BUILD_POLICY,
      policies: { ...BUILD_POLICY.policies, DisablePocket: true },
    };
    const changedText = `${JSON.stringify(changed, null, 2)}\n`;
    writeFileSync(path.join(fixture.buildDir, 'distribution', 'policies.json'), changedText);
    const second = await runApply(fixture);
    expect(second.result.status).toBe('applied');
    expect(second.probeCalls).toBe(1);
    expect(readFileSync(overlays.overlayPolicyPath(fixture.target), 'utf8')).toBe(
      library.policyBytes(library.managedPolicy(changed, { passwordOn: true })),
    );
    expect(record(fixture)).toMatchObject({ sourcePolicyHash: library.sha256(changedText) });
  });

  it('rebuilds a tampered overlay from the same build without a second probe', async () => {
    const fixture = buildFixture();
    await runApply(fixture);
    // Break the hardlink, so the overlay entry is a different file from the build's.
    rmSync(path.join(fixture.target, 'xul.dll'));
    writeFileSync(path.join(fixture.target, 'xul.dll'), 'tampered-bytes');
    const second = await runApply(fixture);
    expect(second.result.status).toBe('applied');
    expect(second.probeCalls).toBe(0);
    expect(readFileSync(path.join(fixture.target, 'xul.dll'), 'utf8')).toBe('fake-xul-bytes');
  });

  it('repairs a probe document left by an interrupted start without a probe', async () => {
    const fixture = buildFixture();
    await runApply(fixture);
    writeFileSync(overlays.overlayPolicyPath(fixture.target), PROBE_TEXT);
    const second = await runApply(fixture);
    expect(second.result.status).toBe('applied');
    expect(second.probeCalls).toBe(0);
    expect(readFileSync(overlays.overlayPolicyPath(fixture.target), 'utf8')).toBe(MANAGED_TEXT);
  });

  it('removes the overlay and caches a definitive prompt failure', async () => {
    const fixture = buildFixture();
    const first = await runApply(fixture, { probe: async () => ({ state: 'prompt' }) });
    expect(first.result.status).toBe('blocked-by-overlay');
    expect(first.result.executable).toBe(fixture.binary);
    expect(existsSync(fixture.target)).toBe(false);
    expect(first.env.STEALTH_PASSWORD_MANAGER_STATE).toBeUndefined();
    expect(record(fixture)).toMatchObject({
      status: 'blocked-by-overlay',
      failure: 'probe',
      overlay: null,
      verified: false,
    });
    expect(first.logs.join('\n')).toContain('did not read its policy');
    const second = await runApply(fixture);
    expect(second.result.status).toBe('blocked-by-overlay');
    expect(second.probeCalls).toBe(0);
    expect(existsSync(fixture.target)).toBe(false);
    // 2.17.0: turning password_manager off produces a different managed document
    // (no password keys), so it is a new policy and is verified fresh - the
    // cached `prompt` belongs to the password-on document only.
    const off = await runApply(fixture, { env: { STEALTH_PASSWORD_MANAGER: 'false' } });
    expect(off.result.status).toBe('applied');
    expect(off.probeCalls).toBe(1);
    // A build-policy change is a new document and retries the probe too.
    const changed = {
      ...BUILD_POLICY,
      policies: { ...BUILD_POLICY.policies, DisablePocket: true },
    };
    writeFileSync(
      path.join(fixture.buildDir, 'distribution', 'policies.json'),
      `${JSON.stringify(changed, null, 2)}\n`,
    );
    expect((await runApply(fixture)).probeCalls).toBe(1);
  });

  it.each([
    ['granted', { state: 'granted' }],
    ['error', { state: 'error', detail: 'launch failed' }],
    ['timeout', { state: 'timeout', detail: 'no answer within 60 s' }],
  ])('keeps the overlay with the final policy when verification says %s', async (_name, probeResult) => {
    const fixture = buildFixture();
    const first = await runApply(fixture, { probe: async () => probeResult });
    expect(first.result.status).toBe('blocked-by-overlay');
    expect(first.result.executable).toBe(fixture.binary);
    expect(existsSync(fixture.target)).toBe(true);
    expect(readFileSync(overlays.overlayPolicyPath(fixture.target), 'utf8')).toBe(MANAGED_TEXT);
    expect(record(fixture)).toMatchObject({
      status: 'blocked-by-overlay',
      failure: 'transient',
      overlay: fixture.target,
      verified: false,
    });
    // Not cached: the next start probes again, and a success turns it on.
    const second = await runApply(fixture);
    expect(second.probeCalls).toBe(1);
    expect(second.result.status).toBe('applied');
  });

  it('reverts when the probe helper throws, and retries next start', async () => {
    const fixture = buildFixture();
    const run = await runApply(fixture, {
      probe: async () => {
        throw new Error('probe crashed');
      },
    });
    expect(run.result.status).toBe('blocked-by-overlay');
    expect(run.result.executable).toBe(fixture.binary);
    expect(existsSync(fixture.target)).toBe(true);
    expect(readFileSync(overlays.overlayPolicyPath(fixture.target), 'utf8')).toBe(MANAGED_TEXT);
    expect((await runApply(fixture)).result.status).toBe('applied');
  });

  it('never overwrites a foreign directory at the overlay path', async () => {
    const fixture = buildFixture();
    mkdirSync(fixture.target, { recursive: true });
    writeFileSync(path.join(fixture.target, 'keep.txt'), 'keep');
    const run = await runApply(fixture);
    expect(run.result.status).toBe('blocked-by-existing-overlay');
    expect(run.probeCalls).toBe(0);
    expect(readFileSync(path.join(fixture.target, 'keep.txt'), 'utf8')).toBe('keep');
    expect(record(fixture)).toMatchObject({ status: 'blocked-by-existing-overlay', overlay: fixture.target });
  });

  it('refuses a junction at the overlay path', async () => {
    const fixture = buildFixture();
    mkdirSync(overlays.overlayRoot(fixture.pluginData), { recursive: true });
    mkdirSync(path.join(fixture.root, 'elsewhere'));
    symlinkDirectory(path.join(fixture.root, 'elsewhere'), fixture.target);
    const run = await runApply(fixture);
    expect(run.result.status).toBe('blocked-by-existing-overlay');
    expect(existsSync(path.join(fixture.root, 'elsewhere'))).toBe(true);
  });

  it('reports a junction failure and leaves no target', async () => {
    const fixture = buildFixture();
    const run = await runApply(fixture, {
      overlayOps: {
        junction: () => {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        },
      },
    });
    expect(run.result.status).toBe('blocked-by-overlay');
    expect(run.result.executable).toBe(fixture.binary);
    expect(overlays.readOverlayMarker(fixture.target).state).toBe('missing');
    expect(run.logs.join('\n')).toContain('junctions');
    expect(record(fixture)).toMatchObject({ status: 'blocked-by-overlay', failure: 'junction' });
  });

  it('reports a free-space failure for the copy fallback', async () => {
    const fixture = buildFixture();
    const run = await runApply(fixture, {
      overlayOps: {
        link: () => {
          const error = new Error('cross-device link not permitted') as NodeJS.ErrnoException;
          error.code = 'EXDEV';
          throw error;
        },
        freeBytes: () => 1024,
      },
    });
    expect(run.result.status).toBe('blocked-by-overlay');
    expect(overlays.readOverlayMarker(fixture.target).state).toBe('missing');
    expect(run.logs.join('\n')).toContain('free space');
    expect(record(fixture)).toMatchObject({ failure: 'space' });
  });

  it('uses the stock build with the signon prefs when the build needs neither transform', async () => {
    const unlocked = {
      ...BUILD_POLICY,
      policies: {
        ...BUILD_POLICY.policies,
        PasswordManagerEnabled: true,
        OfferToSaveLogins: true,
        SearchEngines: undefined,
      },
    };
    delete (unlocked.policies as Record<string, unknown>).SearchEngines;
    const fixture = buildFixture({ policyText: `${JSON.stringify(unlocked, null, 2)}\n` });
    const run = await runApply(fixture);
    expect(run.result.status).toBe('prefs');
    expect(run.result.executable).toBe(fixture.binary);
    expect(run.result.overlay).toBeNull();
    expect(run.env.STEALTH_PASSWORD_MANAGER_STATE).toBe('prefs');
    expect(run.env.STEALTH_CAMOUFOX_OVERLAY_STATE).toBe('stock');
    expect(run.probeCalls).toBe(0);
    expect(existsSync(overlays.overlayRoot(fixture.pluginData))).toBe(false);
    expect(record(fixture)).toMatchObject({
      status: 'prefs',
      verified: true,
      searchSource: 'stock',
      overlay: null,
    });
    // With the setting off the same build reports `stock`: nothing to apply and
    // no state variable for the entry point.
    const off = await runApply(fixture, { env: { STEALTH_PASSWORD_MANAGER: 'false' } });
    expect(off.result.status).toBe('stock');
    expect(off.result.searchSource).toBe('stock');
    expect(off.env.STEALTH_PASSWORD_MANAGER_STATE).toBeUndefined();
    expect(off.env.STEALTH_CAMOUFOX_OVERLAY_STATE).toBe('stock');
    expect(off.probeCalls).toBe(0);
    expect(record(fixture)).toMatchObject({ status: 'stock', searchSource: 'stock' });
  });

  it('retires an overlay an older policy needed when the build no longer needs one', async () => {
    const fixture = buildFixture();
    expect((await runApply(fixture)).result.status).toBe('applied');
    expect(existsSync(fixture.target)).toBe(true);
    const permissive = {
      ...BUILD_POLICY,
      policies: { ...BUILD_POLICY.policies, SearchEngines: undefined },
    };
    delete (permissive.policies as Record<string, unknown>).SearchEngines;
    writeFileSync(
      path.join(fixture.buildDir, 'distribution', 'policies.json'),
      `${JSON.stringify(permissive, null, 2)}\n`,
    );
    const second = await runApply(fixture, { env: { STEALTH_PASSWORD_MANAGER: 'false' } });
    // The overlay is retired (marker + containment + no-follow) and the stock
    // build runs; nothing is left to apply.
    expect(second.result.status).toBe('stock');
    expect(existsSync(fixture.target)).toBe(false);
    expect(existsSync(path.join(fixture.buildDir, 'browser', 'contents.txt'))).toBe(true);
    expect(second.logs.join('\n')).toContain('needs none');
  });

  it('refuses a build without a readable policy document', async () => {
    const missing = buildFixture({ policyText: null });
    const missingRun = await runApply(missing);
    expect(missingRun.result.status).toBe('blocked-by-build-policy');
    expect(missingRun.result.executable).toBe(missing.binary);
    expect(existsSync(missing.target)).toBe(false);
    const invalid = buildFixture({ policyText: '{not json' });
    const invalidRun = await runApply(invalid);
    expect(invalidRun.result.status).toBe('blocked-by-build-policy');
    expect(existsSync(invalid.target)).toBe(false);
  });

  it('refuses an INI user config before creating anything', async () => {
    const fixture = buildFixture();
    const ini = path.join(fixture.root, 'user.ini');
    writeFileSync(ini, 'browser = camoufox\n');
    const run = await runApply(fixture, { env: { CAMOUFOX_MCP_CONFIG: ini } });
    expect(run.result.status).toBe('blocked-config');
    expect(run.probeCalls).toBe(0);
    expect(existsSync(overlays.overlayRoot(fixture.pluginData))).toBe(false);
    expect(run.env.STEALTH_PASSWORD_MANAGER_STATE).toBeUndefined();
    expect(record(fixture)).toMatchObject({ status: 'blocked-config' });
  });

  it('refuses the overlay on a platform without its link recipe', async () => {
    const fixture = buildFixture();
    const run = await runApply(fixture, { platform: 'linux' });
    expect(run.result.status).toBe('blocked-by-overlay');
    expect(run.result.executable).toBe(fixture.binary);
    expect(run.probeCalls).toBe(0);
    expect(existsSync(overlays.overlayRoot(fixture.pluginData))).toBe(false);
    expect(record(fixture)).toMatchObject({ failure: 'platform' });
  });

  it('keeps the overlay when the setting is turned off and rewrites the policy without the password keys', async () => {
    const fixture = buildFixture();
    expect((await runApply(fixture)).result.status).toBe('applied');
    expect(existsSync(fixture.target)).toBe(true);
    expect(readFileSync(overlays.overlayPolicyPath(fixture.target), 'utf8')).toBe(MANAGED_TEXT);
    const off = await runApply(fixture, { env: { STEALTH_PASSWORD_MANAGER: 'false' } });
    expect(off.result.status).toBe('applied');
    // The overlay is still there (search needs it) and the managed document no
    // longer carries the two password values.
    expect(existsSync(fixture.target)).toBe(true);
    expect(readFileSync(overlays.overlayPolicyPath(fixture.target), 'utf8')).toBe(SEARCH_MANAGED_TEXT);
    expect(off.env.STEALTH_PASSWORD_MANAGER_STATE).toBeUndefined();
    expect(record(fixture)).toMatchObject({ status: 'applied', passwordOn: false });
    // Junction targets survive every rebuild.
    expect(existsSync(path.join(fixture.buildDir, 'browser', 'contents.txt'))).toBe(true);
  });

  it('leaves a foreign tree untouched on every start, setting on or off', async () => {
    const fixture = buildFixture();
    mkdirSync(fixture.target, { recursive: true });
    writeFileSync(path.join(fixture.target, 'keep.txt'), 'keep');
    library.writePasswordPolicyRecord(fixture.pluginData, {
      version: 1,
      engine: 'camoufox',
      status: 'blocked-by-existing-overlay',
      build: fixture.build,
      overlay: fixture.target,
      note: 'foreign',
    });
    const off = await runApply(fixture, { env: { STEALTH_PASSWORD_MANAGER: 'false' } });
    expect(off.result.status).toBe('blocked-by-existing-overlay');
    expect(readFileSync(path.join(fixture.target, 'keep.txt'), 'utf8')).toBe('keep');
    // The record is rewritten as the current outcome, not deleted.
    expect(record(fixture)).toMatchObject({ status: 'blocked-by-existing-overlay' });
    expect(off.env.STEALTH_PASSWORD_MANAGER_STATE).toBeUndefined();
    expect(off.env.STEALTH_CAMOUFOX_OVERLAY_STATE).toBe('blocked');
  });

  it('logs one honest line for an unusable setting value and still restores search', async () => {
    const fixture = buildFixture();
    const run = await runApply(fixture, { env: { STEALTH_PASSWORD_MANAGER: 'maybe' } });
    expect(run.result.status).toBe('applied');
    expect(run.logs.join('\n')).toContain('not a boolean');
    expect(run.logs.join('\n')).toContain('camoufox overlay enabled');
    expect(run.env.STEALTH_PASSWORD_MANAGER_STATE).toBeUndefined();
    expect(readFileSync(overlays.overlayPolicyPath(fixture.target), 'utf8')).toBe(SEARCH_MANAGED_TEXT);
  });

  it('runs the one-time search migration on the resolved profile and reports it', async () => {
    const fixture = buildFixture();
    const profile = path.join(fixture.root, 'profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(path.join(profile, 'search.json.mozlz4'), 'old-engine-list');
    const first = await runApply(fixture, {
      env: { STEALTH_PASSWORD_MANAGER: 'false' },
      profileDir: profile,
    });
    expect(first.result.status).toBe('applied');
    expect(first.result.searchMigration).toBe('renamed');
    expect(String(first.result.searchBackupFile)).toMatch(/^search\.json\.mozlz4\.backup-/u);
    expect(existsSync(path.join(profile, 'search.json.mozlz4'))).toBe(false);
    expect(readFileSync(path.join(profile, String(first.result.searchBackupFile)), 'utf8')).toBe(
      'old-engine-list',
    );
    const stored = record(fixture)!;
    expect(stored).toMatchObject({ searchMigration: 'renamed' });
    expect(String(stored.searchNote)).toContain('backup');
    // The next start reuses the overlay and reports the marker.
    const second = await runApply(fixture, {
      env: { STEALTH_PASSWORD_MANAGER: 'false' },
      profileDir: profile,
    });
    expect(second.result.searchMigration).toBe('already');
    expect(second.probeCalls).toBe(0);
  });

  it('never migrates when the overlay is stock or blocked', async () => {
    const permissive = {
      ...BUILD_POLICY,
      policies: { ...BUILD_POLICY.policies, PasswordManagerEnabled: true, OfferToSaveLogins: true },
    };
    delete (permissive.policies as Record<string, unknown>).SearchEngines;
    const stockFixture = buildFixture({ policyText: `${JSON.stringify(permissive, null, 2)}\n` });
    const profile = path.join(stockFixture.root, 'profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(path.join(profile, 'search.json.mozlz4'), 'old');
    const stock = await runApply(stockFixture, {
      env: { STEALTH_PASSWORD_MANAGER: 'false' },
      profileDir: profile,
    });
    expect(stock.result.status).toBe('stock');
    expect(existsSync(path.join(profile, 'search.json.mozlz4'))).toBe(true);
    // A blocked overlay leaves the profile untouched too.
    const blockedFixture = buildFixture();
    mkdirSync(blockedFixture.target, { recursive: true });
    writeFileSync(path.join(blockedFixture.target, 'keep.txt'), 'keep');
    const blockedProfile = path.join(blockedFixture.root, 'profile');
    mkdirSync(blockedProfile, { recursive: true });
    writeFileSync(path.join(blockedProfile, 'search.json.mozlz4'), 'old');
    const blocked = await runApply(blockedFixture, {
      env: { STEALTH_PASSWORD_MANAGER: 'false' },
      profileDir: blockedProfile,
    });
    expect(blocked.result.status).toBe('blocked-by-existing-overlay');
    expect(blocked.result.searchSource).toBe('blocked');
    expect(existsSync(path.join(blockedProfile, 'search.json.mozlz4'))).toBe(true);
  });
});

// --- the retained per-user route (2.15.0, unreachable in 2.17.0) -----------
// 2.15.1 withdrew this route from every shipped platform; 2.17.0 keeps the code,
// exported and covered, so a future build with a readable per-user policy
// directory can use it unchanged. It is not part of the shipped flow.
interface PerUserFixture {
  root: string;
  pluginData: string;
  binary: string;
  build: string;
  localAppData: string;
  target: string;
}

function perUserFixture(): PerUserFixture {
  const root = tempRoot('password-per-user-');
  const localAppData = path.join(root, 'local-app-data');
  const buildDir = path.join(
    localAppData,
    'Camoufox',
    'Camoufox',
    'Cache',
    'browsers',
    'official',
    '156.0.1-beta.39-b38343bc',
  );
  mkdirSync(path.join(buildDir, 'distribution'), { recursive: true });
  writeFileSync(path.join(buildDir, 'camoufox.exe'), 'fake-executable');
  writeFileSync(path.join(buildDir, 'distribution', 'policies.json'), BUILD_POLICY_TEXT);
  return {
    root,
    pluginData: path.join(root, 'plugin-data'),
    binary: path.join(buildDir, 'camoufox.exe'),
    build: 'v156.0.1-beta.39',
    localAppData,
    target: path.join(localAppData, 'Camoufox', 'Camoufox', 'policies.json'),
  };
}

async function runPerUser(
  fixture: PerUserFixture,
  options: {
    env?: Record<string, string | undefined>;
    probe?: () => Promise<Record<string, unknown>>;
    resolvePath?: () => Record<string, unknown> | null;
  } = {},
): Promise<{ result: ApplyResult; probeCalls: number; logs: string[] }> {
  const env: Record<string, string | undefined> = {
    STEALTH_PASSWORD_MANAGER: 'true',
    ...(options.env ?? {}),
  };
  let probeCalls = 0;
  const logs: string[] = [];
  const result = await library.applyPerUserPolicyFile({
    env,
    pluginDataDir: fixture.pluginData,
    binary: fixture.binary,
    build: fixture.build,
    python: 'python',
    bootstrap: 'camoufox_bootstrap.py',
    log: (message: unknown) => logs.push(String(message)),
    resolvePath: options.resolvePath ?? (() => ({ localAppData: fixture.localAppData })),
    probe: async () => {
      probeCalls += 1;
      return options.probe === undefined ? { state: 'denied' } : options.probe();
    },
  });
  return { result, probeCalls, logs };
}

describe('the retained per-user policy-file route', () => {
  it('writes the managed file once, verifies it and records ownership', async () => {
    const fixture = perUserFixture();
    const first = await runPerUser(fixture);
    expect(first.result.status).toBe('applied');
    expect(first.probeCalls).toBe(1);
    expect(readFileSync(fixture.target, 'utf8')).toBe(MANAGED_TEXT);
    const stored = record({ pluginData: fixture.pluginData } as unknown as Fixture)!;
    expect(stored).toMatchObject({ status: 'applied', policyFile: fixture.target, verified: true });
    // A second start reuses the record without another browser start.
    const second = await runPerUser(fixture);
    expect(second.result.status).toBe('applied');
    expect(second.probeCalls).toBe(0);
  });

  it('refuses a file it did not write and never overwrites it', async () => {
    const fixture = perUserFixture();
    const foreign = '{"policies":{"PasswordManagerEnabled":true}}\n';
    writeFileSync(fixture.target, foreign);
    const run = await runPerUser(fixture);
    expect(run.result.status).toBe('blocked-by-existing-policy');
    expect(readFileSync(fixture.target, 'utf8')).toBe(foreign);
    expect(run.probeCalls).toBe(0);
  });

  it('removes the file and caches a definitive verification failure', async () => {
    const fixture = perUserFixture();
    const first = await runPerUser(fixture, { probe: async () => ({ state: 'prompt' }) });
    expect(first.result.status).toBe('blocked-by-build-policy');
    expect(existsSync(fixture.target)).toBe(false);
    const second = await runPerUser(fixture);
    expect(second.probeCalls).toBe(0);
    expect(second.result.status).toBe('blocked-by-build-policy');
  });

  it('never resolves a path when LocalAppData is unavailable', async () => {
    const fixture = perUserFixture();
    const run = await runPerUser(fixture, { resolvePath: () => null });
    expect(run.result.status).toBe('blocked-by-build-policy');
    expect(existsSync(fixture.target)).toBe(false);
    expect(run.probeCalls).toBe(0);
  });
});

// --- the launcher ----------------------------------------------------------
describe('launcher wiring', () => {
  it('wires only the camoufox launcher to the helper and to its executable', () => {
    const source = readFileSync(path.join(universalDir, 'launch-camoufox.mjs'), 'utf8');
    expect(source).toContain("from './lib/password-manager.mjs'");
    expect(source).toContain('applyCamoufoxOverlay({');
    expect(source).toContain('profileDir:');
    expect(source).toContain('overlay.executable');
    for (const launcher of ['launch.mjs', 'launch-camoufox-native.mjs', 'launch-kameleo.mjs']) {
      const other = readFileSync(path.join(universalDir, launcher), 'utf8');
      expect(other).not.toContain('password-manager.mjs');
      expect(other).not.toContain('applyCamoufoxOverlay');
    }
  });

  it('adds no password state variable when the setting is off', () => {
    for (const value of [undefined, '', 'false', '0', 'no', 'off']) {
      const env = camoufoxLauncher.buildChildEnv({
        PLAYWRIGHT_MCP_HEADLESS: 'false',
        ...(value === undefined ? {} : { STEALTH_PASSWORD_MANAGER: value }),
      });
      expect(env.STEALTH_PASSWORD_MANAGER_STATE, `${String(value)}`).toBeUndefined();
      expect(env.STEALTH_CAMOUFOX_OVERLAY_STATE, `${String(value)}`).toBeUndefined();
      expect(env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS).toBe('0');
    }
  });

  it.each(['cloakbrowser', 'camoufox'])('ships %s byte-identical overlay helpers', (name) => {
    for (const file of ['camoufox-overlay.mjs', 'password-manager.mjs']) {
      const canonical = readFileSync(path.join(repoRoot, 'shared', 'core', 'lib', file));
      const copy = path.join(repoRoot, 'plugins', name, 'lib', file);
      expect(existsSync(copy), `${name}/${file}`).toBe(true);
      expect(readFileSync(copy).equals(canonical), `${name}/${file}`).toBe(true);
    }
  });
});

// --- the Python entry logic ------------------------------------------------
describe('the Python saved-login logic', () => {
  it('runs the Python suite for the three prefs and the executable-path strip', () => {
    const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
    let python: string | null = null;
    for (const candidate of candidates) {
      const result = spawnSync(candidate, ['--version'], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      if (result.status === 0 && /Python 3\.\d+/u.test(`${result.stdout ?? ''}${result.stderr ?? ''}`)) {
        python = candidate;
        break;
      }
    }
    if (python === null) {
      return;
    }
    const result = spawnSync(python, ['-I', pythonSuitePath], {
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(output).toContain('RESULT');
    expect(output).toContain('0 failed');
    expect(result.status).toBe(0);
  });
});

// --- the broker report -----------------------------------------------------
function createStubPlugin(root: string): string {
  const plugin = path.join(root, 'plugin');
  const engines = path.join(plugin, 'engines');
  const lib = path.join(plugin, 'lib');
  mkdirSync(engines, { recursive: true });
  mkdirSync(lib, { recursive: true });
  mkdirSync(path.join(plugin, 'contracts'), { recursive: true });
  for (const file of ['broker.mjs', 'engine-registry.mjs']) {
    copyFileSync(path.join(universalDir, file), path.join(plugin, file));
  }
  for (const file of [
    'attach.mjs',
    'camoufox-overlay.mjs',
    'password-manager.mjs',
    'ping-timeout.mjs',
    'profile.mjs',
    'provision.mjs',
    'surface.mjs',
    'tool-cache.mjs',
  ]) {
    copyFileSync(path.join(universalDir, 'lib', file), path.join(lib, file));
  }
  for (const file of ['camoufox.json', 'cloak.json', 'camoufox-native.json']) {
    copyFileSync(path.join(universalDir, 'engines', file), path.join(engines, file));
  }
  copyFileSync(path.join(universalDir, 'engines', 'profiles.json'), path.join(engines, 'profiles.json'));
  copyFileSync(
    path.join(universalDir, 'contracts', 'playwright-canonical.json'),
    path.join(plugin, 'contracts', 'playwright-canonical.json'),
  );
  for (const launcher of ['launch.mjs', 'launch-camoufox.mjs', 'launch-camoufox-native.mjs']) {
    writeFileSync(path.join(plugin, launcher), STUB_SOURCE);
  }
  return plugin;
}

function startBroker(options: {
  pluginDir: string;
  dataDir: string;
  engine: string;
  env?: Record<string, string>;
}): BrokerSession {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: options.dataDir,
    STEALTH_ENGINE: options.engine,
    STEALTH_TOOL_PROFILE: 'full',
    PLAYWRIGHT_MCP_OUTPUT_DIR: path.join(options.dataDir, 'artifacts'),
    ...(options.env ?? {}),
  };
  for (const name of [
    'STEALTH_ACCOUNT',
    'STEALTH_PROFILE_ISOLATION',
    'STEALTH_IDENTITY_MODE',
    'STEALTH_PING_TIMEOUT_MS',
    'STEALTH_PASSWORD_MANAGER',
    'STEALTH_PASSWORD_MANAGER_STATE',
    'PLAYWRIGHT_MCP_PING_TIMEOUT_MS',
    'PLAYWRIGHT_MCP_USER_DATA_DIR',
    'PLAYWRIGHT_MCP_ISOLATED',
    'CAMOUFOX_MCP_CONFIG',
    'PLAYWRIGHT_MCP_CONFIG',
  ]) {
    if (!(name in (options.env ?? {}))) {
      delete env[name];
    }
  }
  const child = spawn(process.execPath, [path.join(options.pluginDir, 'broker.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const pending = new Map<number, (message: JsonRpcResponse) => void>();
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim() === '') return;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id) as (value: JsonRpcResponse) => void;
      pending.delete(message.id);
      resolve(message);
    }
  });
  let nextId = 1;
  const request = (method: string, params?: Record<string, unknown>, timeoutMs = 10000) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}; stderr=${stderr.slice(-600)}`));
      }, timeoutMs);
      pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  };
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  };
  const session: BrokerSession = { request, stderr: () => stderr, close };
  sessions.push(session);
  return session;
}

async function initialize(session: BrokerSession): Promise<JsonRpcResponse> {
  return session.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
}

async function payload(session: BrokerSession, tool: string): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name: tool, arguments: {} });
  return response.result?.structuredContent ?? {};
}

const REPORT_KEYS = [
  'passwordManagerEnabled',
  'passwordManagerApplies',
  'passwordManagerSource',
  'passwordManagerPolicyFile',
  'passwordManagerOverlay',
  'passwordManagerOverlayMode',
  'passwordManagerStore',
] as const;

function report(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(REPORT_KEYS.map((key) => [key, value[key]]));
}

function hasReport(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => key.startsWith('passwordManager'));
}

function appliedRecord(
  root: string,
  content: string,
  overrides: Record<string, unknown> = {},
): { file: string; overlayDir: string; record: Record<string, unknown> } {
  const dataDir = path.join(root, 'data');
  const overlayDir = path.join(dataDir, overlays.OVERLAY_ROOT_NAME, '156.0.1-beta.39-b38343bc');
  mkdirSync(path.join(overlayDir, 'distribution'), { recursive: true });
  writeFileSync(
    path.join(overlayDir, overlays.OVERLAY_MARKER_FILENAME),
    JSON.stringify({
      version: 1,
      engine: 'camoufox',
      pluginOverlayFormat: 1,
      createdAt: '2026-10-26T00:00:00Z',
    }),
  );
  const file = path.join(overlayDir, 'distribution', 'policies.json');
  writeFileSync(file, content);
  const stored = {
    version: 1,
    engine: 'camoufox',
    status: 'applied',
    build: 'v156.0.1-beta.39',
    sourcePolicyHash: 'source',
    managedPolicyHash: library.sha256(content),
    probePolicyHash: 'probe',
    overlayFormat: overlays.OVERLAY_FORMAT,
    overlay: overlayDir,
    policyFile: file,
    mode: 'hardlink',
    verified: true,
    ...overrides,
  };
  library.writePasswordPolicyRecord(dataDir, stored);
  return { file, overlayDir, record: stored };
}

describe('the broker report', () => {
  it('adds no password key to any engine when the setting is off', async () => {
    for (const engine of ['camoufox', 'cloak', 'camoufox-native']) {
      const root = tempRoot(`password-off-${engine}-`);
      const plugin = createStubPlugin(root);
      const dataDir = path.join(root, 'data');
      const absent = startBroker({ pluginDir: plugin, dataDir, engine });
      const absentInitialize = await initialize(absent);
      const absentCapabilities = await payload(absent, 'browser_capabilities');
      const absentStatus = await payload(absent, 'browser_engine_status');
      const off = startBroker({
        pluginDir: plugin,
        dataDir,
        engine,
        env: { STEALTH_PASSWORD_MANAGER: 'false' },
      });
      const offInitialize = await initialize(off);
      const offCapabilities = await payload(off, 'browser_capabilities');
      const offStatus = await payload(off, 'browser_engine_status');
      for (const value of [absentCapabilities, absentStatus, offCapabilities, offStatus]) {
        expect(hasReport(value), `${engine}`).toBe(false);
      }
      expect(offInitialize.result?.instructions).toBe(absentInitialize.result?.instructions);
      expect(offStatus.passwordManagerSource).toBeUndefined();
    }
  });

  it('reports the pending state before the launcher prepared the overlay', async () => {
    const root = tempRoot('password-pending-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    const session = startBroker({
      pluginDir: plugin,
      dataDir,
      engine: 'camoufox',
      env: { STEALTH_PASSWORD_MANAGER: 'true' },
    });
    const initialized = await initialize(session);
    const capabilities = await payload(session, 'browser_capabilities');
    expect(report(capabilities)).toEqual({
      passwordManagerEnabled: false,
      passwordManagerApplies: true,
      passwordManagerSource: 'default',
      passwordManagerPolicyFile: null,
      passwordManagerOverlay: null,
      passwordManagerOverlayMode: null,
      passwordManagerStore: 'missing',
    });
    expect(String(capabilities.passwordManagerNote)).toContain('backend starts');
    expect(report(await payload(session, 'browser_engine_status'))).toEqual(report(capabilities));
    expect(initialized.result?.instructions ?? '').not.toContain('Saved logins');
  });

  it('reports the overlay build and the Firefox login store when applied', async () => {
    const root = tempRoot('password-applied-');
    const plugin = createStubPlugin(root);
    const profile = path.join(root, 'profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(path.join(profile, 'logins.db'), 'not a database');
    const { file, overlayDir } = appliedRecord(root, MANAGED_TEXT);
    const dataDir = path.join(root, 'data');
    const session = startBroker({
      pluginDir: plugin,
      dataDir,
      engine: 'camoufox',
      env: {
        STEALTH_PASSWORD_MANAGER: 'true',
        PLAYWRIGHT_MCP_USER_DATA_DIR: profile,
      },
    });
    const initialized = await initialize(session);
    const capabilities = await payload(session, 'browser_capabilities');
    expect(report(capabilities)).toEqual({
      passwordManagerEnabled: true,
      passwordManagerApplies: true,
      passwordManagerSource: 'overlay',
      passwordManagerPolicyFile: file,
      passwordManagerOverlay: overlayDir,
      passwordManagerOverlayMode: 'hardlink',
      passwordManagerStore: 'firefox-logins-db-present',
    });
    expect(Object.hasOwn(capabilities, 'passwordManagerNote')).toBe(false);
    expect(report(await payload(session, 'browser_engine_status'))).toEqual(report(capabilities));
    expect(initialized.result?.instructions ?? '').toContain('plugin-owned Camoufox build overlay');
    expect(initialized.result?.instructions ?? '').toContain('treat them as secrets');
  });

  it('reports a missing or modified overlay as blocked', async () => {
    const missingRoot = tempRoot('password-missing-overlay-');
    const missingPlugin = createStubPlugin(missingRoot);
    const missing = appliedRecord(missingRoot, MANAGED_TEXT);
    rmSync(missing.overlayDir, { recursive: true, force: true });
    const missingSession = startBroker({
      pluginDir: missingPlugin,
      dataDir: path.join(missingRoot, 'data'),
      engine: 'camoufox',
      env: { STEALTH_PASSWORD_MANAGER: 'true' },
    });
    await initialize(missingSession);
    const missingCapabilities = await payload(missingSession, 'browser_capabilities');
    expect(report(missingCapabilities)).toMatchObject({
      passwordManagerEnabled: false,
      passwordManagerSource: 'blocked-by-overlay',
      passwordManagerOverlay: null,
    });
    expect(String(missingCapabilities.passwordManagerNote)).toContain('missing');

    const modifiedRoot = tempRoot('password-modified-overlay-');
    const modifiedPlugin = createStubPlugin(modifiedRoot);
    const modified = appliedRecord(modifiedRoot, MANAGED_TEXT);
    writeFileSync(modified.file, '{"policies":{"SomeoneElse":true}}\n');
    const modifiedSession = startBroker({
      pluginDir: modifiedPlugin,
      dataDir: path.join(modifiedRoot, 'data'),
      engine: 'camoufox',
      env: { STEALTH_PASSWORD_MANAGER: 'true' },
    });
    const initialized = await initialize(modifiedSession);
    const capabilities = await payload(modifiedSession, 'browser_capabilities');
    expect(report(capabilities)).toMatchObject({
      passwordManagerEnabled: false,
      passwordManagerApplies: true,
      passwordManagerSource: 'blocked-by-overlay',
      passwordManagerPolicyFile: null,
      passwordManagerOverlay: null,
      passwordManagerOverlayMode: null,
      passwordManagerStore: 'missing',
    });
    expect(String(capabilities.passwordManagerNote)).toContain('no longer matches');
    expect(initialized.result?.instructions ?? '').toContain('Saved logins:');
    expect(initialized.result?.instructions ?? '').not.toContain('Saved logins are enabled');
  });

  it('refuses a recorded overlay outside the plugin overlay root', async () => {
    const root = tempRoot('password-outside-');
    const plugin = createStubPlugin(root);
    const outside = path.join(root, 'elsewhere');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'distribution.json'), '{}');
    appliedRecord(root, MANAGED_TEXT, { overlay: outside });
    const session = startBroker({
      pluginDir: plugin,
      dataDir: path.join(root, 'data'),
      engine: 'camoufox',
      env: { STEALTH_PASSWORD_MANAGER: 'true' },
    });
    await initialize(session);
    const capabilities = await payload(session, 'browser_capabilities');
    expect(capabilities.passwordManagerSource).toBe('blocked-by-overlay');
    expect(capabilities.passwordManagerEnabled).toBe(false);
  });

  it('reports the prefs-only path when the build does not lock the manager', async () => {
    const root = tempRoot('password-prefs-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    library.writePasswordPolicyRecord(dataDir, {
      version: 1,
      engine: 'camoufox',
      status: 'prefs',
      build: 'v156.0.1-beta.39',
      sourcePolicyHash: 'source',
      managedPolicyHash: 'managed',
      overlayFormat: overlays.OVERLAY_FORMAT,
      overlay: null,
      policyFile: null,
      verified: true,
    });
    const session = startBroker({
      pluginDir: plugin,
      dataDir,
      engine: 'camoufox',
      env: { STEALTH_PASSWORD_MANAGER: 'true' },
    });
    const initialized = await initialize(session);
    const capabilities = await payload(session, 'browser_capabilities');
    expect(report(capabilities)).toMatchObject({
      passwordManagerEnabled: true,
      passwordManagerApplies: true,
      passwordManagerSource: 'prefs',
      passwordManagerPolicyFile: null,
      passwordManagerOverlay: null,
      passwordManagerOverlayMode: null,
    });
    expect(initialized.result?.instructions ?? '').toContain('Saved logins are enabled for this profile');
  });

  it('reports the launcher-recorded blocked states', async () => {
    for (const status of [
      'blocked-by-overlay',
      'blocked-by-existing-overlay',
      'blocked-by-build-policy',
      'blocked-config',
    ]) {
      const root = tempRoot(`password-blocked-${status}-`);
      const plugin = createStubPlugin(root);
      const dataDir = path.join(root, 'data');
      library.writePasswordPolicyRecord(dataDir, {
        version: 1,
        engine: 'camoufox',
        status,
        build: 'v156.0.1-beta.39',
        overlay: null,
        policyFile: null,
        note: `Saved logins: ${status}.`,
        checkedAt: '2026-10-26T00:00:00Z',
      });
      const session = startBroker({
        pluginDir: plugin,
        dataDir,
        engine: 'camoufox',
        env: { STEALTH_PASSWORD_MANAGER: 'true' },
      });
      const initialized = await initialize(session);
      const capabilities = await payload(session, 'browser_capabilities');
      expect(capabilities.passwordManagerSource, `${status}`).toBe(status);
      expect(capabilities.passwordManagerEnabled).toBe(false);
      expect(report(await payload(session, 'browser_engine_status'))).toEqual(report(capabilities));
      expect(initialized.result?.instructions ?? '').toContain('Saved logins:');
    }
  });

  it('reports an INI wrapper config as inert without touching it', async () => {
    const root = tempRoot('password-ini-');
    const plugin = createStubPlugin(root);
    const ini = path.join(root, 'user.ini');
    writeFileSync(ini, 'browser = camoufox\n');
    const session = startBroker({
      pluginDir: plugin,
      dataDir: path.join(root, 'data'),
      engine: 'camoufox',
      env: { STEALTH_PASSWORD_MANAGER: 'true', CAMOUFOX_MCP_CONFIG: ini },
    });
    await initialize(session);
    const capabilities = await payload(session, 'browser_capabilities');
    expect(capabilities.passwordManagerSource).toBe('default');
    expect(String(capabilities.passwordManagerNote)).toContain('not applied on this start');
    expect(readFileSync(ini, 'utf8')).toBe('browser = camoufox\n');
  });

  it('says the setting is inert on the engines without the mechanism', async () => {
    const root = tempRoot('password-inert-');
    const plugin = createStubPlugin(root);
    for (const engine of ['cloak', 'camoufox-native']) {
      const session = startBroker({
        pluginDir: plugin,
        dataDir: path.join(root, `${engine}-data`),
        engine,
        env: { STEALTH_PASSWORD_MANAGER: 'true' },
      });
      const initialized = await initialize(session);
      expect(initialized.result?.instructions ?? '').not.toContain('Saved logins');
      const capabilities = await payload(session, 'browser_capabilities');
      expect(report(capabilities), `${engine}`).toEqual({
        passwordManagerEnabled: false,
        passwordManagerApplies: false,
        passwordManagerSource: engine === 'camoufox-native' ? 'native-unavailable' : 'default',
        passwordManagerPolicyFile: null,
        passwordManagerOverlay: undefined,
        passwordManagerOverlayMode: undefined,
        passwordManagerStore: null,
      });
      expect(String(capabilities.passwordManagerNote), `${engine}`).toContain(
        engine === 'camoufox-native'
          ? 'mcp-camoufox 0.4.5 has no Firefox prefs input'
          : 'applies only to the camoufox engine',
      );
    }
  });

  // --- search engines (2.17.0) -------------------------------------------
  it('adds no search key for the engines that are not camoufox', async () => {
    const root = tempRoot('search-report-other-engines-');
    const plugin = createStubPlugin(root);
    for (const engine of ['cloak', 'camoufox-native']) {
      const session = startBroker({ pluginDir: plugin, dataDir: path.join(root, `${engine}-data`), engine });
      await initialize(session);
      for (const tool of ['browser_capabilities', 'browser_engine_status']) {
        const value = await payload(session, tool);
        expect(
          Object.keys(value).filter((key) => key.startsWith('searchEngines')),
          `${engine}/${tool}`,
        ).toEqual([]);
        // The password group is unchanged: no password key appears with none set.
        expect(hasReport(value), `${engine}/${tool}`).toBe(false);
      }
    }
  });

  it('reports the pending search state and the four keys for camoufox', async () => {
    const root = tempRoot('search-report-engine-');
    const plugin = createStubPlugin(root);
    const session = startBroker({ pluginDir: plugin, dataDir: path.join(root, 'data'), engine: 'camoufox' });
    await initialize(session);
    for (const tool of ['browser_capabilities', 'browser_engine_status']) {
      const value = await payload(session, tool);
      expect(
        Object.keys(value)
          .filter((key) => key.startsWith('searchEngines'))
          .sort(),
        `${tool}`,
      ).toEqual([
        'searchEnginesDefault',
        'searchEnginesNote',
        'searchEnginesPolicyFile',
        'searchEnginesSource',
      ]);
      expect(value.searchEnginesSource, `${tool}`).toBe('stock');
      expect(value.searchEnginesDefault, `${tool}`).toBeNull();
      expect(value.searchEnginesPolicyFile, `${tool}`).toBeNull();
      expect(String(value.searchEnginesNote), `${tool}`).toContain('backend starts');
      expect(hasReport(value), `${tool}`).toBe(false);
    }
  });

  it('reports the overlay source, the Google default and the migration note', async () => {
    for (const [content, passwordEnv] of [
      [SEARCH_MANAGED_TEXT, {}],
      [MANAGED_TEXT, { STEALTH_PASSWORD_MANAGER: 'true' }],
    ] as const) {
      const root = tempRoot('search-report-applied-');
      const plugin = createStubPlugin(root);
      const { file, overlayDir } = appliedRecord(root, content, {
        searchSource: 'overlay',
        searchDefault: 'Google',
        searchMigration: 'renamed',
        searchBackupFile: 'search.json.mozlz4.backup-20261027T120000Z',
        searchNote: 'Search engines: moved the old list aside once as a backup.',
      });
      const session = startBroker({
        pluginDir: plugin,
        dataDir: path.join(root, 'data'),
        engine: 'camoufox',
        env: passwordEnv,
      });
      await initialize(session);
      const capabilities = await payload(session, 'browser_capabilities');
      expect(capabilities).toMatchObject({
        searchEnginesSource: 'overlay',
        searchEnginesDefault: 'Google',
        searchEnginesPolicyFile: file,
        searchEnginesNote: 'Search engines: moved the old list aside once as a backup.',
      });
      expect(overlayDir).toContain('camoufox-overlay');
      expect(await payload(session, 'browser_engine_status')).toMatchObject({
        searchEnginesSource: 'overlay',
        searchEnginesDefault: 'Google',
        searchEnginesPolicyFile: file,
      });
    }
  });

  it('reports stock when the overlay carries no search transform', async () => {
    const root = tempRoot('search-report-stock-');
    const plugin = createStubPlugin(root);
    appliedRecord(root, MANAGED_TEXT, { searchSource: 'stock' });
    const session = startBroker({
      pluginDir: plugin,
      dataDir: path.join(root, 'data'),
      engine: 'camoufox',
      env: { STEALTH_PASSWORD_MANAGER: 'true' },
    });
    await initialize(session);
    const capabilities = await payload(session, 'browser_capabilities');
    expect(capabilities).toMatchObject({
      searchEnginesSource: 'stock',
      searchEnginesDefault: null,
      searchEnginesPolicyFile: null,
      searchEnginesNote: null,
    });
  });

  it('reports blocked-by-overlay with the launcher note when the overlay is blocked', async () => {
    for (const [status, recordOverlay] of [
      ['blocked-by-overlay', null],
      ['blocked-by-existing-overlay', null],
      ['blocked-by-build-policy', null],
    ] as const) {
      const root = tempRoot(`search-report-${status}-`);
      const plugin = createStubPlugin(root);
      const dataDir = path.join(root, 'data');
      library.writePasswordPolicyRecord(dataDir, {
        version: 1,
        engine: 'camoufox',
        status,
        build: 'v156.0.1-beta.39',
        overlay: recordOverlay,
        policyFile: null,
        searchSource: 'blocked',
        note: `Search engines: ${status}.`,
        checkedAt: '2026-10-27T00:00:00Z',
      });
      const session = startBroker({ pluginDir: plugin, dataDir, engine: 'camoufox' });
      await initialize(session);
      const capabilities = await payload(session, 'browser_capabilities');
      expect(capabilities, `${status}`).toMatchObject({
        searchEnginesSource: 'blocked-by-overlay',
        searchEnginesDefault: null,
        searchEnginesPolicyFile: null,
        searchEnginesNote: `Search engines: ${status}.`,
      });
    }
    // A recorded overlay whose policy file no longer matches is blocked too.
    const root = tempRoot('search-report-modified-');
    const plugin = createStubPlugin(root);
    const { file } = appliedRecord(root, MANAGED_TEXT, { searchSource: 'overlay' });
    writeFileSync(file, '{"policies":{}}\n');
    const session = startBroker({ pluginDir: plugin, dataDir: path.join(root, 'data'), engine: 'camoufox' });
    await initialize(session);
    const capabilities = await payload(session, 'browser_capabilities');
    expect(capabilities.searchEnginesSource).toBe('blocked-by-overlay');
    expect(String(capabilities.searchEnginesNote)).toContain('rebuilds the overlay');
    // The `stock` and `prefs` records (no overlay needed) report the stock list.
    for (const status of ['stock', 'prefs']) {
      const stockRoot = tempRoot(`search-report-${status}-record-`);
      const stockPlugin = createStubPlugin(stockRoot);
      const stockData = path.join(stockRoot, 'data');
      library.writePasswordPolicyRecord(stockData, {
        version: 1,
        engine: 'camoufox',
        status,
        build: 'v156.0.1-beta.39',
        overlay: null,
        policyFile: null,
        searchSource: 'stock',
        note: null,
        checkedAt: '2026-10-27T00:00:00Z',
      });
      const stockSession = startBroker({
        pluginDir: stockPlugin,
        dataDir: stockData,
        engine: 'camoufox',
      });
      await initialize(stockSession);
      expect(await payload(stockSession, 'browser_capabilities'), `${status}`).toMatchObject({
        searchEnginesSource: 'stock',
        searchEnginesDefault: null,
        searchEnginesPolicyFile: null,
        searchEnginesNote: null,
      });
    }
  });
});
