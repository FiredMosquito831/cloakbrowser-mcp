import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// D6 of the rebrand spec: this fork inherits upstream's release workflow, whose
// npm package, Docker images, docs site and MCP registry entry all carry
// upstream's identity. A tag here must never publish them. Every job that can
// publish (now or after someone adds one) needs the owner guard; `metadata` is
// deliberately allowed to run and only computes version outputs.

interface ParsedJob {
  name: string;
  jobIf: string | null;
}

const GUARD = "github.repository_owner == 'swimmwatch'";
const METADATA_JOB = 'metadata';
const PUBLISHING_JOBS = ['npm', 'docker', 'docs-build', 'docs-deploy', 'mcp-registry'] as const;
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');

function parseJobs(source: string): ParsedJob[] {
  const lines = source.split(/\r?\n/);
  const jobsLine = lines.indexOf('jobs:');
  expect(jobsLine).toBeGreaterThanOrEqual(0);
  const jobs: ParsedJob[] = [];
  let current: ParsedJob | null = null;
  for (const line of lines.slice(jobsLine + 1)) {
    const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch !== null) {
      current = { name: jobMatch[1], jobIf: null };
      jobs.push(current);
      continue;
    }
    const ifMatch = current === null ? null : /^ {4}if:\s*(.+?)\s*$/.exec(line);
    if (ifMatch !== null && current !== null) {
      expect(current.jobIf, `${current.name} has more than one job-level if`).toBeNull();
      current.jobIf = ifMatch[1];
    }
  }
  return jobs;
}

describe('release workflow owner guard', () => {
  const jobs = parseJobs(workflow);

  it('keeps the known job set in order so a newly added job cannot slip through unguarded', () => {
    expect(jobs.map((job) => job.name)).toEqual([METADATA_JOB, ...PUBLISHING_JOBS]);
  });

  it('guards every publishing job at job level and leaves metadata able to run', () => {
    for (const job of jobs) {
      const isMetadata = job.name === METADATA_JOB;
      expect(job.jobIf).toBe(isMetadata ? null : GUARD);
    }
    expect(jobs.filter((job) => job.jobIf === GUARD)).toHaveLength(PUBLISHING_JOBS.length);
  });

  it('explains the guard at the top of the workflow', () => {
    expect(workflow.split(/\r?\n/).slice(0, 3).join('\n')).toContain("fork cannot publish upstream's");
  });
});
