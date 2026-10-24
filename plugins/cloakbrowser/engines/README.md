# Engine manifests

The broker is manifest-driven. `broker.mjs` discovers every `engines/*.json`
file at startup, validates it, and exposes the selected engine's tools. Adding
an engine means adding a manifest, not editing broker code.

## Discovery rules

- Each `engines/*.json` file is one engine. The file name is the engine id:
  `engines/cloak.json` defines `cloak`.
- `engines/profiles.json` is reserved: it is the shared tool-profile file, not
  an engine, and is never offered as an engine id.
- Discovery order is deterministic: files sorted by file name. The broker
  reports the same order in `browser_capabilities.engineChoices` and the
  generated `browser_engine` setting.
- Every manifest is validated on every start. An invalid manifest is logged to
  stderr and excluded from the supported engine list. Selecting an invalid
  manifest stops the backend and exposes only the two broker meta-tools, with
  the exact validation error in `browser_capabilities.engineError`.
- An unknown `browser_engine` value is rejected with the discovered ids, for
  example: `Unknown engine "nope". Supported engines: camoufox-native, camoufox, cloak, playwright.`

## Manifest fields

| Field | Required | Value |
|---|---|---|
| `schemaVersion` | yes | `1` |
| `id` | yes | Must equal the file name without `.json` |
| `label` | yes | Non-empty human-readable name |
| `transport` | yes | `launch` (the only value this broker implements). An engine that attaches to an existing browser still uses `launch`: the broker spawns a launcher adapter, and the adapter makes the attach. The attach fact is reported through `capabilities.cdpAttach` |
| `contract` | yes | `playwright-mcp` (canonical tool names and schemas) or `native-mcp` (the backend speaks its own names; see below) |
| `defaultToolProfile` | yes | `full` or `portable`; must exist in `profiles.json` |
| `toolSupport` | yes | Object mapping tool names (or `*`) to `full`, `partial`, `none` or `unknown`. For `native-mcp`, keys are the native-only tool names and the canonical names the backend cannot provide |
| `toolSupportNotes` | no | Object of non-empty strings explaining a `partial` or `none` decision. For `native-mcp`, every `none` entry must have one |
| `launch` | no | Object with one optional field, `launcher`: a launcher file name in the plugin root. Missing means `launch.mjs` |
| `requirements` | no | Array of non-empty strings naming what the engine needs before it can run (reported by `browser_capabilities`) |
| `requiredEnv` | no | Array of `{ "env": "...", "reason": "..." }`. The broker checks each variable before spawning. An empty value or an unresolved `${user_config.*}` placeholder is a configuration error: `initialize` carries `reason`, `tools/list` is meta-only, and no backend starts. `reason` is the complete actionable sentence |
| `runtime` | no | Object describing an attached/remote runtime: `endpointEnv`, `profileEnv`, `defaultEndpoint` (must contain `{profileId}`), `errorHint` (may contain `{endpoint}`), `statusKeys` (`endpoint`/`profileId` → field names). The broker uses it for the extra `browser_engine_status` fields and to append `errorHint` to an `isError` tool result until the first successful tool call. Omit it for a normal launch engine; nothing is added |
| `capabilities` | no | Object with only `groupSwitchesApply` and `cdpAttach` (booleans). The broker copies these into `browser_capabilities` for the engine that declares them |
| `systemDependencies` | no | Array of external software the engine needs but the plugin never installs (see below). Reported generically in `browser_capabilities`; omitted engines gain no key |
| `profileApplies` | no | Boolean, default `true`. Whether the plugin's profile model applies to this engine: `profile_dir`, `account`, `profile_isolation`, the workspace derivation and the lock preflight. Declare `false` for an engine that owns its profile elsewhere or attaches to a browser it did not start. Reported by both meta-tools |
| `ignoredSettings` | no | Array of non-empty strings naming plugin settings the engine cannot honour (reported by `browser_capabilities`) |
| `notes` | yes | String summarising the backend and its limitations |

`launch.launcher` must be a bare file name matching `launch.mjs` or
`launch-<engine>.mjs`; a path, a command or a shell string is rejected at
validation time. When the value is present the file must exist in the plugin
root. The broker starts it with `node <launcher>`, so every launcher is a Node
script with the same stdio contract: stdout is the MCP protocol only, every log
line goes to stderr, and a missing prerequisite exits 1 after one actionable
line.

Example:

