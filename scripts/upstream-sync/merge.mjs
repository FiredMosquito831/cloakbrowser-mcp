// Merge strategy and conflict detection.
//
// The sync merges upstream/main into a branch cut from origin/main. It never
// rebases (upstream history is public and every weekly replay would re-open old
// resolutions) and it never pushes main (the PR is the record and the revert
// point). The two argument builders below are the only places that encode the
// strategy, so a test can assert it never mentions rebase or main.
import {
  INSTALL_HOOK_KEYS,
  SENSITIVE_PACKAGE_KEYS,
  SENSITIVE_PATH_EXACT,
  SENSITIVE_PATH_PREFIXES,
} from './constants.mjs';
import { isAncestor } from './git.mjs';

export const SYNC_BASE_REF = 'origin/main';
const TREE_ID_PATTERN = /^[0-9a-f]{40,64}$/;

/**
 * Arguments that create the sync branch from the fork's main.
 *
 * @param {string} branch Branch name to reset.
 * @returns {string[]} `git checkout` arguments.
 */
export function branchArguments(branch) {
  return ['checkout', '-B', branch, SYNC_BASE_REF];
}

/**
 * Arguments that merge upstream without committing, so pins can be applied first.
 *
 * @param {string} upstreamRef Ref holding upstream/main.
 * @returns {string[]} `git merge` arguments.
 */
export function mergeArguments(upstreamRef) {
  return ['merge', '--no-ff', '--no-commit', upstreamRef];
}

/**
 * Parse `git merge-tree --write-tree --name-only` output.
 *
 * Exit 0 prints the merged tree id. Exit 1 prints the tree id, the conflicted
 * paths, a blank line and the human-readable conflict messages.
 *
 * @param {{status: number, stdout: string, stderr: string}} result Raw git result.
 * @returns {{clean: boolean, tree: string, conflicts: string[], message: string}} Parsed merge.
 */
export function parseMergeTreeOutput({ status, stdout, stderr }) {
  const lines = stdout.split('\n');
  const tree = (lines[0] ?? '').trim();
  if (!TREE_ID_PATTERN.test(tree)) {
    throw new Error(`merge-tree produced no tree id: ${stderr || stdout || 'empty output'}`);
  }
  if (status !== 0 && status !== 1) {
    throw new Error(`merge-tree failed (${status}): ${stderr || stdout}`);
  }
  if (status === 0) {
    return { clean: true, tree, conflicts: [], message: '' };
  }
  const conflicts = [];
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') {
      break;
    }
    conflicts.push(line);
  }
  return {
    clean: false,
    tree,
    conflicts: [...new Set(conflicts)].sort(),
    message: lines.slice(index).join('\n').trim(),
  };
}

/**
 * Normalize a repository-relative path for comparison.
 *
 * @param {string} filePath Path from git.
 * @returns {string} Forward-slash path without a leading `./`.
 */
function normalizePath(filePath) {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

/**
 * Whether a path executes on the runner or changes how the repository builds.
 *
 * @param {string} filePath Repository-relative path.
 * @returns {boolean} True for the guarded paths.
 */
export function isSensitivePath(filePath) {
  const normalized = normalizePath(filePath);
  return (
    SENSITIVE_PATH_EXACT.includes(normalized) ||
    SENSITIVE_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

/**
 * Parse a package.json text, returning null and a reason when unreadable.
 *
 * @param {string|null} text File text.
 * @returns {{data: Record<string, unknown>|null, error: string|null}} Parsed document.
 */
function parsePackageJson(text) {
  try {
    const data = JSON.parse(text ?? '');
    return typeof data === 'object' && data !== null && !Array.isArray(data)
      ? { data, error: null }
      : { data: null, error: 'package.json is not an object' };
  } catch (error) {
    return { data: null, error: `package.json is not valid JSON: ${error.message}` };
  }
}

/**
 * Compare package.json's execution-relevant fields across a merge.
 *
 * @param {string|null} baseText package.json on origin/main.
 * @param {string|null} mergedText package.json after the merge.
 * @returns {string[]} Reasons the file needs a human review, empty when harmless.
 */
export function packageJsonRisk(baseText, mergedText) {
  if (mergedText === null) {
    return ['package.json was deleted'];
  }
  const base = parsePackageJson(baseText);
  const merged = parsePackageJson(mergedText);
  if (merged.error !== null) {
    return [merged.error];
  }
  if (base.error !== null) {
    return ['package.json is new or its base version was unreadable'];
  }
  const reasons = [];
  for (const key of SENSITIVE_PACKAGE_KEYS) {
    if (JSON.stringify(base.data[key]) !== JSON.stringify(merged.data[key])) {
      reasons.push(`package.json ${key} changed`);
    }
  }
  const baseScripts = base.data.scripts ?? {};
  const mergedScripts = merged.data.scripts ?? {};
  for (const hook of INSTALL_HOOK_KEYS) {
    if (JSON.stringify(baseScripts[hook]) !== JSON.stringify(mergedScripts[hook])) {
      reasons.push(`package.json ${hook} hook changed`);
    }
  }
  return [...new Set(reasons)];
}

/**
 * Decide whether a merge needs human review before any merge.
 *
 * @param {{touched: string[], basePackageJson: string|null, mergedPackageJson: string|null}} input Merge facts.
 * @returns {{sensitive: boolean, paths: string[], reasons: string[]}} Sensitivity verdict.
 */
export function assessSensitivity({ touched, basePackageJson, mergedPackageJson }) {
  const paths = touched.filter((filePath) => isSensitivePath(filePath)).sort();
  const reasons = [];
  if (touched.some((filePath) => normalizePath(filePath) === 'package.json')) {
    reasons.push(...packageJsonRisk(basePackageJson, mergedPackageJson));
  }
  return { sensitive: paths.length > 0 || reasons.length > 0, paths, reasons };
}

/**
 * Whether a merge changes a GitHub Actions workflow file.
 *
 * GitHub refuses to let GITHUB_TOKEN create or update workflow files, so a
 * branch containing one cannot be pushed by this workflow at all. That is a
 * hard platform restriction, not a permission we can declare.
 *
 * @param {string[]} touched Repository-relative paths.
 * @returns {boolean} True when any path is under `.github/workflows/`.
 */
export function touchesWorkflowFiles(touched) {
  return touched.some((filePath) => normalizePath(filePath).startsWith('.github/workflows/'));
}

/**
 * Detect an upstream force-push since the last sync.
 *
 * @param {{previousHead: string|null, upstreamHead: string, cwd: string}} input Heads to compare.
 * @returns {{previousHead: string|null, rewritten: boolean}} History verdict.
 */
export function historyStatus({ previousHead, upstreamHead, cwd }) {
  if (previousHead === null) {
    return { previousHead: null, rewritten: false };
  }
  return { previousHead, rewritten: !isAncestor({ ancestor: previousHead, descendant: upstreamHead, cwd }) };
}

/**
 * Read the upstream head recorded by the previous sync commit.
 *
 * @param {string} message Full commit message of the sync branch head.
 * @returns {string|null} Recorded upstream commit id or null.
 */
export function extractSyncHead(message) {
  const match = /^Upstream-Sync-Head:\s*([0-9a-f]{7,64})\s*$/m.exec(message);
  return match === null ? null : match[1];
}
