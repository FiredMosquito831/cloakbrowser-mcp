// Result builders for the Phase 1 writing surface. Every command returns a
// sabm/1 success envelope; real writes are listed, dry runs and no-ops are not.
import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SabmError, success } from './envelope.mjs';
import { getHarness, resolveTarget } from './harnesses.mjs';
import { detectEol, detectIndent, inspectConfig } from './parsers.mjs';
import { resolveDataRoot, shimPath } from './paths.mjs';
import { loadSchema, effectiveSettings } from './schema.mjs';
import { parseKeyValue, validateAll, validateSettingValue } from './schema-validation.mjs';
import {
  assertDocumentKey,
  brokerPrecedence,
  cliLogicalWinner,
  scopeSettings,
  writeSettingsValues,
} from './settings-documents.mjs';
import { SETTINGS_ENV_NAMES } from '../vendor/lib/settings-precedence.mjs';
import {
  materialise,
  loadBundle,
  pruneEngines,
  readCurrent,
  readManifest,
  verifyEngineTree,
  shimFilesPresent,
  writeManifest,
  CLI_VERSION,
} from './engine.mjs';
import {
  findJsonObject,
  findTomlEntry,
  insertJsonProperty,
  jsonProperties,
  removeJsonProperty,
  removeTomlEntry,
  insertTomlEntry,
  spliceText,
} from './spans.mjs';
import { composeEnvironment } from './shim-runtime.mjs';

const ENGINE_IDS = ['cloak', 'playwright', 'camoufox', 'camoufox-native', 'kameleo'];
const D0_NOTICE =
  'Claude Code plugin-management installs are configured only through /plugin -> Configure. The npm/npx path is disjoint; no values are written by this CLI.';
const CLAUDE_COMMANDS = [
  'claude plugin marketplace add FiredMosquito831/secret-agent-browser-mcps',
  'claude plugin install cloakbrowser@cloakbrowser-mcp',
  'printf \'%s\' \'{"browser_engine":"cloak"}\' | claude plugin configure cloakbrowser@cloakbrowser-mcp --values-stdin',
  'claude plugin list --json',
];

function harnessList(value) {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value : [value];
}

function entryValue(
  target,
  { name, dataRoot, harness, eol = '\n', indent = '  ', node = 'node', disabled = false, enabled = false },
) {
  const shim = shimPath(dataRoot);
  const q = (value) => JSON.stringify(String(value));
  const env = { STEALTH_DATA_DIR: dataRoot, STEALTH_HARNESS: harness };
  if (target.format === 'toml') {
    const tableName = /^[A-Za-z0-9_-]+$/.test(name) ? name : q(name);
    const lines = [
      `[mcp_servers.${tableName}]`,
      `command = ${q(node)}`,
      `args = ${JSON.stringify([shim, '--harness', harness, '--entry', name])}`,
      'startup_timeout_sec = 60',
    ];
    if (disabled || enabled) lines.push(`enabled = ${enabled ? 'true' : 'false'}`);
    lines.push('', `[mcp_servers.${tableName}.env]`);
    for (const [key, value] of Object.entries(env)) lines.push(`${key} = ${q(value)}`);
    return lines.join(eol);
  }
  if (target.format === 'json') {
    const body = [
      `"command": ${q(node)}`,
      `"args": ${JSON.stringify([shim, '--harness', harness, '--entry', name])}`,
      `"env": ${JSON.stringify(env)}`,
      '"timeoutSeconds": 600',
    ];
    if (disabled) body.push('"disabled": true');
    if (enabled) body.push('"disabled": false');
    return `{\n${body.map((line) => `${indent}${line}`).join(',\n')}\n}`;
  }
  const body = [
    '"type": "local"',
    `"command": ${JSON.stringify([node, shim, '--harness', harness, '--entry', name])}`,
    `"environment": ${JSON.stringify(env)}`,
  ];
  if (disabled) body.push('"disabled": true');
  if (enabled) body.push('"disabled": false');
  return `{\n${body.map((line) => `${indent}${line}`).join(',\n')}\n}`;
}

