# cloakbrowser

Claude Code plugin that gives the agent the Playwright MCP tool contract (72 `browser_*` tools: snapshots with element refs, clicks, forms, tabs, console, network, tracing, video) running on CloakBrowser, a stealth-patched Chromium.

A local broker selects the engine from the plugin settings. With the default `cloak` engine the plugin exposes **76 tools**: the 72 backend browser tools, two local diagnostics (`cloakbrowser_binary_info`, `cloakbrowser_bridge_info`) and two broker meta-tools (`browser_capabilities`, `browser_engine_status`).

The broker starts `launch.mjs`, which launches `cloakbrowser-mcp`; that package starts the official `@playwright/mcp` server and points it at the selected browser. Tool names and schemas are Microsoft's; parity is structural, not reimplemented.

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

Claude Code prompts for the settings below during install. You can also pass them non-interactively:

```bash
claude plugin install cloakbrowser@cloakbrowser-mcp \
  --config headless=false \
  --config profile_dir=/home/you/.cloakbrowser-profiles/linkedin \
  --config proxy_server=http://user:pass@host:port
```

Change them later with `/plugin` → Configure, the per-option rows in `/config`, or:

```bash
claude plugin configure cloakbrowser@cloakbrowser-mcp

# non-interactive: a JSON object of single-line strings on stdin
printf '%s' '{"profile_dir":"/home/you/.cloakbrowser-profiles/linkedin"}' | \
  claude plugin configure cloakbrowser@cloakbrowser-mcp --values-stdin
```

Non-sensitive values are stored under `pluginConfigs` in your user settings; the licence key goes to the operating system credential store. Restart Claude Code after a change so the MCP server restarts with the new environment.

## Requirements

- Node 22.13+ or 24+.
- The first launch installs the MCP and its pinned engine wrapper into Claude Code's plugin data directory (about 10–20 seconds), then downloads the CloakBrowser Chromium binary (~200 MB) into `~/.cloakbrowser`. Nothing binary is committed to this repository.
- With the profile setting empty, the plugin uses its own persistent profile at `<plugin data>/profiles/default`. It is a real on-disk profile, not a temporary one, and it survives plugin updates.
- The MCP runs on **Patchright 1.64.1** instead of stock Playwright. Stock Playwright's CDP control channel sets `isAutomatedWithCDP` on fingerprint tests; Patchright keeps the same Playwright API and avoids it. The bridge's console fallback is disabled for the same reason, and console capture still works.

The engine wrapper is pinned to `cloakbrowser@0.6.3` because the bridge (1.15.1) rejects `0.6.4` when humanize is enabled. The pin is in `launch.mjs` and is removed once the bridge accepts the newer wrapper.

## Settings

Values live in Claude Code's plugin configuration, not in this repository. Non-sensitive values are stored in `pluginConfigs` in `settings.json`; the licence key goes to the operating system credential store.

| Setting | Default | What it does |
|---|---|---|
| Headless | `false` | Headed is measurably less detectable. Turn on only for a display-less server |
| Browser engine | `cloak` | `cloak` runs the patched CloakBrowser Chromium. `playwright` falls back to stock Chromium and loses the stealth patches. The broker reads this when the MCP server starts; restart Claude Code after changing it |
| Tool groups | all on | Seven checkboxes: vision, pdf, devtools, storage, network, testing, config. Turn one off to remove that group |
| Disabled tools | empty | Comma-separated tool names hidden from `tools/list` and rejected on call |
| Humanised input | `true` | Human-like mouse paths, keystroke timing and scrolling |
| Humanised preset | `default` | `careful` is slower and more deliberate |
| Release channel | `stable` | `preview` requires a Pro licence |
| GeoIP proxy match | `false` | Aligns timezone and locale to the proxy exit; enable with a proxy |
| Profile directory | empty → `<plugin data>/profiles/default` | Persistent cookies, logins and fingerprint seed. One directory per account |
| Proxy server / bypass | empty | Sticky proxy and hosts that skip it |
| Licence key | empty | CloakBrowser Pro key; the free tier allows one concurrent session |
| Engine version pin | empty | Pin a specific Chromium build; empty follows the stable channel |
| Artifacts directory | empty | Where screenshots, traces and session files are written |

