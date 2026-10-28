import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface Compatibility {
  schemaVersion: number;
  bridge: Record<string, { cloakbrowser: string[] }>;
}

interface PinReport {
  changed: boolean;
  bridge: {
    package: string;
    current: string;
    latest: string;
    target: string;
    decision: string;
    reason: string;
  };
  wrapper: {
    package: string;
    current: string;
    target: string;
    decision: string;
    reason: string;
    bridge: string;
    allowed: string[];
    currentAllowed: boolean;
  };
  pluginVersion: { current: string; target: string; decision: string; reason: string };
}

interface Plan {
  baseRef: string;
  baseSha: string;
  upstreamRef: string;
  upstreamSha: string;
  upstreamSubject: string;
  behind: number;
  ahead: number;
  clean: boolean;
  conflicts: string[];
  touched: string[];
  sensitive: { sensitive: boolean; paths: string[]; reasons: string[] };
  history: { previousHead: string | null; rewritten: boolean };
  workflowFiles: boolean;
  pins: PinReport;
  requiresPr: boolean;
}

interface PinState {
  bridge: string;
  wrapper: string;
  coreFile: string;
  mcpSites: { file: string; server: string; version: string }[];
  pluginVersions: { plugin: string; version: string; file: string }[];
}

interface ConstantsModule {
  SYNC_BRANCH: string;
  CONFLICT_ISSUE_TITLE: string;
  REVIEW_LABEL: string;
  gateCommands(options?: { plugins?: string[] }): { label: string; command: string; args: string[] }[];
  spawnableCommand(command: string, platform?: string): string;
}

interface GitModule {
  isAncestor(input: { ancestor: string; descendant: string; cwd: string }): boolean;
}

interface MergeModule {
  branchArguments(branch: string): string[];
  mergeArguments(upstreamRef: string): string[];
  parseMergeTreeOutput(result: { status: number; stdout: string; stderr: string }): {
    clean: boolean;
    tree: string;
    conflicts: string[];
    message: string;
  };
  isSensitivePath(filePath: string): boolean;
  packageJsonRisk(baseText: string | null, mergedText: string | null): string[];
  assessSensitivity(input: {
    touched: string[];
    basePackageJson: string | null;
    mergedPackageJson: string | null;
  }): { sensitive: boolean; paths: string[]; reasons: string[] };
  historyStatus(input: { previousHead: string | null; upstreamHead: string; cwd: string }): {
    previousHead: string | null;
    rewritten: boolean;
  };
  extractSyncHead(message: string): string | null;
  touchesWorkflowFiles(touched: string[]): boolean;
}

interface CompatibilityModule {
  parseCompatibilityDocument(document: unknown): Compatibility;
  wrapperDecision(input: { currentWrapper: string; bridge: string; table: Compatibility }): {
    decision: 'bump' | 'hold';
    reason: string;
    bridge: string;
    target: string;
    allowed: string[];
    currentAllowed: boolean;
  };
}

interface DecideModule {
  decideBridgePin(input: { current: string; latest: string }): {
    decision: 'bump' | 'hold' | 'none';
    target: string;
    latest: string;
    reason: string;
  };
  patchBump(version: string): string;
  lockstepVersion(pluginVersions: { plugin: string; version: string }[]): string;
  decideSync(input: {
    currentPins: { bridge: string; wrapper: string; pluginVersions: { plugin: string; version: string }[] };
    latestBridge: string;
    compatibility: Compatibility;
    now?: () => Date;
  }): PinReport;
}

interface PinsModule {
  listPlugins(root: string): string[];
  readPinState(root: string): PinState;
  readCompatibility(root: string): Compatibility;
  rewriteReadmeMentions(
    text: string,
    changes: {
      bridgeFrom: string;
      bridgeTo: string;
      wrapperFrom: string;
      wrapperTo: string;
      versionFrom: string;
      versionTo: string;
    },
  ): { text: string; count: number };
  writePinState(
    root: string,
    changes: {
      bridgeFrom: string;
      bridgeTo: string;
      wrapperFrom: string;
      wrapperTo: string;
      versionFrom: string;
      versionTo: string;
    },
  ): { changed: string[]; readmes: string[]; sync: { written: string[]; removed: string[] } };
  checkPinState(root: string): { ok: boolean; errors: string[]; state: PinState | null };
}

interface RegistryModule {
  parseNpmViewVersion(stdout: string): string;
  npmInvocation(platform: string, execPath?: string): { command: string; prefix: string[]; shell: boolean };
  npmViewDistTagLatest(options: {
    packageName: string;
    cwd?: string;
    retries?: number;
    spawn?: typeof spawnSync;
    platform?: string;
  }): string;
}

interface GateModule {
  runGate(options: {
    root: string;
    spawn?: typeof spawnSync;
    platform?: string;
    write?: (line: string) => void;
  }): { ok: boolean; failed: string | null; commands: { label: string; command: string; args: string[] }[] };
}

interface BodiesModule {
  renderPrBody(input: {
    plan: Plan;
    gate?: 'passed' | 'not-run';
    sensitive?: boolean;
    mergeRequested?: boolean;
    commitSha?: string | null;
    date?: Date;
  }): string;
  renderIssueBody(input: {
    plan: Plan;
    reason?: 'conflict' | 'history' | 'workflow';
    conflicts?: string[] | null;
    date?: Date;
  }): string;
}

