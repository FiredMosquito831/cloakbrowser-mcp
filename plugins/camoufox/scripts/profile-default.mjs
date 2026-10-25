#!/usr/bin/env node
// Read or set the default-profile pointer for one engine, safely and without a
// shell.
//
// The pointer is one line in <plugin data>/profiles/<engine>/.default that names
// the profile a broker start uses when neither profile_dir nor account is set.
// The broker reads it at start; this tool is what you run before Claude Code
// starts, and the broker's browser_profiles meta-tool does the same from inside a
// session. A change always applies at the NEXT server start: no browser is
// started, stopped or reconfigured here.
//
// The write is atomic (a sibling temporary file renamed over the pointer) and
// only ever creates its own directory and that one file. It never creates,
// renames, copies or deletes a profile; a name that does not exist yet gets its
// directory on the next launch, exactly like an account. Names follow the same
// rule as the broker and scripts/profile-copy.mjs. The file's contents are a
// profile name, never a secret, and every path is printed.
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_ENGINE,
  loadEngineConfiguration,
  manifestProfileApplies,
  resolveLauncherName,
} from '../engine-registry.mjs';
import {
  accountNameError,
  profileDefaultPointerDir,
  readProfileDefaultPointer,
  validateAccountName,
  writeProfileDefaultPointer,
} from '../lib/profile.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.dirname(path.dirname(SCRIPT_PATH));
const LOG_PREFIX = '[profile-default]';

export const DEFAULT_POINTER_ENGINE = DEFAULT_ENGINE;
export const FALLBACK_DATA_DIR_NAME = '.cloakbrowser-mcp-plugin';

const USAGE = `Usage: node scripts/profile-default.mjs [--show | --set <name>] [options]

Read or set the default-profile pointer: one line in
<plugin data>/profiles/<engine>/.default naming the profile a broker start uses
when neither "Profile directory" (profile_dir) nor "Account profile" (account) is
set. Precedence at start: profile_dir, account, this pointer, the workspace
profile, the engine default. The change applies at the NEXT server start; it
never starts, stops or reconfigures a browser.

Options:
  --show             Report the pointer and its target (the default action).
  --engine <id>      Engine whose pointer is read or set (default: ${DEFAULT_POINTER_ENGINE}).
                     Any engine whose manifest has profileApplies true.
  --set <name>       Write this profile name to the pointer. "default" means the
                     engine default; any other new name gets its profile
                     directory on the next launch, like an account.
  --data-dir <path>  Plugin data root (default: CLAUDE_PLUGIN_DATA, otherwise
                     ~/${FALLBACK_DATA_DIR_NAME}).
  --dry-run          Validate and report what would be written; write nothing.
  --json             Print one machine-readable JSON object.
  --help             Show this help and exit 0.

Names use the plugin's account rule: letters, digits, ".", "_" and "-", starting
with a letter or digit, up to 64 characters, no trailing dot, no Windows device
name.

Where the plugin data root is: inside a Claude Code process the variable
CLAUDE_PLUGIN_DATA names it. A terminal normally does not have that variable, so
pass --data-dir explicitly. For an installed plugin on Windows:
  cloakbrowser plugin: %USERPROFILE%\\.claude\\plugins\\data\\cloakbrowser-cloakbrowser-mcp
  camoufox plugin:     %USERPROFILE%\\.claude\\plugins\\data\\camoufox-cloakbrowser-mcp
On POSIX the same directories live under ~/.claude/plugins/data/<plugin>-<marketplace>.
The fallback when nothing is set is ~/${FALLBACK_DATA_DIR_NAME}, which is NOT where an
installed plugin keeps its profiles; browser_capabilities.profileDir names the
real directory, two levels up from the profile.

Exit codes: 0 read or written, 1 refused or failed, 2 usage error.
`;

