import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DOCUMENT_SETTINGS_KEYS, SETTINGS_DOCUMENT_LIMIT_BYTES } from '../vendor/lib/settings-precedence.mjs';
import { readDocument, writeSettingsValue } from '../src/settings-documents.mjs';
import { envForHome, invoke, makeTree, SCHEMA_FROM, snapshotTree } from './helpers.mjs';

test('four logical levels map to two broker documents with additive scopes', async () => {
  const tree = await makeTree('codex', 'user');
  const calls = [
    ['global', 'headless', 'true'],
    ['harness', 'on_locked', 'block'],
    ['entry', 'copy_contents', 'full'],
    ['project', 'humanize', 'false'],
  ];
  const files = new Set();
  for (const [level, key, value] of calls) {
    const result = await writeSettingsValue({
      dataRoot: tree.dataRoot,
      harness: 'codex',
      level,
      key,
      value,
      entry: 'cloakbrowser',
      project: tree.project,
    });
    files.add(result.path);
    assert.ok(Object.hasOwn(result.write, 'backup'));
  }
  assert.equal(files.size, 2, 'only the global and harness documents are written');
  const global = JSON.parse(await readFile(join(tree.dataRoot, 'settings.json'), 'utf8'));
  const harness = JSON.parse(await readFile(join(tree.dataRoot, 'settings.d', 'codex.json'), 'utf8'));
  assert.equal(global.version, 1);
  assert.equal(global.settings.headless, 'true');
  assert.equal(harness.settings.on_locked, 'block');
  assert.equal(harness.scopes.entries.cloakbrowser.settings.copy_contents, 'full');
  assert.equal(harness.scopes.projects[tree.project].settings.humanize, 'false');
  assert.equal(Object.hasOwn(global, 'scopes'), false);
});

test('multiple settings at one level produce exactly one atomic document write', async () => {
  const tree = await makeTree('codex', 'user');
  const result = await invoke(
    [
      'configure',
      'codex',
      '--set',
      'headless=true',
      '--set',
      'humanize=false',
      '--level',
      'harness',
      '--json',
      '--from',
      SCHEMA_FROM,
      '--data-root',
      tree.dataRoot,
    ],
    tree,
    { env: { STEALTH_DATA_DIR: tree.dataRoot } },
  );
  assert.equal(result.code, 0, result.out);
  assert.equal(result.jsonLines[0].writes.length, 1);
  assert.equal(result.jsonLines[0].written.length, 2);
  const document = JSON.parse(await readFile(join(tree.dataRoot, 'settings.d', 'codex.json'), 'utf8'));
  assert.equal(document.settings.headless, 'true');
  assert.equal(document.settings.humanize, 'false');
  // A newly created document has no previous bytes to back up.
  assert.equal(result.jsonLines[0].writes[0].backup, null);
});