interface PlanModule {
  buildPlan(input: {
    root: string;
    baseRef?: string;
    upstreamRef?: string;
    previousRef?: string | null;
    pins: PinState;
    compatibility: Compatibility;
    latestBridge: string;
    now?: () => Date;
  }): Plan;
}

const constants = (await import(
  new URL('../../scripts/upstream-sync/constants.mjs', import.meta.url).href
)) as unknown as ConstantsModule;
const git = (await import(
  new URL('../../scripts/upstream-sync/git.mjs', import.meta.url).href
)) as unknown as GitModule;
const merge = (await import(
  new URL('../../scripts/upstream-sync/merge.mjs', import.meta.url).href
)) as unknown as MergeModule;
const compatibility = (await import(
  new URL('../../scripts/upstream-sync/compatibility.mjs', import.meta.url).href
)) as unknown as CompatibilityModule;
const decide = (await import(
  new URL('../../scripts/upstream-sync/decide.mjs', import.meta.url).href
)) as unknown as DecideModule;
const pins = (await import(
  new URL('../../scripts/upstream-sync/pins.mjs', import.meta.url).href
)) as unknown as PinsModule;
const registry = (await import(
  new URL('../../scripts/upstream-sync/registry.mjs', import.meta.url).href
)) as unknown as RegistryModule;
const gate = (await import(
  new URL('../../scripts/upstream-sync/gate.mjs', import.meta.url).href
)) as unknown as GateModule;
const bodies = (await import(
  new URL('../../scripts/upstream-sync/bodies.mjs', import.meta.url).href
)) as unknown as BodiesModule;
const planModule = (await import(
  new URL('../../scripts/upstream-sync/plan.mjs', import.meta.url).href
)) as unknown as PlanModule;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-10-24T12:00:00Z');
const now = (): Date => NOW;
const TABLE: Compatibility = {
  schemaVersion: 1,
  bridge: { '1.15.1': { cloakbrowser: ['0.6.0', '0.6.1', '0.6.2', '0.6.3'] } },
};
const TREE = 'a'.repeat(40);

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(root, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
}

function provisionSource(bridge: string, wrapper: string): string {
  return [
    '#!/usr/bin/env node',
    "export const NPM_ENGINE_WRAPPER_PIN = '" + wrapper + "';",
    "export const NPM_DRIVER_PIN = 'patchright@1.64.1';",
    "export const DEFAULT_NPM_PACKAGE = 'cloakbrowser-mcp@" + bridge + "';",
    '',
  ].join('\n');
}

function createPinFixture({
  bridge = '1.15.1',
  wrapper = '0.6.3',
  mcpBridge = bridge,
  versions = { cloakbrowser: '2.6.0', camoufox: '2.6.0' },
  table = TABLE,
}: {
  bridge?: string;
  wrapper?: string;
  mcpBridge?: string;
  versions?: Record<string, string>;
  table?: Compatibility;
} = {}): string {
  const root = tempRoot('upstream-sync-pins-');
  const files: Record<string, string> = {
    'shared/core/lib/provision.mjs': provisionSource(bridge, wrapper),
    'scripts/upstream-sync/wrapper-compatibility.json': JSON.stringify(table, null, 2),
  };
  for (const [plugin, version] of Object.entries(versions)) {
    files[`plugins/${plugin}/.claude-plugin/plugin.json`] = JSON.stringify(
      { name: plugin, version },
      null,
      2,
    );
    files[`plugins/${plugin}/.mcp.json`] = JSON.stringify(
      { [plugin]: { env: { CLOAK_PLAYWRIGHT_MCP_PACKAGE: `cloakbrowser-mcp@${mcpBridge}` } } },
      null,
      2,
    );
  }
  writeFiles(root, files);
  return root;
}

const gitConfig = [
  '-c',
  'user.name=Upstream Sync Probe',
  '-c',
  'user.email=probe@example.invalid',
  '-c',
  'core.autocrlf=false',
  '-c',
  'commit.gpgsign=false',
];

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', [...gitConfig, ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function createGitFixture(): string {
  const root = tempRoot('upstream-sync-git-');
  runGit(root, ['init', '-q', '-b', 'main']);
  writeFiles(root, {
    'shared/core/lib/provision.mjs': provisionSource('1.15.1', '0.6.3'),
    'scripts/upstream-sync/wrapper-compatibility.json': JSON.stringify(TABLE, null, 2),
    'plugins/cloakbrowser/.claude-plugin/plugin.json': JSON.stringify(
      { name: 'cloakbrowser', version: '2.6.0' },
      null,
      2,
    ),
    'plugins/cloakbrowser/.mcp.json': JSON.stringify(
      { cloakbrowser: { env: { CLOAK_PLAYWRIGHT_MCP_PACKAGE: 'cloakbrowser-mcp@1.15.1' } } },
      null,
      2,
    ),
    'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'true' } }, null, 2),
    'a.txt': 'base\n',
  });
  runGit(root, ['add', '-A']);
  runGit(root, ['commit', '-qm', 'base']);
  runGit(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return root;
}