export class ProfileDefaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfileDefaultError';
    this.code = code;
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function resolveDataDir(explicit, env, home) {
  if (nonEmptyString(explicit)) {
    return path.resolve(explicit.trim());
  }
  if (nonEmptyString(env?.CLAUDE_PLUGIN_DATA)) {
    return path.resolve(env.CLAUDE_PLUGIN_DATA.trim());
  }
  return path.join(home, FALLBACK_DATA_DIR_NAME);
}

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// The engine must exist and own a broker profile; every other engine declares
// profileApplies: false and has no pointer to read or write.
function resolveEngine({ engine, pluginRoot }) {
  const engineId = nonEmptyString(engine) ? engine.trim() : DEFAULT_POINTER_ENGINE;
  const configuration = loadEngineConfiguration({
    enginesDir: path.join(pluginRoot, 'engines'),
    profilesFile: path.join(pluginRoot, 'engines', 'profiles.json'),
    engineId,
    launcherDir: pluginRoot,
  });
  if (configuration.error !== null) {
    throw new ProfileDefaultError('unknown-engine', configuration.error);
  }
  if (!manifestProfileApplies(configuration.engine)) {
    throw new ProfileDefaultError(
      'engine-no-profiles',
      `The "${engineId}" engine does not use broker profiles (profileApplies: false), so it has no default profile.`,
    );
  }
  return {
    engineId,
    launcherName: resolveLauncherName(configuration.engine),
    label: configuration.engine.label ?? null,
  };
}

// The pointer facts, with the directory its name maps to. A broken pointer is
// reported, never thrown: reading it always succeeds.
function pointerReport(engineId, dataRoot, launcherName) {
  const pointer = readProfileDefaultPointer(engineId, dataRoot);
  const targetDir =
    pointer.name === null ? null : profileDefaultPointerDir(engineId, dataRoot, pointer.name, launcherName);
  return {
    path: pointer.path,
    exists: pointer.exists,
    name: pointer.name,
    state: pointer.state,
    error: pointer.error,
    targetDir,
    targetExists: targetDir === null ? null : isDirectory(targetDir),
  };
}

/**
 * Read or write the default-profile pointer.
 *
 * @param {object} options Options.
 * @param {string} [options.engine] Engine id; defaults to cloak.
 * @param {string|null} [options.set] Profile name to write, or null to read.
 * @param {string|null} [options.dataDir] Plugin data root, or null for the default.
 * @param {boolean} [options.dryRun] Validate and report without writing.
 * @param {object} [options.env] Environment to read CLAUDE_PLUGIN_DATA from.
 * @param {string} [options.home] Home directory for the fallback data root.
 * @param {string} [options.pluginRoot] Plugin root, for tests.
 * @returns {{ok: true, summary: object} | {ok: false, error: {code: string, message: string}}}
 */
