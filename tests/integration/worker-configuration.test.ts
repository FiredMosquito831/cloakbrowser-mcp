import { execFile } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const probe = `
import { availableParallelism } from 'node:os';
import { createVitest, parseCLI } from 'vitest/node';
const config = process.argv[1];
const flags = process.argv.slice(2);
const args = ['vitest', 'run', ...flags];
const parsed = parseCLI(args);
const options = { ...parsed.options, config, watch: false, reporters: [] };
const runner = await createVitest(options);
try {
  await runner.init();
  const effective = {
    pool: runner.config.pool,
    maxWorkers: runner.config.maxWorkers,
    fileParallelism: runner.config.fileParallelism,
    availableWorkers: availableParallelism(),
  };
  process.stdout.write('WORKER_CONFIGURATION=' + JSON.stringify(effective) + '\\n');
} finally {
  await runner.close();
}
`;

interface WorkerProbe {
  pool: string;
  maxWorkers: number;
  fileParallelism: boolean;
  availableWorkers: number;
}

async function configuration(config: string, ci: string, maxWorkers?: number): Promise<WorkerProbe> {
  const flags = maxWorkers === undefined ? [] : [`--maxWorkers=${maxWorkers}`];
  const args = ['--input-type=module', '-e', probe, config, ...flags];
  const options = {
    env: { ...process.env, CI: ci, CLOAK_TEST_REPORT_OPTIONS: '' },
    timeout: 10000,
  };
  const output = await execute(process.execPath, args, options);
  const line = output.stdout.split('\n').find((entry) => entry.startsWith('WORKER_CONFIGURATION='));
  if (!line) throw new Error('Vitest did not expose its effective worker configuration');
  const encoded = line.slice('WORKER_CONFIGURATION='.length);
  return JSON.parse(encoded) as WorkerProbe;
}

describe.each(['vitest.config.ts', 'vitest.e2e.config.ts', 'vitest.distribution-e2e.config.mjs'])(
  'effective worker settings in %s',
  (config) => {
    it('applies the local process cap to the actual Vitest configuration', async () => {
      const effective = await configuration(config, 'false');
      const available = availableParallelism();
      const expected = { pool: 'forks', fileParallelism: true, maxWorkers: Math.min(4, available) };
      expect(effective).toMatchObject(expected);
    });

    it('uses all available CPUs in CI', async () => {
      const effective = await configuration(config, 'true');
      expect(effective.maxWorkers).toBe(effective.availableWorkers);
      expect(effective.pool).toBe('forks');
      expect(effective.fileParallelism).toBe(true);
    });

    it.each([1, 8])('lets the standard CLI flag override the local cap with %i workers', async (workers) => {
      const effective = await configuration(config, 'false', workers);
      expect(effective.maxWorkers).toBe(workers);
    });
  },
);
