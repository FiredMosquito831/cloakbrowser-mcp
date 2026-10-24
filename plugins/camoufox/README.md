# camoufox

Claude Code plugin fixed to the **Camoufox** contract engine: stealth Firefox driven by `camoufox-playwright-mcp==0.1.5` through the Playwright MCP tool contract. One MCP entry (`STEALTH_ENGINE=camoufox`), server key `camoufox`, tool names `mcp__plugin_camoufox_camoufox__*`.

The default `portable` profile exposes **26 tools**: the shared 24-tool `browser_*` core plus the two broker meta-tools. `full` exposes **69**: 67 `browser_*` tools plus the two meta-tools. Five canonical tools are not exposed: `browser_annotate`, `browser_emulate_media`, `browser_start_recording` and `browser_stop_recording` are not implemented by the wrapper, and `browser_pdf_save` cannot run on Firefox. This engine has no CDP and no Cloak-specific diagnostics.

This plugin is the single-engine alternative to the universal `cloakbrowser` plugin. Install one path per engine, never both.

## Install

From the marketplace:

```
/plugin marketplace add FiredMosquito831/cloakbrowser-mcp
/plugin install camoufox@cloakbrowser-mcp
```

From a local checkout:

```
/plugin marketplace add D:\Projects2\StealthBrowserAutomation\fork
/plugin install camoufox@cloakbrowser-mcp
```

Claude Code prompts for the settings below during install. Non-interactively:

```bash
claude plugin install camoufox@cloakbrowser-mcp \
  --config headless=false \
  --config profile_dir=/home/you/.camoufox-profiles/linkedin
```

Change them later with `/plugin` → Configure, the per-option rows in `/config`, or:

```bash
claude plugin configure camoufox@cloakbrowser-mcp

printf '%s' '{"profile_dir":"/home/you/.camoufox-profiles/linkedin"}' | \
  claude plugin configure camoufox@cloakbrowser-mcp --values-stdin
```

Restart Claude Code after a change so the MCP server restarts with the new environment.

## Engine

The engine is fixed to `camoufox` in `.mcp.json`; there is no `browser_engine` setting and nothing to switch. `browser_capabilities.engineChoices` reports only `["camoufox"]`, `engineDefaultToolProfile` is `portable`, and `launch` is `launch-camoufox.mjs`. The engine set in this plugin is `engines/camoufox.json` plus the shared `engines/profiles.json`; the manifest is a generated copy of the universal plugin's canonical manifest.

`browser_capabilities.howToChangeEngine` is inherited from the shared broker and still names the universal plugin. It is the only place this plugin mentions it: switching engines means installing `cloakbrowser`; this plugin cannot do it.

## Requirements and first start

- Node 22.13+ or 24+ for the broker. Nothing else is a manual prerequisite.
- The launcher provisions everything under Claude Code's plugin data directory at the first MCP server start: a pinned checksum-verified `uv` 0.13.5, a uv-managed CPython 3.13.17, and a venv with `camoufox-playwright-mcp==0.1.5` plus its Camoufox dependency. Nothing is installed system-wide and no launcher starts a shell.
- **A `uv` you provide must be 0.13.5 or newer.** The pinned `uv` is the one that installs the managed CPython 3.13.17; older versions fail with `No download found for request: cpython-3.13.17-windows-x86_64-none` and the launcher exits. A `uv` on `PATH` older than 0.13.5, or one that does not answer `--version`, is ignored with one log line and the pinned copy is provisioned instead. An explicit `UV`/`UV_BIN` older than 0.13.5 is refused with the version it reported, never silently replaced.
- The pinned Camoufox build `v156.0.1-beta.39` is a **~1.3 GB download and ~2.4 GB on disk** in Camoufox's machine-wide cache (`%LOCALAPPDATA%\camoufox` on Windows). It is downloaded when absent. The browser starts on the first browser tool call, not at `initialize`.
- A cold first start can take tens of seconds; if Claude Code's MCP startup timeout expires, restart Claude Code (`/reload-plugins`). The next start reuses what was provisioned and downloads nothing.
- **Windows shim.** The pinned wrapper installs a signal watchdog through anyio, which Windows does not implement; without a fix the server exits before answering `initialize`. `camoufox_entry.py` replaces only that receiver with an empty one (the broker owns shutdown on every platform) and then runs the unmodified wrapper. On other platforms the shim is not installed.
- **Camoufox cache side effect.** Camoufox stores builds in a machine-wide user cache and its installer makes the build it installs the active one. Installing this pin can move another Camoufox consumer on this machine to `v156.0.1-beta.39`. This plugin's launches stay pinned through `CAMOUFOX_EXECUTABLE_PATH` regardless of the active build.

