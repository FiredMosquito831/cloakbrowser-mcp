# 06 — Transport and CDP failure recovery

Status: Planned; execution requires explicit packet authorization
Requirements: TEST-001, TEST-007, TEST-010, TEST-011
Dependencies: 01 and 03 complete; owned fixtures and safe reporter pass

## Pinned inputs

- `source_version`: `785424ba80d8dbf709c51901135a288276377b0a5aa08958d25c7d6ba2988a83`
- `specification_version`: `9eb3ca847f6421bd03834981a659066362922abcffcd79605c63d04cd9e30a7e`
- `review_ref`: `28b4daa7-1f0e-4286-ace1-eace5f685e70`
- CWD for every command: `/home/dmitry-vasiliev/.codex/worktrees/release-v1-15-0/cloakbrowser-mcp`
- Recheck pins through scenario MCP, Git status including staged/untracked files,
  and the source evidence below before editing. Preserve unrelated changes.

## Outcome and evidence

Close demonstrated gaps in CLI/config, stdio, Streamable HTTP and managed CDP
failure/recovery behavior, retaining sufficient existing boundary tests.

Evidence: `src/http/server.ts:93`, `src/http/sessionStore.ts:25`;
`tests/integration/streamable-http.test.ts:617` dynamic tools/isolation,
`:710` unknown session, `:730` invalid DELETE version, `:752` child shutdown,
`:1269` capacity, `:1296` aborted initialization, `:1391` auth, `:1415` TLS.
CDP ownership: `src/cdp/session.ts:33`. Real checks:
`tests/e2e/cdp-access.manual.ts:110`, `:284`, `:655`, `:680`.
Current Pro/multi-session gating at `:25` must be reconciled with verified Free,
without deleting required concurrent scenarios for a green result.

## Scope and ownership

Allowed: existing CLI/config/server/session-store unit tests, proxy/HTTP/CDP
integration suites and fake-upstream fixture, `tests/e2e/cdp-access.manual.ts`,
bounded distribution/harness helpers and plan/checklist/handoff.
Only a proven bridge defect permits changes in `src/server.ts`, `src/http/`,
`src/cdp/`, CLI lifecycle or configuration ownership. Do not introduce a native
adapter, new authentication/origin policy, upstream tools or new transport contract.

Fake upstream owns injected protocol failure, cancellation and child disconnect.
HTTP controller owns session lifecycle; CDP runtime owns generation, challenge,
proxy sockets and browser resources. Tests observe public responses/events/ports,
not snapshots exposing mutable private state. Test harness depends on runtime,
never vice versa.

## Test-first acceptance

Packet 01 inventory identifies exactly which assertions below are missing.
Link already sufficient tests rather than recreate every boundary.

| Area | Positive/negative/failure observation |
| --- | --- |
| CLI/config | Help/version/doctor, documented CLI/env precedence and engine selection; invalid config/startup fail with actionable redacted stderr |
| Packaged stdio | Valid MCP exchange and clean stdout framing from first launch; wrong inputs/upstream errors remain explicit; shutdown closes owned child |
| Streamable HTTP | Initialization/session isolation, unknown/expired IDs and correct status; one failed session does not corrupt another |
| Cancellation/disconnect | Inject cancellation and unexpected upstream exit using fake server; response/closure matches current SDK/bridge contract, no abandoned session/child |
| Real CDP HTTP/WS | Observe real browser state shared with MCP, concurrent session isolation and generation rotation after browser close |
| CDP security | Retain actual auth/capability/origin/TLS positive and rejection paths; redacted diagnostics never reveal usable capabilities |
| Recovery/cleanup | After injected browser/upstream failure, a supported fresh session navigates local page; old owned ports/children close |

Do not invent reconnection where the existing transport contract requires a new
session. No required Free capability test is silently skipped; demonstrated upstream
or Free limitation is a blocker with evidence.

RED: write missing assertions before fixes; use fake upstream only for protocol
boundaries. Browser-facing claims require real npm CLI/Chromium. PROVE absence,
structural wiring and newly written checks of existing behavior by suppressing the
specific cleanup/isolation/security boundary once, restoring it afterward.

## Commands and prerequisites

Prerequisites: 01/03; verified Free, controlled Playwright executable for the other
supported engine, loopback/TLS helper support.

```bash
rtk proxy npm run test:unit
rtk proxy npm exec -- vitest run tests/integration/proxy.test.ts tests/integration/streamable-http.test.ts tests/integration/cdp-lifecycle.test.ts
rtk proxy npm run test:e2e
rtk proxy npm run test:e2e:cdp
rtk proxy npm run test:report -- --suite cdp
rtk proxy npm run check
```

Add changed CDP integration files to the focused command when applicable.
Report mocks, real engines, executed/skip counts and unavailable platform evidence
separately; passing fake upstream is not Chromium recovery evidence.
## Completion and stop

Keep the packet incomplete if any required check fails or cannot run. Record exact
commands, results, skips, environment and blockers; update the sole checklist
`todo.md` and replace `handoff.md`. Recheck specification freshness and stop after
this packet. Review is optional and separately invoked.

MANUAL GATES: explicit authorization for this packet; commit/push/PR, remote CI
dispatch and publication remain separate. No downstream packet is authorized.
