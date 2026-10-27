import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Camoufox saved logins and autofill (2.15.0; the Windows per-user route was
// withdrawn in 2.15.1). The pinned build locks Firefox's login manager off
// through its own enterprise policy, and it has no readable per-user policy
// directory on Windows, so the setting reports blocked-by-build-policy there
// without writing, probing or merging anything. This suite pins:
//   - both plugin manifests, the environment mapping and the settings counts;
//   - the Windows dead path: no path lookup, no file, no probe, no pref;
//   - the retained per-user policy-file route (2.15.0), unchanged and covered;
//   - the shared helper: boolean resolution, the path decision, the policy
//     documents, the ownership record and every apply branch;
//   - the entry point's merge of the four prefs (tests/python);
//   - the broker report: off adds no key anywhere, on reports what happened and
//     the engines that cannot apply it say so;
//   - the default configuration's byte stability.
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
}

interface PasswordModule {
  PASSWORD_MANAGER_ENGINE_ID: string;
  PASSWORD_MANAGER_SETTING_VAR: string;
  PASSWORD_MANAGER_STATE_VAR: string;
  PASSWORD_MANAGER_STATE_APPLIED: string;
  PASSWORD_MANAGER_WINDOWS_DEAD_PATH_NOTE: string;
  PASSWORD_MANAGER_PREFS: Record<string, boolean>;
  resolvePasswordManager(env?: Record<string, string | undefined>): Resolution;
  passwordManagerProblemNote(resolution: Resolution): string | null;
  expectedPerUserDir(localAppData: string): string;
  buildLayout(binary: string): { buildDir: string; cacheRoot: string } | null;
  sameWindowsPath(left: string, right: string): boolean;
  managedPolicy(buildPolicy: unknown): Record<string, unknown> | null;
  probePolicy(managed: unknown): Record<string, unknown> | null;
  policyBytes(policy: unknown): string;
  sha256(text: string): string;
  sha256File(file: string): string | null;
  readPasswordPolicyRecord(pluginDataDir: string): Record<string, unknown> | null;
  writePasswordPolicyRecord(pluginDataDir: string, record: Record<string, unknown>): void;
  policyOwnership(record: Record<string, unknown> | null, policyFile: string): string;
  passwordUserConfigProblem(env: Record<string, string | undefined>): string | null;
  hasFirefoxLoginStore(profileDir: string): boolean;
  applyPasswordManager(options: Record<string, unknown>): Promise<ApplyResult>;
  applyPerUserPolicyFile(options: Record<string, unknown>): Promise<ApplyResult>;
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
    SearchEngines: { PreventInstalls: true, Default: 'None' },
  },
};

interface Fixture {
  root: string;
  localAppData: string;
  cacheRoot: string;
  buildDir: string;
  binary: string;
  pluginData: string;
  target: string;
  build: string;
}

// The real Camoufox cache layout: <LocalAppData>/camoufox/camoufox/Cache/
// browsers/official/<version>-<hash>/camoufox.exe. Expected per-user directory:
// <LocalAppData>/Camoufox/Camoufox/policies.json (same directory on Windows,
// case-insensitively).
function layoutFixture(options: { withSourcePolicy?: boolean; sourceText?: string } = {}): Fixture {
  const root = tempRoot('password-manager-');
  const localAppData = path.join(root, 'LocalAppData');
  const cacheRoot = path.join(localAppData, 'camoufox', 'camoufox');
  const build = 'v156.0.1-beta.39';
  const buildDir = path.join(cacheRoot, 'Cache', 'browsers', 'official', '156.0.1-beta.39-b38343bc');
  const binary = path.join(buildDir, 'camoufox.exe');
  mkdirSync(path.join(buildDir, 'distribution'), { recursive: true });
  writeFileSync(binary, '');
  if (options.withSourcePolicy !== false) {
    writeFileSync(
      path.join(buildDir, 'distribution', 'policies.json'),
      options.sourceText ?? `${JSON.stringify(BUILD_POLICY, null, 2)}\n`,
    );
  }
  return {
    root,
    localAppData,
    cacheRoot,
    buildDir,
    binary,
    pluginData: path.join(root, 'plugin-data'),
    target: path.join(localAppData, 'Camoufox', 'Camoufox', 'policies.json'),
    build,
  };
}

interface RunResult {
  result: ApplyResult;
  env: Record<string, string | undefined>;
  probeCalls: number;
  pathCalls: number;
  logs: string[];
}

interface RunOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  resolvePath?: () => Record<string, unknown> | null;
  probe?: () => Promise<Record<string, unknown>>;
  pluginDataDir?: string;
  binary?: string;
  build?: string;
}

