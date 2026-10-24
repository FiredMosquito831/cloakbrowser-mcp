# cloakbrowser

Claude Code plugin that gives the agent the Playwright MCP tool contract (72 `browser_*` tools: snapshots with element refs, clicks, forms, tabs, console, network, tracing, video) running on CloakBrowser, a stealth-patched Chromium, on Camoufox, a stealth Firefox, or on Camoufox's own native MCP server.

A local broker selects the engine and tool profile from the plugin settings. With the default `cloak` engine and the default `full` profile the plugin exposes **76 tools**: the 72 backend browser tools, two local diagnostics (`cloakbrowser_binary_info`, `cloakbrowser_bridge_info`) and two broker meta-tools (`browser_capabilities`, `browser_engine_status`). The `portable` profile exposes **26 tools**: one shared 24-tool browser core plus the two meta-tools; backend-specific and extra tools, including the two local diagnostics, are hidden. The `camoufox` engine defaults to `portable` and exposes **26** tools by default (**69** at `full`). The `camoufox-native` engine defaults to `portable` and exposes **16** tools (14 canonical aliases plus the two meta-tools); `full` exposes **27** (16 canonical aliases + 9 prefixed native tools + 2 meta).

For the Chromium engines the broker starts `launch.mjs`, which launches `cloakbrowser-mcp`; that package starts the official `@playwright/mcp` server and points it at the selected browser. For Camoufox it starts `launch-camoufox.mjs`, which provisions a Python runtime and starts `camoufox-playwright-mcp`. For Camoufox native it starts `launch-camoufox-native.mjs`, which locates the user-installed `mcp-camoufox` package and starts it. Tool names and schemas are Microsoft's; parity is structural, not reimplemented.

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
- **The `camoufox` engine additionally needs Python 3.12+ and `uv` on `PATH`.** The launcher never installs either; it names the missing prerequisite and exits, and the broker then reports the failure through `browser_engine_status` instead of blocking the handshake. Python 3.13 was the tested interpreter.
- **Camoufox first launch is large.** The launcher creates a vendored venv at `<plugin data>/runtime-camoufox` (about 260 MB on disk) and installs `camoufox-playwright-mcp==0.1.5` with `uv`. It then ensures the pinned Camoufox build `v156.0.1-beta.39`; when absent, that is a **~1.3 GB download and ~2.4 GB on disk** in Camoufox's machine-wide cache. Plan for the time and space; the browser itself starts on the first browser tool call, not at `initialize`.
- **Camoufox cache side effect.** Camoufox stores builds in a machine-wide user cache (`%LOCALAPPDATA%\camoufox` on Windows), and its installer makes the build it installs the active one. Installing the pin can therefore move another Camoufox consumer on this machine to `v156.0.1-beta.39`. This engine's own launches stay pinned through `CAMOUFOX_EXECUTABLE_PATH` regardless of which build is active.
- **Windows and the Camoufox engine.** The pinned wrapper's stdio server installs a signal watchdog through anyio, which Windows does not implement; without a fix the server exits before answering `initialize`. `camoufox_entry.py` replaces only that receiver with an empty one (the broker owns shutdown on every platform) and then runs the unmodified wrapper. On other platforms the shim is not installed.
- **The `camoufox-native` engine needs the user to install `mcp-camoufox`.** The plugin does **not** bundle, download or redistribute this package. Install it once yourself, with Python 3.12+ on `PATH`:

  ```
  uv tool install mcp-camoufox==0.4.5
  # or: pipx install mcp-camoufox==0.4.5
  ```

  `launch-camoufox-native.mjs` looks for `mcp-camoufox.exe` (POSIX: `mcp-camoufox`) on `PATH` and in `~/.local/bin`. When it is absent the launcher exits with that exact install command in one line, and the broker answers `initialize` with only the two meta-tools so `browser_engine_status` can report the failure. This is the **PyPI `mcp-camoufox`** (27 tools); the npm package of the same name is a different 133-tool project. Its licence is **FSL-1.1-MIT** (source-available, not OSI); installing it is your decision.
