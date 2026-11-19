import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pruneBackups, atomicWriteText } from '../src/writers.mjs';
import { writeSettingsValue } from '../src/settings-documents.mjs';
import { parsesSuccessfully } from '../src/commands.mjs';
import { findJsonObject, removeJsonProperty, spliceText } from '../src/spans.mjs';
import { envForHome, INSTALLER_ROOT, invoke, makeTree, SCHEMA_FROM, snapshotTree } from './helpers.mjs';

test('post-splice validation accepts valid falsy JSON roots', () => {
  for (const text of ['null', 'false', '0', '""']) {
    assert.equal(parsesSuccessfully('json', text), true, text);
  }
  assert.equal(parsesSuccessfully('json', '{bad'), false);
});

test('JSONC removal preserves user trivia before the first managed property', async () => {
  const text = `{
  "mcp": {
    "servers": {
      // user comment must survive
      "cloakbrowser": { "command": "node" }
    }
  }
}
`;
  const found = findJsonObject(text, ['mcp', 'servers']);
  const edit = removeJsonProperty(text, found.objectSpan, 'cloakbrowser', 'jsonc');
  assert.ok(edit.start > found.objectSpan.innerStart, 'leading trivia was not part of our span');
  const next = spliceText(text, edit);
  assert.match(next, /\/\/ user comment must survive/);
  assert.doesNotMatch(next, /cloakbrowser/);
});

