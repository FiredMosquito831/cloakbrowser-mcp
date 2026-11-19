# secret-agent-browser-mcps

`secret-agent-browser-mcps` 1.1.0 installs, configures and removes stable shim entries for Codex,
Antigravity and OpenCode. It has its own version line and its own dependency tree; the root
`package.json` (the upstream bridge) is untouched, and no `workspaces` field is added. Claude Code
remains print-only (D0): all plugin settings stay under `/plugin` and nothing under `~/.claude` is
read or written by this CLI.

Both `secret-agent-browser-mcps` and `sabm` run the same entry file. From a checkout:

```sh
npm --prefix installer run build
node installer/src/cli.mjs install codex --json
node installer/src/cli.mjs configure codex --set headless=true --level harness --json
node installer/src/cli.mjs doctor --static --json
node installer/src/cli.mjs list --json
node installer/src/cli.mjs doctor codex --start --json
```

## Phase 1 surface

| Command | Writes | Notes |
|---|---|---|
| `install|add <harness>` | engine tree, shim, `current.json`, `manifest.json`, one broker document and the harness entry | `--dry-run` writes nothing; Claude Code prints `claude plugin` commands |
| `uninstall|remove <harness>` | removes only our entry span | `--force` removes only CLI-owned entries, `manifest.json` and tracked engine trees; never user config text |
| `update [harness]` | new `engine/<version>/`, one `current.json` rename | harness configs never change; `--keep 2` prunes old generations only |
| `configure <harness>` | one broker document per command | `--set key=value`, `--unset key`, `--level global|harness|entry|project`, `--show`, `--values-stdin`, `--print-env` |
| `enable|disable <harness>` | our entry span only | Codex `enabled = false`; Antigravity/OpenCode `"disabled": true` |
| `list` | none | reports install state, engine verification and document states |
| `doctor` | none | `--static` default; `--start` performs an MCP handshake with no browser |

Exit codes are `usage` 1, `refused` 2 and `verification_failed` 3. Every non-zero exit prints exactly
one `sabm/1` line with `writes: []`. Success lists real writes as `{path, action, backup}`; no-ops and
`--dry-run` use `writes: []`. Secrets are never echoed.

## Broker-owned settings

Only two documents exist: `<dataRoot>/settings.json` (global) and
`<dataRoot>/settings.d/<harness>.json` (harness). `--level global` writes the global document's
`settings` object; all other levels write the harness document. Entry and project values are additive
top-level scopes (`scopes.entries.<entry>` / `scopes.projects.<abs path>`); the broker reads only
`settings`. One command edits exactly one document atomically. Only the 16 document-settable keys
and single-line string values are allowed; session-only keys and `settings_level` are refused.

`precedence.settings`, `precedenceNote`, `documents` and `settingsLevel` are emitted only for a gated
read and copied verbatim from the byte-identical vendored `settings-precedence.mjs`. Broker `level`
and `source` stay in their own vocabulary (`env|session|harness|global|default` and
`env|setting|document|default`); CLI scope winners are reported separately as `cliLogicalWinner`.
All 16 document-settable keys always carry `skipped`, including `[]`; credentials are exactly
`{level, configured, source}`.

Each managed entry carries `STEALTH_DATA_DIR=<dataRoot>` and `STEALTH_HARNESS=<harness>` in its env.
`CLAUDE_PLUGIN_DATA` is never written. The shim reads `current.json` on every start, applies the
document ladder plus entry/project scopes, resolves settings through the vendored module, composes
the child environment from the bundled `.mcp.json` map and spawns the bundled broker.

## Source-preserving writers

TOML, strict JSON and JSONC writers splice only their own span into the original text, re-parse the
whole file, copy the previous bytes to `<dataRoot>/backups/<name>.sabm-backup-<stamp>` (last 3 kept),
then `fsync` a temp file and `rename` once. Comments, key order, indentation and EOL outside our span
survive; `add` → `remove` restores the original bytes exactly. Ownership is decided only by the shim
path in `command`/`args`. Unparseable files, foreign same-named entries, read-only files, directories,
inline/dotted TOML collisions, duplicate keys and Windows OpenCode paths are refused before any write.

## Paths and formats

| Harness | User config | Project config | Format | Entry key |
|---|---|---|---|---|
| Claude Code | `claude plugin` owns it | plugin-owned | none | printed commands only |
| Codex | `~/.codex/config.toml` (`CODEX_HOME` overrides) | `<project>/.codex/config.toml` | TOML | `mcp_servers.<name>` |
| Antigravity | `~/.gemini/config/mcp_config.json` | `<workspace>/.agents/mcp_config.json` | JSON | `mcpServers.<name>` |
| OpenCode | `~/.config/opencode/opencode.jsonc` (`XDG_CONFIG_HOME` overrides) | `<project>/opencode.json(c)` | JSONC | `mcp.servers.<name>` |

OpenClaw and Hermes stay visible in `list` but have no writer in Phase 1. OpenCode global writes on
Windows are refused until an upstream path is verified. `--data-root` beats every environment value.

## Distribution

`dist/` contains the deterministic engine bundle, `bundle.json` with SHA-256 hashes, the stable shim
and the byte-identical vendored resolver. It is built before packaging and shipped in `files`; there
is no `postinstall`. CI packs the tarball and installs it into a scratch prefix.

## npm publishing

`.github/workflows/npm-release.yml` publishes this package to npm with npm trusted publishing (OIDC),
so no npm token is stored in the repository. It runs when a GitHub release is published, when a push
to `main` changes `installer/package.json` (or any other file under `installer/`), and on manual
dispatch with an optional tag. A `sabm-vX.Y.Z` tag must match `installer/package.json`; a normal
`vX.Y.Z` plugin release publishes the installer version in that same commit. An already published
version is skipped, and commits that do not change the installer version are skipped.

One-time npm setup, on the package's **Settings → Trusted Publisher → GitHub Actions** page:

| Field | Value |
|---|---|
| Organisation or user | `FiredMosquito831` |
| Repository | `secret-agent-browser-mcps` |
| Workflow filename | `npm-release.yml` |
| Environment | leave EMPTY |

The workflow pins npm 11.19.0, publishes with `--access public --provenance`, and verifies the version
afterwards with `npm view`. A refused trusted publish prints the setup reminder and leaves the GitHub
release green; check the workflow log and the registry, not just the badge. Re-run a tag with:

```sh
gh workflow run npm-release.yml --repo FiredMosquito831/secret-agent-browser-mcps -f tag=sabm-v1.1.0
```