// The retained per-user policy-file route (2.15.0), called directly. 2.15.1
// reaches it through no platform (the Windows block below records the dead path
// instead), and every branch stays covered here for a future build that
// implements a readable per-user policy directory.
async function runApply(fixture: Fixture, options: RunOptions = {}): Promise<RunResult> {
  return runStep(fixture, options, (stepOptions) => library.applyPerUserPolicyFile(stepOptions));
}

// The setting-level entry point the launcher calls. `resolvePath` and `probe` are
// injected so a test can prove they are never reached.
async function runApplySetting(fixture: Fixture, options: RunOptions = {}): Promise<RunResult> {
  return runStep(fixture, options, (stepOptions) => library.applyPasswordManager(stepOptions));
}

async function runStep(
  fixture: Fixture,
  options: RunOptions,
  step: (options: Record<string, unknown>) => Promise<ApplyResult>,
): Promise<RunResult> {
  const env: Record<string, string | undefined> = {
    STEALTH_PASSWORD_MANAGER: 'true',
    ...(options.env ?? {}),
  };
  let probeCalls = 0;
  let pathCalls = 0;
  const logs: string[] = [];
  const result = await step({
    env,
    pluginDataDir: options.pluginDataDir ?? fixture.pluginData,
    binary: options.binary ?? fixture.binary,
    build: options.build ?? fixture.build,
    python: 'python',
    bootstrap: 'camoufox_bootstrap.py',
    platform: options.platform ?? 'win32',
    log: (message: unknown) => logs.push(String(message)),
    resolvePath: () => {
      pathCalls += 1;
      return options.resolvePath === undefined
        ? { localAppData: fixture.localAppData }
        : options.resolvePath();
    },
    probe: async () => {
      probeCalls += 1;
      return options.probe === undefined ? { state: 'denied' } : options.probe();
    },
  });
  return { result, env, probeCalls, pathCalls, logs };
}

function record(fixture: Fixture): Record<string, unknown> | null {
  return library.readPasswordPolicyRecord(fixture.pluginData);
}

