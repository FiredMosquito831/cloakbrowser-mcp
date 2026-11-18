// Source-preserving span finders for the three Phase 1 config formats.
// Nothing here serialises a whole document: every edit is a splice into the
// original bytes, followed by a full re-parse in writers.mjs.
import { SabmError } from './envelope.mjs';
import { parseText } from './parsers.mjs';

function refusal(path, message, remedy = 'Fix the file with an editor, then try again.') {
  throw new SabmError('refused', 'parse-error', message, remedy);
}

export function skipTrivia(text, index) {
  let i = index;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return i;
      i = end + 2;
      continue;
    }
    return i;
  }
}

export function readJsonKey(text, index) {
  if (text[index] === '"' || text[index] === "'") {
    const quote = text[index];
    let i = index + 1;
    let value = '';
    while (i < text.length && text[i] !== quote) {
      if (text[i] === '\\' && quote === '"') {
        value += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      value += text[i];
      i += 1;
    }
    if (i >= text.length) return null;
    return {
      key: quote === '"' ? JSON.parse(`"${value}"`) : value,
      start: index,
      end: i + 1,
      next: i + 1,
    };
  }
  const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(index));
  if (!match) return null;
  return { key: match[0], start: index, end: index + match[0].length, next: index + match[0].length };
}

// Skip one JSON/JSONC value, tolerating comments, trailing commas and quotes.
export function skipJsonValue(text, index) {
  let i = skipTrivia(text, index);
  if (text[i] === '"' || text[i] === "'") {
    const quote = text[i];
    i += 1;
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i] === quote) return i + 1;
      i += 1;
    }
    return i;
  }
  if (text[i] === '{' || text[i] === '[') {
    const stack = [text[i]];
    i += 1;
    while (i < text.length && stack.length > 0) {
      const char = text[i];
      if (char === '"' || char === "'") {
        const end = skipJsonValue(text, i);
        i = end;
        continue;
      }
      if (char === '/' && text.startsWith('//', i)) {
        i = skipTrivia(text, i);
        continue;
      }
      if (char === '/' && text.startsWith('/*', i)) {
        i = skipTrivia(text, i);
        continue;
      }
      if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        const open = stack.pop();
        if ((open === '{' && char !== '}') || (open === '[' && char !== ']')) return i;
      }
      i += 1;
    }
    return i;
  }
  while (
    i < text.length &&
    !/[\s,}\]]/.test(text[i]) &&
    !text.startsWith('//', i) &&
    !text.startsWith('/*', i)
  ) {
    i += 1;
  }
  return i;
}

export function jsonProperties(text, objectSpan) {
  const properties = [];
  let i = objectSpan.innerStart;
  for (;;) {
    const at = skipTrivia(text, i);
    if (at >= objectSpan.close || text[at] === '}') break;
    const key = readJsonKey(text, at);
    if (!key) break;
    let cursor = skipTrivia(text, key.next);
    if (text[cursor] !== ':') break;
    cursor = skipTrivia(text, cursor + 1);
    const valueEnd = skipJsonValue(text, cursor);
    const after = skipTrivia(text, valueEnd);
    const commaAfter = text[after] === ',' ? after : null;
    properties.push({
      key: key.key,
      start: key.start,
      end: valueEnd,
      valueStart: cursor,
      valueEnd,
      commaAfter,
      next: commaAfter === null ? valueEnd : commaAfter + 1,
    });
    i = commaAfter === null ? valueEnd : commaAfter + 1;
  }
  return properties;
}

// Locate an object by a chain of keys. Missing intermediate objects are
// reported by key so the caller can create the chain in one splice.
export function findJsonObject(text, keys) {
  let objectSpan = {
    start: 0,
    innerStart: skipTrivia(text, 0),
    close: text.lastIndexOf('}'),
  };
  if (text[objectSpan.innerStart] !== '{' || objectSpan.close < objectSpan.innerStart) {
    return { found: false, missingAt: 0, objectSpan: null };
  }
  objectSpan.innerStart += 1;
  for (let depth = 0; depth < keys.length; depth += 1) {
    const property = jsonProperties(text, objectSpan).find((item) => item.key === keys[depth]);
    if (!property) return { found: false, missingAt: depth, objectSpan };
    const valueStart = skipTrivia(text, property.valueStart);
    if (text[valueStart] !== '{') return { found: false, missingAt: depth, objectSpan, nonObject: true };
    const close = findClosingBrace(text, valueStart);
    if (close === -1) return { found: false, missingAt: depth, objectSpan, nonObject: true };
    objectSpan = { start: valueStart, innerStart: valueStart + 1, close };
  }
  return { found: true, objectSpan };
}