- **Camoufox native first call.** The app owns the browser download: when the pinned build `156.0.1-beta.39` is absent it downloads on the first browser tool call, which is slow. `initialize` and `tools/list` answer from the static tool registry first.
- **Camoufox native profiles.** `CAMOUFOX_DATA_DIR` defaults to `<plugin data>/profiles/camoufox-native`. The app always creates `<data dir>/profiles/<name>`, so the on-disk profile is `<plugin data>/profiles/camoufox-native/profiles/<name>` — the doubled `profiles/` segment is the app's layout, not a typo. Profile names are 1–64 characters, start alphanumeric, and use only letters, digits, `.`, `_` and `-`; a slash is impossible. One name per account; with the daemon off, a second session naming the same profile is refused by the app.
- **Camoufox native daemon is off.** v2.3.0 pins `CAMOUFOX_DAEMON=false`. The broker can only own its own child tree; a detached, lease-driven daemon would outlive it by design, so daemon mode is not exposed.
- **Camoufox native fingerprint OS defaults to the host.** When `CAMOUFOX_FINGERPRINT_OS` is unset, the launcher sets it to the host OS in Camoufox's vocabulary (`win32` → `windows`, `darwin` → `macos`, `linux` → `linux`), so the claimed persona matches the machine that renders the GPU/user-agent stack. An explicit `CAMOUFOX_FINGERPRINT_OS` wins (case and surrounding whitespace are normalised). An invalid value falls back to the host default and logs one line instead of failing. This is not a plugin setting: set it in the environment before starting Claude Code. The 2026-10-24 detector runs showed why it matters: random macOS personas on this Windows host tripped `hasInconsistentTimingResolution`, while Windows-pinned personas passed cold and warm.

The engine wrapper is pinned to `cloakbrowser@0.6.3` because the bridge (1.15.1) rejects `0.6.4` when humanize is enabled. The pin is in `launch.mjs` and is removed once the bridge accepts the newer wrapper. The Camoufox pins are in `launch-camoufox.mjs` and `.mcp.json` (`CAMOUFOX_MCP_PACKAGE`, `CAMOUFOX_BROWSER_BUILD`).

## Settings

Values live in Claude Code's plugin configuration, not in this repository. Non-sensitive values are stored in `pluginConfigs` in `settings.json`; the licence key goes to the operating system credential store.

| Setting | Default | What it does |
|---|---|---|
| Headless | `false` | Headed is measurably less detectable. Turn on only for a display-less server |
| Browser engine | `cloak` | `cloak` runs the patched CloakBrowser Chromium. `playwright` falls back to stock Chromium and loses the stealth patches. `camoufox` runs the Camoufox stealth Firefox through `camoufox-playwright-mcp` and needs Python 3.12+ with `uv`. The broker reads this when the MCP server starts; restart Claude Code after changing it |
| Tool profile | `default` | `default` follows the selected engine's manifest: `full` for `cloak` and `playwright`, `portable` for `camoufox` and `camoufox-native`. `portable` exposes the shared 24-tool browser core; `full` exposes everything the engine supports. The seven tool groups and `disabled_tools` still apply. Restart Claude Code after changing it |
| Camoufox native profile | `default` | Profile name for the `camoufox-native` engine. Letters, digits, `.`, `_` and `-`, starting with a letter or digit, up to 64 characters. One name per account; cookies and logins live under it |
| Camoufox native data directory | empty → `<plugin data>/profiles/camoufox-native` | Where the native engine keeps `profiles/<name>` and `logs/`. Use one directory per set of accounts |
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

`broker.mjs` is the single MCP server Claude Code starts. It reads the **Browser engine** setting, discovers every `engines/*.json` manifest, validates it, loads the selected one, starts `launch.mjs` for that engine and relays JSON-RPC in both directions. The engine value is an enum in the plugin configuration, never a command or a path. The enum (`browser_engine.options`) is generated from the manifests; adding an engine does not edit the broker. See `engines/README.md` for the add-an-engine recipe.

| Engine | Manifest | Backend | Notes |
|---|---|---|---|
| `cloak` (default) | `engines/cloak.json` | CloakBrowser Chromium on Patchright | Stealth patches; the 1.x browser behaviour is unchanged |
| `playwright` | `engines/playwright.json` | Stock Playwright Chromium | Same Playwright MCP contract, no stealth patches |
| `camoufox` | `engines/camoufox.json` | Camoufox stealth Firefox via `camoufox-playwright-mcp` 0.1.5 | Needs Python 3.12+ and `uv`; portable by default; four tools absent and `browser_pdf_save` unusable; no CDP |
| `camoufox-native` | `engines/camoufox-native.json` | Camoufox stealth Firefox via the **user-installed** PyPI `mcp-camoufox` 0.4.5 | Its own 27-tool contract; 16 canonical aliases + 9 prefixed native tools; portable by default; 10 portable verbs absent; no CDP; licence FSL-1.1-MIT |

The Camoufox engine differs from the Chromium engines where the backend does:

