import { afterEach, describe, expect, it, vi } from 'vitest';
const { register, metadata } = vi.hoisted(() => ({ register: vi.fn(), metadata: vi.fn() }));
vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
  register,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: metadata,
}));
afterEach(() => {
  vi.resetModules();
  register.mockReset();
  metadata.mockReset();
});
describe('humanize compatibility registration', () => {
  const values: readonly string[] = ['0.5.11', '0.6.1'];
  it.each(values)('rejects unverified dependency version %s', async (version) => {
    const stringifyOptions = { version } as const;
    const serializedValue = JSON.stringify(stringifyOptions);
    metadata.mockReturnValue(serializedValue);
    const { registerHumanizeCompatibility } = await import('@/runtime/humanizeCompatibility.js');
    expect(() => registerHumanizeCompatibility()).toThrow('verified only for CloakBrowser 0.6.0');
    expect(register).not.toHaveBeenCalled();
  });
  it('registers one loader per upstream process even across repeated initialization', async () => {
    const stringifyOptions2 = { version: '0.6.0' } as const;
    const serializedValue2 = JSON.stringify(stringifyOptions2);
    metadata.mockReturnValue(serializedValue2);
    const { registerHumanizeCompatibility } = await import('@/runtime/humanizeCompatibility.js');
    for (let attempt = 0; attempt < 1000; attempt += 1) registerHumanizeCompatibility();
    expect(register).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledTimes(1);
    const receiverActual = register;
    const anyResult = expect.any(URL);
    const toHaveBeenCalledWithOptions = {
      data: {
        helpersUrl: expect.stringMatching(/\/human\/worldHelpers\.js$/u),
        worldUrl: expect.stringMatching(/\/human\/world\.js$/u),
      },
    } as const;
    expect(receiverActual).toHaveBeenCalledWith(anyResult, toHaveBeenCalledWithOptions);
  });
});