export function findClosingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' || char === "'") {
      i = skipJsonValue(text, i) - 1;
      continue;
    }
    if (char === '/' && text.startsWith('//', i)) {
      const end = text.indexOf('\n', i + 2);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (char === '/' && text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function insertJsonProperty(
  text,
  objectSpan,
  key,
  valueText,
  indent = '  ',
  eol = '\n',
  format = 'json',
) {
  const properties = jsonProperties(text, objectSpan);
  const existing = properties.find((property) => property.key === key);
  // Replace only the value span: the existing quoted key and its indentation
  // are part of the user's file and must survive the edit.
  if (existing) {
    return { start: existing.valueStart, end: existing.valueEnd, inserted: valueText, action: 'replace' };
  }
  const last = properties.at(-1);
  // Match the parent's trailing-comma style. With a pre-existing trailing
  // comma, our property ends with one too, so removal is unambiguous.
  const trailing = format === 'jsonc' && last && last.commaAfter !== null ? ',' : '';
  // Insert AFTER an existing trailing comma, not before it: the comma belongs
  // to the previous property and must stay with it for add/remove byte equality.
  const at = last ? (last.commaAfter === null ? last.valueEnd : last.commaAfter + 1) : objectSpan.innerStart;
  const prefix = last && last.commaAfter === null ? ',' : '';
  const inserted = `${prefix}${eol}${indent}${JSON.stringify(key)}: ${valueText}${trailing}`;
  return { start: at, end: at, inserted, action: 'insert' };
}

function nestedJsonObject(keys, leaf, indent, eol, level = 0) {
  const pad = indent.repeat(level + 1);
  const body = `${pad}${JSON.stringify(keys[0])}: ${
    keys.length === 1 ? leaf : nestedJsonObject(keys.slice(1), leaf, indent, eol, level + 1)
  }`;
  return `{${eol}${body}${eol}${indent.repeat(level)}}`;
}

// Create missing parent objects in one splice. A missing root is created too.
export function insertJsonPath(
  text,
  parentKeys,
  name,
  valueText,
  indent = '  ',
  eol = '\n',
  format = 'json',
) {
  const found = findJsonObject(text, parentKeys);
  if (found.found) {
    return insertJsonProperty(text, found.objectSpan, name, valueText, indent, eol, format);
  }
  if (found.nonObject) {
    throw new SabmError(
      'refused',
      'parse-error',
      `${parentKeys.slice(0, found.missingAt + 1).join('.')} is not an object; refusing to guess an edit span.`,
      'Convert the parent to an object with an editor, then try again.',
    );
  }
  if (!found.objectSpan) {
    return {
      start: 0,
      end: text.length,
      inserted: `${nestedJsonObject([...parentKeys, name], valueText, indent, eol)}${eol}`,
      action: 'create',
    };
  }
  const missing = parentKeys.slice(found.missingAt);
  return insertJsonProperty(
    text,
    found.objectSpan,
    missing[0],
    nestedJsonObject([...missing.slice(1), name], valueText, indent, eol),
    indent,
    eol,
    format,
  );
}

export function removeJsonProperty(text, objectSpan, key, format = 'json') {
  const properties = jsonProperties(text, objectSpan);
  const property = properties.find((item) => item.key === key);
  if (!property) return null;
  const index = properties.indexOf(property);
  const previous = properties[index - 1];
  const candidates = [];
  if (!previous) {
    // The first property's leading EOL + indent were inserted by us.
    candidates.push({
      start: objectSpan.innerStart,
      end: property.commaAfter !== null ? property.commaAfter + 1 : property.valueEnd,
    });
  }
  if (property.commaAfter !== null) {
    // A pre-existing trailing comma means our inserted property also carries
    // one; its leading newline + indent are part of our span too.
    if (previous?.commaAfter !== null && previous?.commaAfter !== undefined) {
      candidates.push({ start: previous.commaAfter + 1, end: property.commaAfter + 1 });
    }
    candidates.push({ start: property.start, end: property.commaAfter + 1 });
  }
  if (previous) {
    // A comma directly before a last property with no comma of its own was
    // inserted by us; remove it first. Parsers accept trailing commas in JSONC,
    // so parser-only candidate selection would leave that comma behind.
    candidates.push({ start: previous.valueEnd, end: property.valueEnd });
    if (previous.commaAfter !== null) {
      candidates.push({ start: previous.commaAfter + 1, end: property.valueEnd });
    }
  }
  candidates.push({ start: property.start, end: property.valueEnd });
  for (const candidate of candidates) {
    const next = spliceText(text, { ...candidate, inserted: '' });
    try {
      parseText(format, next);
      return { ...candidate, action: 'remove' };
    } catch {
      // Try the next inverse span.
    }
  }
  return { ...candidates[0], action: 'remove' };
}

const TOML_TABLE =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(\.\s*env\s*)?\]\s*$/;

export function findTomlEntry(text, name) {
  const lines = text.split('\n');
  const headers = [];
  let offset = 0;
  for (const line of lines) {
    const match = TOML_TABLE.exec(line);
    const key = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
    if (match && key === name) {
      headers.push({ env: Boolean(match[4]), lineStart: offset, lineEnd: offset + line.length });
    }
    offset += line.length + 1;
  }
  if (headers.length === 0) return null;
  const main = headers.find((header) => !header.env);
  const env = headers.find((header) => header.env);
  // A main table without an env table is still our entry (Phase 0 snippets
  // could be copied in that shape); splices replace exactly what is present.
  if (!main) {
    refusal(
      'config',
      `The entry tables for "${name}" are incomplete; refusing to guess an edit span.`,
      `Run 'codex mcp remove ${name}' and install again.`,
    );
  }
  const last = env ?? main;
  const nextHeader = /\s*\[[^\]]+\]\s*$/;
  let end = text.length;
  for (let i = last.lineEnd; i < text.length; i += 1) {
    if (text.startsWith('\n', i)) {
      const line = text.slice(
        i + 1,
        text.indexOf('\n', i + 1) === -1 ? text.length : text.indexOf('\n', i + 1),
      );
      if (nextHeader.test(line)) {
        end = i + 1;
        break;
      }
    }
  }
  while (end > last.lineEnd && /[\r\n]/.test(text[end - 1])) end -= 1;
  return { start: main.lineStart, end, main, env };
}