```json
{
  "schemaVersion": 1,
  "id": "example",
  "label": "Example browser",
  "transport": "launch",
  "contract": "playwright-mcp",
  "defaultToolProfile": "portable",
  "launch": { "launcher": "launch-example.mjs" },
  "requirements": ["Node 22.13+", "the engine binary (one-time download)"],
  "ignoredSettings": ["humanize"],
  "toolSupport": {
    "*": "full",
    "browser_pdf_save": "none"
  },
  "toolSupportNotes": {
    "browser_pdf_save": "Not supported by this backend."
  },
  "notes": "What the backend is, what it changes and what it cannot do."
}
```

Support is resolved per tool name first, then `*`, then `unknown`. `unknown`
is not unsupported: the broker exposes the tool under `full` and forwards the
call, and the backend answers for itself.

## Native contract (`native-mcp`)

A backend that speaks its own tool names uses `"contract": "native-mcp"`. The
broker does not forward that list unchanged: it classifies every backend tool
once, then advertises the manifest's surface. These fields are required for a
native manifest; a `playwright-mcp` manifest does not use them and its
validation is unchanged.

| Field | Value |
|---|---|
| `contractSchemas` | Relative path to the canonical schema file. It must stay inside the plugin root and contain a `{ description, inputSchema }` entry for every aliased `browser_*` name |
| `nativePrefix` | Prefix for native-only tools, for example `camoufox_native_`. Lowercase letters, digits and underscores; must not start with `browser_` |
| `profileArgument` | `{ "name": "profile", "env": "CAMOUFOX_PROFILE", "setting": "camoufox_profile", "default": "default", "except": ["list_sessions"] }`. The broker injects `name` into every native call except the tools in `except` |
| `toolAliases` | Array of alias entries (below). Each canonical name appears once; several aliases may name the same native tool |
| `capabilities` | Optional `{ "groupSwitchesApply": false }`. The seven `tools_*` switches are Playwright MCP capability groups and do not shape a native backend |

An alias entry has exactly one of `native` (one native tool) or `dispatch` (an
action → native map). Optional keys:

- `args`: canonical argument name → native argument name. Arguments present in
  `args` are renamed; `ignore` arguments are accepted and dropped; `reject`
  arguments are refused; any other argument is refused.
- `transform`: one of `single-select-value`, `form-fields`,
  `evaluate-function`, `console-level`, `accept-to-action`. The named transforms
  consume the canonical arguments they understand (`values`, `fields`,
  `function`/`target`, `level`/`all`, `accept`).
- `send` / `required` (dispatch only): per action, the canonical arguments to
  forward and the ones that must be present. `browser_tabs` is the worked
  example: `list` sends none, `new` sends `url`, `close`/`select` send the
  required `index`.

The advertised input schema is the canonical schema projected onto the
arguments the alias accepts: rejected properties and their `required` entries
are removed. `tools/list` order is sorted by exposed name for a native engine.
A backend tool the manifest does not classify is exposed with the prefix and
support `unknown` (fail open); an alias that names a tool the backend does not
list is an engine error (fail closed) and the broker exposes only its
meta-tools. `disabled_tools` matches exposed names: `browser_*` aliases and
`<nativePrefix><name>`, never a raw native name.

Example excerpt:

```json
{
  "contract": "native-mcp",
  "contractSchemas": "contracts/playwright-canonical.json",
  "nativePrefix": "camoufox_native_",
  "profileArgument": {
    "name": "profile",
    "env": "CAMOUFOX_PROFILE",
    "setting": "camoufox_profile",
    "default": "default",
    "except": ["list_sessions"]
  },
  "toolAliases": [
    { "canonical": "browser_navigate", "native": "navigate", "support": "full", "args": { "url": "url" } },
    {
      "canonical": "browser_tabs",
      "support": "partial",
      "dispatch": { "list": "list_pages", "new": "new_page", "close": "close_page", "select": "select_page" },
      "send": { "list": [], "new": ["url"], "close": ["index"], "select": ["index"] },
      "required": { "close": ["index"], "select": ["index"] },
      "args": { "index": "page_idx", "url": "url" }
    }
  ]
}
```

## Profile applicability (`profileApplies`)

The broker resolves the browser profile before it spawns a launcher. For an engine
that owns a persistent local profile directory (`cloak`, `playwright`,
`camoufox`) it applies, in this order: an explicit `profile_dir`, the `account`
name, a `profile_isolation=workspace` derivation
(`profiles/<engine>/ws-<sha256(cwd)[:7]>`), then the engine default. It reads the
bridge's `<profile>/.cloakbrowser-mcp-profile.lock` before spawning and refuses a
start when a live process holds it; in workspace mode it may move to the numbered
siblings `-2` … `-5` and reports the switch as `profileFallback`.

