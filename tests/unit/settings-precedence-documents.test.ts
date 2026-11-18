import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 2.26.0: exact 16-key x 5-case x 3-level matrix, document safety and the
// additive report. The vendored plugin module is the one the broker runs.

type Json = Record<string, unknown>;

interface Skip {
  level: string;
  value: string;
  reason: string;
}

interface Entry {
  level: string;
  source: string;
  value: unknown;
  skipped: Skip[];
}

interface Layered {
  enabled: boolean;
  env: Record<string, string | undefined>;
  report: Record<string, Entry>;
  resolution: Record<string, { resolver: Json }>;
  note: string | null;
}

interface ReadDocument {
  path: string | null;
  state: string;
  version: number | null;
  keys: number;
  error: string | null;
  settings: Record<string, string>;
  problems: Skip[];
}

interface Module {
  DOCUMENT_SETTINGS_KEYS: string[];
  SETTINGS_LEVEL_ENV: string;
  SETTINGS_DOCUMENT_LIMIT_BYTES: number;
  resolveSettingsLevel(env: Json, log?: (message: string) => void): { value: string; source: string };
  settingsDocumentsEnabled(env: Json, level: string): boolean;
  readSettingsDocument(options: Json): ReadDocument;
  resolveLayeredSettings(options: Json): Layered;
  settingsPrecedenceReport(base: Json, state: Json): Json;
}

const precedence = (await import(
  new URL('../../plugins/cloakbrowser/lib/settings-precedence.mjs', import.meta.url).href
)) as unknown as Module;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'settings-docs-'));
  roots.push(dir);
  return dir;
}

function document(
  dir: string,
  level: 'global' | 'harness',
  settings: Json,
  harnessId = 'claude-code',
): string {
  const file =
    level === 'global' ? path.join(dir, 'settings.json') : path.join(dir, 'settings.d', `${harnessId}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, settings }, null, 2)}\n`);
  return file;
}

function resolve(env: Json, dir: string, settingsLevel = 'auto'): Layered {
  const documents = {
    global: precedence.readSettingsDocument({ dataDir: dir, level: 'global' }),
    harness: precedence.readSettingsDocument({ dataDir: dir, level: 'harness', harnessId: 'claude-code' }),
  };
  return precedence.resolveLayeredSettings({
    env,
    documents,
    settingsLevel,
    dataRootEnabled: precedence.settingsDocumentsEnabled(env, settingsLevel),
    engine: { defaultToolProfile: 'minimal' },
    profiles: { profiles: { full: { tools: [] }, portable: { tools: [] }, minimal: { tools: [] } } },
  });
}

const SAFE: Record<string, unknown> = {
  profile_isolation: 'shared',
  on_locked: 'copy',
  copy_contents: 'identity',
  profile_lifetime: 'browser',
  seat_limit: 'engine-default',
  identity_mode: 'profile',
  ping_timeout_ms: 0,
  password_manager: false,
  headless: false,
  humanize: true,
  human_preset: 'default',
  release_channel: 'stable',
  proxy_bypass: null,
  engine_version: null,
  output_dir: null,
  tool_profile: 'minimal',
};

const CASES: Record<string, { placeholder?: string; unknown: string; valid: string; expected: unknown }> = {
  profile_isolation: { unknown: 'nope', valid: 'session', expected: 'session' },
  on_locked: { unknown: 'nope', valid: 'block', expected: 'block' },
  copy_contents: { unknown: 'nope', valid: 'full', expected: 'full' },
  profile_lifetime: { unknown: 'nope', valid: 'server', expected: 'server' },
  seat_limit: { unknown: 'nope', valid: 'unlimited', expected: 'unlimited' },
  identity_mode: { unknown: 'nope', valid: 'random', expected: 'random' },
  ping_timeout_ms: {
    placeholder: '${user_config.ping_timeout_ms}',
    unknown: 'abc',
    valid: '1234',
    expected: 1234,
  },
  password_manager: { unknown: 'maybe', valid: 'true', expected: true },
  headless: { unknown: 'maybe', valid: 'true', expected: true },
  humanize: { unknown: 'maybe', valid: 'false', expected: false },
  human_preset: { unknown: 'fast', valid: 'careful', expected: 'careful' },
  release_channel: { unknown: 'nightly', valid: 'preview', expected: 'preview' },
  proxy_bypass: { unknown: '${user_config.proxy_bypass}', valid: 'localhost', expected: 'localhost' },
  engine_version: { unknown: '${user_config.engine_version}', valid: '1.2.3', expected: '1.2.3' },
  output_dir: { unknown: '${user_config.output_dir}', valid: '/tmp/out', expected: '/tmp/out' },
  tool_profile: { unknown: 'missing-profile', valid: 'full', expected: 'full' },
};

