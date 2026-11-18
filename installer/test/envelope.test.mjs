import assert from 'node:assert/strict';
import test from 'node:test';
import { errorEnvelope, exitCodeFor, failure, redact, SabmError, success } from '../src/envelope.mjs';
import { VERSION_TEXT } from '../src/cli.mjs';
import { invoke, makeTree } from './helpers.mjs';

test('envelope shapes, exit codes and secret redaction', () => {
  const ok = success('list', { count: 2 });
  assert.equal(ok.schema, 'sabm/1');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.writes, []);
  assert.equal(exitCodeFor(ok), 0);
  const bad = failure({
    command: 'install',
    code: 'refused',
    kind: 'foreign-entry',
    message: 'no',
    remedy: 'fix',
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.writes, []);
  assert.equal(exitCodeFor(bad), 2);
  assert.equal(exitCodeFor(failure({ code: 'usage', message: 'x', remedy: 'y' })), 1);
  assert.equal(exitCodeFor(failure({ code: 'verification_failed', message: 'x', remedy: 'y' })), 3);
  assert.equal(redact('licence_key', 'abc'), 'configured: true');
  assert.equal(redact('proxy_server', ''), '(unset)');
  assert.equal(redact('browser_engine', 'cloak'), 'cloak');
  const fromError = errorEnvelope(
    new SabmError('refused', 'unsupported-scope', 'no project', 'use user'),
    'install',
  );
  assert.equal(fromError.error.code, 'refused');
  assert.equal(fromError.error.kind, 'unsupported-scope');
});

test('non-zero exits print exactly one sabm/1 line, even without --json', async () => {
  const tree = await makeTree('codex', 'user');
  const usage = await invoke(['install', 'not-a-harness', '--dry-run'], tree);
  assert.equal(usage.code, 1);
  assert.equal(usage.jsonLines.length, 1);
  assert.equal(usage.jsonLines[0].error.code, 'usage');
  assert.equal(usage.out.trim().split('\n').length, 1);

  const scope = await invoke(['install', 'hermes', '--scope', 'project', '--dry-run'], tree);
  assert.equal(scope.code, 2);
  assert.equal(scope.jsonLines[0].error.kind, 'unsupported-scope');
  assert.deepEqual(scope.jsonLines[0].writes, []);

  const refused = await invoke(['--print-config', 'opencode'], tree, { platform: 'win32' });
  assert.equal(refused.code, 2);
  assert.equal(refused.jsonLines[0].error.kind, 'windows-path-unverified');
  assert.match(refused.jsonLines[0].error.message, /UNVERIFIED/);

  const version = await invoke(['--version'], tree);
  assert.equal(version.code, 0);
  assert.equal(version.out.trim(), VERSION_TEXT);
});

test('doctor errors produce verification_failed with checks in the single line', async () => {
  const tree = await makeTree('codex', 'user', 'foreign');
  const result = await invoke(['doctor', '--static'], tree);
  assert.equal(result.code, 3);
  assert.equal(result.out.trim().split('\n').length, 1);
  assert.equal(result.jsonLines.length, 1);
  assert.equal(result.jsonLines[0].error.code, 'verification_failed');
  assert.equal(result.jsonLines[0].error.kind, 'doctor-error');
  assert.ok(result.jsonLines[0].checks.some((check) => check.status === 'error'));
  assert.deepEqual(result.jsonLines[0].writes, []);
});
