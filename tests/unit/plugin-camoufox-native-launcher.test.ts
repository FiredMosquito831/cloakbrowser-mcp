import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface FingerprintResolution {
  value: string | null;
  source: string;
  warning: string | null;
}

interface LauncherModule {
  HOST_FINGERPRINT_OS: Record<string, string>;
  buildChildEnv(source: Record<string, string | undefined>, platform?: string): Record<string, string>;
  resolveFingerprintOs(rawValue: string | undefined, platform: string): FingerprintResolution;
}

const launcher = (await import(
  new URL('../../plugins/cloakbrowser/launch-camoufox-native.mjs', import.meta.url).href
)) as unknown as LauncherModule;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const launcherPath = path.join(repoRoot, 'plugins', 'cloakbrowser', 'launch-camoufox-native.mjs');
const baseEnv = {
  CLAUDE_PLUGIN_DATA: 'D:/scratch/plugin-data',
  CAMOUFOX_PROFILE: 'acct-one',
  PLAYWRIGHT_MCP_HEADLESS: 'false',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('camoufox-native fingerprint OS default', () => {
  it('maps the host platform to the Camoufox OS name', () => {
    expect(launcher.HOST_FINGERPRINT_OS).toEqual({
      darwin: 'macos',
      linux: 'linux',
      win32: 'windows',
    });
  });

  it.each([
    ['win32', 'windows'],
    ['darwin', 'macos'],
    ['linux', 'linux'],
  ])('defaults an unset value to the host OS on %s', (platform, expected) => {
    expect(launcher.resolveFingerprintOs(undefined, platform)).toEqual({
      value: expected,
      source: 'host-default',
      warning: null,
    });
    expect(launcher.resolveFingerprintOs('', platform)).toMatchObject({ value: expected });
    expect(launcher.resolveFingerprintOs('   ', platform)).toMatchObject({ value: expected });
  });

  it.each(['windows', 'macos', 'linux'])('keeps an explicit %s value on every host', (value) => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(launcher.resolveFingerprintOs(value, platform)).toEqual({
        value,
        source: 'explicit',
        warning: null,
      });
    }
  });

  it('normalises case and surrounding whitespace on an explicit value', () => {
    expect(launcher.resolveFingerprintOs('  MACOS ', 'win32')).toEqual({
      value: 'macos',
      source: 'explicit',
      warning: null,
    });
  });

  it('falls back to the host default with a warning for an invalid value', () => {
    const resolution = launcher.resolveFingerprintOs('beos', 'win32');
    expect(resolution.value).toBe('windows');
    expect(resolution.source).toBe('host-default');
    expect(resolution.warning).toContain('beos');
    expect(resolution.warning).toContain('host default "windows"');
  });

  it('leaves the value unset with a warning on a platform with no Camoufox name', () => {
    const resolution = launcher.resolveFingerprintOs('beos', 'freebsd');
    expect(resolution.value).toBeNull();
    expect(resolution.warning).toContain('no Camoufox host default');
    expect(launcher.resolveFingerprintOs(undefined, 'freebsd')).toMatchObject({
      value: null,
      source: 'none',
    });
  });
});

describe('buildChildEnv fingerprint OS', () => {
  it('sets the host OS when the user did not set one', () => {
    const env = launcher.buildChildEnv(baseEnv, 'win32');
    expect(env.CAMOUFOX_FINGERPRINT_OS).toBe('windows');
    expect(env.CAMOUFOX_DAEMON).toBe('false');
    expect(env.CAMOUFOX_PROFILE).toBe('acct-one');
  });

  it('keeps an explicit value and ignores the host', () => {
    const env = launcher.buildChildEnv({ ...baseEnv, CAMOUFOX_FINGERPRINT_OS: 'linux' }, 'win32');
    expect(env.CAMOUFOX_FINGERPRINT_OS).toBe('linux');
  });

  it('falls back to the host default and logs one line for an invalid value', () => {
    const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const env = launcher.buildChildEnv({ ...baseEnv, CAMOUFOX_FINGERPRINT_OS: 'beos' }, 'win32');
    expect(env.CAMOUFOX_FINGERPRINT_OS).toBe('windows');
    const text = writes.mock.calls.map((call) => String(call[0])).join('');
    expect(text).toContain('[camoufox-native]');
    expect(text).toContain('CAMOUFOX_FINGERPRINT_OS "beos"');
    expect(text).toContain('host default "windows"');
  });

  it('does not write a warning for the normal host default', () => {
    const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    launcher.buildChildEnv(baseEnv, 'darwin');
    expect(writes).not.toHaveBeenCalled();
  });

  it('is exported from the launcher that the manifest names', () => {
    const source = readFileSync(launcherPath, 'utf8');
    expect(source).toContain('export function resolveFingerprintOs');
    expect(source).toContain('export function buildChildEnv');
    expect(source).toContain('HOST_FINGERPRINT_OS');
    expect(source).toContain('pathToFileURL');
  });
});