function planFixture(overrides: Partial<Plan> = {}): Plan {
  return {
    baseRef: 'origin/main',
    baseSha: 'b'.repeat(40),
    upstreamRef: 'upstream/main',
    upstreamSha: 'c'.repeat(40),
    upstreamSubject: 'build(deps): bump the npm-dependencies group',
    behind: 2,
    ahead: 14,
    clean: true,
    conflicts: [],
    touched: ['package.json', 'package-lock.json'],
    sensitive: { sensitive: false, paths: [], reasons: [] },
    history: { previousHead: null, rewritten: false },
    workflowFiles: false,
    pins: {
      changed: false,
      bridge: {
        package: 'cloakbrowser-mcp',
        current: '1.15.1',
        latest: '1.15.1',
        target: '1.15.1',
        decision: 'none',
        reason: 'registry-latest-equals-current',
      },
      wrapper: {
        package: 'cloakbrowser',
        current: '0.6.3',
        target: '0.6.3',
        decision: 'hold',
        reason: 'bridge-allowlist',
        bridge: '1.15.1',
        allowed: ['0.6.0', '0.6.1', '0.6.2', '0.6.3'],
        currentAllowed: true,
      },
      pluginVersion: {
        current: '2.6.0',
        target: '2.6.0',
        decision: 'none',
        reason: 'no-pin-change',
      },
    },
    requiresPr: true,
    ...overrides,
  };
}

describe('merge strategy', () => {
  it('cuts the sync branch from origin/main and merges upstream without committing', () => {
    expect(merge.branchArguments('chore/upstream-sync')).toEqual([
      'checkout',
      '-B',
      'chore/upstream-sync',
      'origin/main',
    ]);
    expect(merge.mergeArguments('upstream/main')).toEqual([
      'merge',
      '--no-ff',
      '--no-commit',
      'upstream/main',
    ]);
    expect(merge.mergeArguments('upstream/main')).not.toContain('--rebase');
    expect(merge.branchArguments('chore/upstream-sync')).not.toContain('main:main');
  });

  it('parses a clean merge-tree result', () => {
    const result = merge.parseMergeTreeOutput({ status: 0, stdout: `${TREE}\n`, stderr: '' });
    expect(result).toEqual({ clean: true, tree: TREE, conflicts: [], message: '' });
  });

  it('parses conflicted paths from a stopped merge-tree', () => {
    const stdout = [
      TREE,
      'a.txt',
      'docs/b.md',
      '',
      'Auto-merging a.txt',
      'CONFLICT (content): Merge conflict in a.txt',
      '',
    ].join('\n');
    const result = merge.parseMergeTreeOutput({ status: 1, stdout, stderr: '' });
    expect(result.clean).toBe(false);
    expect(result.tree).toBe(TREE);
    expect(result.conflicts).toEqual(['a.txt', 'docs/b.md']);
    expect(result.message).toContain('CONFLICT (content)');
  });

  it('rejects unparseable merge-tree output', () => {
    expect(() =>
      merge.parseMergeTreeOutput({ status: 128, stdout: '', stderr: 'fatal: bad revision' }),
    ).toThrow(/no tree id/);
  });

  it('detects upstream history rewrites', () => {
    const root = createGitFixture();
    const base = runGit(root, ['rev-parse', 'HEAD']);
    writeFiles(root, { 'a.txt': 'next\n' });
    runGit(root, ['add', '-A']);
    runGit(root, ['commit', '-qm', 'next']);
    const next = runGit(root, ['rev-parse', 'HEAD']);
    expect(merge.historyStatus({ previousHead: base, upstreamHead: next, cwd: root }).rewritten).toBe(false);
    expect(merge.historyStatus({ previousHead: next, upstreamHead: base, cwd: root }).rewritten).toBe(true);
    expect(merge.historyStatus({ previousHead: null, upstreamHead: base, cwd: root }).rewritten).toBe(false);
    expect(git.isAncestor({ ancestor: base, descendant: next, cwd: root })).toBe(true);
  });

  it('reads the upstream head recorded by the previous sync commit', () => {
    expect(merge.extractSyncHead('chore: sync\n\nUpstream-Sync-Head: ' + 'd'.repeat(40) + '\n\nbody')).toBe(
      'd'.repeat(40),
    );
    expect(merge.extractSyncHead('chore: sync without a trailer')).toBeNull();
  });

  it('recognizes a merge that changes a workflow file', () => {
    expect(merge.touchesWorkflowFiles(['package.json', '.github/workflows/ci.yml'])).toBe(true);
    expect(merge.touchesWorkflowFiles(['.github/CODEOWNERS', 'package.json'])).toBe(false);
    expect(merge.touchesWorkflowFiles([])).toBe(false);
  });
});

