// Pure, manifest-driven tool-surface helpers for native MCP backends.
//
// A "native" engine speaks its own tool names and schemas instead of the
// Playwright MCP contract. The manifest classifies every backend tool exactly
// once: either as the target of one or more canonical `browser_*` aliases
// (`toolAliases`), or as a native-only tool exposed under the manifest's
// `nativePrefix`. This module owns the classification, the canonical schema
// projection, the call translation and the per-call profile injection. The
// broker only wires it to JSON-RPC; no engine id or tool name is hardcoded here.
import { readFileSync } from 'node:fs';
import { manifestSupport, NATIVE_CONTRACT, profileAllows } from '../engine-registry.mjs';

const META_TOOL_NAMES = new Set(['browser_capabilities', 'browser_engine_status']);
const CANONICAL_NAME_PATTERN = /^browser_[a-z0-9_]+$/;
const FORM_FIELD_TYPES = new Set(['textbox', 'combobox']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(object, key) {
  return Object.hasOwn(object, key);
}

// --- canonical schema file ------------------------------------------------

export function loadContractSchemas(file) {
  let document;
  try {
    document = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { schemas: null, error: `Cannot read ${file}: ${error.message}` };
  }
  if (!isPlainRecord(document) || document.schemaVersion !== 1) {
    return { schemas: null, error: `Invalid canonical contract ${file}: schemaVersion must be 1` };
  }
  if (!isPlainRecord(document.tools) || Object.keys(document.tools).length === 0) {
    return { schemas: null, error: `Invalid canonical contract ${file}: tools is missing` };
  }
  for (const [name, definition] of Object.entries(document.tools)) {
    if (!CANONICAL_NAME_PATTERN.test(name)) {
      return {
        schemas: null,
        error: `Invalid canonical contract ${file}: "${name}" is not a browser_* name`,
      };
    }
    if (!isPlainRecord(definition) || !nonEmptyString(definition.description)) {
      return { schemas: null, error: `Invalid canonical contract ${file}: "${name}" has no description` };
    }
    if (!isPlainRecord(definition.inputSchema)) {
      return { schemas: null, error: `Invalid canonical contract ${file}: "${name}" has no inputSchema` };
    }
  }
  return { schemas: document.tools, error: null };
}

// --- alias index, classification and surface ------------------------------

export function createAliasIndex(manifest) {
  const byCanonical = new Map();
  const byNative = new Map();
  const consumedNatives = new Set();
  const aliases = Array.isArray(manifest?.toolAliases) ? manifest.toolAliases : [];
  for (const alias of aliases) {
    if (!isPlainRecord(alias) || !nonEmptyString(alias.canonical)) {
      return { error: 'toolAliases has an entry without a canonical name' };
    }
    if (byCanonical.has(alias.canonical)) {
      return { error: `toolAliases declares "${alias.canonical}" more than once` };
    }
    byCanonical.set(alias.canonical, alias);
    const natives = [];
    if (nonEmptyString(alias.native)) {
      natives.push(alias.native);
    }
    if (isPlainRecord(alias.dispatch)) {
      natives.push(...Object.values(alias.dispatch));
    }
    for (const native of natives) {
      if (!nonEmptyString(native)) {
        return { error: `alias "${alias.canonical}" names an empty native tool` };
      }
      const owners = byNative.get(native) ?? [];
      if (!owners.includes(alias)) {
        owners.push(alias);
      }
      byNative.set(native, owners);
      consumedNatives.add(native);
    }
  }
  return { aliases, byCanonical, byNative, consumedNatives, error: null };
}

export function isNativeContract(manifest) {
  return manifest?.contract === NATIVE_CONTRACT;
}

// Classify one exposed name against the manifest alone. A prefixed name that
// matches an aliased native is not exposed (aliases consume their natives), so
// it is unknown even though the string is well formed.
export function classifyExposedTool(index, manifest, name) {
  if (typeof name !== 'string' || name === '') {
    return { kind: 'unknown' };
  }
  if (index.byCanonical.has(name)) {
    const entry = index.byCanonical.get(name);
    return { kind: 'canonical', entry, support: entry.support, native: entry.native ?? null };
  }
  const prefix = manifest.nativePrefix;
  if (nonEmptyString(prefix) && name.startsWith(prefix) && name.length > prefix.length) {
    const native = name.slice(prefix.length);
    if (index.consumedNatives.has(native)) {
      return { kind: 'unknown' };
    }
    return { kind: 'native-only', native, support: manifestSupport(manifest, native) };
  }
  return { kind: 'unknown' };
}

function transformConsumedArguments(alias) {
  switch (alias.transform) {
    case 'single-select-value':
      return ['values'];
    case 'form-fields':
      return ['fields'];
    case 'evaluate-function':
      return ['function', 'target'];
    case 'accept-to-action':
      return ['accept'];
    default:
      return [];
  }
}

// Advertise only the arguments the translation actually accepts. The canonical
// names, descriptions and annotations are kept; rejected properties and their
// required entries are removed so the advertised schema can never demand an
// argument the native tool cannot receive.
export function projectCanonicalSchema(schema, alias) {
  const properties = isPlainRecord(schema?.properties) ? schema.properties : {};
  const rejected = new Set(alias.reject ?? []);
  const keep = new Set();
  if (isPlainRecord(alias.dispatch)) {
    keep.add('action');
    for (const names of Object.values(alias.send ?? {})) {
      for (const name of names) {
        keep.add(name);
      }
    }
  } else {
    for (const name of Object.keys(alias.args ?? {})) {
      keep.add(name);
    }
    for (const name of alias.ignore ?? []) {
      keep.add(name);
    }
    for (const name of transformConsumedArguments(alias)) {
      keep.add(name);
    }
  }
  const projectedProperties = {};
  for (const [name, value] of Object.entries(properties)) {
    if (rejected.has(name) || !keep.has(name)) {
      continue;
    }
    projectedProperties[name] = value;
  }
  const projected = { ...schema, properties: projectedProperties };
  if (Array.isArray(schema?.required)) {
    const required = schema.required.filter((name) => own(projectedProperties, name));
    if (required.length === 0) {
      delete projected.required;
    } else {
      projected.required = required;
    }
  }
  return projected;
}

function canonicalDefinition(name, definition, alias) {
  return {
    name,
    description: definition.description,
    inputSchema: projectCanonicalSchema(definition.inputSchema, alias),
    ...(definition.annotations === undefined ? {} : { annotations: definition.annotations }),
  };
}

// Build the exposed surface for a native backend. backendTools is the raw
// tools/list array from the backend. Returns either an error (the caller falls
// back to meta-only) or a surface with deterministic order, the exposed names,
// per-name support and what each filter hid.
export function buildNativeSurface({ manifest, contracts, backendTools, toolProfile, profiles, disabled }) {
  const index = createAliasIndex(manifest);
  if (index.error !== null) {
    return { error: index.error };
  }
  const backendNames = new Set();
  for (const tool of backendTools) {
    if (isPlainRecord(tool) && nonEmptyString(tool.name)) {
      backendNames.add(tool.name);
    }
  }
  const missing = [...index.consumedNatives].filter((native) => !backendNames.has(native)).sort();
  if (missing.length > 0) {
    return {
      error:
        `Engine manifest aliases native tools the backend does not expose: ${missing.join(', ')}. ` +
        'Update the manifest or install the backend version it was written for.',
    };
  }
  if (!isPlainRecord(contracts)) {
    return { error: 'No canonical tool schemas are loaded; the native engine cannot advertise its aliases.' };
  }

  const definitions = new Map();
  const supportByExposed = new Map();
  const canonicalNames = new Set();
  const prefixedNames = new Set();
  const hiddenByManifest = [];
  const hiddenByProfile = [];
  const hiddenByCollision = [];
  for (const [canonical, alias] of index.byCanonical) {
    const definition = contracts[canonical];
    if (!isPlainRecord(definition)) {
      return { error: `No canonical schema for aliased tool "${canonical}" in ${manifest.contractSchemas}.` };
    }
    if (alias.support === 'none') {
      hiddenByManifest.push(canonical);
      continue;
    }
    definitions.set(canonical, canonicalDefinition(canonical, definition, alias));
    supportByExposed.set(canonical, alias.support);
    canonicalNames.add(canonical);
  }
  let nativeOnlyToolCount = 0;
  for (const tool of backendTools) {
    if (!isPlainRecord(tool) || !nonEmptyString(tool.name)) {
      continue;
    }
    if (index.consumedNatives.has(tool.name)) {
      continue;
    }
    nativeOnlyToolCount += 1;
    const exposed = `${manifest.nativePrefix}${tool.name}`;
    if (definitions.has(exposed) || META_TOOL_NAMES.has(exposed)) {
      return { error: `The manifest produces the duplicate exposed tool name "${exposed}".` };
    }
    const support = manifestSupport(manifest, tool.name);
    if (support === 'none') {
      hiddenByManifest.push(exposed);
      continue;
    }
    definitions.set(exposed, { ...tool, name: exposed });
    supportByExposed.set(exposed, support);
    prefixedNames.add(exposed);
  }
  if (definitions.size === 0) {
    return { error: 'The native backend exposes no tool for this manifest.' };
  }

  const tools = [];
  const exposedNames = new Set();
  for (const [name, tool] of definitions) {
    if (META_TOOL_NAMES.has(name)) {
      hiddenByCollision.push(name);
      continue;
    }
    if (!profileAllows(toolProfile, profiles, name, supportByExposed.get(name))) {
      hiddenByProfile.push(name);
      continue;
    }
    if (disabled.has(name)) {
      continue;
    }
    tools.push(tool);
    exposedNames.add(name);
  }
  tools.sort((left, right) => left.name.localeCompare(right.name));
  hiddenByProfile.sort();
  hiddenByManifest.sort();
  hiddenByCollision.sort();
  return {
    error: null,
    tools,
    exposedNames,
    exposedSupport: supportByExposed,
    canonicalNames,
    prefixedNames,
    backendNatives: backendNames,
    hiddenByProfile,
    hiddenByManifest,
    hiddenByCollision,
    counts: {
      backend: backendNames.size,
      canonical: index.byCanonical.size,
      nativeOnly: nativeOnlyToolCount,
    },
  };
}

// --- call translation ------------------------------------------------------

function injectProfile(manifest, native, args, profileValue) {
  const profile = manifest.profileArgument;
  if (!isPlainRecord(profile) || !nonEmptyString(profile.name) || !nonEmptyString(profileValue)) {
    return args;
  }
  if (Array.isArray(profile.except) && profile.except.includes(native)) {
    return args;
  }
  if (own(args, profile.name)) {
    return args;
  }
  return { ...args, [profile.name]: profileValue };
}

function translateDispatch(alias, args) {
  const action = args.action;
  if (!nonEmptyString(action)) {
    return { error: `"${alias.canonical}" requires an "action" argument.` };
  }
  if (!isPlainRecord(alias.dispatch) || !own(alias.dispatch, action)) {
    return { error: `"${alias.canonical}" has no native tool for action "${String(action)}".` };
  }
  const send = alias.send?.[action] ?? [];
  const missing = (alias.required?.[action] ?? []).filter((name) => !own(args, name));
  if (missing.length > 0) {
    return { error: `"${alias.canonical}" action "${action}" requires ${missing.join(', ')}.` };
  }
  const translated = {};
  for (const [name, value] of Object.entries(args)) {
    if (name === 'action') {
      continue;
    }
    if (!send.includes(name)) {
      return { error: `Argument "${name}" is not used by "${alias.canonical}" action "${action}".` };
    }
    const nativeName = alias.args?.[name] ?? name;
    translated[nativeName] = value;
  }
  return { native: alias.dispatch[action], args: translated };
}

function translateTransform(alias, canonicalArgs, translated) {
  switch (alias.transform) {
    case 'single-select-value': {
      const values = canonicalArgs.values;
      if (!Array.isArray(values) || values.length !== 1 || !nonEmptyString(values[0])) {
        return `"${alias.canonical}" maps to a single native value; pass exactly one entry in "values".`;
      }
      translated.value = values[0];
      return null;
    }
    case 'form-fields': {
      const fields = canonicalArgs.fields;
      if (!Array.isArray(fields)) {
        return `"${alias.canonical}" requires a "fields" array.`;
      }
      const mapped = [];
      for (const [position, field] of fields.entries()) {
        if (!isPlainRecord(field)) {
          return `Field ${position + 1} is not an object.`;
        }
        if (!nonEmptyString(field.target)) {
          return `Field ${position + 1} has no "target".`;
        }
        if (typeof field.value !== 'string') {
          return `Field ${position + 1} has no string "value".`;
        }
        if (field.type !== undefined && !FORM_FIELD_TYPES.has(field.type)) {
          return `Field ${position + 1} has type "${String(field.type)}"; the native fill_form accepts textbox and combobox fields only.`;
        }
        for (const name of Object.keys(field)) {
          if (!['element', 'name', 'target', 'type', 'value'].includes(name)) {
            return `Field ${position + 1} has unsupported argument "${name}".`;
          }
        }
        mapped.push({ uid: field.target, value: field.value });
      }
      translated.fields = mapped;
      return null;
    }
    case 'evaluate-function': {
      if (!nonEmptyString(canonicalArgs.function)) {
        return `"${alias.canonical}" requires a "function" argument.`;
      }
      translated.script = canonicalArgs.function;
      if (canonicalArgs.target !== undefined) {
        if (!nonEmptyString(canonicalArgs.target)) {
          return '"target" must be a non-empty string when provided.';
        }
        translated.uids = [canonicalArgs.target];
      }
      return null;
    }
    case 'console-level': {
      if (canonicalArgs.level !== undefined) {
        translated.levels = [canonicalArgs.level];
      }
      if (canonicalArgs.all !== undefined) {
        translated.include_preserved = canonicalArgs.all;
      }
      return null;
    }
    case 'accept-to-action': {
      if (typeof canonicalArgs.accept !== 'boolean') {
        return `"${alias.canonical}" requires a boolean "accept".`;
      }
      translated.action = canonicalArgs.accept ? 'accept' : 'dismiss';
      return null;
    }
    default:
      return null;
  }
}

// Resolve one exposed tool call into the native tool name and its arguments.
// Canonical names come from the manifest's aliases; prefixed names come from the
// backend's own list when a surface has been built, and from the manifest's
// native-only classification before that.
export function resolveNativeCall({ manifest, contracts, surface, exposedName, args, profileValue }) {
  const requestArgs = isPlainRecord(args) ? args : {};
  const index = createAliasIndex(manifest);
  if (index.error !== null) {
    return { error: index.error };
  }
  const classification = classifyExposedTool(index, manifest, exposedName);
  if (classification.kind === 'unknown') {
    return { error: `Unknown tool "${String(exposedName)}" for the "${manifest.id}" engine.` };
  }
  if (classification.kind === 'native-only') {
    if (surface !== null && !surface.backendNatives.has(classification.native)) {
      return { error: `Unknown native tool "${classification.native}" for the "${manifest.id}" engine.` };
    }
    if (surface === null && !own(manifest.toolSupport ?? {}, classification.native)) {
      return { error: `Unknown native tool "${classification.native}" for the "${manifest.id}" engine.` };
    }
    const nativeArgs = injectProfile(manifest, classification.native, requestArgs, profileValue);
    return { native: classification.native, arguments: nativeArgs, error: null };
  }

  const alias = classification.entry;
  if (isPlainRecord(alias.dispatch)) {
    const dispatch = translateDispatch(alias, requestArgs);
    if (dispatch.error !== undefined) {
      return { error: dispatch.error };
    }
    const nativeArgs = injectProfile(manifest, dispatch.native, dispatch.args, profileValue);
    return { native: dispatch.native, arguments: nativeArgs, error: null };
  }

  const definition = contracts?.[alias.canonical];
  if (!isPlainRecord(definition)) {
    return { error: `No canonical schema for aliased tool "${alias.canonical}".` };
  }
  const projected = projectCanonicalSchema(definition.inputSchema, alias);
  const required = Array.isArray(projected.required) ? projected.required : [];
  const missing = required.filter((name) => !own(requestArgs, name));
  if (missing.length > 0) {
    return { error: `"${alias.canonical}" requires ${missing.join(', ')}.` };
  }
  const argsMap = isPlainRecord(alias.args) ? alias.args : {};
  const ignored = new Set(alias.ignore ?? []);
  const rejected = new Set(alias.reject ?? []);
  const consumed = new Set(transformConsumedArguments(alias));
  const translated = {};
  for (const [name, value] of Object.entries(requestArgs)) {
    if (own(argsMap, name)) {
      translated[argsMap[name]] = value;
      continue;
    }
    if (consumed.has(name) || ignored.has(name)) {
      continue;
    }
    if (rejected.has(name)) {
      return { error: `Argument "${name}" is not supported by the native "${String(alias.native)}" tool.` };
    }
    return { error: `Argument "${name}" is not part of the mapped arguments for "${alias.canonical}".` };
  }
  const transformError = translateTransform(alias, requestArgs, translated);
  if (transformError !== null) {
    return { error: transformError };
  }
  const nativeArgs = injectProfile(manifest, alias.native, translated, profileValue);
  return { native: alias.native, arguments: nativeArgs, error: null };
}

// Manifest data for browser_capabilities: the whole alias map, so a caller can
// see which native tool each canonical name reaches without reading the file.
export function aliasSummary(manifest) {
  const aliases = Array.isArray(manifest?.toolAliases) ? manifest.toolAliases : [];
  return aliases.map((alias) => {
    const entry = { canonical: alias.canonical, support: alias.support };
    if (nonEmptyString(alias.native)) {
      entry.native = alias.native;
    }
    if (isPlainRecord(alias.dispatch)) {
      entry.dispatch = { ...alias.dispatch };
    }
    for (const field of ['args', 'ignore', 'reject', 'transform', 'send', 'required']) {
      if (alias[field] !== undefined) {
        entry[field] = Array.isArray(alias[field]) ? [...alias[field]] : { ...alias[field] };
      }
    }
    return entry;
  });
}
