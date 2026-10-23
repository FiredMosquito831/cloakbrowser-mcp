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

Claude Code prompts for the settings below during install. Change them later with `/plugin` or `claude plugin configure cloakbrowser`.

## Requirements

- Node 22.13+ or 24+.
- The first launch downloads the CloakBrowser Chromium binary (~200 MB) into `~/.cloakbrowser`. Nothing binary is committed to this repository.

## Settings

Values live in Claude Code's plugin configuration, not in this repository. Non-sensitive values are stored in `pluginConfigs` in `settings.json`; the licence key goes to the operating system credential store.

| Setting | Default | What it does |
|---|---|---|
| Headless | `false` | Headed is measurably less detectable. Turn on only for a display-less server |
| Browser engine | `cloak` | `playwright` falls back to stock Chromium and loses the stealth patches |
| Tool capabilities | all seven | `vision,pdf,devtools,storage,network,testing,config` exposes all 72 tools; removing entries hides tools. Without this list the server exposes 25 |
| Humanised input | `true` | Human-like mouse paths, keystroke timing and scrolling |
| Humanised preset | `default` | `careful` is slower and more deliberate |
| Release channel | `stable` | `preview` requires a Pro licence |
| GeoIP proxy match | `false` | Aligns timezone and locale to the proxy exit; enable with a proxy |
| Profile directory | empty | Persistent cookies, logins and fingerprint seed. One directory per account |
| Proxy server / bypass | empty | Sticky proxy and hosts that skip it |
| Licence key | empty | CloakBrowser Pro key; the free tier allows one concurrent session |
| Engine version pin | empty | Pin a specific Chromium build; empty follows the stable channel |
| Artifacts directory | empty | Where screenshots, traces and session files are written |

The launcher drops empty optional values before starting the server, so leaving a directory or proxy blank behaves as "not configured" rather than as an empty path.

## Sign-in

Sign in to Google or any site manually, in the headed window, with the persistent profile. Automate only the logged-in session. Do not automate the Google credential form.

## Version and updates

Pinned to `cloakbrowser-mcp@1.15.1`. The plugin version mirrors the MCP version.

- The MCP package does **not** self-update. Update by changing the pin in `.mcp.json` (`CLOAK_PLAYWRIGHT_MCP_PACKAGE`) and `plugin.json` together.
- The Chromium binary **does** self-update: on each launch the wrapper checks at most once per hour and downloads a newer build in the background.

## Licence

The wrapper and this plugin are MIT. The CloakBrowser binary is proprietary: the v146 build is free, and current builds require a CloakBrowser licence for more than one concurrent session. See `BINARY-LICENSE.md` in the upstream engine repository.