// --- the shipped manifests -------------------------------------------------
describe('password_manager in the shipped manifests', () => {
  const plugins = ['cloakbrowser', 'camoufox'] as const;

  it.each(plugins)('declares a boolean, off by default, with the security text (%s)', (name) => {
    const plugin = JSON.parse(
      readFileSync(path.join(repoRoot, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as {
      version: string;
      userConfig: Record<string, { type?: string; default?: unknown; description?: string }>;
    };
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
      'XREUserRunTimeDir',
      'blocked-by-build-policy',
      'overlay build',
      'not read, written or removed',
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

  it('keeps the settings counts at 31 and 20', () => {
    for (const [name, count] of [
      ['cloakbrowser', 31],
      ['camoufox', 20],
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
    }
    const nativeSection = readFileSync(path.join(universalDir, 'README.md'), 'utf8');
    expect(nativeSection).toContain('native-unavailable');
  });
});

// --- the shared helper -----------------------------------------------------
describe('the shared password-manager helper', () => {
  it('is off unless the value is an explicit true spelling', () => {
    expect(library.PASSWORD_MANAGER_ENGINE_ID).toBe('camoufox');
    expect(library.PASSWORD_MANAGER_SETTING_VAR).toBe('STEALTH_PASSWORD_MANAGER');
    expect(library.PASSWORD_MANAGER_STATE_VAR).toBe('STEALTH_PASSWORD_MANAGER_STATE');
    expect(library.PASSWORD_MANAGER_STATE_APPLIED).toBe('applied');
    expect(library.PASSWORD_MANAGER_PREFS).toEqual({
      'toolkit.policies.perUserDir': true,
      'signon.rememberSignons': true,
      'signon.autofillForms': true,
      'signon.autofillForms.http': false,
    });
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

  it('derives the per-user directory and accepts only the standard cache layout', () => {
    const local = path.join('C:', 'Users', 'someone', 'AppData', 'Local');
    expect(library.expectedPerUserDir(local)).toBe(path.join(local, 'Camoufox', 'Camoufox'));
    const binary = path.resolve(
      local,
      'camoufox',
      'camoufox',
      'Cache',
      'browsers',
      'official',
      'x-h',
      'camoufox.exe',
    );
    expect(library.buildLayout(binary)).toEqual({
      buildDir: path.resolve(local, 'camoufox', 'camoufox', 'Cache', 'browsers', 'official', 'x-h'),
      cacheRoot: path.resolve(local, 'camoufox', 'camoufox'),
    });
    expect(
      library.sameWindowsPath(path.join(local, 'camoufox', 'camoufox'), library.expectedPerUserDir(local)),
    ).toBe(true);
    expect(library.buildLayout(path.join(local, 'Somewhere', 'Else', 'camoufox.exe'))).toBeNull();
    expect(library.buildLayout('')).toBeNull();
    expect(library.sameWindowsPath('', local)).toBe(false);
    expect(library.sameWindowsPath(path.join(local, 'Camoufox'), path.join(local, 'camoufox'))).toBe(true);
  });

  it('builds a managed policy that differs from the build file only in the two keys', () => {
    const managed = library.managedPolicy(BUILD_POLICY) as { policies: Record<string, unknown> };
    expect(managed).not.toBeNull();
    expect(managed.policies.PasswordManagerEnabled).toBe(true);
    expect(managed.policies.OfferToSaveLogins).toBe(true);
    const expected = {
      ...BUILD_POLICY,
      policies: { ...BUILD_POLICY.policies, PasswordManagerEnabled: true, OfferToSaveLogins: true },
    };
    expect(managed).toEqual(expected);
    // Every other policy is preserved value for value.
    for (const [key, value] of Object.entries(BUILD_POLICY.policies)) {
      if (key === 'PasswordManagerEnabled' || key === 'OfferToSaveLogins') {
        continue;
      }
      expect(managed.policies[key], `${key}`).toEqual(value);
    }
    expect((managed as Record<string, unknown>)['__COMMENT__ More Information']).toBe(
      BUILD_POLICY['__COMMENT__ More Information'],
    );
    expect(library.managedPolicy({})).toBeNull();
    expect(library.managedPolicy(null)).toBeNull();
    expect(library.managedPolicy({ policies: [] })).toBeNull();
  });

  it('adds only the geolocation probe policy to the verification document', () => {
    const managed = library.managedPolicy(BUILD_POLICY) as { policies: Record<string, unknown> };
    const probe = library.probePolicy(managed) as { policies: Record<string, unknown> };
    expect(probe.policies.Permissions).toEqual({ Location: { BlockNewRequests: true } });
    expect(probe.policies.PasswordManagerEnabled).toBe(true);
    expect(probe.policies.OfferToSaveLogins).toBe(true);
    expect((managed.policies as Record<string, unknown>).Permissions).toBeUndefined();
    // A build policy that already has Permissions keeps its other values.
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

  it('hashes the exact bytes and keeps the record in plugin data', () => {
    const text = library.policyBytes({ policies: { A: true } });
    expect(text.endsWith('\n')).toBe(true);
    expect(library.sha256(text)).toMatch(/^[0-9a-f]{64}$/u);
    const root = tempRoot('password-record-');
    expect(library.readPasswordPolicyRecord(root)).toBeNull();
    const file = path.join(root, 'policies.json');
    writeFileSync(file, text);
    const good = {
      version: 1,
      engine: 'camoufox',
      status: 'applied',
      build: 'v1',
      policyFile: file,
      contentHash: library.sha256(text),
      probeHash: 'other',
      verified: true,
    };
    library.writePasswordPolicyRecord(root, good);
    expect(library.readPasswordPolicyRecord(root)).toEqual(good);
    expect(library.policyOwnership(good, file)).toBe('ours');
    expect(library.policyOwnership({ ...good, policyFile: path.join(root, 'elsewhere.json') }, file)).toBe(
      'unknown',
    );
    writeFileSync(file, '{"policies":{"Foreign":true}}\n');
    expect(library.policyOwnership(good, file)).toBe('foreign');
    library.writePasswordPolicyRecord(root, { ...good, status: 'nonsense' });
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
    // A directory with that name also counts: the helper never opens it.
    const other = tempRoot('password-store-dir-');
    mkdirSync(path.join(other, 'logins.db'));
    expect(library.hasFirefoxLoginStore(other)).toBe(true);
  });
});

// --- the apply step --------------------------------------------------------
describe('applyPasswordManager (2.15.1: the Windows per-user route is dead)', () => {
  it('is byte-identical when off: no files, no record, no path resolution', async () => {
    for (const value of [undefined, '', 'false', '0', 'no', 'off']) {
      const fixture = layoutFixture();
      const run = await runApplySetting(fixture, { env: { STEALTH_PASSWORD_MANAGER: value } });
      expect(run.result.status, `${String(value)}`).toBe('off');
      expect(run.probeCalls).toBe(0);
      expect(run.pathCalls).toBe(0);
      expect(existsSync(fixture.pluginData)).toBe(false);
      expect(existsSync(fixture.target)).toBe(false);
      expect(run.logs).toEqual([]);
    }
  });

  // 2.15.1 removed the Windows attempt: this build has no readable per-user
  // policy directory there, so a Windows start with the setting on must not
  // resolve a path (20 s), write a machine-wide file, start a verification
  // browser (60 s) or merge a pref. Every guard below is mutation-checked.
  it('on Windows blocks with the dead-path note and starts nothing', async () => {
    const fixture = layoutFixture();
    const run = await runApplySetting(fixture);
    expect(run.result.status).toBe('blocked-by-build-policy');
    expect(run.result.note).toBe(library.PASSWORD_MANAGER_WINDOWS_DEAD_PATH_NOTE);
    expect(run.result.note).toContain('no readable per-user Firefox policy directory on Windows');
    expect(run.result.note).toContain('overlay build (not yet shipped) is the future route');
    expect(run.result.policyFile).toBeNull();
    // No path resolution (up to 20 s) and no verification browser start (up to 60 s).
    expect(run.pathCalls).toBe(0);
    expect(run.probeCalls).toBe(0);
    // No policy file and no pref: the entry point merges nothing without the state var.
    expect(existsSync(fixture.target)).toBe(false);
    expect(run.env.STEALTH_PASSWORD_MANAGER_STATE).toBeUndefined();
    // One honest log line, and the blocked record the broker reads.
    expect(run.logs).toEqual([library.PASSWORD_MANAGER_WINDOWS_DEAD_PATH_NOTE]);
    expect(record(fixture)).toMatchObject({
      version: 1,
      engine: 'camoufox',
      status: 'blocked-by-build-policy',
      build: fixture.build,
      policyFile: null,
      note: library.PASSWORD_MANAGER_WINDOWS_DEAD_PATH_NOTE,
    });
  });

  it('never reads or removes a file at the old per-user path on Windows', async () => {
    const fixture = layoutFixture();
    const previous = '{"policies":{"PasswordManagerEnabled":true}}\n';
    mkdirSync(path.dirname(fixture.target), { recursive: true });
    writeFileSync(fixture.target, previous);
    const run = await runApplySetting(fixture);
    expect(run.result.status).toBe('blocked-by-build-policy');
    expect(run.result.note).toBe(library.PASSWORD_MANAGER_WINDOWS_DEAD_PATH_NOTE);
    expect(run.pathCalls).toBe(0);
    expect(run.probeCalls).toBe(0);
    // A file left by an earlier 2.15.0 start is not this release's data to touch.
    expect(readFileSync(fixture.target, 'utf8')).toBe(previous);
  });

  it('takes no measurable step on Windows (the handshake carries no 20/60 s wait)', async () => {
    const fixture = layoutFixture();
    const started = process.hrtime.bigint();
    await runApplySetting(fixture);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // The 2.15.0 step could take 20 s (path) + 60 s (probe); the dead path is a
    // record write. 1000 ms is far above any filesystem jitter and far below the
    // smallest step this guard removes.
    expect(elapsedMs).toBeLessThan(1000);
  });

  // The tests below exercise the retained per-user policy-file route (2.15.0)
  // through `runApply`, which calls `applyPerUserPolicyFile` directly. No
  // shipped platform reaches that function any more; the route stays covered so a
  // future build that implements the directory keeps its contract.
  it('writes our managed file on the first enable and records ownership', async () => {
    const fixture = layoutFixture();
    const run = await runApply(fixture);
    expect(run.result.status).toBe('applied');
    expect(run.result.policyFile).toBe(fixture.target);
    expect(run.env.STEALTH_PASSWORD_MANAGER_STATE).toBe('applied');
    expect(run.probeCalls).toBe(1);
    const written = readFileSync(fixture.target, 'utf8');
    const managed = library.policyBytes(library.managedPolicy(BUILD_POLICY));
    expect(written).toBe(managed);
    const stored = record(fixture);
    expect(stored).toMatchObject({
      version: 1,
      engine: 'camoufox',
      status: 'applied',
      build: fixture.build,
      policyFile: fixture.target,
      sourcePolicyHash: library.sha256(`${JSON.stringify(BUILD_POLICY, null, 2)}\n`),
      contentHash: library.sha256(managed),
      verified: true,
    });
    expect(typeof stored?.verifiedAt).toBe('string');
    expect(run.logs.join('\n')).toContain('saved logins enabled');
    // The atomic write leaves no temporary file behind.
    const leftovers = readdirSync(path.dirname(fixture.target)).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it.each([
    ['prompt', { state: 'prompt' }],
    ['granted', { state: 'granted' }],
    ['error', { state: 'error', detail: 'launch failed' }],
    ['timeout', { state: 'timeout', detail: 'no answer within 60 s' }],
  ])('reverts and removes our file when the verification says %s', async (_name, probeResult) => {
    const fixture = layoutFixture();
    const run = await runApply(fixture, { probe: async () => probeResult });
    expect(run.result.status).toBe('blocked-by-build-policy');
    expect(existsSync(fixture.target)).toBe(false);
    expect(run.env.STEALTH_PASSWORD_MANAGER_STATE).toBeUndefined();
    expect(record(fixture)).toMatchObject({ status: 'blocked-by-build-policy' });
    expect(run.logs.join('\n')).toContain('verification start');
  });

  it('reverts when the probe helper throws', async () => {
    const fixture = layoutFixture();
    const run = await runApply(fixture, {
      probe: async () => {
        throw new Error('probe crashed');
      },
    });
    expect(run.result.status).toBe('blocked-by-build-policy');
    expect(existsSync(fixture.target)).toBe(false);
    expect(run.env.STEALTH_PASSWORD_MANAGER_STATE).toBeUndefined();
  });

  it('caches a verification failure and retries only after the setting cycles off', async () => {
    const fixture = layoutFixture();
    const first = await runApply(fixture, { probe: async () => ({ state: 'prompt' }) });
    expect(first.result.status).toBe('blocked-by-build-policy');
    expect(first.probeCalls).toBe(1);
    const second = await runApply(fixture);
    expect(second.result.status).toBe('blocked-by-build-policy');
    expect(second.probeCalls).toBe(0);
    expect(existsSync(fixture.target)).toBe(false);
    expect(record(fixture)).toMatchObject({ status: 'blocked-by-build-policy', verified: false });
    const off = await runApplySetting(fixture, { env: { STEALTH_PASSWORD_MANAGER: 'false' } });
    expect(off.result.status).toBe('off');
    expect(record(fixture)).toBeNull();
    const third = await runApply(fixture);
    expect(third.probeCalls).toBe(1);
    expect(third.result.status).toBe('applied');
  });

  it('never overwrites a foreign per-user file and reports it', async () => {
    const fixture = layoutFixture();
    mkdirSync(path.dirname(fixture.target), { recursive: true });
    writeFileSync(fixture.target, '{"policies":{"Foreign":true}}\n');
    const run = await runApply(fixture);
    expect(run.result.status).toBe('blocked-by-existing-policy');
    expect(run.probeCalls).toBe(0);
    expect(readFileSync(fixture.target, 'utf8')).toBe('{"policies":{"Foreign":true}}\n');
    expect(record(fixture)).toMatchObject({
      status: 'blocked-by-existing-policy',
      policyFile: fixture.target,
    });
    expect(run.logs.join('\n')).toContain('not written by this plugin');
  });

  it('does not touch a foreign file when the setting is turned off', async () => {
    const fixture = layoutFixture();
    const foreign = '{"policies":{"Foreign":true}}\n';
    mkdirSync(path.dirname(fixture.target), { recursive: true });
    writeFileSync(fixture.target, foreign);
    library.writePasswordPolicyRecord(fixture.pluginData, {
      version: 1,
      engine: 'camoufox',
      status: 'applied',
      build: fixture.build,
      policyFile: fixture.target,
      contentHash: 'deadbeef',
      probeHash: 'feedface',
      verified: true,
    });
    const run = await runApplySetting(fixture, { env: { STEALTH_PASSWORD_MANAGER: 'false' } });
    expect(run.result.status).toBe('off');
    expect(readFileSync(fixture.target, 'utf8')).toBe(foreign);
    expect(record(fixture)).toBeNull();
  });

  it('removes only our own file when the setting is turned off', async () => {
    const fixture = layoutFixture();
    const first = await runApply(fixture);
    expect(first.result.status).toBe('applied');
    expect(existsSync(fixture.target)).toBe(true);
    const second = await runApplySetting(fixture, { env: { STEALTH_PASSWORD_MANAGER: 'false' } });
    expect(second.result.status).toBe('off');
    expect(existsSync(fixture.target)).toBe(false);
    expect(record(fixture)).toBeNull();
    expect(second.logs.join('\n')).toContain('removed this plugin');
  });

  it('refuses a build that is not inside the standard Camoufox cache', async () => {
    const fixture = layoutFixture();
    const elsewhere = tempRoot('password-custom-build-');
    const binary = path.join(elsewhere, 'camoufox.exe');
    writeFileSync(binary, '');
    const run = await runApply(fixture, { binary });
    expect(run.result.status).toBe('blocked-by-build-policy');
    expect(run.probeCalls).toBe(0);
    expect(existsSync(fixture.target)).toBe(false);
    expect(run.logs.join('\n')).toContain('not inside the expected machine-wide Camoufox cache');
  });

  it('refuses when the KnownFolder path cannot be resolved', async () => {
    const fixture = layoutFixture();
    const run = await runApply(fixture, { resolvePath: () => null });
    expect(run.result.status).toBe('blocked-by-build-policy');
    expect(run.logs.join('\n')).toContain('LocalAppData');
    expect(existsSync(fixture.target)).toBe(false);
  });

  it('refuses when the build has no readable policy file', async () => {
    const missing = layoutFixture({ withSourcePolicy: false });
    const missingRun = await runApply(missing);
    expect(missingRun.result.status).toBe('blocked-by-build-policy');
    expect(existsSync(missing.target)).toBe(false);
    const invalid = layoutFixture({ sourceText: '{not json' });
    const invalidRun = await runApply(invalid);
    expect(invalidRun.result.status).toBe('blocked-by-build-policy');
    expect(existsSync(invalid.target)).toBe(false);
  });

  it('refuses on a non-Windows platform with the 2.15.0 answer', async () => {
    const fixture = layoutFixture();
    const run = await runApplySetting(fixture, { platform: 'linux' });
    expect(run.result.status).toBe('blocked-by-build-policy');
    expect(run.result.note).toBe(
      'Saved logins: the per-user Firefox policy path could not be resolved on this platform, so the setting is ' +
        'not applied. It was verified on Windows only.',
    );
    expect(run.pathCalls).toBe(0);
    expect(run.probeCalls).toBe(0);
    expect(existsSync(fixture.target)).toBe(false);
    expect(existsSync(fixture.pluginData)).toBe(true);
  });

  it('does not write any policy file when the user config cannot carry prefs', async () => {
    const fixture = layoutFixture();
    const ini = path.join(fixture.root, 'user.ini');
    writeFileSync(ini, 'browser = camoufox\n');
    const run = await runApplySetting(fixture, { env: { CAMOUFOX_MCP_CONFIG: ini } });
    expect(run.result.status).toBe('blocked-config');
    expect(run.pathCalls).toBe(0);
    expect(run.probeCalls).toBe(0);
    expect(existsSync(fixture.target)).toBe(false);
    expect(run.env.STEALTH_PASSWORD_MANAGER_STATE).toBeUndefined();
  });

  it('does not repeat the probe on a later start with a verified record', async () => {
    const fixture = layoutFixture();
    const first = await runApply(fixture);
    expect(first.result.status).toBe('applied');
    const before = readFileSync(fixture.target, 'utf8');
    const second = await runApply(fixture);
    expect(second.result.status).toBe('applied');
    expect(second.probeCalls).toBe(0);
    expect(readFileSync(fixture.target, 'utf8')).toBe(before);
  });

  it('rewrites the managed file without a probe when it disappeared', async () => {
    const fixture = layoutFixture();
    await runApply(fixture);
    rmSync(fixture.target);
    const second = await runApply(fixture);
    expect(second.result.status).toBe('applied');
    expect(second.probeCalls).toBe(0);
    expect(readFileSync(fixture.target, 'utf8')).toBe(
      library.policyBytes(library.managedPolicy(BUILD_POLICY)),
    );
  });

  it('repairs a probe document left by an interrupted start', async () => {
    const fixture = layoutFixture();
    await runApply(fixture);
    const stored = record(fixture)!;
    const probeText = library.policyBytes(library.probePolicy(library.managedPolicy(BUILD_POLICY)));
    writeFileSync(fixture.target, probeText);
    expect(library.policyOwnership(stored, fixture.target)).toBe('ours');
    const second = await runApply(fixture);
    expect(second.result.status).toBe('applied');
    expect(second.probeCalls).toBe(0);
    expect(readFileSync(fixture.target, 'utf8')).not.toBe(probeText);
  });

  it('re-verifies when the build policy changes', async () => {
    const fixture = layoutFixture();
    await runApply(fixture);
    const changed = {
      ...BUILD_POLICY,
      policies: { ...BUILD_POLICY.policies, DisablePocket: true },
    };
    writeFileSync(
      path.join(fixture.buildDir, 'distribution', 'policies.json'),
      `${JSON.stringify(changed, null, 2)}\n`,
    );
    const second = await runApply(fixture);
    expect(second.result.status).toBe('applied');
    expect(second.probeCalls).toBe(1);
    expect(readFileSync(fixture.target, 'utf8')).toBe(library.policyBytes(library.managedPolicy(changed)));
  });

  it('blocks when our recorded file was replaced by something else', async () => {
    const fixture = layoutFixture();
    await runApply(fixture);
    writeFileSync(fixture.target, '{"policies":{"SomeoneElse":true}}\n');
    const second = await runApply(fixture);
    expect(second.result.status).toBe('blocked-by-existing-policy');
    expect(second.probeCalls).toBe(0);
    expect(readFileSync(fixture.target, 'utf8')).toBe('{"policies":{"SomeoneElse":true}}\n');
  });

  it('logs one honest line for an unusable setting value', async () => {
    const fixture = layoutFixture();
    const run = await runApplySetting(fixture, { env: { STEALTH_PASSWORD_MANAGER: 'maybe' } });
    expect(run.result.status).toBe('off');
    expect(run.logs.join('\n')).toContain('not a boolean');
    expect(existsSync(fixture.target)).toBe(false);
  });
});

// --- the launcher ----------------------------------------------------------
describe('launcher wiring', () => {
  it('wires only the camoufox launcher to the helper', () => {
    const source = readFileSync(path.join(universalDir, 'launch-camoufox.mjs'), 'utf8');
    expect(source).toContain("from './lib/password-manager.mjs'");
    expect(source).toContain('applyPasswordManager({');
    for (const launcher of ['launch.mjs', 'launch-camoufox-native.mjs', 'launch-kameleo.mjs']) {
      const other = readFileSync(path.join(universalDir, launcher), 'utf8');
      expect(other).not.toContain('password-manager.mjs');
      expect(other).not.toContain('applyPasswordManager');
    }
  });

  it('adds no state variable when the setting is off', () => {
    for (const value of [undefined, '', 'false', '0', 'no', 'off']) {
      const env = camoufoxLauncher.buildChildEnv({
        PLAYWRIGHT_MCP_HEADLESS: 'false',
        ...(value === undefined ? {} : { STEALTH_PASSWORD_MANAGER: value }),
      });
      expect(env.STEALTH_PASSWORD_MANAGER_STATE, `${String(value)}`).toBeUndefined();
      expect(env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS).toBe('0');
    }
  });

  it.each(['cloakbrowser', 'camoufox'])('ships %s a byte-identical helper', (name) => {
    const canonical = readFileSync(path.join(repoRoot, 'shared', 'core', 'lib', 'password-manager.mjs'));
    const copy = path.join(repoRoot, 'plugins', name, 'lib', 'password-manager.mjs');
    expect(existsSync(copy)).toBe(true);
    expect(readFileSync(copy).equals(canonical)).toBe(true);
  });
});

// --- the Python entry logic ------------------------------------------------
describe('the Python saved-login logic', () => {
  it('merges the four prefs into the wrapper config as specified', () => {
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
    'password-manager.mjs',
    'ping-timeout.mjs',
    'profile.mjs',
    'provision.mjs',
    'surface.mjs',
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
  'passwordManagerStore',
] as const;

function report(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(REPORT_KEYS.map((key) => [key, value[key]]));
}

function hasReport(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => key.startsWith('passwordManager'));
}

function appliedRecord(root: string, content: string): { file: string; record: Record<string, unknown> } {
  const file = path.join(root, 'policies.json');
  writeFileSync(file, content);
  const dataDir = path.join(root, 'data');
  const stored = {
    version: 1,
    engine: 'camoufox',
    status: 'applied',
    build: 'v156.0.1-beta.39',
    policyFile: file,
    sourcePolicyHash: 'source',
    contentHash: library.sha256(content),
    probeHash: 'probe',
    verified: true,
  };
  library.writePasswordPolicyRecord(dataDir, stored);
  return { file, record: stored };
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

  it('reports the pending state before the launcher prepared the policy file', async () => {
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
      passwordManagerStore: 'missing',
    });
    expect(String(capabilities.passwordManagerNote)).toContain('backend starts');
    expect(report(await payload(session, 'browser_engine_status'))).toEqual(report(capabilities));
    expect(initialized.result?.instructions ?? '').not.toContain('Saved logins');
  });

  it('reports the managed file and the Firefox login store when applied', async () => {
    const root = tempRoot('password-applied-');
    const plugin = createStubPlugin(root);
    const profile = path.join(root, 'profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(path.join(profile, 'logins.db'), 'not a database');
    const { file } = appliedRecord(root, `${JSON.stringify({ policies: { A: true } }, null, 2)}\n`);
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
      passwordManagerSource: 'setting',
      passwordManagerPolicyFile: file,
      passwordManagerStore: 'firefox-logins-db-present',
    });
    expect(Object.hasOwn(capabilities, 'passwordManagerNote')).toBe(false);
    expect(report(await payload(session, 'browser_engine_status'))).toEqual(report(capabilities));
    expect(initialized.result?.instructions ?? '').toContain('Saved logins are enabled for this profile');
    expect(initialized.result?.instructions ?? '').toContain('treat them as secrets');
  });

  it('reports a missing store without opening anything', async () => {
    const root = tempRoot('password-no-store-');
    const plugin = createStubPlugin(root);
    const profile = path.join(root, 'profile');
    mkdirSync(profile, { recursive: true });
    appliedRecord(root, `${JSON.stringify({ policies: {} }, null, 2)}\n`);
    const session = startBroker({
      pluginDir: plugin,
      dataDir: path.join(root, 'data'),
      engine: 'camoufox',
      env: { STEALTH_PASSWORD_MANAGER: 'true', PLAYWRIGHT_MCP_USER_DATA_DIR: profile },
    });
    await initialize(session);
    const capabilities = await payload(session, 'browser_capabilities');
    expect(capabilities.passwordManagerStore).toBe('missing');
  });

  it('reports a foreign or modified policy file as blocked', async () => {
    const root = tempRoot('password-modified-');
    const plugin = createStubPlugin(root);
    const { file } = appliedRecord(root, `${JSON.stringify({ policies: {} }, null, 2)}\n`);
    writeFileSync(file, '{"policies":{"SomeoneElse":true}}\n');
    const session = startBroker({
      pluginDir: plugin,
      dataDir: path.join(root, 'data'),
      engine: 'camoufox',
      env: { STEALTH_PASSWORD_MANAGER: 'true' },
    });
    const initialized = await initialize(session);
    const capabilities = await payload(session, 'browser_capabilities');
    expect(report(capabilities)).toMatchObject({
      passwordManagerEnabled: false,
      passwordManagerApplies: true,
      passwordManagerSource: 'blocked-by-existing-policy',
      passwordManagerPolicyFile: null,
      passwordManagerStore: 'missing',
    });
    expect(String(capabilities.passwordManagerNote)).toContain('no longer matches');
    expect(initialized.result?.instructions ?? '').toContain('Saved logins:');
    expect(initialized.result?.instructions ?? '').not.toContain('Saved logins are enabled');
  });

  it('reports the launcher-recorded blocked states', async () => {
    for (const status of ['blocked-by-existing-policy', 'blocked-by-build-policy']) {
      const root = tempRoot(`password-blocked-${status}-`);
      const plugin = createStubPlugin(root);
      const dataDir = path.join(root, 'data');
      const file = path.join(root, 'policies.json');
      writeFileSync(file, '{"policies":{"Foreign":true}}\n');
      library.writePasswordPolicyRecord(dataDir, {
        version: 1,
        engine: 'camoufox',
        status,
        build: 'v156.0.1-beta.39',
        policyFile: status === 'blocked-by-existing-policy' ? file : null,
        note:
          status === 'blocked-by-existing-policy'
            ? 'Saved logins: foreign file.'
            : 'Saved logins: build policy.',
        checkedAt: '2026-10-26T00:00:00Z',
      });
      const session = startBroker({
        pluginDir: plugin,
        dataDir,
        engine: 'camoufox',
        env: { STEALTH_PASSWORD_MANAGER: 'true' },
      });
      await initialize(session);
      const capabilities = await payload(session, 'browser_capabilities');
      expect(capabilities.passwordManagerSource, `${status}`).toBe(status);
      expect(capabilities.passwordManagerEnabled).toBe(false);
      expect(report(await payload(session, 'browser_engine_status'))).toEqual(report(capabilities));
    }
  });

  it('reports the 2.15.1 Windows dead path from the record the launcher writes', async () => {
    const root = tempRoot('password-dead-path-');
    const plugin = createStubPlugin(root);
    const dataDir = path.join(root, 'data');
    // Exactly the step the camoufox launcher runs when the setting is on.
    const applied = await runApplySetting(layoutFixture(), { pluginDataDir: dataDir });
    expect(applied.result.status).toBe('blocked-by-build-policy');
    expect(applied.pathCalls).toBe(0);
    expect(applied.probeCalls).toBe(0);
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
      passwordManagerSource: 'blocked-by-build-policy',
      passwordManagerPolicyFile: null,
      passwordManagerStore: 'missing',
    });
    expect(String(capabilities.passwordManagerNote)).toBe(library.PASSWORD_MANAGER_WINDOWS_DEAD_PATH_NOTE);
    expect(report(await payload(session, 'browser_engine_status'))).toEqual(report(capabilities));
    expect(initialized.result?.instructions ?? '').toContain(
      'no readable per-user Firefox policy directory on Windows',
    );
    expect(initialized.result?.instructions ?? '').not.toContain('Saved logins are enabled');
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
        passwordManagerStore: null,
      });
      expect(String(capabilities.passwordManagerNote), `${engine}`).toContain(
        engine === 'camoufox-native'
          ? 'mcp-camoufox 0.4.5 has no Firefox prefs input'
          : 'applies only to the camoufox engine',
      );
      expect(report(await payload(session, 'browser_engine_status'))).toEqual(report(capabilities));
    }
  });
});
