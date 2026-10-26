#!/usr/bin/env node
// Copy one browser profile to a new name, safely and without a shell.
//
// A profile is the identity a browser session presents: cookies, logins, local
// storage, Chromium's Local State and Preferences, and the CloakBrowser
// fingerprint seed (.cloakbrowser-seed). Copying it lets a user branch an
// existing identity instead of signing in again from scratch. The operation is
// only safe while the source browser is closed, because a live Chromium profile
// contains locks and files in flight.
//
// This tool only ever creates its own destination directory. It never renames,
// moves, overwrites or deletes a profile; a failure removes only what this run
// created. It copies no lock (neither the bridge's nor the engine's own), no
// Chromium singleton file and no cache, so the copy starts cleanly. Names and
// paths follow lib/profile.mjs and the broker: the same account rule, the same
// profiles/<engine>/<name> layout and the same "default" mapping.
//
// A profile a live browser holds is refused before anything is copied: the
// bridge lock is read first, then the engine's own lock from the manifest's
// profileLock descriptor (Chromium's lockfile, Firefox's parent.lock), so a
// browser started by another tool is caught instead of failing mid-tree. The
// engine is the explicit --engine setting, confirmed by the resolved path, so a
// profile under another engine's folder is never copied with the wrong rules.
//
// The same plan and exclusion engine also builds the broker's
// profile_isolation "copy" session copies; --prune lists those temporary copies
// and removes only the ones no live process owns (explicit, never automatic).
//
// Output never contains a file's contents. It reports paths, counts and bytes
// only, and anything that looks like a URL credential is redacted.
import { existsSync, statSync } from 'node:fs';
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
  copyPlanToTarget,
  engineLockBlocksStart,
  engineProfileLockMessage,
  EXCLUSION_LABELS,
  EXCLUSION_RULES,
  excludedNameList,
  planCopy,
  ProfileCopyError,
  pruneSessionCopies,
  readEngineProfileLock,
  readProfileLock,
  redactSecrets,
  resolveProfile,
  validateAccountName,
} from '../lib/profile.mjs';

// The module surface the tool has always exported (tests and the old API import
// these names from here); the implementation lives in lib/profile.mjs so the
// broker's session copies use exactly the same rules.
export { copyPlanToTarget, EXCLUSION_LABELS, EXCLUSION_RULES, excludedNameList, planCopy, ProfileCopyError };
export { exclusionRule } from '../lib/profile.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.dirname(path.dirname(SCRIPT_PATH));
const LOG_PREFIX = '[profile-copy]';

export const DEFAULT_COPY_ENGINE = DEFAULT_ENGINE;
export const FALLBACK_DATA_DIR_NAME = '.cloakbrowser-mcp-plugin';

