import { systemErrorCodes } from '@/runtime/systemErrorCodes.js';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileSeedFileName, readOrCreateProfileSeed } from '@/bridge/profile-seed.js';
const { linkFailure } = vi.hoisted(() => ({ linkFailure: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  link: linkFailure,
}));
const roots: string[] = [];
afterEach(async () => {
  linkFailure.mockReset();
  const mappedValues = roots.splice(0).map((root) => {
    const rmOptions = { recursive: true, force: true } as const;
    return rm(root, rmOptions);
  });
  await Promise.all(mappedValues);
});
async function createRoot(): Promise<string> {
  const tmpdirResult = tmpdir();
  const joinedPath = path.join(tmpdirResult, 'cloak-seed-fallback-');
  const root = await mkdtemp(joinedPath);
  roots.push(root);
  return root;
}
describe('profile seed publication on filesystems without hard links', () => {
  const values: readonly ('ENOSYS' | 'ENOTSUP' | 'EOPNOTSUPP' | 'EPERM' | 'EXDEV')[] = [
    systemErrorCodes.EPERM,
    systemErrorCodes.ENOTSUP,
    systemErrorCodes.EOPNOTSUPP,
    systemErrorCodes.ENOSYS,
    systemErrorCodes.EXDEV,
  ];
  it.each(values)('publishes exclusively when link fails with %s', async (code) => {
    const root = await createRoot();
    const error = new Error('Unsupported hard link');
    const assignOptions = { code } as const;
    const assignResult = Object.assign(error, assignOptions);
    linkFailure.mockRejectedValue(assignResult);
    const fromOptions = { length: 8 } as const;
    const fromResult = Array.from(fromOptions, () => readOrCreateProfileSeed(root));
    const seeds = await Promise.all(fromResult);
    const argumentValue = new Set(seeds).size;
    expect(argumentValue).toBe(1);
    const joinedPath2 = path.join(root, profileSeedFileName);
    const fileResult = await readFile(joinedPath2, 'utf8');
    const receiverActual = fileResult;
    const message = `${seeds[0]}\n`;
    expect(receiverActual).toBe(message);
    const dirResult = await readdir(root);
    const receiver2Actual = dirResult;
    const values2: string[] = [profileSeedFileName];
    expect(receiver2Actual).toEqual(values2);
  });
  it('preserves a seed published by another writer before the exclusive fallback', async () => {
    const root = await createRoot();
    linkFailure.mockImplementation(async () => {
      const joinedPath3 = path.join(root, profileSeedFileName);
      const writeFileOptions = { flag: 'wx' } as const;
      await writeFile(joinedPath3, '12345\n', writeFileOptions);
      const error2 = new Error('Unsupported hard link');
      const assignOptions2 = { code: systemErrorCodes.ENOTSUP } as const;
      throw Object.assign(error2, assignOptions2);
    });
    const orCreateProfileSeedResult = await readOrCreateProfileSeed(root);
    expect(orCreateProfileSeedResult).toBe(12345);
    const dirResult2 = await readdir(root);
    const receiver3Actual = dirResult2;
    const values3: string[] = [profileSeedFileName];
    expect(receiver3Actual).toEqual(values3);
  });
  it('propagates access failures and removes the unpublished temporary file', async () => {
    const root = await createRoot();
    const error3 = new Error('Access denied');
    const assignOptions3 = { code: systemErrorCodes.EACCES } as const;
    const assignResult2 = Object.assign(error3, assignOptions3);
    linkFailure.mockRejectedValue(assignResult2);
    const orCreateProfileSeedResult2 = readOrCreateProfileSeed(root);
    const receiver4Actual = orCreateProfileSeedResult2;
    const toMatchObjectOptions = { code: systemErrorCodes.EACCES } as const;
    await expect(receiver4Actual).rejects.toMatchObject(toMatchObjectOptions);
    const dirResult3 = await readdir(root);
    const receiver5Actual = dirResult3;
    const values4: never[] = [];
    expect(receiver5Actual).toEqual(values4);
  });
});
