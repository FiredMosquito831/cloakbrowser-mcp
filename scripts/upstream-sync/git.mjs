// Thin, shell-free git access. Every call passes an argument array, so a path
// or ref from upstream can never become a shell word.
import { spawnSync } from 'node:child_process';

/**
 * Run git and capture its output.
 *
 * @param {string[]} args Git arguments, without the leading `git`.
 * @param {{cwd?: string, allowFailure?: boolean, maxBuffer?: number}} [options] Run options.
 * @returns {{status: number, stdout: string, stderr: string}} Captured result.
 */
export function runGit(
  args,
  { cwd = process.cwd(), allowFailure = false, maxBuffer = 64 * 1024 * 1024 } = {},
) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer });
  if (result.error !== undefined) {
    throw new Error(`git ${args.join(' ')} could not start: ${result.error.message}`);
  }
  const stdout = (result.stdout ?? '').trimEnd();
  const stderr = (result.stderr ?? '').trimEnd();
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${stderr || stdout}`);
  }
  return { status: result.status ?? 1, stdout, stderr };
}

/**
 * Resolve a ref to a commit id, or null when the ref does not exist.
 *
 * @param {string} ref Git ref or revision.
 * @param {string} cwd Repository working directory.
 * @returns {string|null} Full commit id or null.
 */
export function revParse(ref, cwd) {
  const result = runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd,
    allowFailure: true,
  });
  return result.status === 0 && result.stdout !== '' ? result.stdout : null;
}

/**
 * Count the commits selected by a revision range.
 *
 * @param {string} range Revision range such as `main..upstream/main`.
 * @param {string} cwd Repository working directory.
 * @returns {number} Commit count.
 */
export function countCommits(range, cwd) {
  return Number(runGit(['rev-list', '--count', range], { cwd }).stdout);
}

/**
 * Return the subject line of a commit.
 *
 * @param {string} ref Commit ref.
 * @param {string} cwd Repository working directory.
 * @returns {string} Subject line.
 */
export function commitSubject(ref, cwd) {
  return runGit(['log', '-1', '--format=%s', ref], { cwd }).stdout;
}

/**
 * Return the full message of a commit.
 *
 * @param {string} ref Commit ref.
 * @param {string} cwd Repository working directory.
 * @returns {string} Full commit message.
 */
export function commitMessage(ref, cwd) {
  return runGit(['log', '-1', '--format=%B', ref], { cwd }).stdout;
}

/**
 * Return the tree id of a commit.
 *
 * @param {string} ref Commit ref.
 * @param {string} cwd Repository working directory.
 * @returns {string} Tree object id.
 */
export function treeOf(ref, cwd) {
  return runGit(['rev-parse', `${ref}^{tree}`], { cwd }).stdout;
}

/**
 * Compute a hypothetical merge without touching a worktree or a ref.
 *
 * @param {{base: string, upstream: string, cwd: string}} options Merge inputs.
 * @returns {{status: number, stdout: string, stderr: string}} Raw merge-tree result.
 */
export function mergeTree({ base, upstream, cwd }) {
  return runGit(['merge-tree', '--write-tree', '--name-only', base, upstream], { cwd, allowFailure: true });
}

/**
 * List the paths that differ between two trees.
 *
 * @param {{from: string, to: string, cwd: string}} options Tree ids.
 * @returns {string[]} Repository-relative paths, sorted.
 */
export function diffNames({ from, to, cwd }) {
  const result = runGit(['diff', '--name-only', from, to], { cwd, allowFailure: true });
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort();
}

/**
 * List the paths with an unmerged index entry during a stopped merge.
 *
 * @param {string} cwd Repository working directory.
 * @returns {string[]} Conflicted paths, sorted and unique.
 */
export function listConflicts(cwd) {
  const paths = new Set();
  for (const extra of [[], ['--cached']]) {
    const result = runGit(['diff', '--name-only', '--diff-filter=U', ...extra], { cwd, allowFailure: true });
    for (const line of result.stdout.split('\n')) {
      const value = line.trim();
      if (value !== '') {
        paths.add(value);
      }
    }
  }
  return [...paths].sort();
}

/**
 * Test commit ancestry.
 *
 * @param {{ancestor: string, descendant: string, cwd: string}} options Commits to compare.
 * @returns {boolean} True when ancestor is reachable from descendant.
 */
export function isAncestor({ ancestor, descendant, cwd }) {
  return (
    runGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd, allowFailure: true }).status === 0
  );
}

/**
 * Read a file blob from a ref without checking it out.
 *
 * @param {{ref: string, file: string, cwd: string}} options Ref and path.
 * @returns {string|null} File text, or null when absent at that ref.
 */
export function fileAtRef({ ref, file, cwd }) {
  const result = runGit(['show', `${ref}:${file}`], { cwd, allowFailure: true });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Fetch a branch by URL into FETCH_HEAD, without adding a remote.
 *
 * @param {{url: string, branch: string, cwd: string}} options Fetch inputs.
 * @returns {string} The fetched commit id.
 */
export function fetchUrl({ url, branch, cwd }) {
  runGit(['fetch', '--no-tags', url, branch], { cwd });
  const head = revParse('FETCH_HEAD', cwd);
  if (head === null) {
    throw new Error(`fetching ${url} ${branch} left no FETCH_HEAD`);
  }
  return head;
}

/**
 * Add the upstream remote, or point an existing one at the canonical URL.
 *
 * @param {{name: string, url: string, cwd: string}} options Remote identity.
 * @returns {{added: boolean}} Whether the remote was created.
 */
export function ensureRemote({ name, url, cwd }) {
  const remotes = runGit(['remote'], { cwd })
    .stdout.split('\n')
    .map((line) => line.trim());
  if (remotes.includes(name)) {
    runGit(['remote', 'set-url', name, url], { cwd });
    return { added: false };
  }
  runGit(['remote', 'add', name, url], { cwd });
  return { added: true };
}

/**
 * Fetch a branch from a configured remote.
 *
 * @param {{remote: string, branch: string, cwd: string}} options Fetch inputs.
 * @returns {string} The remote-tracking commit id.
 */
export function fetchRemote({ remote, branch, cwd }) {
  runGit(['fetch', '--no-tags', remote, branch], { cwd });
  const ref = `${remote}/${branch}`;
  const head = revParse(ref, cwd);
  if (head === null) {
    throw new Error(`fetching ${ref} left no remote-tracking ref`);
  }
  return head;
}
