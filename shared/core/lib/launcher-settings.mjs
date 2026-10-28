// Launcher-side settings and their safe branches (2.21.0).
//
// Most settings are resolved by the broker. These are the ones a launcher turns
// into the child environment of an engine, so the launcher is where they are
// used and where a bad value used to do damage:
//
//   headless         an unset PLAYWRIGHT_MCP_HEADLESS means headless to the
//                    pinned bridge (its own default is true), so a missing value
//                    silently flipped a headed install to a detectable headless
//                    one;
//   humanize         the bridge's own default is false, so a missing value
//                    silently disabled the humanization the plugin ships;
//   human_preset     the bridge THROWS on anything but "default"/"careful", so a
//                    placeholder exited the backend and left a meta-only server;
//   release_channel  the bridge THROWS on anything but "stable"/"preview";
//   proxy_server     a placeholder was passed to the engine as a proxy URL and
//                    the browser failed at its first start;
//   engine_version   a placeholder asked the wrapper for a version named
//                    "${user_config.engine_version}";
//   camoufox_profile a placeholder failed the app's own profile-name rule.
//
// The rule (2026-10-28 decision, Q9/Q10): a value is used only when it is one of
// the setting's documented choices. Otherwise — unset, empty, an unsubstituted
// ${user_config.*} placeholder, or an unrecognised value — the code takes its
// documented safe branch, the launcher writes exactly one stderr line, and
// browser_capabilities reports which source won (launcherSettings) with the same
// one-line reason. A safe branch never throws, never refuses a start that would
// otherwise work, never widens a security-relevant setting and never silently
// changes identity or data.
//
// The safe branch for each setting is defined HERE, in code, not in plugin.json:
// the plugin manifest's default is only what the host substitutes, and the
// placeholder case exists precisely because the host may not substitute at all.
const SETTING_STATES = Object.freeze({
  UNSET: 'unset',
  EMPTY: 'empty',
  PLACEHOLDER: 'placeholder',
  VALUE: 'value',
});

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);
const HEADLESS_SAFE = false;
const HUMANIZE_SAFE = true;
const HUMAN_PRESET_VALUES = Object.freeze(['default', 'careful']);
const RELEASE_CHANNEL_VALUES = Object.freeze(['stable', 'preview']);

// Say nothing about a value that is not there: an unset or empty optional value
// is the normal state (the plugin's own text documents it), and a per-start log
// line for it would be noise in every session.
export function settingState(raw) {
  if (typeof raw !== 'string') {
    return SETTING_STATES.UNSET;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return SETTING_STATES.EMPTY;
  }
  if (trimmed.includes('${')) {
    return SETTING_STATES.PLACEHOLDER;
  }
  return SETTING_STATES.VALUE;
}

function echo(raw) {
  const text = typeof raw === 'string' ? raw.trim().replaceAll('\n', ' ') : '';
  return text.length > 60 ? `${text.slice(0, 60)}...` : text;
}

// A boolean setting whose documented safe branch is `safe`. The branch is used
// for every value that is not one of the accepted spellings, and the engine never
// sees the unusable value.
export function resolveBooleanSetting(raw, { name, envName, safe }) {
  const state = settingState(raw);
  if (state === SETTING_STATES.VALUE) {
    const folded = raw.trim().toLowerCase();
    if (TRUE_VALUES.has(folded)) {
      return { value: true, source: 'setting', note: null };
    }
    if (FALSE_VALUES.has(folded)) {
      return { value: false, source: 'setting', note: null };
    }
    return {
      value: safe,
      source: 'default',
      note:
        `${name}: "${echo(raw)}" is not true or false, so this start uses ${name} ${String(safe)} ` +
        `(${envName}); the value was not passed to the engine.`,
    };
  }
  if (state === SETTING_STATES.PLACEHOLDER) {
    return {
      value: safe,
      source: 'default',
      note: `${name}: ignoring the unsubstituted placeholder ${echo(raw)}; this start uses ${name} ${String(safe)}.`,
    };
  }
  // Unset and empty take the same safe branch. Only a setting whose safe branch
  // differs from the engine's own default says so, so a default start stays quiet.
  return {
    value: safe,
    source: 'default',
    note:
      safe === true
        ? `${name}: ${envName} is not set, so this start keeps ${name} true; the engine's own default would ` +
          'turn it off.'
        : `${name}: ${envName} is not set, so this start runs headed (headless false); the engine's own ` +
          'default would be headless.',
  };
}

// A choice setting whose documented safe branch is `safe`. An unset or empty
// value is the documented default and says nothing: the engine's own default is
// the same value, so the child environment stays exactly what it was.
export function resolveChoiceSetting(raw, { name, choices, safe }) {
  const state = settingState(raw);
  if (state === SETTING_STATES.VALUE) {
    const folded = raw.trim().toLowerCase();
    if (choices.includes(folded)) {
      return { value: folded, source: 'setting', note: null };
    }
    return {
      value: safe,
      source: 'default',
      note:
        `${name}: "${echo(raw)}" is not ${choices.join(' or ')}, so this start uses "${safe}"; the engine ` +
        'never receives a value it would refuse.',
    };
  }
  if (state === SETTING_STATES.PLACEHOLDER) {
    return {
      value: safe,
      source: 'default',
      note: `${name}: ignoring the unsubstituted placeholder ${echo(raw)}; this start uses "${safe}".`,
    };
  }
  return { value: safe, source: 'default', note: null };
}

