import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

// Keep this count-boundary test independent of filesystem sync latency.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      handle.sync = async () => undefined;
      return handle;
    },
  };
});

interface Reporting {
  mergeReport: (options: Record<string, unknown>) => Promise<string>;
}
interface Evidence {
  writeTestResult: (options: Record<string, unknown>) => Promise<string>;
  mergeTestResults: (options: Record<string, unknown>) => Promise<string>;
}
const reportingModule = import.meta.resolve('#scripts/test-report');
const evidenceModule = import.meta.resolve('#scripts/lib/test-results');
const { mergeReport } = (await import(reportingModule)) as Reporting;
const { writeTestResult, mergeTestResults } = (await import(evidenceModule)) as Evidence;

it('keeps 10001 merged results readable without enlarging individual producer limits', async () => {
  const temporary = tmpdir();
  const prefix = path.join(temporary, 'report-large-merge-');
  const directory = await mkdtemp(prefix);
  const root = await realpath(directory);
  try {
    const runId = 'original';
    const ids = ['first', 'second'];
    const counts = [6000, 4001];
    let failedFile = '';
    for (const [index, producerId] of ids.entries()) {
      const count = counts[index];
      const allocation = { length: count };
      const results = Array.from(allocation, (_, caseIndex) => {
        const uuid = randomUUID();
        const failed = index === 1 && caseIndex === count - 1;
        if (failed) failedFile = `${uuid}-result.json`;
        return {
          uuid,
          file: 'tests/unit/controlled.test.ts',
          name: `${producerId} case ${caseIndex}`,
          project: 'unit',
          feature: 'reporting',
          level: 'unit',
          status: failed ? 'failed' : 'passed',
          start: 10,
          stop: 20,
          retry: 0,
          environment: { os: 'linux', arch: 'x64', node: '24', browser: 'none', lane: 'pr' },
          attachments:
            caseIndex === 0 ? [{ name: 'log', type: 'text/plain', data: `Controlled ${producerId}` }] : [],
        };
      });
      const options = { root, runId, producerId, results };
      await writeTestResult(options);
    }
    const input = path.join(root, runId);
    const output = path.join(root, 'merged-run');
    const expected = ids.join(',');
    const merge = { input, output, expected };
    await mergeReport(merge);
    const directories = await readdir(output);
    const sorted = directories.sort();
    expect(sorted).toEqual(ids);
    for (const [index, id] of ids.entries()) {
      const filename = path.join(output, id, 'producer.json');
      const bytes = await readFile(filename, 'utf8');
      const manifest = JSON.parse(bytes) as { count: number; runId: string; producerId: string };
      const expectedManifest = { count: counts[index], runId: 'merged-run', producerId: id };
      expect(manifest).toMatchObject(expectedManifest);
    }
    // Use the same strict reader as generateReport, including its per-manifest limit.
    const outputDir = path.join(root, 'readback');
    const reading = { root, runId: 'merged-run', producerIds: ids, outputDir };
    await mergeTestResults(reading);
    const files = await readdir(outputDir);
    const resultFiles = files.filter((filename) => filename.endsWith('-result.json'));
    const attachments = files.filter((filename) => filename.endsWith('-attachment.txt'));
    expect(resultFiles).toHaveLength(10001);
    expect(attachments).toHaveLength(2);
    const failedPath = path.join(outputDir, failedFile);
    const failedBytes = await readFile(failedPath, 'utf8');
    const failure = JSON.parse(failedBytes) as { status: string };
    expect(failure.status).toBe('failed');
    const repeated = mergeReport(merge);
    await expect(repeated).rejects.toThrow('already exists');
    const manifestPath = path.join(output, 'first', 'producer.json');
    const manifestBytes = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestBytes) as { count: number; results: string[] };
    manifest.results = resultFiles;
    manifest.count = resultFiles.length;
    const oversized = JSON.stringify(manifest);
    await writeFile(manifestPath, oversized);
    const rejectedOutput = path.join(root, 'oversized-run');
    const invalid = { input: output, output: rejectedOutput, expected };
    const rejection = mergeReport(invalid);
    await expect(rejection).rejects.toThrow('incomplete producer');
    const rootEntries = await readdir(root);
    expect(rootEntries).not.toContain('oversized-run');
  } finally {
    const cleanup = { recursive: true, force: true };
    await rm(root, cleanup);
  }
}, 60000);