describe('sensitive paths and package.json risk', () => {
  it('guards runner-executed paths and the build contract', () => {
    for (const filePath of [
      '.github/workflows/upstream-sync.yml',
      '.github/actions/setup/action.yml',
      'Dockerfile',
      '.github/dependabot.yml',
    ]) {
      expect(merge.isSensitivePath(filePath)).toBe(true);
    }
    for (const filePath of ['src/index.ts', '.github/zizmor.yml', 'docs/Dockerfile.md', 'README.md']) {
      expect(merge.isSensitivePath(filePath)).toBe(false);
    }
  });

  it('flags package.json script, workspace, publishConfig and install-hook changes only', () => {
    const base = JSON.stringify({ scripts: { test: 'true' }, dependencies: { a: '1.0.0' } });
    expect(
      merge.packageJsonRisk(
        base,
        JSON.stringify({ scripts: { test: 'false' }, dependencies: { a: '1.0.0' } }),
      ),
    ).toContain('package.json scripts changed');
    expect(
      merge.packageJsonRisk(
        base,
        JSON.stringify({ scripts: { test: 'true' }, dependencies: { a: '1.0.1' } }),
      ),
    ).toEqual([]);
    expect(
      merge.packageJsonRisk(
        base,
        JSON.stringify({
          scripts: { test: 'true', postinstall: 'node evil.mjs' },
          dependencies: { a: '1.0.0' },
        }),
      ),
    ).toEqual(
      expect.arrayContaining(['package.json scripts changed', 'package.json postinstall hook changed']),
    );
    expect(merge.packageJsonRisk(base, '{ not json')).toEqual([expect.stringContaining('not valid JSON')]);
    expect(merge.packageJsonRisk(base, null)).toEqual(['package.json was deleted']);
  });

  it('marks a merge sensitive when any guarded path changed', () => {
    expect(
      merge.assessSensitivity({
        touched: ['README.md', 'src/a.ts'],
        basePackageJson: null,
        mergedPackageJson: null,
      }),
    ).toEqual({ sensitive: false, paths: [], reasons: [] });
    expect(
      merge.assessSensitivity({
        touched: ['.github/workflows/ci.yml', 'package.json'],
        basePackageJson: JSON.stringify({ scripts: { test: 'true' } }),
        mergedPackageJson: JSON.stringify({ scripts: { test: 'false' } }),
      }),
    ).toEqual({
      sensitive: true,
      paths: ['.github/workflows/ci.yml'],
      reasons: ['package.json scripts changed'],
    });
  });
});

describe('wrapper compatibility table', () => {
  it('validates the document shape', () => {
    expect(compatibility.parseCompatibilityDocument(TABLE)).toEqual(TABLE);
    expect(() => compatibility.parseCompatibilityDocument({ schemaVersion: 2, bridge: {} })).toThrow(
      /schemaVersion/,
    );
    expect(() =>
      compatibility.parseCompatibilityDocument({
        schemaVersion: 1,
        bridge: { '1.0.0': { cloakbrowser: [] } },
      }),
    ).toThrow(/must list/);
    expect(() =>
      compatibility.parseCompatibilityDocument({
        schemaVersion: 1,
        bridge: { '1.0.0': { cloakbrowser: ['nope'] } },
      }),
    ).toThrow(/Unsupported semver/);
  });

  it('holds at the current wrapper when the bridge allowlist ends there', () => {
    const result = compatibility.wrapperDecision({ currentWrapper: '0.6.3', bridge: '1.15.1', table: TABLE });
    expect(result).toMatchObject({
      decision: 'hold',
      reason: 'bridge-allowlist',
      target: '0.6.3',
      currentAllowed: true,
    });
  });

  it('bumps to the highest allowed wrapper', () => {
    const table: Compatibility = {
      schemaVersion: 1,
      bridge: { '1.15.1': { cloakbrowser: ['0.6.1', '0.6.3', '0.6.4', '0.7.0-beta.1'] } },
    };
    const result = compatibility.wrapperDecision({ currentWrapper: '0.6.3', bridge: '1.15.1', table });
    expect(result.decision).toBe('bump');
    expect(result.target).toBe('0.6.4');
    expect(result.allowed).toEqual(['0.6.1', '0.6.3', '0.6.4']);
  });

  it('holds when the bridge is unknown, the current wrapper is not allowed, or majors differ', () => {
    expect(
      compatibility.wrapperDecision({ currentWrapper: '0.6.3', bridge: '9.9.9', table: TABLE }),
    ).toMatchObject({ decision: 'hold', reason: 'bridge-not-in-compatibility-table', target: '0.6.3' });
    expect(
      compatibility.wrapperDecision({ currentWrapper: '0.5.0', bridge: '1.15.1', table: TABLE }),
    ).toMatchObject({ decision: 'hold', reason: 'current-wrapper-not-allowed', currentAllowed: false });
    const majorTable: Compatibility = {
      schemaVersion: 1,
      bridge: { '1.15.1': { cloakbrowser: ['0.6.3', '1.0.0'] } },
    };
    expect(
      compatibility.wrapperDecision({ currentWrapper: '0.6.3', bridge: '1.15.1', table: majorTable }),
    ).toMatchObject({ decision: 'hold', reason: 'held-major-change', target: '0.6.3' });
  });
});

