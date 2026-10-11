# Test execution and CI reports

Run fast checks with `npm run check`. Real browser suites use installed npm
packages and local fixture pages:

- `npm run test:e2e:cdp`: managed CDP with Free CloakBrowser and Playwright.
- `npm run test:e2e:playwright-console`: console methods across clean sessions.
- `npm run test:e2e:npm-package`: standard tools, persistent state and humanization.

The required E2E matrix runs CLI, console and managed CDP on Linux x64/arm64,
macOS Intel/ARM and Windows x64 with Node 26. A Linux Node 22 matrix cell preserves
managed CDP coverage on the minimum supported Node major. CDP still runs if another
browser suite fails, provided Chromium installation succeeded. Required CI checks
the complete matrix; no browser failure is allowed to pass silently.

Free browser fixtures reuse a verified cached binary or download an authenticated
Free binary into an owned temporary cache. Downloads do not inherit license,
preview, custom mirror or browser override settings. Test cleanup removes owned
downloads, profiles and processes. An explicit unverified override fails clearly.
Console tests pass the installed Playwright executable explicitly, avoiding a
revision mismatch with upstream MCP's bundled Playwright.

CI uploads sanitized results from each matrix cell. The aggregation job expects
90 producers, including six managed CDP producers, and generates a combined HTML
report. Missing producers and failed tests make aggregation fail. Reports are
available as Actions artifacts; public publication requires the trusted publisher
workflow to reach the default branch.

Local reporting commands:

```bash
npm run test:report -- --suite unit --run-id local
npm run test:report:generate -- --input artifacts/test-results --output artifacts/test-report/local
npm run test:report:open -- --report artifacts/test-report/local
```

Use the actual output directory reported by the collector as generation input.
Never add real secrets or external page screenshots to diagnostic fixtures.

Docker parity tests compare the tools and complete schemas of the pinned image.
They test `browser_find.filename` only when that upstream schema provides it and
record its availability in the parity report. Passing Docker MCP 0.0.82 parity
provides no evidence for npm MCP 0.0.83; the npm suite checks filename persistence
separately. Release completion remains blocked on the agreed official Docker base.