export function runProfileDefault({
  engine = DEFAULT_POINTER_ENGINE,
  set = null,
  dataDir = null,
  dryRun = false,
  env = process.env,
  home = homedir(),
  pluginRoot = PLUGIN_ROOT,
} = {}) {
  try {
    const summary = run({ engine, set, dataDir, dryRun, env, home, pluginRoot });
    return { ok: true, summary };
  } catch (error) {
    if (error instanceof ProfileDefaultError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    return {
      ok: false,
      error: {
        code: 'failed',
        message: `The profile default tool failed: ${error?.message ?? String(error)}`,
      },
    };
  }
}

function run({ engine, set, dataDir, dryRun, env, home, pluginRoot }) {
  const resolved = resolveEngine({ engine, pluginRoot });
  const dataRoot = resolveDataDir(dataDir, env, home);
  const base = {
    engine: resolved.engineId,
    label: resolved.label,
    dataDir: dataRoot,
    applies: 'next server start',
  };

  if (set === null) {
    return {
      ok: true,
      dryRun: false,
      action: 'show',
      ...base,
      pointer: pointerReport(resolved.engineId, dataRoot, resolved.launcherName),
    };
  }

  const name = typeof set === 'string' ? set.trim() : '';
  if (!validateAccountName(name)) {
    throw new ProfileDefaultError('invalid-name', `--set: ${accountNameError(set)}`);
  }
  const summary = {
    ok: true,
    dryRun,
    action: 'set-default',
    ...base,
    name,
    written: false,
  };
  if (dryRun) {
    const targetDir = profileDefaultPointerDir(resolved.engineId, dataRoot, name, resolved.launcherName);
    return {
      ...summary,
      pointer: {
        path: readProfileDefaultPointer(resolved.engineId, dataRoot).path,
        exists: null,
        name,
        state: 'planned',
        error: null,
        targetDir,
        targetExists: isDirectory(targetDir),
      },
    };
  }
  const written = writeProfileDefaultPointer(resolved.engineId, dataRoot, name);
  if (!written.written) {
    throw new ProfileDefaultError('write-failed', written.error);
  }
  return {
    ...summary,
    written: true,
    pointer: pointerReport(resolved.engineId, dataRoot, resolved.launcherName),
  };
}

export function formatHumanSummary(summary) {
  const lines = [];
  const pointer = summary.pointer;
  if (summary.action === 'show') {
    lines.push(`Default-profile pointer for engine "${summary.engine}" (${summary.label ?? 'no label'}).`);
    lines.push(`pointer: ${pointer.path}`);
    if (!pointer.exists) {
      lines.push('state: missing; no default is configured, so the engine default or the workspace applies.');
    } else if (pointer.state === 'invalid') {
      lines.push(`state: invalid; ${pointer.error}`);
    } else {
      lines.push(`state: ${pointer.name}`);
      if (pointer.targetDir !== null) {
        lines.push(
          `target: ${pointer.targetDir}${pointer.targetExists ? '' : ' (created on the next launch)'}`,
        );
      }
    }
    lines.push(
      'The pointer is applied at the next server start, when neither profile_dir nor account is set.',
    );
    return `${lines.join('\n')}\n`;
  }
  const verb = summary.dryRun ? 'Dry run: would write' : 'Wrote';
  lines.push(`${verb} "${summary.name}" as the default profile for engine "${summary.engine}".`);
  if (summary.dryRun) {
    lines.push(`pointer: ${pointer.path} (nothing was written)`);
  } else {
    lines.push(`pointer: ${pointer.path}`);
  }
  if (pointer.targetDir !== null) {
    lines.push(`target: ${pointer.targetDir}${pointer.targetExists ? '' : ' (created on the next launch)'}`);
  }
  lines.push('It applies at the next server start; this does not start, stop or reconfigure a browser.');
  return `${lines.join('\n')}\n`;
}

/**
 * Parse command-line arguments.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {{options: object, errors: string[]}} Parsed options and usage errors.
 */
export function parseArguments(argv) {
  const options = {
    engine: DEFAULT_POINTER_ENGINE,
    set: null,
    dataDir: null,
    show: false,
    dryRun: false,
    json: false,
    help: false,
  };
  const errors = [];
  const seen = new Set();
  const valueOptions = { '--engine': 'engine', '--set': 'set', '--data-dir': 'dataDir' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? null : argument.slice(equals + 1);
    if (name === '--help') {
      options.help = true;
    } else if (name === '--show') {
      options.show = true;
    } else if (name === '--dry-run') {
      options.dryRun = true;
    } else if (name === '--json') {
      options.json = true;
    } else if (Object.hasOwn(valueOptions, name)) {
      const optionName = valueOptions[name];
      if (optionName === 'set') {
        seen.add('set');
        if (options.set !== null) {
          errors.push(`${name} can be given once.`);
          continue;
        }
      }
      let value = inline;
      if (value === null) {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) {
          errors.push(`${name} needs a value.`);
          continue;
        }
        value = next;
        index += 1;
      }
      if (value === '') {
        errors.push(`${name} needs a value.`);
      } else {
        options[optionName] = value;
      }
    } else {
      errors.push(`Unknown option "${argument}".`);
    }
  }
  if (options.help) {
    return { options, errors: [] };
  }
  if (options.show && seen.has('set')) {
    errors.push('--show and --set cannot be combined.');
  }
  return { options, errors };
}

function main(argv) {
  const { options, errors } = parseArguments(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (errors.length > 0) {
    for (const error of errors) {
      process.stderr.write(`${LOG_PREFIX} ${error}\n`);
    }
    process.stderr.write(`${LOG_PREFIX} Run with --help for usage.\n`);
    process.exitCode = 2;
    return;
  }
  const result = runProfileDefault({
    engine: options.engine,
    set: options.set,
    dataDir: options.dataDir,
    dryRun: options.dryRun,
    env: process.env,
  });
  if (options.json) {
    const payload = result.ok ? result.summary : result;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (!result.ok) {
    process.stderr.write(`${LOG_PREFIX} ${result.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(formatHumanSummary(result.summary));
}

const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (invokedPath !== null && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2));
}
