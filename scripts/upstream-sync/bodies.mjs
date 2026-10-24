// PR and conflict-issue bodies. Rendering is pure so the dry run can print the
// exact text the workflow would publish.
import { CONFLICT_ISSUE_TITLE, PR_TITLE, SYNC_BRANCH, UPSTREAM_URL } from './constants.mjs';

/**
 * Format a date for humans.
 *
 * @param {Date} date Date to format.
 * @returns {string} ISO-8601 UTC timestamp.
 */
function timestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Render the pin decision rows.
 *
 * @param {object} report Pin report from decideSync.
 * @returns {string[]} Markdown table rows.
 */
function pinRows(report) {
  return [
    `| \`${report.bridge.package}\` | \`${report.bridge.current}\` | \`${report.bridge.target}\` | ${report.bridge.decision} | ${report.bridge.reason} |`,
    `| \`${report.wrapper.package}\` | \`${report.wrapper.current}\` | \`${report.wrapper.target}\` | ${report.wrapper.decision} | ${report.wrapper.reason} |`,
    `| plugin version | \`${report.pluginVersion.current}\` | \`${report.pluginVersion.target}\` | ${report.pluginVersion.decision} | ${report.pluginVersion.reason} |`,
  ];
}

/**
 * Render the list of merged paths.
 *
 * @param {string[]} touched Repository-relative paths.
 * @returns {string[]} Markdown lines.
 */
function touchedSection(touched) {
  if (touched.length === 0) {
    return ['This run only changes pin files; no upstream commit was merged.'];
  }
  const shown = touched.slice(0, 200);
  const lines = [`<details><summary>${touched.length} path(s) changed by the merge</summary>`, ''];
  lines.push(...shown.map((filePath) => `- \`${filePath}\``));
  if (touched.length > shown.length) {
    lines.push(`- …and ${touched.length - shown.length} more`);
  }
  lines.push('', '</details>');
  return lines;
}

/**
 * Render the sensitive-path block.
 *
 * @param {{sensitive: boolean, paths: string[], reasons: string[]}} sensitivity Sensitivity verdict.
 * @returns {string[]} Markdown lines.
 */
function sensitiveSection(sensitivity) {
  if (!sensitivity.sensitive) {
    return ['None.'];
  }
  return [
    '**This merge changes a path that executes on the runner or changes how the repository builds.**',
    'It is labelled `upstream-sync: review required` and is never merged automatically, even with `allow_merge=true`.',
    '',
    ...sensitivity.paths.map((filePath) => `- \`${filePath}\``),
    ...sensitivity.reasons.map((reason) => `- ${reason}`),
  ];
}

/**
 * Render the sync pull-request body.
 *
 * @param {{plan: object, gate?: 'passed'|'not-run', sensitive?: boolean, mergeRequested?: boolean, commitSha?: string|null, date?: Date}} input Render inputs.
 * @returns {string} Markdown body.
 */
export function renderPrBody({
  plan,
  gate = 'not-run',
  sensitive = plan.sensitive.sensitive,
  mergeRequested = false,
  commitSha = null,
  date = new Date(),
}) {
  const gateLines =
    gate === 'passed'
      ? [
          'The in-workflow gate passed on this branch: `npm ci --ignore-scripts`, `npm run build`,',
          '`node scripts/sync-plugin-core.mjs --check`, the pin guard, `npm run check:static`,',
          '`npm test` and `claude plugin validate` for the marketplace and every plugin.',
          '',
          'This is **not a CI result**. Pull requests created with `GITHUB_TOKEN` do not trigger',
          '`ci.yml`, so the gate inside `.github/workflows/upstream-sync.yml` is the evidence.',
        ]
      : ['The in-workflow gate has not run yet. Do not treat this PR as verified.'];
  const sensitivity = { ...plan.sensitive, sensitive };
  return [
    '## Weekly upstream sync',
    '',
    `Merges \`swimmwatch/cloakbrowser-mcp\` \`main\` at \`${plan.upstreamSha}\` ("${plan.upstreamSubject}") into \`origin/main\` at \`${plan.baseSha}\`.`,
    '',
    '| Fact | Value |',
    '| --- | --- |',
    `| Detected (UTC) | ${timestamp(date)} |`,
    `| Sync branch | \`${SYNC_BRANCH}\` |`,
    `| Commit under test | ${commitSha === null ? 'not committed yet' : `\`${commitSha}\``} |`,
    `| Upstream commits behind | ${plan.behind} |`,
    `| Fork commits not upstream | ${plan.ahead} |`,
    `| Files changed by the merge | ${plan.touched.length} |`,
    '',
    '### In-workflow gate',
    '',
    ...gateLines,
    '',
    '### Pin report',
    '',
    '| Pin | Current | Target | Decision | Reason |',
    '| --- | --- | --- | --- | --- |',
    ...pinRows(plan.pins),
    '',
    plan.pins.changed
      ? 'A pin changed, so every plugin version is patch-bumped in the same commit.'
      : 'No pin changed; the plugin version stays as it is.',
    '',
    '### Files merged',
    '',
    ...touchedSection(plan.touched),
    '',
    '### Sensitive paths',
    '',
    ...sensitiveSection(sensitivity),
    '',
    '### Merge policy',
    '',
    '- This PR is **left open by default**.',
    `- With \`allow_merge=true\`, the workflow squash-merges it only after the gate passes and only when no sensitive path changed.${mergeRequested ? ' Merge was requested for this run.' : ''}`,
    '- A merge conflict never reaches this PR: the workflow aborts and opens or updates the conflict issue instead.',
    '',
    'by FiredMosquito831',
    '',
  ].join('\n');
}