function refusalsFor(state, target, name) {
  if (state.status === 'unparseable') {
    throw new SabmError(
      'refused',
      'parse-error',
      `${target.path} does not parse as ${target.format}; refusing to edit it.`,
      'Fix the file with an editor, then try again.',
    );
  }
  if (state.status === 'foreign') {
    throw new SabmError(
      'refused',
      'foreign-entry',
      `A different entry named "${name}" exists in ${target.path} at ${target.keyLabel.replace('<name>', name)}; refusing to replace it.`,
      'Choose another --name or remove the foreign entry with the harness, then try again.',
    );
  }
  if (['read-only-file', 'directory'].includes(state.status)) {
    throw new SabmError(
      'refused',
      state.status,
      state.message ?? `${target.path} is not a writable regular file.`,
      'Use a writable regular file.',
    );
  }
}

function planEdit(text, target, name, value, remove = false) {
  if (target.format === 'toml') {
    const existing = findTomlEntry(text, name);
    if (remove) {
      if (!existing) return null;
      return { ...removeTomlEntry(text, existing), action: 'remove' };
    }
    return existing
      ? { start: existing.start, end: existing.end, inserted: value, action: 'modify' }
      : { ...insertTomlEntry(text, value), action: 'create' };
  }
  const found = findJsonObject(text, target.parent);
  if (!found.found) {
    throw new Error(
      `${target.path} has no object at ${target.parent.join('.')}; refusing to guess an edit span.`,
    );
  }
  if (remove) return removeJsonProperty(text, found.objectSpan, name, target.format);
  return insertJsonProperty(text, found.objectSpan, name, value, detectIndent(text, target.parent));
}