export function insertTomlEntry(text, block) {
  const start = text.length;
  return { start, end: start, inserted: `\n${block}`, action: 'insert' };
}

export function removeTomlEntry(text, entry) {
  // The splice engine always inserts a single newline before our first table;
  // that newline is part of our span so add -> remove restores the exact bytes.
  const start = entry.start > 0 && text[entry.start - 1] === '\n' ? entry.start - 1 : entry.start;
  let end = entry.end;
  if (end < text.length && text[end] === '\n') end += 1;
  return { start, end, action: 'remove' };
}

// Remove parent objects that our writer created when they become empty.
// Objects containing comments or other keys are left untouched.
export function removeEmptyParentChain(text, parentKeys, format = 'json') {
  let working = text;
  for (let depth = parentKeys.length - 1; depth >= 0; depth -= 1) {
    const chain = findJsonObject(working, parentKeys.slice(0, depth + 1));
    if (!chain.found) break;
    const span = chain.objectSpan;
    if (working.slice(span.innerStart, span.close).trim() !== '') break;
    const parent = findJsonObject(working, parentKeys.slice(0, depth));
    if (!parent.found) break;
    const edit = removeJsonProperty(working, parent.objectSpan, parentKeys[depth], format);
    if (!edit) break;
    working = spliceText(working, edit);
  }
  return working;
}

export function spliceText(text, edit) {
  // Removal edits have no inserted text; defaulting to '' keeps the inverse
  // splice lossless (never the string "undefined").
  return text.slice(0, edit.start) + (edit.inserted ?? '') + text.slice(edit.end);
}
