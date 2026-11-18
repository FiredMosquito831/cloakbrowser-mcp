#!/usr/bin/env node
import { homedir as systemHomedir } from 'node:os';
import { Command, CommanderError } from 'commander';
import { errorEnvelope, exitCodeFor, failure, printJsonLine } from './envelope.mjs';
import { makeContext } from './paths.mjs';
import {
  configureResult,
  doctorResult,
  installResult,
  listResult,
  printConfigure,
  printDoctor,
  printInstall,
  printList,
  printConfigSnippet,
} from './report.mjs';

export const VERSION_TEXT = 'secret-agent-browser-mcps 1.0.0 (Phase 0 reporter; plugin tree not bundled)';

function collect(value, previous) {
  return [...previous, value];
}

function addCommon(command) {
  command.option('--json', 'print one sabm/1 JSON line on stdout');
  command.option('--data-root <path>', 'data root (beats every environment value)');
  command.option('--from <dir>', 'cloakbrowser plugin tree that supplies the schema');
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
    .description('Read-only Phase 0 reporter for secret-agent-browser MCP installs.')
    .exitOverride();
  program.configureOutput({
    writeOut: (text) => output.stdout.write(text),
    writeErr: (text) => output.stderr.write(text),
  });
  program.option('--print-config <harness>', 'print the config snippet for one harness');
  program.option('--scope <scope>', 'user or project (default: user)');
  program.option('--name <entry>', 'entry name (default: cloakbrowser)');
  addCommon(program);
  // A program-level action keeps Commander from printing help when only
  // top-level options (such as --print-config) are supplied.
  program.action(() => {});

  const run = async (name, options, builder, printer) => {
    // Commander 15 routes an option declared on both the program and a subcommand
    // to the program. Merge both sets so either placement works.
    const opts = { ...program.opts(), ...options };
    commandName = name;
    ranSubcommand = true;
    const result = await builder(opts, context);
    const payload = result.payload ?? result;
    if (name === 'doctor' && result.hasError) {
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
    if (opts.json) printJsonLine(output, payload);
    else printer(payload, output);
    resultCode = 0;
    return 0;
  };

  addCommon(
    program
      .command('list')
      .description('Show harness config paths, entry status and parse status.')
      .option('--harness <name>', 'limit to one harness (repeatable)', collect, [])
      .option('--scope <scope>', 'limit to user or project')
      .option('--data-size', 'measure the data root read-only'),
  ).action(async (options) => run('list', options, listResult, printList));

  addCommon(
    program
      .command('doctor')
      .description('Run static, read-only checks (no server, browser or provisioning).')
      .option('--static', 'static checks only (the only Phase 0 mode)')
      .option('--harness <name>', 'limit to one harness (repeatable)', collect, [])
      .option('--scope <scope>', 'limit to user or project'),
  ).action(async (options) => {
    if (options.start || options.browser) {
      throw new Error('--start and --browser are future phases; Phase 0 supports only --static.');
    }
    return run('doctor', options, doctorResult, printDoctor);
  });

  addCommon(
    program
      .command('configure')
      .description('Show effective userConfig defaults and their sources.')
      .option('--show', 'show effective settings (the only Phase 0 mode)')
      .option('--harness <name>', 'limit the notice to one harness')
      .option('--entry <name>', 'entry name for the report'),
  ).action(async (options) => run('configure', options, configureResult, printConfigure));

  addCommon(
    program
      .command('install <harness>')
      .description('Print an install plan without changing anything.')
      .option('-s, --scope <scope>', 'user or project (default: user)')
      .option('--name <entry>', 'entry name (default: cloakbrowser)')
      .option('--engine <id>', 'engine id (default: cloak)')
      .option('--project <path>', 'project directory for project scope')
      .option('--dry-run', 'print the plan and write nothing (the only Phase 0 mode)'),
  ).action(async (harness, options) => run('install', { ...options, harness }, installResult, printInstall));

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
