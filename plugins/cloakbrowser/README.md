# cloakbrowser

Claude Code plugin that gives the agent the Playwright MCP tool contract (72 `browser_*` tools: snapshots with element refs, clicks, forms, tabs, console, network, tracing, video) running on CloakBrowser, a stealth-patched Chromium, on Camoufox, a stealth Firefox, on Camoufox's own native MCP server, or on a Kameleo Chroma profile over CDP.

A local broker selects the engine and tool profile from the plugin settings. With the default `cloak` engine and the default `full` profile the plugin exposes **76 tools**: the 72 backend browser tools, two local diagnostics (`cloakbrowser_binary_info`, `cloakbrowser_bridge_info`) and two broker meta-tools (`browser_capabilities`, `browser_engine_status`). The `portable` profile exposes **26 tools**: one shared 24-tool browser core plus the two meta-tools; backend-specific and extra tools, including the two local diagnostics, are hidden. The `camoufox` engine defaults to `portable` and exposes **26** tools by default (**69** at `full`). The `camoufox-native` engine defaults to `portable` and exposes **16** tools (14 canonical aliases plus the two meta-tools); `full` exposes **27** (16 canonical aliases + 9 prefixed native tools + 2 meta). The `kameleo` engine defaults to `portable` and exposes **26** tools; `full` exposes **74** (72 browser tools + 2 meta), because this path bypasses the Cloak bridge and its two local diagnostics.

For the Chromium engines the broker starts `launch.mjs`, which launches `cloakbrowser-mcp`; that package starts the official `@playwright/mcp` server and points it at the selected browser. For Camoufox it starts `launch-camoufox.mjs`, which provisions a pinned `uv`, a managed Python and a venv with `camoufox-playwright-mcp`, then starts it. For Camoufox native it starts `launch-camoufox-native.mjs`, which fetches `mcp-camoufox` from PyPI into a plugin-managed venv and starts it. For Kameleo it starts `launch-kameleo.mjs`, which reuses the plugin's pinned runtime and starts the official `@playwright/mcp` CLI against Kameleo's local CDP WebSocket. Tool names and schemas are Microsoft's; parity is structural, not reimplemented.

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

## Per-engine plugin

This plugin is the universal broker: one MCP server whose **Browser engine** setting selects `cloak` (default), `playwright`, `camoufox`, `camoufox-native` or `kameleo`. It stays the default, and every prompt, permission rule or saved transcript written against `mcp__plugin_cloakbrowser_cloakbrowser__*` keeps working.

The marketplace also ships **`camoufox`**, a separate plugin fixed to the Camoufox contract engine (`STEALTH_ENGINE=camoufox`, server key `camoufox`, tool names `mcp__plugin_camoufox_camoufox__*`). Choose it for a single-engine install that declares only the settings the Camoufox engine honours; its plugin configuration is separate and is not carried over from this plugin. Do **not** install both plugins for the same engine: each starts its own broker, runtime and profile. A Kameleo per-engine plugin is **not** shipped; Kameleo remains an engine of this universal broker, with its live behaviour unverified.

Both plugins share a generated core. Edit `shared/core/` and run `node scripts/sync-plugin-core.mjs --write` from the repository root; never edit a plugin copy directly.

## Requirements