Overrides are environment variables, not plugin settings:

| Variable | Effect |
|---|---|
| `UV`, `UV_BIN` | Use this `uv` instead of `PATH` or the pinned copy. It must be 0.13.5 or newer: a broken, older or unanswering value fails instead of falling back |
| `UV_PYTHON`, `PYTHON` | Use this interpreter instead of the managed CPython. `UV_PYTHON` wins |
| `CAMOUFOX_MCP_PACKAGE` | Override `camoufox-playwright-mcp==0.1.5`; the venv marker detects the change and rebuilds the venv |
| `CAMOUFOX_BROWSER_BUILD` | Override the pinned browser build |

Only the official uv release (SHA-256 verified against the checksums in `lib/provision.mjs`), the Python builds uv resolves, the package index, and the Camoufox release index are contacted. `uv python install` runs with `--no-bin --no-registry`, and `UV_PYTHON_INSTALL_DIR`, `UV_CACHE_DIR` and the venvs all live under the plugin data directory.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Headless | `false` | Headed is measurably less detectable. Turn on only for a display-less server |
| Tool profile | `default` | `default` follows the engine manifest (`portable` for Camoufox). `portable` exposes the shared 24-tool browser core; `full` exposes everything this engine supports. The seven tool groups and `disabled_tools` still apply. Restart Claude Code after changing it |
| Tool groups | all on | Seven checkboxes: vision, pdf, devtools, storage, network, testing, config. `tools_pdf` is kept for cross-engine configuration; this engine never exposes `browser_pdf_save` |
| Disabled tools | empty | Comma-separated exposed names hidden from `tools/list` and rejected on call |
| Account profile | empty → this plugin's default profile | One profile per account: `profiles/camoufox/<name>`, and `default` reaches the existing `profiles/camoufox/default`. Ignored when Profile directory is set. Restart after changing it. See [Accounts](#accounts) |
| Profile directory | empty → `<plugin data>/profiles/camoufox/default` | Explicit profile path; wins over Account profile. Persistent cookies, logins and fingerprint seed. One directory per account |
| Proxy server / bypass | empty | Sticky proxy and hosts that skip it |
| Artifacts directory | empty | Where screenshots, traces and session files are written |

The launcher drops empty optional values before starting the server, so leaving a directory or proxy blank behaves as "not configured" rather than as an empty path.

## Accounts

One browser profile per account. Set **Account profile** to a name such as `alice`; the broker resolves it to a directory under Claude Code's plugin data directory and starts Camoufox with it. With both Account profile and Profile directory empty, nothing changes: the plugin uses `profiles/camoufox/default` exactly as before.

| Account / setting | Effective profile directory |
|---|---|
| empty, `profile_dir` empty | `<plugin data>/profiles/camoufox/default` |
| `default` | `<plugin data>/profiles/camoufox/default` — the profile you already have |
| `alice` | `<plugin data>/profiles/camoufox/alice` |
| `profile_dir` set | that path, unchanged; Account profile is ignored |

