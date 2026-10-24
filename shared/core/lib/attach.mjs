// Pure helpers for engines that attach to an already-running browser over a
// local CDP WebSocket instead of launching one.
//
// The module is manifest-driven: a manifest may declare a `runtime` block with
// the environment variable that holds a full endpoint, the variable that holds
// a profile id, the default endpoint template, the sentence the broker appends
// to a backend error, and the names of the extra browser_engine_status fields.
// No engine id, setting name or tool name is hardcoded here; the launcher names
// its own setting when it validates the value.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// An empty value and an unresolved ${user_config.*} placeholder are the same
// as unset: the host did not supply a usable value.
function usableEnvValue(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.includes('${')) {
    return null;
  }
  return trimmed;
}

function normalizeHostname(hostname) {
  const value = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1);
  }
  return value;
}

// Replace the template's profile placeholder. The id is percent-encoded as one
// path segment: a slash, a space or a non-ASCII character must not change the
// URL's structure.
export function buildEndpoint(template, profileId) {
  return String(template).split('{profileId}').join(encodeURIComponent(profileId));
}

// Validate an explicit endpoint setting. Only ws:// or wss:// on a loopback
// host is accepted: a CDP endpoint is full browser control, and this plugin's
// scope is local engines. The setting name is a parameter so the message names
// the exact row the user must edit.
export function validateEndpointSetting(raw, settingName) {
  const setting = nonEmptyString(settingName) ? settingName.trim() : 'endpoint';
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') {
    return {
      endpoint: null,
      error:
        `${setting} is empty. Leave it empty to use the default endpoint, or enter a full ` +
        'ws:// or wss:// URL on a loopback host.',
    };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    // WHATWG URL rejects a port above 65535 outright, losing the specific
    // reason; recover it from the authority so the message names the rule.
    const authority = /^wss?:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]*):(\d+)(?:[/?#]|$)/i.exec(value);
    if (authority !== null) {
      const port = Number(authority[2]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return {
          endpoint: null,
          error: `${setting} port "${authority[2]}" is outside 1-65535.`,
        };
      }
    }
    return {
      endpoint: null,
      error:
        `${setting} must be a full URL starting with ws:// or wss://, ` +
        'for example ws://127.0.0.1:5050/playwright/<profile ID>.',
    };
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return {
      endpoint: null,
      error:
        `${setting} must use the ws:// or wss:// scheme, not "${url.protocol}". ` +
        'A CDP endpoint is a WebSocket URL, not an HTTP page.',
    };
  }
  const host = normalizeHostname(url.hostname);
  if (host === '') {
    return { endpoint: null, error: `${setting} must name a host.` };
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    return {
      endpoint: null,
      error:
        `${setting} must point at a loopback host (127.0.0.1, ::1 or localhost), not "${host}". ` +
        "Remote CDP endpoints are outside this plugin's local-engine scope.",
    };
  }
  if (url.username !== '' || url.password !== '') {
    return {
      endpoint: null,
      error: `${setting} must not contain a username or password; put credentials in the browser profile instead.`,
    };
  }
  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return {
        endpoint: null,
        error: `${setting} port "${url.port}" is outside 1-65535.`,
      };
    }
  }
  return { endpoint: value, error: null };
}

// The runtime facts a manifest's `runtime` block describes, resolved against
// the process environment. Null when the manifest declares no runtime block
// (every launch-only engine), so callers add nothing for those engines.
export function effectiveRuntime(manifest, env) {
  const runtime = isPlainObject(manifest?.runtime) ? manifest.runtime : null;
  if (runtime === null) {
    return null;
  }
  const profileId = nonEmptyString(runtime.profileEnv) ? usableEnvValue(env?.[runtime.profileEnv]) : null;
  let endpoint = null;
  let endpointSource = 'none';
  if (nonEmptyString(runtime.endpointEnv)) {
    const explicit = usableEnvValue(env?.[runtime.endpointEnv]);
    if (explicit !== null) {
      endpoint = explicit;
      endpointSource = 'setting';
    }
  }
  if (endpoint === null && nonEmptyString(runtime.defaultEndpoint) && profileId !== null) {
    endpoint = buildEndpoint(runtime.defaultEndpoint, profileId);
    endpointSource = 'default';
  }
  return { endpoint, endpointSource, profileId };
}

// The one sentence the broker appends to a backend error tool result while no
// tool call has succeeded yet. Null when the manifest asks for no enrichment.
export function runtimeErrorHint(manifest, env) {
  const runtime = isPlainObject(manifest?.runtime) ? manifest.runtime : null;
  if (runtime === null || !nonEmptyString(runtime.errorHint)) {
    return null;
  }
  const effective = effectiveRuntime(manifest, env);
  const endpoint = effective?.endpoint ?? 'the configured endpoint';
  return runtime.errorHint.split('{endpoint}').join(endpoint);
}

// Extra browser_engine_status fields, named by the manifest so an engine's
// diagnostics are visible without the broker knowing the engine id.
export function runtimeStatusFields(manifest, env) {
  const runtime = isPlainObject(manifest?.runtime) ? manifest.runtime : null;
  if (runtime === null || !isPlainObject(runtime.statusKeys)) {
    return {};
  }
  const effective = effectiveRuntime(manifest, env);
  const fields = {};
  for (const [field, key] of Object.entries(runtime.statusKeys)) {
    if (field === 'endpoint') {
      fields[key] = effective?.endpoint ?? null;
    } else if (field === 'profileId') {
      fields[key] = effective?.profileId ?? null;
    }
  }
  return fields;
}

// Append the hint to the text content of an isError tool result. Protocol
// errors (a JSON-RPC `error` object) are never touched; structuredContent is
// preserved. Returns null when there is nothing to enrich, so the broker can
// relay the original line byte-for-byte.
export function enrichToolError(result, hint) {
  if (!isPlainObject(result) || result.isError !== true || !nonEmptyString(hint)) {
    return null;
  }
  const content = Array.isArray(result.content) ? [...result.content] : [];
  let lastTextIndex = -1;
  for (const [index, item] of content.entries()) {
    if (isPlainObject(item) && item.type === 'text' && typeof item.text === 'string') {
      lastTextIndex = index;
    }
  }
  if (lastTextIndex === -1) {
    content.push({ type: 'text', text: hint });
  } else {
    const item = content[lastTextIndex];
    content[lastTextIndex] = { ...item, text: `${item.text} ${hint}` };
  }
  return { ...result, content };
}
