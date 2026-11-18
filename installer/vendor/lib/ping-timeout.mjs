// Server-heartbeat timeout for MCP engines whose backend sends server->client
// pings, resolved from two places with one precedence:
//
//   1. PLAYWRIGHT_MCP_PING_TIMEOUT_MS — the wrapper's own variable (camoufox-
//      playwright-mcp 0.1.5, mcp/server.py:105-107 and :444-451). It is an
//      operator escape hatch: an explicit non-empty value wins, so a shell
//      environment can always override the plugin.
//   2. STEALTH_PING_TIMEOUT_MS — the plugin setting (userConfig
//      `ping_timeout_ms`), substituted by Claude Code through .mcp.json. It has
//      its own name precisely because the setting must never overwrite an
//      explicit value in (1).
//   3. otherwise 0 — the default: no heartbeat.
//
// The value is a deadline in milliseconds. The wrapper pings every 3 s (the
// interval is hard-coded upstream) and closes the browser and the MCP session
// when the answer does not arrive within this deadline; 0 means the middleware
// is not installed at all. That is the plugin default since 2.14.1: one late
// client answer (a stalled event loop, a busy machine, sleep/resume) was enough
// to lose the browser, and a dead client is already detected by the broker on
// its own pipe (stdin EOF).
//
// The helper is deliberately engine-neutral so a second engine that sends
// server pings can call it; today only launch-camoufox.mjs passes the value to
// its child, and only the camoufox engine's report says it applies.
export const PING_TIMEOUT_ENV_VAR = 'PLAYWRIGHT_MCP_PING_TIMEOUT_MS';
export const PING_TIMEOUT_SETTING_VAR = 'STEALTH_PING_TIMEOUT_MS';
export const PING_TIMEOUT_DEFAULT_MS = 0;
export const PING_TIMEOUT_ENGINE_ID = 'camoufox';

// A non-negative integer of milliseconds that JavaScript can represent exactly.
// Anything else is refused instead of guessed: the wrapper treats a value it
// cannot parse as its 5 s default, which is exactly the heartbeat that must not
// come back by accident.
function parseDeadlineMs(raw) {
  if (!/^\d+$/u.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

// The first non-empty value in the precedence order decides; a value that cannot
// be used does NOT fall through to the next source (an explicit operator value
// wins even when it is wrong, and the caller says so instead of hiding it). The
// effective deadline is then the default, 0.
//
// `source` names the layer that supplied the effective value ("env", "setting"
// or, for an unusable value, "default"); `variable` names the environment
// variable it came from; `problem` is "invalid", "placeholder" (an unsubstituted
// ${user_config.*} value, which the host did not resolve) or null.
export function resolvePingTimeout(env = {}) {
  for (const [variable, source] of [
    [PING_TIMEOUT_ENV_VAR, 'env'],
    [PING_TIMEOUT_SETTING_VAR, 'setting'],
  ]) {
    const value = env[variable];
    if (typeof value !== 'string' || value.trim() === '') {
      continue;
    }
    const raw = value.trim();
    if (raw.includes('${')) {
      return { ms: PING_TIMEOUT_DEFAULT_MS, source: 'default', variable, raw, problem: 'placeholder' };
    }
    const ms = parseDeadlineMs(raw);
    if (ms === null) {
      return { ms: PING_TIMEOUT_DEFAULT_MS, source: 'default', variable, raw, problem: 'invalid' };
    }
    return { ms, source, variable, raw, problem: null };
  }
  return { ms: PING_TIMEOUT_DEFAULT_MS, source: 'default', variable: null, raw: null, problem: null };
}

// Put the resolved deadline into a child environment. The variable is always
// written, including "0", so the wrapper's own 5 s default can never apply by
// omission.
export function applyPingTimeout(env) {
  const resolution = resolvePingTimeout(env);
  env[PING_TIMEOUT_ENV_VAR] = String(resolution.ms);
  return resolution;
}

// One honest sentence for a value that was ignored, shared by the launcher's
// stderr line and the meta-tool report so both say the same thing. Null when the
// value was usable (or absent).
export function pingTimeoutProblemNote(resolution) {
  if (resolution.problem === 'placeholder') {
    return (
      `Ping timeout: ignoring the unsubstituted placeholder ${JSON.stringify(resolution.raw)} from ` +
      `${resolution.variable}; the server heartbeat stays disabled.`
    );
  }
  if (resolution.problem === 'invalid') {
    return (
      `Ping timeout: ignoring ${resolution.variable} value ${JSON.stringify(resolution.raw)} because it is ` +
      'not a non-negative integer of milliseconds; the server heartbeat stays disabled.'
    );
  }
  return null;
}
