import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SabmError, success } from './envelope.mjs';
import { allTargets, getHarness, resolveTarget } from './harnesses.mjs';
import { detectEol, detectIndent, inspectConfig, snippetFor } from './parsers.mjs';
import { modeState, resolveDataRoot, stamp, treeSize } from './paths.mjs';
import { effectiveSettings, loadSchema } from './schema.mjs';

const ENGINE_IDS = ['cloak', 'playwright', 'camoufox', 'camoufox-native', 'kameleo'];
const LOCK_NAMES = new Set(['lockfile', 'parent.lock', '.parentlock', 'SingletonLock', 'SingletonCookie']);
const D0_NOTICE =
  'Claude Code plugin-management installs are configured only through /plugin -> Configure. The npm/npx path is disjoint; no values are written by this reporter.';

function harnessList(value) {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value : [value];
}

async function scanLocks(profilesPath) {
  const found = [];
  async function walk(current, depth) {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && LOCK_NAMES.has(entry.name)) found.push(full.slice(profilesPath.length + 1));
    }
  }
  await walk(profilesPath, 0);
  return found;
}

export async function listResult(options, context) {
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
  const size = options.dataSize ? await treeSize(root.path) : null;
  return success('list', {
    harnesses: rows,
    dataRoot: root.path,
    dataRootSource: root.source,
    dataSize: size,
    dataSizeNote: options.dataSize
      ? size
        ? 'read-only recursive size; symlinks skipped'
        : 'data root absent; no size reported and nothing created'
      : 'not requested',
  });
}

export function printList(result, io) {
  const header = ['HARNESS', 'SCOPE', 'CONFIG PATH', 'PATH SOURCE', 'FORMAT', 'ENTRY', 'STATUS'];
  const widths = [13, 8, 40, 14, 8, 32, 16];
  io.stdout.write(
    `${header
      .map((cell, index) => cell.padEnd(widths[index]))
      .join('')
      .trimEnd()}\n`,
  );
  for (const row of result.harnesses) {
    const cells = [
      row.harness,
      row.scope,
      row.path ?? '(none — refused or plugin-managed)',
      row.pathSource,
      row.format,
      row.entry ? (typeof row.entry === 'string' ? row.entry : JSON.stringify(row.entry)) : '(absent)',
      row.status,
    ];
    io.stdout.write(
      `${cells
        .map((cell, index) => String(cell).padEnd(widths[index]))
        .join('')
        .trimEnd()}\n`,
    );
    if (row.message && ['refused-windows', 'plugin-managed', 'foreign', 'unparseable'].includes(row.status)) {
      io.stdout.write(`  ${row.harness}/${row.scope}: ${row.message}\n`);
    }
  }
  io.stdout.write(`Data root: ${result.dataRoot} (${result.dataRootSource})\n`);
  io.stdout.write(
    `Data size: ${result.dataSize ? `${result.dataSize.bytes} bytes in ${result.dataSize.files} files` : result.dataSizeNote}\n`,
  );
}

export async function doctorResult(options, context) {
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
        details: { path: target.path, keyPath: target.keyLabel },
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
  const mode = await modeState(root.path);
  checks.push({
    name: 'data-root',
    status: !mode.exists ? 'skip' : mode.writableByMode ? 'ok' : 'warning',
    message: `exists: ${mode.exists ? 'yes' : 'no'}; mode check only — not probed${mode.exists && !mode.writableByMode ? '; no write bits set' : ''}.`,
    details: { path: root.path, ...mode },
  });
  try {
    const locks = await scanLocks(join(root.path, 'profiles'));
    checks.push({
      name: 'profile-lock',
      status: locks.length > 0 ? 'warning' : 'ok',
      message:
        locks.length > 0
          ? `Found ${locks.length} lock descriptor(s), read-only and not changed: ${locks.join(', ')}.`
          : 'No profile lock descriptors found (read-only scan).',
      details: { locks },
    });
  } catch (error) {
    checks.push({
      name: 'profile-lock',
      status: 'warning',
      message: `Lock scan failed: ${error.message}`,
      details: {},
    });
  }
  checks.push({
    name: 'shim-current-json',
    status: 'skip',
    message: 'Phase 0 ships no shim or current.json; nothing to compare.',
    details: {},
  });
  checks.push({
    name: 'engine-tree',
    status: 'skip',
    message: 'Phase 0 ships no engine bundle; bundle hashes arrive in Phase 1.',
    details: {},
  });
  checks.push({
    name: 'settings-types',
    status: 'skip',
    message: 'Settings documents are broker-owned (items 51/52); Phase 0 does not read them.',
    details: {},
  });
  return {
    payload: success('doctor', {
      checks,
      dataRoot: root.path,
      dataRootSource: root.source,
      staticOnly: true,
    }),
    hasError: checks.some((check) => check.status === 'error'),
  };
}

