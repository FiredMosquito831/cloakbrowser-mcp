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
  example: `Unknown engine "nope". Supported engines: cloak, playwright.`

## Manifest fields

| Field | Required | Value |
|---|---|---|
| `schemaVersion` | yes | `1` |
| `id` | yes | Must equal the file name without `.json` |
| `label` | yes | Non-empty human-readable name |
| `transport` | yes | `launch` (the only transport this broker implements) |
| `contract` | yes | `playwright-mcp` (the only contract this broker implements) |
| `defaultToolProfile` | yes | `full` or `portable`; must exist in `profiles.json` |
| `toolSupport` | yes | Object mapping tool names (or `*`) to `full`, `partial`, `none` or `unknown` |
| `toolSupportNotes` | no | Object of non-empty strings explaining a `partial` or `none` decision |
| `notes` | yes | String summarising the backend and its limitations |

Example:

```json
{
  "schemaVersion": 1,
  "id": "example",
  "label": "Example browser",
  "transport": "launch",
  "contract": "playwright-mcp",
  "defaultToolProfile": "portable",
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
- Every portable name must be exposed by every manifest, and no manifest may
  mark a portable name `none`; the unit suite enforces both.

## Adding an engine

1. Add `engines/<id>.json` with every field above. Keep the id equal to the
   file name.
2. If the engine uses the existing `launch` transport and `playwright-mcp`
   contract, no broker change is needed. A new transport or contract needs the
   broker to implement it plus one launcher adapter in the plugin root named
   `launch-<id>.mjs`; that is a separate change, not a manifest.
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
