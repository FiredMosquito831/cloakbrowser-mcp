# 09 — Humanize and repeated resource cleanup

Status: Planned; execution requires explicit packet authorization
Requirements: TEST-007, TEST-010, TEST-011
Dependencies: 04–08 complete; relevant browser, profile, transport, proxy and extension evidence available

## Pinned inputs

- `source_version`: `785424ba80d8dbf709c51901135a288276377b0a5aa08958d25c7d6ba2988a83`
- `specification_version`: `9eb3ca847f6421bd03834981a659066362922abcffcd79605c63d04cd9e30a7e`
- `review_ref`: `28b4daa7-1f0e-4286-ace1-eace5f685e70`
- CWD for every command: `/home/dmitry-vasiliev/.codex/worktrees/release-v1-15-0/cloakbrowser-mcp`
- Recheck pins through scenario MCP, Git status including staged/untracked files,
  and the source evidence below before editing. Preserve unrelated changes.

## Outcome and evidence

Retain existing real humanize coverage, add only missing assertions, and prove
bounded repeated lifecycle cleanup across successful and failed scenarios.

Evidence: `tests/e2e/npm-package.manual.ts:239` already covers both presets,
tabs/iframes/locators/inputs/modifiers/errors and detached DOM; `:401` checks
concurrent cold-cache downloading and stdout. Weak-reference/frame checks exist
at `tests/unit/humanize-compatibility.test.ts:46` and `:93`.
Compatibility ownership: `src/runtime/humanizeCompatibility.ts:6`,
`src/runtime/humanizeCompatibilityLoader.ts:17`, `:37`.
Startup rollback: `src/bridge/config.ts:250`; CDP disposal:
`src/cdp/session.ts:599`, `:613`, `:676`.

## Scope and ownership

Allowed: `tests/e2e/npm-package.manual.ts`, `tests/e2e/browser-lifecycle.manual.ts`,
existing humanize/CDP/HTTP lifecycle tests, owned runtime fixture helper,
narrow reporter selector/diagnostic changes and plan/checklist/handoff.
Only confirmed defects justify changes in existing humanize compatibility hook,
bridge/HTTP/CDP disposal owners. Keep `humanizeBrowser`/`patchContext`,
source hash guard and unchanged upstream contracts. No license use or replacement
private adapter; no speculative memory framework.

Fixture registers owned children/servers/clients/profiles/cache resources once.
Disposal is idempotent and awaits completion, including partial-start failure.
Use public process exit/close, socket close, reconnect refusal and successful
profile reacquisition. Tests must not kill arbitrary OS browsers.

## Test-first acceptance

| Scenario | Observation and bound |
| --- | --- |
| Both presets | default/careful pass real existing/new-tab, iframe-visible/hidden, complex/ambiguous locator, special field, modifier and MCP error cases; add missing outcomes only |
| Detached DOM | Existing collection check observes element references disappear after detach and bounded explicit collection; retained live element remains valid |
| Repeated success/failure | At least five sequential lifecycle cycles per selected owner; successful start, partial-start failure and browser/upstream failure each close owned resources |
| HTTP/CDP/profile | Session failure does not leak child or port; stale generation unavailable; same explicit profile can be acquired after shutdown |
| Proxy/extension | Negative setup/pairing/routing paths release sockets/browser resources observed in packets 07/08 |
| Concurrent download | Two real Free processes share an empty isolated cache; exact usable binary, clean stdout protocol and no leftover partial download/locks |
| Diagnostics | Unexpected failures retain bounded redacted stderr, owned PID and exit/signal; fixture screenshot only when local controlled page is available |

Resource close deadline is 10 seconds after initiating disposal; a deadline failure
fails the owning scenario. Readiness uses events/bounded conditions, not a fixed
sleep. Keep intentional navigation survival delays distinct from readiness.
Long RSS trends are supplemental P2 and cannot substitute deterministic cleanup.

RED: write uncovered assertions before fixes. New checks of existing behavior,
absence/cleanup and structural hook wiring require PROVE: retain one detached
element, suppress one owned disposal, or break one hook guard separately, confirm
the intended assertion fails, then restore. Do not weaken source hash verification,
drop ambiguous-locator cases or erase a failure with automatic retries.

## Commands and prerequisites

Prerequisites: 04–08 evidence, verified Free, actual local fixture/display/TLS
capabilities. Add `lifecycle` development reporting selector.

```bash
rtk proxy npm exec -- vitest run tests/unit/humanize-compatibility.test.ts tests/unit/humanize-compatibility-registration.test.ts tests/unit/humanize-init-page.test.ts
rtk proxy npm run test:e2e:npm-package
rtk proxy npm exec -- vitest run --config vitest.distribution-e2e.config.mjs tests/e2e/browser-lifecycle.manual.ts
rtk proxy npm run test:report -- --suite lifecycle
rtk proxy npm run check
```

Record actual child/socket/profile outcomes and iterations, not a broad claim that
one heap sample proves memory safety. Failed download, cleanup or browser capability
is required evidence still missing and leaves the packet incomplete.
## Completion and stop

Keep the packet incomplete if any required check fails or cannot run. Record exact
commands, results, skips, environment and blockers; update the sole checklist
`todo.md` and replace `handoff.md`. Recheck specification freshness and stop after
this packet. Review is optional and separately invoked.

MANUAL GATES: explicit authorization for this packet; commit/push/PR, remote CI
dispatch and publication remain separate. No downstream packet is authorized.
