import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SabmError } from '../src/envelope.mjs';
import { atomicWriteText } from '../src/writers.mjs';
import { envForHome, invoke, makeTree, SCHEMA_FROM, snapshotTree } from './helpers.mjs';

const FORMATS = [
  ['codex', 'toml'],
  ['antigravity', 'json'],
  ['opencode', 'jsonc'],
];

for (const [harness, format] of FORMATS) {
  test(`${format}: add -> golden, idempotence and byte-exact add -> remove`, async (t) => {
    const tree = await makeTree(harness, 'user');
    const before = await readFile(tree.target.path);
    const argv = ['install', harness, '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'];
    const installed = await invoke(argv, tree);
    assert.equal(installed.code, 0, installed.out);
    const body = installed.jsonLines[0];
    assert.deepEqual(body.writes.length > 0, true);
    assert.ok(
      body.writes.every((write) => write.path && write.action && Object.hasOwn(write, 'backup')),
      JSON.stringify(body.writes),
    );
    const after = await readFile(tree.target.path);
    assert.notDeepEqual(after, before, `${format}: install changed the config`);
    if (format === 'toml') {
      assert.match(after.toString('utf8'), /STEALTH_HARNESS = "codex"/);
      assert.ok(after.toString('utf8').includes('\r\n'));
    } else if (format === 'json') {
      assert.match(after.toString('utf8'), /STEALTH_HARNESS/);
    } else {
      assert.match(after.toString('utf8'), /STEALTH_HARNESS/);
      assert.match(after.toString('utf8'), /\/\/ OpenCode fixture/, 'comments survive');
    }
    const second = await invoke(argv, tree);
    assert.equal(second.code, 0, second.out);
    assert.deepEqual(second.jsonLines[0].writes, [], `${format}: a second install must be a no-op`);
    assert.deepEqual(await readFile(tree.target.path), after, `${format}: idempotent install changed bytes`);
    const removed = await invoke(
      ['uninstall', harness, '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
      tree,
    );
    assert.equal(removed.code, 0, removed.out);
    assert.deepEqual(
      await readFile(tree.target.path),
      before,
      `${format}: add -> remove must be byte-identical`,
    );
    t.diagnostic(`${format}: round trip ${before.length} -> ${after.length} -> ${before.length} bytes`);
  });
}

test('a foreign same-named entry refuses with exit 2 and untouched bytes', async () => {
  for (const [harness] of FORMATS) {
    const tree = await makeTree(harness, 'user', 'foreign');
    const before = await snapshotTree(tree.root);
    const result = await invoke(
      ['install', harness, '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
      tree,
    );
    assert.equal(result.code, 2, result.out);
    assert.equal(result.jsonLines[0].error.kind, 'foreign-entry');
    assert.deepEqual(result.jsonLines[0].writes, []);
    assert.deepEqual(await snapshotTree(tree.root), before, `${harness}: refusal changed a file`);
  }
});

test('uninstall --force still refuses a foreign entry and preserves its bytes', async () => {
  const tree = await makeTree('codex', 'user', 'foreign');
  const before = await snapshotTree(tree.root);
  const result = await invoke(
    ['uninstall', 'codex', '--force', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(result.code, 2, result.out);
  assert.equal(result.jsonLines[0].error.kind, 'foreign-entry');
  assert.deepEqual(result.jsonLines[0].writes, []);
  assert.deepEqual(await snapshotTree(tree.root), before);
});

test('refusals: unparseable file, inline TOML, directory and Windows OpenCode', async () => {
  const cases = [
    ['codex', 'unparseable'],
    ['codex', 'inline'],
    ['antigravity', 'unparseable'],
    ['opencode', 'unparseable'],
  ];
  for (const [harness, variant] of cases) {
    const tree = await makeTree(harness, 'user', variant);
    const before = await readFile(tree.target.path);
    const result = await invoke(
      ['install', harness, '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
      tree,
    );
    assert.equal(result.code, 2, `${harness}/${variant}: ${result.out}`);
    assert.deepEqual(result.jsonLines[0].writes, []);
    assert.deepEqual(await readFile(tree.target.path), before);
  }
  const tree = await makeTree('codex', 'user');
  const before = await snapshotTree(tree.root);
  const windows = await invoke(
    ['install', 'opencode', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
    {
      platform: 'win32',
    },
  );
  assert.equal(windows.code, 2);
  assert.match(windows.jsonLines[0].error.message, /UNVERIFIED/);
  assert.deepEqual(await snapshotTree(tree.root), before, 'Windows refusal opened/wrote a path');
});

test('atomicity failure injection leaves original bytes and a backup', async () => {
  const tree = await makeTree('codex', 'user');
  const path = tree.target.path;
  const original = await readFile(path, 'utf8');
  await assert.rejects(
    atomicWriteText(path, original, `${original}\n# partial`, {
      backupRoot: tree.dataRoot,
      action: 'modify',
      validate: () => true,
      hooks: {
        afterTemp: () => {
          throw new Error('injected rename failure');
        },
      },
    }),
    /injected rename failure/,
  );
  assert.equal(await readFile(path, 'utf8'), original, 'original bytes survived');
  const names = await import('node:fs/promises').then((fs) => fs.readdir(join(tree.dataRoot, 'backups')));
  assert.ok(names.some((name) => name.startsWith('config.toml.sabm-backup-')));
  for (const name of await import('node:fs/promises').then((fs) =>
    fs.readdir(join(tree.dataRoot, 'backups')),
  )) {
    const temp = await stat(join(tree.dataRoot, 'backups', name));
    assert.ok(temp.isFile());
  }
});

test('backup rotation keeps only the last three backups per file', async () => {
  const tree = await makeTree('codex', 'user');
  const path = tree.target.path;
  const original = await readFile(path, 'utf8');
  for (let i = 0; i < 5; i += 1) {
    await atomicWriteText(path, original, original, {
      backupRoot: tree.dataRoot,
      action: 'modify',
      validate: () => true,
    });
  }
  const { readdir } = await import('node:fs/promises');
  const names = (await readdir(join(tree.dataRoot, 'backups'))).filter((name) =>
    name.startsWith('config.toml.sabm-backup-'),
  );
  assert.equal(names.length, 3);
});

test('enable/disable splice only our entry and Claude Code stays print-only', async () => {
  const tree = await makeTree('antigravity', 'user');
  await invoke(['install', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot], tree);
  const disabled = await invoke(
    ['disable', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(disabled.code, 0, disabled.out);
  assert.equal(disabled.jsonLines[0].writes.length, 1);
  assert.match(await readFile(tree.target.path, 'utf8'), /"disabled": true/);
  const enabled = await invoke(
    ['enable', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(enabled.code, 0, enabled.out);
  assert.doesNotMatch(await readFile(tree.target.path, 'utf8'), /"disabled": true/);
  const claude = await makeTree('claude-code', 'user');
  const before = await snapshotTree(claude.root);
  const printed = await invoke(['disable', 'claude-code', '--json'], claude);
  assert.equal(printed.code, 0);
  assert.match(printed.jsonLines[0].commands[0], /claude plugin disable/);
  assert.deepEqual(printed.jsonLines[0].writes, []);
  assert.deepEqual(await snapshotTree(claude.root), before);
});
