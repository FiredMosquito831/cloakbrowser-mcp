import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { runNpmCommand } from '@tests/e2e/distributionHarness.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('runs npm through Node without shell parsing of Windows paths or metacharacters', () => {
  const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  vi.stubEnv('npm_execpath', cli);
  const output = { status: 0, stdout: 'packed', stderr: '', pid: 1, output: [], signal: null };
  vi.mocked(spawnSync).mockReturnValue(output);
  const cwd = tmpdir();
  const args = ['install', 'C:\\Temp\\fixture & package.tgz'];
  const result = runNpmCommand(args, cwd);
  expect(result).toBe('packed');
  const expectedArgs = [cli, ...args];
  const expectedOptions = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  expect(spawnSync).toHaveBeenCalledExactlyOnceWith(process.execPath, expectedArgs, expectedOptions);
});

it('fails clearly when the npm CLI context is unavailable', () => {
  vi.stubEnv('npm_execpath', undefined);
  const cwd = tmpdir();
  const args = ['pack'];
  expect(() => runNpmCommand(args, cwd)).toThrow('Run distribution tests through npm');
  expect(spawnSync).not.toHaveBeenCalled();
});
