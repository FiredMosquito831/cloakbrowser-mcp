import { availableParallelism } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerConfiguration } from '#scripts/testing/worker-configuration';

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, availableParallelism: vi.fn() };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(availableParallelism).mockReset();
});

describe('test worker policy', () => {
  it.each([
    [1, 1],
    [2, 2],
    [4, 4],
    [24, 4],
  ])('limits local workers with %i available CPUs to %i processes', (available, expected) => {
    vi.stubEnv('CI', undefined);
    vi.mocked(availableParallelism).mockReturnValue(available);
    const configuration = workerConfiguration();
    const expectedConfiguration = { pool: 'forks', maxWorkers: expected, fileParallelism: true };
    expect(configuration).toEqual(expectedConfiguration);
    expect(availableParallelism).toHaveBeenCalledOnce();
  });

  it.each(['true', '1'])('uses all available CPUs when CI=%s', (ci) => {
    vi.stubEnv('CI', ci);
    for (const available of [2, 24]) {
      vi.mocked(availableParallelism).mockReturnValue(available);
      const configuration = workerConfiguration();
      expect(configuration.maxWorkers).toBe(available);
    }
  });

  it.each(['false', '0', ''])('keeps the local cap when CI=%s', (ci) => {
    vi.stubEnv('CI', ci);
    vi.mocked(availableParallelism).mockReturnValue(24);
    const configuration = workerConfiguration();
    expect(configuration.maxWorkers).toBe(4);
  });
});
