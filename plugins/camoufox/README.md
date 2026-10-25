# camoufox

Claude Code plugin fixed to the **Camoufox** contract engine: stealth Firefox driven by `camoufox-playwright-mcp==0.1.5` through the Playwright MCP tool contract. One MCP entry (`STEALTH_ENGINE=camoufox`), server key `camoufox`, tool names `mcp__plugin_camoufox_camoufox__*`.

The default `portable` profile exposes **27 tools**: the shared 24-tool `browser_*` core plus the three broker meta-tools (`browser_capabilities`, `browser_engine_status`, `browser_profiles`). `full` exposes **70**: 67 `browser_*` tools plus the three meta-tools. Five canonical tools are not exposed: `browser_annotate`, `browser_emulate_media`, `browser_start_recording` and `browser_stop_recording` are not implemented by the wrapper, and `browser_pdf_save` cannot run on Firefox. This engine has no CDP and no Cloak-specific diagnostics.

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
- **The venv pins the Python MCP stack.** Beside the wrapper it installs `fastmcp==3.4.7` and `mcp==1.29.0`, the versions the wrapper's own `uv.lock` resolves. The wrapper's `pyproject.toml` declares only `fastmcp>=3.4.2` with no upper bound, so an unpinned install resolves fastmcp 4.x; that major answers in the 2026-07-28 protocol era, where every request gets a new session id, and the wrapper keys its browser backend by that id. It then starts a new browser on every tool call, and the second launch fails on the profile the first browser still holds (`exitCode=0`, the error users saw on 2.9.0). The pins are part of the venv marker, so an existing venv rebuilds itself on the next start with no manual step; `CAMOUFOX_MCP_PACKAGE` still overrides the wrapper pin and the stack pins stay. The pin is revisited when upstream bounds `fastmcp` or keys its backend by a stable id.
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
| `CAMOUFOX_MCP_PACKAGE` | Override `camoufox-playwright-mcp==0.1.5`; the venv marker detects the change and rebuilds the venv. The pinned `fastmcp==3.4.7` and `mcp==1.29.0` stay |
| `CAMOUFOX_BROWSER_BUILD` | Override the pinned browser build |

