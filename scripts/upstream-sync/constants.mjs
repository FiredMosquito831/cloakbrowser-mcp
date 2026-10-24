// Shared constants for the weekly upstream sync.
//
// Everything here is a fact the workflow and the local dry run must agree on.
// Version numbers never live here: they are read from the files that own them.
export const SYNC_BRANCH = 'chore/upstream-sync';
export const UPSTREAM_URL = 'https://github.com/swimmwatch/cloakbrowser-mcp.git';
export const UPSTREAM_REMOTE = 'upstream';
export const UPSTREAM_BRANCH = 'main';
export const CONFLICT_ISSUE_TITLE = 'Upstream sync conflict (swimmwatch/main)';
export const ISSUE_LABELS = Object.freeze(['upstream-sync', 'conflict']);
export const REVIEW_LABEL = 'upstream-sync: review required';
export const SYNC_ASSIGNEE = 'FiredMosquito831';
export const CLAUDE_CODE_VERSION = '2.1.310';
export const PR_TITLE = 'chore(upstream): weekly sync from swimmwatch/main';
export const SYNC_HEAD_TRAILER = 'Upstream-Sync-Head';
export const BUILD_PACKAGE = 'cloakbrowser-mcp';
export const WRAPPER_PACKAGE = 'cloakbrowser';
export const CORE_PROVISION_FILE = 'shared/core/lib/provision.mjs';
export const COMPATIBILITY_FILE = 'scripts/upstream-sync/wrapper-compatibility.json';
export const PLUGINS_ROOT = 'plugins';

// A merge that touches these paths executes on the runner or changes how the
// repository builds. They are never auto-merged, whatever the dispatch input says.
export const SENSITIVE_PATH_PREFIXES = Object.freeze(['.github/workflows/', '.github/actions/']);
export const SENSITIVE_PATH_EXACT = Object.freeze(['Dockerfile', '.github/dependabot.yml']);
export const SENSITIVE_PACKAGE_KEYS = Object.freeze(['scripts', 'workspaces', 'publishConfig']);
export const INSTALL_HOOK_KEYS = Object.freeze(['preinstall', 'install', 'postinstall']);

export const GATE_INSTALL_ARGS = Object.freeze(['ci', '--ignore-scripts']);

/**
 * The commands the in-workflow gate runs, in order.
 *
 * The list is the single source shared by the workflow and the tests. The local
 * gate on Windows cannot run it (two known symlink tests), which is why the
 * workflow runs it on ubuntu-latest.
 *
 * @param {{plugins?: string[]}} [options] Plugin directory names to validate.
 * @returns {{label: string, command: string, args: string[]}[]} Ordered commands.
 */
export function gateCommands({ plugins = [] } = {}) {
  return [
    { label: 'install dependencies', command: 'npm', args: [...GATE_INSTALL_ARGS] },
    { label: 'build', command: 'npm', args: ['run', 'build'] },
    {
      label: 'plugin core check',
      command: 'node',
      args: ['scripts/sync-plugin-core.mjs', '--check'],
    },
    { label: 'pin guard', command: 'node', args: ['scripts/upstream-sync/run.mjs', 'pins', '--check'] },
    { label: 'static checks', command: 'npm', args: ['run', 'check:static'] },
    { label: 'unit and integration tests', command: 'npm', args: ['test'] },
    { label: 'validate marketplace', command: 'claude', args: ['plugin', 'validate', '.'] },
    ...plugins.map((plugin) => ({
      label: `validate ${plugin}`,
      command: 'claude',
      args: ['plugin', 'validate', `./${PLUGINS_ROOT}/${plugin}`],
    })),
  ];
}

/**
 * npm/npx/claude are `.cmd` shims on Windows; git and node are executables.
 *
 * @param {string} command Command name.
 * @param {string} [platform] Node platform value.
 * @returns {string} A name spawnSync can execute on that platform.
 */
export function spawnableCommand(command, platform = process.platform) {
  const shimmed = new Set(['claude', 'npm', 'npx']);
  return platform === 'win32' && shimmed.has(command) ? `${command}.cmd` : command;
}