- **Names:** 1–64 characters, starting with a letter or digit, then letters, digits, `.`, `_` or `-`. No trailing dot, no slash, no Windows device name (`CON`, `NUL`, `COM1`, …). An invalid name is a start-up error: no browser starts and `browser_engine_status.lastError` carries the exact reason. The name is validated before any path is built.
- **One account at a time.** The plugin configuration holds one value per key, so one plugin instance runs one account. Changing Account profile, Profile directory or the proxy takes effect when the MCP server restarts — restart Claude Code. There is no runtime account switch.
- **Visibility.** `browser_capabilities` reports `account`, `profileDir`, `profileSource` (`profile_dir`, `account`, `default`), `defaultProfileDir`, `availableAccounts` (at most 100 names), `availableAccountCount` and `accountApplies`. `browser_engine_status` adds `account` and `profileDir`. The broker creates the account directory; it never copies, renames or deletes a profile.
- **One profile per account, always.** Two identities in one profile overwrite each other's cookies. Windows is case-insensitive, so `Alice` and `alice` are the same directory.
- **Concurrency.** Camoufox locks a profile while a session uses it, so a second session on the same directory is refused by the engine. A second session on a different profile runs a second browser (each has its own process). The CloakBrowser free-tier one-session limit does **not** apply to this engine; there is no CloakBrowser binary here.
- See [Sign-in](#sign-in) for the manual, headed login each account needs.

### Per-account proxy file

A proxy can be sticky per account with a file beside the profile instead of the global **Proxy server** setting:

```
<plugin data>/profiles/camoufox/alice.proxy     beside profiles/camoufox/alice/
<plugin data>/profiles/camoufox/default.proxy   beside profiles/camoufox/default/
```

- **Proxy server set:** it wins, and one line in the MCP log says the file is ignored. **Proxy server empty:** the file is read for the active account, or beside the default profile when no account is set (only if the file exists). No file means a direct connection.
- The file is one line, no comments: `http://user:pass@host:port`, `https://…`, `socks4://…` or `socks5://…`. A missing scheme means `http://`. Percent-encode `@`, `:`, `/` inside credentials. The value is passed to the engine unchanged.
- A file that cannot be read, is not valid UTF-8, has more than one non-empty line, or does not parse as a proxy URL is a **start-up error**: the browser does not start and the error names the file, never its contents. A bad file never falls back to a silent direct connection.
- **The file is a credential in plaintext.** On POSIX run `chmod 600 <file>`; on Windows it inherits the user-profile ACL (the plugin does not change permissions). Keep it out of the repository, shared backups, PRs and screenshots; back it up like a password. The plugin only reads it, never writes it.
- The URL is never logged and never returned: `browser_capabilities` reports `proxySource` (`setting`, `account-file`, `none` or `error`) and `proxyConfigured` (boolean). Credential-bearing URLs in relayed backend log lines are masked as `scheme://***@host`.

### Backup, rename and delete (manual)

- **Backup:** close Claude Code (at least the browser), then copy the account directory and its `.proxy` file. A live profile contains lock files and can be copied inconsistently. The fingerprint seed sits inside the directory; keeping it keeps the fingerprint.
- **Rename:** close the browser, rename the directory and the `.proxy` file, change Account profile (or Profile directory), and restart. Nothing is migrated for you.
- **Delete:** close the browser, delete the directory and the `.proxy` file. Irreversible. There is no delete in the plugin.
- To switch accounts: `/plugin` → Configure → set Account profile → restart Claude Code.

## Sign-in

Sign in to Google or any site manually, in the headed window, with the persistent profile. Automate only the logged-in session. **Never automate the Google credential form** — or any site's password, recovery, 2FA, passkey or CAPTCHA step.

Per account:

1. Set **Account profile** to the account name and restart Claude Code.
2. Ask the agent to open the site's sign-in page in the headed window (`headless` stays off).
3. The agent stops at the credential form and says it is waiting.
4. Type the email, password and any 2FA or CAPTCHA in that window yourself and finish the login.
5. The agent confirms the signed-in state by reading the page (name or avatar), never by reading secrets.
6. The session is stored in that account's profile directory and reused on the next start.

Never automated, for any account: the credential form, password entry, account recovery, 2FA or passkey prompts, CAPTCHA or bot challenges; account creation; copying cookies, storage state or a profile between accounts to skip a login. One account per profile, always.

Settings that the Camoufox engine cannot honour are **not declared**: `humanize`, `human_preset`, `release_channel`, `geoip_proxy_match`, `licence_key`, `engine_version`, `browser_engine`, `camoufox_profile`, `camoufox_data_dir`, `kameleo_profile_id` and `kameleo_endpoint`. `browser_capabilities.ignoredSettings` still reports the first six, because the shared manifest names them for the universal broker. CloakBrowser's humanised input, release channel, GeoIP proxy matching and licence do not exist in this engine.

## Tool profiles and unavailable tools

`engines/profiles.json` defines the shared `portable` list (24 browser tools) and `full` (everything the manifest does not mark `none`). The manifest marks these `none` with a reason in `browser_capabilities.unavailableTools` or `toolSupportNotes`:

| Tool | Why |
|---|---|
| `browser_annotate` | Not implemented by `camoufox-playwright-mcp` 0.1.5 |
| `browser_emulate_media` | Not implemented by the wrapper |
| `browser_start_recording` / `browser_stop_recording` | Not implemented by the wrapper |
| `browser_pdf_save` | Listed by the backend but PDF output only works on headless Chromium |
| `browser_run_code_unsafe` | `partial`: it runs asynchronous **Python** Playwright code, not JavaScript. Hidden under `portable`, exposed with a note under `full` |

The seven group switches shape the backend list before the profile and `disabled_tools`, exactly as they do for the universal plugin. The two broker meta-tools are always present.

## Profile and sessions

With the profile setting empty, the plugin uses `<plugin data>/profiles/camoufox/default` inside its own `${CLAUDE_PLUGIN_DATA}` (for example `.../data/camoufox-cloakbrowser-mcp/profiles/camoufox/default`). That directory is separate from the universal plugin's profile; cookies and logins are not shared. The browser engine locks a profile while a session uses it, so do not point two running sessions at the same directory. One directory per account; see [Accounts](#accounts) for the name setting.

## Detection record (2026-10-24)

One real headed run through **this plugin's** broker (`full` profile, fresh profile directory, `deviceandbrowserinfo.com/are_you_a_bot`):

- `initialize` and `tools/list` answered; **69 tools**; `engineChoices: ["camoufox"]`; backend `Playwright 0.1.5`; broker version `2.6.0`.
- A `browser_route` for `**fingerprint-scan.com/**` with **status 204** was registered; `browser_route_list` reported `**fingerprint-scan.com/** (status=204)`. A direct navigation to the blocked host was aborted by the 204 fulfillment (`Page.goto: NS_BINDING_ABORTED`), which is the block working, not a detector failure. The detector page itself did not redirect and the URL stayed on `deviceandbrowserinfo.com`.
- Verdict: **`isBot: false`**, and every one of the 22 reported flags `false`, including `isAutomatedWithCDP`, `isAutomatedWithCDPInWebWorker`, `hasInconsistentTimingResolution`, `isPlaywright`, `hasWebdriverTrue` and the WebGL/client-hint/worker checks. `navigator.webdriver` was `false`; UA was Firefox 156 on `Win32`; WebGL reported an Intel ANGLE renderer.
- Console capture worked: 13 messages (2 errors, 8 warnings).
- `browser_close` succeeded.

This is one recorded run on this Windows host, not a general stealth validation. Re-test after every browser or wrapper bump. The wrapper has no CDP channel and the seven group switches do not change that.

## Updates and versions

This plugin is version **2.7.1**, the same version as `cloakbrowser` while both share a generated core. Update them separately:

```bash
claude plugin marketplace update
claude plugin update camoufox@cloakbrowser-mcp
# then /reload-plugins
```

A core fix bumps both plugins; a merge alone does not update a running copy. The plugin settings of `cloakbrowser` and `camoufox` are separate: uninstalling one and installing the other does not carry the profile, proxy or tool settings over.

The shared core and the Camoufox manifest are generated. Edit `shared/core/` or the canonical `plugins/cloakbrowser/engines/camoufox.json`, then run `node scripts/sync-plugin-core.mjs --write` from the repository root. `node scripts/sync-plugin-core.mjs --check` fails on any byte difference and runs in `npm run check:static`. The generated core also contains the launchers for the other engines; no manifest in this plugin names them, so they are inert files, not exposed behaviour.

## Licence

This plugin is MIT. It does **not** bundle `camoufox-playwright-mcp`: the package is fetched from the public PyPI index into the plugin data directory at first start, and the plugin does not redistribute it. Camoufox is a separate open-source project. This is a licence note, not legal advice.
