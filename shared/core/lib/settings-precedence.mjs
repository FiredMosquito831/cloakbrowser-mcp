// Harness identity and the additive profile half of `precedence` (2.25.0).
//
// This module is the one source of truth for the harness-id rule: the broker
// resolves STEALTH_HARNESS with it, the default-pointer helpers validate the
// optional harness argument with it, and the profile-default CLI uses it for
// --harness. The file is in CORE_FILES and is vendored byte-identically into
// both plugins, so the installer CLI can use the same rule later.
//
// Setting documents, settings_level and the settings half of `precedence` are
// deliberately NOT here: they belong to the next release. Nothing in this
// module writes, creates, moves or deletes a file.
import { settingState } from './launcher-settings.mjs';

export const HARNESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const INFERRED_HARNESS_ID = 'claude-code';
export const HARNESS_ENV_NAME = 'STEALTH_HARNESS';

const HARNESS_HINT =
  'Use lowercase letters, digits and "-", starting with a letter or digit, up to 32 characters.';

// Echo a bad value as one bounded line, with no control characters and no
// multi-line paste. This is a diagnostic only; it never reaches a child env.
function echo(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, '?')
    .trim()
    .slice(0, 60);
}

// Normalize one harness id. Null means "not a harness id" and is handled by
// the caller as an unset value; no path is ever joined from a raw id.
export function normalizeHarnessId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const id = value.trim().toLowerCase();
  // The pinned pattern permits a trailing "-"; the documented slug shape does
  // not, so the one extra rule is applied here in the shared validator.
  return HARNESS_ID_PATTERN.test(id) && !id.endsWith('-') ? id : null;
}

// Resolve harness identity from the environment. `{ id, source, error }` has
// only two source spellings: "env" for a usable id (explicit or inferred) and
// "unset" when there is no harness level. A bad value is reported once and
// never kills a start. Inference is broker-only: the plugin manager sets
// CLAUDE_PLUGIN_DATA and no STEALTH_DATA_DIR on the Claude Code plugin path,
// so that path gets the same id without adding an env var to either .mcp.json
// or exporting anything to the engine child. A CLI data-root alias suppresses
// inference; an explicitly bad value is never replaced by an inferred one.
export function resolveHarness(env = process.env, log = () => {}) {
  const source = env ?? {};
  const raw = source[HARNESS_ENV_NAME];
  if (raw === undefined) {
    const pluginData = typeof source.CLAUDE_PLUGIN_DATA === 'string' ? source.CLAUDE_PLUGIN_DATA.trim() : '';
    const aliasSet = Object.hasOwn(source, 'STEALTH_DATA_DIR') && source.STEALTH_DATA_DIR !== undefined;
    if (pluginData !== '' && !aliasSet) {
      return { id: INFERRED_HARNESS_ID, source: 'env', error: null };
    }
    return { id: null, source: 'unset', error: null };
  }
  if (typeof raw !== 'string') {
    const error = `STEALTH_HARNESS: ignoring a non-string value; ${HARNESS_HINT}`;
    log(error);
    return { id: null, source: 'unset', error };
  }
  const state = settingState(raw);
  if (state === 'empty') {
    return { id: null, source: 'unset', error: null };
  }
  if (state === 'placeholder') {
    const error = `STEALTH_HARNESS: ignoring an unsubstituted placeholder "${echo(raw)}"; ${HARNESS_HINT}`;
    log(error);
    return { id: null, source: 'unset', error };
  }
  const id = normalizeHarnessId(raw);
  if (id === null) {
    const error = `STEALTH_HARNESS: ignoring "${echo(raw)}"; ${HARNESS_HINT}`;
    log(error);
    return { id: null, source: 'unset', error };
  }
  return { id, source: 'env', error: null };
}

// The pointer file's own facts, without targetDir: this block reports files,
// not profile directories. A pointer that was never read (no harness id, or an
// engine that owns its profile) is reported as not-applicable.
function pointerView(pointer) {
  return {
    path: pointer?.path ?? null,
    state: pointer?.state ?? 'not-applicable',
    name: pointer?.name ?? null,
    error: pointer?.error ?? null,
  };
}

// The additive `precedence.profile` block from spec §7.1, narrowed to the
// profile half. `won` is the existing profileSource vocabulary; the level that
// won is reported separately as profilePointerLevel.
export function profilePrecedenceReport({
  harness = null,
  session = null,
  harnessPointer = null,
  globalPointer = null,
  pointerLevel = null,
  won = null,
} = {}) {
  return {
    harness: {
      id: harness?.id ?? null,
      source: harness?.source ?? 'unset',
      error: harness?.error ?? null,
    },
    profile: {
      won,
      session: {
        profile_dir: session?.profile_dir ?? null,
        account: session?.account ?? null,
      },
      harness: pointerView(harnessPointer),
      global: pointerView(globalPointer),
    },
  };
}

// The existing pointer-source vocabulary, reused by the additive
// profileDefaultGlobal key. `null` means the pointer was not read at all.
export function pointerSource(pointer) {
  if (pointer === null || pointer === undefined) {
    return null;
  }
  if (pointer.state === 'present') {
    return 'pointer';
  }
  return pointer.state === 'missing' ? 'none' : 'invalid';
}

// { name, source, path, error } | null for the global pointer, reported beside
// the effective profileDefault* keys.
export function globalPointerReport(pointer) {
  if (pointer === null || pointer === undefined) {
    return null;
  }
  return {
    name: pointer.name,
    source: pointerSource(pointer),
    path: pointer.path,
    error: pointer.error,
  };
}