// The exclusion rules, the plan and the copy writer live in lib/profile.mjs:
// the broker's profile_isolation "copy" mode uses the same engine for its
// session copies. They are imported here and re-exported so this script keeps
// its documented module surface.
// Every *.sqlite-wal and *.sqlite-shm file is deliberately NOT matched by any
// rule: those files are part of the database, and a copy without them can lose
// the newest committed rows. No rule ends in these suffixes.
const USAGE = `Usage: node scripts/profile-copy.mjs --from <name> --to <new-name> [options]
       node scripts/profile-copy.mjs --prune [options]

Copy one browser profile to a new name. Cookies, logins, Local State,
Preferences and the fingerprint seed (.cloakbrowser-seed) are kept. The bridge
profile lock, the engine's own lock file, Chromium singleton files, caches,
temporary files and log directories are not. The source browser must be closed:
a live profile lock refuses the copy, and for Chromium that includes a browser
started on the profile by another tool.

A copy never carries session cookies: Chromium deletes its session cookies at the
next start, and Firefox keeps them in memory, not on disk. Saved cookies, logins,
localStorage and IndexedDB travel as files, so a copy on the same operating-system
user and machine stays signed in wherever those files carry the session.

Engine-specific exclusions (every engine also loses the bridge profile lock,
*.tmp entries, log directories and the shared caches):
  Chromium   lockfile, DawnGraphiteCache, DawnWebGPUCache, BrowserMetrics
  Firefox    parent.lock, cache2, startupCache, thumbnails
Every *.sqlite-wal and *.sqlite-shm file is kept: it is part of the database.

With --prune, list the temporary session copies that profile_isolation "copy" and
"copy-keep" leave under <plugin data>/profiles/<engine>/.sessions and remove the
ones no live process owns. A copy whose broker or browser is still running is
kept and reported. Pruning is explicit: the plugin never removes a session copy on
its own, and this command never touches an account profile or the engine default.
It also never removes a retained <base>.previous-<stamp> tree: profile_isolation
"copy-keep" keeps the old base there after a clean close, and those trees are
user data that stay until you remove them yourself.

Options:
  --engine <id>      Engine whose profiles are copied or pruned (default: ${DEFAULT_COPY_ENGINE}).
                     Any engine whose manifest has profileApplies true. The
                     resolved profile path must agree: if it lies under
                     profiles/<engine>/ for a different engine, the copy is
                     refused instead of guessing.
  --from <name>      Source profile: an account name or "default".
  --to <new-name>    New profile name. It must not exist; nothing is overwritten
                     and nothing is merged.
  --prune            List and remove leftover session copies; takes no --from or
                     --to.
  --data-dir <path>  Plugin data root (default: CLAUDE_PLUGIN_DATA, otherwise
                     ~/${FALLBACK_DATA_DIR_NAME}).
  --dry-run          List what would be copied or pruned; change nothing.
  --json             Print one machine-readable JSON summary object.
  --help             Show this help and exit 0.

Names use the plugin's account rule: letters, digits, ".", "_" and "-", starting
with a letter or digit, up to 64 characters, no trailing dot, no Windows device
name. "default" maps to the engine's existing default profile.

The optional per-account <name>.proxy file beside a profile is NOT copied: it is
a plaintext credential. Copy it yourself if the copy should use the same proxy.

Exit codes: 0 copied, pruned or dry run, 1 refused or failed, 2 usage error.
`;

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

function humanBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return index === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[index]}`;
}

function lockSummary(lock) {
  return {
    state: lock.state,
    owner: lock.owner === null ? null : { pid: lock.owner.pid, createdAt: lock.owner.createdAt },
  };
}

// The engine a profile directory belongs to, proven by the path. A directory
// under <data>/profiles/<engine>/ names the engine in the same layout the broker
// and this tool use; <data>/profiles/default is the legacy shared Chromium
// default and has no engine segment. Anything else — a path outside the data
// root, a first segment that is not a shipped engine id, the profiles root itself
// — returns null: the tool never guesses an engine from a path it cannot prove,
// and the explicit --engine decides. Detection therefore cannot mis-detect: it
// either names a shipped engine the layout proves or says nothing.
export function detectEngineFromProfilePath(profileDir, dataDir, engineIds) {
  if (!nonEmptyString(profileDir) || !nonEmptyString(dataDir) || !Array.isArray(engineIds)) {
    return null;
  }
  const profilesRoot = path.resolve(dataDir, 'profiles');
  const relative = path.relative(profilesRoot, path.resolve(profileDir));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  const segments = relative.split(path.sep);
  if (segments.length < 2) {
    return null;
  }
  const segment = segments[0];
  return engineIds.includes(segment) ? segment : null;
}

// The engine a copy uses: the requested setting, confirmed by the resolved path.
// A source under profiles/<engine>/ for a different engine is refused rather
// than guessed, so a name that exists under two engines can never apply the
// wrong engine's lock rule or exclusion list. Returns { engineId, source,
// error }: source is "path" when the layout proved the engine and "setting"
// otherwise (the legacy shared default).
export function resolveCopyEngine({ requestedEngine, sourceDir, dataDir, engineIds }) {
  const requested = nonEmptyString(requestedEngine) ? requestedEngine.trim() : DEFAULT_COPY_ENGINE;
  const detected = detectEngineFromProfilePath(sourceDir, dataDir, engineIds);
  if (detected !== null && detected !== requested) {
    return {
      engineId: null,
      source: null,
      error:
        `The source profile ${sourceDir} is a "${detected}" profile, but --engine is "${requested}". ` +
        `Run the copy again with --engine ${detected}, or copy the "${requested}" profile of that name.`,
    };
  }
  return { engineId: requested, source: detected === null ? 'setting' : 'path', error: null };
}

/**
 * Validate and copy one profile. Returns { ok: true, summary } or
 * { ok: false, error: { code, message } }; it never throws and never partially
 * leaves a destination behind.
 *
 * @param {object} options Copy options.
 * @param {string} [options.engine] Engine id; defaults to cloak.
 * @param {string} [options.from] Source account name or "default".
 * @param {string} [options.to] New account name.
 * @param {string|null} [options.dataDir] Plugin data root, or null for the default.
 * @param {boolean} [options.dryRun] Plan and report without copying.
 * @param {object} [options.env] Environment to read CLAUDE_PLUGIN_DATA from.
 * @param {string} [options.home] Home directory for the fallback data root.
 * @param {string} [options.pluginRoot] Plugin root, for tests.
 * @returns {{ok: true, summary: object} | {ok: false, error: {code: string, message: string}}} Result.
 */
export function runProfileCopy({
  engine = DEFAULT_COPY_ENGINE,
  from,
  to,
  dataDir = null,
  dryRun = false,
  env = process.env,
  home = homedir(),
  pluginRoot = PLUGIN_ROOT,
} = {}) {
  try {
    const summary = copyProfile({ engine, from, to, dataDir, dryRun, env, home, pluginRoot });
    return { ok: true, summary };
  } catch (error) {
    if (error instanceof ProfileCopyError) {
      return { ok: false, error: { code: error.code, message: redactSecrets(error.message) } };
    }
    return {
      ok: false,
      error: {
        code: 'copy-failed',
        message: redactSecrets(`The profile copy failed: ${error?.message ?? String(error)}`),
      },
    };
  }
}

function copyProfile({ engine, from, to, dataDir, dryRun, env, home, pluginRoot }) {
  const engineId = nonEmptyString(engine) ? engine.trim() : DEFAULT_COPY_ENGINE;
  const configuration = loadEngineConfiguration({
    enginesDir: path.join(pluginRoot, 'engines'),
    profilesFile: path.join(pluginRoot, 'engines', 'profiles.json'),
    engineId,
    launcherDir: pluginRoot,
  });
  if (configuration.error !== null) {
    throw new ProfileCopyError('unknown-engine', redactSecrets(configuration.error));
  }
  if (!manifestProfileApplies(configuration.engine)) {
    throw new ProfileCopyError(
      'engine-no-profiles',
      `The "${engineId}" engine does not use account profiles (profileApplies: false), so there is no profile to copy.`,
    );
  }
  const launcherName = resolveLauncherName(configuration.engine);

  for (const [option, value] of [
    ['--from', from],
    ['--to', to],
  ]) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!validateAccountName(name)) {
      throw new ProfileCopyError('invalid-name', `${option}: ${accountNameError(value)}`);
    }
  }
  const sourceName = from.trim();
  const targetName = to.trim();

  const dataRoot = resolveDataDir(dataDir, env, home);
  if (existsSync(dataRoot) && !statSync(dataRoot).isDirectory()) {
    throw new ProfileCopyError(
      'data-dir-invalid',
      `The plugin data root ${redactSecrets(dataRoot)} is not a directory.`,
    );
  }

  const resolve = (name) =>
    resolveProfile({
      account: name,
      engineId,
      dataDir: dataRoot,
      launcherName,
      profileApplies: true,
      isolation: 'shared',
    });
  const sourceResolution = resolve(sourceName);
  const targetResolution = resolve(targetName);
  if (sourceResolution.error !== null) {
    throw new ProfileCopyError('invalid-name', `--from: ${sourceResolution.error}`);
  }
  if (targetResolution.error !== null) {
    throw new ProfileCopyError('invalid-name', `--to: ${targetResolution.error}`);
  }
  const sourceDir = sourceResolution.profileDir;
  const targetDir = targetResolution.profileDir;
  // The engine is the requested setting, confirmed by the resolved path: a source
  // under profiles/<engine>/ for another shipped engine refuses instead of
  // guessing, so the wrong lock rule and exclusion list can never be applied.
  const resolvedEngine = resolveCopyEngine({
    requestedEngine: engineId,
    sourceDir,
    dataDir: dataRoot,
    engineIds: configuration.engineIds,
  });
  if (resolvedEngine.error !== null) {
    throw new ProfileCopyError('engine-mismatch', redactSecrets(resolvedEngine.error));
  }
  const samePath = (left, right) =>
    process.platform === 'win32'
      ? left.toLowerCase() === right.toLowerCase()
      : path.resolve(left) === path.resolve(right);
  if (samePath(sourceDir, targetDir)) {
    throw new ProfileCopyError(
      'same-profile',
      `The source and destination are the same profile (${redactSecrets(sourceDir)}). Choose a different --to name.`,
    );
  }

  let sourceStat;
  try {
    sourceStat = statSync(sourceDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ProfileCopyError(
        'source-missing',
        `The source profile "${sourceName}" does not exist: ${redactSecrets(sourceDir)}.`,
      );
    }
    throw new ProfileCopyError(
      'source-unreadable',
      `Cannot read the source profile ${redactSecrets(sourceDir)}: ${redactSecrets(error.message)}`,
    );
  }
  if (!sourceStat.isDirectory()) {
    throw new ProfileCopyError(
      'source-missing',
      `The source profile "${sourceName}" is not a directory: ${redactSecrets(sourceDir)}.`,
    );
  }

  if (existsSync(targetDir)) {
    throw new ProfileCopyError(
      'destination-exists',
      `The destination profile "${targetName}" already exists: ${redactSecrets(targetDir)}. ` +
        'Choose another name; the copy tool never overwrites or merges a profile.',
    );
  }

  const lock = readProfileLock(sourceDir);
  if (lock.state === 'live') {
    const owner = lock.owner ?? {};
    const who = owner.pid === undefined ? 'another process' : `pid ${owner.pid}`;
    const when = typeof owner.createdAt === 'string' ? `, started ${owner.createdAt}` : '';
    throw new ProfileCopyError(
      'source-locked',
      `The source profile ${redactSecrets(sourceDir)} is in use by ${who}${when}. ` +
        'Close the browser window or Claude Code session that owns it, then run the copy again. ' +
        'The profile was not copied.',
    );
  }
  if (lock.state === 'invalid') {
    throw new ProfileCopyError(
      'source-locked',
      `The source profile ${redactSecrets(sourceDir)} has a lock file that cannot be read, ` +
        'so the copy cannot prove the browser is closed. ' +
        `${lock.error === null ? '' : `${redactSecrets(lock.error)} `}` +
        'Close the browser that owns it; if no browser is running, remove the lock file. ' +
        'The profile was not copied.',
    );
  }

  // The engine's own lock file, read from the manifest's profileLock descriptor
  // with the same rule the broker's preflight uses: Chromium's lockfile proves a
  // live owner by refusing a write-open, Firefox's parent.lock by refusing a
  // read-open, a pid file by process liveness. A live owner refuses the copy with
  // the broker's own wording (profile directory, lock file, holder and fix); a
  // stale or uninterpretable file never blocks, exactly like the broker.
  const engineLockDescriptor =
    configuration.engine.profileLock === undefined ? null : configuration.engine.profileLock;
  const engineLock =
    engineLockDescriptor === null ? null : readEngineProfileLock(sourceDir, engineLockDescriptor);
  if (engineLock !== null && engineLockBlocksStart(engineLock)) {
    throw new ProfileCopyError(
      'source-locked',
      engineProfileLockMessage(engineLock, { trailing: 'The profile was not copied.' }),
    );
  }

  const engineLockFile =
    engineLockDescriptor !== null && typeof engineLockDescriptor.file === 'string'
      ? engineLockDescriptor.file
      : null;
  const plan = planCopy(sourceDir, { engineLockFile });
  const summary = {
    ok: true,
    dryRun,
    engine: engineId,
    engineSource: resolvedEngine.source,
    from: sourceName,
    to: targetName,
    sourceDir: redactSecrets(sourceDir),
    targetDir: redactSecrets(targetDir),
    copied: {
      files: plan.files.length,
      directories: plan.directories.length,
      bytes: plan.bytes,
    },
    excluded: {
      entries: Object.values(plan.excluded).reduce((total, count) => total + count, 0),
      byRule: { ...plan.excluded },
      names: excludedNameList(plan.excludedNames).map((entry) => ({
        name: entry.name,
        rule: entry.rule,
        count: entry.count,
      })),
    },
    skipped: { ...plan.skipped },
    topLevel: plan.topLevel.map((entry) => ({
      path: redactSecrets(entry.path),
      type: entry.type,
      files: entry.files,
      bytes: entry.bytes,
      excluded: entry.excluded,
    })),
    sourceLock: lockSummary(lock),
    sourceEngineLock:
      engineLock === null
        ? null
        : {
            state: engineLock.state,
            path: redactSecrets(engineLock.path),
            file: engineLock.file,
            liveness: engineLock.liveness,
            owner: engineLock.owner,
            error: engineLock.error === null ? null : redactSecrets(engineLock.error),
          },
  };
  if (dryRun) {
    return summary;
  }

  copyPlanToTarget(plan, targetDir, { targetName });
  return summary;
}

export function formatHumanSummary(summary) {
  const lines = [];
  const verb = summary.dryRun ? 'Dry run: would copy' : 'Copied';
  lines.push(`${verb} profile "${summary.from}" to "${summary.to}" (engine ${summary.engine}).`);
  lines.push(`from: ${summary.sourceDir}`);
  lines.push(`to: ${summary.targetDir}`);
  if (summary.dryRun) {
    lines.push('Top-level entries:');
    for (const entry of summary.topLevel) {
      if (entry.excluded !== null) {
        lines.push(`  ${entry.path} (excluded: ${EXCLUSION_LABELS[entry.excluded]})`);
      } else if (entry.type === 'directory') {
        lines.push(`  ${entry.path}/ (directory, ${entry.files} file(s), ${entry.bytes} bytes)`);
      } else if (entry.type === 'file') {
        lines.push(`  ${entry.path} (file, ${entry.bytes} bytes)`);
      } else {
        lines.push(`  ${entry.path} (skipped: not a regular file or directory)`);
      }
    }
  } else {
    for (const entry of summary.topLevel) {
      if (entry.excluded !== null) {
        lines.push(`  ${entry.path} (excluded: ${EXCLUSION_LABELS[entry.excluded]})`);
      }
    }
  }
  lines.push(
    `files: ${summary.copied.files} (${summary.copied.bytes} bytes, ${humanBytes(summary.copied.bytes)})`,
  );
  lines.push(`directories: ${summary.copied.directories}`);
  const rules = EXCLUSION_RULES.filter((rule) => summary.excluded.byRule[rule] > 0).map(
    (rule) => `${EXCLUSION_LABELS[rule]} ${summary.excluded.byRule[rule]}`,
  );
  lines.push(`excluded: ${summary.excluded.entries}${rules.length === 0 ? '' : ` (${rules.join(', ')})`}`);
  const names = Array.isArray(summary.excluded.names)
    ? summary.excluded.names.map((entry) => `${entry.name} ${entry.count}`)
    : [];
  lines.push(`engine-specific exclusions: ${names.length === 0 ? 'none' : names.join(', ')}`);
  lines.push(`skipped: ${summary.skipped.symlinks} symlinks, ${summary.skipped.other} other entries`);
  if (summary.sourceLock.state === 'stale') {
    const owner = summary.sourceLock.owner;
    const who = owner === null || owner.pid === undefined ? 'its owner' : `pid ${owner.pid}`;
    lines.push(`stale lock ignored: ${who} is gone; the lock file was not copied.`);
  }
  if (summary.sourceEngineLock !== null && summary.sourceEngineLock !== undefined) {
    if (summary.sourceEngineLock.state === 'stale') {
      lines.push(
        `stale engine lock ignored: nobody holds ${summary.sourceEngineLock.path}; it was not copied.`,
      );
    } else if (summary.sourceEngineLock.state === 'unknown') {
      lines.push(
        `engine lock not interpreted: ${summary.sourceEngineLock.path} was not checked ` +
          `(${summary.sourceEngineLock.error ?? 'unknown reason'}); it was not copied.`,
      );
    }
  }
  lines.push('A copy carries no session cookies (Chromium discards them, Firefox keeps them in memory).');
  lines.push('The per-account <name>.proxy file was not copied; it is a plaintext credential.');
  return `${lines.join('\n')}\n`;
}

// --- explicit session-copy prune --------------------------------------------
// profile_isolation=copy leaves a temporary copy under
// <plugin data>/profiles/<engine>/.sessions for every session it starts. A clean
// shutdown removes it; a crashed broker keeps it, because data is never lost.
// This action lists them and removes only the leftovers nobody owns. It is the
// only pruning path and it is never automatic.

function pruneEngineConfiguration({ engine, pluginRoot }) {
  const engineId = nonEmptyString(engine) ? engine.trim() : DEFAULT_COPY_ENGINE;
  const configuration = loadEngineConfiguration({
    enginesDir: path.join(pluginRoot, 'engines'),
    profilesFile: path.join(pluginRoot, 'engines', 'profiles.json'),
    engineId,
    launcherDir: pluginRoot,
  });
  if (configuration.error !== null) {
    throw new ProfileCopyError('unknown-engine', redactSecrets(configuration.error));
  }
  if (!manifestProfileApplies(configuration.engine)) {
    throw new ProfileCopyError(
      'engine-no-profiles',
      `The "${engineId}" engine does not use account profiles (profileApplies: false), so it has no session copies to prune.`,
    );
  }
  return { engineId, configuration };
}

function sessionCopySummary(copy) {
  return {
    name: copy.name,
    path: redactSecrets(copy.path),
    baseName: copy.baseName,
    startedAtLocal: copy.startedAtLocal,
    pid: copy.pid,
    state: copy.state,
    bridgeLock: copy.bridgeLock,
    engineLock: copy.engineLock,
  };
}

// List (and unless dryRun remove) the leftover session copies of one engine.
// Returns { ok: true, summary } or { ok: false, error }; it never throws and
// never touches a profile directory, only .sessions entries.
export function runSessionPrune({
  engine = DEFAULT_COPY_ENGINE,
  dataDir = null,
  dryRun = false,
  env = process.env,
  home = homedir(),
  pluginRoot = PLUGIN_ROOT,
} = {}) {
  try {
    const { engineId, configuration } = pruneEngineConfiguration({ engine, pluginRoot });
    const dataRoot = resolveDataDir(dataDir, env, home);
    if (existsSync(dataRoot) && !statSync(dataRoot).isDirectory()) {
      throw new ProfileCopyError(
        'data-dir-invalid',
        `The plugin data root ${redactSecrets(dataRoot)} is not a directory.`,
      );
    }
    const descriptor =
      configuration.engine.profileLock === undefined ? null : configuration.engine.profileLock;
    const result = pruneSessionCopies(engineId, dataRoot, {
      engineLockDescriptor: descriptor,
      dryRun,
    });
    if (result.error !== undefined) {
      throw new ProfileCopyError('sessions-unreadable', redactSecrets(result.error));
    }
    const failed = result.failed.map((copy) => ({
      ...sessionCopySummary(copy),
      error: redactSecrets(copy.error),
    }));
    return {
      ok: failed.length === 0,
      summary: {
        ok: failed.length === 0,
        dryRun,
        engine: engineId,
        sessionRoot: redactSecrets(result.root),
        copies: result.copies.map((copy) => sessionCopySummary(copy)),
        removed: result.removed.map((copy) => sessionCopySummary(copy)),
        kept: result.kept.map((copy) => sessionCopySummary(copy)),
        failed,
      },
      ...(failed.length === 0
        ? {}
        : { error: { code: 'prune-failed', message: `${failed.length} session copy removal(s) failed.` } }),
    };
  } catch (error) {
    if (error instanceof ProfileCopyError) {
      return { ok: false, error: { code: error.code, message: redactSecrets(error.message) } };
    }
    return {
      ok: false,
      error: {
        code: 'prune-failed',
        message: redactSecrets(`The session-copy prune failed: ${error?.message ?? String(error)}`),
      },
    };
  }
}

export function formatPruneSummary(summary) {
  const lines = [];
  lines.push(
    `${summary.dryRun ? 'Dry run: session copies' : 'Session copies'} for engine "${summary.engine}" under ` +
      `${summary.sessionRoot}:`,
  );
  if (summary.copies.length === 0) {
    lines.push('  (none)');
  }
  for (const copy of summary.copies) {
    lines.push(
      `  ${copy.name} (${copy.state}; base "${copy.baseName}", started ${copy.startedAtLocal} local time, ` +
        `pid ${copy.pid})`,
    );
  }
  const verb = summary.dryRun ? 'Would remove' : 'Removed';
  lines.push(
    `${verb} ${summary.removed.length} leftover session ` +
      `${summary.removed.length === 1 ? 'copy' : 'copies'}; kept ${summary.kept.length} ` +
      `${summary.kept.length === 1 ? 'copy' : 'copies'} still in use by a live process.`,
  );
  for (const failure of summary.failed) {
    lines.push(`  could not remove ${failure.path}: ${failure.error}`);
  }
  lines.push(
    'A session copy is the temporary working directory of profile_isolation "copy" or "copy-keep"; ' +
      'pruning never touches an account profile, the engine default, or a retained ' +
      '<base>.previous-<stamp> tree from copy-keep.',
  );
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
    engine: DEFAULT_COPY_ENGINE,
    from: null,
    to: null,
    dataDir: null,
    dryRun: false,
    json: false,
    prune: false,
    help: false,
  };
  const errors = [];
  const seen = new Set();
  const valueOptions = { '--engine': 'engine', '--from': 'from', '--to': 'to', '--data-dir': 'dataDir' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? null : argument.slice(equals + 1);
    if (name === '--help') {
      options.help = true;
    } else if (name === '--dry-run') {
      options.dryRun = true;
    } else if (name === '--json') {
      options.json = true;
    } else if (name === '--prune') {
      options.prune = true;
    } else if (Object.hasOwn(valueOptions, name)) {
      const optionName = valueOptions[name];
      seen.add(optionName);
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
  if (options.prune) {
    for (const [option, value] of [
      ['--from', options.from],
      ['--to', options.to],
    ]) {
      if (value !== null) {
        errors.push(`--prune cannot be combined with ${option}.`);
      }
    }
    return { options, errors };
  }
  if (options.from === null && !seen.has('from')) {
    errors.push('--from is required.');
  }
  if (options.to === null && !seen.has('to')) {
    errors.push('--to is required.');
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
  if (options.prune) {
    const pruned = runSessionPrune({
      engine: options.engine,
      dataDir: options.dataDir,
      dryRun: options.dryRun,
      env: process.env,
    });
    if (options.json) {
      const payload = pruned.summary ?? pruned;
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      process.exitCode = pruned.ok ? 0 : 1;
      return;
    }
    if (pruned.summary !== undefined) {
      process.stdout.write(formatPruneSummary(pruned.summary));
    }
    if (!pruned.ok) {
      process.stderr.write(`${LOG_PREFIX} ${pruned.error.message}\n`);
      process.exitCode = 1;
      return;
    }
    return;
  }
  const result = runProfileCopy({
    engine: options.engine,
    from: options.from,
    to: options.to,
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
