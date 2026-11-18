import JSON5 from 'json5';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { SabmError, redact } from './envelope.mjs';
import { norm, readTextFile, shimPath } from './paths.mjs';

const SECRET_FIELDS = new Set(['licence_key', 'proxy_server']);

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseText(format, text) {
  const cleaned = String(text).replace(/^﻿/, '');
  if (cleaned.trim() === '') return {};
  if (format === 'json') return JSON.parse(cleaned);
  if (format === 'toml') return parseToml(cleaned);
  if (format === 'yaml') return parseYaml(cleaned) ?? {};
  return JSON5.parse(cleaned);
}

export function getPathValue(document, keys) {
  let current = document;
  for (const key of keys) {
    if (!isPlainObject(current) || !(key in current)) return { found: false, value: undefined };
    current = current[key];
  }
  return { found: true, value: current };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function structuralRefusal(target, text, name) {
  const path = target.path;
  const key = escapeRegExp(name);
  if (target.format === 'toml') {
    const collision = new RegExp(
      `^\\s*mcp_servers\\s*\\.\\s*(?:"${key}"|'${key}'|${key})\\s*(?:\\.|=\\s*[{])`,
      'm',
    );
    if (collision.test(text)) {
      return {
        kind: 'parse-error',
        message: `${path} uses an inline table or dotted-key form for ${target.keyLabel}; refusing to guess an edit span.`,
        remedy: `Remove the inline entry with the harness's own command, then run this reporter again.`,
      };
    }
  }
  if (target.format === 'yaml') {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    const parentName = target.parent[0];
    const parentLine = lines.find((line) => new RegExp(`^${escapeRegExp(parentName)}\\s*:`).test(line));
    if (parentLine) {
      const rest = parentLine.slice(parentLine.indexOf(':') + 1).trim();
      if (rest !== '' && !rest.startsWith('#')) {
        return {
          kind: 'parse-error',
          message: `${path} has ${parentName} as a scalar, flow mapping or alias; refusing to guess an edit span.`,
          remedy: `Convert ${parentName} to a block mapping in ${path}, then run this reporter again.`,
        };
      }
    }
    const entryLine = lines.find((line) => new RegExp(`^\\s+${key}\\s*:\\s*(.*)$`).test(line));
    if (entryLine) {
      const rest = entryLine.slice(entryLine.indexOf(':') + 1).trim();
      if (rest !== '' && !rest.startsWith('#') && !rest.startsWith('"') && !rest.startsWith("'")) {
        return {
          kind: 'parse-error',
          message: `${path} has ${target.keyLabel.replace('<name>', name)} as a scalar, flow mapping or alias; refusing to guess an edit span.`,
          remedy: `Convert that entry to a block mapping in ${path}, then run this reporter again.`,
        };
      }
    }
  }
  if (['json', 'jsonc', 'json5'].includes(target.format)) {
    const occurrences = text.match(new RegExp(`"${key}"\\s*:`, 'g')) ?? [];
    if (occurrences.length > 1) {
      return {
        kind: 'parse-error',
        message: `${path} contains more than one "${name}" key; refusing to choose one.`,
        remedy: `Remove the duplicate key from ${path}, then run this reporter again.`,
      };
    }
  }
  return null;
}

export function classifyEntry(entry, { shim, harness, name }) {
  if (!isPlainObject(entry)) return { present: false, owned: false, foreign: true };
  const rawCommand = entry.command;
  const rawArgs = Array.isArray(rawCommand)
    ? rawCommand.slice(1)
    : Array.isArray(entry.args)
      ? entry.args
      : [];
  const decoded = rawArgs.map(norm);
  const wanted = norm(shim);
  const present = decoded.includes(wanted);
  const owned = present && decoded.includes(harness) && decoded.includes(name);
  return { present, owned, foreign: !owned };
}

export function sanitizeEntry(entry) {
  if (!isPlainObject(entry)) return entry ?? null;
  const result = { ...entry };
  for (const field of ['env', 'environment']) {
    if (!isPlainObject(result[field])) continue;
    const cleaned = {};
    for (const [key, value] of Object.entries(result[field])) {
      cleaned[key] = isSecretKeyField(key) ? redact(key, value) : value;
    }
    result[field] = cleaned;
  }
  return result;
}

function isSecretKeyField(key) {
  return SECRET_FIELDS.has(key) || /LICENSE|LICENCE|PROXY_SERVER|TOKEN|PASSWORD/i.test(key);
}

export async function inspectConfig(target, name, dataRoot) {
  const base = {
    parse: 'missing',
    status: 'absent',
    entry: null,
    present: false,
    owned: false,
    message: null,
    text: null,
  };
  let text;
  try {
    text = await readTextFile(target.path, 'config file');
  } catch (error) {
    if (error instanceof SabmError) {
      return { ...base, parse: 'refused', status: error.kind, message: error.message };
    }
    throw error;
  }
  if (text === null) return base;
  const withText = { ...base, text };
  try {
    const document = parseText(target.format, text);
    const refusal = structuralRefusal(target, text, name);
    if (refusal) throw new SabmError('refused', refusal.kind, refusal.message, refusal.remedy);
    const parent = getPathValue(document, target.parent);
    if (parent.found && !isPlainObject(parent.value)) {
      throw new SabmError(
        'refused',
        'parse-error',
        `${target.path} has a non-object parent at ${target.parent.join('.')}; refusing to guess an edit span.`,
        `Convert ${target.parent.join('.')} in ${target.path} to an object or mapping, then try again.`,
      );
    }
    const rawEntry = parent.found ? parent.value[name] : undefined;
    if (rawEntry === undefined)
      return { ...withText, parse: 'ok', status: 'absent', message: 'entry not present' };
    const classification = classifyEntry(rawEntry, {
      shim: shimPath(dataRoot),
      harness: target.harness,
      name,
    });
    const status = classification.owned ? 'present-ours' : 'foreign';
    const message = classification.owned
      ? 'entry points at this data root shim'
      : `entry "${name}" in ${target.path} is not owned by this data root`;
    return {
      ...withText,
      parse: 'ok',
      status,
      entry: sanitizeEntry(rawEntry),
      present: classification.present,
      owned: classification.owned,
      message,
    };
  } catch (error) {
    if (error instanceof SabmError) {
      const parse = error.kind === 'parse-error' ? 'error' : 'refused';
      const status = error.kind === 'parse-error' ? 'unparseable' : error.kind;
      return { ...withText, parse, status, message: error.message };
    }
    return {
      ...withText,
      parse: 'error',
      status: 'unparseable',
      message: `${target.path} does not parse as ${target.format}; the file was not changed.`,
    };
  }
}

export function detectEol(text) {
  return typeof text === 'string' && text.includes('\r\n') ? '\r\n' : '\n';
}

export function detectIndent(text, parent = []) {
  const last = parent.at(-1) ?? '';
  const pattern = new RegExp(
    `^([ \\t]*)(?:"${escapeRegExp(last)}"|'${escapeRegExp(last)}'|${escapeRegExp(last)})\\s*(?::|=)`,
  );
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match) return match[1] || '  ';
  }
  return '  ';
}