- **Tools it does not implement:** `browser_annotate`, `browser_emulate_media`, `browser_start_recording` and `browser_stop_recording` are hidden (`support: none`), and `browser_pdf_save` is hidden because PDF output only works on headless Chromium. They are reported in `browser_capabilities.unavailableTools` with a reason.
- **`browser_run_code_unsafe` is `partial`:** it executes asynchronous **Python** Playwright code against the active page, not JavaScript. It is hidden under `portable` (not on the shared list) and exposed with its note under `full`.
- **Ignored settings:** `humanize`, `human_preset`, `release_channel`, `geoip_proxy_match`, `licence_key` and `engine_version` do not apply to Camoufox and are listed in `browser_capabilities.ignoredSettings`. `headless`, `profile_dir`, `proxy_server`, `proxy_bypass`, `output_dir` and the seven tool groups do apply. The default profile root for this engine is `<plugin data>/profiles/camoufox/default`; do not point it at a Chromium engine's profile directory.

### Camoufox native aliases

`camoufox-native` does not speak the Playwright contract, so the broker translates the honest subset and prefixes the rest. Everything is declared in `engines/camoufox-native.json`; there is no engine-specific code in the broker.

- **16 canonical aliases:** `navigate`, `go_back`, `snapshot`, `click`, `fill` (twice: `browser_type` and `browser_select_option`), `fill_form`, `press_key`, `find`, `evaluate`, `screenshot`, the four tab tools behind `browser_tabs`, `list_network_requests`, `list_console_messages`, `handle_dialog` and `close_session` appear as their `browser_*` names with a canonical (projected) input schema. Arguments the native tool cannot honour are rejected at call time and are not advertised: for example `browser_click` has no `button` or `modifiers`, `browser_type` has no `slowly` or `submit`, `browser_take_screenshot` has no `type`, `filename` or `scale`, and `browser_snapshot` accepts no canonical arguments.
- **9 prefixed native tools:** `camoufox_native_get_element`, `camoufox_native_get_html`, `camoufox_native_get_network_request`, `camoufox_native_scroll`, `camoufox_native_upload_file`, `camoufox_native_wait_for`, `camoufox_native_click_at`, `camoufox_native_reload` and `camoufox_native_list_sessions`. They keep their native names, descriptions and schemas.
- **10 absent portable verbs:** `browser_hover`, `browser_drag`, `browser_file_upload`, `browser_wait_for`, `browser_network_request` and the five `browser_cookie_*` tools are `none` with a reason in `browser_capabilities.unavailableTools`. There is no hover or drag tool; file upload, wait conditions and request addressing have different native semantics and stay prefixed; there are no cookie tools at all.
- **The profile is injected by the broker.** Every native call except `list_sessions` receives the configured `camoufox_profile`; the agent never sees the argument.
- **Results are native.** Snapshot text, tab listings and network numbering are mcp-camoufox's formats, not Playwright's. The broker passes results through untouched and does not pretend they are identical.
- **The seven tool-group switches do not apply.** They shape the Playwright MCP capability groups inside the cloak launcher. For this engine, `tool_profile` and `disabled_tools` are the controls; `browser_capabilities.groupSwitchesApply` is `false`.
- **Detection note (2026-10-24).** Six headed runs through the broker on `https://deviceandbrowserinfo.com/are_you_a_bot` were recorded, and the flag is **persona-driven**, not cold-start:
  - With a random persona that picked macOS/MacIntel on this Windows host, `isBot: true` both times, caused solely by `hasInconsistentTimingResolution: true`; every other signal was false, including `isAutomatedWithCDP`, `isAutomatedWithCDPInWebWorker` and the WebGL checks.
  - With `CAMOUFOX_FINGERPRINT_OS=windows` (cold and warm, same fresh profile), `isBot: false` both times with every flag false.
  - With the new host-OS default and a fresh profile (`os=windows` in the launcher log), `isBot: false`, `hasInconsistentTimingResolution: false`, `isAutomatedWithCDP: false`, navigate 7.9 s.
  - With `CAMOUFOX_FINGERPRINT_OS=macos`, the page returned no verdict within the probe window (inconclusive).
  - No fingerprint-scan redirect occurred; the URL stayed on the detector page.
  - **Conclusion:** the native engine now defaults the persona to the host OS for coherence, which produced a clean run here. This is not a general stealth validation: a macOS host would default to `macos` (not tested here), and `CAMOUFOX_FINGERPRINT_OS` is not a plugin setting — set it in the environment to override.

### Tool profiles