const ENV_NAME: Record<string, string> = {
  profile_isolation: 'STEALTH_PROFILE_ISOLATION',
  on_locked: 'STEALTH_ON_LOCKED',
  copy_contents: 'STEALTH_COPY_CONTENTS',
  profile_lifetime: 'STEALTH_PROFILE_LIFETIME',
  seat_limit: 'STEALTH_SEAT_LIMIT',
  identity_mode: 'STEALTH_IDENTITY_MODE',
  ping_timeout_ms: 'STEALTH_PING_TIMEOUT_MS',
  password_manager: 'STEALTH_PASSWORD_MANAGER',
  headless: 'PLAYWRIGHT_MCP_HEADLESS',
  humanize: 'CLOAK_PLAYWRIGHT_MCP_HUMANIZE',
  human_preset: 'CLOAK_PLAYWRIGHT_MCP_HUMAN_PRESET',
  release_channel: 'CLOAK_PLAYWRIGHT_MCP_RELEASE_CHANNEL',
  proxy_bypass: 'PLAYWRIGHT_MCP_PROXY_BYPASS',
  engine_version: 'CLOAKBROWSER_VERSION',
  output_dir: 'PLAYWRIGHT_MCP_OUTPUT_DIR',
  tool_profile: 'STEALTH_TOOL_PROFILE',
};

const PROFILE_WRAPPERS = new Set([
  'profile_isolation',
  'on_locked',
  'copy_contents',
  'profile_lifetime',
  'seat_limit',
  'identity_mode',
  'tool_profile',
]);
const LAUNCHER_WRAPPERS = new Set([
  'headless',
  'humanize',
  'human_preset',
  'release_channel',
  'proxy_bypass',
  'engine_version',
  'output_dir',
]);

function expectedResolver(): Json {
  return { ignored: null, placeholder: null, problem: null };
}

function skipReason(key: string, raw: unknown): string {
  if (key === 'ping_timeout_ms') {
    return String(raw).includes('${') ? 'placeholder' : 'invalid';
  }
  return String(raw).includes('${') ? 'unsubstituted placeholder' : 'not one of the documented choices';
}

describe('16 keys x 5 raw cases x 3 levels', () => {
  const raws = {
    unset: undefined,
    empty: '',
    placeholder: '${user_config.key}',
    unknown: 'UNKNOWN',
    valid: 'VALID',
  } as const;

  for (const [key, spec] of Object.entries(CASES)) {
    for (const [label, baseRaw] of Object.entries(raws)) {
      for (const level of ['session', 'harness', 'global'] as const) {
        it(`${key} / ${label} / ${level}`, () => {
          const dir = root();
          const raw =
            label === 'unknown'
              ? spec.unknown
              : label === 'valid'
                ? spec.valid
                : label === 'placeholder'
                  ? (spec.placeholder ?? '${user_config.key}')
                  : baseRaw;
          const env: Json = { STEALTH_DATA_DIR: dir };
          const settings: Json = {};
          if (level === 'session') {
            env[ENV_NAME[key]] = raw;
          } else {
            settings[key] = raw;
            document(dir, level, settings);
          }
          const result = resolve(env, dir);
          const expected: Entry =
            label === 'valid'
              ? {
                  level,
                  source: level === 'session' ? 'setting' : 'document',
                  value: spec.expected,
                  skipped: [],
                }
              : label === 'unset' || label === 'empty'
                ? { level: 'default', source: 'default', value: SAFE[key], skipped: [] }
                : {
                    level: 'default',
                    source: 'default',
                    value: SAFE[key],
                    skipped: [{ level, value: String(raw).slice(0, 60), reason: skipReason(key, raw) }],
                  };
          expect(result.report[key]).toEqual(expected);
          expect(result.resolution[key].resolver).toMatchObject(expectedResolver());
          expect(
            PROFILE_WRAPPERS.has(key) ||
              LAUNCHER_WRAPPERS.has(key) ||
              key === 'ping_timeout_ms' ||
              key === 'password_manager',
          ).toBe(true);
        });
      }
    }
  }
});

