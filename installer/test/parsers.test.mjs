import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { HARNESS_INFO } from '../src/harnesses.mjs';
import { detectEol, detectIndent, inspectConfig, parseText, snippetFor } from '../src/parsers.mjs';
import { FIXTURES, makeTree, SCHEMA_FROM } from './helpers.mjs';

const FORMAT_HARNESS = {
  toml: 'codex',
  json: 'antigravity',
  jsonc: 'opencode',
  json5: 'openclaw',
  yaml: 'hermes',
};

function targetFor(format, path) {
  const harness = FORMAT_HARNESS[format];
  const info = HARNESS_INFO[harness];
  return {
    harness,
    label: info.label,
    format,
    parent: info.parent,
    envKey: info.envKey,
    keyLabel: info.keyLabel,
    path,
  };
}

test('parser corpus: every documented format parses and yields a splice plan', async () => {
  const files = {
    toml: 'codex-valid.toml',
    json: 'antigravity-valid.json',
    jsonc: 'opencode-valid.jsonc',
    json5: 'openclaw-valid.json5',
    yaml: 'hermes-valid.yaml',
  };
  for (const [format, name] of Object.entries(files)) {
    const path = join(FIXTURES, name);
    const original = await readFile(path);
    const text = original.toString('utf8');
    const document = parseText(format, text);
    assert.ok(document && typeof document === 'object', `${format} parsed`);
    const state = await inspectConfig(targetFor(format, path), 'cloakbrowser', SCHEMA_FROM);
    assert.equal(state.parse, 'ok', `${format}: ${state.message}`);
    assert.equal(state.status, 'absent');
    const snippet = snippetFor(targetFor(format, path), { dataRoot: 'C:\\data\\sabm', name: 'cloakbrowser' });
    assert.match(snippet, /format: /);
    assert.match(snippet, /STEALTH_DATA_DIR/);
    assert.deepEqual(await readFile(path), original, 'parse-only inspection left the fixture untouched');
  }
});

test('TOML CRLF, quoted keys and detected indentation survive in the snippet text', async () => {
  const path = join(FIXTURES, 'codex-valid.toml');
  const text = await readFile(path, 'utf8');
  assert.equal(detectEol(text), '\r\n');
  assert.equal(detectIndent(text, ['mcp_servers']), '  ');
  const snippet = snippetFor(targetFor('toml', path), {
    dataRoot: 'C:\\data\\sabm',
    name: 'cloakbrowser',
    eol: '\r\n',
    indent: '    ',
  });
  assert.ok(snippet.includes('\r\n'));
  assert.match(snippet, /\[mcp_servers\.cloakbrowser\]/);
  assert.match(snippet, /"--harness", "codex"/);
  assert.ok(snippet.includes(JSON.stringify('C:\\data\\sabm')));
  assert.match(snippet, /\r\ncommand = "node"/);
});

test('JSON, JSONC, JSON5 and YAML snippets use the shape for their harness', () => {
  const dataRoot = '/tmp/sabm';
  const json = snippetFor(targetFor('json', 'x.json'), { dataRoot, name: 'cloakbrowser' });
  assert.match(json, /"mcpServers": \{/);
  assert.match(json, /"timeoutSeconds": 600/);
  const jsonc = snippetFor(targetFor('jsonc', 'x.jsonc'), { dataRoot, name: 'cloakbrowser' });
  assert.match(jsonc, /"environment": \{ "STEALTH_DATA_DIR"/);
  assert.match(jsonc, /"type": "local"/);
  const json5 = snippetFor(targetFor('json5', 'x.json5'), { dataRoot, name: 'cloakbrowser' });
  assert.match(json5, /mcp: \{/);
  assert.match(json5, /servers: \{/);
  assert.doesNotMatch(json5, /"servers":/);
  const yaml = snippetFor(targetFor('yaml', 'x.yaml'), { dataRoot, name: 'cloakbrowser' });
  assert.match(yaml, /mcp_servers:\n  cloakbrowser:/);
  assert.match(yaml, /      STEALTH_DATA_DIR:/);
});

test('refusal corpus leaves bytes untouched', async () => {
  const cases = [
    ['json', 'unparseable.json', 'unparseable'],
    ['json', 'json-duplicate.json', 'unparseable'],
    ['toml', 'codex-inline.toml', 'unparseable'],
    ['yaml', 'hermes-alias.yaml', 'unparseable'],
  ];
  for (const [format, name, expected] of cases) {
    const path = join(FIXTURES, name);
    const before = await readFile(path);
    const state = await inspectConfig(targetFor(format, path), 'cloakbrowser', SCHEMA_FROM);
    assert.equal(state.status, expected, `${name}: ${state.message}`);
    assert.deepEqual(await readFile(path), before);
  }
  const foreign = await inspectConfig(
    targetFor('toml', join(FIXTURES, 'codex-foreign.toml')),
    'cloakbrowser',
    SCHEMA_FROM,
  );
  assert.equal(foreign.status, 'foreign');
  assert.equal(foreign.present, false);
  const foreignJson = await inspectConfig(
    targetFor('json', join(FIXTURES, 'antigravity-foreign.json')),
    'cloakbrowser',
    SCHEMA_FROM,
  );
  assert.equal(foreignJson.status, 'foreign');
});

test('a directory, a missing file and a non-object parent are classified honestly', async () => {
  const tree = await makeTree('codex', 'user');
  const missing = await inspectConfig(
    targetFor('toml', join(tree.root, 'absent.toml')),
    'cloakbrowser',
    tree.dataRoot,
  );
  assert.equal(missing.parse, 'missing');
  const directory = await inspectConfig(targetFor('toml', tree.root), 'cloakbrowser', tree.dataRoot);
  assert.equal(directory.status, 'directory');
  const parent = { mcp_servers: 'not an object' };
  assert.deepEqual(parent.mcp_servers, 'not an object');
});
