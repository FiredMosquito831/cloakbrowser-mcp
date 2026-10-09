export const TEXT_LIMIT = 128 * 1024;
export const PNG_LIMIT = 2 * 1024 * 1024;
export const ATTACHMENT_LIMIT = 6 * 1024 * 1024;
const screenshots = new WeakMap();
const secretKey = /(?:authorization|cookie|password|passwd|secret|token|key)$/i;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function reject() {
  throw new Error('Test evidence: unsafe or oversized diagnostic');
}

/** Validate controlled PNG content without reading files or preserving metadata chunks. */
export function validateControlledPng(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > PNG_LIMIT ||
    bytes.length < 45 ||
    !bytes.subarray(0, 8).equals(pngSignature)
  )
    reject();
  let offset = 8;
  let imageData = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (
      offset + length + 12 > bytes.length ||
      !['IHDR', 'IDAT', 'IEND', 'PLTE', 'tRNS', 'sRGB', 'gAMA', 'pHYs'].includes(type)
    )
      reject();
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) reject();
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width * height > 4 * 1024 * 1024) reject();
    } else if (type === 'IHDR') reject();
    if (type === 'IDAT') imageData = true;
    offset += length + 12;
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length) reject();
      ended = true;
      break;
    }
  }
  if (!imageData || !ended) reject();
  return Buffer.from(bytes);
}

/** Register bytes captured from an owned local fixture, never an arbitrary image path. */
export function registerControlledScreenshot(bytes, fixtureUrl) {
  let url;
  try {
    url = new URL(fixtureUrl);
  } catch {
    reject();
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    reject();
  const safe = validateControlledPng(bytes);
  const receipt = Object.freeze({ provenance: 'controlled-local' });
  screenshots.set(receipt, safe);
  return receipt;
}

function redactText(text, secrets) {
  let safe = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || !secret || secret.length > TEXT_LIMIT) reject();
    for (const form of [secret, encodeURIComponent(secret), encodeURI(secret)]) {
      safe = safe.replaceAll(form, '[REDACTED]');
    }
  }
  safe = safe
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(
      /\b(?:authorization|proxy-authorization|set-cookie|cookie)\s*:\s*[^\r\n]+/gi,
      '[REDACTED HEADER]',
    )
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, '[REDACTED AUTH]')
    .replace(
      /(["']?(?:password|passwd|secret|token|access[-_]?token|api[-_]?key|license[-_]?key)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&<>]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:https?|socks5h?):\/\/[^\s/@]+@/gi, '[REDACTED PROXY]@')
    .replace(
      /\b(?:wss?:\/\/[^\s"'<>]+|https?:\/\/[^\s"'<>]*\/(?:cdp|devtools)[^\s"'<>]*)/gi,
      '[REDACTED CDP]',
    )
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return safe;
}

/** Redact bounded text/metadata or return a copy of registered local PNG bytes. */
export function sanitizeDiagnostic(input, secrets = []) {
  if (!Array.isArray(secrets) || secrets.length > 256) reject();
  if (input && typeof input === 'object' && screenshots.has(input)) {
    return Buffer.from(screenshots.get(input));
  }
  const seen = new WeakSet();
  let fields = 0;
  function visit(value, depth) {
    if (depth > 8 || ++fields > 256) reject();
    if (typeof value === 'string') {
      if (Buffer.byteLength(value) > TEXT_LIMIT) reject();
      return redactText(value, secrets);
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
      return value;
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || seen.has(value)) reject();
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) reject();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) reject();
    const entries = Object.entries(value);
    const result = Object.create(null);
    for (const [key, item] of entries) {
      if (/^(?:env|environment|processEnv)$/i.test(key) || key === '__proto__') reject();
      const safeKey = redactText(key, secrets);
      result[safeKey] = secretKey.test(key) ? '[REDACTED]' : visit(item, depth + 1);
    }
    return result;
  }
  const value = visit(input, 0);
  const output = typeof value === 'string' ? value : JSON.stringify(value);
  if (Buffer.byteLength(output) > TEXT_LIMIT) reject();
  return output;
}