test('JSONC comment-bearing config add -> remove restores original bytes', async () => {
  const tree = await makeTree('opencode', 'user');
  const original = `{
  // header comment
  "mcp": {
    "servers": {
      // inner comment
    }
  }
}
`;
  await writeFile(tree.target.path, original);
  const installed = await invoke(
    ['install', 'opencode', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(installed.code, 0, installed.out);
  const removed = await invoke(
    ['uninstall', 'opencode', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(removed.code, 0, removed.out);
  assert.equal(await readFile(tree.target.path, 'utf8'), original);
});

test('multiple entries from a generated root all retain restoration metadata', async () => {
  const tree = await makeTree('antigravity', 'user');
  await writeFile(tree.target.path, '');
  const first = await invoke(
    ['install', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(first.code, 0, first.out);
  const second = await invoke(
    [
      'install',
      'antigravity',
      '--name',
      'second',
      '--from',
      SCHEMA_FROM,
      '--data-root',
      tree.dataRoot,
      '--json',
    ],
    tree,
  );
  assert.equal(second.code, 0, second.out);
  const manifest = JSON.parse(await readFile(join(tree.dataRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.createdPaths['antigravity:user:cloakbrowser'].rootText, '');
  assert.deepEqual(
    manifest.createdPaths['antigravity:user:second'],
    manifest.createdPaths['antigravity:user:cloakbrowser'],
  );
  const removedFirst = await invoke(
    ['uninstall', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(removedFirst.code, 0, removedFirst.out);
  assert.match(await readFile(tree.target.path, 'utf8'), /second/);
  const removedSecond = await invoke(
    [
      'uninstall',
      'antigravity',
      '--name',
      'second',
      '--from',
      SCHEMA_FROM,
      '--data-root',
      tree.dataRoot,
      '--json',
    ],
    tree,
  );
  assert.equal(removedSecond.code, 0, removedSecond.out);
  assert.equal(await readFile(tree.target.path, 'utf8'), '');
});

test('install -> update -> uninstall preserves generated-root restoration metadata', async () => {
  const tree = await makeTree('antigravity', 'user');
  await writeFile(tree.target.path, '');
  const installed = await invoke(
    ['install', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(installed.code, 0, installed.out);
  const currentPath = join(tree.dataRoot, 'current.json');
  const current = JSON.parse(await readFile(currentPath, 'utf8'));
  current.pluginVersion = '2.25.0';
  await writeFile(currentPath, `${JSON.stringify(current, null, 2)}\n`);
  const before = JSON.parse(await readFile(join(tree.dataRoot, 'manifest.json'), 'utf8'));
  assert.ok(before.createdPaths['antigravity:user:cloakbrowser']);
  const updated = await invoke(
    ['update', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(updated.code, 0, updated.out);
  const after = JSON.parse(await readFile(join(tree.dataRoot, 'manifest.json'), 'utf8'));
  assert.deepEqual(after.createdPaths, before.createdPaths);
  const removed = await invoke(
    ['uninstall', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(removed.code, 0, removed.out);
  assert.equal(await readFile(tree.target.path, 'utf8'), '');
});

test('user-added BOM on a generated root is preserved on uninstall', async () => {
  const tree = await makeTree('antigravity', 'user');
  await writeFile(tree.target.path, '');
  const installed = await invoke(
    ['install', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(installed.code, 0, installed.out);
  await writeFile(tree.target.path, `﻿${await readFile(tree.target.path, 'utf8')}`);
  const removed = await invoke(
    ['uninstall', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(removed.code, 0, removed.out);
  const final = await readFile(tree.target.path, 'utf8');
  assert.ok(final.startsWith('﻿'), 'user-authored BOM was discarded');
  assert.doesNotMatch(final, /cloakbrowser/);
});

test('JSONC without a trailing comma: add -> remove restores the original bytes', async () => {
  const tree = await makeTree('opencode', 'user', 'no-trailing');
  const before = await readFile(tree.target.path);
  const installed = await invoke(
    ['install', 'opencode', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(installed.code, 0, installed.out);
  const added = await readFile(tree.target.path, 'utf8');
  assert.match(added, /"cloakbrowser"/);
  assert.equal(/,\s*$/m.test(added.split('"cloakbrowser"')[0].split('\n').at(-1)), false);
  const removed = await invoke(
    ['uninstall', 'opencode', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(removed.code, 0, removed.out);
  assert.deepEqual(await readFile(tree.target.path), before);
});

test('configure --print-env failure happens before the settings document is written', async () => {
  const tree = await makeTree('codex', 'user');
  const before = await snapshotTree(tree.root);
  const result = await invoke(
    [
      'configure',
      'codex',
      '--set',
      'headless=true',
      '--print-env',
      '--json',
      '--from',
      SCHEMA_FROM,
      '--data-root',
      tree.dataRoot,
    ],
    tree,
    { env: { STEALTH_DATA_DIR: tree.dataRoot } },
  );
  assert.equal(result.code, 2, result.out);
  assert.equal(result.jsonLines[0].error.kind, 'not-installed');
  assert.deepEqual(result.jsonLines[0].writes, []);
  assert.deepEqual(await snapshotTree(tree.root), before);
});

test('doctor reports invalid settings documents as an error', async () => {
  const tree = await makeTree('codex', 'user');
  await mkdir(join(tree.dataRoot, 'settings.d'), { recursive: true });
  await writeFile(
    join(tree.dataRoot, 'settings.json'),
    `${JSON.stringify({ version: 1, settings: { headless: 12 } })}\n`,
  );
  const result = await invoke(
    ['doctor', 'codex', '--static', '--json', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot],
    tree,
    { env: { STEALTH_DATA_DIR: tree.dataRoot } },
  );
  assert.equal(result.code, 3, result.out);
  const check = result.jsonLines[0].checks.find((item) => item.name === 'settings-types');
  assert.equal(check.status, 'error');
  assert.match(check.message, /headless/);
});

test('cliLogicalWinner reports entry-only values at the entry level', async () => {
  const tree = await makeTree('codex', 'user');
  await writeSettingsValue({
    dataRoot: tree.dataRoot,
    harness: 'codex',
    level: 'entry',
    key: 'headless',
    value: 'true',
    entry: 'cloakbrowser',
    project: tree.project,
  });
  const result = await invoke(
    ['configure', 'codex', '--show', '--json', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot],
    tree,
    { env: { STEALTH_DATA_DIR: tree.dataRoot } },
  );
  assert.equal(result.code, 0, result.out);
  const winner = result.jsonLines[0].cliLogicalWinner.find((item) => item.key === 'headless');
  assert.deepEqual(winner, { key: 'headless', level: 'entry', source: 'document' });
});

test('Phase 1 write commands refuse OpenClaw and Hermes', async () => {
  const tree = await makeTree('openclaw', 'user');
  for (const argv of [
    ['install', 'openclaw', '--dry-run', '--json'],
    ['configure', 'openclaw', '--set', 'headless=true', '--json'],
    ['enable', 'hermes', '--json'],
  ]) {
    const result = await invoke(argv, tree);
    assert.equal(result.code, 2, `${argv.join(' ')}: ${result.out}`);
    assert.equal(result.jsonLines[0].error.kind, 'unsupported-harness');
    assert.deepEqual(result.jsonLines[0].writes, []);
  }
});

test('Claude Code print-only commands use the requested engine', async () => {
  const tree = await makeTree('claude-code', 'user');
  const result = await invoke(['install', 'claude-code', '--engine', 'camoufox', '--json'], tree);
  assert.equal(result.code, 0, result.out);
  assert.ok(
    result.jsonLines[0].commands.some((command) => command.includes('"browser_engine":"camoufox"')),
    result.out,
  );
});

test('a missing JSON parent object is created in one splice and removal is byte-exact', async () => {
  const tree = await makeTree('antigravity', 'user');
  const original = '{"keep":true}\n';
  await writeFile(tree.target.path, original);
  const installed = await invoke(
    ['install', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(installed.code, 0, installed.out);
  const parsed = JSON.parse(await readFile(tree.target.path, 'utf8'));
  assert.ok(parsed.mcpServers.cloakbrowser, 'parent chain was created');
  const removed = await invoke(
    ['uninstall', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(removed.code, 0, removed.out);
  assert.equal(await readFile(tree.target.path, 'utf8'), original);
});

test('JSONC insertion preserves CRLF in the inserted block', async () => {
  const tree = await makeTree('opencode', 'user');
  const original =
    '{\r\n  // comment\r\n  "mcp": {\r\n    "servers": {\r\n      "other": { "type": "local" }\r\n    }\r\n  }\r\n}\r\n';
  await writeFile(tree.target.path, original);
  const installed = await invoke(
    ['install', 'opencode', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(installed.code, 0, installed.out);
  const added = await readFile(tree.target.path, 'utf8');
  assert.match(added, /"cloakbrowser": \{\r\n/);
  const removed = await invoke(
    ['uninstall', 'opencode', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(removed.code, 0, removed.out);
  assert.equal(await readFile(tree.target.path, 'utf8'), original);
});

test('check.mjs enforces bundle drift instead of swallowing it', async () => {
  const source = await readFile(join(INSTALLER_ROOT, 'scripts', 'check.mjs'), 'utf8');
  assert.match(source, /assert\.equal\(bundled\.status/);
  assert.doesNotMatch(source, /if \(!error\.message\.includes\('bundle\.json'\)\)/);
});

test('uninstall --force removes manifest.json instead of leaving a zero-byte file', async () => {
  const tree = await makeTree('codex', 'user');
  const installed = await invoke(
    ['install', 'codex', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(installed.code, 0, installed.out);
  const manifest = join(tree.dataRoot, 'manifest.json');
  assert.ok((await stat(manifest)).isFile());
  const removed = await invoke(
    ['uninstall', 'codex', '--force', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(removed.code, 0, removed.out);
  await assert.rejects(stat(manifest), { code: 'ENOENT' });
  const backups = await readdir(join(tree.dataRoot, 'backups'));
  assert.ok(backups.some((name) => name.startsWith('manifest.json.sabm-backup-')));
});

test('backup pruning keeps the newest files by mtime, not by filename', async () => {
  const tree = await makeTree('codex', 'user');
  const dir = join(tree.dataRoot, 'backups');
  await mkdir(dir, { recursive: true });
  const names = ['a', 'b', 'c', 'd', 'e'];
  for (const [index, suffix] of names.entries()) {
    const path = join(dir, `config.toml.sabm-backup-${suffix}`);
    await writeFile(path, suffix);
    const when = new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1));
    await utimes(path, when, when);
  }
  await pruneBackups(dir, 'config.toml');
  assert.deepEqual((await readdir(dir)).sort(), [
    'config.toml.sabm-backup-c',
    'config.toml.sabm-backup-d',
    'config.toml.sabm-backup-e',
  ]);
});

test('atomic write failure never leaves a temp file behind', async () => {
  const tree = await makeTree('codex', 'user');
  const path = tree.target.path;
  const original = await readFile(path, 'utf8');
  await assert.rejects(
    atomicWriteText(path, original, `${original}\n# fail`, {
      backupRoot: tree.dataRoot,
      validate: () => true,
      hooks: {
        afterTemp: () => {
          throw new Error('injected');
        },
      },
    }),
    /injected/,
  );
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(
    (await readdir(join(tree.dataRoot, 'backups'))).some((name) =>
      name.startsWith('config.toml.sabm-backup-'),
    ),
    true,
  );
});

test('empty JSONC parent object: add -> remove restores exact bytes', async () => {
  const tree = await makeTree('opencode', 'user');
  const original = '{"mcp":{"servers":{}}}';
  await writeFile(tree.target.path, original);
  const installed = await invoke(
    ['install', 'opencode', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(installed.code, 0, installed.out);
  const added = await readFile(tree.target.path, 'utf8');
  assert.match(added, /"cloakbrowser"/);
  assert.doesNotMatch(added, /\{\s*,/, 'no trailing comma after an empty object');
  const removed = await invoke(
    ['uninstall', 'opencode', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(removed.code, 0, removed.out);
  assert.equal(await readFile(tree.target.path, 'utf8'), original);
});

test('legacy pathless root metadata is not shared with an unrelated harness config', async () => {
  const tree = await makeTree('antigravity', 'user');
  const original = '{"mcpServers":{}}\n';
  await writeFile(tree.target.path, original);
  const manifestPath = join(tree.dataRoot, 'manifest.json');
  const legacy = { parents: ['mcpServers'], rootText: '' };
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schema: 'sabm-manifest/1',
        cliVersion: '1.1.0',
        entries: ['codex:user:legacy'],
        engines: ['2.26.0'],
        createdPaths: { 'codex:user:legacy': legacy },
      },
      null,
      2,
    )}\n`,
  );
  const installed = await invoke(
    ['install', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(installed.code, 0, installed.out);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.createdPaths['antigravity:user:cloakbrowser'], undefined);
  assert.deepEqual(manifest.createdPaths['codex:user:legacy'], legacy);
  const removed = await invoke(
    ['uninstall', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(removed.code, 0, removed.out);
  assert.equal(await readFile(tree.target.path, 'utf8'), original);
});

test('same-config pathless legacy metadata is shared and upgraded with a path', async () => {
  const tree = await makeTree('antigravity', 'user');
  await writeFile(tree.target.path, '');
  const first = await invoke(
    ['install', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(first.code, 0, first.out);
  const manifestPath = join(tree.dataRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.ok(manifest.createdPaths['antigravity:user:cloakbrowser'].path);
  delete manifest.createdPaths['antigravity:user:cloakbrowser'].path;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const second = await invoke(
    [
      'install',
      'antigravity',
      '--name',
      'second',
      '--from',
      SCHEMA_FROM,
      '--data-root',
      tree.dataRoot,
      '--json',
    ],
    tree,
  );
  assert.equal(second.code, 0, second.out);
  const upgraded = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(upgraded.createdPaths['antigravity:user:second'].path, tree.target.path);
  assert.equal(upgraded.createdPaths['antigravity:user:second'].rootText, '');
  const removedFirst = await invoke(
    ['uninstall', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
    tree,
  );
  assert.equal(removedFirst.code, 0, removedFirst.out);
  assert.match(await readFile(tree.target.path, 'utf8'), /second/);
  const removedSecond = await invoke(
    [
      'uninstall',
      'antigravity',
      '--name',
      'second',
      '--from',
      SCHEMA_FROM,
      '--data-root',
      tree.dataRoot,
      '--json',
    ],
    tree,
  );
  assert.equal(removedSecond.code, 0, removedSecond.out);
  assert.equal(await readFile(tree.target.path, 'utf8'), '');
});

test('legacy metadata with a colon in the entry name is shared and restores bytes', async () => {
  const tree = await makeTree('antigravity', 'user');
  await writeFile(tree.target.path, '');
  const first = await invoke(
    [
      'install',
      'antigravity',
      '--name',
      'a:b',
      '--from',
      SCHEMA_FROM,
      '--data-root',
      tree.dataRoot,
      '--json',
    ],
    tree,
  );
  assert.equal(first.code, 0, first.out);
  const manifestPath = join(tree.dataRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const legacyKey = 'antigravity:user:a:b';
  assert.ok(manifest.createdPaths[legacyKey].path);
  delete manifest.createdPaths[legacyKey].path;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const second = await invoke(
    [
      'install',
      'antigravity',
      '--name',
      'second',
      '--from',
      SCHEMA_FROM,
      '--data-root',
      tree.dataRoot,
      '--json',
    ],
    tree,
  );
  assert.equal(second.code, 0, second.out);
  const upgraded = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(upgraded.createdPaths['antigravity:user:second'].path, tree.target.path);
  assert.equal(upgraded.createdPaths['antigravity:user:second'].rootText, '');
  const removedFirst = await invoke(
    [
      'uninstall',
      'antigravity',
      '--name',
      'a:b',
      '--from',
      SCHEMA_FROM,
      '--data-root',
      tree.dataRoot,
      '--json',
    ],
    tree,
  );
  assert.equal(removedFirst.code, 0, removedFirst.out);
  assert.match(await readFile(tree.target.path, 'utf8'), /second/);
  const removedSecond = await invoke(
    [
      'uninstall',
      'antigravity',
      '--name',
      'second',
      '--from',
      SCHEMA_FROM,
      '--data-root',
      tree.dataRoot,
      '--json',
    ],
    tree,
  );
  assert.equal(removedSecond.code, 0, removedSecond.out);
  assert.equal(await readFile(tree.target.path, 'utf8'), '');
});

test('legacy names with empty colon segments are shared and restore bytes', async () => {
  for (const legacyName of ['a:', 'a::b', ':x']) {
    const tree = await makeTree('antigravity', 'user');
    await writeFile(tree.target.path, '');
    const first = await invoke(
      [
        'install',
        'antigravity',
        '--name',
        legacyName,
        '--from',
        SCHEMA_FROM,
        '--data-root',
        tree.dataRoot,
        '--json',
      ],
      tree,
    );
    assert.equal(first.code, 0, `${legacyName}: ${first.out}`);
    const manifestPath = join(tree.dataRoot, 'manifest.json');
    const legacyKey = `antigravity:user:${legacyName}`;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.ok(manifest.createdPaths[legacyKey].path);
    delete manifest.createdPaths[legacyKey].path;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const second = await invoke(
      [
        'install',
        'antigravity',
        '--name',
        'second',
        '--from',
        SCHEMA_FROM,
        '--data-root',
        tree.dataRoot,
        '--json',
      ],
      tree,
    );
    assert.equal(second.code, 0, `${legacyName}: ${second.out}`);
    const upgraded = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(upgraded.createdPaths['antigravity:user:second'].path, tree.target.path);
    assert.equal(upgraded.createdPaths['antigravity:user:second'].rootText, '');
    const removedFirst = await invoke(
      [
        'uninstall',
        'antigravity',
        '--name',
        legacyName,
        '--from',
        SCHEMA_FROM,
        '--data-root',
        tree.dataRoot,
        '--json',
      ],
      tree,
    );
    assert.equal(removedFirst.code, 0, `${legacyName}: ${removedFirst.out}`);
    assert.match(await readFile(tree.target.path, 'utf8'), /second/);
    const removedSecond = await invoke(
      [
        'uninstall',
        'antigravity',
        '--name',
        'second',
        '--from',
        SCHEMA_FROM,
        '--data-root',
        tree.dataRoot,
        '--json',
      ],
      tree,
    );
    assert.equal(removedSecond.code, 0, `${legacyName}: ${removedSecond.out}`);
    assert.equal(await readFile(tree.target.path, 'utf8'), '');
  }
});

test('empty and BOM-only config files restore their original bytes', async () => {
  for (const original of ['', '﻿']) {
    const tree = await makeTree('antigravity', 'user');
    await writeFile(tree.target.path, original, 'utf8');
    const installed = await invoke(
      ['install', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
      tree,
    );
    assert.equal(installed.code, 0, installed.out);
    const added = await readFile(tree.target.path, 'utf8');
    assert.match(added, /"cloakbrowser"/);
    const removed = await invoke(
      ['uninstall', 'antigravity', '--from', SCHEMA_FROM, '--data-root', tree.dataRoot, '--json'],
      tree,
    );
    assert.equal(removed.code, 0, removed.out);
    assert.equal(await readFile(tree.target.path, 'utf8'), original);
  }
});
