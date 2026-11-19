# Secret Agent Browser MCPs

A collection of adapted MCP tools for popular stealth-automation browsers, through the Playwright MCP contract.

Derived from [swimmwatch/cloakbrowser-mcp](https://github.com/swimmwatch/cloakbrowser-mcp) (MIT): the bridge, its CLI, packaging and the [`docs/`](docs/) tree are upstream's. This repository adapts them into a Claude Code plugin marketplace and adds a complete, proper stealth implementation for agentic harnesses and tasks. Full attribution is in [NOTICE](NOTICE).

## Install

This repository is a Claude Code plugin marketplace named `cloakbrowser-mcp`. The marketplace name and both plugin ids keep their existing values, so installed configurations, tool prefixes and data directories stay where they are.

```bash
/plugin marketplace add FiredMosquito831/secret-agent-browser-mcps
/plugin install cloakbrowser@cloakbrowser-mcp   # universal broker, default
/plugin install camoufox@cloakbrowser-mcp       # fixed Camoufox engine
```

Install one path per engine. Plugin settings are per plugin and are not carried across; a Kameleo per-engine plugin is not shipped. See the [cloakbrowser](plugins/cloakbrowser/README.md) and [camoufox](plugins/camoufox/README.md) plugin READMEs. For the upstream bridge's npm, Docker and Streamable HTTP installation, see [Getting started](docs/getting-started.md) and [Docker](docs/docker.md).

## Per-harness installation

Reserved for the installer CLI: a later release will generate each harness's configuration from the CLI's own help, so the snippets cannot drift from the tool. No harness-specific configuration is duplicated here.

## Plugins

| Plugin | Engine | What it adds |
|---|---|---|
| `cloakbrowser` | selectable: `cloak` (default), `playwright`, `camoufox`, `camoufox-native`, `kameleo` | the 77-tool CloakBrowser surface, a manifest-driven broker, and every engine setting |
| `camoufox` | fixed `camoufox` (stealth Firefox) | only the settings that engine honours; 27 tools at the portable profile, 70 at full; provisions its own Python runtime |

## What this repository adds

- **One broker, five engines.** `cloak` (CloakBrowser Chromium), `playwright` (stock Chromium), `camoufox` (stealth Firefox through a pinned wrapper), `camoufox-native` (the native PyPI server) and `kameleo` (CDP attach, live-unverified), selected through a manifest-driven registry.
- **A stable tool surface.** Microsoft's Playwright MCP contract with `portable` and `full` profiles, seven tool-group switches and `disabled_tools`: 77 tools at `full` for the universal plugin, 70 for the Camoufox plugin, 27 at `portable` for both.
- **Session-safe profiles.** Per-account, workspace, isolated, copy, copy-keep and session modes; lock preflights, one-seat CloakBrowser gating, copies that never lose data, lazy profile lifetime and a tool-list cache that keeps a cold start usable.
- **No manual browser dependencies.** The first start provisions the pinned npm runtime, checksum-verified `uv`, a managed CPython and the engine venvs under plugin data. The CloakBrowser Chromium binary downloads to `~/.cloakbrowser` on first use.
- **Camoufox corrections.** An always-on overlay restores the stock search engines; saved logins are opt-in, device identity can be pinned to a profile, and the heartbeat is configurable. The broker also recovers from a dead backend with one bounded restart.
- **Weekly upstream sync** with pin guards and a handled-conflict flow, documented in [scripts/upstream-sync/README.md](scripts/upstream-sync/README.md).

## Where the browsers come from

| Engine | Source | Credit and licence |
|---|---|---|
| `cloak` | [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) stealth-patched Chromium | Proprietary binary. The v146 build is free; more than one concurrent session needs a vendor licence. |
| `playwright` | Stock Playwright Chromium, driven by [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Tool names and schemas are Microsoft's; parity is structural, not a reimplementation. |
| `camoufox` | [Camoufox](https://github.com/camoufox-org/camoufox) stealth Firefox, driven by the pinned [camoufox-playwright-mcp](https://pypi.org/project/camoufox-playwright-mcp/) 0.1.5 wrapper | The wrapper is fetched from PyPI at first start and is never bundled here. |
| `camoufox-native` | [mcp-camoufox](https://pypi.org/project/mcp-camoufox/) 0.4.5 from PyPI | FSL-1.1-MIT (source-available, not OSI-approved); fetched at first start and never bundled. The npm package of the same name is a different project. |
| `kameleo` | [Kameleo](https://kameleo.io/downloads) desktop app over a local CDP endpoint | Proprietary and user-installed; the attach path is live-unverified and no stealth claim is made for it. |

The bridge these plugins drive is [swimmwatch/cloakbrowser-mcp](https://github.com/swimmwatch/cloakbrowser-mcp) (MIT), which starts upstream `@playwright/mcp` and points it at the selected browser. This repository is an adapted collection, not a new upstream: the marketplace, plugins and broker are this project's work.

## Upstream bridge documentation

The documentation in [`docs/`](docs/) documents the upstream bridge this collection adapts. It is kept for reference and is not rewritten here.

- Upstream site: [Documentation](https://swimmwatch.github.io/cloakbrowser-mcp/) · [Comparison](https://swimmwatch.github.io/cloakbrowser-mcp/comparison/) · [Recipes](https://swimmwatch.github.io/cloakbrowser-mcp/recipes/) · [Testing](https://swimmwatch.github.io/cloakbrowser-mcp/testing/) · [Generated CLI reference](https://swimmwatch.github.io/cloakbrowser-mcp/generated/cli/).
- In this checkout: [Getting started](docs/getting-started.md), [Configuration](docs/configuration.md), [Managed CDP access](docs/configuration.md#managed-cdp), [Comparison](docs/comparison.md), [Recipes](docs/recipes/index.md), [Persistent login profile](docs/recipes/persistent-login-profile.md), [Claude Desktop](docs/recipes/connect-claude-desktop.md), [Codex CLI](docs/recipes/connect-codex-cli.md), [Reverse proxy](docs/recipes/docker-streamable-http-reverse-proxy.md), [GeoIP proxy matching](docs/geoip-proxy-matching.md), [Humanized input behavior](docs/humanized-input-behavior.md), [Docker](docs/docker.md), [Version compatibility](docs/version-compatibility.md), [Contributor guide](docs/contributor-guide.md) and [test reporting](tests/README.md).

## Version compatibility

<!-- compatibility-table:start -->

| cloakbrowser-mcp | @playwright/mcp | CloakBrowser | Node.js                | Platform                                                                                  |
| ---------------- | --------------- | ------------ | ---------------------- | ----------------------------------------------------------------------------------------- |
| `1.15.1`         | `^0.0.83`       | `^0.6.3`     | `^22.13.0 || >=24.0.0` | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.15.0`         | `^0.0.83`       | `^0.6.3`     | `^22.13.0 || >=24.0.0` | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.14.1`         | `^0.0.82`       | `^0.5.10`    | `^22.13.0 || >=24.0.0` | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.14.0`         | `^0.0.82`       | `^0.5.10`    | `^22.13.0 || >=24.0.0` | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.13.0`         | `^0.0.80`       | `^0.5.10`    | `^22.13.0 || >=24.0.0` | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.12.0`         | `^0.0.79`       | `^0.5.7`     | `^22.13.0 || >=24.0.0` | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.11.0`         | `^0.0.79`       | `^0.5.6`     | `^22.13.0 || >=24.0.0` | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.10.0`         | `^0.0.78`       | `^0.5.3`     | `^22.13.0 || >=24.0.0` | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.9.0`          | `^0.0.78`       | `^0.5.1`     | `^22.13.0 || >=24.0.0` | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.8.0`          | `^0.0.78`       | `^0.4.10`    | `^22.13.0 || >=24.0.0` | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.7.0`          | `^0.0.77`       | `^0.4.8`     | `>=22.12`              | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.6.1`          | `^0.0.77`       | `^0.4.7`     | `>=22.12`              | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.6.0`          | `^0.0.77`       | `^0.4.7`     | `>=22.12`              | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.5.0`          | `^0.0.76`       | `^0.4.3`     | `>=22.12`              | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.4.0`          | `^0.0.76`       | `^0.3.32`    | `>=22.12`              | npm on Linux x64/arm64, macOS arm64/x64, Windows x64; Docker `linux/amd64`, `linux/arm64` |
| `1.3.0`          | `^0.0.75`       | `^0.3.31`    | `>=20`                 | Docker `linux/amd64`, Node.js local                                                       |
| `1.2.7`          | `^0.0.75`       | `^0.3.30`    | `>=20`                 | Docker `linux/amd64`, Node.js local                                                       |
| `1.2.6`          | `^0.0.75`       | `^0.3.30`    | `>=20`                 | Docker `linux/amd64`, Node.js local                                                       |
| `1.2.5`          | `^0.0.75`       | `^0.3.30`    | `>=20`                 | Docker `linux/amd64`, Node.js local                                                       |
| `1.2.3`          | `^0.0.75`       | `^0.3.30`    | `>=20`                 | Docker `linux/amd64`, Node.js local                                                       |
| `1.2.2`          | `^0.0.75`       | `^0.3.30`    | `>=20`                 | Docker `linux/amd64`, Node.js local                                                       |
| `1.2.1`          | `^0.0.75`       | `^0.3.30`    | `>=20`                 | Docker `linux/amd64`, Node.js local                                                       |
| `1.2.0`          | `^0.0.75`       | `^0.3.30`    | `>=20`                 | Docker `linux/amd64`, Node.js local                                                       |
| `1.1.0`          | `^0.0.75`       | `^0.3.30`    | `>=20`                 | Docker `linux/amd64`, Node.js local                                                       |
| `1.0.2`          | `^0.0.75`       | `^0.3.30`    | `>=20`                 | Docker `linux/amd64`, Node.js local                                                       |
| `1.0.1`          | `^0.0.75`       | `^0.3.30`    | `>=20`                 | Docker `linux/amd64`, Node.js local                                                       |
| `1.0.0`          | `^0.0.75`       | `^0.3.30`    | `>=20`                 | Docker `linux/amd64`, Node.js local                                                       |

<!-- compatibility-table:end -->

See [Version Compatibility](docs/version-compatibility.md) for the maintained compatibility table.

Both plugins are at version **2.26.1** and move in lockstep. The pins are unchanged: bridge `cloakbrowser-mcp@1.15.1` on Patchright `1.64.1` with engine wrapper `cloakbrowser@0.6.3`; Camoufox wrapper `camoufox-playwright-mcp==0.1.5` with `fastmcp==3.4.7` and `mcp==1.29.0`; managed `uv` `0.13.5`, CPython `3.13.17`, browser build `v156.0.1-beta.39`; native PyPI wrapper `mcp-camoufox==0.4.5`.

## Credits and licence

This repository is derived from [swimmwatch/cloakbrowser-mcp](https://github.com/swimmwatch/cloakbrowser-mcp) (MIT). The upstream bridge and its documentation remain upstream's work; this repository adds the adapted marketplace, plugins and broker. See [NOTICE](NOTICE) for the full attribution and [LICENSE](LICENSE) for the MIT terms, kept verbatim. The CloakBrowser binary and Kameleo are proprietary; `mcp-camoufox` is FSL-1.1-MIT. This is a licence note, not legal advice.