function applyIndent(block, unit) {
  if (unit === '  ') return block;
  return block
    .split('\n')
    .map((line) => {
      const spaces = line.match(/^ */)?.[0].length ?? 0;
      return unit.repeat(Math.floor(spaces / 2)) + line.slice(spaces);
    })
    .join('\n');
}

export function snippetFor(target, options = {}) {
  const name = options.name ?? 'cloakbrowser';
  const dataRoot = options.dataRoot;
  const harness = target.harness;
  const eol = options.eol ?? '\n';
  const unit = options.indent ?? '  ';
  const shim = shimPath(dataRoot);
  const q = (value) => JSON.stringify(String(value));
  const arr = (values) => `[${values.map(q).join(', ')}]`;
  const args = arr([shim, '--harness', harness, '--entry', name]);
  const root = q(dataRoot);
  const file = target.path ?? '(config file)';
  const header =
    target.format === 'toml' || target.format === 'yaml'
      ? `# ${target.label} — ${file}\n# format: ${target.format}`
      : `// ${target.label} — ${file}\n// format: ${target.format}`;
  let block;
  if (target.format === 'toml') {
    const tableName = /^[A-Za-z0-9_-]+$/.test(name) ? name : q(name);
    block = [
      `[mcp_servers.${tableName}]`,
      'command = "node"',
      `args = ${arr([shim, '--harness', harness, '--entry', name])}`,
      'startup_timeout_sec = 60',
      '',
      `[mcp_servers.${tableName}.env]`,
      `STEALTH_DATA_DIR = ${root}`,
    ].join('\n');
  } else if (target.format === 'json') {
    block = [
      `"mcpServers": {`,
      `  ${q(name)}: {`,
      `    "command": "node",`,
      `    "args": ${args},`,
      `    "env": { "STEALTH_DATA_DIR": ${root} },`,
      `    "timeoutSeconds": 600`,
      `  }`,
      `}`,
    ].join('\n');
  } else if (target.format === 'jsonc') {
    block = [
      '"mcp": {',
      '  "servers": {',
      `    ${q(name)}: {`,
      '      "type": "local",',
      `      "command": ${arr(['node', shim, '--harness', harness, '--entry', name])},`,
      `      "environment": { "STEALTH_DATA_DIR": ${root} }`,
      '    }',
      '  }',
      '}',
    ].join('\n');
  } else if (target.format === 'json5') {
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : q(name);
    block = [
      'mcp: {',
      '  servers: {',
      `    ${key}: {`,
      '      command: "node",',
      `      args: ${args},`,
      `      env: { STEALTH_DATA_DIR: ${root} }`,
      '    }',
      '  }',
      '}',
    ].join('\n');
  } else {
    block = [
      'mcp_servers:',
      `  ${name}:`,
      '    command: "node"',
      `    args: ${args}`,
      '    env:',
      `      STEALTH_DATA_DIR: ${root}`,
    ].join('\n');
  }
  const body = applyIndent(block, unit);
  return options.header === false ? body.split('\n').join(eol) : `${header}\n${body}`.split('\n').join(eol);
}