An engine whose profile belongs to someone else declares `"profileApplies":
false`. The broker then skips every step above, reports `profileApplies: false`
and `profileLock: null`, and the engine's own profile setting governs. The
shipped examples are `camoufox-native` (mcp-camoufox owns its profile and lease)
and `kameleo` (CDP attach). `ignoredSettings` is a separate, additive fact: an
engine can ignore one plugin setting without opting out of the profile model, and
vice versa. The rule is manifest-driven; no engine id appears in `broker.mjs`.

## Attach runtime (`requiredEnv` + `runtime`)

An engine that attaches to a browser it did not launch (a local antidetect
profile, a CDP endpoint) still uses `transport: "launch"`: the launcher adapter
opens the endpoint and starts the MCP backend in attach mode. Two optional,
generic manifest blocks let the broker handle the configuration and the first
failure without knowing the engine:

```json
{
  "requiredEnv": [
    { "env": "ENGINE_PROFILE_ID", "reason": "One actionable sentence naming the setting and how to fix it." }
  ],
  "runtime": {
    "endpointEnv": "ENGINE_ENDPOINT",
    "profileEnv": "ENGINE_PROFILE_ID",
    "defaultEndpoint": "ws://127.0.0.1:5050/playwright/{profileId}",
    "errorHint": "The engine is not answering at {endpoint}. Start it and check the profile.",
    "statusKeys": { "endpoint": "engineEndpoint", "profileId": "engineProfileId" }
  },
  "capabilities": { "groupSwitchesApply": true, "cdpAttach": true },
  "profileApplies": false
}
```

- `requiredEnv` is checked in the broker before any spawn. A missing value is a
  configuration error: meta-only `tools/list`, `backendState: "failed"`, the
  reason in `engineError` and `lastError`. The launcher should repeat the same
  sentence when invoked directly.
- `runtime.defaultEndpoint` is built by replacing `{profileId}` with the
  percent-encoded value of `profileEnv`. `endpointEnv`, when set and non-empty,
  wins. `errorHint` replaces `{endpoint}` and is appended to an `isError` tool
  result only until the first successful tool call in that process; protocol
  `error` objects are never rewritten. An engine without a `runtime` block gets
  no enrichment and no extra status fields.
- `statusKeys` names the extra `browser_engine_status` fields; `endpoint` and
  `profileId` are the only recognised sources. Omit `statusKeys` to add none.
- The endpoint rules themselves live in the launcher (loopback host, `ws(s)`,
  no userinfo); the broker only reports the effective value.

## System dependencies (`systemDependencies`)

A manifest may declare external software it needs but must never install, for
example a commercial desktop application with its own licence. The block is
display-only: the broker never downloads an installer, never runs one, never
starts a GUI and never uses a package manager.

```json
{
  "systemDependencies": [
    {
      "id": "example-app",
      "label": "Example app",
      "required": true,
      "downloadUrl": "https://example.com/downloads",
      "installerName": "Example.Installer.exe",
      "installHint": "Download it from https://example.com/downloads, run Example.Installer.exe, start the app, create a profile and put its ID in the engine setting.",
      "licenceNote": "Proprietary and separately licensed by its vendor."
    }
  ]
}
```

| Field | Required | Value |
|---|---|---|
| `id` | yes | Unique non-empty id within the manifest |
| `label` | yes | Human-readable name used in the status hint |
| `required` | no | Boolean, default `true`. Only required entries contribute to the missing-dependency hint |
| `downloadUrl` | no | `https://` URL of the vendor's download page |
| `installerName` | no | The file name the user runs, for example `Kameleo.Installer.exe` |
| `installHint` | yes | Complete actionable sentence (download, install, start, configure) |
| `licenceNote` | no | Licence facts, marked vendor-reported where applicable |

`browser_capabilities.systemDependencies` lists each entry with its declared
fields plus a `status`:

- `unknown` — the app may or may not be present. The broker cannot inspect a GUI
  application without running something, so it never claims it is installed.
- `missing` — evidence of absence: a `requiredEnv`/manifest configuration error,
  a backend start or exit failure, or a failed tool call that the manifest's
  `runtime.errorHint` explains.

When a required dependency is `missing`, the same hint is appended to
`browser_engine_status.lastError` and to the synthesized `initialize`
instructions. Engines without a `systemDependencies` block gain no key and no
text; their payloads are unchanged. The status is informational only: the engine
still starts and its own errors still surface, so the user can install the app
and retry without changing the plugin.

## Tool profiles

Profiles are per engine and shared across engines:

- `engines/profiles.json` defines `full` (`kind: "all-supported"`, everything
  except `none`) and `portable` (`kind: "explicit"`, the same 24 browser tools
  for every engine).
- A manifest's `defaultToolProfile` is the profile used when the user leaves
  the **Tool profile** setting at `default`.