The launcher drops empty optional values before starting the server, so leaving a directory or proxy blank behaves as "not configured" rather than as an empty path.

## Engines and the broker

`broker.mjs` is the single MCP server Claude Code starts. It reads the **Browser engine** setting, loads the matching manifest from `engines/`, starts `launch.mjs` for that engine and relays JSON-RPC in both directions. The engine value is an enum in the plugin configuration, never a command or a path.

| Engine | Manifest | Backend | Notes |
|---|---|---|---|
| `cloak` (default) | `engines/cloak.json` | CloakBrowser Chromium on Patchright | Stealth patches; the 1.x browser behaviour is unchanged |
| `playwright` | `engines/playwright.json` | Stock Playwright Chromium | Same Playwright MCP contract, no stealth patches |

Both manifests use the `full` tool profile and mark every backend tool as `full` support. The broker adds two meta-tools that are always present and cannot collide with backend tools:

| Meta-tool | What it reports |
|---|---|
| `browser_capabilities` | Selected engine, label, contract, tool profile (`full`), backend tool count, per-tool support and how to change engines |
| `browser_engine_status` | Selected engine, backend state, backend version, startup and `tools/list` timing, last error |

Total surface for `cloak`: 76 tools = 72 backend `browser_*` tools + 2 local diagnostics + 2 broker meta-tools. The seven group switches and `disabled_tools` shape the backend tools; the broker applies the manifest and adds the meta-tools, which stay callable. Engine changes apply after the MCP server restarts.

## Sign-in

Sign in to Google or any site manually, in the headed window, with the persistent profile. Automate only the logged-in session. Do not automate the Google credential form.

## Version and updates

The plugin is version 2.0.0. It pins `cloakbrowser-mcp@1.15.1`, runs it on `patchright@1.64.1`, and pins the engine wrapper to `0.6.3`. The plugin version moves independently of the MCP pin; the pin lives in `.mcp.json`.

## Tool groups and per-tool control

Seven checkboxes in the plugin configuration control the capability groups:

| Setting | Adds | Tools |
|---|---|---:|
| Mouse primitives (vision) | coordinate mouse tools | 6 |
| PDF export | `browser_pdf_save` | 1 |
| Tracing, video and highlights | devtools tools | 13 |
| Cookies and web storage | cookies, localStorage, sessionStorage | 17 |
| Network routing | route, unroute, route list, network state | 4 |
| Assertions and locator generation | testing tools | 5 |
| Configuration read | `browser_get_config` | 1 |

Presets are combinations of those switches:

| Preset | Switches on | Browser tools |
|---|---|---:|
| `minimal` | none | 25 |
| `standard` | vision, pdf, devtools | 45 |
| `full` | all seven | 72 |

Those counts are backend `browser_*` tools. The two local diagnostics and the two broker meta-tools are additional and are not controlled by these switches.

For individual tools, set **Disabled tools** to a comma-separated list. The broker hides those names from `tools/list` and returns an `isError: true` tool result if one is called, for example:

```
browser_pdf_save,browser_start_video,browser_mouse_wheel
```

Changes take effect after the MCP server restarts.

- The MCP package does **not** self-update. Update by changing the pin in `.mcp.json` (`CLOAK_PLAYWRIGHT_MCP_PACKAGE`) and `plugin.json` together; the launcher reinstalls into the plugin data directory when either pin changes.
- The Chromium binary **does** self-update: on each launch the wrapper checks at most once per hour and downloads a newer build in the background.

## Licence

The wrapper and this plugin are MIT. The CloakBrowser binary is proprietary: the v146 build is free, and current builds require a CloakBrowser licence for more than one concurrent session. See `BINARY-LICENSE.md` in the upstream engine repository.