describe('pin decisions', () => {
  it('bumps the bridge only within the same major and never to a prerelease', () => {
    expect(decide.decideBridgePin({ current: '1.15.1', latest: '1.15.1' })).toMatchObject({
      decision: 'none',
      target: '1.15.1',
    });
    expect(decide.decideBridgePin({ current: '1.15.1', latest: '1.15.2' })).toMatchObject({
      decision: 'bump',
      target: '1.15.2',
    });
    expect(decide.decideBridgePin({ current: '1.15.1', latest: '2.0.0' })).toMatchObject({
      decision: 'hold',
      reason: 'held-major-change',
      target: '1.15.1',
    });
    expect(decide.decideBridgePin({ current: '1.15.1', latest: '1.16.0-beta.1' })).toMatchObject({
      decision: 'hold',
      reason: 'held-prerelease',
    });
    expect(decide.decideBridgePin({ current: '1.15.1', latest: '1.14.0' })).toMatchObject({
      decision: 'hold',
      reason: 'held-registry-behind',
    });
  });

  it('patch-bumps and enforces lockstep plugin versions', () => {
    expect(decide.patchBump('2.6.0')).toBe('2.6.1');
    expect(decide.patchBump('2.6.99')).toBe('2.6.100');
    expect(
      decide.lockstepVersion([
        { plugin: 'cloakbrowser', version: '2.6.0' },
        { plugin: 'camoufox', version: '2.6.0' },
      ]),
    ).toBe('2.6.0');
    expect(() =>
      decide.lockstepVersion([
        { plugin: 'cloakbrowser', version: '2.6.0' },
        { plugin: 'camoufox', version: '2.6.1' },
      ]),
    ).toThrow(/not lockstep/);
  });

  it('keeps the versions when the registry matches the pins', () => {
    const report = decide.decideSync({
      currentPins: {
        bridge: '1.15.1',
        wrapper: '0.6.3',
        pluginVersions: [
          { plugin: 'cloakbrowser', version: '2.6.0' },
          { plugin: 'camoufox', version: '2.6.0' },
        ],
      },
      latestBridge: '1.15.1',
      compatibility: TABLE,
      now,
    });
    expect(report.changed).toBe(false);
    expect(report.bridge.decision).toBe('none');
    expect(report.wrapper.reason).toBe('bridge-allowlist');
    expect(report.pluginVersion).toMatchObject({ decision: 'none', target: '2.6.0' });
  });

  it('bumps both pins and the plugin version when a new bridge widens the allowlist', () => {
    const table: Compatibility = {
      schemaVersion: 1,
      bridge: {
        '1.15.1': { cloakbrowser: ['0.6.0', '0.6.1', '0.6.2', '0.6.3'] },
        '1.15.2': { cloakbrowser: ['0.6.0', '0.6.1', '0.6.2', '0.6.3', '0.6.4'] },
      },
    };
    const report = decide.decideSync({
      currentPins: {
        bridge: '1.15.1',
        wrapper: '0.6.3',
        pluginVersions: [
          { plugin: 'cloakbrowser', version: '2.6.0' },
          { plugin: 'camoufox', version: '2.6.0' },
        ],
      },
      latestBridge: '1.15.2',
      compatibility: table,
      now,
    });
    expect(report.changed).toBe(true);
    expect(report.bridge.target).toBe('1.15.2');
    expect(report.wrapper).toMatchObject({ decision: 'bump', target: '0.6.4', bridge: '1.15.2' });
    expect(report.pluginVersion).toMatchObject({ decision: 'bump', target: '2.6.1' });
  });

  it('bumps the bridge but holds the wrapper when the new bridge is unlisted', () => {
    const report = decide.decideSync({
      currentPins: {
        bridge: '1.15.1',
        wrapper: '0.6.3',
        pluginVersions: [{ plugin: 'cloakbrowser', version: '2.6.0' }],
      },
      latestBridge: '1.15.2',
      compatibility: TABLE,
      now,
    });
    expect(report.changed).toBe(true);
    expect(report.wrapper).toMatchObject({
      decision: 'hold',
      reason: 'bridge-not-in-compatibility-table',
      target: '0.6.3',
      bridge: '1.15.2',
    });
    expect(report.pluginVersion.target).toBe('2.6.1');
  });
});

