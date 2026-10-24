#!/usr/bin/env node
// CLI for the weekly upstream sync. The workflow calls these subcommands; a
// developer can run the same code locally. Nothing here pushes, opens a PR or
// merges: those actions are GitHub API calls in the workflow, made with the
// run's GITHUB_TOKEN, so the local dry run cannot reach them by construction.
//
//   node scripts/upstream-sync/run.mjs fetch
//   node scripts/upstream-sync/run.mjs plan --out plan.json --github-output
//   node scripts/upstream-sync/run.mjs pins --write --report pin-report.json
//   node scripts/upstream-sync/run.mjs pins --check
//   node scripts/upstream-sync/run.mjs gate
//   node scripts/upstream-sync/run.mjs conflicts --out conflicts.json
//   node scripts/upstream-sync/run.mjs pr-body --plan plan.json --report pin-report.json --out pr.md
//   node scripts/upstream-sync/run.mjs issue-body --plan plan.json --out issue.md
//   node scripts/upstream-sync/run.mjs preview --plan plan.json --out-dir preview/
//   node scripts/upstream-sync/run.mjs dry-run [--offline] [--out-dir preview/]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appendGithubOutput } from '../lib/github-output.mjs';
import { renderIssueBody, renderPrBody } from './bodies.mjs';
import { decideSync } from './decide.mjs';
import { buildPlan } from './plan.mjs';
import {
  BUILD_PACKAGE,
  CORE_PROVISION_FILE,
  UPSTREAM_BRANCH,
  UPSTREAM_REMOTE,
  UPSTREAM_URL,
} from './constants.mjs';
import { runGate } from './gate.mjs';
import { ensureRemote, fetchRemote, fetchUrl, listConflicts } from './git.mjs';
import { checkPinState, readCompatibility, readPinState, writePinState } from './pins.mjs';
import { npmViewDistTagLatest } from './registry.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.dirname(path.dirname(path.dirname(SCRIPT_PATH)));

const USAGE = [
  'usage: run.mjs <command> [options]',
  '',
  'commands:',
  '  fetch        add/update the upstream remote and fetch its main branch',
  '  plan         print and optionally write the sync plan (read-only)',
  '  pins --write apply the pin/version decision and refresh generated copies',
  '  pins --check fail closed when the checked-in pins disagree or are not allowed',
  '  gate         run the in-workflow gate in order',
  '  conflicts    list the unmerged paths of a stopped merge',
  '  pr-body      render the pull-request body',
  '  issue-body   render the conflict-issue body',
  '  preview      render the bodies for a plan file without touching a branch',
  '  dry-run      fetch upstream by URL, plan, decide and render, without pushing',
  '',
  'options: --root, --url, --remote, --branch, --base, --upstream, --previous-ref,',
  '         --check, --offline, --json, --out, --report, --plan, --conflicts, --gate,',
  '         --reason, --sensitive, --merge-requested, --commit-sha, --out-dir, --date,',
  '         --github-output',
].join('\n');

