# 13 — Separate Pages publication and PR report link

Status: Planned; specification approved; packet and external setup authorization required
Requirements: TEST-007, TEST-008, TEST-009 (delivery amendment)
Dependencies: 10; external setup authorization before live publication
Delivery order: after 10, before 11; existing packet IDs remain stable

## Pinned inputs and provenance

- `source_version`: `785424ba80d8dbf709c51901135a288276377b0a5aa08958d25c7d6ba2988a83`
- `specification_version`: `9eb3ca847f6421bd03834981a659066362922abcffcd79605c63d04cd9e30a7e`
- `review_ref`: `28b4daa7-1f0e-4286-ace1-eace5f685e70`
- User instruction: `301e19f0-2621-412e-b6b4-dc23d3666ddd`, revision 1,
  recorded through scenario MCP on 2026-10-10.
- Reconciliation approval: `95e828ec-3581-4edc-abd2-8808a24ecc0d`, revision 1.
  Independent review passed 22/22 items with consistent whole-specification text;
  MCP state is pass/reviewed, Approved, with a recorded approval checkpoint.
- CWD: `/home/dmitry-vasiliev/.codex/worktrees/release-v1-15-0/cloakbrowser-mcp`

TEST-007/008/009 and the scope manifest now cover this delivery amendment.
Keep generated output out of the source repository/npm package; only the dedicated
report repository may version generated public HTML. Do not hand-edit workflow YAML
state; recheck current specification freshness before implementation.

## Outcome and repository evidence

A PR exposes one merged matrix report through a browser link. Documentation Pages
and release publication remain outside the report publisher's ownership.

Existing project documentation deployment is
`.github/workflows/release.yml:377` (upload `site/`), `:392` (Pages permission)
and `:407` (deploy). Producer/aggregation ownership is packet 10 and existing
`.github/workflows/ci.yml:49`, `:127`, `:187`.

Official references:
[workflow_run security and privileges](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run),
[repository-scoped GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token),
[PR issue-comment API](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment).

## Selected projects, Actions and repositories

This selected approach is covered by the approved reviewed specification.
Use these components:

