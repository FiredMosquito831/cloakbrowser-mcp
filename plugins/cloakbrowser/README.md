# cloakbrowser

Claude Code plugin that gives the agent the Playwright MCP tool contract (72 `browser_*` tools: snapshots with element refs, clicks, forms, tabs, console, network, tracing, video) running on CloakBrowser, a stealth-patched Chromium.

It launches `cloakbrowser-mcp`, which starts the official `@playwright/mcp` server and points it at the CloakBrowser binary. Tool names and schemas are Microsoft's; parity is structural, not reimplemented.

## Install

From this repository:

```
/plugin marketplace add FiredMosquito831/cloakbrowser-mcp
/plugin install cloakbrowser@cloakbrowser-mcp
```

From a local checkout:

```
/plugin marketplace add D:\Projects2\StealthBrowserAutomation\fork
/plugin install cloakbrowser@cloakbrowser-mcp
```

## Requirements

- Node 22.13+ or 24+.
- The first launch downloads the CloakBrowser Chromium binary (~200 MB) into `~/.cloakbrowser`. Nothing binary is committed to this repository.

## Default settings

The plugin ships these values in `.mcp.json`:

| Variable | Value | Why |
|---|---|---|
| `PLAYWRIGHT_MCP_HEADLESS` | `false` | Upstream defaults to `true`; headed is needed for login, debugging and watching the run |
| `PLAYWRIGHT_MCP_BROWSER_ENGINE` | `cloak` | Use CloakBrowser rather than plain Playwright Chromium |
| `PLAYWRIGHT_MCP_CAPS` | `vision,pdf,devtools,storage,network,testing,config` | **Required for full parity.** Without caps the server exposes only 25 browser tools; this list exposes all 72 |
| `CLOAK_PLAYWRIGHT_MCP_HUMANIZE` | `true` | Humanised mouse, keyboard and scrolling |
| `CLOAK_PLAYWRIGHT_MCP_GEOIP_PROXY_MATCH` | `false` | Enable only together with a proxy; it aligns timezone and locale to the proxy exit |
| `CLOAK_PLAYWRIGHT_MCP_RELEASE_CHANNEL` | `stable` | Free/stable binary channel; `preview` is Pro-only |

## Per-user settings

Set these in your environment before starting Claude Code. They cannot be shared in a public plugin.

| Variable | Use |
|---|---|
| `PLAYWRIGHT_MCP_USER_DATA_DIR` | Persistent profile directory. Use one per account; the bridge refuses two servers on one profile |
| `PLAYWRIGHT_MCP_PROXY_SERVER` | Sticky residential proxy, for example `http://user:pass@host:port` |
| `PLAYWRIGHT_MCP_PROXY_BYPASS` | Hosts that should not use the proxy |
| `CLOAK_PLAYWRIGHT_MCP_GEOIP_PROXY_MATCH` | Set `true` when a proxy is configured, so timezone and locale match its exit |
| `CLOAKBROWSER_LICENSE_KEY` | CloakBrowser Pro key. The free tier allows one concurrent session |
| `CLOAKBROWSER_VERSION` | Pin a specific engine build instead of the stable channel |

## Sign-in

Sign in to Google or any site manually, in the headed window, with the persistent profile. Automate only the logged-in session. Do not automate the Google credential form.

## Version and updates

Pinned to `cloakbrowser-mcp@1.15.1`. The plugin version mirrors the MCP version.

- The MCP package does **not** self-update. Update by changing the pin in `.mcp.json` and `plugin.json` together (the upstream-sync workflow does this).
- The Chromium binary **does** self-update: on each launch the wrapper checks at most once per hour and downloads a newer build in the background.

## Licence

The wrapper and this plugin are MIT. The CloakBrowser binary is proprietary: the v146 build is free, and current builds require a CloakBrowser licence for more than one concurrent session. See `BINARY-LICENSE.md` in the upstream engine repository.