// A free-form optional value (a path, a URL, a version, a profile name). There is
// no documented choice to validate against, so only a missing substitution is a
// broken value: the placeholder would be used literally as a path or a URL. It is
// dropped, exactly as an empty value already is, and the engine behaves as if the
// setting were unset.
export function resolveOptionalSetting(raw, { name }) {
  const state = settingState(raw);
  if (state === SETTING_STATES.VALUE) {
    return { value: raw.trim(), source: 'setting', note: null };
  }
  if (state === SETTING_STATES.PLACEHOLDER) {
    return {
      value: null,
      source: 'default',
      note: `${name}: ignoring the unsubstituted placeholder ${echo(raw)}; this start behaves as if it were unset.`,
    };
  }
  return { value: null, source: 'default', note: null };
}

// Which settings a launcher actually turns into its child environment. An engine
// whose launcher does not read a setting never sees it, so its payload gains
// nothing: the report is driven by the launcher, not by the plugin's key list.
export const LAUNCHER_SETTINGS = Object.freeze({
  'launch.mjs': Object.freeze([
    'headless',
    'humanize',
    'human_preset',
    'release_channel',
    'proxy_server',
    'proxy_bypass',
    'engine_version',
    'licence_key',
    'output_dir',
  ]),
  'launch-camoufox.mjs': Object.freeze(['headless', 'proxy_server', 'proxy_bypass', 'output_dir']),
  'launch-camoufox-native.mjs': Object.freeze(['headless', 'camoufox_profile', 'camoufox_data_dir']),
  // Kameleo owns the window, its proxy and its browser build; only the artifact
  // directory reaches the Playwright MCP CLI in attach mode.
  'launch-kameleo.mjs': Object.freeze(['output_dir']),
});

export const LAUNCHER_SETTING_ENV = Object.freeze({
  headless: 'PLAYWRIGHT_MCP_HEADLESS',
  humanize: 'CLOAK_PLAYWRIGHT_MCP_HUMANIZE',
  human_preset: 'CLOAK_PLAYWRIGHT_MCP_HUMAN_PRESET',
  release_channel: 'CLOAK_PLAYWRIGHT_MCP_RELEASE_CHANNEL',
  proxy_server: 'PLAYWRIGHT_MCP_PROXY_SERVER',
  proxy_bypass: 'PLAYWRIGHT_MCP_PROXY_BYPASS',
  engine_version: 'CLOAKBROWSER_VERSION',
  licence_key: 'CLOAKBROWSER_LICENSE_KEY',
  output_dir: 'PLAYWRIGHT_MCP_OUTPUT_DIR',
  camoufox_profile: 'CAMOUFOX_PROFILE',
  camoufox_data_dir: 'CAMOUFOX_DATA_DIR',
});

// The settings a launcher resolves, with their safe branch, as one object. The
// launcher applies `values` to its child environment; the broker reports `report`
// from the same function and the same environment, so the two can never disagree.
// `report` never carries a proxy URL or a licence key: those may contain
// credentials, so only the fact and the source are reported.
export function resolveLauncherSettings(env, launcherName) {
  const names = LAUNCHER_SETTINGS[launcherName] ?? [];
  const values = {};
  const report = {};
  const notes = [];
  for (const name of names) {
    const raw = env[LAUNCHER_SETTING_ENV[name]];
    let resolved;
    if (name === 'headless') {
      resolved = resolveBooleanSetting(raw, {
        name,
        envName: LAUNCHER_SETTING_ENV[name],
        safe: HEADLESS_SAFE,
      });
    } else if (name === 'humanize') {
      resolved = resolveBooleanSetting(raw, {
        name: 'humanize',
        envName: LAUNCHER_SETTING_ENV[name],
        safe: HUMANIZE_SAFE,
      });
    } else if (name === 'human_preset') {
      resolved = resolveChoiceSetting(raw, {
        name: 'human_preset',
        choices: HUMAN_PRESET_VALUES,
        safe: 'default',
      });
    } else if (name === 'release_channel') {
      resolved = resolveChoiceSetting(raw, {
        name: 'release_channel',
        choices: RELEASE_CHANNEL_VALUES,
        safe: 'stable',
      });
    } else {
      resolved = resolveOptionalSetting(raw, { name });
    }
    values[name] = resolved.value;
    if (name === 'proxy_server' || name === 'licence_key') {
      report[name] = {
        configured: resolved.value !== null,
        source: resolved.source,
        ...(resolved.note === null ? {} : { note: resolved.note }),
      };
    } else {
      report[name] = {
        value: resolved.value,
        source: resolved.source,
        ...(resolved.note === null ? {} : { note: resolved.note }),
      };
    }
    if (resolved.note !== null) {
      notes.push(resolved.note);
    }
  }
  return { values, report, notes };
}

// Apply the resolved settings to a launcher's child environment. The two engine
// variables that accept a boolean are always written in their canonical spelling,
// so neither the bridge's nor the wrapper's own default can apply by omission; a
// value the engine would refuse is never written.
export function applyLauncherSettings(env, launcherName, log) {
  const { values, notes } = resolveLauncherSettings(env, launcherName);
  for (const note of notes) {
    log(note);
  }
  for (const [name, value] of Object.entries(values)) {
    const envName = LAUNCHER_SETTING_ENV[name];
    if (value === null || value === undefined) {
      delete env[envName];
    } else if (typeof value === 'boolean') {
      env[envName] = value ? 'true' : 'false';
    } else {
      env[envName] = value;
    }
  }
  return env;
}

// The payload object browser_capabilities reports, or null for a launcher that
// resolves none of these settings (an unknown or future launcher).
export function launcherSettingsReport(env, launcherName) {
  const { report } = resolveLauncherSettings(env, launcherName);
  if (Object.keys(report).length === 0) {
    return null;
  }
  return { launcher: launcherName, ...report };
}
