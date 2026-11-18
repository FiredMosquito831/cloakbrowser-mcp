// Writers and readers for the two broker-owned settings documents. The CLI
// never invents a third store and never writes a settings_level userConfig key.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SabmError } from './envelope.mjs';
import { parseText } from './parsers.mjs';
import {
  findJsonObject,
  insertJsonProperty,
  jsonProperties,
  removeJsonProperty,
  spliceText,
} from './spans.mjs';
import { atomicWriteText } from './writers.mjs';
import {
  CREDENTIAL_SETTINGS_KEYS,
  DOCUMENT_SETTINGS_KEYS,
  EXCLUDED_DOCUMENT_KEYS,
  SETTINGS_DOCUMENT_LIMIT_BYTES,
  SETTINGS_LEVEL_ENV,
  SETTINGS_ENV_NAMES,
  readSettingsDocuments,
  resolveLayeredSettings,
  resolveSettingsLevel,
  settingsDocumentPath,
  settingsPrecedenceReport,
} from '../vendor/lib/settings-precedence.mjs';

export {
  CREDENTIAL_SETTINGS_KEYS,
  DOCUMENT_SETTINGS_KEYS,
  EXCLUDED_DOCUMENT_KEYS,
  SETTINGS_DOCUMENT_LIMIT_BYTES,
  SETTINGS_LEVEL_ENV,
  SETTINGS_ENV_NAMES,
  readSettingsDocuments,
  resolveLayeredSettings,
  resolveSettingsLevel,
  settingsDocumentPath,
  settingsPrecedenceReport,
};

export function assertDocumentKey(key) {
  if (DOCUMENT_SETTINGS_KEYS.includes(key)) return;
  const sessionOnly =
    EXCLUDED_DOCUMENT_KEYS.includes(key) || key === SETTINGS_LEVEL_ENV || key === 'settings_level';
  throw new SabmError(
    'refused',
    sessionOnly ? 'session-only-key' : 'unknown-setting',
    sessionOnly
      ? `"${key}" is session-only and cannot be stored in a broker settings document.`
      : `Unknown setting "${key}".`,
    `Use one of: ${DOCUMENT_SETTINGS_KEYS.join(', ')}.`,
  );
}

export function assertStringValue(key, value) {
  if (typeof value !== 'string') {
    throw new SabmError(
      'refused',
      'invalid-type',
      `"${key}" must be a single-line string in a settings document.`,
      'Quote the value and keep it on one line.',
    );
  }
  if (/\r|\n/.test(value)) {
    throw new SabmError('refused', 'invalid-type', `"${key}" must not contain a newline.`, 'Use one line.');
  }
}

export function documentForLevel(dataRoot, harness, level, entry, project) {
  if (level === 'global') return { path: settingsDocumentPath(dataRoot, 'global'), keyPath: ['settings'] };
  if (level === 'harness') {
    return { path: settingsDocumentPath(dataRoot, 'harness', harness), keyPath: ['settings'] };
  }
  if (level === 'entry') {
    if (!entry) {
      throw new SabmError('usage', 'missing-entry', '--level entry needs --entry <name>.', 'Pass --entry.');
    }
    return {
      path: settingsDocumentPath(dataRoot, 'harness', harness),
      keyPath: ['scopes', 'entries', entry, 'settings'],
    };
  }
  if (level === 'project') {
    if (!project) {
      throw new SabmError(
        'usage',
        'missing-project',
        '--level project needs a project path.',
        'Pass --project.',
      );
    }
    return {
      path: settingsDocumentPath(dataRoot, 'harness', harness),
      keyPath: ['scopes', 'projects', resolve(project), 'settings'],
    };
  }
  throw new SabmError(
    'usage',
    'unknown-level',
    `Unknown level "${level}".`,
    'Use global, harness, entry or project.',
  );
}

export function scopeSettings(document, entry, project) {
  const scopes = document?.settings && typeof document.settings === 'object' ? document : {};
  const entryValues = scopes.scopes?.entries?.[entry]?.settings ?? {};
  const projectValues = project ? (scopes.scopes?.projects?.[resolve(project)]?.settings ?? {}) : {};
  return { ...entryValues, ...projectValues };
}

function nestedValue(keys, index, leaf) {
  if (index === keys.length - 1) return `${JSON.stringify(keys[index])}: ${leaf}`;
  return `${JSON.stringify(keys[index])}: {\n    ${nestedValue(keys, index + 1, leaf)}\n  }`;
}

function validateDocumentText(text, path) {
  let parsed;
  try {
    parsed = parseText('json', text);
  } catch {
    throw new SabmError(
      'refused',
      'parse-error',
      `${path} is not valid JSON; refusing to edit it.`,
      'Fix the document with an editor, then try again.',
    );
  }
  if (
    !parsed ||
    parsed.version !== 1 ||
    typeof parsed.settings !== 'object' ||
    Array.isArray(parsed.settings)
  ) {
    throw new SabmError(
      'refused',
      'invalid-document',
      `${path} must be an object with version 1 and a settings object.`,
      'Fix the document with an editor, then try again.',
    );
  }
  if (Buffer.byteLength(text, 'utf8') > SETTINGS_DOCUMENT_LIMIT_BYTES) {
    throw new SabmError(
      'refused',
      'document-too-large',
      `${path} exceeds the 64 KB document limit.`,
      'Remove settings from the document, then try again.',
    );
  }
  return parsed;
}

