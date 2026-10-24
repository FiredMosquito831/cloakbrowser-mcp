# Generated plugin core

Everything in this directory except this file is copied byte-for-byte into every
plugin whose `plugins/<name>/plugin-config.json` sets `"core": true`.

- Edit files here, never in `plugins/<name>/` — the copies are generated.
- After an edit run `node scripts/sync-plugin-core.mjs --write` from the
  repository root, then commit both this directory and the regenerated copies.
- `node scripts/sync-plugin-core.mjs --check` fails on any byte difference, a
  missing copy or an unexpected engine manifest. It runs in `npm run
  check:static` and in the unit suite.
- Engine manifests are per plugin. The universal plugin
  (`plugins/cloakbrowser/engines/`) holds the canonical manifest for every
  engine; the sync script copies only the ids named in a plugin's
  `plugin-config.json`. `engines/profiles.json` is shared core and is copied to
  every core plugin.
- No generated header is added to a copied file: byte equality is the contract.

`CORE_FILES` in `scripts/sync-plugin-core.mjs` is the authoritative list.
