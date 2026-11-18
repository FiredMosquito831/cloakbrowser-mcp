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

export function insertJsonProperty(text, objectSpan, key, valueText, indent) {
  const properties = jsonProperties(text, objectSpan);
  const existing = properties.find((property) => property.key === key);
  // Replace only the value span: the existing quoted key and its indentation
  // are part of the user's file and must survive the edit.
  if (existing) {
    return { start: existing.valueStart, end: existing.valueEnd, inserted: valueText, action: 'replace' };
  }
  const last = properties.at(-1);
  // Insert AFTER an existing trailing comma, not before it: the comma belongs
  // to the previous property and must stay with it for add/remove byte equality.
  const at = last ? (last.commaAfter === null ? last.valueEnd : last.commaAfter + 1) : objectSpan.innerStart;
  const prefix = last && last.commaAfter === null ? ',' : '';
  const inserted = `${prefix}\n${indent}${JSON.stringify(key)}: ${valueText}`;
  return { start: at, end: at, inserted, action: 'insert' };
}

export function removeJsonProperty(text, objectSpan, key, format = 'json') {
  const properties = jsonProperties(text, objectSpan);
  const property = properties.find((item) => item.key === key);
  if (!property) return null;
  const index = properties.indexOf(property);
  const previous = properties[index - 1];
  const candidates = [];
  if (property.commaAfter !== null) {
    candidates.push({ start: property.start, end: property.commaAfter + 1 });
  }
  if (previous) {
    if (previous.commaAfter !== null) {
      // Keep a pre-existing trailing comma (JSONC corpus); remove our property.
      candidates.push({ start: previous.commaAfter + 1, end: property.valueEnd });
    }
    // Drop a comma we inserted immediately after the previous value (strict
    // JSON corpus). Both candidates are tried against the real parser.
    candidates.push({ start: previous.valueEnd, end: property.valueEnd });
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

export function spliceText(text, edit) {
  // Removal edits have no inserted text; defaulting to '' keeps the inverse
  // splice lossless (never the string "undefined").
  return text.slice(0, edit.start) + (edit.inserted ?? '') + text.slice(edit.end);
}
