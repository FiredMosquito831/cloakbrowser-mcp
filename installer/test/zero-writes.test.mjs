import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { HARNESS_IDS, HARNESS_INFO } from '../src/harnesses.mjs';
import { INSTALLER_ROOT, invoke, makeTree, SCHEMA_FROM, snapshotTree } from './helpers.mjs';

const VARIANTS = ['clean', 'foreign', 'unparseable'];

function commandsFor(harness, scope, tree) {
  const root = tree.dataRoot;
  return [
    { argv: ['list', '--json', '--data-root', root], platform: 'linux' },
    { argv: ['list', '--data-root', root], platform: 'linux' },
    { argv: ['doctor', '--static', '--json', '--data-root', root], platform: 'linux' },
    { argv: ['doctor', '--static', '--data-root', root], platform: 'linux' },
    {
      argv: ['configure', '--show', '--json', '--from', SCHEMA_FROM, '--data-root', root],
      platform: 'linux',
    },
    { argv: ['configure', '--show', '--from', SCHEMA_FROM, '--data-root', root], platform: 'linux' },
    {
      argv: ['install', harness, '--dry-run', '--json', '--scope', scope, '--data-root', root],
      platform: 'linux',
    },
    { argv: ['install', harness, '--dry-run', '--scope', scope, '--data-root', root], platform: 'linux' },
    { argv: ['--print-config', harness, '--json', '--scope', scope, '--data-root', root], platform: 'linux' },
    { argv: ['--print-config', harness, '--scope', scope, '--data-root', root], platform: 'linux' },
    { argv: ['--print-config', harness, '--scope', scope, '--data-root', root], platform: 'win32' },
    {
      argv: ['install', harness, '--dry-run', '--json', '--scope', scope, '--data-root', root],
      platform: 'win32',
    },
  ];
}

test('five-part hash proof: no Phase 0 command changes a fixture home, project or data root', async (t) => {
  let invocations = 0;
  let jsonLines = 0;
  for (const harness of HARNESS_IDS) {
    for (const scope of HARNESS_INFO[harness].scopes) {
      for (const variant of VARIANTS) {
        const tree = await makeTree(harness, scope, variant);
        const before = await snapshotTree(tree.root);
        for (const { argv, platform } of commandsFor(harness, scope, tree)) {
          const result = await invoke(argv, tree, { platform });
          invocations += 1;
          assert.ok([0, 1, 2, 3].includes(result.code), `${argv.join(' ')} exited ${result.code}`);
          if (result.code !== 0) {
            assert.equal(result.out.trim().split('\n').length, 1, `${argv.join(' ')} printed extra stdout`);
            assert.equal(result.jsonLines.length, 1, `${argv.join(' ')} did not print one JSON line`);
            assert.equal(result.jsonLines[0].ok, false);
            assert.deepEqual(result.jsonLines[0].writes, []);
            assert.ok(['usage', 'refused', 'verification_failed'].includes(result.jsonLines[0].error.code));
            for (const field of ['code', 'message', 'remedy']) {
              assert.ok(result.jsonLines[0].error[field], `${argv.join(' ')} missing error.${field}`);
            }
          }
          for (const line of result.jsonLines) {
            jsonLines += 1;
            assert.deepEqual(line.writes, [], `${argv.join(' ')} reported writes`);
          }
        }
        assert.deepEqual(
          await snapshotTree(tree.root),
          before,
          `${harness}/${scope}/${variant} changed the fixture tree`,
        );
      }
    }
  }
  t.diagnostic(
    `hash proof: ${invocations} invocations, ${jsonLines} JSON lines, all fixture trees byte-identical`,
  );
});

test('Phase 0 source has no write, rename, process or network calls', async () => {
  const src = join(INSTALLER_ROOT, 'src');
  const forbidden = [
    /node:child_process/,
    /\bspawn(Sync)?\s*\(/,
    /require\s*\(\s*['"]child_process/,
    /\bwriteFile(Sync)?\s*\(/,
    /\bappendFile(Sync)?\s*\(/,
    /\bcreateWriteStream\s*\(/,
    /\bmkdir(Sync)?\s*\(/,
    /\brmdir(Sync)?\s*\(/,
    /\bunlink(Sync)?\s*\(/,
    /\brename(Sync)?\s*\(/,
    /\brmSync\s*\(/,
    /\bfetch\s*\(/,
    /(?:from|import\s*\()\s*['"][^'"]*(?:playwright|provision\.mjs|broker\.mjs|launch[^'"]*\.mjs)/i,
  ];
  for (const name of await readdir(src)) {
    if (!name.endsWith('.mjs')) continue;
    const source = await readFile(join(src, name), 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${name} contains forbidden code`);
  }
});
