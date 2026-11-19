import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { compareVersions, pruneEngines } from '../src/engine.mjs';
import { makeTree } from './helpers.mjs';

test('version-aware ordering keeps 2.10.0 above 2.9.0 and 2.8.0', () => {
  assert.ok(compareVersions('2.10.0', '2.9.0') > 0);
  assert.ok(compareVersions('2.9.0', '2.8.0') > 0);
  assert.equal(compareVersions('2.26.0', '2.26.0'), 0);
});

test('pruneEngines retains the current generation and newest kept versions', async () => {
  const tree = await makeTree('codex', 'user');
  const root = join(tree.dataRoot, 'engine');
  for (const version of ['2.8.0', '2.9.0', '2.10.0']) await mkdir(join(root, version), { recursive: true });
  const removed = await pruneEngines(tree.dataRoot, 2, '2.10.0');
  assert.deepEqual(removed, ['2.8.0']);
  assert.deepEqual((await readdir(root)).sort(), ['2.10.0', '2.9.0']);
});
