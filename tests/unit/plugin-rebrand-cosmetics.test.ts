import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// PR 2 of the collection rebrand. The broker's visible strings change, but the
// serverInfo name must never become an input to the tool-cache key or to a
// profile/lock path: those keys survive broker releases so a rename cannot
// strand cached tool lists or move a user's profile. This test reads the literal
// out of the canonical source, so it keeps proving the invariant when the chosen
// name changes again. The source-shape guards fail if a future change wires
// serverInfo into any of those builders, and the value guards fail if a path or
// key is derived from the name.

interface ToolCacheModule {
  toolCacheKey(input: {
    engineId: string;
    toolProfile: string;
    caps: Record<string, unknown>;
    serverInfo?: { name: string };
  }): string;
}
interface ProfileModule {
  accountProfileDir(engineId: string, account: string, dataDir: string): string;
  defaultProfileDir(engineId: string, dataDir: string, launcherName?: string): string;
  effectiveProfileDir(resolution: unknown): string | null;
  profileDefaultPointerPath(engineId: string, dataDir: string): string;
  profileLockPath(profileDir: string): string;
  resolveProfile(options: {
    account: string | null;
    cwd: string;
    dataDir: string;
    engineId: string;
    pointer: string | null;
    profileDir: string | null;
    serverInfo?: { name: string };
  }): unknown;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const brokerPath = path.join(repoRoot, 'shared', 'core', 'broker.mjs');
const corePath = path.join(repoRoot, 'shared', 'core');
const brokerSource = readFileSync(brokerPath, 'utf8');
const toolCacheSource = readFileSync(path.join(corePath, 'lib', 'tool-cache.mjs'), 'utf8');
const profileSource = readFileSync(path.join(corePath, 'lib', 'profile.mjs'), 'utf8');
const toolCache = (await import(
  new URL('../../shared/core/lib/tool-cache.mjs', import.meta.url).href
)) as unknown as ToolCacheModule;
const profile = (await import(
  new URL('../../shared/core/lib/profile.mjs', import.meta.url).href
)) as unknown as ProfileModule;

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `missing ${signature}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  expect(open, `missing body for ${signature}`).toBeGreaterThan(start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unbalanced body for ${signature}`);
}

function brokerServerInfoName(): string {
  const match = /serverInfo:\s*\{\s*\n\s*name:\s*'([^']+)'/.exec(brokerSource);
  expect(match, 'broker serverInfo name literal').not.toBeNull();
  return match?.[1] ?? '';
}

describe('broker cosmetic rebrand', () => {
  it('uses collection wording at every cosmetic surface', () => {
    expect(brokerServerInfoName()).toBe('secret-agent-browser-mcps-broker');
    expect(brokerSource).toContain("title: 'Secret Agent Browser MCPs broker'");
    expect(brokerSource).toContain("const LOG_PREFIX = '[secret-agent-browser-mcps-broker]'");
    expect(brokerSource).toContain("const ROOTS_PROBE_ID = 'secret-agent-browser-mcps-broker-roots'");
    expect(brokerSource).toContain('disabled by the secret-agent-browser-mcps collection');
  });

  it('does not wire serverInfo into the tool-cache key builders', () => {
    const builders = [
      functionBody(toolCacheSource, 'export function toolCacheKey('),
      functionBody(brokerSource, 'function toolCacheCaps()'),
      functionBody(brokerSource, 'function toolCacheFile()'),
    ].join('\n');
    expect(builders).not.toMatch(/serverInfo|serverName|SERVER_NAME|BROKER_NAME/i);

    const name = brokerServerInfoName();
    const input = {
      engineId: 'cloak',
      toolProfile: 'full',
      caps: { groups: { vision: true }, packagePin: 'cloakbrowser-mcp@1.15.1', surface: 'abc123' },
    };
    const baseline = toolCache.toolCacheKey(input);
    expect(toolCache.toolCacheKey({ ...input, serverInfo: { name } })).toBe(baseline);
    expect(toolCache.toolCacheKey({ ...input, serverInfo: { name: 'a-different-broker' } })).toBe(baseline);
  });

  it('does not wire serverInfo into profile or lock paths', () => {
    const builders = [
      functionBody(profileSource, 'export function defaultProfileDir('),
      functionBody(profileSource, 'export function accountProfileDir('),
      functionBody(profileSource, 'export function profileDefaultPointerPath('),
      functionBody(profileSource, 'export function profileLockPath('),
      functionBody(profileSource, 'export function effectiveProfileDir('),
      functionBody(profileSource, 'export function resolveProfile('),
    ].join('\n');
    expect(builders).not.toMatch(/serverInfo|serverName|SERVER_NAME|BROKER_NAME/i);

    const name = brokerServerInfoName();
    const dataDir = path.join(path.sep, 'rebrand-proof', 'plugin-data');
    const options = {
      account: 'alice',
      cwd: path.join(path.sep, 'rebrand-proof', 'workspace'),
      dataDir,
      engineId: 'cloak',
      pointer: null,
      profileDir: null,
    };
    const baseline = profile.resolveProfile(options);
    const changed = profile.resolveProfile({ ...options, serverInfo: { name: 'a-different-broker' } });
    expect(changed).toEqual(baseline);

    const baseDir = profile.effectiveProfileDir(baseline);
    const changedDir = profile.effectiveProfileDir(changed);
    expect(baseDir).not.toBeNull();
    expect(changedDir).toBe(baseDir);
    const paths = [
      profile.defaultProfileDir('cloak', dataDir),
      profile.accountProfileDir('cloak', 'alice', dataDir),
      profile.profileDefaultPointerPath('cloak', dataDir),
      profile.profileLockPath(baseDir ?? ''),
      profile.profileLockPath(changedDir ?? ''),
    ];
    for (const value of paths) {
      expect(value).not.toContain(name);
    }
    expect(profile.profileLockPath(changedDir ?? '')).toBe(profile.profileLockPath(baseDir ?? ''));
  });
});
