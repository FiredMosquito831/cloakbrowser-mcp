// Build the facts one sync run needs before it touches a branch: divergence,
// the hypothetical merge, conflicts, sensitive paths, history status and the
// pin decision. Read-only with respect to the working tree.
import { decideSync } from './decide.mjs';
import {
  commitMessage,
  commitSubject,
  countCommits,
  diffNames,
  fileAtRef,
  mergeTree,
  revParse,
  treeOf,
} from './git.mjs';
import {
  assessSensitivity,
  extractSyncHead,
  historyStatus,
  parseMergeTreeOutput,
  SYNC_BASE_REF,
  touchesWorkflowFiles,
} from './merge.mjs';

/**
 * Build a sync plan.
 *
 * @param {{root: string, baseRef?: string, upstreamRef?: string, previousRef?: string|null, pins: object, compatibility: object, latestBridge: string, now?: () => Date}} input Plan inputs.
 * @returns {object} JSON-serialisable plan.
 */
export function buildPlan({
  root,
  baseRef = SYNC_BASE_REF,
  upstreamRef = 'upstream/main',
  previousRef = null,
  pins,
  compatibility,
  latestBridge,
  now = () => new Date(),
}) {
  const baseSha = revParse(baseRef, root);
  const upstreamSha = revParse(upstreamRef, root);
  if (baseSha === null) {
    throw new Error(`cannot resolve ${baseRef}`);
  }
  if (upstreamSha === null) {
    throw new Error(`cannot resolve ${upstreamRef}; fetch upstream first`);
  }
  const merge = parseMergeTreeOutput(mergeTree({ base: baseSha, upstream: upstreamSha, cwd: root }));
  const touched = merge.clean ? diffNames({ from: treeOf(baseSha, root), to: merge.tree, cwd: root }) : [];
  const touchesPackageJson = touched.includes('package.json');
  const sensitivity = assessSensitivity({
    touched,
    basePackageJson: touchesPackageJson ? fileAtRef({ ref: baseSha, file: 'package.json', cwd: root }) : null,
    mergedPackageJson:
      touchesPackageJson && merge.clean
        ? fileAtRef({ ref: merge.tree, file: 'package.json', cwd: root })
        : null,
  });
  const previousHead =
    previousRef === null || revParse(previousRef, root) === null
      ? null
      : extractSyncHead(commitMessage(previousRef, root));
  const history = historyStatus({ previousHead, upstreamHead: upstreamSha, cwd: root });
  const pinReport = decideSync({
    currentPins: {
      bridge: pins.bridge,
      wrapper: pins.wrapper,
      pluginVersions: pins.pluginVersions,
    },
    latestBridge,
    compatibility,
    now,
  });
  return {
    baseRef,
    baseSha,
    upstreamRef,
    upstreamSha,
    upstreamSubject: commitSubject(upstreamSha, root),
    behind: countCommits(`${baseSha}..${upstreamSha}`, root),
    ahead: countCommits(`${upstreamSha}..${baseSha}`, root),
    clean: merge.clean,
    conflicts: merge.conflicts,
    touched,
    sensitive: sensitivity,
    workflowFiles: touchesWorkflowFiles(touched),
    history,
    pins: pinReport,
    requiresPr: countCommits(`${baseSha}..${upstreamSha}`, root) > 0 || pinReport.changed,
  };
}
