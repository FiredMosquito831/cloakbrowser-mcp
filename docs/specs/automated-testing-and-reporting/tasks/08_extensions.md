# 08 — Real extension attachment

Status: Planned; execution requires explicit packet authorization
Requirements: TEST-007, TEST-010, TEST-011
Dependencies: 01 and 03 complete; Free ownership, safe reports and local pages available

## Pinned inputs

- `source_version`: `785424ba80d8dbf709c51901135a288276377b0a5aa08958d25c7d6ba2988a83`
- `specification_version`: `9eb3ca847f6421bd03834981a659066362922abcffcd79605c63d04cd9e30a7e`
- `review_ref`: `28b4daa7-1f0e-4286-ace1-eace5f685e70`
- CWD for every command: `/home/dmitry-vasiliev/.codex/worktrees/release-v1-15-0/cloakbrowser-mcp`
- Recheck pins through scenario MCP, Git status including staged/untracked files,
  and the source evidence below before editing. Preserve unrelated changes.

## Outcome and evidence

Automate both existing mechanisms: unpacked extension loading and connection
through the official Playwright Extension. Configuration mocks alone are insufficient.

Evidence: `src/bridge/config.ts:364` validates connection mode/conflicts;
`tests/unit/config.test.ts:1145` covers unpacked configuration;
`docs/recipes/load-chrome-extension.md:11` distinguishes mechanisms;
`docs/configuration.md:281` owns token/profile restrictions;
installed upstream relay at
`node_modules/@playwright/mcp/node_modules/playwright-core/lib/coreBundle.js:75016`,
`:75025`, `:75075` selects executable/profile, token and connection timeout.
The source commit matching upstream core is
`e8149b8257d32dcf8f72573ecc43e72439da7080`:
`packages/extension/` and the
[upstream extension fixture](https://github.com/microsoft/playwright/blob/e8149b8257d32dcf8f72573ecc43e72439da7080/tests/extension/extension-fixtures.ts#L49).

## Scope and ownership

Allowed: `tests/e2e/extensions.manual.ts`, `tests/helpers/browser-extension.ts`,
`tests/fixtures/extensions/`, existing extension/config/HTTP tests,
distribution/TLS helpers as narrowly needed, reporter selector and
plan/checklist/handoff. Official extension build/download data live only in
owned temporary directories; retain Apache-2.0 notices/pin metadata.
No project dependency additions for its build, Web Store install/update,
personal profile, runtime relay rewrite or new public options.

Prepare official extension 0.4.0 from the exact pinned Playwright tree and its
lockfile in a disposable checkout; run the upstream Vite extension build there.
Derive extension ID from the pinned manifest. Fixture starts headed known Free
Chromium with an explicit persistent profile and official unpacked extension;
preserve singleton behavior as the official fixture does by omitting
`--enable-automation`. Register actual extension/profile installation state
following upstream's test fixture, not a fake relay handshake.

Read the synthetic profile token through the real extension UI, pass it only via
existing process-level token configuration, and select profile using the existing
bridge userDataDir/profileDirName settings. Harness owns token, browser, worker,
client and checkout; screenshots may show only the controlled local page, never
extension connect URLs/token UI. Linux headed runs use an available display/Xvfb;
other native runners require their actual display capability.

## Test-first acceptance and early feasibility

Run an early real attachment probe before implementing the full suite. It must
show actual official extension readiness, client attachment and a local-page action
through the installed package. Record Free version/platform and display evidence.
If Free/singleton/extension support is unavailable, leave the packet blocked;
do not replace attachment with mocks, Pro or private test adapters.

| Mechanism | Required assertions |
| --- | --- |
| Unpacked launch | Controlled content script changes local page marker; persistent-profile requirement and unsupported config combinations remain tested |
| Official attachment | Client binds to controlled browser tab; MCP click/navigation changes actual page; no separate competing browser launches |
| Token/pairing rejection | Missing/wrong token is explicitly rejected or times out with documented error; browser/page remains usable and no unauthorized action occurs |
| Disconnect/recovery | Extension-side disconnect becomes an explicit client failure; supported fresh pairing/restart acts on the page again |
| Isolation/cleanup | Dedicated profiles remain isolated; browser/worker/relay sockets/clients/checkout close on success, wrong token and partial startup |

RED: write action/rejection/cleanup assertions first, then make fixture executable.
PROVE newly written existing-behavior and absence assertions by withholding
extension loading, changing synthetic token or suppressing the controlled effect
one at a time. Restore all mutations. Match exposed errors without hardcoding
private implementation strings.

## Commands and prerequisites

Prerequisites: 01/03, known Free, actual headed display, locked upstream extension
build prepared in a temp root. Declare `extensions` reporter selector.

```bash
rtk proxy npm exec -- vitest run tests/unit/config.test.ts
rtk proxy npm exec -- vitest run --config vitest.distribution-e2e.config.mjs tests/e2e/extensions.manual.ts
rtk proxy npm run test:report -- --suite extensions
rtk proxy npm run check
```

Recheck required native-platform execution in packets 10/11; a Linux success does
not prove macOS/Windows. Positive/negative attachment must precede final docs
removing the old manual-only statement.
## Completion and stop

Keep the packet incomplete if any required check fails or cannot run. Record exact
commands, results, skips, environment and blockers; update the sole checklist
`todo.md` and replace `handoff.md`. Recheck specification freshness and stop after
this packet. Review is optional and separately invoked.

MANUAL GATES: explicit authorization for this packet; commit/push/PR, remote CI
dispatch and publication remain separate. No downstream packet is authorized.