describe('ladder, settings_level and reporting', () => {
  it('keeps session above documents in auto and promotes only an explicit document level', () => {
    const dir = root();
    document(dir, 'global', { headless: 'false', output_dir: '/global' });
    document(dir, 'harness', { headless: 'true', output_dir: '/harness' });
    const env: Json = {
      STEALTH_DATA_DIR: dir,
      PLAYWRIGHT_MCP_HEADLESS: 'false',
      PLAYWRIGHT_MCP_OUTPUT_DIR: '/session',
    };
    expect(resolve(env, dir).report.headless).toEqual({
      level: 'session',
      source: 'setting',
      value: false,
      skipped: [],
    });
    expect(resolve(env, dir, 'global').report.headless.value).toBe(false);
    expect(resolve(env, dir, 'global').report.headless.level).toBe('global');
    expect(resolve(env, dir, 'harness').report.headless.value).toBe(true);
    expect(resolve(env, dir, 'harness').report.headless.level).toBe('harness');
    expect(resolve(env, dir, 'session').report.headless.level).toBe('session');
  });

  it('resolves unusable and explicit settings levels without being fatal', () => {
    const log = vi.fn();
    for (const value of [undefined, '', '${user_config.level}', 'nope', 'a'.repeat(40)]) {
      const env = value === undefined ? {} : { STEALTH_SETTINGS_LEVEL: value };
      expect(precedence.resolveSettingsLevel(env, log)).toEqual({ value: 'auto', source: 'default' });
    }
    expect(log).toHaveBeenCalledTimes(3);
    expect(precedence.resolveSettingsLevel({ STEALTH_SETTINGS_LEVEL: 'Harness' }, log)).toEqual({
      value: 'harness',
      source: 'env',
    });
  });

  it('opens the gate only for an alias or an explicit document level', () => {
    expect(precedence.settingsDocumentsEnabled({ CLAUDE_PLUGIN_DATA: 'D:/data' }, 'auto')).toBe(false);
    expect(precedence.settingsDocumentsEnabled({ CLAUDE_PLUGIN_DATA: 'D:/data' }, 'session')).toBe(false);
    expect(
      precedence.settingsDocumentsEnabled(
        { CLAUDE_PLUGIN_DATA: 'D:/data', STEALTH_SETTINGS_LEVEL: 'global' },
        'global',
      ),
    ).toBe(true);
    expect(precedence.settingsDocumentsEnabled({ STEALTH_DATA_DIR: 'D:/data' }, 'auto')).toBe(true);
  });

  it('lets a valid engine ping variable win and refuses an unusable one without fallthrough', () => {
    const dir = root();
    document(dir, 'global', { ping_timeout_ms: '900' });
    expect(
      resolve({ STEALTH_DATA_DIR: dir, PLAYWRIGHT_MCP_PING_TIMEOUT_MS: '500' }, dir).report.ping_timeout_ms,
    ).toEqual({ level: 'env', source: 'env', value: 500, skipped: [] });
    const refused = resolve({ STEALTH_DATA_DIR: dir, PLAYWRIGHT_MCP_PING_TIMEOUT_MS: 'abc' }, dir);
    expect(refused.report.ping_timeout_ms).toEqual({
      level: 'default',
      source: 'default',
      value: 0,
      skipped: [{ level: 'env', value: 'abc', reason: 'invalid' }],
    });
  });

  it('reports credentials without values or skipped arrays', () => {
    const dir = root();
    const result = resolve(
      {
        STEALTH_DATA_DIR: dir,
        PLAYWRIGHT_MCP_PROXY_SERVER: 'https://secret@example.invalid',
        CLOAKBROWSER_LICENSE_KEY: 'key-secret',
      },
      dir,
    );
    expect(result.report.proxy_server).toEqual({ level: 'session', configured: true, source: 'setting' });
    expect(result.report.licence_key).toEqual({ level: 'session', configured: true, source: 'setting' });
    expect(JSON.stringify(result.report)).not.toContain('secret');
    expect(result.note).toBeNull();
  });

  it('picks the first skip by key order then level order, independent of insertion order', () => {
    const dir = root();
    document(dir, 'global', { humanize: 'maybe', headless: 'global-bad', profile_isolation: 'also-bad' });
    const result = resolve({ STEALTH_DATA_DIR: dir, STEALTH_PROFILE_ISOLATION: 'session-bad' }, dir);
    expect(result.report.profile_isolation.skipped).toEqual([
      { level: 'session', value: 'session-bad', reason: 'not one of the documented choices' },
      { level: 'global', value: 'also-bad', reason: 'not one of the documented choices' },
    ]);
    expect(result.note).toBe(
      'The session profile_isolation value "session-bad" is not one of the documented choices; ' +
        'the default value "shared" is used instead.',
    );
    expect(result.report.headless.skipped).toHaveLength(1);
    expect(result.report.humanize.skipped).toHaveLength(1);
  });

  it('adds the settings half only for a gated read and lists session-only keys', () => {
    const closed = precedence.settingsPrecedenceReport(
      { harness: {} },
      { enabled: false, documents: {}, settingsLevel: { value: 'auto', source: 'default' }, report: {} },
    );
    expect(closed).toEqual({ harness: {} });
    const open = precedence.settingsPrecedenceReport(
      { harness: {} },
      {
        enabled: true,
        documents: {
          global: {
            path: 'g',
            state: 'present',
            problems: [{ key: 'settings_level', reason: 'session-only', value: 'global' }],
          },
          harness: null,
        },
        settingsLevel: { value: 'global', source: 'env' },
        report: { headless: { level: 'default', source: 'default', value: false, skipped: [] } },
      },
    );
    expect(Object.keys(open)).toEqual(['harness', 'documents', 'settingsLevel', 'settings']);
    expect((open.documents as Json).harness).toMatchObject({ path: null, state: 'not-applicable' });
    expect((open.documents as Json).global).toMatchObject({ sessionOnly: ['settings_level'] });
    expect(open.settingsLevel).toEqual({ value: 'global', source: 'env' });
  });
});

