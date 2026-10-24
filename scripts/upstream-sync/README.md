# Weekly upstream sync

`.github/workflows/upstream-sync.yml` merges `swimmwatch/cloakbrowser-mcp` `main` into
this fork once a week, applies the pin policy, runs a gate inside the workflow, and opens a
pull request. It never pushes to `main`, never rebases and never relies on repository
protection: `main` is unprotected and `allow_auto_merge` is false, so the workflow's own gate
is the evidence.

## Schedule and manual runs

| Trigger | When / how |
| --- | --- |
| `schedule` | Monday 04:41 UTC (`41 4 * * 1`), clear of the existing 03:17, 05:23 and 06:17 crons |
| `workflow_dispatch` | Manual. Inputs: `dry_run` (default `false`), `allow_merge` (default `false`) |

Inherited scheduled workflows in this fork are `disabled_fork`; a newly added workflow is
normally active, but the first two runs must be dispatches anyway:

1. **First dispatch** — `dry_run=true`, `allow_merge=false`: prints the plan, the pin report and
   the PR/issue bodies; pushes nothing and opens nothing.
2. **Second dispatch** — defaults (`dry_run=false`, `allow_merge=false`): performs the real sync,
   runs the gate, pushes `chore/upstream-sync` and opens the PR, which stays open for review.

Only after both are clean should the schedule be enabled in the Actions tab (if GitHub has not
already enabled it) and `allow_merge=true` be considered. A scheduled run may be delayed by
GitHub at busy times; that is normal.

## What a run does

1. Checks out the fork with full history and no persisted credentials, then configures git
   credentials for this run with `gh auth setup-git` and the job's `GITHUB_TOKEN`.
2. Adds or updates the `upstream` remote and fetches `upstream/main`.
3. `node scripts/upstream-sync/run.mjs plan` computes divergence, a hypothetical merge
   (`git merge-tree`), conflicts, touched paths, sensitive paths, whether upstream rewrote
   history since the last sync, and the pin decision. A no-op week ends with a `::notice`.
4. If the plan is clean and no workflow file changes: `git checkout -B chore/upstream-sync
   origin/main` and `git merge --no-ff --no-commit upstream/main`.
5. `pins --write` applies the pin policy (below) and refreshes every generated plugin copy with
   `scripts/sync-plugin-core.mjs --write`.
6. Commits, runs the gate, then pushes with `--force-with-lease` to `chore/upstream-sync` only.
7. Opens or updates one pull request (`chore/upstream-sync` → `main`). It is left open by
   default. With `allow_merge=true` it is squash-merged, but only if the gate passed and no
   sensitive path changed.

## The gate

`node scripts/upstream-sync/run.mjs gate` runs, in order:

1. `npm ci --ignore-scripts` — install scripts are skipped so a newly merged `postinstall`
   never executes before the sensitive-path review; this matches the repository's own CI.
2. `npm run build`
3. `node scripts/sync-plugin-core.mjs --check`
4. `node scripts/upstream-sync/run.mjs pins --check` (fail-closed pin guard)
5. `npm run check:static`
6. `npm test` (unit and integration; the Linux runner passes the two Windows-only symlink tests)
7. `claude plugin validate .` and once per `plugins/*` with the pinned
   `@anthropic-ai/claude-code@2.1.310`, installed in a prior step

"Green" means this gate passed. It never means "CI is green": pull requests opened with
`GITHUB_TOKEN` do not trigger `ci.yml`, actionlint or zizmor.

## Pin policy

Version numbers are never typed by hand; both come from the npm registry (`npm view <pkg>
dist-tags.latest --json`).

| Pin | Where | Rule |
| --- | --- | --- |
| Bridge (`cloakbrowser-mcp`) | `shared/core/lib/provision.mjs` (`DEFAULT_NPM_PACKAGE`) and every `plugins/*/.mcp.json` carrying `CLOAK_PLAYWRIGHT_MCP_PACKAGE` | Bump only within the same major, never a prerelease. A major change is held for manual review. |
| Wrapper (`cloakbrowser`) | `shared/core/lib/provision.mjs` (`NPM_ENGINE_WRAPPER_PIN`) | Bump only to the highest version listed for the *effective* bridge in `wrapper-compatibility.json`. If the bridge is not in the table, hold and say so. |
| Plugin versions | `plugins/*/.claude-plugin/plugin.json` | Lockstep patch bump in the same commit as any pin change; no bump when no pin changes. |