describe('pin discovery and the fail-closed guard', () => {
  it('reads the canonical pin and every MCP site', () => {
    const root = createPinFixture();
    const state = pins.readPinState(root);
    expect(state.bridge).toBe('1.15.1');
    expect(state.wrapper).toBe('0.6.3');
    expect(state.mcpSites.map((site) => site.file)).toEqual([
      'plugins/camoufox/.mcp.json',
      'plugins/cloakbrowser/.mcp.json',
    ]);
    expect(state.pluginVersions.map((entry) => entry.version)).toEqual(['2.6.0', '2.6.0']);
  });

  it('accepts consistent pins and rejects every drift the guard exists for', () => {
    expect(pins.checkPinState(createPinFixture()).ok).toBe(true);
    const mismatch = pins.checkPinState(createPinFixture({ mcpBridge: '1.15.0' }));
    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors.join('\n')).toMatch(/pins cloakbrowser-mcp@1\.15\.0/);
    const unlisted = pins.checkPinState(createPinFixture({ bridge: '1.15.2' }));
    expect(unlisted.ok).toBe(false);
    expect(unlisted.errors.join('\n')).toMatch(/not in .*wrapper-compatibility\.json/);
    const badWrapper = pins.checkPinState(createPinFixture({ wrapper: '0.6.4' }));
    expect(badWrapper.ok).toBe(false);
    expect(badWrapper.errors.join('\n')).toMatch(/wrapper 0\.6\.4 is not allowed/);
    const mixed = pins.checkPinState(createPinFixture({ versions: { a: '2.6.0', b: '2.6.1' } }));
    expect(mixed.ok).toBe(false);
    expect(mixed.errors.join('\n')).toMatch(/not lockstep/);
  });

  it('rewrites the exact README tokens and nothing else', () => {
    const text =
      'pins `cloakbrowser-mcp@1.15.1`, `cloakbrowser@0.6.3`, engine wrapper to `0.6.3`, bridge (1.15.1), version 2.6.0, and rejects 0.6.4.';
    const result = pins.rewriteReadmeMentions(text, {
      bridgeFrom: '1.15.1',
      bridgeTo: '1.15.2',
      wrapperFrom: '0.6.3',
      wrapperTo: '0.6.4',
      versionFrom: '2.6.0',
      versionTo: '2.6.1',
    });
    expect(result.count).toBe(5);
    expect(result.text).toContain('cloakbrowser-mcp@1.15.2');
    expect(result.text).toContain('cloakbrowser@0.6.4');
    expect(result.text).toContain('wrapper to `0.6.4`');
    expect(result.text).toContain('bridge (1.15.2)');
    expect(result.text).toContain('version 2.6.1');
    expect(result.text).toContain('rejects 0.6.4');
  });

  it('writes the pin, the plugin versions, the READMEs and the generated copies', () => {
    const root = tempRoot('upstream-sync-write-');
    cpSync(path.join(repoRoot, 'shared'), path.join(root, 'shared'), { recursive: true });
    cpSync(path.join(repoRoot, 'plugins'), path.join(root, 'plugins'), { recursive: true });
    writeFiles(root, {
      'scripts/upstream-sync/wrapper-compatibility.json': JSON.stringify(
        {
          schemaVersion: 1,
          bridge: { '1.15.2': { cloakbrowser: ['0.6.0', '0.6.1', '0.6.2', '0.6.3', '0.6.4'] } },
        },
        null,
        2,
      ),
    });
    const written = pins.writePinState(root, {
      bridgeFrom: '1.15.1',
      bridgeTo: '1.15.2',
      wrapperFrom: '0.6.3',
      wrapperTo: '0.6.4',
      versionFrom: '2.20.0',
      versionTo: '2.20.1',
    });
    expect(written.changed).toContain('shared/core/lib/provision.mjs');
    expect(written.changed).toContain('plugins/cloakbrowser/.mcp.json');
    expect(written.readmes).toContain('plugins/cloakbrowser/README.md');
    const state = pins.readPinState(root);
    expect(state.bridge).toBe('1.15.2');
    expect(state.wrapper).toBe('0.6.4');
    expect(state.pluginVersions.map((entry) => entry.version)).toEqual(['2.20.1', '2.20.1']);
    expect(readFileSync(path.join(root, 'plugins/cloakbrowser/lib/provision.mjs'), 'utf8')).toContain(
      'cloakbrowser-mcp@1.15.2',
    );
    expect(readFileSync(path.join(root, 'plugins/cloakbrowser/README.md'), 'utf8')).toContain(
      'cloakbrowser-mcp@1.15.2',
    );
    expect(readFileSync(path.join(root, 'plugins/cloakbrowser/README.md'), 'utf8')).toContain('2.20.1');
    expect(pins.checkPinState(root).ok).toBe(true);
  });
});

describe('registry reads', () => {
  it('parses both JSON and raw npm view output', () => {
    expect(registry.parseNpmViewVersion('"1.15.1"\n')).toBe('1.15.1');
    expect(registry.parseNpmViewVersion('1.15.1\n')).toBe('1.15.1');
    expect(() => registry.parseNpmViewVersion('')).toThrow(/no version/);
  });

  it('retries a failing npm view and never accepts an invalid package name', () => {
    const calls: { command: string; args: string[] }[] = [];
    const spawn = ((command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0, stdout: '"1.15.2"', stderr: '', error: undefined };
    }) as unknown as typeof spawnSync;
    expect(
      registry.npmViewDistTagLatest({
        packageName: 'cloakbrowser-mcp',
        retries: 1,
        spawn,
        platform: 'linux',
      }),
    ).toBe('1.15.2');
    expect(calls[0]).toEqual({
      command: 'npm',
      args: ['view', 'cloakbrowser-mcp', 'dist-tags.latest', '--json'],
    });
    let attempts = 0;
    const failing = (() => {
      attempts += 1;
      return { status: 1, stdout: '', stderr: 'EAI_AGAIN', error: undefined };
    }) as unknown as typeof spawnSync;
    expect(() =>
      registry.npmViewDistTagLatest({
        packageName: 'cloakbrowser-mcp',
        retries: 3,
        spawn: failing,
        platform: 'linux',
      }),
    ).toThrow(/after 3 attempts/);
    expect(attempts).toBe(3);
    expect(() => registry.npmViewDistTagLatest({ packageName: '../evil', spawn, platform: 'linux' })).toThrow(
      /invalid npm package name/,
    );
  });

  it('runs npm shell-free where it can and only falls back to a shell on Windows', () => {
    expect(registry.npmInvocation('linux', '/usr/bin/node')).toEqual({
      command: 'npm',
      prefix: [],
      shell: false,
    });
    const fallback = registry.npmInvocation('win32', 'C:\\nowhere\\node.exe');
    expect(fallback.command).toBe('npm.cmd');
    expect(fallback.shell).toBe(true);
    const fakeNode = path.join(tempRoot('upstream-sync-npm-'), 'node.exe');
    writeFiles(path.dirname(fakeNode), { 'node_modules/npm/bin/npm-cli.js': '// npm cli\n' });
    const native = registry.npmInvocation('win32', fakeNode);
    expect(native).toEqual({
      command: fakeNode,
      prefix: [path.join(path.dirname(fakeNode), 'node_modules', 'npm', 'bin', 'npm-cli.js')],
      shell: false,
    });
  });
});

