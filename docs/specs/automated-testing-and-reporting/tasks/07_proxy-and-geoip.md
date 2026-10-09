# 07 — Controlled proxy routing and GeoIP

Status: Planned; execution requires explicit packet authorization
Requirements: TEST-005, TEST-007, TEST-010, TEST-011
Dependencies: 04 complete; observable navigation and safe fixtures pass

## Pinned inputs

- `source_version`: `785424ba80d8dbf709c51901135a288276377b0a5aa08958d25c7d6ba2988a83`
- `specification_version`: `9eb3ca847f6421bd03834981a659066362922abcffcd79605c63d04cd9e30a7e`
- `review_ref`: `28b4daa7-1f0e-4286-ace1-eace5f685e70`
- CWD for every command: `/home/dmitry-vasiliev/.codex/worktrees/release-v1-15-0/cloakbrowser-mcp`
- Recheck pins through scenario MCP, Git status including staged/untracked files,
  and the source evidence below before editing. Preserve unrelated changes.

## Outcome and evidence

Prove browser traffic routing and actual proxy-IP/database matching using local
services. Verify documented failures, overrides and clean recovery.

Evidence: `src/bridge/config.ts:1144` resolves proxy inputs;
`tests/unit/config.test.ts:1016` uses injected launch options, not real lookup;
`node_modules/cloakbrowser/dist/geoip.js:70` resolves proxy IP and MMDB,
`:155` declares echo endpoints, `:306` cache path, `:320` ensures database.
`docs/geoip-proxy-matching.md:170`, `:177`, `:206` own override/fail-closed/
browser-flag request API behavior. Preserve those contracts.

## Scope and ownership

Allowed: `tests/e2e/proxy-geoip.manual.ts`, `tests/helpers/browser-proxy.ts`,
bounded TLS/helper extensions, `tests/fixtures/geoip/`, relevant config tests,
distribution fixture helpers, reporter suite selection and plan/checklist/handoff.
Only a proven bridge defect permits changes within proxy/GeoIP configuration in
`src/bridge/config.ts`. No dependency-private fetch wrappers or new runtime options.

Local proxy owns HTTP/CONNECT/SOCKS sockets and an observable request ledger.
It routes only allowlisted fixture/echo authorities, rejecting everything else.
Use synthetic hostnames routed by the proxy; explicit bypass uses a separately
mapped local hostname and existing launch-argument support, so Chromium's implicit
loopback bypass cannot falsely prove the configured bypass rule. Credentials are
synthetic and never stored in reports. No public origin/proxy/GeoIP service call.

Pin MaxMind City-Test fixture to commit
`6a690a705bc6962c0025a32e94a8f0dc8f86418c`, blob
`e20846ac1757a3745ae41411757ed3817536e3be`, 22,569 bytes; retain MIT notice.
Readiness: actual `mmdb-lib` Reader lookup for `81.2.69.160` returns GB /
Europe/London; expected locale is en-GB. Copy the DB into
`<temporary-cache>/geoip/GeoLite2-City.mmdb` with fresh mtime.

CONNECT echo fixture uses SAN certificates for the three upstream authorities
(api.ipify.org, checkip.amazonaws.com, ifconfig.me); trust its test CA only in the
bridge child via `NODE_EXTRA_CA_CERTS`. Never set TLS verification to zero.
Do not patch `resolveProxyGeo` or inject a fixed launch result on the healthy path.
For missing DB, a temporary test-only Node preload rejects only the known DB
download URL to inject offline failure; disclose this distinction. Real exit-IP
discovery and real MMDB read remain exercised in their respective cases.

## Test-first acceptance

| Scenario | Actual observation |
| --- | --- |
| HTTP/authenticated HTTP/SOCKS routing | Proxy ledger records controlled origin request and browser renders exact fixture marker; configured fallback/native path matches selected Free capabilities |
| Bypass | Mapped bypass origin renders directly with no ledger request; a separate non-bypass origin still routes through proxy |
| Proxy failure/recovery | Unavailable/rejecting proxy returns expected navigation error; fresh valid runtime renders content; all old sockets close |
| GeoIP healthy | Ledger sees echo through proxy; actual browser Intl timezone and locale/language match Europe/London/en-GB |
| Disabled/explicit override | Matching disabled causes no echo query; supported explicit timezone/lang/locale overrides produce their exact configured browser values |
| Lookup failure | No record, corrupt/unavailable DB and bounded echo timeout fail closed with expected diagnostic, release profile/child ownership, then valid restart succeeds |
| Security | Credentials/capability canaries absent from persisted/merged reports and logs; no rejected authority is contacted |

Derive native auth capability from current Free behavior; do not silently switch
to licensed Chromium. Request APIs `context.request`, `page.request` and
`route.fetch()` retain documented browser-flag limitations; real browser navigation/
in-page fetch is routing evidence.

RED: add assertions and run them before fixtures/fixes. A new fixture that makes an
existing feature pass requires PROVE by returning wrong echo IP/payload or disabling
one intended routing/bypass/cleanup boundary. Absence assertions also require PROVE.
Use bounded state/event waits; no flaky public network readiness or sleep retries.

## Commands and prerequisites

Prerequisites: 04, Free executable, local TLS support; exact fixture download during
preparation is verified, after which scenarios use only local services.
Add `proxy-geoip` to the development reporter's suite selector.

```bash
rtk proxy npm exec -- vitest run tests/unit/config.test.ts
rtk proxy npm exec -- vitest run --config vitest.distribution-e2e.config.mjs tests/e2e/proxy-geoip.manual.ts
rtk proxy npm run test:report -- --suite proxy-geoip
rtk proxy npm run check
```

Record lookup/routing observations separately from fault injection. Upstream
fail-closed/Free defects or unavailable TLS support remain blockers.
## Completion and stop

Keep the packet incomplete if any required check fails or cannot run. Record exact
commands, results, skips, environment and blockers; update the sole checklist
`todo.md` and replace `handoff.md`. Recheck specification freshness and stop after
this packet. Review is optional and separately invoked.

MANUAL GATES: explicit authorization for this packet; commit/push/PR, remote CI
dispatch and publication remain separate. No downstream packet is authorized.