Every manifest declares a default profile and per-tool support (`full`, `partial`, `none`, `unknown`). The **Tool profile** setting (`default`, `portable`, `full`) overrides the manifest default; `default` means "use the manifest's choice". `full` exposes everything the manifest does not mark `none`. `portable` exposes one shared 24-tool browser core, defined once in `engines/profiles.json`:

`browser_navigate`, `browser_navigate_back`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_drag`, `browser_select_option`, `browser_file_upload`, `browser_handle_dialog`, `browser_take_screenshot`, `browser_evaluate`, `browser_wait_for`, `browser_tabs`, `browser_console_messages`, `browser_network_requests`, `browser_network_request`, `browser_cookie_list`, `browser_cookie_get`, `browser_cookie_set`, `browser_cookie_delete`, `browser_cookie_clear`, `browser_close`.

Under `portable` the two local diagnostics (`cloakbrowser_binary_info`, `cloakbrowser_bridge_info`) are hidden; the two broker meta-tools stay.

| Engine | Default | `full` | `portable` |
|---|---|---:|---:|
| `cloak` | `full` | 76 | 26 |
| `playwright` | `full` | 76 | 26 |
| `camoufox` | `portable` | 69 | 26 |
| `camoufox-native` | `portable` | 27 | 16 (of which 2 meta) |

The `camoufox-native` counts include the two broker meta-tools: 25 exposed tools at `full` (16 canonical + 9 prefixed) and 14 canonical tools at `portable` — ten portable verbs are not available on that engine. The group switches do not apply to it.

The profile is applied before `disabled_tools`; for `cloak`, `playwright` and `camoufox` the seven group switches still shape the backend list first. With `tools_storage=false` cloak exposes 59 at `full` and 21 at `portable`; with `tools_pdf=false` it exposes 75 at `full` and 26 at `portable`.

The broker adds two meta-tools that are always present and cannot collide with backend tools:

| Meta-tool | What it reports |
|---|---|
| `browser_capabilities` | Selected engine, label, contract, effective `toolProfile` and its source, per-tool support and notes, the portable list, what the profile and manifest hid, and how to change engines |
| `browser_engine_status` | Selected engine, effective tool profile, backend state, backend version, startup and `tools/list` timing, last error |

Total surface for `cloak` at the default profile: 76 tools = 72 backend `browser_*` tools + 2 local diagnostics + 2 broker meta-tools. At `portable`: 26 = 24 backend `browser_*` tools + 2 broker meta-tools. Engine and profile changes apply after the MCP server restarts.

## Sign-in

Sign in to Google or any site manually, in the headed window, with the persistent profile. Automate only the logged-in session. Do not automate the Google credential form.

## Version and updates

The plugin is version 2.3.0. It pins `cloakbrowser-mcp@1.15.1`, runs it on `patchright@1.64.1`, and pins the engine wrapper to `0.6.3`. The Camoufox engine pins `camoufox-playwright-mcp==0.1.5` and browser build `v156.0.1-beta.39`. The Camoufox native engine expects the user to install `mcp-camoufox==0.4.5` and pins browser build `156.0.1-beta.39` in `.mcp.json` (`CAMOUFOX_NATIVE_PACKAGE`, `CAMOUFOX_NATIVE_BROWSER_BUILD`). The plugin version moves independently of the MCP pins; the pins live in `.mcp.json`.

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

Tool groups act on the backend list before the tool profile and before `disabled_tools`, so all three combine rather than replace each other.

For individual tools, set **Disabled tools** to a comma-separated list. The broker hides those names from `tools/list` and returns an `isError: true` tool result if one is called, for example:

```
browser_pdf_save,browser_start_video,browser_mouse_wheel
```

Changes take effect after the MCP server restarts.

- The MCP package does **not** self-update. Update by changing the pin in `.mcp.json` (`CLOAK_PLAYWRIGHT_MCP_PACKAGE`) and `plugin.json` together; the launcher reinstalls into the plugin data directory when either pin changes.
- The Chromium binary **does** self-update: on each launch the wrapper checks at most once per hour and downloads a newer build in the background.

## Licence

The wrapper and this plugin are MIT. The CloakBrowser binary is proprietary: the v146 build is free, and current builds require a CloakBrowser licence for more than one concurrent session. See `BINARY-LICENSE.md` in the upstream engine repository.

The optional `camoufox-native` engine starts **PyPI `mcp-camoufox` 0.4.5**, which is licensed **FSL-1.1-MIT** (source-available, not OSI-approved; it restricts competing products for two years). The plugin does not bundle, download or redistribute it: the user installs it. This is a licence note, not legal advice.
