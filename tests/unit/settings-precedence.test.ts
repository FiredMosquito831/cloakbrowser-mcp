import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Harness identity and the additive profile precedence report (2.25.0). The
// rule lives in one vendored core module shared by the broker, the pointer
// helpers and the CLI. These cases prove the four-case rule, plugin-path
// inference, the one-log-line contract and that a read never writes.

interface HarnessResult {
  id: string | null;
  source: 'env' | 'unset';
  error: string | null;
}

interface PointerRead {
  path: string;
  exists: boolean;
  name: string | null;
  state: 'missing' | 'present' | 'invalid';
  error: string | null;
}

interface PrecedenceModule {
  HARNESS_ID_PATTERN: RegExp;
  INFERRED_HARNESS_ID: string;
  normalizeHarnessId(value: unknown): string | null;
  resolveHarness(env?: Record<string, string | undefined>, log?: (message: string) => void): HarnessResult;
  profilePrecedenceReport(options: Record<string, unknown>): Record<string, unknown>;
  pointerSource(pointer: PointerRead | null): string | null;
  globalPointerReport(pointer: PointerRead | null): Record<string, unknown> | null;
}

const precedence = (await import(
  new URL('../../plugins/cloakbrowser/lib/settings-precedence.mjs', import.meta.url).href
)) as unknown as PrecedenceModule;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveHarness', () => {
  it('normalizes a valid id with trim + lowercase and reports source "env"', () => {
    expect(precedence.HARNESS_ID_PATTERN).toEqual(/^[a-z0-9][a-z0-9-]{0,31}$/);
    expect(precedence.INFERRED_HARNESS_ID).toBe('claude-code');
    expect(precedence.normalizeHarnessId('  Claude-Code ')).toBe('claude-code');
    expect(precedence.normalizeHarnessId('a'.repeat(32))).toBe('a'.repeat(32));
    expect(precedence.normalizeHarnessId('a'.repeat(33))).toBeNull();
    const log = vi.fn();
    expect(precedence.resolveHarness({ STEALTH_HARNESS: '  OpenCode  ' }, log)).toEqual({
      id: 'opencode',
      source: 'env',
      error: null,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('treats %s as a silent unset value', (_label, value) => {
    const log = vi.fn();
    expect(precedence.resolveHarness({ STEALTH_HARNESS: value }, log)).toEqual({
      id: null,
      source: 'unset',
      error: null,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['placeholder', '${user_config.harness}'],
    ['underscore', 'A_b'],
    ['slash', 'a/b'],
    ['dot', 'a.b'],
    ['trailing dash', 'claude-code-'],
    ['overlong', 'a'.repeat(33)],
    ['multi-line', 'claude-code\nother'],
    ['non-string', 42],
  ])('treats %s as unset with exactly one log line', (_label, value) => {
    const log = vi.fn();
    const result = precedence.resolveHarness({ STEALTH_HARNESS: value as string }, log);
    expect(result.id).toBeNull();
    expect(result.source).toBe('unset');
    expect(result.error).toMatch(/STEALTH_HARNESS/u);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).not.toContain('\n');
  });

  it('infers only from the plugin-manager data root, never from a CLI alias', () => {
    const log = vi.fn();
    expect(precedence.resolveHarness({ CLAUDE_PLUGIN_DATA: 'D:/data' }, log)).toEqual({
      id: 'claude-code',
      source: 'env',
      error: null,
    });
    expect(precedence.resolveHarness({ STEALTH_DATA_DIR: 'D:/alias' }, log)).toEqual({
      id: null,
      source: 'unset',
      error: null,
    });
    expect(
      precedence.resolveHarness({ CLAUDE_PLUGIN_DATA: 'D:/data', STEALTH_DATA_DIR: 'D:/alias' }, log),
    ).toEqual({ id: null, source: 'unset', error: null });
    expect(log).not.toHaveBeenCalled();
  });

  it('never replaces an explicit bad value with the inferred id', () => {
    const log = vi.fn();
    expect(
      precedence.resolveHarness({ CLAUDE_PLUGIN_DATA: 'D:/data', STEALTH_HARNESS: 'bad/id' }, log),
    ).toEqual({ id: null, source: 'unset', error: expect.stringContaining('STEALTH_HARNESS') });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('does not infer for an explicitly empty value and never writes a file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'harness-no-write-'));
    roots.push(root);
    precedence.resolveHarness({ CLAUDE_PLUGIN_DATA: root, STEALTH_HARNESS: '' });
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(path.join(root, '.default.claude-code'))).toBe(false);
  });
});

describe('profile precedence report', () => {
  const harnessPointer: PointerRead = {
    path: 'D:/data/profiles/cloak/.default.claude-code',
    exists: true,
    name: 'work',
    state: 'present',
    error: null,
  };
  const globalPointer: PointerRead = {
    path: 'D:/data/profiles/cloak/.default',
    exists: true,
    name: null,
    state: 'invalid',
    error: 'broken global pointer',
  };

  it('builds the full additive profile half without targetDir', () => {
    expect(
      precedence.profilePrecedenceReport({
        harness: { id: 'claude-code', source: 'env', error: null },
        session: { profile_dir: null, account: 'alice' },
        harnessPointer,
        globalPointer,
        pointerLevel: 'harness',
        won: 'pointer',
      }),
    ).toEqual({
      harness: { id: 'claude-code', source: 'env', error: null },
      profile: {
        won: 'pointer',
        session: { profile_dir: null, account: 'alice' },
        harness: { path: harnessPointer.path, state: 'present', name: 'work', error: null },
        global: { path: globalPointer.path, state: 'invalid', name: null, error: 'broken global pointer' },
      },
    });
  });

  it('reports unread files as not-applicable and maps the pointer source vocabulary', () => {
    const report = precedence.profilePrecedenceReport({
      harness: { id: null, source: 'unset', error: null },
    }) as { profile: { harness: Record<string, unknown>; global: Record<string, unknown> } };
    expect(report.profile.harness).toEqual({
      path: null,
      state: 'not-applicable',
      name: null,
      error: null,
    });
    expect(precedence.pointerSource(null)).toBeNull();
    expect(precedence.pointerSource(globalPointer)).toBe('invalid');
    expect(precedence.pointerSource({ ...globalPointer, state: 'present' })).toBe('pointer');
    expect(precedence.globalPointerReport(null)).toBeNull();
    expect(precedence.globalPointerReport(globalPointer)).toEqual({
      name: null,
      source: 'invalid',
      path: globalPointer.path,
      error: 'broken global pointer',
    });
  });
});