const STATUS_LABEL = { ok: 'OK', warning: 'WARN', error: 'ERROR', skip: 'SKIP' };

export function printDoctor(result, io) {
  for (const check of result.checks) {
    io.stdout.write(`${STATUS_LABEL[check.status]}  ${check.name} — ${check.message}\n`);
  }
  io.stdout.write(`Data root: ${result.dataRoot} (${result.dataRootSource}); static checks only.\n`);
}

export async function configureResult(options, context) {
  const schema = await loadSchema(options, context);
  if (options.harness) getHarness(options.harness);
  const root = resolveDataRoot(options, context);
  return success('configure', {
    harness: options.harness ?? null,
    entry: options.entry ?? 'cloakbrowser',
    pluginVersion: schema.pluginVersion,
    settings: effectiveSettings(schema, context),
    legend: 'global < harnesses.<h> < entries.<e> < projects.<abs> < host environment',
    settingsDocument: 'absent (broker-owned; items 51/52)',
    dataRoot: root.path,
    dataRootSource: root.source,
    notice: options.harness === 'claude-code' ? D0_NOTICE : null,
  });
}

export function printConfigure(result, io) {
  io.stdout.write(
    `cloakbrowser · ${result.harness ?? 'all harnesses'} · ${result.entry} · settings (effective)\n`,
  );
  if (result.notice) io.stdout.write(`${result.notice}\n`);
  for (const setting of result.settings) {
    const value = setting.value === '' ? '(unset)' : String(setting.value);
    io.stdout.write(
      `  ${setting.key.padEnd(32)}${value.padEnd(20)}${setting.source.padEnd(28)}${setting.note}\n`,
    );
  }
  io.stdout.write(`Levels: ${result.legend}\n`);
  io.stdout.write(`Settings document: ${result.settingsDocument}\n`);
  io.stdout.write(`Data root: ${result.dataRoot} (${result.dataRootSource})\n`);
}

