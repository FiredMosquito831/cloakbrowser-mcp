// Human-readable printers. Every JSON envelope is produced by the command
// builders in commands.mjs; printers only render an already-computed result.
import { printJsonLine } from './envelope.mjs';
import { printConfigSnippet as originalPrintConfigSnippet } from './parsers-snippet.mjs';

export {
  installResult,
  uninstallResult,
  updateResult,
  configureResult,
  enableResult,
  disableResult,
  listResult,
  doctorResult,
} from './commands.mjs';

export const printConfigSnippet = originalPrintConfigSnippet;

const STATUS_LABEL = { ok: 'OK', warning: 'WARN', error: 'ERROR', skip: 'SKIP' };

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
  if (result.installed) {
    io.stdout.write(
      `Installed: plugin ${result.installed.pluginVersion}, CLI ${result.installed.cliVersion}, engine ${result.installed.engineVerified === true ? 'verified' : 'UNVERIFIED'}\n`,
    );
  } else {
    io.stdout.write('Installed: none (no current.json)\n');
  }
  io.stdout.write(`Documents: global=${result.documents.global}, harness=${result.documents.harness}\n`);
}

export function printDoctor(result, io) {
  for (const check of result.checks) {
    io.stdout.write(`${STATUS_LABEL[check.status] ?? check.status}  ${check.name} — ${check.message}\n`);
  }
  io.stdout.write(
    `Data root: ${result.dataRoot} (${result.dataRootSource}); ${result.staticOnly ? 'static checks only' : 'static + start checks'}\n`,
  );
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
  io.stdout.write(`Data root: ${result.dataRoot} (${result.dataRootSource ?? 'unspecified'})\n`);
  if (result.written.length) {
    io.stdout.write(`Written: ${result.written.map((item) => `${item.key}@${item.level}`).join(', ')}\n`);
  }
  if (result.precedence) {
    io.stdout.write(
      `Precedence: ${Object.keys(result.precedence.settings ?? {}).length} broker settings reported verbatim; CLI scopes are reported separately.\n`,
    );
  }
  if (result.precedenceNote) io.stdout.write(`Note: ${result.precedenceNote}\n`);
}

export function printInstall(result, io) {
  io.stdout.write(
    `Harness: ${result.harness} (${result.scope}) · entry: ${result.entry} · engine: ${result.engine}\n`,
  );
  io.stdout.write(
    `Dry run: ${result.dryRun === true} · changed: ${result.changed} · writes: ${result.writes.length}\n`,
  );
  for (const command of result.commands ?? []) io.stdout.write(`Command: ${command}\n`);
  for (const file of result.files) {
    io.stdout.write(`Config: ${file.path} · action: ${file.action} · key path: ${file.keyPath}\n`);
  }
  if (result.engineTree) {
    io.stdout.write(`Engine tree: ${result.engineTree.path} (plugin ${result.engineTree.pluginVersion})\n`);
  }
  for (const warning of result.warnings ?? []) io.stdout.write(`Note: ${warning}\n`);
  for (const notice of result.notices ?? []) io.stdout.write(`Note: ${notice}\n`);
  if (result.notice) io.stdout.write(`Note: ${result.notice}\n`);
  io.stdout.write(`Data root: ${result.dataRoot} (${result.dataRootSource ?? 'unspecified'})\n`);
  for (const item of result.next ?? []) io.stdout.write(`  - ${item}\n`);
}

export function printResult(command, result, io) {
  if (command === 'list') return printList(result, io);
  if (command === 'doctor') return printDoctor(result, io);
  if (command === 'configure') return printConfigure(result, io);
  if (command === 'install') return printInstall(result, io);
  io.stdout.write(
    `${command}: changed=${result.changed === true} · writes=${result.writes.length} · data root=${result.dataRoot ?? 'n/a'}\n`,
  );
  for (const commandText of result.commands ?? []) io.stdout.write(`Command: ${commandText}\n`);
  for (const notice of result.notices ?? []) io.stdout.write(`Note: ${notice}\n`);
  if (result.notice) io.stdout.write(`Note: ${result.notice}\n`);
  if (result.enginesRemoved?.length)
    io.stdout.write(`Removed old engines: ${result.enginesRemoved.join(', ')}\n`);
}

export function printEnvelope(io, payload) {
  printJsonLine(io, payload);
}