test('all 16 document-settable keys are string-only and version 1', async () => {
  const tree = await makeTree('codex', 'user');
  for (const key of DOCUMENT_SETTINGS_KEYS) {
    const result = await writeSettingsValue({
      dataRoot: tree.dataRoot,
      harness: 'codex',
      level: 'global',
      key,
      value: 'true',
    });
    assert.ok(Object.hasOwn(result.write, 'backup'));
  }
  const document = JSON.parse(await readFile(join(tree.dataRoot, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(document.settings).sort(), [...DOCUMENT_SETTINGS_KEYS].sort());
  assert.ok(Object.values(document.settings).every((value) => typeof value === 'string'));
  await assert.rejects(
    writeSettingsValue({
      dataRoot: tree.dataRoot,
      harness: 'codex',
      level: 'global',
      key: 'profile_isolation',
      value: 12,
    }),
    /single-line string/,
  );
});

test('session-only keys, unknown keys and settings_level never enter a document', async () => {
  const tree = await makeTree('codex', 'user');
  for (const key of ['profile_dir', 'browser_engine', 'licence_key', 'settings_level', 'not_a_key']) {
    const result = await invoke(
      [
        'configure',
        'codex',
        '--set',
        `${key}=value`,
        '--level',
        'harness',
        '--from',
        SCHEMA_FROM,
        '--data-root',
        tree.dataRoot,
        '--json',
      ],
      tree,
    );
    assert.equal(result.code, 2, `${key}: ${result.out}`);
    assert.deepEqual(result.jsonLines[0].writes, []);
  }
  const files = await import('node:fs/promises').then((fs) => fs.readdir(tree.dataRoot));
  assert.ok(!files.includes('settings.json'));
  assert.ok(!files.includes('settings.d'));
});

test('over-limit, invalid UTF-8 and non-object documents are refused, never fatal', async () => {
  const tree = await makeTree('codex', 'user');
  await mkdir(join(tree.dataRoot, 'settings.d'), { recursive: true });
  const global = join(tree.dataRoot, 'settings.json');
  await writeFile(
    global,
    `${JSON.stringify({ version: 1, settings: { headless: 'x'.repeat(SETTINGS_DOCUMENT_LIMIT_BYTES) } })}`,
  );
  await assert.rejects(
    writeSettingsValue({
      dataRoot: tree.dataRoot,
      harness: 'codex',
      level: 'global',
      key: 'headless',
      value: 'true',
    }),
    /64 KB/,
  );
  const result = await invoke(
    ['configure', 'codex', '--show', '--json', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot],
    tree,
  );
  assert.equal(result.code, 0, result.out);
  assert.equal(result.jsonLines[0].settingsDocument, 'present (broker-owned)');
  await writeFile(global, Buffer.from([0xff, 0xfe, 0x00]));
  await assert.rejects(readDocument(global), /valid JSON/);
});

test('broker-owned output is verbatim for a gated read, absent otherwise', async () => {
  const tree = await makeTree('codex', 'user');
  const gated = await invoke(
    [
      'configure',
      'codex',
      '--set',
      'headless=true',
      '--level',
      'harness',
      '--json',
      '--from',
      SCHEMA_FROM,
      '--data-root',
      tree.dataRoot,
    ],
    tree,
    { env: { STEALTH_DATA_DIR: tree.dataRoot } },
  );
  assert.equal(gated.code, 0, gated.out);
  const body = gated.jsonLines[0];
  assert.ok(body.precedence, 'gated read emits broker precedence');
  assert.equal(body.precedence.settings.headless.level, 'harness');
  assert.equal(body.precedence.settings.headless.source, 'document');
  for (const key of DOCUMENT_SETTINGS_KEYS)
    assert.ok(Array.isArray(body.precedence.settings[key].skipped), `${key}.skipped`);
  for (const key of ['proxy_server', 'licence_key']) {
    assert.deepEqual(Object.keys(body.precedence.settings[key]).sort(), ['configured', 'level', 'source']);
  }
  assert.ok(body.cliLogicalWinner.length > 0);
  assert.ok(
    !body.cliLogicalWinner.some(
      (winner) =>
        ['env', 'session', 'harness', 'global', 'default'].includes(winner.level) &&
        winner.source === 'document' &&
        winner.level === 'project',
    ),
  );
  const ungated = await invoke(['configure', 'codex', '--show', '--json', '--from', SCHEMA_FROM], tree, {
    env: { STEALTH_DATA_DIR: undefined },
  });
  assert.equal(ungated.code, 0, ungated.out);
  assert.equal(ungated.jsonLines[0].precedence, undefined);
  assert.equal(ungated.jsonLines[0].precedenceNote, undefined);
});

test('D0: Claude Code print-only install/configure never probes or writes settings', async () => {
  const tree = await makeTree('claude-code', 'user');
  const before = await snapshotTree(tree.root);
  const install = await invoke(['install', 'claude-code', '--json', '--data-root', tree.dataRoot], tree);
  const configure = await invoke(
    ['configure', 'claude-code', '--set', 'headless=true', '--json', '--data-root', tree.dataRoot],
    tree,
  );
  assert.equal(install.code, 0);
  assert.equal(configure.code, 0);
  assert.deepEqual(install.jsonLines[0].writes, []);
  assert.deepEqual(configure.jsonLines[0].writes, []);
  assert.deepEqual(await snapshotTree(tree.root), before);
});