describe('gate command list', () => {
  it('runs the gate in the specified order', () => {
    const commands = constants.gateCommands({ plugins: ['camoufox', 'cloakbrowser'] });
    expect(commands[0]).toEqual({
      label: 'install dependencies',
      command: 'npm',
      args: ['ci', '--ignore-scripts'],
    });
    expect(commands[1]).toMatchObject({ command: 'npm', args: ['run', 'build'] });
    expect(commands[2]).toEqual({
      label: 'plugin core check',
      command: 'node',
      args: ['scripts/sync-plugin-core.mjs', '--check'],
    });
    expect(commands[3]).toEqual({
      label: 'pin guard',
      command: 'node',
      args: ['scripts/upstream-sync/run.mjs', 'pins', '--check'],
    });
    expect(commands[4]).toMatchObject({ command: 'npm', args: ['run', 'check:static'] });
    expect(commands[5]).toMatchObject({ command: 'npm', args: ['test'] });
    expect(commands[6]).toEqual({
      label: 'audit dependencies',
      command: 'npm',
      args: ['audit', '--audit-level=high'],
    });
    expect(commands[7]).toMatchObject({ command: 'claude', args: ['plugin', 'validate', '.'] });
    expect(commands.slice(8).map((step) => step.args.at(-1))).toEqual([
      './plugins/camoufox',
      './plugins/cloakbrowser',
    ]);
  });

  it('uses .cmd shims on Windows only', () => {
    expect(constants.spawnableCommand('npm', 'win32')).toBe('npm.cmd');
    expect(constants.spawnableCommand('claude', 'win32')).toBe('claude.cmd');
    expect(constants.spawnableCommand('node', 'win32')).toBe('node');
    expect(constants.spawnableCommand('npm', 'linux')).toBe('npm');
  });

  it('stops at the first failing command', () => {
    const ran: string[] = [];
    const spawn = ((command: string, args: string[]) => {
      ran.push([command, ...args].join(' '));
      return { status: ran.length === 2 ? 1 : 0, stdout: '', stderr: '', error: undefined };
    }) as unknown as typeof spawnSync;
    const result = gate.runGate({ root: repoRoot, spawn, write: () => undefined });
    expect(result.ok).toBe(false);
    expect(result.failed).toBe('build');
    expect(ran).toHaveLength(2);
  });

  it('lists the shipped plugins from the repository', () => {
    expect(pins.listPlugins(repoRoot)).toEqual(['camoufox', 'cloakbrowser']);
  });
});

describe('bodies', () => {
  it('renders a PR body that states the gate, the pins and the merge policy', () => {
    const body = bodies.renderPrBody({
      plan: planFixture(),
      gate: 'passed',
      commitSha: 'e'.repeat(40),
      date: NOW,
    });
    expect(body).toContain('## Weekly upstream sync');
    expect(body).toContain(`\`${'c'.repeat(40)}\``);
    expect(body).toContain('build(deps): bump the npm-dependencies group');
    expect(body).toContain('The in-workflow gate passed on this branch');
    expect(body).toContain('This is **not a CI result**');
    expect(body).toContain('| `cloakbrowser-mcp` | `1.15.1` | `1.15.1` | none |');
    expect(body).toContain('No pin changed; the plugin version stays as it is.');
    expect(body).toContain('left open by default');
    expect(body).toContain('by FiredMosquito831');
    expect(body).not.toContain('CI is green');
  });

  it('flags a sensitive merge and a missing gate', () => {
    const plan = planFixture({
      sensitive: {
        sensitive: true,
        paths: ['.github/workflows/ci.yml'],
        reasons: ['package.json scripts changed'],
      },
    });
    const body = bodies.renderPrBody({ plan, gate: 'not-run', date: NOW });
    expect(body).toContain('never merged automatically');
    expect(body).toContain('`.github/workflows/ci.yml`');
    expect(body).toContain('package.json scripts changed');
    expect(body).toContain('has not run yet');
  });

  it('renders a conflict issue with the resolution block', () => {
    const body = bodies.renderIssueBody({
      plan: planFixture({ clean: false, conflicts: ['package.json', 'README.md'] }),
      date: NOW,
    });
    expect(body).toContain('Upstream sync conflict (swimmwatch/main)');
    expect(body).toContain('- `package.json`');
    expect(body).toContain('- `README.md`');
    expect(body).toContain(`git merge --no-ff ${'c'.repeat(40)}`);
    expect(body).toContain('`main` was not touched and no branch was pushed.');
    expect(body).toContain('by FiredMosquito831');
  });

  it('renders a rewritten-history issue with the ancestry check', () => {
    const body = bodies.renderIssueBody({
      plan: planFixture({ history: { previousHead: 'f'.repeat(40), rewritten: true } }),
      reason: 'history',
      date: NOW,
    });
    expect(body).toContain('Upstream rewrote history');
    expect(body).toContain('git merge-base --is-ancestor ' + 'f'.repeat(40));
    expect(body).toContain('by FiredMosquito831');
  });

  it('renders a workflow-file block with the manual push instructions', () => {
    const body = bodies.renderIssueBody({
      plan: planFixture({
        touched: ['.github/workflows/ci.yml', 'package.json'],
        sensitive: { sensitive: true, paths: ['.github/workflows/ci.yml'], reasons: [] },
        workflowFiles: true,
      }),
      conflicts: [],
      reason: 'workflow',
      date: NOW,
    });
    expect(body).toContain('GITHUB_TOKEN` cannot push workflow files');
    expect(body).toContain('`.github/workflows/ci.yml`');
    expect(body).toContain('git push --force-with-lease origin HEAD:refs/heads/chore/upstream-sync');
    expect(body).not.toContain('no conflicting path');
    expect(body).toContain('by FiredMosquito831');
  });
});