describe('document safety', () => {
  const malformed = [
    ['not JSON', '{oops', 'settings document is not valid JSON', []],
    ['not an object', '[]', 'settings document must be an object with version 1', []],
    [
      'missing version',
      JSON.stringify({ settings: {} }),
      'settings document must be an object with version 1',
      [],
    ],
    [
      'string version',
      JSON.stringify({ version: '1', settings: {} }),
      'settings document must be an object with version 1',
      [],
    ],
    ['no settings', JSON.stringify({ version: 1 }), 'settings document has no settings object', []],
  ] as const;
  for (const [label, text, errorPart, problems] of malformed) {
    it(`${label} is invalid with the exact error and no accepted keys`, () => {
      const dir = root();
      const file = path.join(dir, 'settings.json');
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text);
      const read = precedence.readSettingsDocument({ dataDir: dir, level: 'global' });
      expect(read.state).toBe('invalid');
      expect(read.error).toBe(`${file}: ${errorPart}; it is ignored.`);
      expect(read.version).toBeNull();
      expect(read.keys).toBe(0);
      expect(read.settings).toEqual({});
      expect(read.problems).toEqual([...problems]);
      const result = resolve({ STEALTH_DATA_DIR: dir }, dir);
      expect(result.report.headless).toEqual({
        level: 'default',
        source: 'default',
        value: false,
        skipped: [],
      });
    });
  }

  it('reports invalid-type, unknown and session-only keys exactly', () => {
    const dir = root();
    const file = document(dir, 'global', { headless: true, unknown_key: 'x', settings_level: 'global' });
    const read = precedence.readSettingsDocument({ dataDir: dir, level: 'global' });
    expect(read.state).toBe('present');
    expect(read.error).toBeNull();
    expect(read.version).toBe(1);
    expect(read.keys).toBe(0);
    expect(read.settings).toEqual({});
    expect(read.problems).toEqual([
      { key: 'headless', value: 'true', reason: 'invalid-type' },
      { key: 'unknown_key', value: 'x', reason: 'unknown key' },
      { key: 'settings_level', value: 'global', reason: 'session-only' },
    ]);
    const result = resolve({ STEALTH_DATA_DIR: dir }, dir);
    expect(result.report.headless).toEqual({
      level: 'default',
      source: 'default',
      value: false,
      skipped: [{ level: 'global', value: 'true', reason: 'invalid-type' }],
    });
    expect(result.note).toBe(
      'The global headless value "true" is invalid-type; the default value "false" is used instead.',
    );
    expect(file).toBe(path.join(dir, 'settings.json'));
  });

  it('accepts exactly 64 KB and rejects 64 KB + 1 with the exact state/error pair', () => {
    const dir = root();
    const file = path.join(dir, 'settings.json');
    mkdirSync(dir, { recursive: true });
    const emptySize = Buffer.byteLength(JSON.stringify({ version: 1, settings: { output_dir: '' } }));
    const atLimit = JSON.stringify({
      version: 1,
      settings: { output_dir: 'x'.repeat(65_536 - emptySize) },
    });
    writeFileSync(file, atLimit);
    expect(readFileSync(file).byteLength).toBe(65_536);
    const accepted = precedence.readSettingsDocument({ dataDir: dir, level: 'global' });
    expect(accepted.state).toBe('present');
    expect(accepted.error).toBeNull();
    expect(accepted.version).toBe(1);
    expect(accepted.keys).toBe(1);
    expect(resolve({ STEALTH_DATA_DIR: dir }, dir).report.output_dir.level).toBe('global');

    const overLimit = JSON.stringify({
      version: 1,
      settings: { output_dir: 'x'.repeat(65_537 - emptySize) },
    });
    writeFileSync(file, overLimit);
    expect(readFileSync(file).byteLength).toBe(65_537);
    const rejected = precedence.readSettingsDocument({ dataDir: dir, level: 'global' });
    expect(rejected.state).toBe('invalid');
    expect(rejected.error).toBe(`${file}: settings document exceeds the 64 KB limit; it is ignored.`);
    expect(rejected.keys).toBe(0);
    expect(rejected.settings).toEqual({});
    expect(
      resolve({ STEALTH_DATA_DIR: dir, PLAYWRIGHT_MCP_OUTPUT_DIR: '/session-out' }, dir).report.output_dir,
    ).toEqual({ level: 'session', source: 'setting', value: '/session-out', skipped: [] });
  });

  it('rejects invalid UTF-8 and a 1 MB fixture without accepting a value', () => {
    const dir = root();
    const file = path.join(dir, 'settings.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    const invalidUtf8 = precedence.readSettingsDocument({ dataDir: dir, level: 'global' });
    expect(invalidUtf8.state).toBe('invalid');
    expect(invalidUtf8.error).toBe(`${file}: settings document is not valid UTF-8; it is ignored.`);
    writeFileSync(file, JSON.stringify({ version: 1, settings: { output_dir: 'x'.repeat(1024 * 1024) } }));
    const megabyte = precedence.readSettingsDocument({ dataDir: dir, level: 'global' });
    expect(megabyte.state).toBe('invalid');
    expect(megabyte.error).toBe(`${file}: settings document exceeds the 64 KB limit; it is ignored.`);
  });

  it('treats a directory in place of the document as invalid and writes nothing', () => {
    const dir = root();
    const file = path.join(dir, 'settings.d', 'claude-code.json');
    mkdirSync(file, { recursive: true });
    const before = readdirSync(path.join(dir, 'settings.d'));
    const read = precedence.readSettingsDocument({
      dataDir: dir,
      level: 'harness',
      harnessId: 'claude-code',
    });
    expect(read.state).toBe('invalid');
    expect(read.error).toBe(`${file}: settings document is not a file; it is ignored.`);
    expect(read.settings).toEqual({});
    expect(readdirSync(path.join(dir, 'settings.d'))).toEqual(before);
  });
});
