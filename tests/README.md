# Test reports

The existing unit, integration and packaged CLI suites use an opt-in Vitest
reporter. Allure Report 3 generates HTML from validated, sanitized results.
Coverage thresholds and Codecov remain unchanged.

## Worker processes

All three Vitest configurations run test files in separate Node.js processes
(`pool: 'forks'`, `fileParallelism: true`). With `CI=true` or `CI=1`, the worker
limit is `os.availableParallelism()`, computed independently on each runner.
Locally, the limit is the smaller of four and the available CPU parallelism.
This is a maximum: a run with fewer files uses fewer workers. Tests inside each
file remain sequential unless explicitly marked concurrent.

Override the limit with Vitest's standard CLI option:

```bash
npm run test:unit -- --maxWorkers=8
npm run test:integration -- --maxWorkers=2
npm run test:coverage -- --maxWorkers=4
npm run test:e2e:run -- --maxWorkers=1
npm run test:e2e:npm-package -- --maxWorkers=2
```

Pass the flag to a direct Vitest npm script; `npm run check` is a chain of
commands and does not forward it to every test stage.

## Local use

```bash
npm run test:report:probe
npm run test:report -- --suite unit --run-id local-unit
npm run test:report:generate -- --input artifacts/test-results/local-unit --output artifacts/test-report/local-unit
npm run test:report:open -- --report artifacts/test-report/local-unit
```

Use `--suite integration` or `--suite cli` for those suites. Each invocation needs
a fresh run ID. A failing suite returns a nonzero status while preserving its
sanitized evidence. Generation and viewing are separate commands, so failed runs
can still be inspected. Generated files stay under ignored `artifacts/` paths.
`test:report:merge` preserves each producer's manifest, so the combined run may
contain more than 10000 results while the limit per producer remains unchanged.

## GitHub Actions and PR links

CI uploads `test-results-*` artifacts from existing test jobs and merges the
matrix into `combined-test-report-attempt-<number>`. Artifact names include the
attempt number to avoid upload conflicts on reruns. Partial reruns reuse existing
jobs' evidence and select the latest available attempt for each producer within
the same CI run. A failed or corrupt latest result never falls back to an older
passing result. The Job Summary lists totals, failures and
missing producers. Required checks retain their existing failure behavior.

The trusted default-branch publisher validates producer data and regenerates HTML
without executing PR code or publishing producer-supplied HTML. It publishes to
the separate `swimmwatch/cloakbrowser-mcp-reports` repository and updates one
verified bot-owned PR comment after checking the Pages build and exact HTML.

Reports retain OS, architecture, Node.js version, suite and lane labels. Each
link identifies the PR head SHA, CI run and attempt:

```text
https://swimmwatch.github.io/cloakbrowser-mcp-reports/pr/<number>/run/<id>-attempt-<attempt>/<sha>/
```

Artifacts and public reports have 14-day retention. Unavailable publication uses
an Actions-run fallback. Main project documentation Pages is unchanged.

## Configuration and security

Source repository Actions variables:

- `TEST_REPORT_REPOSITORY=swimmwatch/cloakbrowser-mcp-reports`
- `TEST_REPORT_APP_CLIENT_ID`: the reports App client ID
- `TEST_REPORT_PUBLICATION_ENABLED=true`: publication and daily owned-path cleanup

Store the App private key only in Actions secret `TEST_REPORT_APP_PRIVATE_KEY`.
The App installation is limited to the reports repository, with Contents write,
Pages read and implicit Metadata read. Test jobs receive no publication credential.

The reports site is public. Sanitization removes supported credential patterns
and supplied secret values; it cannot recognize arbitrary sensitive prose. Use
controlled fixtures and do not put private user data into test names or evidence.
Raw logs, arbitrary screenshots/assets and executable producer content are not
published. Setting the enable variable to `false` stops publication and cleanup;
it does not remove already published reports.

Extended periodic browser scenarios remain in the release worktree until their
browser/runtime prerequisites are delivered. This reporting delivery instruments
the existing PR matrix and does not schedule unavailable test suites.