- Node 22.13+ or 24+ (the plugin and the npm runtime).
- **Nothing else is a manual prerequisite for `cloak`, `playwright`, `camoufox` or `camoufox-native`.** Every local dependency is provisioned into Claude Code's plugin data directory at the first MCP server start: the npm runtime, a pinned and checksum-verified `uv`, a managed CPython, and the engine's Python venv. No Python, uv, pip, pipx or `uv tool` install is needed, nothing is installed system-wide, and no launcher starts a shell.
- **A `uv` you provide must be 0.13.5 or newer.** The plugin pins `uv` 0.13.5 because that release installs the managed CPython 3.13.17; older ones fail with `No download found for request: cpython-3.13.17-windows-x86_64-none`, and the Camoufox launchers then exit. A `uv` on `PATH` older than 0.13.5, or one that does not answer `--version`, is ignored with one log line and the plugin provisions its own pinned copy. An explicit `UV`/`UV_BIN` older than 0.13.5 is refused with the version it reported: the plugin never silently replaces your explicit choice.
- **The first start may take seconds to several minutes.** The largest item is the Camoufox browser build (about 1.3 GB); everything else is tens of megabytes. If Claude Code's MCP startup timeout expires during a first download, restart Claude Code (`/reload-plugins`): the next start reuses what was already provisioned and does not download it again.
- The first launch installs the MCP and its pinned engine wrapper into Claude Code's plugin data directory, then downloads the CloakBrowser Chromium binary (~200 MB) into `~/.cloakbrowser` on the first browser call. Nothing binary is committed to this repository.
- With the profile settings empty, the plugin uses its own persistent profile at `<plugin data>/profiles/default`. It is a real on-disk profile, not a temporary one, and it survives plugin updates. **Profile isolation** (`shared`, the default) can instead derive one profile per project folder; see [Session safety and profile isolation](#session-safety-and-profile-isolation).
- The MCP runs on **Patchright 1.64.1** instead of stock Playwright. Stock Playwright's CDP control channel sets `isAutomatedWithCDP` on fingerprint tests; Patchright keeps the same Playwright API and avoids it. The bridge's console fallback is disabled for the same reason, and console capture still works.
- **Camoufox first launch is large.** The launcher creates a venv at `<plugin data>/venvs/camoufox` and installs `camoufox-playwright-mcp==0.1.5` plus its Camoufox dependency. It then ensures the pinned Camoufox build `v156.0.1-beta.39`; when absent, that is a **~1.3 GB download and ~2.4 GB on disk** in Camoufox's machine-wide cache. Plan for the time and space; the browser itself starts on the first browser tool call, not at `initialize`.
- **Camoufox cache side effect.** Camoufox stores builds in a machine-wide user cache (`%LOCALAPPDATA%\camoufox` on Windows), and its installer makes the build it installs the active one. Installing the pin can therefore move another Camoufox consumer on this machine to `v156.0.1-beta.39`. This engine's own launches stay pinned through `CAMOUFOX_EXECUTABLE_PATH` regardless of which build is active.
- **Windows and the Camoufox engine.** The pinned wrapper's stdio server installs a signal watchdog through anyio, which Windows does not implement; without a fix the server exits before answering `initialize`. `camoufox_entry.py` replaces only that receiver with an empty one (the broker owns shutdown on every platform) and then runs the unmodified wrapper. On other platforms the shim is not installed.
- **The `camoufox-native` engine fetches `mcp-camoufox` from PyPI itself.** At the first start the launcher provisions `mcp-camoufox==0.4.5` into `<plugin data>/venvs/camoufox-native` and uses its console script. The plugin never bundles or redistributes the package; its licence is **FSL-1.1-MIT** (source-available, not OSI); provisioning it is a download from the public index, the same decision as installing it yourself. If provisioning fails, an explicit `CAMOUFOX_NATIVE_COMMAND` wins and a usable `mcp-camoufox` on `PATH` is the fallback; when neither exists the launcher exits with one actionable line, and the broker answers `initialize` with only the two meta-tools so `browser_engine_status` can report the failure. This is the **PyPI `mcp-camoufox`** (27 tools); the npm package of the same name is a different 133-tool project.
- **Camoufox native first call.** The app owns the browser download: when the pinned build `156.0.1-beta.39` is absent it downloads on the first browser tool call, which is slow. `initialize` and `tools/list` answer from the static tool registry first.
- **Camoufox native profiles.** `CAMOUFOX_DATA_DIR` defaults to `<plugin data>/profiles/camoufox-native`. The app always creates `<data dir>/profiles/<name>`, so the on-disk profile is `<plugin data>/profiles/camoufox-native/profiles/<name>` — the doubled `profiles/` segment is the app's layout, not a typo. Profile names are 1–64 characters, start alphanumeric, and use only letters, digits, `.`, `_` and `-`; a slash is impossible. One name per account; with the daemon off, a second session naming the same profile is refused by the app.
- **Camoufox native daemon is off.** v2.3.0 pins `CAMOUFOX_DAEMON=false`. The broker can only own its own child tree; a detached, lease-driven daemon would outlive it by design, so daemon mode is not exposed.
- **Camoufox native fingerprint OS defaults to the host.** When `CAMOUFOX_FINGERPRINT_OS` is unset, the launcher sets it to the host OS in Camoufox's vocabulary (`win32` → `windows`, `darwin` → `macos`, `linux` → `linux`), so the claimed persona matches the machine that renders the GPU/user-agent stack. An explicit `CAMOUFOX_FINGERPRINT_OS` wins (case and surrounding whitespace are normalised). An invalid value falls back to the host default and logs one line instead of failing. This is not a plugin setting: set it in the environment before starting Claude Code. The 2026-10-24 detector runs showed why it matters: random macOS personas on this Windows host tripped `hasInconsistentTimingResolution`, while Windows-pinned personas passed cold and warm.

### What is installed at first launch

Measured on the build machine on 2026-10-24 with a fresh plugin data directory and no `uv` on `PATH`; times are the first server start (broker plus provisioning), and disk is the plugin data directory after it (`du`, hard links counted once).

| Engine | Provisioned under `<plugin data>` | Source host | Disk | First start |
|---|---|---|---:|---:|
| `cloak`, `playwright` | `runtime/`: `cloakbrowser-mcp@1.15.1` with Playwright aliased to `patchright@1.64.1` | registry.npmjs.org | 64 MB | ~7 s |
| `kameleo` | the same `runtime/` (Kameleo itself is **not** installed; see below) | registry.npmjs.org | 64 MB | ~7 s |
| `camoufox` | `tools/uv/0.13.5`, `tools/python/3.13.17`, `venvs/camoufox` (`camoufox-playwright-mcp==0.1.5`), `cache/uv` | github.com (uv release; Python builds), pypi.org / files.pythonhosted.org | 391 MB | ~28 s |
| `camoufox-native` | `tools/uv/0.13.5`, `tools/python/3.13.17`, `venvs/camoufox-native` (`mcp-camoufox==0.4.5`), `cache/uv` | github.com (uv release; Python builds), pypi.org / files.pythonhosted.org | 456 MB | ~28 s |

The Camoufox browser build (about 1.3 GB download, ~2.4 GB on disk) is separate and lives in Camoufox's machine-wide cache; it is not counted above and is only downloaded when absent. The CloakBrowser Chromium binary (~200 MB) is downloaded into `~/.cloakbrowser` on the first browser call, not at server start. A second start reuses everything: measured 0.5–3.3 s with no download.

**Overrides (environment variables, not plugin settings):**

| Variable | Effect |
|---|---|
| `UV`, `UV_BIN` | Use this `uv` instead of `PATH` or the pinned copy. It must be 0.13.5 or newer: a broken, older or unanswering value fails instead of falling back |
| `UV_PYTHON`, `PYTHON` | Use this interpreter (a path or a uv Python request) instead of the managed CPython. `UV_PYTHON` wins |
| `CAMOUFOX_NATIVE_COMMAND` | Use this `mcp-camoufox` executable instead of provisioning or `PATH` |
| `CLOAK_PLAYWRIGHT_MCP_PACKAGE`, `CAMOUFOX_MCP_PACKAGE`, `CAMOUFOX_NATIVE_PACKAGE` | Override the pinned package (the marker detects the change and rebuilds the runtime or venv) |
| `CAMOUFOX_BROWSER_BUILD`, `CAMOUFOX_NATIVE_BROWSER_BUILD` | Override the pinned Camoufox browser build |

Only the official uv release (SHA-256 verified against the checksum embedded in `lib/provision.mjs`), the Python builds uv resolves, the package index (PyPI by default), npm's registry and the Camoufox release index are contacted. Nothing is written to the user `PATH`, the Windows registry, `~/.local/bin` or a system Python site; `uv python install` runs with `--no-bin --no-registry`, and `UV_PYTHON_INSTALL_DIR`, `UV_CACHE_DIR` and the venvs all live under the plugin data directory.

- **The `kameleo` engine needs the Kameleo desktop app.** Kameleo is a commercial desktop application and is **not** a package the plugin can provision: the plugin never downloads, installs, runs or starts it, and there is no package-manager path (the build machine has no `winget`). Install it yourself:
  1. Download the Windows installer from <https://kameleo.io/downloads> (`Kameleo.Installer.exe`, about 150 MB; the vendor lists Windows 10 or newer).
  2. Run the installer and start Kameleo.
  3. Create or select a **Chromium (Chroma)** profile; a Junglefox (Firefox) profile cannot be attached over CDP.
  4. Copy the profile ID into **Kameleo profile ID** (`kameleo_profile_id`), select the `kameleo` engine and restart Claude Code.

  The vendor's download page states on 2026-10-24 that no account is needed and that a free tier exists; that is **vendor-reported and was not tested here**. `browser_capabilities.systemDependencies` reports the app as `unknown` until there is evidence, then `missing` with this same install hint in `browser_engine_status.lastError`. The free tier allows 2 concurrent profiles; licence or profile-start failures surface as the tool error, not as a plugin bug.
- **Kameleo endpoint.** With the endpoint setting empty, the launcher uses `ws://127.0.0.1:5050/playwright/<profile ID>`. `127.0.0.1` and `localhost` are the same local listener; the plugin uses the literal IPv4 loopback for determinism. The optional **Kameleo CDP endpoint** setting is a full override and is accepted only when it parses as a `ws://` or `wss://` URL whose host is `127.0.0.1`, `::1` or `localhost`, with no username or password and a port in 1–65535; a path is allowed, so a raw `devtools/browser/...` URL can be pasted. Anything else is rejected at startup with one line naming the setting and the failed rule. Non-loopback endpoints are rejected because a CDP endpoint is full browser control and this plugin's scope is local engines.
- **Lazy connection.** `initialize` and `tools/list` answer without Kameleo running: the official Playwright MCP CLI lists its tools from static schemas and creates a browser only on the first browser tool call. That call makes a local TCP attempt; when nothing listens on 5050 it fails after the CLI's 30-second CDP timeout and returns an `isError: true` tool result. The broker appends one sentence to that result until a tool call succeeds:
  `Kameleo is not answering at ws://127.0.0.1:5050/playwright/<profile ID>. Start the Kameleo app, sign in, and confirm the profile ID exists. Kameleo starts the profile itself when the endpoint is opened.`
  The exact offline error recorded on 2026-10-24 was:
  ```
  Error: async initializeServer: WebSocket error: connect ECONNREFUSED 127.0.0.1:5050
  Call log:
    - <ws connecting> ws://127.0.0.1:5050/playwright/<profile ID>
    - <ws error> ws://127.0.0.1:5050/playwright/<profile ID> error connect ECONNREFUSED 127.0.0.1:5050
    - <ws connect error> ws://127.0.0.1:5050/playwright/<profile ID> connect ECONNREFUSED 127.0.0.1:5050
    - <ws disconnected> ws://127.0.0.1:5050/playwright/<profile ID> code=1006 reason=
  ```
  A missing profile ID is different: it is a configuration error before any process starts. `initialize` answers with that reason, `tools/list` returns only the two meta-tools, `browser_engine_status.backendState` is `failed`, and `browser_capabilities.engineError` carries the exact sentence naming `kameleo_profile_id`.
- **The Kameleo runtime is the cloak runtime.** `launch-kameleo.mjs` starts the pinned `@playwright/mcp` CLI inside `<plugin data>/runtime`, the tree `launch.mjs` installs (`cloakbrowser-mcp@1.15.1`, Playwright aliased to Patchright 1.64.1). It does not go through `cloakbrowser-mcp` and does not start `patchright mcp`. A healthy runtime is reused; if it is absent or its pin marker does not match, the launcher provisions it with the same package, overrides and marker as `launch.mjs`, then starts the CLI with `--cdp-endpoint`. This first provisioning needs npm and takes the same 10–20 seconds the cloak engine's first launch takes.
- **Kameleo settings that do not apply.** The profile, its cookies, its logins and its proxy are Kameleo's. `profile_dir`, `proxy_server`, `proxy_bypass`, `humanize`, `human_preset`, `release_channel`, `geoip_proxy_match`, `licence_key`, `engine_version`, `headless`, `camoufox_profile` and `camoufox_data_dir` are ignored by this engine and are reported in `browser_capabilities.ignoredSettings`. `output_dir`, `tool_profile`, `disabled_tools` and the seven tool groups still apply.
- **Kameleo is UNVERIFIED.** Kameleo is not installed on the machine this release was built on, and nothing listens on TCP 5050. The adapter, the lazy handshake, the error path and the tool surface were verified offline; **no CDP attach and no detector run were performed, and no stealth claim is made for this engine.** The central unknown is whether Patchright in attach mode suppresses CDP tells; `connectOverCDP` is also documented by Playwright as lower fidelity for traces, video and some routing. Install Kameleo, activate a licence, create a Chroma profile and provide its ID, then record `isBot`, the CDP flags, timing, WebGL and console before treating the engine as validated. `browser_close` is marked `partial` because it closes the attached context and may close the Kameleo profile window; tracing is `partial`; video, recording and annotation are `unknown`. These are exposed at `full` and a call fails with the backend's own message.
- **Kameleo has no local diagnostics.** This path bypasses the Cloak bridge, so `cloakbrowser_binary_info` and `cloakbrowser_bridge_info` do not exist for it. The surface is 72 browser tools + 2 broker meta-tools = **74** at `full`, and 24 + 2 = **26** at `portable`.

The engine wrapper is pinned to `cloakbrowser@0.6.3` because the bridge (1.15.1) rejects `0.6.4` when humanize is enabled. The pin is in `launch.mjs` and is removed once the bridge accepts the newer wrapper. The Camoufox pins are in `launch-camoufox.mjs` and `.mcp.json` (`CAMOUFOX_MCP_PACKAGE`, `CAMOUFOX_BROWSER_BUILD`). The Kameleo launcher reuses the Cloak runtime and pins the same package, wrapper and driver identities; a unit test keeps the two launchers' constants equal.

## Settings

Values live in Claude Code's plugin configuration, not in this repository. Non-sensitive values are stored in `pluginConfigs` in `settings.json`; the licence key goes to the operating system credential store.

| Setting | Default | What it does |
|---|---|---|
| Headless | `false` | Headed is measurably less detectable. Turn on only for a display-less server |
| Browser engine | `cloak` | `cloak` runs the patched CloakBrowser Chromium. `playwright` falls back to stock Chromium and loses the stealth patches. `camoufox` runs the Camoufox stealth Firefox through `camoufox-playwright-mcp`; its Python runtime is provisioned automatically. `kameleo` attaches to a running Kameleo Chroma profile over CDP and needs the separately installed app, a licence and a profile ID. The broker reads this when the MCP server starts; restart Claude Code after changing it |
| Tool profile | `default` | `default` follows the selected engine's manifest: `full` for `cloak` and `playwright`, `portable` for `camoufox`, `camoufox-native` and `kameleo`. `portable` exposes the shared 24-tool browser core; `full` exposes everything the engine supports. The seven tool groups and `disabled_tools` still apply. Restart Claude Code after changing it |
| Camoufox native profile | `default` | Profile name for the `camoufox-native` engine. Letters, digits, `.`, `_` and `-`, starting with a letter or digit, up to 64 characters. One name per account; cookies and logins live under it |
| Camoufox native data directory | empty → `<plugin data>/profiles/camoufox-native` | Where the native engine keeps `profiles/<name>` and `logs/`. Use one directory per set of accounts |
| Kameleo profile ID | empty | Required when the browser engine is `kameleo`. The ID of a Chromium (Chroma) profile in Kameleo. The plugin never starts the app; it connects to Kameleo's local API, which starts the profile. Junglefox profiles cannot be attached over CDP |
| Kameleo CDP endpoint | empty → `ws://127.0.0.1:5050/playwright/<profile ID>` | Optional full WebSocket endpoint. Only `ws://` or `wss://` on `127.0.0.1`, `::1` or `localhost`, without userinfo, is accepted |
| Tool groups | all on | Seven checkboxes: vision, pdf, devtools, storage, network, testing, config. Turn one off to remove that group |
| Disabled tools | empty | Comma-separated tool names hidden from `tools/list` and rejected on call |
| Humanised input | `true` | Human-like mouse paths, keystroke timing and scrolling |
| Humanised preset | `default` | `careful` is slower and more deliberate |
| Release channel | `stable` | `preview` requires a Pro licence |
| GeoIP proxy match | `false` | Aligns timezone and locale to the proxy exit; enable with a proxy |
| Profile isolation | `shared` | `shared` keeps one profile per account for every Claude Code window, exactly as before. `workspace` derives one profile per project folder (`profiles/<engine>/ws-<hash>`) with a fresh login state, and moves to a numbered sibling if that profile is already in use. Ignored when Account profile or Profile directory is set. The free CloakBrowser tier still allows one browser at a time. See [Session safety and profile isolation](#session-safety-and-profile-isolation) |
| Account profile | empty → the plugin's default profile | One profile per account: `profiles/<engine>/<name>`, and `default` reaches the existing `profiles/default`. Wins over Profile isolation; ignored when Profile directory is set. Restart after changing it. See [Accounts](#accounts) |
| Profile directory | empty → `<plugin data>/profiles/default` | Explicit profile path; wins over Account profile and Profile isolation. Persistent cookies, logins and fingerprint seed. One directory per account |
| Proxy server / bypass | empty | Sticky proxy and hosts that skip it |
| Licence key | empty | CloakBrowser Pro key; the free tier allows one concurrent session |
| Engine version pin | empty | Pin a specific Chromium build; empty follows the stable channel |
| Artifacts directory | empty | Where screenshots, traces and session files are written |

The launcher drops empty optional values before starting the server, so leaving a directory or proxy blank behaves as "not configured" rather than as an empty path.

## Accounts

One browser profile per account. Set **Account profile** to a name such as `alice`; the broker resolves it to a directory under Claude Code's plugin data directory and starts the engine with it. With Account profile, Profile directory and Profile isolation at their defaults, nothing changes: the plugin uses `profiles/default` exactly as before.

| Account / setting | Effective profile directory |
|---|---|
| empty, isolation `shared` | `<plugin data>/profiles/default` |
| empty, isolation `workspace` | `<plugin data>/profiles/<engine>/ws-<sha256(cwd)[:7]>` |
| `default` | the engine's existing default profile — `profiles/default` for `cloak`/`playwright`, `profiles/<engine>/default` otherwise |
| `alice`, engine `cloak` | `<plugin data>/profiles/cloak/alice` |
| `alice`, engine `playwright` | `<plugin data>/profiles/playwright/alice` |
| `alice`, engine `camoufox` | `<plugin data>/profiles/camoufox/alice` |
| `profile_dir` set | that path, unchanged; Account profile and Profile isolation are ignored |

Precedence is **Profile directory → Account profile → Profile isolation → engine default**. Only the first value that is set applies.

- **Names:** 1–64 characters, starting with a letter or digit, then letters, digits, `.`, `_` or `-`. No trailing dot, no slash, no Windows device name (`CON`, `NUL`, `COM1`, …). An invalid name is a start-up error: no browser starts and `browser_engine_status.lastError` carries the exact reason. The name is validated before any path is built, so it can never escape the profiles directory.
- **`camoufox-native` and `kameleo` do not use account profiles.** Their manifests declare `profileApplies: false`, so `browser_capabilities.profileApplies` and `accountApplies` are `false`; use `camoufox_profile` for the native engine, and Kameleo's own profile for the attach engine. Profile isolation and the lock preflight are inert for them too.
- **One account at a time.** The plugin configuration holds one value per key, so one plugin instance runs one account. Changing Account profile, Profile directory, Profile isolation or the proxy takes effect when the MCP server restarts — restart Claude Code. There is no runtime account switch. Two Claude Code windows share the same configuration and therefore the same account unless Profile isolation is `workspace` and they run in different project folders.
- **Visibility.** `browser_capabilities` reports `account`, `profileDir`, `profileSource` (`profile_dir`, `account`, `workspace`, `engine`, `default`), `defaultProfileDir`, `availableAccounts` (at most 100 names), `availableAccountCount`, `accountApplies`, `profileApplies`, `profileIsolation`, `profileIsolationSource`, `profileFallback` and `profileLock`. `browser_engine_status` adds `account`, `profileDir`, `profileIsolation`, `profileApplies`, `profileFallback` and `profileLock`. The broker creates the account and workspace directories; it never copies, renames, moves or deletes a profile.
- **One profile per account, always.** Two identities in one profile overwrite each other's cookies and make the account history incoherent. Windows is case-insensitive, so `Alice` and `alice` are the same directory; the resolved path in `browser_capabilities` makes that visible.
- **Concurrency.** The bridge refuses a second server on the same profile directory (`Persistent profile is already active: <dir>`), and the CloakBrowser free tier allows **one concurrent browser session**. A second session is expected to fail at the engine; the plugin adds no account counter. A Pro licence is the supported path for concurrent sessions.
- See [Sign-in](#sign-in) for the manual, headed login each account needs.

### Per-account proxy file

A proxy can be sticky per account with a file beside the profile instead of the global **Proxy server** setting:

```
<plugin data>/profiles/cloak/alice.proxy        beside profiles/cloak/alice/
<plugin data>/profiles/default.proxy            beside profiles/default/
<plugin data>/profiles/camoufox/alice.proxy     beside profiles/camoufox/alice/
```

- **Proxy server set:** it wins, and one line in the MCP log says the file is ignored. **Proxy server empty:** the file is read for the active account, or beside the default profile when no account is set (only if the file exists). No file means a direct connection.
- The file is one line, no comments: `http://user:pass@host:port`, `https://…`, `socks4://…` or `socks5://…`. A missing scheme means `http://`. Percent-encode `@`, `:`, `/` inside credentials. The value is passed to the engine unchanged.
- A file that cannot be read, is not valid UTF-8, has more than one non-empty line, or does not parse as a proxy URL is a **start-up error**: the browser does not start and the error names the file, never its contents. A bad file never falls back to a silent direct connection.
- **The file is a credential in plaintext.** On POSIX run `chmod 600 <file>`; on Windows it inherits the user-profile ACL (the plugin does not change permissions). Keep it out of the repository, shared backups, PRs and screenshots; back it up like a password. The plugin only reads it, never writes it.
- The URL is never logged and never returned: `browser_capabilities` reports `proxySource` (`setting`, `account-file`, `none` or `error`) and `proxyConfigured` (boolean). Credential-bearing URLs in relayed backend log lines are masked as `scheme://***@host`.

### Backup, rename and delete (manual)

- **Backup:** close Claude Code (at least the browser), then copy the account directory and its `.proxy` file. A live Chromium profile contains lock files and can be copied in an inconsistent state. `.cloakbrowser-seed` sits inside the directory; keeping it keeps the fingerprint.
- **Rename:** close the browser, rename the directory and the `.proxy` file, change Account profile (or Profile directory), and restart. Nothing is migrated for you.
- **Delete:** close the browser, delete the directory and the `.proxy` file. Irreversible. There is no delete in the plugin.
- To switch accounts: `/plugin` → Configure → set Account profile → restart Claude Code.

## Session safety and profile isolation

A persistent Chromium profile can be used by only one browser at a time. The engine bridge takes an exclusive lock at backend start-up, before any browser or tool call, so a second Claude Code window that starts against the same profile loses the whole tool list, not just the browser. Two windows can differ in project folder, account or scope and still collide, because `${CLAUDE_PLUGIN_DATA}` and the default profile are shared by every window.

Claude Code always starts one MCP server per window, and this plugin cannot change when the bridge locks. It can choose the profile, check the lock first and explain the result. That is what this release adds.

### Profile isolation

**Profile isolation** (`profile_isolation`) has two values:

| Value | Profile for a window with no Account profile and no Profile directory | Behaviour |
|---|---|---|
| `shared` (default) | `<plugin data>/profiles/default` (or the engine default) | Exactly the previous behaviour, byte for byte. Two windows share one identity, and a second window is stopped by the loud preflight below |
| `workspace` | `<plugin data>/profiles/<engine>/ws-<sha256(cwd)[:7]>` | One identity per project folder, Playwright-style. Different projects never collide. The profile starts with a **fresh login state** — no cookies, logins or fingerprint seed from `profiles/default` are carried over |

- The hash is Playwright's own derivation: SHA-256 of the exact working-directory string, first seven hex characters. For example `D:\Projects2\StealthBrowserAutomation` → `ws-0b0e194`. The same folder always maps to the same profile; a different spelling of the same path (different case or separator) maps to a different one.
- Precedence: **Profile directory → Account profile → Profile isolation → engine default**. An explicit Profile directory or Account profile therefore keeps its exact previous meaning, and `shared` never changes an existing path.
- The free CloakBrowser licence still allows **one browser at a time**. `workspace` removes the profile collision, not the seat limit: with two browsers running, the second fails at the engine with the licence error, not with the profile lock. The stock `playwright` and `camoufox` engines are not Cloak-licensed and do not have that seat cap.
- A workspace profile is an ordinary profile directory: it keeps its own `.proxy` file beside it (`<plugin data>/profiles/<engine>/ws-<hash>.proxy`) and survives restarts and updates. Nothing is moved, copied or deleted.

### Loud preflight

Before spawning the backend, the broker reads the bridge's own lock file, `<profile>/.cloakbrowser-mcp-profile.lock`. When a **live** process owns it, the broker does not start a doomed backend: the meta-tools answer instead, and the same sentence appears in `initialize.instructions`, `browser_capabilities.engineError` and `browser_engine_status.lastError`:

```
The browser profile <dir> is already in use by pid 25028, started 2026-10-24T14:09:50.197Z.
Close the Claude Code session or browser window that owns this profile (pid 25028, started ...);
if that process is gone, the lock is reclaimed automatically. You can also set "Profile directory"
(profile_dir) to another folder, or set "Profile isolation" (profile_isolation) to workspace so each
project folder gets its own profile. Restart Claude Code after the change. The backend was not started.
```

- `browser_capabilities.profileLock` and `browser_engine_status.profileLock` report `{ state, profileDir, path, owner: { pid, createdAt }, fix }`. `state` is `free` (no lock), `live` (owner exists, start refused), `stale` (owner is gone; the bridge reclaims it automatically) or `invalid` (the file exists but cannot be read; the start is refused and the fix names the file).
- A lock whose recorded process is gone is **not** removed by the plugin. It is reported as `stale`, and the bridge reclaims it at start-up exactly as before.
- A lock file that exists but cannot be read also stops the start: the bridge cannot reclaim it either, so the plugin names it instead of letting the backend exit.
- The preflight is best-effort: it narrows the window, but the bridge remains the authority. If another process takes the lock between the check and the bridge start, the bridge's own message now reaches `browser_engine_status.lastError` as well, because the last launcher/backend stderr line is reported for **every** engine.
- Proxy URLs are never printed: the lock text contains no proxy, and relayed stderr is redacted as before.

### Loud fallback (workspace only)

With `profile_isolation=workspace`, when the derived workspace profile is locked by a live owner, the broker tries the numbered siblings `ws-<hash>-2`, `ws-<hash>-3`, `ws-<hash>-4` and `ws-<hash>-5`. The first one whose lock is absent, stale or unreadable-by-the-bridge is used, and the switch is always reported:

- `browser_capabilities.profileFallback` and `browser_engine_status.profileFallback` = `{ from, to, reason }`.
- `initialize.instructions` carries the same sentence.
- One line in the MCP log says the same.

```
The workspace profile <data>/profiles/cloak/ws-0b0e194 was already in use (pid 25028, started ...),
so this session uses <data>/profiles/cloak/ws-0b0e194-2 instead. It has separate cookies, logins
and fingerprint seed.
```

- The fallback profile is a **different identity**: if the first window is signed in, the fallback window is not. Nothing is shared, copied or migrated.
- When `ws-<hash>-2` through `ws-<hash>-5` are all live-locked, no backend starts and the error says so, naming the base owner.
- With `shared` (the default) there is **no fallback**. The loud preflight is the whole behaviour; a busy profile is never silently swapped for another identity.
- Fallback applies only to the profile derived by `profile_isolation=workspace`. An explicit Account profile or Profile directory is never moved aside.

### Concurrent windows, plainly

| Situation | `shared` (default) | `workspace` |
|---|---|---|
| Two windows, different project folders | Second window: loud preflight, no browser | Both get their own profile; two browsers (free Cloak tier refuses the second with its licence error) |
| Two windows, same project folder | Second window: loud preflight, no browser | Second window: falls back to `ws-<hash>-2` (a fresh identity) |
| Two windows, same named Account profile | Second window: loud preflight, no browser | Same — an account is never moved aside |
| Same profile, one window closed | Next start reclaims the stale lock automatically | Same |

To run two CloakBrowser browsers at once you need a Pro licence; no profile setting adds a seat. `workspace` is for isolating projects, not for lifting that limit.

## Engines and the broker

`broker.mjs` is the single MCP server Claude Code starts. It reads the **Browser engine** setting, discovers every `engines/*.json` manifest, validates it, loads the selected one, starts `launch.mjs` for that engine and relays JSON-RPC in both directions. The engine value is an enum in the plugin configuration, never a command or a path. The enum (`browser_engine.options`) is generated from the manifests; adding an engine does not edit the broker. See `engines/README.md` for the add-an-engine recipe.

| Engine | Manifest | Backend | Notes |
|---|---|---|---|
| `cloak` (default) | `engines/cloak.json` | CloakBrowser Chromium on Patchright | Stealth patches; the 1.x browser behaviour is unchanged |
| `playwright` | `engines/playwright.json` | Stock Playwright Chromium | Same Playwright MCP contract, no stealth patches |
| `camoufox` | `engines/camoufox.json` | Camoufox stealth Firefox via `camoufox-playwright-mcp` 0.1.5 | Provisions uv, Python and its venv automatically; portable by default; four tools absent and `browser_pdf_save` unusable; no CDP |
| `camoufox-native` | `engines/camoufox-native.json` | Camoufox stealth Firefox via PyPI `mcp-camoufox` 0.4.5, fetched into a plugin-managed venv | Its own 27-tool contract; 16 canonical aliases + 9 prefixed native tools; portable by default; 10 portable verbs absent; no CDP; licence FSL-1.1-MIT; never bundled |
| `kameleo` | `engines/kameleo.json` | A running Kameleo Chroma profile over CDP | Full 72-tool contract over attach; portable by default (26), 74 at full; the profile and its proxy belong to Kameleo; Junglefox unsupported; no local diagnostics; **stealth UNVERIFIED**, no detector run |

Every manifest is the source of truth for whether the profile model applies: `cloak`, `playwright` and `camoufox` own a local profile directory and resolve `profile_dir`, `account` and `profile_isolation` (`profileApplies: true`, the default). `camoufox-native` (the app owns its profile and its lease) and `kameleo` (CDP attach) declare `profileApplies: false`; for them the profile settings, the lock preflight and the workspace derivation are inert, and the meta-tools report `profileApplies: false`. The broker has no engine-id branch for this rule.

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

### Kameleo engine

`kameleo` is the attach engine: the browser already exists as a Kameleo profile, and the plugin drives it through Kameleo's local CDP WebSocket. Everything is declared in `engines/kameleo.json` and `launch-kameleo.mjs`; there is no engine-specific code in the broker, which reads the manifest's `requiredEnv`, `runtime`, `capabilities` and `systemDependencies` blocks generically.

- **Setup (the plugin never installs Kameleo).** Kameleo is a commercial desktop application, so it is a detected prerequisite, not a provisioned dependency. There is no package-manager path (no `winget` on the build machine) and the plugin never downloads, runs or starts the installer:
  1. Download `Kameleo.Installer.exe` (about 150 MB) from <https://kameleo.io/downloads>; the vendor lists Windows 10 or newer.
  2. Run the installer, start Kameleo, sign in and activate the licence.
  3. Create or select a **Chromium (Chroma)** profile (Junglefox is Firefox and cannot be attached). Start the profile or let Kameleo start it when the endpoint is opened.
  4. Copy the profile ID from the profile row into **Kameleo profile ID**, select the `kameleo` engine, and restart Claude Code.

  The vendor's download page stated on 2026-10-24 that no account is needed and that a free tier exists; that is **vendor-reported and was not tested here**.
- **Dependency reporting.** `browser_capabilities.systemDependencies` lists the app with `status: "unknown"` until there is evidence, then `"missing"` with the install hint after a configuration error, a backend failure or a failed tool call. The same hint is appended to `browser_engine_status.lastError` and to the synthesized `initialize` instructions. The declared fields are `id`, `label`, `required`, `downloadUrl`, `installerName`, `installHint` and `licenceNote`; the broker never acts on them.
- **Endpoint.** The default is `ws://127.0.0.1:5050/playwright/<profile ID>`, with the ID percent-encoded as one path segment. An explicit **Kameleo CDP endpoint** overrides it, with the loopback-only validation described under Requirements.
- **Missing profile ID.** This is a configuration error before any process starts: `initialize` explains it, only the two meta-tools are exposed, `browser_engine_status.backendState` is `failed`, and `browser_engine_status.lastError` / `browser_capabilities.engineError` carry the exact sentence that names `kameleo_profile_id`.
- **App not running or port closed.** `initialize` and `tools/list` still answer, because the CLI is lazy. The first browser call fails with `isError: true`; the broker appends the Kameleo prerequisite sentence. After the first successful tool call, errors pass through unchanged. This enrichment is declared by the manifest (`runtime.errorHint`) and exists only for engines that declare it; every other engine's relay is byte-identical.
- **Tool support.** `*` is `full`; `browser_close` and the two tracing tools are `partial`; `browser_start_video`, `browser_stop_video`, the three video helpers, `browser_start_recording`, `browser_stop_recording` and `browser_annotate` are `unknown` (exposed, with a reason, and a call may fail). No tool is `none`: the backend is the full official 72-tool Playwright MCP contract.
- **Group switches apply.** Unlike `camoufox-native`, this engine runs the official Playwright MCP CLI, so the seven `tools_*` switches shape `PLAYWRIGHT_MCP_CAPS` exactly as they do for `cloak`. `browser_capabilities.groupSwitchesApply` is `true`, and `browser_capabilities.cdpAttach` is `true`.
- **Diagnostics.** `browser_engine_status` gains `kameleoEndpoint` and `kameleoProfileId` for this engine only. The names come from the manifest's `runtime.statusKeys`; they are absent for every other engine.
- **No bridge, no local diagnostics.** The launcher starts the pinned `@playwright/mcp` CLI directly, so `cloakbrowser_binary_info` and `cloakbrowser_bridge_info` do not exist here and the full surface is 74, not 76. The seven tool groups, `tool_profile`, `disabled_tools` and `output_dir` still apply.
- **Stealth status: UNVERIFIED.** Kameleo is not installed on the build machine and nothing listens on 5050, so no attach and no detector run were performed. Patchright's documented benefit is on its own launch path; whether it suppresses CDP tells when the client attaches to Kameleo's Chromium is **unknown**. Kameleo also advises against adding third-party stealth patches, so the combination is untested in both directions. Do not read this engine as stealth-validated until a recorded detector run exists.

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
| `kameleo` | `portable` | 74 | 26 (of which 2 meta) |

The `camoufox-native` counts include the two broker meta-tools: 25 exposed tools at `full` (16 canonical + 9 prefixed) and 14 canonical tools at `portable` — ten portable verbs are not available on that engine. The group switches do not apply to it. The `kameleo` counts also include the two meta-tools: 72 browser tools at `full` and 24 at `portable`; the group switches do apply, so with fewer groups both counts fall. With all seven groups off, `kameleo` exposes 27 at `full` (25 browser + 2 meta) and 21 at `portable` (19 + 2): the CLI's minimal 25-tool set contains 19 of the 24 portable names, including `browser_close`.

The profile is applied before `disabled_tools`; for `cloak`, `playwright`, `camoufox` and `kameleo` the seven group switches still shape the backend list first. With `tools_storage=false` cloak exposes 59 at `full` and 21 at `portable`; with `tools_pdf=false` it exposes 75 at `full` and 26 at `portable`.

The broker adds two meta-tools that are always present and cannot collide with backend tools:

| Meta-tool | What it reports |
|---|---|
| `browser_capabilities` | Selected engine, label, contract, effective `toolProfile` and its source, per-tool support and notes, the portable list, what the profile and manifest hid, how to change engines, and the profile facts: `profileIsolation`, `profileApplies`, `profileFallback` and `profileLock` |
| `browser_engine_status` | Selected engine, effective tool profile, backend state, backend version, startup and `tools/list` timing, last error, and the same profile facts |

Both meta-tool descriptions mention the profile diagnostic, so an agent that sees only the two-tool degraded surface knows to call them when a profile is already in use.

Total surface for `cloak` at the default profile: 76 tools = 72 backend `browser_*` tools + 2 local diagnostics + 2 broker meta-tools. At `portable`: 26 = 24 backend `browser_*` tools + 2 broker meta-tools. Engine and profile changes apply after the MCP server restarts.

## Sign-in

Sign in to Google or any site manually, in the headed window, with the persistent profile. Automate only the logged-in session. **Never automate the Google credential form** — or any site's password, recovery, 2FA, passkey or CAPTCHA step.

Per account:

1. Set **Account profile** to the account name and restart Claude Code.
2. Ask the agent to open the site's sign-in page in the headed window (`headless` stays off).
3. The agent stops at the credential form and says it is waiting.
4. Type the email, password and any 2FA or CAPTCHA in that window yourself and finish the login.
5. The agent confirms the signed-in state by reading the page (name or avatar), never by reading secrets.
6. The session is stored in that account's profile directory and reused on the next start.

Never automated, for any account or engine: the credential form, password entry, account recovery, 2FA or passkey prompts, CAPTCHA or bot challenges; account creation; copying cookies, storage state or a profile between accounts to skip a login. Log in through the same proxy and approximate location the account normally uses — a sudden geo change is an anomaly signal to the platform. One account per profile, always.

## Version and updates

The plugin is version 2.8.0. It adds session-safe profiles (`profile_isolation`, the lock preflight and the workspace fallback) without changing the default profile path. It pins `cloakbrowser-mcp@1.15.1`, runs it on `patchright@1.64.1`, and pins the engine wrapper to `0.6.3`. The Camoufox engine pins `camoufox-playwright-mcp==0.1.5`, the managed `uv` `0.13.5`, CPython `3.13.17` and browser build `v156.0.1-beta.39`. The Camoufox native engine provisions `mcp-camoufox==0.4.5` from PyPI with the same uv/Python pins and browser build `156.0.1-beta.39` in `.mcp.json` (`CAMOUFOX_NATIVE_PACKAGE`, `CAMOUFOX_NATIVE_BROWSER_BUILD`). The Kameleo engine has no package pin of its own: it reuses the `cloakbrowser-mcp@1.15.1` runtime and starts its pinned `@playwright/mcp` CLI with `--cdp-endpoint`. The uv version, its per-platform SHA-256 values and the Python pin live in `lib/provision.mjs`; the package pins live in `.mcp.json` or the launcher. The plugin version moves independently of the MCP pins.

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

The optional `camoufox-native` engine provisions **PyPI `mcp-camoufox` 0.4.5** at first start, which is licensed **FSL-1.1-MIT** (source-available, not OSI-approved; it restricts competing products for two years). The plugin does not bundle or redistribute it: it is fetched from the public package index into the plugin data directory. This is a licence note, not legal advice.

The optional `kameleo` engine drives the **Kameleo desktop application**, which is proprietary and separately licensed by its vendor. The plugin does not bundle, download or redistribute Kameleo; it connects only to the local CDP endpoint of a copy the user installed and licensed. This is a licence note, not legal advice.
