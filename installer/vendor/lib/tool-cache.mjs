// Tool-list cache for a held start (2.16.0).
//
// A single-seat engine (CloakBrowser: the free licence allows one concurrent
// browser) cannot start a second backend on a busy profile, so the session waits
// and retries on its next tool call. While it waits the server stays usable: the
// tool list the backend sent on a previous successful start is served from this
// cache through the normal manifest → profile → disabled filter. The cache holds
// the backend's own tool objects (name, description, inputSchema), never the
// filtered result, so a changed tool profile or disabled list is applied on
// read and can never be served stale.
//
// The file lives under the plugin data directory and is keyed by the engine, the
// tool profile and a digest of everything else that shapes the list (the seven
// tool-group switches, the MCP package pin and the manifest fields that shape the
// surface). Since 2.21.0 the key no longer includes the broker version, which
// never shaped a backend list and made every release start with no cache; the
// version below is the STORED-SHAPE version and moves only when the payload
// layout does. Nothing here throws: a missing, unreadable, oversized or malformed
// cache is reported as an error string and the caller decides what to answer.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// 2: the payload carries the surface digest in `caps` instead of the broker
// version, so a previous release's file can never be read as this one's.
export const TOOL_CACHE_VERSION = 2;
export const TOOL_CACHE_DIRNAME = 'cache';
export const TOOL_CACHE_MAX_BYTES = 2 * 1024 * 1024;
export const TOOL_CACHE_MAX_TOOLS = 400;
const KEY_LENGTH = 12;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The cache key: the tool profile, then a short digest of the engine, the
// switches, the package pin and the broker version. Both parts are file-name
// safe by construction.
export function toolCacheKey({ engineId, toolProfile, caps }) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ engineId, toolProfile, caps: isPlainObject(caps) ? caps : {} }))
    .digest('hex')
    .slice(0, KEY_LENGTH);
  const profile =
    typeof toolProfile === 'string' && toolProfile.trim() !== '' ? toolProfile.trim() : 'default';
  return `${profile}-${digest}`;
}

export function toolCachePath(engineId, dataDir, key) {
  const engine = typeof engineId === 'string' && engineId.trim() !== '' ? engineId.trim() : 'engine';
  return path.join(path.resolve(dataDir), TOOL_CACHE_DIRNAME, engine, `tools-${key}.json`);
}

// Keep only entries a client can call: an object with a non-empty string name.
// Everything else in the object is passed through untouched, and the list is
// bounded so a corrupt cache cannot exhaust memory.
function usableTools(tools) {
  if (!Array.isArray(tools)) {
    return null;
  }
  const kept = [];
  for (const tool of tools) {
    if (kept.length >= TOOL_CACHE_MAX_TOOLS) {
      break;
    }
    if (isPlainObject(tool) && typeof tool.name === 'string' && tool.name.trim() !== '') {
      kept.push(tool);
    }
  }
  return kept.length === 0 ? null : kept;
}

// Read the cached backend tool list. Returns { tools, savedAt, error }: tools is
// null when there is nothing usable, and error says why (a missing cache is the
// normal first-start state and reports "missing").
export function readToolCache(file) {
  if (typeof file !== 'string' || file.trim() === '') {
    return { tools: null, savedAt: null, error: 'no cache path' };
  }
  let bytes;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) {
      return { tools: null, savedAt: null, error: 'not a regular file' };
    }
    if (stat.size > TOOL_CACHE_MAX_BYTES) {
      return { tools: null, savedAt: null, error: 'larger than the cache bound' };
    }
    bytes = readFileSync(file);
  } catch (error) {
    return {
      tools: null,
      savedAt: null,
      error: error?.code === 'ENOENT' ? 'missing' : `cannot read it: ${error.message}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { tools: null, savedAt: null, error: 'not valid JSON' };
  }
  if (!isPlainObject(parsed) || parsed.version !== TOOL_CACHE_VERSION) {
    return { tools: null, savedAt: null, error: 'an unknown cache version' };
  }
  const tools = usableTools(parsed.tools);
  if (tools === null) {
    return { tools: null, savedAt: null, error: 'no usable tool entries' };
  }
  return {
    tools,
    savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
    error: null,
  };
}

// Write the cache atomically. Returns { written, error }; a failure is logged by
// the caller and never stops a start or a tool call.
export function writeToolCache(file, { engineId, toolProfile, caps, tools, now = new Date() } = {}) {
  const usable = usableTools(tools);
  if (usable === null) {
    return { written: false, error: 'there is no tool list to cache' };
  }
  const payload = {
    version: TOOL_CACHE_VERSION,
    engine: typeof engineId === 'string' ? engineId : null,
    toolProfile: typeof toolProfile === 'string' ? toolProfile : null,
    caps: isPlainObject(caps) ? caps : {},
    savedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    tools: usable,
  };
  const body = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(body, 'utf8') > TOOL_CACHE_MAX_BYTES) {
    return { written: false, error: 'the tool list is larger than the cache bound' };
  }
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, body, 'utf8');
    renameSync(temporary, file);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The temporary file is beside the cache; leaving it changes no behaviour.
    }
    return { written: false, error: `cannot write the tool cache ${file}: ${error.message}` };
  }
  return { written: true, error: null };
}