export async function installResult(options, context) {
  const harness = getHarness(options.harness);
  const engine = options.engine ?? 'cloak';
  if (!ENGINE_IDS.includes(engine)) {
    throw new SabmError(
      'usage',
      'unknown-engine',
      `Unknown engine "${engine}".`,
      `Use one of: ${ENGINE_IDS.join(', ')}.`,
    );
  }
  const scope = options.scope ?? 'user';
  const name = options.name ?? 'cloakbrowser';
  const target = await resolveTarget(harness.id, { scope, project: options.project }, context);
  if (target.refused) {
    throw new SabmError(
      'refused',
      'windows-path-unverified',
      target.message,
      'Use a documented path on macOS/Linux; Phase 3 will verify Windows paths.',
    );
  }
  const root = resolveDataRoot(options, context);
  const next = [
    'Engine tree materialisation and shim creation are Phase 1; this run writes nothing.',
    `Restart ${target.label} after an actual install so it loads the entry.`,
    'Run doctor --static after an install to verify the entry.',
  ];
  if (harness.managed) {
    return success('install', {
      dryRun: true,
      harness: harness.id,
      scope,
      entry: name,
      engine,
      changed: false,
      files: [],
      commands: [
        'claude plugin marketplace add FiredMosquito831/secret-agent-browser-mcps',
        'claude plugin install cloakbrowser@cloakbrowser-mcp',
        `printf '%s' '{"browser_engine":"${engine}"}' | claude plugin configure cloakbrowser@cloakbrowser-mcp --values-stdin`,
        'claude plugin list --json',
      ],
      warnings: [D0_NOTICE],
      next,
      dataRoot: root.path,
    });
  }
  const state = await inspectConfig(target, name, root.path);
  if (state.status === 'unparseable') {
    throw new SabmError(
      'refused',
      'parse-error',
      `${target.path} does not parse as ${target.format}; refusing to plan an edit.`,
      'Fix the file with an editor, then run this command again.',
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
  if (state.status === 'read-only-file' || state.status === 'directory') {
    throw new SabmError(
      'refused',
      state.status,
      state.message ?? `${target.path} is not a writable regular file.`,
      'Use a writable regular config file or choose a different --project path.',
    );
  }
  const keyPath = target.keyLabel.replace('<name>', name);
  const changed = state.status !== 'present-ours';
  const snippet = snippetFor(target, {
    dataRoot: root.path,
    name,
    eol: detectEol(state.text),
    indent: detectIndent(state.text, target.parent),
  });
  const warnings =
    target.pathSource === 'derived'
      ? [`${target.path} is derived from ~, not documented upstream; verify it before Phase 1 adds a writer.`]
      : [];
  return success('install', {
    dryRun: true,
    harness: harness.id,
    scope,
    entry: name,
    engine,
    changed,
    keyPath,
    files: [
      {
        path: target.path,
        action: changed ? (state.parse === 'missing' ? 'create' : 'modify') : 'noop',
        keyPath,
        snippet,
        backup: changed ? `${target.path}.sabm-backup-${stamp()}` : null,
      },
    ],
    warnings,
    next,
    dataRoot: root.path,
    dataRootSource: root.source,
    phaseNote: 'Phase 0 prints a plan only; no file is changed.',
  });
}

export function printInstall(result, io) {
  io.stdout.write(
    `Harness: ${result.harness} (${result.scope}) · entry: ${result.entry} · engine: ${result.engine}\n`,
  );
  io.stdout.write(`Dry run: true · changed: ${result.changed} · writes: 0\n`);
  for (const command of result.commands ?? []) io.stdout.write(`Command: ${command}\n`);
  for (const file of result.files) {
    io.stdout.write(`Config: ${file.path}\n`);
    io.stdout.write(`Action: ${file.action} · key path: ${file.keyPath}\n`);
    io.stdout.write(`${file.snippet}\n`);
    io.stdout.write(`Backup (Phase 1): ${file.backup ?? 'none — already current'}\n`);
  }
  for (const warning of result.warnings) io.stdout.write(`Note: ${warning}\n`);
  io.stdout.write(`Data root: ${result.dataRoot} (${result.dataRootSource ?? 'unspecified'})\n`);
  io.stdout.write(`${result.phaseNote ?? result.next[0]}\n`);
  io.stdout.write('Next:\n');
  for (const item of result.next) io.stdout.write(`  - ${item}\n`);
}

export async function printConfigSnippet(options, context, io) {
  const target = await resolveTarget(
    options.harness,
    { scope: options.scope ?? 'user', project: options.project },
    context,
  );
  if (target.refused) {
    throw new SabmError(
      'refused',
      'windows-path-unverified',
      target.message,
      'Use a documented path on macOS/Linux; Phase 3 will verify Windows paths.',
    );
  }
  const root = resolveDataRoot(options, context);
  const snippet = snippetFor(target, { dataRoot: root.path, name: options.name ?? 'cloakbrowser' });
  if (options.json) {
    printJsonEnvelope(
      io,
      success('print-config', { harness: target.harness, scope: target.scope, path: target.path, snippet }),
    );
    return;
  }
  io.stdout.write(`${snippet}\n`);
  io.stdout.write('read-only; nothing written\n');
}

function printJsonEnvelope(io, value) {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}