Only the official uv release (SHA-256 verified against the checksums in `lib/provision.mjs`), the Python builds uv resolves, the package index, and the Camoufox release index are contacted. `uv python install` runs with `--no-bin --no-registry`, and `UV_PYTHON_INSTALL_DIR`, `UV_CACHE_DIR` and the venvs all live under the plugin data directory.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Headless | `false` | Headed is measurably less detectable. Turn on only for a display-less server |
| Tool profile | `default` | `default` follows the engine manifest (`portable` for Camoufox). `portable` exposes the shared 24-tool browser core; `full` exposes everything this engine supports. The seven tool groups and `disabled_tools` still apply. Restart Claude Code after changing it |
| Tool groups | all on | Seven checkboxes: vision, pdf, devtools, storage, network, testing, config. `tools_pdf` is kept for cross-engine configuration; this engine never exposes `browser_pdf_save` |
| Disabled tools | empty | Comma-separated exposed names hidden from `tools/list` and rejected on call |
| Profile isolation | `shared` | `shared` keeps one profile per account for every Claude Code window, exactly as before. `workspace` derives one profile per project folder (`profiles/camoufox/ws-<hash>`) with a fresh login state, and moves to a numbered sibling if that profile is already in use. Ignored when Account profile or Profile directory is set. See [Profile and sessions](#profile-and-sessions) |
| Account profile | empty → this plugin's default profile | One profile per account: `profiles/camoufox/<name>`, and `default` reaches the existing `profiles/camoufox/default`. Wins over Profile isolation; ignored when Profile directory is set. Restart after changing it. See [Accounts](#accounts) |
| Profile directory | empty → `<plugin data>/profiles/camoufox/default` | Explicit profile path; wins over Account profile and Profile isolation. Persistent cookies, logins and fingerprint seed. One directory per account |
| Proxy server / bypass | empty | Sticky proxy and hosts that skip it |
| Artifacts directory | empty | Where screenshots, traces and session files are written. Empty means `.playwright-mcp` inside the client's first usable `file://` root (the project folder Claude Code opened), or `<plugin data>/output/<engine>` when the client advertises no usable file root; `browser_capabilities.outputDir` reports the effective directory |
| Unrestricted file access | `false` | Removes Playwright's file-access allowlist for tool-chosen paths and unblocks `file://` navigation, so the model can read and write any file your operating-system user can. A deliberate security trade-off: a prompt-injected page could make the model read or overwrite private files. Leave it off unless you need a path outside the Artifacts directory and the client workspace root |

The launcher drops empty optional values before starting the server, so leaving a directory or proxy blank behaves as "not configured" rather than as an empty path.

`browser_capabilities` also explains a file-access refusal: `serverCwd` is the directory the MCP server runs in, `outputDir` is the effective artifact directory, and `clientRoots` is the MCP roots the client advertised (one read-only `roots/list` request with a 2 s bound, cached for the session; `clientRootsError` carries the reason when they could not be read). When `output_dir` is empty the broker chooses the artifact directory before the engine starts — `.playwright-mcp` inside the client's first usable `file://` root, or `<plugin data>/output/<engine>` when no usable file root is available — and passes it to the wrapper as `PLAYWRIGHT_MCP_OUTPUT_DIR`, so the roots request is made during the `initialize` handshake in that case and lazily on the first `browser_capabilities` call when the setting already fixed the directory. Unlike the Cloak bridge, this engine's Python server receives the client's roots, so its workspace root is the client's first root. `initialize.instructions` adds one sentence naming the artifact directory, which default was applied, and the `output_dir` setting.

**Unrestricted file access** (`allow_unrestricted_file_access`, default off) removes that allowlist for tool-chosen paths and unblocks `file://` navigation. When it is on, the model may read and write **any file your operating-system user can**, not only the two roots — including files outside the project. That is a deliberate security trade-off, not a convenience: a prompt-injected page could ask the model to read credentials or overwrite a private file, and the plugin cannot distinguish that from your own request. Leave it off unless a workflow needs a path outside the roots; when you can, set the Artifacts directory instead. The launcher passes `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=true` to the engine only when the setting is on; when it is off or unset the variable is not passed, so the default configuration is unchanged.

## Accounts

One browser profile per account. Set **Account profile** to a name such as `alice`; the broker resolves it to a directory under Claude Code's plugin data directory and starts Camoufox with it. With Account profile, Profile directory, the default-profile pointer and Profile isolation at their defaults, nothing changes: the plugin uses `profiles/camoufox/default` exactly as before.

| Account / setting | Effective profile directory |
|---|---|
| empty, isolation `shared` | `<plugin data>/profiles/camoufox/default` |
| empty, isolation `workspace` | `<plugin data>/profiles/camoufox/ws-<sha256(cwd)[:7]>` |
| `default` | `<plugin data>/profiles/camoufox/default` — the profile you already have |
| `alice` | `<plugin data>/profiles/camoufox/alice` |
| default pointer set, nothing else | the pointer's name in `<plugin data>/profiles/camoufox/.default`; `default` means `profiles/camoufox/default`, any other name maps as an account |
| `profile_dir` set | that path, unchanged; Account profile, the default pointer and Profile isolation are ignored |

Precedence is **Profile directory → Account profile → Default profile pointer → Profile isolation → engine default**.

- **Names:** 1–64 characters, starting with a letter or digit, then letters, digits, `.`, `_` or `-`. No trailing dot, no slash, no Windows device name (`CON`, `NUL`, `COM1`, …). An invalid name is a start-up error: no browser starts and `browser_engine_status.lastError` carries the exact reason. The name is validated before any path is built.
- **One account at a time.** The plugin configuration holds one value per key, so one plugin instance runs one account. Changing Account profile, Profile directory or the proxy takes effect when the MCP server restarts — restart Claude Code. There is no runtime account switch.
- **Visibility.** `browser_capabilities` reports `account`, `profileDir`, `profileSource` (`profile_dir`, `account`, `pointer`, `workspace`, `engine`, `default`), `defaultProfileDir`, `profileDefault`, `profileDefaultSource`, `profileDefaultPath` and, when the pointer is broken, `profileDefaultError`, plus `availableAccounts` (at most 100 names), `availableAccountCount`, `accountApplies`, `profileApplies`, `profileIsolation`, `profileIsolationSource`, `profileFallback` and `profileLock`. `browser_engine_status` adds `account`, `profileDir`, `profileIsolation`, `profileApplies`, `profileFallback` and `profileLock`. The `browser_profiles` meta-tool reports the same profile facts on demand and writes the default-profile pointer. The broker creates the account, pointer and workspace directories; it never copies, renames, moves or deletes a profile.
- **One profile per account, always.** Two identities in one profile overwrite each other's cookies. Windows is case-insensitive, so `Alice` and `alice` are the same directory.
- **Concurrency.** Camoufox locks a profile while a session uses it. With `shared`, a second session on the same directory is refused by the engine; the plugin's preflight now reports the owner and the fix before starting it. With `workspace`, different project folders get different profiles and run their own browsers (each has its own process). Two windows in the same project folder fall back to a numbered sibling profile, which is a **fresh login state**. The CloakBrowser free-tier one-session limit does **not** apply to this engine; there is no CloakBrowser binary here.
- See [Sign-in](#sign-in) for the manual, headed login each account needs.

### Per-account proxy file

A proxy can be sticky per account with a file beside the profile instead of the global **Proxy server** setting:

```
<plugin data>/profiles/camoufox/alice.proxy          beside profiles/camoufox/alice/
<plugin data>/profiles/camoufox/default.proxy        beside profiles/camoufox/default/
<plugin data>/profiles/camoufox/ws-0b0e194.proxy     beside a workspace profile
```

- **Proxy server set:** it wins, and one line in the MCP log says the file is ignored. **Proxy server empty:** the file is read for the active account, or beside the default profile when no account is set (only if the file exists). No file means a direct connection.
- The file is one line, no comments: `http://user:pass@host:port`, `https://…`, `socks4://…` or `socks5://…`. A missing scheme means `http://`. Percent-encode `@`, `:`, `/` inside credentials. The value is passed to the engine unchanged.
- A file that cannot be read, is not valid UTF-8, has more than one non-empty line, or does not parse as a proxy URL is a **start-up error**: the browser does not start and the error names the file, never its contents. A bad file never falls back to a silent direct connection.
- **The file is a credential in plaintext.** On POSIX run `chmod 600 <file>`; on Windows it inherits the user-profile ACL (the plugin does not change permissions). Keep it out of the repository, shared backups, PRs and screenshots; back it up like a password. The plugin only reads it, never writes it.
- The URL is never logged and never returned: `browser_capabilities` reports `proxySource` (`setting`, `account-file`, `none` or `error`) and `proxyConfigured` (boolean). Credential-bearing URLs in relayed backend log lines are masked as `scheme://***@host`.

### Backup, rename and delete (manual)

- **Backup:** close Claude Code (at least the browser), then copy the account directory and its `.proxy` file. A live profile contains lock files and can be copied inconsistently. The fingerprint seed sits inside the directory; keeping it keeps the fingerprint. For a checked copy that skips locks and caches, use the copy tool below.
- **Rename:** close the browser, rename the directory and the `.proxy` file, change Account profile (or Profile directory), and restart. Nothing is migrated for you.
- **Delete:** close the browser, delete the directory and the `.proxy` file. Irreversible. There is no delete in the plugin.
- To switch accounts: `/plugin` → Configure → set Account profile → restart Claude Code.

### Copy a profile (safe copies)

A copy branches an existing profile under a new account name with the same cookies, logins, local storage and fingerprint seed. Use it to experiment from a signed-in state, to keep a checked backup, or to start a second account from the same point. **A copy is not a new identity**: it presents the same fingerprint and the same sessions, so the one-account-per-profile rule still applies. It is not a way to move a session to a different account or to skip that account's sign-in.

1. **Close the browser first.** The profile lock exists while a browser uses the directory and a live profile is not safe to copy. The tool refuses a source whose lock names a live process; a stale lock (owner gone) is ignored and is not copied. An unreadable lock also refuses the copy.
2. Run the copy tool, from a checkout of this repository at the repository root:

   ```powershell
   node plugins/camoufox/scripts/profile-copy.mjs --engine camoufox --from default --to work2 `
     --data-dir "$env:USERPROFILE\.claude\plugins\data\camoufox-cloakbrowser-mcp"
   ```

   An installed plugin carries the same script at `<plugin root>/scripts/profile-copy.mjs`, for example
   `%USERPROFILE%\.claude\plugins\cache\cloakbrowser-mcp\camoufox\<version>\scripts\profile-copy.mjs`.
   This plugin ships only the `camoufox` engine, so `--engine camoufox` is required: the tool's default engine is `cloak`, which this plugin does not contain and therefore rejects. The tool uses the same account rule and `profiles/camoufox/<name>` layout as the broker:
   - `--data-dir <path>` names the plugin data root. In a Claude Code process it is `CLAUDE_PLUGIN_DATA`; a terminal normally does not have that variable, so pass the directory shown by `browser_capabilities.profileDir` two levels up — for this plugin `%USERPROFILE%\.claude\plugins\data\camoufox-cloakbrowser-mcp`. The fallback when nothing is set is `~/.cloakbrowser-mcp-plugin`, which is why the command above passes it explicitly.
   - `--dry-run` lists the top-level entries and totals without creating anything; `--json` prints one machine-readable summary.
   - `--from default --to work2` copies `profiles/camoufox/default` to `profiles/camoufox/work2`.
3. **Set Account profile to the copy** (`work2` above) and restart Claude Code. The copy starts signed in wherever the source was signed in.
4. **Copied:** cookies, logins, local storage, `Local State`, `Preferences`, and the fingerprint seed `.cloakbrowser-seed`. **Not copied:** the profile lock, Chromium singleton files (`SingletonLock`, `SingletonSocket`, `SingletonCookie`), caches (`Cache`, `Code Cache`, `GPUCache`, `GrShaderCache`, `GraphiteDawnCache`, `DawnCache`, `ShaderCache`, `Crashpad`), `*.tmp` entries and log directories. The engine rebuilds the caches on first use.
5. **The optional `.proxy` file is not copied.** `profiles/camoufox/work2.proxy` does not appear: the file is a plaintext credential, so the tool never duplicates it silently. Copy it yourself (and `chmod 600` it on POSIX) only if the copy should use the same proxy.
6. **Same identity, or a fresh one.** Because the seed is copied, the copy keeps the source fingerprint, which is what makes it useful. To give the copy a fresh fingerprint, close the browser and delete `<copy>/.cloakbrowser-seed` before the first start; the engine then writes a new seed. The copy tool never deletes or edits the seed for you.
7. **No CloakBrowser seat is involved.** Camoufox is not Cloak-licensed; two Camoufox sessions can run on different profiles, each with its own process. The free CloakBrowser tier still allows one browser at a time, and a copy never adds a CloakBrowser seat.
8. **Refusals are complete:** an invalid name, a missing source, an existing destination (never overwritten, never merged), a live or unreadable lock. A failed copy removes only the destination directory it created, never the source and never a directory another process made.

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

The seven group switches shape the backend list before the profile and `disabled_tools`, exactly as they do for the universal plugin. The three broker meta-tools are always present.

## Profile and sessions

With the profile settings empty, the plugin uses `<plugin data>/profiles/camoufox/default` inside its own `${CLAUDE_PLUGIN_DATA}` (for example `.../data/camoufox-cloakbrowser-mcp/profiles/camoufox/default`). That directory is separate from the universal plugin's profile; cookies and logins are not shared. The browser engine locks a profile while a session uses it, so do not point two running sessions at the same directory. One directory per account; see [Accounts](#accounts) for the name setting.

### Default profile (applies at the next start)

The default-profile pointer is one line in `<plugin data>/profiles/camoufox/.default` naming the profile a start uses when neither Profile directory nor Account profile is set. Set it with the `browser_profiles` meta-tool (`action: "set-default"`, `name`) or with `scripts/profile-default.mjs` from a terminal (`--show`, `--set <name>`, `--dry-run`, `--json`, `--data-dir`; an installed copy lives at `<plugin root>/scripts/profile-default.mjs`, and the data root for this plugin is `%USERPROFILE%\.claude\plugins\data\camoufox-cloakbrowser-mcp`). This plugin ships only the `camoufox` engine, so the script needs `--engine camoufox`: its default engine is `cloak`, which this plugin does not contain and therefore rejects. Both paths validate the name with the account rule and write atomically. The change applies at the **next server start**; this session keeps its profile and no browser is started, stopped or reconfigured. A broken pointer is reported in `browser_capabilities.profileDefaultError`, logged once, and ignored for that start (the workspace profile or the engine default applies) — never fatal. A pointer-named profile is created on its first launch like an account, and `profiles/camoufox/<name>.proxy` is used beside it. Delete `<plugin data>/profiles/camoufox/.default` to remove it; the universal plugin's README documents the same mechanism in full.

### Profile isolation

**Profile isolation** (`profile_isolation`) has two values. `shared` (the default) is the previous behaviour byte for byte: every Claude Code window uses the same profile for the account, and a second window is stopped by the preflight below. `workspace` derives one profile per project folder, `<plugin data>/profiles/camoufox/ws-<sha256(cwd)[:7]>` (for example `ws-0b0e194`), Playwright-style. Different project folders never collide. A workspace profile starts with a **fresh login state**: cookies, logins and fingerprint seed from `profiles/camoufox/default` are not carried over. An explicit Account profile or Profile directory keeps its exact previous meaning and wins over isolation.

### Lock preflight and fallback

Before starting the backend, the broker reads the bridge's profile lock (`<profile>/.cloakbrowser-mcp-profile.lock`) and:

- With a **live owner**, it does not start a doomed backend. The meta-tools answer, and the same plain-language sentence (directory, owner PID and start time, and the fix) appears in `initialize.instructions`, `browser_capabilities.engineError`/`profileLock` and `browser_engine_status.lastError`/`profileLock`. `profileLock.state` is `free`, `live`, `stale` (owner gone; the bridge reclaims it) or `invalid` (unreadable lock file; the fix names it). The plugin never deletes a lock or a profile.
- With `profile_isolation=workspace` and the derived workspace profile busy, it uses the first free numbered sibling (`ws-<hash>-2` … `ws-<hash>-5`) and reports `profileFallback: { from, to, reason }` in both meta-tools and in `initialize.instructions`. The fallback is a different identity; it is always announced. When all five are in use, no backend starts and the error says so.
- With `shared`, there is **no fallback**: a busy profile is never silently swapped for another identity.

The preflight narrows the race but the engine remains the authority; its last stderr line is now reported for every engine, including this one, and credential-bearing proxy URLs are redacted.

## Detection record (2026-10-24)

One real headed run through **this plugin's** broker (`full` profile, fresh profile directory, `deviceandbrowserinfo.com/are_you_a_bot`):

- `initialize` and `tools/list` answered; **69 tools**; `engineChoices: ["camoufox"]`; backend `Playwright 0.1.5`; broker version `2.6.0`.
- A `browser_route` for `**fingerprint-scan.com/**` with **status 204** was registered; `browser_route_list` reported `**fingerprint-scan.com/** (status=204)`. A direct navigation to the blocked host was aborted by the 204 fulfillment (`Page.goto: NS_BINDING_ABORTED`), which is the block working, not a detector failure. The detector page itself did not redirect and the URL stayed on `deviceandbrowserinfo.com`.
- Verdict: **`isBot: false`**, and every one of the 22 reported flags `false`, including `isAutomatedWithCDP`, `isAutomatedWithCDPInWebWorker`, `hasInconsistentTimingResolution`, `isPlaywright`, `hasWebdriverTrue` and the WebGL/client-hint/worker checks. `navigator.webdriver` was `false`; UA was Firefox 156 on `Win32`; WebGL reported an Intel ANGLE renderer.
- Console capture worked: 13 messages (2 errors, 8 warnings).
- `browser_close` succeeded.

This is one recorded run on this Windows host, not a general stealth validation. Re-test after every browser or wrapper bump. The wrapper has no CDP channel and the seven group switches do not change that.

## Updates and versions

This plugin is version **2.10.1**, the same version as `cloakbrowser` while both share a generated core. This release changes where auto-named artifacts go when the **Artifacts directory** (`output_dir`) is empty: `.playwright-mcp` inside the client's first usable `file://` root (the project folder Claude Code opened), or `<plugin data>/output/<engine>` when the client advertises no usable file root. An explicit directory still wins, `browser_capabilities.outputDir` reports exactly the effective directory, and the broker passes it to the Camoufox wrapper as `PLAYWRIGHT_MCP_OUTPUT_DIR`. The previous release added the **default-profile pointer** (`<plugin data>/profiles/camoufox/.default`, precedence `profile_dir` → `account` → pointer → workspace → engine default) and the **`browser_profiles` meta-tool** (`list` / `set-default`), plus the same `scripts/profile-default.mjs` terminal tool. `set-default` validates the name, writes atomically, starts no browser, and applies at the next server start. A missing pointer changes nothing; a broken one is reported in `browser_capabilities` (`profileDefault`, `profileDefaultSource`, `profileDefaultPath`, `profileDefaultError`), logged once, and ignored for that start — never fatal. The surface gains one meta-tool: 26 → **27** tools at `portable` and 69 → **70** at `full`. The previous release adds the opt-in **Unrestricted file access** setting (`allow_unrestricted_file_access`, default `false`): when it is on, the model may read and write any file your operating-system user can, beyond the Artifacts directory and the client workspace root, and `file://` navigation is unblocked. It is a deliberate security trade-off, stated in the setting, the settings table and the file-access section. The launcher passes `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=true` to the engine only when the setting is on; when it is off or unset the variable is not passed, so the default child environment is byte-identical to 2.9.5. No tool, engine, profile or artifact-directory default changes. The previous release added artifact diagnostics to `browser_capabilities`: the server working directory, the effective artifact directory, and the MCP roots the client advertised (one lazy, read-only `roots/list` request on the first call, 2 s bound, cached for the session, with `clientRootsError` when the roots cannot be read), plus one sentence in `initialize.instructions` naming the artifact directory and the `output_dir` setting. It changes no tool, engine or profile behaviour, and every existing capability key and value is unchanged. The previous release added the Camoufox profile preflight: before starting a backend the broker reads Firefox's `parent.lock` in the resolved profile and refuses one a live browser still holds, with the loud meta-only start (profile directory, lock file, owner, exact fix) instead of a 180 s hang or an `exitCode=0` launch failure. The file is never written, moved or deleted; the zero-byte lock an exited browser leaves behind is reported as stale and does not block. The previous release made the broker's backend status honest: when an engine rejects the `initialize` handshake but then answers `tools/list` or a tool call, `browser_engine_status` reports `backendState: running` with the additive `initializeRejected: true`, keeps the rejection in `lastError` (with one actionable sentence for the 2026-07-28 protocol era) and stops growing `waitMs` once the backend has answered anything. The previous release pinned the Python MCP stack in the Camoufox venv (`fastmcp==3.4.7`, `mcp==1.29.0`, the versions in the wrapper's `uv.lock`), which stops fastmcp 4.x from answering in the 2026-07-28 protocol era where the wrapper starts a new browser on every tool call. The existing venv rebuilds itself on the next start. Before that, a Windows-only warm-up in the Camoufox entry point stopped the first Camoufox browser tool call from stalling while the engine's modules load. Before that, the shared profile copy tool (`scripts/profile-copy.mjs`) copied cookies, logins and the fingerprint seed to a new profile name while excluding the lock, Chromium singletons, caches and logs. Before that, session-safe profiles (`profile_isolation`, the lock preflight and the workspace fallback) arrived without changing the default profile path. Update them separately:

```bash
claude plugin marketplace update
claude plugin update camoufox@cloakbrowser-mcp
# then /reload-plugins
```

A core fix bumps both plugins; a merge alone does not update a running copy. The plugin settings of `cloakbrowser` and `camoufox` are separate: uninstalling one and installing the other does not carry the profile, proxy or tool settings over.

The shared core and the Camoufox manifest are generated. Edit `shared/core/` or the canonical `plugins/cloakbrowser/engines/camoufox.json`, then run `node scripts/sync-plugin-core.mjs --write` from the repository root. `node scripts/sync-plugin-core.mjs --check` fails on any byte difference and runs in `npm run check:static`. The generated core also contains the launchers for the other engines; no manifest in this plugin names them, so they are inert files, not exposed behaviour.

## Licence

This plugin is MIT. It does **not** bundle `camoufox-playwright-mcp`: the package is fetched from the public PyPI index into the plugin data directory at first start, and the plugin does not redistribute it. Camoufox is a separate open-source project. This is a licence note, not legal advice.
