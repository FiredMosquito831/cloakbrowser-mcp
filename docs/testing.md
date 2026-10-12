---
description: Testing strategy for CloakBrowser MCP unit tests, fake upstream integration tests, Docker smoke tests, and Playwright MCP parity checks.
icon: material/test-tube
tags:
  - Testing
  - Project Internals
---

# Testing

## Unit Tests

```bash
npm run test:unit
```

Unit tests cover environment parsing, bridge config generation, launch argument handling, and local Cloak introspection tools.

## Integration Tests

```bash
npm run test:integration
```

Integration tests use a fake upstream MCP child process and verify that the bridge merges local tools and forwards upstream calls unchanged.

`npm run check` includes unit, integration, and packaged CLI checks. The CLI suite runs the built `dist/cli.js` against fake upstream MCP; it does not launch Chromium. CI runs these checks and package verification on Node.js 22 and 24-26 across Linux x64, Linux arm64, macOS arm64, macOS x64, and Windows x64.

## Real Browser And Distribution Tests

```bash
npm run test:e2e
npm run test:e2e:playwright-console
npm run test:e2e:cdp
npm run test:e2e:npm-package
npm run test:e2e:docker
npm run test:e2e:cdp:docker
```

`test:e2e` combines fake-upstream CLI checks with real Playwright Chromium console checks. `test:e2e:playwright-console` verifies console methods across clean browser sessions. `test:e2e:cdp` verifies managed Chrome DevTools Protocol (CDP) access with Free CloakBrowser and controlled Playwright Chromium.

`test:e2e:npm-package` packs and installs the package into a temporary project. Its forwarding-contract check uses fake upstream; browser scenarios use real CloakBrowser and local pages to check standard tools, persistent state, and both humanization presets. A separate case checks concurrent cold-cache downloads and clean stdout. Package verification alone is not browser acceptance.

The required browser CI matrix runs CLI and console checks on Node.js 26 across the five platforms listed above. Managed CDP uses the same matrix plus Linux x64 on Node.js 22. Docker distribution and managed CDP acceptance run on both `linux/amd64` and `linux/arm64`.

The separate Functional test reporting workflow runs the npm-package, proxy/GeoIP, extensions, and lifecycle suites weekly and on manual dispatch. It uses Node.js 24 across the same five platforms. The full npm humanization suite is part of this heavier workflow.

## Test Reports

Each CI matrix cell uploads sanitized results and diagnostic attachments. The aggregation job combines them into one Allure HTML report while retaining suite and environment labels. Missing expected producers and failed tests fail aggregation; raw results and the HTML report remain available as Actions artifacts.

Eligible PR runs can publish a report link through the configured separate reports repository. Publication requires enabled delivery, validated run evidence, and successful Pages verification. The documentation site is deployed separately. Public reports contain only allowlisted, sanitized diagnostics from controlled test fixtures.

```bash
npm run test:report -- --suite unit --run-id local
npm run test:report:generate -- --input artifacts/test-results --output artifacts/test-report/local
npm run test:report:open -- --report artifacts/test-report/local
```

Use the collector's actual output directory as generation input. See [Contributing](contributing.md) for report formats, attachments, and CI delivery details.

## Package Verification

```bash
npm run package:verify
```

This builds the package, runs `npm pack`, checks the tarball file list, installs the tarball into a temporary project, and verifies CLI `--version` and `--help`.

Package verification also validates `server.json` against the published MCP server schema.

## Docker Smoke

```bash
npm run docker:build
npm run docker:smoke
```

The smoke test verifies that the built image starts and prints CLI help. CI smoke-tests Docker images for `linux/amd64` and `linux/arm64`.

## Upstream Parity

```bash
npm run bridge:compare
npm run bridge:compare -- cloakbrowser-mcp:dev --report bridge-parity-report.json
```

The parity script starts the official Playwright MCP Docker image and the CloakBrowser bridge image, compares upstream tool names, exercises the default browser tool surface on one fixture page, and verifies local Cloak introspection tools.

CI uploads the JSON parity report as an artifact for Docker build jobs and release jobs. Browser parity runs on `linux/amd64`; both architectures also run smoke, vulnerability, distribution, and managed CDP checks. Parity validates the pinned Docker MCP version and does not establish acceptance of a different npm MCP version.

## Security Checks

```bash
npm run audit:prod
npm run server:validate
```

CI also runs CodeQL, Dependency Review, OpenSSF Scorecard, zizmor, and Trivy. These tools are free for public repositories and do not require external accounts.