`wrapper-compatibility.json` transcribes the bridge's humanize allowlist
(`src/runtime/humanizeCompatibility.ts`). Today the bridge is 1.15.1 and allows 0.6.0–0.6.3, so
the wrapper pin is expected to stay at 0.6.3 while npm's latest is 0.6.4.

`pins --check` fails closed when the bridge is not in the table, the current wrapper is not
allowed by it, the MCP pin disagrees between the canonical core and any `.mcp.json`, or the
plugin versions are not lockstep. To prove the guard, set `NPM_ENGINE_WRAPPER_PIN` to `0.6.4`
in a scratch copy and run the check; it exits 1.

The pin write also rewrites the exact version and pin tokens in each plugin README. Prose that
describes *why* a version is pinned (for example "the bridge rejects 0.6.4") is not rewritten;
review it when a pin actually moves.

## Conflicts and rewritten history

A conflict is a handled outcome, not an unhandled failure:

- `git merge --abort` restores the tree; nothing is pushed and `main` is untouched.
- One open issue titled `Upstream sync conflict (swimmwatch/main)` is created, or commented on
  when it already exists, with labels `upstream-sync` and `conflict`, assignee
  `FiredMosquito831`, the conflicting paths and a copy-paste resolution block.
- The run ends successfully with a `::error` annotation, so the run list is visible without a
  failing-check alert storm.

If the head recorded in the previous sync commit (`Upstream-Sync-Head:` trailer) is no longer an
ancestor of `upstream/main`, upstream rewrote history. The same issue is used with a
rewrite-specific resolution block instead of merging stale history. The same fixed issue title
also records a workflow-file merge that `GITHUB_TOKEN` cannot push (see below), so one open issue
covers every handled stop.

## Sensitive paths (never auto-merged)

A merge touching `.github/workflows/**`, `.github/actions/**`, `Dockerfile`,
`.github/dependabot.yml`, or changing `package.json`'s `scripts`, `workspaces`,
`publishConfig` or an install hook (`preinstall`/`install`/`postinstall`) is labelled
`upstream-sync: review required` and is never merged automatically, whatever `allow_merge`
says. Those paths execute on the runner itself, and the repository's security linters will not
run on this PR.

### Workflow files cannot be pushed with `GITHUB_TOKEN`

GitHub refuses to let `GITHUB_TOKEN` create or update files under `.github/workflows/`, and no
declared permission changes that. A merge that touches a workflow file therefore **stops before
pushing**, using the same conflict issue with a workflow-specific resolution block: merge and
review locally, push `chore/upstream-sync` with your own credentials, and the next run gates the
branch and opens the PR. Without this guard the failure would happen at `git push`, after the
gate had already spent 10–20 minutes.

## Permissions

`GITHUB_TOKEN` only, declared at job level: `contents: write` (push the sync branch),
`pull-requests: write` (open/update/merge the PR), `issues: write` (conflict issue). No PAT and
no secrets. A PAT would be a long-lived credential in an inherited public fork, and it would not
make the in-workflow gate stronger.

## Running the dry run locally

From the repository root:

```bash
node scripts/upstream-sync/run.mjs dry-run
```

This fetches `swimmwatch/cloakbrowser-mcp` `main` by URL into `FETCH_HEAD` (no remote is added),
computes the merge with `git merge-tree`, reads the registry, renders the PR/issue bodies and
writes them to a temporary directory under the OS temp dir. It never checks out the sync branch,
never pushes and never calls the GitHub API. `--offline` skips the registry read
(`--out-dir <path>` chooses where the previews go; `--json` prints the full summary).

Other useful local commands:

```bash
node scripts/upstream-sync/run.mjs plan --offline --json
node scripts/upstream-sync/run.mjs pins --check
node scripts/upstream-sync/run.mjs preview --plan <plan.json> --out-dir <dir>
```

The gate itself is Linux-oriented; on Windows the two known symlink tests and the TEMP-dependent
doctor test fail for pre-existing reasons, so use the workflow for the full gate.

## Tests

`tests/unit/upstream-sync.test.ts` covers merge parsing, conflict detection, sensitive paths,
package.json risk, the allowlist, the pin decisions, README rewriting, version bumps, the guard,
the gate command list and both body renderers. No test touches the network; git tests use
temporary repositories.