| Component | Exact project | Responsibility |
| --- | --- | --- |
| Generator | [Allure Report 3](https://github.com/allure-framework/allure3), development package `allure` | Generate one HTML report from validated merged results; packet 03 owns the version and compatibility probe |
| Publisher | [peaceiris/actions-gh-pages](https://github.com/peaceiris/actions-gh-pages) | Publish trusted generated output to the separate reports repository |
| PR report Action | [allure-framework/allure-action](https://github.com/allure-framework/allure-action) | Read trusted generated `summary.json`, present statistics and link the deployed URL through `remote-href`; it does not host reports |
| Source repository | [swimmwatch/cloakbrowser-mcp](https://github.com/swimmwatch/cloakbrowser-mcp) | Own tests, aggregation, trusted publisher workflow and checks |
| Reports repository | Proposed `swimmwatch/cloakbrowser-mcp-reports` | Own sanitized generated HTML and independent project Pages publication; exact identity and creation require separate authorization |

Use the existing packet-03 safe adapter and Allure 3 generator. Do not use
`simple-elf/allure-report-action`: its generator is Allure 2, as explained by the
[official Allure 3 Pages guide](https://allurereport.org/docs/guides/github-pages/).
`deivydasp/allure-deployer-action-v2` is a researched alternative, not a selected
dependency or an audited implementation.

### Concrete configuration and verification

- Configure `peaceiris/actions-gh-pages` with `external_repository` set to the
  confirmed reports repository, `publish_branch: gh-pages`, and `publish_dir`
  pointing only to trusted regenerated output. Supply `personal_token` with a
  short-lived GitHub App installation token scoped to the reports repository.
  Do not use a broad personal access token.
- Configure the reports repository's Pages source as branch `gh-pages`, root
  directory. No second Pages deployment workflow or source-repository Pages-write
  permission is needed. Leave documentation deployment independent.
- Stage reports under `pr/<number>/run/<id>-attempt-<attempt>/<sha>/`. Use
  `keep_files: true` to preserve other runs, rather than relying on the beta
  `destination_dir` input. Guarded publisher cleanup owns explicit deletion of
  expired report paths; `keep_files` does not implement retention. Serialize
  publication and cleanup across the destination repository.
- After successful deployment and URL verification, set the official Allure
  Action's `remote-href` to the immutable URL. Read only summaries rebuilt by
  trusted code. Verify its actual comment/update behavior, permissions and
  summary compatibility before integration. Preserve the single bot-owned
  comment, current-head/latest-run guards and Job Summary requirements below;
  implement missing guards in the trusted publisher.
- Before adding workflow `uses:` entries, select supported releases, inspect
  both Actions and pin them to verified full commit SHAs with version comments.
  Record exact commits and permission checks in implementation evidence. This
  plan does not invent unverified Action pins.

Expected URLs if the proposed destination repository is confirmed:

```text
Documentation: https://swimmwatch.github.io/cloakbrowser-mcp/
Reports: https://swimmwatch.github.io/cloakbrowser-mcp-reports/
PR report: https://swimmwatch.github.io/cloakbrowser-mcp-reports/pr/<number>/run/<id>-attempt-<attempt>/<sha>/
```

One CI run produces one combined matrix report retaining Linux/macOS/Windows,
Node and other environment variants. Missing producers are visible as incomplete
evidence. A second branch in the source repository is not a second independent
Pages site.

## Scope and ownership

After authorization, allowed source paths:
`.github/workflows/publish-test-report.yml`, `scripts/publish-test-report.mjs`,
report validation helpers from packets 02/03, reports-repository branch-based Pages
setup instructions, publisher unit/integration tests and fixtures,
and plan/checklist/handoff. The separate repository is an external delivery target,
not another source checkout implicitly authorized for mutation.

No edits to `release.yml`, documentation `site/`, existing Pages settings,
Docker base, runtime, required checks or default-branch history trust rules.
The report repository's exact owner/name must be confirmed before external setup;
`cloakbrowser-mcp-reports` is only an example.

### Publication flow and security

1. A trusted default-branch `workflow_run` publisher handles completed CI runs,
   including failed tests. Fetch PR/run/SHA/attempt identity through GitHub's API,
   not an artifact-supplied PR number or destination.
2. Download only that run's expected data artifacts and validate bounded schema,
   identities, paths, attachments, omissions and redaction. Never checkout/execute
   PR code or publish its supplied HTML/config/JavaScript. Generate HTML using
   trusted pinned reporting code/assets; reject unsafe evidence.
3. Publish one merged report retaining OS/architecture/Node/engine/level variants.
   Immutable path: `pr/<number>/run/<id>-attempt-<attempt>/<sha>/`.
   Restrict writes to this validated destination; preserve other runs and PRs.
4. Write generated output to the separate report repository using a GitHub App
   installation token scoped only to that repository with contents-write permission.
   Its branch-based Pages publication serves the reports site. No source
   documentation Pages permission or source contents-write grant is needed.
5. Await successful deployment and verify its exact entrypoint before linking.
   Re-fetch current PR head and latest eligible CI run, then update one bot-owned
   comment identified by a fixed marker. Link the same URL from publisher Job Summary.
   Comment includes tested SHA, counts, environment failures and incomplete status.
   An older run/attempt must not overwrite the newer link.
6. Serialize report-repository writes, use conflict-safe updates and idempotent
   run identity. Duplicate events do not create duplicate reports/comments.
7. Remove only public report paths older than 14 days through a scoped scheduled
   cleanup. Missing/expired report has an explicit unavailable state and an Actions
   run fallback (and artifacts while retained); no green empty page is generated.

The source publisher job alone gets actions-read and pull-requests-write.
Test jobs remain read-only and cannot access the report installation credential.
Fork results never update trusted history. The publisher must treat artifacts as
untrusted despite its privileged trigger. Pages output is public and is not a
secret store; no raw logs/results or credentials are committed to the report repo.

Separate project Pages repositories may share an origin. Repository separation
protects publishing ownership, not browser-origin isolation. Safe trusted rendering
and exclusion of arbitrary artifact HTML/assets are mandatory.

## Test-first acceptance

| Criterion | RED check, expected observation and PROVE |
| --- | --- |
| Matrix merge/link | Simulated completed run with distinct OS/Node producers produces one report; comment retains tested SHA and every environment result |
| Website preservation | Fake GitHub client rejects writes to source repository/Pages; publisher destination allowlist and scoped paths are observed; PROVE wrong-target mutation |
| No privilege crossing | Fork/malicious artifact attempts repo/path/PR substitution or executable HTML; rejection before write/execute; PROVE absence guard |
| Stale/rerun safety | Older SHA/run/attempt and duplicate event cannot overwrite a newer link or another PR's output; PROVE removing freshness/idempotency guard |
| Failure transparency | Failed tests still produce a truthful report; missing output/deploy failure produces explicit unavailable/incomplete state and no broken success link |
| Secret safety | Synthetic credential/header/capability canaries absent from published tree, comment and summary; second sanitization detects unsafe input |
| Retention/recovery | Fixed-clock 14-day cleanup removes only expired owned report paths, preserving live reports and unrelated files; publisher can be disabled without changing docs |
| Authorized live proof | Public URL opens actual merged report, PR comment resolves to its SHA/run and documentation deployment/site remain intact |

Write discriminating tests before publisher behavior. Use a fake GitHub API/client
for local mutation/permission tests, then separately authorized live proof for
deployment/link behavior. Correct checks must not be weakened. New absence,
structural and existing-behavior assertions require PROVE and restored mutations.

## Commands and prerequisites

Prerequisites: refreshed specification/review pins and packet 10. Add the named
tests before these existing runner commands:

```bash
rtk proxy npm exec -- vitest run tests/unit/test-report-publisher.test.ts tests/integration/test-report-publisher.test.ts
rtk proxy npm run check
rtk proxy docker run --rm -v "$PWD:/repo" --workdir /repo docker.io/rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 -color
rtk proxy python3 -m pipx run zizmor --min-severity high .
```

## Manual gates

Prepare reviewable code/tests/templates before requesting external activation.
MANUAL GATE: separately obtain exact target-repository confirmation, authorization for its
creation/Pages settings, GitHub App installation/credentials, and activation of
public publication/automatic PR comments. This plan edit grants none of those
external mutations. Do not create a repository, publish or message a PR now.

## Completion and stop

Required local or authorized live checks failing/unavailable leave this packet
incomplete. Roll back by disabling only the report publisher and retaining sanitized
Actions results/summary; do not alter documentation deployment. Record commands,
results, blockers and ownership in `todo.md`/`handoff.md`, recheck specification
freshness and stop. Commit/push/PR and downstream packets need separate authorization.
