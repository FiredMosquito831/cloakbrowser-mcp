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
  "capabilities": { "groupSwitchesApply": true, "cdpAttach": true }
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
   block for its endpoint and error hint; `engines/kameleo.json` with
   `launch-kameleo.mjs` is the worked attach example. The Camoufox engine in
   `engines/camoufox.json` is the worked example for a contract engine;
   `engines/camoufox-native.json` is the worked example for a native one. All
   launchers are adapters only: no engine id, setting name or tool name appears
   in `broker.mjs`, `lib/surface.mjs` or `lib/attach.mjs`.
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