- `tool_profile` (`STEALTH_TOOL_PROFILE`) overrides the manifest default with
  `portable` or `full`. `default`, unset, empty, an unsubstituted
  `${user_config.*}` placeholder, or an unknown value all fall back to the
  manifest default; unknown values are logged, never fatal.
- The exposed surface is the active manifest intersected with the selected
  profile, then the seven tool-group switches (inside the launcher), then
  `disabled_tools`.
- Every portable name must be exposed by every `playwright-mcp` manifest, and
  no such manifest may mark a portable name `none`; the unit suite enforces
  that. A `native-mcp` manifest is allowed to report portable gaps, because its
  backend genuinely lacks them: each gap must be `none` with a
  `toolSupportNotes` reason and is listed in `browser_capabilities.unavailableTools`.

## Provisioning contract

Every launcher provisions its own local dependencies into
`${CLAUDE_PLUGIN_DATA}` at the first MCP server start; nothing is installed
system-wide and no shell is started. `lib/provision.mjs` is the shared,
engine-agnostic implementation:

| Helper | What it does |
|---|---|
| `ensureUv` | Uses an explicit `UV`/`UV_BIN` (it must report a `uv --version` at or above the pinned 0.13.5, otherwise the call fails), then a `uv` on `PATH` that reports that version, then the plugin-managed pinned `uv` under `tools/uv/<version>` (downloaded from the official GitHub release, SHA-256 verified, extracted with pure Node). A `PATH` uv that is older, unparsable or does not answer `--version` is ignored with one log line. Fails closed on an unknown platform or a checksum mismatch |
| `ensurePython` | Uses `UV_PYTHON`, then `PYTHON`, then `uv python install` of the pinned CPython under `tools/python` with `--no-bin --no-registry`. No system Python is required |
| `ensureVenv` | Creates or refreshes `venvs/<name>` with `uv venv` + `uv pip install` of the manifest's pinned packages. A `.provision.json` marker records the uv version, Python version, package pins and a hash; a matching marker plus intact package metadata means reuse |
| `ensureNpmRuntime` | The npm runtime shared by the Chromium launchers (`runtime/`); pins, `package.json` bytes, npm arguments, clean-reinstall rule and marker bytes are unchanged from 1.x |

An engine that needs another runtime adds a launcher that calls these helpers;
it does not add engine-specific code to the broker. Overrides (`UV`, `UV_BIN`,
`UV_PYTHON`, `PYTHON`, and the engine's own package/command variables) are
environment variables, not plugin settings.

## Adding an engine

1. Add `engines/<id>.json` with every field above. Keep the id equal to the
   file name.
2. If the engine uses the existing `launch` transport and `playwright-mcp`
   contract, name the launcher adapter (or omit `launch` for `launch.mjs`). A
   new backend that needs its own runtime gets one launcher adapter in the
   plugin root named `launch-<id>.mjs`; that is a separate change, not a broker
   edit. A backend with its own tool names uses `native-mcp` and declares
   `contractSchemas`, `nativePrefix`, `profileArgument` and `toolAliases` as
   above. A backend that attaches to a browser someone else owns declares
   `requiredEnv` for the values without which it can never work and a `runtime`
   block for its endpoint and error hint; if it also needs external software the
   plugin must not install, declare `systemDependencies`. Declare
   `"profileApplies": false` when the engine owns its profile or attaches to one
   it did not start, so the broker does not resolve a profile for it.
   `engines/kameleo.json`
   with `launch-kameleo.mjs` is the worked attach example (and the worked
   `systemDependencies` example). The Camoufox engine in
   `engines/camoufox.json` is the worked example for a contract engine;
   `engines/camoufox-native.json` is the worked example for a native one. All
   launchers are adapters only: no engine id, setting name or tool name appears
   in `broker.mjs`, `lib/surface.mjs` or `lib/attach.mjs`, and every launcher
   provisions through `lib/provision.mjs`.
3. Regenerate the plugin's engine enum from the manifests:

   ```
   cd plugins/cloakbrowser
   node scripts/generate-engine-options.mjs --write
   ```

   From the repository root the same command is
   `npm run engines:options:write`. `--check` reports an out-of-sync enum with
   the manifest list and exits non-zero; the static gate runs it on every
   check.
4. Validate:

   ```
   cd plugins/cloakbrowser
   node scripts/generate-engine-options.mjs --check
   cd ../..
   npx vitest run tests/unit/engine-registry.test.ts
   npm run check:static
   claude plugin validate ./plugins/cloakbrowser
   ```

5. Restart Claude Code. The engine list and tool surface are resolved when the
   MCP server starts; there is no runtime switch.

Do not edit `broker.mjs` to add an engine, and do not put a path or command in
the engine setting: the value selects a manifest id only.
