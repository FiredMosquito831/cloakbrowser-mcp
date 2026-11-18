# secret-agent-browser-mcps (Phase 0 reporter)

`secret-agent-browser-mcps` 1.0.0 is the read-only Phase 0 command line reporter for this collection.
It has its own version line and its own dependency tree; the root `package.json` (the upstream bridge) is
untouched, and no `workspaces` field is added.

Both `secret-agent-browser-mcps` and `sabm` run the same entry file. From a checkout:

```sh
node installer/src/cli.mjs list --json
node installer/src/cli.mjs doctor --static --json
node installer/src/cli.mjs configure --show --harness codex --json
node installer/src/cli.mjs install codex --dry-run --json
node installer/src/cli.mjs --print-config codex
```

## Zero-write guarantee

Phase 0 only reads. `list`, `doctor --static`, `configure --show`, `install --dry-run` and `--print-config`
never create, edit, move, rename or delete a file, never start a browser, never provision a runtime and never
run an external CLI. Every result envelope carries `writes: []`. Snippets are generated as text for copying;
no parser serializer is called and no user file is re-serialised. Tests hash redirected fixture trees before
and after each invocation to prove this.

`doctor --static` checks writability by mode only (`exists: yes/no; mode check only — not probed`); it does
not touch a file. The shim, engine tree and settings-document checks are reported as explicit `skip` entries
because those artefacts belong to later phases.

## Commands

- `list [--harness <name>] [--scope user|project] [--data-size] [--json]` resolves every known harness/scope
  pair, reads its config if present, and reports its path, path source, format, key path, entry status and
  parse status. Resolved paths are printed verbatim so a wrong derivation is visible. Claude Code is reported
  as plugin-managed and the exact inspection command is printed; the CLI does not run it.
- `doctor --static [--json]` prints one `OK|WARN|ERROR|SKIP <check> — <message>` line per check. Exit 3 when a
  check is an error. `--start` and `--browser` are not implemented in Phase 0.
- `configure --show [--harness <name>] [--entry <name>] [--json]` reports the `userConfig` defaults read from
  the cloakbrowser plugin manifest and the option -> environment mapping from its `.mcp.json`. Host
  environment values for the mapped variables are reported with source `host environment`. Settings
  documents do not exist yet (items 51/52); the report says so. `licence_key` and `proxy_server` are only
  ever printed as `configured: true` or `(unset)`.
- `install --dry-run <harness> [-s|--scope] [--name] [--engine] [--project] [--data-root] [--from] [--json]`
  prints the plan: target path, action, key path, exact snippet, backup naming and next steps. A same-named
  foreign entry is refused; an already-current entry is `changed:false` with no planned writes. For
  `claude-code` it prints the exact `claude plugin` commands and no file plan. Engine materialisation and
  shim creation are Phase 1; this run writes nothing.
- `--print-config <harness> [--scope] [--name] [--data-root] [--json]` prints only the snippet for that
  harness with a comment header naming the file and format, plus `read-only; nothing written`.

## Paths and formats

| Harness | User config | Project config | Format | Entry key |
|---|---|---|---|---|
| Claude Code | `claude plugin` owns it | plugin-owned | none | printed commands only |
| Codex | `~/.codex/config.toml` (`CODEX_HOME` overrides) | `<project>/.codex/config.toml` | TOML | `mcp_servers.<name>` |
| Antigravity | `~/.gemini/config/mcp_config.json` | `<workspace>/.agents/mcp_config.json` | JSON | `mcpServers.<name>` |
| OpenCode | `~/.config/opencode/opencode.jsonc` (`XDG_CONFIG_HOME` overrides) | `<project>/opencode.json(c)` or `<project>/.opencode/opencode.json(c)` | JSONC | `mcp.servers.<name>` |
| OpenClaw | `~/.openclaw/openclaw.json` (`OPENCLAW_CONFIG_PATH`, `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR` override) | none | JSON5 | `mcp.servers.<name>` |
| Hermes | `~/.hermes/config.yaml` (`HERMES_HOME` overrides) | none | YAML | `mcp_servers.<name>` |

All paths are resolved with `os.homedir()`; no `%USERPROFILE%` or `$HOME` string is read directly. Windows
paths for Codex, Antigravity and OpenClaw are derived from `~` and labelled `derived`. On Windows, OpenCode
and Hermes targets are refused with a precise message before any path is opened, because their global paths
are UNVERIFIED upstream; `list` shows them as `refused-windows` and `doctor` reports that status as a skip.

`--data-root` takes precedence over every environment value, including `STEALTH_DATA_DIR`. The default is
`~/.secret-agent-browser-mcps`. Phase 0 never creates the data root.

## Disjoint install paths

Plugin-management installs (Claude Code) keep their current behaviour: settings come only from
`/plugin` -> Configure. npm/npx installs use the CLI's own configuration documents in later phases. The two
paths never influence each other. `configure --show --harness claude-code` prints that notice and writes
nothing. `install claude-code --dry-run` prints commands for the user to run; nothing under `~/.claude` is
read or written by this CLI.

## Envelope and exit codes

Success with `--json` is one line: `{"schema":"sabm/1","ok":true,"command":"...","writes":[]}` plus command
specific fields. Every non-zero exit is exactly one line with `ok:false`, `error.code`, `error.message`,
`error.remedy` and `writes:[]`; codes are `usage` (1), `refused` (2) and `verification_failed` (3). Secrets
are never echoed.

## Schema source

Phase 0 is designed to run from a checkout: the schema defaults come from
`plugins/cloakbrowser/.claude-plugin/plugin.json` and the option->env map from `plugins/cloakbrowser/.mcp.json`.
`--from <dir>` points at another cloakbrowser plugin tree. A future published tarball needs a generated
schema snapshot (Phase 1); Phase 0 publishes nothing.
