#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir as systemHomedir } from 'node:os';
import { Command, CommanderError } from 'commander';
import { errorEnvelope, exitCodeFor, failure, printJsonLine } from './envelope.mjs';
import { makeContext } from './paths.mjs';
import { doctorResult, printConfigSnippet, printDoctor, printResult } from './report.mjs';
import { CLI_VERSION } from './engine.mjs';
import {
  installResult,
  uninstallResult,
  updateResult,
  configureResult,
  enableResult,
  disableResult,
  listResult,
} from './commands.mjs';

export const VERSION_TEXT = `secret-agent-browser-mcps ${CLI_VERSION} (Phase 1 writers; plugin tree bundled)`;

function collect(value, previous) {
  return [...previous, value];
}

function addCommon(command) {
  command.option('--json', 'print one sabm/1 JSON line on stdout');
  command.option('--data-root <path>', 'data root (beats every environment value)');
  command.option('--from <dir>', 'plugin tree or bundled engine that supplies the schema');
  return command;
}

function addScope(command) {
  command.option('-s, --scope <scope>', 'user or project (default: user)');
  command.option('--name <entry>', 'entry name (default: cloakbrowser)');
  command.option('--project <path>', 'project directory for project scope');
  return command;
}

export async function main(argv = process.argv.slice(2), io) {
  const output = io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    platform: process.platform,
    homedir: systemHomedir(),
    cwd: process.cwd(),
  };
  const context = makeContext(output);
  let commandName = 'cli';
  let ranSubcommand = false;
  let resultCode = 0;

  if (argv.includes('--version') || argv.includes('-V')) {
    output.stdout.write(`${VERSION_TEXT}\n`);
    return 0;
  }

  const program = new Command();
  program
    .name('secret-agent-browser-mcps')
    .description('Install, configure and remove secret-agent-browser MCP harness entries.')
    .exitOverride();
  program.configureOutput({
    writeOut: (text) => output.stdout.write(text),
    writeErr: (text) => output.stderr.write(text),
  });
  program.option('--print-config <harness>', 'print the config snippet for one harness');
  program.option('--scope <scope>', 'user or project (default: user)');
  program.option('--name <entry>', 'entry name (default: cloakbrowser)');
  addCommon(program);
  program.action(() => {});

  const run = async (name, options, builder, printer) => {
    const opts = { ...program.opts(), ...options };
    commandName = name;
    ranSubcommand = true;
    const payload = await builder(opts, context);
    if (opts.json) printJsonLine(output, payload);
    else printer(payload, output);
    resultCode = 0;
    return 0;
  };

  addCommon(
    program
      .command('list')
      .description('Show harness config paths, entry status and install state.')
      .option('--harness <name>', 'limit to one harness (repeatable)', collect, [])
      .option('--scope <scope>', 'limit to user or project')
      .option('--data-size', 'measure the data root read-only'),
  ).action(async (options) => run('list', options, listResult, printResultFor('list')));

  addCommon(
    program
      .command('doctor [harness]')
      .description('Static checks and an optional MCP start handshake.')
      .option('--static', 'static, read-only checks')
      .option('--start', 'spawn the installed entry and perform an MCP handshake')
      .option('--browser', 'reserved for a later phase (refused here)')
      .option('--timeout <ms>', 'budget for --start (default: 45000)')
      .option('--harness <name>', 'limit to one harness (repeatable)', collect, [])
      .option('--scope <scope>', 'limit to user or project'),
  ).action(async (harness, options) => {
    if (harness) options.harness = [harness];
    if (options.browser) {
      commandName = 'doctor';
      throw Object.assign(
        new Error('doctor --browser is a later phase; this command never launches a browser.'),
        {
          code: 'refused',
          kind: 'unsupported-option',
          remedy: 'Use doctor --static or doctor --start (MCP handshake only).',
        },
      );
    }
    commandName = 'doctor';
    ranSubcommand = true;
    const opts = { ...program.opts(), ...options };
    const result = await doctorResult(opts, context);
    if (result.hasError) {
      const failed = result.payload.checks.filter((check) => check.status === 'error').length;
      printJsonLine(
        output,
        failure({
          command: 'doctor',
          code: 'verification_failed',
          kind: 'doctor-error',
          message: `${failed} doctor check(s) failed.`,
          remedy: 'Fix the reported errors, then run doctor --static again.',
          checks: result.payload.checks,
        }),
      );
      resultCode = 3;
      return 3;
    }
    if (opts.json) printJsonLine(output, result.payload);
    else printDoctor(result.payload, output);
    return 0;
  });

  addCommon(
    program
      .command('configure [harness]')
      .description('Show or write broker-owned settings for one harness.')
      .option('--show', 'show effective settings (default with no write flags)')
      .option('--harness <name>', 'limit the report to one harness')
      .option('--set <key=value>', 'set one value (repeatable)', collect, [])
      .option('--unset <key>', 'remove one value at this level (repeatable)', collect, [])
      .option('--values-stdin', 'read a JSON object of values from stdin')
      .option('--level <level>', 'global, harness, entry or project (default: harness)')
      .option('--entry <name>', 'entry name for --level entry')
      .option('--project <path>', 'project path for --level project')
      .option('--print-env', 'print the environment the shim builds'),
  ).action(async (harness, options) => {
    const opts = { ...options, harness: harness ?? options.harness };
    if (opts.valuesStdin) {
      const text = await readFile(0, 'utf8').catch(() => '');
      if (text.trim() !== '') {
        const values = JSON.parse(text);
        for (const [key, value] of Object.entries(values)) {
          opts.set = [...(opts.set ?? []), `${key}=${value}`];
        }
      }
    }
    return run('configure', opts, configureResult, printResultFor('configure'));
  });

  const install = addCommon(
    addScope(
      program
        .command('install <harness>')
        .description('Write this product entry into a harness config.')
        .option('--engine <id>', 'engine id (default: cloak)')
        .option('--config <key=value>', 'document-settable setting (repeatable)', collect, [])
        .option('--node <path>', 'node executable recorded in the entry (default: node)')
        .option('--dry-run', 'print the plan and write nothing'),
    ),
  );
  install.alias('add');
  install.action(async (harness, options) =>
    run('install', { ...options, harness }, installResult, printResultFor('install')),
  );

  const uninstall = addCommon(
    addScope(
      program
        .command('uninstall <harness>')
        .description('Remove only this product entry.')
        .option('--force', 'remove only this CLI’s own entries, manifest and tracked engine trees')
        .option('--keep-data', 'keep the data root (always the default in Phase 1)')
        .option('--purge', 'reserved for a later phase (refused here)')
        .option('--dry-run', 'print the plan and write nothing'),
    ),
  );
  uninstall.action(async (harness, options) => {
    if (options.purge) {
      commandName = 'uninstall';
      throw Object.assign(
        new Error('uninstall --purge is a later phase; no data root deletion is performed.'),
        {
          code: 'refused',
          kind: 'unsupported-option',
          remedy: 'Use --force for CLI-owned artefacts, or --keep-data (the default).',
        },
      );
    }
    return run('uninstall', { ...options, harness }, uninstallResult, printResultFor('uninstall'));
  });
  uninstall.alias('remove');

  const update = addCommon(
    program
      .command('update [harness]')
      .description('Materialise the newest bundled engine; harness configs are untouched.')
      .option('--check', 'report the available version without writing')
      .option('--keep <n>', 'engine generations to keep (default: 2)')
      .option('--dry-run', 'print the plan and write nothing'),
  );
  update.action(async (harness, options) =>
    run('update', { ...options, harness: harness ?? null }, updateResult, printResultFor('update')),
  );

  for (const [name, builder] of [
    ['enable', enableResult],
    ['disable', disableResult],
  ]) {
    addCommon(
      addScope(
        program
          .command(`${name} <harness>`)
          .description(`${name[0].toUpperCase()}${name.slice(1)} this product entry.`)
          .option('--dry-run', 'print the plan and write nothing'),
      ),
    ).action(async (harness, options) =>
      run(
        name,
        { ...options, harness },
        (opts, ctx) => builder(opts, ctx, name === 'enable'),
        printResultFor(name),
      ),
    );
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
    const globalOptions = program.opts();
    if (!ranSubcommand && globalOptions.printConfig) {
      commandName = 'print-config';
      await printConfigSnippet(
        {
          harness: globalOptions.printConfig,
          scope: globalOptions.scope,
          name: globalOptions.name,
          dataRoot: globalOptions.dataRoot,
          from: globalOptions.from,
          json: globalOptions.json,
        },
        context,
        output,
      );
    }
    return resultCode;
  } catch (error) {
    if (
      error instanceof CommanderError &&
      ['commander.helpDisplayed', 'commander.help', 'commander.version'].includes(error.code)
    ) {
      return 0;
    }
    const envelope = errorEnvelope(error, commandName);
    printJsonLine(output, envelope);
    return exitCodeFor(envelope);
  }
}

function printResultFor(name) {
  return (result, io) => printResult(name, result, io);
}

const here = new URL(import.meta.url);
if (process.argv[1] && here.href === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error?.message ?? error}\n`);
      process.exitCode = 1;
    });
}