async function entryText(target) {
  try {
    return await readFile(target.path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function writeEntry({ target, name, value, remove, dataRoot, hooks = {} }) {
  const original = await entryText(target);
  const edit = planEdit(original, target, name, value, remove);
  if (!edit) return { write: null, text: original };
  const nextText = spliceText(original, edit);
  const { atomicWriteText } = await import('./writers.mjs');
  const { parseText } = await import('./parsers.mjs');
  const write = await atomicWriteText(target.path, original || null, nextText, {
    backupRoot: dataRoot,
    hooks,
    action: edit.action,
    validate: (candidate) => Boolean(parseText(target.format, candidate)),
  });
  return { write, text: nextText };
}

function noWriteEnvelope(command, extra) {
  return success(command, { writes: [], ...extra });
}

export async function installResult(options, context) {
  const harness = getHarness(options.harness);
  const engine = options.engine ?? 'cloak';
  if (!ENGINE_IDS.includes(engine)) {
    throw Object.assign(new Error(`Unknown engine "${engine}".`), {
      code: 'usage',
      kind: 'unknown-engine',
      remedy: `Use one of: ${ENGINE_IDS.join(', ')}.`,
    });
  }
  const scope = options.scope ?? 'user';
  const name = options.name ?? 'cloakbrowser';
  const target = await resolveTarget(harness.id, { scope, project: options.project }, context);
  if (target.refused) {
    throw Object.assign(new Error(target.message), {
      code: 'refused',
      kind: 'windows-path-unverified',
      remedy: 'Use a documented path on macOS/Linux; Phase 3 will verify Windows paths.',
    });
  }
  const schema = await loadSchema(options, context);
  const settings = validateAll(schema, (options.config ?? []).map(parseKeyValue));
  const root = resolveDataRoot(options, context);
  const next = [
    `Restart ${target.label} after an install so it loads the entry.`,
    'Run doctor --static (and --start for a stub-free handshake check) to verify the entry.',
  ];
  if (harness.managed) {
    return noWriteEnvelope('install', {
      dryRun: true,
      harness: harness.id,
      scope,
      entry: name,
      engine,
      changed: false,
      files: [],
      commands: CLAUDE_COMMANDS,
      warnings: [D0_NOTICE],
      next,
      dataRoot: root.path,
    });
  }
  const state = await inspectConfig(target, name, root.path);
  refusalsFor(state, target, name);
  const text = await entryText(target);
  const value = entryValue(target, {
    name,
    dataRoot: root.path,
    harness: harness.id,
    eol: detectEol(text),
    indent: detectIndent(text, target.parent),
    node: options.node ?? 'node',
  });
  const edit = planEdit(text, target, name, value);
  const current = await readCurrent(root.path);
  // Ownership is decided solely by the shim path in the entry. A matching
  // entry is a no-op even before current.json exists (Phase 0 entries point at
  // the same stable shim).
  const alreadyCurrent =
    state.status === 'present-ours' && (!current || current.pluginVersion === schema.pluginVersion);
  const changed = !alreadyCurrent;
  let bundle = null;
  if (!options.dryRun && !alreadyCurrent) {
    bundle = await loadBundle(options, context);
  } else if (options.dryRun) {
    try {
      bundle = await loadBundle(options, context);
    } catch {
      bundle = null;
    }
  }
  const writes = [];
  if (!options.dryRun && !alreadyCurrent && bundle) {
    const materialised = await materialise({ dataRoot: root.path, bundle, hooks: options.hooks });
    writes.push(materialised.write);
    if (settings.length > 0) {
      const written = await writeSettingsValues({
        dataRoot: root.path,
        harness: harness.id,
        level: 'entry',
        values: settings,
        entry: name,
        hooks: options.hooks,
      });
      writes.push(written.write);
    }
    const manifest = await writeManifest(
      root.path,
      [`${harness.id}:${scope}:${name}`],
      [bundle.pluginVersion],
      options.hooks,
    );
    writes.push(manifest.write);
    const written = await writeEntry({
      target,
      name,
      value,
      remove: false,
      dataRoot: root.path,
      hooks: options.hooks,
    });
    if (written.write) writes.push(written.write);
  }
  return success('install', {
    dryRun: Boolean(options.dryRun),
    harness: harness.id,
    scope,
    entry: name,
    engine,
    changed: Boolean(changed),
    files: [
      {
        path: target.path,
        action: alreadyCurrent ? 'noop' : state.parse === 'missing' ? 'create' : 'modify',
        keyPath: target.keyLabel.replace('<name>', name),
        backup: null,
      },
    ],
    engineTree: bundle
      ? {
          id: engine,
          pluginVersion: bundle.pluginVersion,
          path: join(root.path, 'engine', bundle.pluginVersion),
        }
      : null,
    settingsWritten: settings,
    warnings:
      target.pathSource === 'derived' ? [`${target.path} is derived from ~, not documented upstream.`] : [],
    next,
    dataRoot: root.path,
    dataRootSource: root.source,
    writes,
  });
}

export async function uninstallResult(options, context) {
  const harness = getHarness(options.harness);
  const scope = options.scope ?? 'user';
  const name = options.name ?? 'cloakbrowser';
  const target = await resolveTarget(harness.id, { scope, project: options.project }, context);
  if (target.refused) {
    throw Object.assign(new Error(target.message), {
      code: 'refused',
      kind: 'windows-path-unverified',
      remedy: 'Use a documented path on macOS/Linux.',
    });
  }
  const root = resolveDataRoot(options, context);
  if (harness.managed) {
    return noWriteEnvelope('uninstall', {
      harness: harness.id,
      changed: false,
      commands: [
        'claude plugin remove cloakbrowser@cloakbrowser-mcp',
        'claude plugin marketplace remove FiredMosquito831/secret-agent-browser-mcps',
      ],
      notice: D0_NOTICE,
      dataRoot: root.path,
    });
  }
  const state = await inspectConfig(target, name, root.path);
  if (state.status === 'absent' && !options.force) {
    return noWriteEnvelope('uninstall', {
      harness: harness.id,
      entry: name,
      changed: false,
      dataRoot: root.path,
    });
  }
  // --force never takes a foreign entry: ownership is the shim path only, and
  // user-authored config text is never deleted.
  if (state.status !== 'absent' && !state.owned) {
    refusalsFor(state, target, name);
    throw Object.assign(
      new Error(`Entry "${name}" in ${target.path} is not owned by this data root; refusing to remove it.`),
      {
        code: 'refused',
        kind: 'foreign-entry',
        remedy: 'Remove the foreign entry with the harness, then run this command again.',
      },
    );
  }
  const writes = [];
  if (!options.dryRun) {
    const removed = await writeEntry({
      target,
      name,
      value: null,
      remove: true,
      dataRoot: root.path,
      hooks: options.hooks,
    });
    if (removed.write) writes.push(removed.write);
    if (options.force) {
      const manifest = await readManifest(root.path);
      const { atomicWriteText } = await import('./writers.mjs');
      try {
        const text = await readFile(join(root.path, 'manifest.json'), 'utf8');
        writes.push(
          await atomicWriteText(join(root.path, 'manifest.json'), text, '', {
            backupRoot: root.path,
            hooks: options.hooks,
            action: 'remove',
            validate: (candidate) => candidate === '',
          }),
        );
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      for (const version of manifest?.engines ?? []) {
        await rm(join(root.path, 'engine', version), { recursive: true, force: true });
      }
    }
  }
  return success('uninstall', {
    dryRun: Boolean(options.dryRun),
    harness: harness.id,
    entry: name,
    changed: writes.length > 0,
    keepData: true,
    forced: Boolean(options.force),
    dataRoot: root.path,
    writes,
  });
}

export async function updateResult(options, context) {
  const root = resolveDataRoot(options, context);
  const bundle = await loadBundle(options, context);
  const installed = await readCurrent(root.path);
  const newer = installed?.pluginVersion !== bundle.pluginVersion;
  const keep = Number(options.keep ?? 2);
  if (!Number.isInteger(keep) || keep < 1) {
    throw Object.assign(new Error('--keep must be a positive integer.'), {
      code: 'usage',
      kind: 'invalid-keep',
      remedy: 'Use --keep 2.',
    });
  }
  if (options.check || options.dryRun || !newer) {
    return noWriteEnvelope('update', {
      check: Boolean(options.check),
      dryRun: Boolean(options.dryRun || !newer),
      current: installed,
      available: { cliVersion: CLI_VERSION, pluginVersion: bundle.pluginVersion },
      changed: false,
      dataRoot: root.path,
    });
  }
  const writes = [];
  const materialised = await materialise({ dataRoot: root.path, bundle, hooks: options.hooks });
  writes.push(materialised.write);
  const manifest = await readManifest(root.path);
  const updated = await writeManifest(
    root.path,
    manifest?.entries ?? [],
    [bundle.pluginVersion, ...(manifest?.engines ?? [])],
    options.hooks,
  );
  writes.push(updated.write);
  const removed = await pruneEngines(root.path, keep);
  return success('update', {
    check: false,
    dryRun: false,
    changed: true,
    current: materialised.current,
    verification: materialised.verification,
    enginesRemoved: removed,
    retained: 'profiles, runtimes, venvs and caches are never deleted',
    dataRoot: root.path,
    writes,
  });
}

export async function enableResult(options, context, enabled) {
  const command = enabled ? 'enable' : 'disable';
  const harness = getHarness(options.harness);
  const scope = options.scope ?? 'user';
  const name = options.name ?? 'cloakbrowser';
  const target = await resolveTarget(harness.id, { scope, project: options.project }, context);
  if (target.refused) {
    throw Object.assign(new Error(target.message), {
      code: 'refused',
      kind: 'windows-path-unverified',
      remedy: 'Use a documented path on macOS/Linux.',
    });
  }
  const root = resolveDataRoot(options, context);
  if (harness.managed) {
    return noWriteEnvelope(command, {
      harness: harness.id,
      changed: false,
      commands: [`claude plugin ${command} cloakbrowser@cloakbrowser-mcp`],
      notice: D0_NOTICE,
      dataRoot: root.path,
    });
  }
  const state = await inspectConfig(target, name, root.path);
  refusalsFor(state, target, name);
  if (state.status === 'absent') {
    throw Object.assign(new Error(`No entry "${name}" in ${target.path}; install it first.`), {
      code: 'refused',
      kind: 'entry-absent',
      remedy: `Run 'sabm install ${harness.id}' first.`,
    });
  }
  const original = await entryText(target);
  const entry = state.entry ?? {};
  const already = target.format === 'toml' ? entry.enabled === enabled : Boolean(entry.disabled) === !enabled;
  const writes = [];
  if (!already && !options.dryRun) {
    const value = entryValue(target, {
      name,
      dataRoot: root.path,
      harness: harness.id,
      eol: detectEol(original),
      indent: detectIndent(original, target.parent),
      disabled: !enabled,
      enabled,
    });
    const written = await writeEntry({
      target,
      name,
      value,
      remove: false,
      dataRoot: root.path,
      hooks: options.hooks,
    });
    if (written.write) writes.push(written.write);
  }
  return success(command, {
    dryRun: Boolean(options.dryRun),
    harness: harness.id,
    entry: name,
    changed: writes.length > 0,
    enabled,
    dataRoot: root.path,
    writes,
  });
}

async function gatedPrecedence(options, context, root, harness) {
  const schema = await loadSchema(options, context);
  const { readSettingsDocuments } = await import('../vendor/lib/settings-precedence.mjs');
  const level = (await import('../vendor/lib/settings-precedence.mjs')).resolveSettingsLevel(
    context.env,
    () => {},
  );
  const read = readSettingsDocuments({
    env: context.env,
    dataDir: root.path,
    harnessId: harness,
    settingsLevel: level.value,
  });
  let documents = read.documents;
  if (!read.enabled) documents = { global: null, harness: null };
  const result = await brokerPrecedence({
    env: context.env,
    dataRoot: root.path,
    harness,
    settingsLevel: level,
  });
  return { schema, level, documents, result };
}

export async function configureResult(options, context) {
  const schema = await loadSchema(options, context);
  const root = resolveDataRoot(options, context);
  const harness = options.harness ?? null;
  if (harness) getHarness(harness);
  const name = options.entry ?? 'cloakbrowser';
  const project = options.project ? resolve(context.cwd, options.project) : context.cwd;
  const notices = harness === 'claude-code' ? [D0_NOTICE] : [];
  if (harness === 'claude-code') {
    return noWriteEnvelope('configure', {
      harness,
      entry: name,
      settings: effectiveSettings(schema, context),
      legend: 'global < harnesses.<h> < entries.<e> < projects.<abs> < host environment',
      settingsDocument: 'absent (broker-owned; items 51/52)',
      dataRoot: root.path,
      dataRootSource: root.source,
      notice: D0_NOTICE,
      notices,
      written: [],
    });
  }
  const values = (options.set ?? [])
    .map(parseKeyValue)
    .concat((options.unset ?? []).map((key) => ({ key, value: '' })));
  const normalized = [];
  if (harness && values.length > 0) {
    for (const pair of values) {
      const validated = pair.value === '' ? null : validateSettingValue(schema, pair.key, pair.value);
      if (validated === null) assertDocumentKey(pair.key);
      normalized.push({ key: pair.key, value: validated ? validated.value : null });
    }
  }
  const writes = [];
  const written = [];
  if (harness && normalized.length > 0 && !options.dryRun) {
    const level = options.level ?? 'harness';
    const result = await writeSettingsValues({
      dataRoot: root.path,
      harness,
      level,
      values: normalized,
      entry: name,
      project,
      hooks: options.hooks,
    });
    writes.push(result.write);
    for (const item of normalized) written.push({ key: item.key, level, value: item.value });
  }
  const gated = await gatedPrecedence(options, context, root, harness);
  const payload = {
    harness,
    entry: name,
    pluginVersion: schema.pluginVersion,
    settings: effectiveSettings(schema, context),
    legend: 'global < harnesses.<h> < entries.<e> < projects.<abs> < host environment',
    settingsDocument:
      ['present', 'invalid'].includes(gated.documents.global?.state) ||
      ['present', 'invalid'].includes(gated.documents.harness?.state)
        ? 'present (broker-owned)'
        : 'absent (broker-owned; items 51/52)',
    dataRoot: root.path,
    dataRootSource: root.source,
    notice: harness === 'claude-code' ? D0_NOTICE : null,
    notices,
    written,
    settingsLevel: gated.level,
    cliLogicalWinner: Object.keys(SETTINGS_ENV_NAMES).map((key) =>
      cliLogicalWinner(gated.documents, {
        key,
        entry: name,
        project,
        env: context.env,
        envName: SETTINGS_ENV_NAMES[key],
      }),
    ),
    writes,
  };
  if (gated.result.enabled) {
    // Broker-owned output, copied verbatim from the vendored module.
    payload.precedence = gated.result.precedence;
    payload.precedenceNote = gated.result.precedenceNote;
  }
  if (options.printEnv) {
    const composed = await composeEnvironment({
      dataRoot: root.path,
      harness: harness ?? 'claude-code',
      entry: name,
      env: context.env,
      cwd: context.cwd,
    });
    payload.environment = composed.env;
    payload.engine = composed.current?.pluginVersion ?? null;
  }
  return success('configure', payload);
}

export async function listResult(options, context) {
  const { allTargets } = await import('./harnesses.mjs');
  const { treeSize } = await import('./paths.mjs');
  const root = resolveDataRoot(options, context);
  const targets = await allTargets({ harness: harnessList(options.harness), scope: options.scope }, context);
  const rows = [];
  for (const target of targets) {
    if (target.managed) {
      rows.push({
        harness: target.harness,
        scope: target.scope,
        path: null,
        pathSource: target.pathSource,
        format: 'n/a',
        keyPath: target.keyLabel,
        entry: 'plugin-managed (claude plugin)',
        present: false,
        owned: false,
        parse: 'n/a',
        status: 'plugin-managed',
        message: 'Read-only: run `claude plugin list --json` to inspect plugin installs.',
      });
      continue;
    }
    if (target.refused) {
      rows.push({
        harness: target.harness,
        scope: target.scope,
        path: null,
        pathSource: target.pathSource,
        format: target.format,
        keyPath: target.keyLabel,
        entry: null,
        present: false,
        owned: false,
        parse: 'refused',
        status: 'refused-windows',
        message: target.message,
      });
      continue;
    }
    const state = await inspectConfig(target, options.name ?? 'cloakbrowser', root.path);
    rows.push({
      harness: target.harness,
      scope: target.scope,
      path: target.path,
      pathSource: target.pathSource,
      format: target.format,
      keyPath: target.keyLabel.replace('<name>', options.name ?? 'cloakbrowser'),
      entry: state.entry,
      present: state.present,
      owned: state.owned,
      parse: state.parse,
      status: state.status,
      message: state.message,
    });
  }
  const current = await readCurrent(root.path);
  const bundle = await loadBundle(options, context).catch(() => null);
  const verification =
    current && bundle && current.pluginVersion === bundle.pluginVersion
      ? await verifyEngineTree(join(root.path, 'engine', current.pluginVersion), bundle.files)
      : null;
  let documents = { global: 'not-read', harness: 'not-read' };
  if (context.env.STEALTH_DATA_DIR !== undefined) {
    const read = (await import('../vendor/lib/settings-precedence.mjs')).readSettingsDocuments({
      env: context.env,
      dataDir: root.path,
      harnessId: 'codex',
    });
    documents = {
      global: read.documents.global?.state ?? 'missing',
      harness: read.documents.harness?.state ?? 'missing',
    };
  }
  const size = options.dataSize ? await treeSize(root.path) : null;
  return noWriteEnvelope('list', {
    harnesses: rows,
    dataRoot: root.path,
    dataRootSource: root.source,
    dataSize: size,
    dataSizeNote: options.dataSize
      ? size
        ? 'read-only recursive size; symlinks skipped'
        : 'data root absent; no size reported and nothing created'
      : 'not requested',
    installed: current
      ? {
          cliVersion: current.cliVersion,
          pluginVersion: current.pluginVersion,
          enginePath: join(root.path, 'engine', current.pluginVersion),
          engineVerified: verification?.ok ?? null,
          shim: await shimFilesPresent(root.path),
        }
      : null,
    documents,
  });
}

export async function doctorResult(options, context) {
  const doctorHarness = Array.isArray(options.harness) ? options.harness[0] : (options.harness ?? 'codex');
  const { allTargets } = await import('./harnesses.mjs');
  const { startCheck } = await import('./doctor.mjs');
  const { scanLocksForDoctor } = await import('./doctor-static.mjs');
  const checks = [];
  try {
    const schema = await loadSchema(options, context);
    checks.push({
      name: 'schema',
      status: 'ok',
      message: `Read cloakbrowser schema from ${schema.from}: ${schema.settings.length} userConfig options, ${schema.fixed.length} fixed env pins.`,
      details: { from: schema.from, options: schema.settings.length, pins: schema.fixed.length },
    });
  } catch (error) {
    checks.push({ name: 'schema', status: 'warning', message: error.message, details: {} });
  }
  const root = resolveDataRoot(options, context);
  const targets = await allTargets({ harness: harnessList(options.harness), scope: options.scope }, context);
  for (const target of targets) {
    const suffix = `${target.harness} (${target.scope})`;
    if (target.refused) {
      checks.push({
        name: `config ${suffix}`,
        status: 'skip',
        message: `refused-windows: ${target.message}`,
        details: {},
      });
      continue;
    }
    if (target.managed) {
      checks.push({
        name: `config ${suffix}`,
        status: 'skip',
        message: 'plugin-managed; inspect with `claude plugin list --json`.',
        details: {},
      });
      continue;
    }
    const state = await inspectConfig(target, options.name ?? 'cloakbrowser', root.path);
    const configStatus = state.parse === 'missing' ? 'warning' : state.parse === 'ok' ? 'ok' : 'error';
    checks.push({
      name: `config ${suffix}`,
      status: configStatus,
      message:
        state.parse === 'missing'
          ? `${target.path} is absent; nothing was created.`
          : state.parse === 'ok'
            ? `${target.path} parses as ${target.format}.`
            : (state.message ?? `${target.path} could not be validated.`),
      details: { path: target.path, pathSource: target.pathSource, parse: state.parse },
    });
    if (configStatus !== 'ok') {
      checks.push({
        name: `entry ${suffix}`,
        status: 'skip',
        message: 'config not readable; entry not checked.',
        details: {},
      });
    } else if (state.status === 'present-ours') {
      checks.push({
        name: `entry ${suffix}`,
        status: 'ok',
        message: `Entry points at ${root.path}/bin/run.mjs.`,
        details: {},
      });
    } else if (state.status === 'foreign') {
      checks.push({
        name: `entry ${suffix}`,
        status: 'error',
        message: `A foreign entry named "${options.name ?? 'cloakbrowser'}" exists in ${target.path}.`,
        details: { path: target.path },
      });
    } else {
      checks.push({
        name: `entry ${suffix}`,
        status: 'warning',
        message: `Entry absent from ${target.path}.`,
        details: {},
      });
    }
  }
  const current = await readCurrent(root.path);
  const shim = await shimFilesPresent(root.path);
  checks.push({
    name: 'shim-current-json',
    status: !current ? 'skip' : Object.values(shim).every(Boolean) ? 'ok' : 'error',
    message: !current
      ? 'No current.json; nothing was created.'
      : `current.json names plugin ${current.pluginVersion} (cli ${current.cliVersion}); shim files ${Object.values(shim).every(Boolean) ? 'present' : 'incomplete'}.`,
    details: { current, shim },
  });
  let bundle = null;
  try {
    bundle = await loadBundle(options, context);
  } catch {
    bundle = null;
  }
  const verification =
    current && bundle
      ? await verifyEngineTree(join(root.path, 'engine', current.pluginVersion), bundle.files)
      : null;
  checks.push({
    name: 'engine-tree',
    status: !verification || verification.total === 0 ? 'skip' : verification.ok ? 'ok' : 'error',
    message: !verification
      ? 'No installed engine tree to verify.'
      : verification.total === 0
        ? 'No bundle hashes available (--from tree); engine tree not hash-verified.'
        : `${verification.checked}/${verification.total} hashed files match bundle.json${verification.problems.length ? `; ${verification.problems.slice(0, 3).join('; ')}` : ''}.`,
    details: { verification },
  });
  const gates = await gatedPrecedence(options, context, root, doctorHarness);
  checks.push({
    name: 'settings-types',
    status: !gates.result.enabled ? 'skip' : 'ok',
    message: !gates.result.enabled
      ? 'Settings documents are gated: no STEALTH_DATA_DIR or explicit settings_level; nothing was probed.'
      : `Documents parsed; ${Object.keys(gates.documents.global?.settings ?? {}).length + Object.keys(gates.documents.harness?.settings ?? {}).length} broker setting(s) accepted.`,
    details: {
      documents: {
        global: gates.documents.global?.state ?? 'not-applicable',
        harness: gates.documents.harness?.state ?? 'not-applicable',
      },
    },
  });
  const { modeState } = await import('./paths.mjs');
  const mode = await modeState(root.path);
  checks.push({
    name: 'data-root',
    status: !mode.exists ? 'skip' : mode.writableByMode ? 'ok' : 'warning',
    message: `exists: ${mode.exists ? 'yes' : 'no'}; mode check only — not probed${mode.exists && !mode.writableByMode ? '; no write bits set' : ''}.`,
    details: { path: root.path, ...mode },
  });
  checks.push(...(await scanLocksForDoctor(root.path)));
  let start = null;
  if (options.start) {
    if (!current) {
      checks.push({
        name: 'start-handshake',
        status: 'error',
        message: 'Nothing is installed; run install before doctor --start.',
        details: {},
      });
    } else {
      start = await startCheck({
        dataRoot: root.path,
        harness: doctorHarness,
        entry: options.name ?? 'cloakbrowser',
        timeout: Number(options.timeout ?? 45000),
        env: context.env,
      });
      checks.push(...start.checks);
    }
  }
  const payload = success('doctor', {
    checks,
    dataRoot: root.path,
    dataRootSource: root.source,
    staticOnly: !options.start,
    started: Boolean(options.start),
  });
  if (gates.result.enabled) {
    payload.precedence = gates.result.precedence;
    payload.precedenceNote = gates.result.precedenceNote;
  }
  return { payload, hasError: checks.some((check) => check.status === 'error') };
}

export async function disableResult(options, context) {
  return enableResult(options, context, false);
}

export { D0_NOTICE, CLAUDE_COMMANDS };
