# Execution checklist

Status: Planned; specification approved; explicit packet authorization required

This is the sole completion checklist. A checked packet means all its required
criteria and checks passed with evidence in the current handoff and plan.
Dependency completion and plan approval do not authorize execution.

| Packet                                                               | Dependency eligibility                                        | Completion |
| -------------------------------------------------------------------- | ------------------------------------------------------------- | ---------- |
| [01 — Inventory and Free fixtures](01_inventory-and-fixtures.md)     | Approved specification; executed on explicit skill invocation | [x]        |
| [02 — Safe evidence and merge](02_safe-results.md)                   | 01; executed on explicit skill invocation                     | [x]        |
| [03 — Public Vitest / Allure](03_vitest-and-allure.md)               | 02                                                            | [ ]        |
| [04 — Real browser tools](04_browser-tools.md)                       | 01, 03                                                        | [ ]        |
| [05 — Profiles and state](05_profiles-and-state.md)                  | 04                                                            | [ ]        |
| [06 — Transports / CDP](06_transports-and-cdp.md)                    | 01, 03                                                        | [ ]        |
| [07 — Proxy / GeoIP](07_proxy-and-geoip.md)                          | 04                                                            | [ ]        |
| [08 — Both extension mechanisms](08_extensions.md)                   | 01, 03                                                        | [ ]        |
| [09 — Humanize / resources](09_humanize-and-resources.md)            | 04–08                                                         | [ ]        |
| [10 — CI / periodic lanes](10_ci-reporting.md)                       | 03–09                                                         | [ ]        |
| [13 — Separate Pages / PR report link](13_public-report-delivery.md) | 10; approved external setup                                   | [ ]        |
| [11 — Functional / platform acceptance](11_functional-acceptance.md) | 10, 13                                                        | [ ]        |
| [12 — Developer docs / translations](12_developer-documentation.md)  | 11                                                            | [ ]        |

Failed or unavailable required checks leave the owning row unchecked.
Missing native runners, real extension capability and Docker execution remain
blockers; only explicitly approved scope changes can remove a key requirement.
Review is optional, and commit/push/PR/publication require separate authorization.

Selected delivery components are explicit in `plan.md` and packet 13:
Allure Report 3, `peaceiris/actions-gh-pages` and
`allure-framework/allure-action`; proposed destination
`swimmwatch/cloakbrowser-mcp-reports`. Action SHA selection/audit and external
repository setup are still pending, not completed checklist items.

Specification reconciliation is complete: independent review passed 22/22 items;
MCP reports pass/reviewed and Approved. All packet pins were refreshed.
Packet 01 is complete: 12 new controlled tests, inventory and cleanup verification;
`npm run check` passed. Packet 02 is complete: 43 new controlled tests and atomic, sanitized evidence
persistence/merge; `check` and `package:verify` passed. The next implementation
packet is 03, owned by the main agent on the next explicit invocation. No downstream packet or external setup
is authorized by completion of packet 01.