export async function readDocument(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { path, text: null, parsed: null };
    throw new SabmError(
      'refused',
      'parse-error',
      `Cannot read ${path}: ${error?.code ?? error.message}.`,
      'Check the path and permissions.',
    );
  }
  return { path, text, parsed: validateDocumentText(text, path) };
}

function spliceDocumentValue(text, keyPath, key, value) {
  // keyPath is the parent object path (settings, or a scopes.entries/project
  // settings object). The setting key itself is the property we splice.
  const parentPath = keyPath;
  let target = findJsonObject(text ?? '', parentPath);
  if (!target.found && !target.objectSpan) {
    throw new SabmError(
      'refused',
      'invalid-document',
      'The settings document root is not an object.',
      'Fix the document with an editor.',
    );
  }
  if (!target.found && target.nonObject) {
    throw new SabmError(
      'refused',
      'invalid-document',
      `The settings path ${parentPath.join('.')} is not an object.`,
      'Fix the document with an editor.',
    );
  }
  let working = text;
  if (!target.found) {
    const missing = parentPath.slice(target.missingAt);
    const leaf = nestedValue([...missing, key], 0, JSON.stringify(value));
    const parent = target.objectSpan;
    const properties = jsonProperties(working, parent);
    const last = properties.at(-1);
    const at = last ? (last.commaAfter ?? last.valueEnd) : parent.innerStart;
    const prefix = last && last.commaAfter === null ? ',' : '';
    const inserted = `${prefix}\n  ${leaf}`;
    working = spliceText(working, { start: at, end: at, inserted });
    target = findJsonObject(working, parentPath);
  }
  const edit =
    value === null
      ? removeJsonProperty(working, target.objectSpan, key)
      : insertJsonProperty(working, target.objectSpan, key, JSON.stringify(value), '  ');
  if (!edit) return working;
  return spliceText(working, edit);
}

// One command writes exactly one broker document, atomically. All values at
// one logical level are spliced in memory first, then written once.
export async function writeSettingsValues({ dataRoot, harness, level, values, entry, project, hooks = {} }) {
  for (const item of values) {
    assertDocumentKey(item.key);
    if (item.value !== null) assertStringValue(item.key, item.value);
  }
  const target = documentForLevel(dataRoot, harness, level, entry, project);
  const current = await readDocument(target.path);
  const original = current.text ?? '{\n  "version": 1,\n  "settings": {}\n}\n';
  let next = original;
  for (const item of values) {
    next = spliceDocumentValue(next, target.keyPath, item.key, item.value);
  }
  validateDocumentText(next, target.path);
  const write = await atomicWriteText(target.path, current.text, next, {
    backupRoot: dataRoot,
    hooks,
    action:
      current.text === null
        ? 'create'
        : values.some((item) => item.value === null)
          ? 'remove-setting'
          : 'set-setting',
    label: 'settings document',
    validate: (candidate, path) => Boolean(validateDocumentText(candidate, path)),
  });
  return {
    write,
    path: target.path,
    keyPaths: values.map((item) => [...target.keyPath, item.key]),
    values,
  };
}

export async function writeSettingsValue({ key, value, ...options }) {
  const result = await writeSettingsValues({ ...options, values: [{ key, value }] });
  return { write: result.write, path: result.path, keyPath: result.keyPaths[0], value };
}

// Gated broker read: the four additive keys appear only when the broker would
// actually probe documents. Every nested value is copied verbatim from the
// vendored module, never recomputed by the CLI.
export async function brokerPrecedence({ env, dataRoot, harness, settingsLevel, log = () => {} }) {
  const documents = readSettingsDocuments({
    env,
    dataDir: dataRoot,
    harnessId: harness,
    settingsLevel: settingsLevel?.value ?? 'auto',
    log,
  });
  const layered = resolveLayeredSettings({
    env,
    documents: documents.documents,
    settingsLevel: settingsLevel?.value ?? 'auto',
    dataRootEnabled: documents.enabled,
    log,
  });
  const precedence = documents.enabled
    ? settingsPrecedenceReport({}, { ...layered, documents: documents.documents, settingsLevel })
    : null;
  return {
    enabled: documents.enabled,
    documents: documents.documents,
    layered,
    precedence,
    precedenceNote: documents.enabled ? layered.note : null,
  };
}

// A separately named field keeps CLI scope winners out of the broker's
// level/source vocabulary (env|session|harness|global|default).
export function cliLogicalWinner(documents, { key, entry, project, env, envName }) {
  const scopes = {
    global: undefined,
    harness: undefined,
    entry: undefined,
    project: undefined,
  };
  for (const [level, document] of [
    ['global', documents?.global],
    ['harness', documents?.harness],
  ]) {
    const value = document?.settings?.[key];
    if (typeof value === 'string' && value !== '') scopes[level] = value;
  }
  const scoped = scopeSettings(documents?.harness, entry, project);
  if (typeof scoped[key] === 'string' && scoped[key] !== '') scopes.entry = scoped[key];
  if (typeof scoped[key] === 'string' && scoped[key] !== '') scopes.project = scoped[key];
  if (envName && typeof env?.[envName] === 'string' && env[envName] !== '')
    return { key, level: 'host', source: 'env' };
  for (const level of ['project', 'entry', 'harness', 'global']) {
    if (scopes[level] !== undefined) return { key, level, source: 'document' };
  }
  return { key, level: 'default', source: 'default' };
}
