import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

interface Scope {
  repository: string;
  lane: string;
  key: string;
  producers: string[];
  branch: string;
}
interface CiReporter {
  ciPlan: (lane: string, platforms: string[], nodes: string[]) => string[];
  historyScope: (env: Record<string, string | undefined>, producers: string[]) => Scope | undefined;
  selectHistoryRun: (
    runs: Record<string, unknown>[],
    artifacts: Record<string, unknown>[],
    scope: Scope,
  ) => number | undefined;
  ciAggregate: (
    options: Record<string, unknown>,
  ) => Promise<{ status: string; missing: string[]; total: number; failed: number }>;
  saveCiHistory: (options: Record<string, unknown>) => Promise<void>;
}
const url = new URL('../../scripts/test-report.mjs', import.meta.url);
const cli = (await import(url.href)) as CiReporter;
const writerUrl = new URL('../../scripts/lib/test-results.mjs', import.meta.url);
const writer = (await import(writerUrl.href)) as {
  writeTestResult: (options: Record<string, unknown>) => Promise<string>;
};
const roots: string[] = [];
const execute = promisify(execFile);
afterEach(async () => {
  const options = { recursive: true, force: true };
  const cleanup = roots.splice(0).map((root) => rm(root, options));
  await Promise.all(cleanup);
});
const trusted = {
  GITHUB_REPOSITORY: 'swimmwatch/cloakbrowser-mcp',
  GITHUB_EVENT_NAME: 'schedule',
  GITHUB_REF: 'refs/heads/main',
  CLOAK_REPORT_DEFAULT_BRANCH: 'main',
  CLOAK_REPORT_LANE: 'periodic',
};
async function fixture() {
  const prefix = path.join(tmpdir(), 'report-ci-');
  const temporary = await mkdtemp(prefix);
  const root = await realpath(temporary);
  roots.push(root);
  const input = path.join(root, 'download');
  const output = path.join(root, 'report');
  await mkdir(input);
  return { root, input, output };
}
async function producer(input: string, id: string, status: string, environment?: Record<string, string>) {
  const artifact = path.join(input, `test-results-${id}`);
  const result = {
    uuid: randomUUID(),
    file: 'tests/integration/controlled.test.ts',
    name: 'controlled matrix case',
    project: 'default',
    feature: 'reporting',
    level: 'integration',
    status,
    start: 10,
    stop: 20,
    retry: 1,
    environment: environment ?? {
      os: id.startsWith('linux-') ? 'win32' : id,
      arch: 'x64',
      node: '24',
      browser: 'none',
      lane: 'periodic',
    },
    attachments: [{ name: 'Controlled log', type: 'text/plain', data: 'password=synthetic-ci-secret' }],
  };
  const options = { root: artifact, runId: 'run', producerId: id, results: [result] };
  await writer.writeTestResult(options);
  return path.join(artifact, 'run', id);
}
describe('CI reporting trust and matrix aggregation', () => {
  it('keeps independent Node executions separate in actual Allure output', async () => {
    const f = await fixture();
    const expected: string[] = [];
    for (const node of ['22', '24']) {
      const id = `linux-x64-node${node}-none-pr-quality-integration`;
      const environment = { os: 'linux', arch: 'x64', node, browser: 'none', lane: 'pr-quality' };
      await producer(f.input, id, 'passed', environment);
      expected.push(id);
    }
    const options = { ...f, runId: 'run', expected };
    const result = await cli.ciAggregate(options);
    expect(result).toMatchObject({ status: 'passed', total: 2 });
    const summaryFile = path.join(f.output, 'summary.json');
    const summary = JSON.parse(await readFile(summaryFile, 'utf8')) as { stats: { total: number } };
    expect(summary.stats.total).toBe(2);
  });
  it('rejects a CI producer that claims another runner environment', async () => {
    const f = await fixture();
    const id = 'linux-x64-node24-none-pr-quality-integration';
    await producer(f.input, id, 'passed');
    const expected = [id];
    const options = { ...f, runId: 'run', expected };
    await expect(cli.ciAggregate(options)).rejects.toThrow('producer environment');
  });
  it('reports existing unit and integration runs separately without rerunning tests', async () => {
    const f = await fixture();
    const options = {
      root: f.root,
      runId: 'split',
      producerId: 'quality',
      suite: 'unit',
      splitLevels: true,
      secretValues: [],
      lane: 'pr',
      browser: 'none',
    };
    const env = { ...process.env, CLOAK_TEST_REPORT_OPTIONS: JSON.stringify(options) };
    const args = [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.config.ts',
      'tests/unit/humanize-init-page.test.ts',
      'tests/integration/browser-fixture-lifecycle.test.ts',
    ];
    const execution = { env };
    await execute(process.execPath, args, execution);
    const run = path.join(f.root, 'split');
    const producers = await readdir(run);
    expect(producers.sort()).toEqual(['quality-integration', 'quality-unit']);
    for (const level of ['unit', 'integration']) {
      const producer = path.join(run, `quality-${level}`);
      const files = await readdir(producer);
      for (const file of files.filter((file) => file.endsWith('-result.json'))) {
        const target = path.join(producer, file);
        const result = JSON.parse(await readFile(target, 'utf8')) as {
          labels: { name: string; value: string }[];
        };
        expect(result.labels).toContainEqual({ name: 'level', value: level });
        expect(result.labels).toContainEqual({ name: 'lane', value: 'pr' });
      }
    }
  });

  it('reuses only matching validated history and rejects corrupt or untrusted input', async () => {
    const f = await fixture();
    await producer(f.input, 'linux', 'passed');
    const expected = ['linux'];
    const options = { ...f, runId: 'run', expected };
    await cli.ciAggregate(options);
    const history = path.join(f.root, 'history');
    const save = { report: f.output, output: history, env: trusted, expected };
    await cli.saveCiHistory(save);
    const scope = cli.historyScope(trusted, expected);
    const secondOutput = path.join(f.root, 'second-report');
    const second = { ...options, output: secondOutput, history, scope };
    await cli.ciAggregate(second);
    const historyFile = path.join(secondOutput, 'history.jsonl');
    const content = await readFile(historyFile, 'utf8');
    expect(content.trim().split('\n')).toHaveLength(2);
    const untrusted = { ...second, output: path.join(f.root, 'untrusted'), scope: undefined };
    await expect(cli.ciAggregate(untrusted)).rejects.toThrow('untrusted history');
    const contextFile = path.join(history, 'context.json');
    await writeFile(contextFile, '{}');
    const mismatch = { ...second, output: path.join(f.root, 'mismatch') };
    await expect(cli.ciAggregate(mismatch)).rejects.toThrow('wrong history scope');
  });

  it('keeps a failed aggregate nonzero in the real CI command and still writes Job Summary', async () => {
    const f = await fixture();
    const summaryFile = path.join(f.root, 'job-summary.md');
    const platforms: string[] = [];
    const env = {
      ...process.env,
      CLOAK_REPORT_LANE: 'pr',
      CLOAK_REPORT_PLATFORMS: JSON.stringify(platforms),
      NODE_CHECK_VERSIONS: '["24"]',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1',
      CLOAK_REPORT_INPUT: f.input,
      CLOAK_REPORT_OUTPUT: f.output,
      GITHUB_STEP_SUMMARY: summaryFile,
    };
    const args = ['scripts/test-report.mjs', 'ci-aggregate'];
    const options = { env };
    const running = execute(process.execPath, args, options);
    await expect(running).rejects.toMatchObject({ code: 1 });
    const summary = await readFile(summaryFile, 'utf8');
    expect(summary).toContain('Missing producers');
    const html = await readFile(path.join(f.output, 'index.html'), 'utf8');
    expect(html).toContain('<html');
  });

  it('requires every PR suite without duplicate coverage, CLI or release test jobs', async () => {
    const ci = await readFile('.github/workflows/ci.yml', 'utf8');
    const release = await readFile('.github/workflows/release.yml', 'utf8');
    const config = await readFile('vitest.config.ts', 'utf8');
    const jobs = ['npm-audit', 'quality', 'e2e', 'functional', 'docs', 'docker', 'test-report'];
    const start = ci.indexOf('  required-ci:');
    const stop = ci.indexOf('  test-report:', start);
    const required = ci.slice(start, stop);
    const dependencyMatch = /needs:\n((?: {6}- [^\n]+\n)+)/u.exec(required);
    if (!dependencyMatch) throw new Error('Missing required CI dependencies');
    const declared = dependencyMatch[1]
      .trim()
      .split('\n')
      .map((line) => line.trim().slice(2));
    expect(declared).toEqual(jobs);
    const body = /node <<'EOF'\n([\s\S]*?) {10}EOF/u.exec(required)?.[1];
    if (!body) throw new Error('Missing executable required CI gate');
    const args = ['-e', body];
    const entries = jobs.map((job) => [job, { result: 'success' }]);
    const success = Object.fromEntries(entries);
    const passing = { env: { ...process.env, NEEDS_JSON: JSON.stringify(success) } };
    await execute(process.execPath, args, passing);
    for (const job of jobs) {
      for (const status of ['failure', 'cancelled', 'skipped', undefined]) {
        const outcomes = { ...success, [job]: status ? { result: status } : undefined };
        const options = { env: { ...process.env, NEEDS_JSON: JSON.stringify(outcomes) } };
        const execution = execute(process.execPath, args, options);
        const expected = { code: 1 };
        await expect(execution).rejects.toMatchObject(expected);
      }
    }
    expect(ci).toContain('files: ./coverage/lcov.info');
    expect(ci).toContain('token: ${{ secrets.CODECOV_TOKEN }}');
    const thresholds = ['lines: 85', 'functions: 85', 'statements: 85', 'branches: 75'];
    for (const threshold of thresholds) expect(config).toContain(threshold);
    expect(ci).toContain('  functional:');
    expect(ci).toContain('pull_request:');
    expect(ci).toContain('schedule:');
    expect(ci).not.toContain('  coverage:');
    expect(ci).not.toContain('  cdp-e2e:');
    expect(ci).not.toContain('continue-on-error: true');
    const cliRuns = ci.match(/run: npm run test:e2e:run\n/gu) ?? [];
    const packageChecks = ci.match(/run: npm run package:verify\n/gu) ?? [];
    expect(cliRuns).toHaveLength(1);
    expect(packageChecks).toHaveLength(1);
    expect(ci).toContain('if: always()');
    expect(ci).toContain('name: Run managed CDP with both browser engines');
    expect(ci).toContain('CLOAKBROWSER_MCP_CDP_EXPECTED_ARCHITECTURE: ${{ matrix.native-architecture }}');
    expect(release).not.toMatch(/test:e2e|npm test|audit:prod|audit signatures|package:verify|cdp-runtime/u);
    expect(release).toContain('npm run package:pack');
    expect(release).toContain('npm run docs:build:site');
    const platformValue = /^ {2}CLOAK_REPORT_PLATFORMS: '([^']+)'$/mu.exec(ci)?.[1];
    if (!platformValue) throw new Error('Missing native CI platforms');
    const platforms = JSON.parse(platformValue) as string[];
    const nodes = ['22', '24', '25', '26'];
    for (const lane of ['pr', 'periodic']) {
      const inventory = cli.ciPlan(lane, platforms, nodes);
      expect(inventory).toHaveLength(97);
      const unique = new Set(inventory);
      expect(unique.size).toBe(inventory.length);
    }
  });
  it('merges distinct producers, keeps attachments and reports a failing environment', async () => {
    const f = await fixture();
    await producer(f.input, 'linux', 'passed');
    await producer(f.input, 'windows', 'failed');
    const expected = ['linux', 'windows'];
    const options = { ...f, runId: 'run', expected };
    const result = await cli.ciAggregate(options);
    expect(result).toMatchObject({ status: 'failed', total: 2, failed: 1, missing: [] });
    const summaryPath = path.join(f.output, 'summary.json');
    const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as {
      stats: { total: number; failed: number };
    };
    expect(summary.stats).toMatchObject({ total: 2, failed: 1 });
    const resultsDir = path.join(f.output, 'results');
    const files = await readdir(resultsDir);
    const logs = files.filter((file) => file.endsWith('-attachment.txt'));
    expect(logs).toHaveLength(2);
    for (const file of logs) {
      const target = path.join(resultsDir, file);
      const text = await readFile(target, 'utf8');
      expect(text).not.toContain('synthetic-ci-secret');
    }
    const summaryText = await readFile(path.join(f.output, 'ci-summary.md'), 'utf8');
    expect(summaryText).toContain('failed');
    expect(summaryText).not.toContain('synthetic-ci-secret');
  });
  it('creates explicit broken evidence for missing producers, including an entirely empty run', async () => {
    for (const present of [true, false]) {
      const f = await fixture();
      if (present) await producer(f.input, 'linux', 'passed');
      const expected = ['linux', 'windows'];
      const options = { ...f, runId: 'run', expected };
      const result = await cli.ciAggregate(options);
      expect(result.status).toBe('failed');
      expect(result.missing).toContain('windows');
      expect(result.total).toBe(2);
      const text = await readFile(path.join(f.output, 'ci-summary.md'), 'utf8');
      expect(text).toContain('windows');
    }
  });
  it('rejects unexpected or corrupt producer metadata before generation', async () => {
    const f = await fixture();
    const directory = await producer(f.input, 'linux', 'passed');
    const expected = ['windows'];
    const options = { ...f, runId: 'run', expected };
    await expect(cli.ciAggregate(options)).rejects.toThrow('unexpected producer');
    const manifestPath = path.join(directory, 'producer.json');
    await writeFile(manifestPath, '{"complete":true}');
    const invalid = { ...options, expected: ['linux'] };
    await expect(cli.ciAggregate(invalid)).rejects.toThrow();
  });
  it('rejects symlinked artifact directories and traversal identifiers', async () => {
    const f = await fixture();
    const outside = path.join(f.root, 'outside');
    await mkdir(outside);
    const link = path.join(f.input, 'test-results-linux');
    await symlink(outside, link, 'junction');
    const options = { ...f, runId: 'run', expected: ['linux'] };
    await expect(cli.ciAggregate(options)).rejects.toThrow();
    const traversal = { ...options, expected: ['../linux'] };
    await expect(cli.ciAggregate(traversal)).rejects.toThrow();
  });
  it.each(['pull_request', 'pull_request_target', 'push'])('excludes %s from trusted history', (event) => {
    const env = { ...trusted, GITHUB_EVENT_NAME: event };
    const producers = ['linux'];
    const scope = cli.historyScope(env, producers);
    expect(scope).toBeUndefined();
  });
  it('excludes non-default refs and binds history to repository, lane and environment inventory', () => {
    const producers = ['linux'];
    const branch = { ...trusted, GITHUB_REF: 'refs/heads/release/v1.15.0' };
    expect(cli.historyScope(branch, producers)).toBeUndefined();
    const scope = cli.historyScope(trusted, producers);
    expect(scope).toBeDefined();
    const other = { ...trusted, CLOAK_REPORT_LANE: 'another' };
    expect(cli.historyScope(other, producers)?.key).not.toBe(scope?.key);
    const environments = ['windows'];
    expect(cli.historyScope(trusted, environments)?.key).not.toBe(scope?.key);
  });
  it('selects only a completed successful trusted history run with an unexpired matching artifact', () => {
    const producers = ['linux'];
    const scope = cli.historyScope(trusted, producers);
    if (!scope) throw new Error('Missing test history scope');
    const run = {
      id: 42,
      status: 'completed',
      conclusion: 'success',
      event: 'schedule',
      head_branch: 'main',
      head_repository: { full_name: trusted.GITHUB_REPOSITORY },
    };
    const artifact = { name: `test-history-${scope.key}`, expired: false, workflow_run: { id: 42 } };
    expect(cli.selectHistoryRun([run], [artifact], scope)).toBe(42);
    for (const change of [
      { event: 'pull_request' },
      { head_branch: 'feature' },
      { conclusion: 'failure' },
      { head_repository: { full_name: 'fork/cloakbrowser-mcp' } },
    ]) {
      const invalid = { ...run, ...change };
      expect(cli.selectHistoryRun([invalid], [artifact], scope)).toBeUndefined();
    }
    const expired = { ...artifact, expired: true };
    expect(cli.selectHistoryRun([run], [expired], scope)).toBeUndefined();
  });
  it('refuses to save history without trust or from a failed report', async () => {
    const f = await fixture();
    await producer(f.input, 'linux', 'failed');
    const expected = ['linux'];
    const options = { ...f, runId: 'run', expected };
    await cli.ciAggregate(options);
    const output = path.join(f.root, 'history');
    const save = { report: f.output, output, env: trusted, expected };
    await expect(cli.saveCiHistory(save)).rejects.toThrow();
    const env = { ...trusted, GITHUB_EVENT_NAME: 'pull_request' };
    const untrusted = { ...save, env };
    await expect(cli.saveCiHistory(untrusted)).rejects.toThrow('untrusted');
  });
  it('includes every functional suite and CDP engine in the required native inventory', () => {
    const platforms = [
      'ubuntu-latest',
      'ubuntu-24.04-arm',
      'macos-latest',
      'macos-15-intel',
      'windows-latest',
    ];
    const nodes = ['22', '24', '25', '26'];
    const periodic = cli.ciPlan('periodic', platforms, nodes);
    const pr = cli.ciPlan('pr', platforms, nodes);
    expect(new Set(pr).size).toBe(pr.length);
    for (const environment of ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win32-x64']) {
      expect(periodic.some((id) => id.startsWith(environment) && id.includes('npm'))).toBe(true);
      expect(pr.some((id) => id.startsWith(environment) && id.includes('quality-unit'))).toBe(true);
      expect(pr).toContain(`${environment}-node26-mixed-pr-cdp`);
    }
    for (const environment of ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win32-x64']) {
      for (const suite of ['npm', 'proxy-geoip', 'extensions', 'lifecycle']) {
        const expected = `${environment}-node24-cloak-pr-${suite}`;
        expect(pr).toContain(expected);
      }
    }
    expect(pr).not.toContain('linux-x64-node24-none-pr-coverage-unit');
    expect(pr).not.toContain('linux-x64-node26-none-pr-cli');
  });
});
