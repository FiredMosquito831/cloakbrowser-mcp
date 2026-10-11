import { describe, expect, it } from 'vitest';

interface Identity {
  pr: number;
  run: number;
  attempt: number;
  sha: string;
  path: string;
  fallback: string;
}
interface Publisher {
  reportIdentity: (run: unknown, pr: unknown, source: unknown) => Identity;
  reportDestination: (repository: string, source: string) => string;
  freshPublication: (identity: Identity, pr: unknown, runs: unknown[], comments: unknown[]) => boolean;
  expiredReports: (entries: unknown[], now: number) => string[];
}
const url = new URL('../../scripts/publish-test-report.mjs', import.meta.url);
const publisher = (await import(url.href)) as Publisher;
const sha = 'a'.repeat(40);
const source = { id: 10, full_name: 'swimmwatch/cloakbrowser-mcp' };
const run = {
  id: 20,
  run_attempt: 2,
  head_sha: sha,
  event: 'pull_request',
  status: 'completed',
  repository: source,
  head_repository: { id: 11 },
  workflow_id: 4,
  path: '.github/workflows/ci.yml',
};
const pr = { number: 7, state: 'open', head: { sha, repo: { id: 11 } }, base: { repo: source } };
const identity: Identity = {
  pr: 7,
  run: 20,
  attempt: 2,
  sha,
  path: `pr/7/run/20-attempt-2/${sha}`,
  fallback: 'https://github.com/swimmwatch/cloakbrowser-mcp/actions/runs/20/attempts/2',
};

describe('public report ownership and freshness', () => {
  it('derives immutable identity only from matching API run and PR records', () => {
    expect(publisher.reportIdentity(run, pr, source)).toEqual(identity);
  });
  it.each([
    { ...run, repository: { id: 12, full_name: source.full_name } },
    { ...run, head_sha: '../escape' },
    { ...run, run_attempt: 0 },
    { ...run, event: 'pull_request_target' },
    { ...run, path: '.github/workflows/foreign.yml' },
    { ...run, head_repository: { id: 12 } },
  ])('rejects mismatched or unsafe run identity', (invalid) => {
    expect(() => publisher.reportIdentity(invalid, pr, source)).toThrow();
  });
  it.each(['swimmwatch/cloakbrowser-mcp', 'other/reports', 'swimmwatch/../reports', ''])(
    'rejects a destination outside reports-only ownership: %s',
    (repository) => {
      expect(() => publisher.reportDestination(repository, source.full_name)).toThrow();
    },
  );
  it('allows a separate repository under the same owner', () => {
    expect(publisher.reportDestination('swimmwatch/cloakbrowser-mcp-reports', source.full_name)).toBe(
      'https://swimmwatch.github.io/cloakbrowser-mcp-reports/',
    );
  });
  it('accepts the current completed run and treats duplicates as idempotent', () => {
    const comments: unknown[] = [];
    const runs = [run];
    expect(publisher.freshPublication(identity, pr, runs, comments)).toBe(true);
  });
  it('rejects a changed head, newer pending run and newer rerun attempt', () => {
    const changed = { ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } };
    const newer = { ...run, id: 21, status: 'in_progress' };
    const rerun = { ...run, run_attempt: 3 };
    const none: unknown[] = [];
    expect(publisher.freshPublication(identity, changed, [run], none)).toBe(false);
    expect(publisher.freshPublication(identity, pr, [newer, run], none)).toBe(false);
    expect(publisher.freshPublication(identity, pr, [rerun], none)).toBe(false);
  });
  it('expires only owned immutable paths after fourteen days', () => {
    const now = Date.UTC(2026, 9, 10);
    const expired = { path: identity.path, created: now - 15 * 86400000 };
    const live = { path: `pr/8/run/21-attempt-1/${sha}`, created: now - 86400000 };
    const foreign = { path: 'site/index.html', created: 0 };
    const traversal = { path: `pr/7/run/20-attempt-2/${sha}/../outside`, created: 0 };
    const entries = [expired, live, foreign, traversal];
    expect(publisher.expiredReports(entries, now)).toEqual([identity.path]);
  });
});