describe('plan building', () => {
  it('computes a clean merge and the touched paths', () => {
    const root = createGitFixture();
    runGit(root, ['checkout', '-qb', 'upstream']);
    writeFiles(root, { 'a.txt': 'upstream\n', 'new.txt': 'new\n' });
    runGit(root, ['add', '-A']);
    runGit(root, ['commit', '-qm', 'upstream change']);
    runGit(root, ['update-ref', 'refs/remotes/upstream/main', 'HEAD']);
    const plan = planModule.buildPlan({
      root,
      baseRef: 'refs/remotes/origin/main',
      upstreamRef: 'refs/remotes/upstream/main',
      pins: pins.readPinState(root),
      compatibility: TABLE,
      latestBridge: '1.15.1',
      now,
    });
    expect(plan.behind).toBe(1);
    expect(plan.clean).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.touched).toEqual(['a.txt', 'new.txt']);
    expect(plan.requiresPr).toBe(true);
    expect(plan.sensitive.sensitive).toBe(false);
    expect(plan.pins.changed).toBe(false);
  });

  it('reports conflicts without touching a worktree', () => {
    const root = createGitFixture();
    runGit(root, ['checkout', '-qb', 'upstream']);
    writeFiles(root, { 'a.txt': 'upstream\n' });
    runGit(root, ['add', '-A']);
    runGit(root, ['commit', '-qm', 'upstream change']);
    runGit(root, ['update-ref', 'refs/remotes/upstream/main', 'HEAD']);
    runGit(root, ['checkout', '-q', 'main']);
    writeFiles(root, { 'a.txt': 'fork\n' });
    runGit(root, ['add', '-A']);
    runGit(root, ['commit', '-qm', 'fork change']);
    runGit(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const plan = planModule.buildPlan({
      root,
      baseRef: 'refs/remotes/origin/main',
      upstreamRef: 'refs/remotes/upstream/main',
      pins: pins.readPinState(root),
      compatibility: TABLE,
      latestBridge: '1.15.1',
      now,
    });
    expect(plan.clean).toBe(false);
    expect(plan.conflicts).toEqual(['a.txt']);
    expect(plan.touched).toEqual([]);
    expect(existsSync(path.join(root, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('marks a package.json script change as sensitive', () => {
    const root = createGitFixture();
    runGit(root, ['checkout', '-qb', 'upstream']);
    writeFiles(root, {
      'package.json': JSON.stringify(
        { name: 'fixture', scripts: { test: 'true', postinstall: 'node x.mjs' } },
        null,
        2,
      ),
    });
    runGit(root, ['add', '-A']);
    runGit(root, ['commit', '-qm', 'upstream package change']);
    runGit(root, ['update-ref', 'refs/remotes/upstream/main', 'HEAD']);
    const plan = planModule.buildPlan({
      root,
      baseRef: 'refs/remotes/origin/main',
      upstreamRef: 'refs/remotes/upstream/main',
      pins: pins.readPinState(root),
      compatibility: TABLE,
      latestBridge: '1.15.1',
      now,
    });
    expect(plan.clean).toBe(true);
    expect(plan.touched).toContain('package.json');
    expect(plan.sensitive.sensitive).toBe(true);
    expect(plan.sensitive.reasons).toContain('package.json scripts changed');
    expect(plan.sensitive.reasons).toContain('package.json postinstall hook changed');
  });

  it('flags a workflow-file merge, which GITHUB_TOKEN cannot push', () => {
    const root = createGitFixture();
    runGit(root, ['checkout', '-qb', 'upstream']);
    writeFiles(root, { '.github/workflows/new.yml': 'name: New\non: workflow_dispatch\n' });
    runGit(root, ['add', '-A']);
    runGit(root, ['commit', '-qm', 'upstream workflow change']);
    runGit(root, ['update-ref', 'refs/remotes/upstream/main', 'HEAD']);
    const plan = planModule.buildPlan({
      root,
      baseRef: 'refs/remotes/origin/main',
      upstreamRef: 'refs/remotes/upstream/main',
      pins: pins.readPinState(root),
      compatibility: TABLE,
      latestBridge: '1.15.1',
      now,
    });
    expect(plan.workflowFiles).toBe(true);
    expect(plan.sensitive.sensitive).toBe(true);
    expect(plan.sensitive.paths).toEqual(['.github/workflows/new.yml']);
  });
});