/**
 * Render the conflict or rewritten-history issue body.
 *
 * @param {{plan: object, reason?: 'conflict'|'history'|'workflow', conflicts?: string[]|null, date?: Date}} input Render inputs.
 * @returns {string} Markdown body.
 */
export function renderIssueBody({ plan, reason = 'conflict', conflicts = null, date = new Date() }) {
  const workflowPaths = plan.touched.filter((filePath) =>
    filePath.replaceAll('\\', '/').startsWith('.github/workflows/'),
  );
  const reported = conflicts ?? (reason === 'workflow' ? workflowPaths : plan.conflicts);
  const effective = reason === 'workflow' && reported.length === 0 ? workflowPaths : reported;
  const paths = [...new Set(effective)].sort();
  const reasonText =
    reason === 'history'
      ? 'Upstream rewrote history: the head recorded by the previous sync is no longer an ancestor of `swimmwatch/main`.'
      : reason === 'workflow'
        ? 'The merge changes a GitHub Actions workflow file. `GITHUB_TOKEN` cannot push workflow files, so this run stopped before pushing instead of failing at the push.'
        : 'The merge of `swimmwatch/main` into `origin/main` has conflicts.';
  const pathLines =
    paths.length === 0
      ? ['Git reported no conflicting path; inspect the merge output in the workflow run.']
      : paths.map((filePath) => `- \`${filePath}\``);
  const resolution =
    reason === 'history'
      ? [
          '```bash',
          'cd fork',
          `git fetch ${UPSTREAM_URL} main`,
          `git merge-base --is-ancestor ${plan.history.previousHead ?? '<previous-upstream-head>'} FETCH_HEAD; echo $?`,
          `git checkout -B ${SYNC_BRANCH} origin/main`,
          `git merge --no-ff ${plan.upstreamSha}`,
          '# confirm the rewrite, land the resolution on main, and the next run starts from it',
          '```',
        ]
      : reason === 'workflow'
        ? [
            '```bash',
            'cd fork',
            `git fetch ${UPSTREAM_URL} main`,
            `git checkout -B ${SYNC_BRANCH} origin/main`,
            `git merge --no-ff ${plan.upstreamSha}`,
            '# review the workflow change, then push the branch with your own credentials:',
            `git push --force-with-lease origin HEAD:refs/heads/${SYNC_BRANCH}`,
            '# open and merge a PR into main; the next run starts from the updated main',
            '```',
          ]
        : [
            '```bash',
            'cd fork',
            `git fetch ${UPSTREAM_URL} main`,
            `git checkout -B ${SYNC_BRANCH} origin/main`,
            `git merge --no-ff ${plan.upstreamSha}`,
            '# resolve, then push the branch and land the resolution on main (open and merge its PR);',
            '# each run cuts a fresh branch from origin/main, so the resolution must be on main',
            '```',
          ];
  const reasonLabel =
    reason === 'history'
      ? 'upstream history rewrite'
      : reason === 'workflow'
        ? 'workflow file changed'
        : 'merge conflict';
  return [
    `**${CONFLICT_ISSUE_TITLE}**`,
    '',
    reasonText,
    '',
    '| Fact | Value |',
    '| --- | --- |',
    `| Detected (UTC) | ${timestamp(date)} |`,
    `| Fork head | \`${plan.baseSha}\` |`,
    `| Upstream head | \`${plan.upstreamSha}\` ("${plan.upstreamSubject}") |`,
    `| Upstream commits behind | ${plan.behind} |`,
    `| Reason | ${reasonLabel} |`,
    '',
    reason === 'workflow' ? '### Workflow files' : '### Conflicting paths',
    '',
    ...pathLines,
    '',
    '### Resolution',
    '',
    ...resolution,
    '',
    '`main` was not touched and no branch was pushed. The next scheduled or dispatched run will pick up the resolution and run the gate.',
    '',
    'by FiredMosquito831',
    '',
  ].join('\n');
}

export { CONFLICT_ISSUE_TITLE, PR_TITLE };