const OPTIONS = {
  root: { type: 'string' },
  url: { type: 'string' },
  remote: { type: 'string' },
  branch: { type: 'string' },
  base: { type: 'string' },
  upstream: { type: 'string' },
  'previous-ref': { type: 'string' },
  check: { type: 'boolean', default: false },
  offline: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  out: { type: 'string' },
  report: { type: 'string' },
  plan: { type: 'string' },
  conflicts: { type: 'string' },
  gate: { type: 'string' },
  reason: { type: 'string' },
  sensitive: { type: 'string' },
  'merge-requested': { type: 'boolean', default: false },
  'commit-sha': { type: 'string' },
  'out-dir': { type: 'string' },
  date: { type: 'string' },
  'github-output': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

/**
 * Write one line to standard output.
 *
 * @param {string} [line] Line to write.
 * @returns {void}
 */
function out(line = '') {
  process.stdout.write(`${line}\n`);
}

/**
 * Write one line to standard error.
 *
 * @param {string} line Line to write.
 * @returns {void}
 */
function err(line) {
  process.stderr.write(`${line}\n`);
}

/**
 * Read and parse a JSON file.
 *
 * @param {string} file File path.
 * @returns {any} Parsed value.
 */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Write JSON with a trailing newline, creating the parent directory.
 *
 * @param {string} file Destination path.
 * @param {unknown} value JSON-serialisable value.
 * @returns {void}
 */
function writeJson(file, value) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read the registry's latest bridge version, or keep the current one offline.
 *
 * @param {string} root Repository root.
 * @param {object} pins Pin state.
 * @param {boolean} offline Whether to skip the registry.
 * @returns {string} Latest version to consider.
 */
function latestBridge(root, pins, offline) {
  return offline ? pins.bridge : npmViewDistTagLatest({ packageName: BUILD_PACKAGE, cwd: root });
}

/**
 * Print the pin decision as human-readable lines.
 *
 * @param {object} report Pin report.
 * @returns {void}
 */
function printPinReport(report) {
  out(
    `bridge ${report.bridge.package}: ${report.bridge.current} -> ${report.bridge.target} ` +
      `(${report.bridge.decision}: ${report.bridge.reason})`,
  );
  out(
    `wrapper ${report.wrapper.package}: ${report.wrapper.current} -> ${report.wrapper.target} ` +
      `(${report.wrapper.decision}: ${report.wrapper.reason}, bridge ${report.wrapper.bridge})`,
  );
  out(
    `plugin version: ${report.pluginVersion.current} -> ${report.pluginVersion.target} ` +
      `(${report.pluginVersion.decision}: ${report.pluginVersion.reason})`,
  );
}

/**
 * `fetch`: make sure the upstream remote exists and fetch its main branch.
 *
 * @param {Record<string, any>} values Parsed options.
 * @param {string} root Repository root.
 * @returns {object} Fetch result.
 */
function commandFetch(values, root) {
  const url = values.url ?? UPSTREAM_URL;
  const remote = values.remote ?? UPSTREAM_REMOTE;
  const branch = values.branch ?? UPSTREAM_BRANCH;
  const { added } = ensureRemote({ name: remote, url, cwd: root });
  const sha = fetchRemote({ remote, branch, cwd: root });
  return { url, remote, branch, sha, added };
}

/**
 * `plan`: compute divergence, merge, sensitivity, history and pin decisions.
 *
 * @param {Record<string, any>} values Parsed options.
 * @param {string} root Repository root.
 * @returns {Promise<object>} The plan.
 */
async function commandPlan(values, root) {
  const pins = readPinState(root);
  const compatibility = readCompatibility(root);
  const plan = buildPlan({
    root,
    baseRef: values.base ?? 'origin/main',
    upstreamRef: values.upstream ?? `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`,
    previousRef: values['previous-ref'] ?? null,
    pins,
    compatibility,
    latestBridge: latestBridge(root, pins, values.offline),
    now: values.date === undefined ? () => new Date() : () => new Date(values.date),
  });
  if (values.out !== undefined) {
    writeJson(values.out, plan);
  }
  if (values.json) {
    out(JSON.stringify(plan, null, 2));
  } else {
    out(
      `upstream ${plan.upstreamRef} ${plan.upstreamSha} "${plan.upstreamSubject}": ` +
        `${plan.behind} behind, ${plan.ahead} ahead, ${plan.clean ? 'clean merge' : 'CONFLICT'}`,
    );
    printPinReport(plan.pins);
  }
  if (values['github-output']) {
    await appendGithubOutput({
      base_sha: plan.baseSha,
      upstream_sha: plan.upstreamSha,
      behind: plan.behind,
      clean: plan.clean,
      conflicts_count: plan.conflicts.length,
      sensitive: plan.sensitive.sensitive,
      workflow_files: plan.workflowFiles,
      history_rewritten: plan.history.rewritten,
      pin_changed: plan.pins.changed,
      requires_pr: plan.requiresPr,
    });
  }
  return plan;
}

/**
 * `pins`: check the guard, or apply the decided pin and version values.
 *
 * @param {Record<string, any>} values Parsed options.
 * @param {string} root Repository root.
 * @returns {number} Process exit code.
 */
function commandPins(values, root) {
  if (values.check === true) {
    const result = checkPinState(root);
    if (!result.ok) {
      err(`[pins] the pin guard failed:`);
      for (const error of result.errors) {
        err(`  ${error}`);
      }
      return 1;
    }
    out(
      `[pins] bridge ${result.state.bridge}, wrapper ${result.state.wrapper}, ` +
        `${result.state.mcpSites.length} MCP pin site(s), ${result.state.pluginVersions.length} plugin version(s) agree`,
    );
    return 0;
  }
  const pins = readPinState(root);
  const compatibility = readCompatibility(root);
  const report = decideSync({
    currentPins: pins,
    latestBridge: latestBridge(root, pins, values.offline),
    compatibility,
    now: values.date === undefined ? () => new Date() : () => new Date(values.date),
  });
  report.sites = {
    core: CORE_PROVISION_FILE,
    mcp: pins.mcpSites.map((site) => site.file),
  };
  if (report.changed) {
    const written = writePinState(root, {
      bridgeFrom: pins.bridge,
      bridgeTo: report.bridge.target,
      wrapperFrom: pins.wrapper,
      wrapperTo: report.wrapper.target,
      versionFrom: report.pluginVersion.current,
      versionTo: report.pluginVersion.target,
    });
    report.files = written;
  } else {
    report.files = { changed: [], readmes: [], sync: { written: [], removed: [] } };
  }
  if (values.report !== undefined) {
    writeJson(values.report, report);
  }
  if (values.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    printPinReport(report);
    out(
      `[pins] ${report.changed ? `${report.files.changed.length} file(s) written, ` : 'no file written, '}` +
        `${report.files.readmes.length} README updated, ${report.files.sync.written.length} generated copy(ies) refreshed`,
    );
  }
  return 0;
}

/**
 * `pr-body`: render the pull-request body from the plan and the pin report.
 *
 * @param {Record<string, any>} values Parsed options.
 * @returns {string} Markdown body.
 */
function commandPrBody(values) {
  if (values.plan === undefined) {
    throw new Error('pr-body requires --plan <file>');
  }
  const plan = readJson(values.plan);
  const report = values.report === undefined ? plan.pins : readJson(values.report);
  return renderPrBody({
    plan: { ...plan, pins: report },
    gate: values.gate ?? 'not-run',
    sensitive: values.sensitive === undefined ? plan.sensitive.sensitive : values.sensitive === 'true',
    mergeRequested: values['merge-requested'] === true,
    commitSha: values['commit-sha'] ?? null,
    date: values.date === undefined ? new Date() : new Date(values.date),
  });
}

/**
 * `issue-body`: render the conflict or rewritten-history issue body.
 *
 * @param {Record<string, any>} values Parsed options.
 * @returns {string} Markdown body.
 */
function commandIssueBody(values) {
  if (values.plan === undefined) {
    throw new Error('issue-body requires --plan <file>');
  }
  const plan = readJson(values.plan);
  const conflicts = values.conflicts === undefined ? null : readJson(values.conflicts);
  return renderIssueBody({
    plan,
    reason: values.reason ?? (plan.history.rewritten ? 'history' : 'conflict'),
    conflicts: Array.isArray(conflicts) ? conflicts : (conflicts?.conflicts ?? null),
    date: values.date === undefined ? new Date() : new Date(values.date),
  });
}

/**
 * Write a rendered body to --out, or print it.
 *
 * @param {string|undefined} destination Output path.
 * @param {string} body Markdown body.
 * @returns {void}
 */
function emitBody(destination, body) {
  if (destination === undefined) {
    out(body);
    return;
  }
  mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  writeFileSync(destination, body);
  out(`[body] wrote ${destination}`);
}

/**
 * Render the PR body and, when the plan cannot become a PR, the issue body.
 *
 * @param {object} plan Sync plan.
 * @param {object} report Pin report (defaults to the plan's).
 * @param {Date} date Render date.
 * @returns {{prBody: string, issueBody: string|null}} Rendered bodies.
 */
function renderBodies(plan, report, date) {
  const prBody = renderPrBody({
    plan: { ...plan, pins: report },
    gate: 'not-run',
    sensitive: plan.sensitive.sensitive,
    date,
  });
  const issueBody =
    plan.clean && !plan.history.rewritten
      ? null
      : renderIssueBody({
          plan,
          reason: plan.history.rewritten ? 'history' : 'conflict',
          date,
        });
  return { prBody, issueBody };
}

/**
 * Write the rendered bodies to a directory and report the files.
 *
 * @param {string} outDir Destination directory.
 * @param {{prBody: string, issueBody: string|null}} rendered Bodies.
 * @returns {void}
 */
function writePreview(outDir, { prBody, issueBody }) {
  mkdirSync(path.resolve(outDir), { recursive: true });
  writeFileSync(path.join(outDir, 'pr-body.md'), prBody);
  out(`[preview] wrote ${path.join(outDir, 'pr-body.md')}`);
  if (issueBody !== null) {
    writeFileSync(path.join(outDir, 'issue-body.md'), issueBody);
    out(`[preview] wrote ${path.join(outDir, 'issue-body.md')}`);
  }
}

/**
 * `preview`: render both bodies for an existing plan file.
 *
 * @param {Record<string, any>} values Parsed options.
 * @returns {void}
 */
function commandPreview(values) {
  if (values.plan === undefined) {
    throw new Error('preview requires --plan <file>');
  }
  const plan = readJson(values.plan);
  const report = values.report === undefined ? plan.pins : readJson(values.report);
  const rendered = renderBodies(plan, report, values.date === undefined ? new Date() : new Date(values.date));
  if (values['out-dir'] !== undefined) {
    writePreview(values['out-dir'], rendered);
    return;
  }
  out('--- PR body ---');
  out(rendered.prBody);
  if (rendered.issueBody !== null) {
    out('--- Issue body ---');
    out(rendered.issueBody);
  }
}

/**
 * `dry-run`: fetch by URL, plan, decide and render without writing the tree.
 *
 * @param {Record<string, any>} values Parsed options.
 * @param {string} root Repository root.
 * @returns {Promise<object>} Dry-run summary.
 */
async function commandDryRun(values, root) {
  const url = values.url ?? UPSTREAM_URL;
  const branch = values.branch ?? UPSTREAM_BRANCH;
  const upstreamSha = fetchUrl({ url, branch, cwd: root });
  const pins = readPinState(root);
  const compatibility = readCompatibility(root);
  const plan = buildPlan({
    root,
    baseRef: values.base ?? 'origin/main',
    upstreamRef: 'FETCH_HEAD',
    previousRef: values['previous-ref'] ?? null,
    pins,
    compatibility,
    latestBridge: latestBridge(root, pins, values.offline),
    now: values.date === undefined ? () => new Date() : () => new Date(values.date),
  });
  const report = plan.pins;
  const date = values.date === undefined ? new Date() : new Date(values.date);
  const rendered = renderBodies(plan, report, date);
  const outDir = path.resolve(
    values['out-dir'] ?? path.join(os.tmpdir(), `upstream-sync-dry-run-${upstreamSha.slice(0, 12)}`),
  );
  writePreview(outDir, rendered);
  writeFileSync(path.join(outDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  const summary = {
    url,
    branch,
    baseRef: plan.baseRef,
    baseSha: plan.baseSha,
    upstreamSha: plan.upstreamSha,
    upstreamSubject: plan.upstreamSubject,
    behind: plan.behind,
    ahead: plan.ahead,
    clean: plan.clean,
    conflicts: plan.conflicts,
    touched: plan.touched,
    sensitive: plan.sensitive,
    history: plan.history,
    requiresPr: plan.requiresPr,
    pins: report,
    outDir,
    issueBodyWritten: rendered.issueBody !== null,
  };
  if (values.json) {
    out(JSON.stringify(summary, null, 2));
  } else {
    out(`[dry-run] ${url} ${branch} at ${plan.upstreamSha} "${plan.upstreamSubject}"`);
    out(
      `[dry-run] ${plan.behind} upstream commit(s) behind, ${plan.ahead} fork commit(s) ahead; ` +
        `${plan.clean ? 'merge-tree reports a clean merge' : `CONFLICT in ${plan.conflicts.length} path(s)`}`,
    );
    printPinReport(report);
    out(
      `[dry-run] sensitive: ${plan.sensitive.sensitive ? `yes (${[...plan.sensitive.paths, ...plan.sensitive.reasons].join('; ')})` : 'no'}; ` +
        `history rewritten: ${plan.history.rewritten}; would open a PR: ${plan.requiresPr}`,
    );
    if (plan.touched.length > 0) {
      out(`[dry-run] ${plan.touched.length} path(s) touched: ${plan.touched.join(', ')}`);
    }
    if (plan.conflicts.length > 0) {
      out(`[dry-run] conflicting paths: ${plan.conflicts.join(', ')}`);
    }
    out(`[dry-run] wrote ${outDir}`);
  }
  return summary;
}

/**
 * Parse the CLI and dispatch one subcommand.
 *
 * @param {string[]} argv Raw arguments after the node executable and script.
 * @returns {Promise<number>} Process exit code.
 */
async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const command = positionals[0];
  const root = path.resolve(values.root ?? REPO_ROOT);
  if (values.help === true || command === undefined || command === 'help') {
    out(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === 'fetch') {
    const result = commandFetch(values, root);
    out(
      `[fetch] ${result.remote} (${result.url}) ${result.branch} at ${result.sha}${result.added ? ' (remote added)' : ''}`,
    );
    if (values.json) {
      out(JSON.stringify(result, null, 2));
    }
    if (values['github-output']) {
      await appendGithubOutput({ upstream_sha: result.sha });
    }
    return 0;
  }
  if (command === 'plan') {
    await commandPlan(values, root);
    return 0;
  }
  if (command === 'pins') {
    return commandPins(values, root);
  }
  if (command === 'gate') {
    const result = runGate({ root });
    return result.ok ? 0 : 1;
  }
  if (command === 'conflicts') {
    const conflicts = listConflicts(root);
    if (values.out !== undefined) {
      writeJson(values.out, { conflicts });
    }
    out(JSON.stringify({ conflicts }, null, 2));
    return 0;
  }
  if (command === 'pr-body') {
    emitBody(values.out, commandPrBody(values));
    return 0;
  }
  if (command === 'issue-body') {
    emitBody(values.out, commandIssueBody(values));
    return 0;
  }
  if (command === 'preview') {
    commandPreview(values);
    return 0;
  }
  if (command === 'dry-run') {
    await commandDryRun(values, root);
    return 0;
  }
  err(`unknown command: ${command}`);
  out(USAGE);
  return 2;
}

const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === SCRIPT_PATH) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      err(`[upstream-sync] ${error.message}`);
      process.exitCode = 1;
    });
}

export { commandDryRun, commandIssueBody, commandPins, commandPrBody, main };
