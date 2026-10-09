import { describe, expect, it } from 'vitest';

interface Diagnostics {
  TEXT_LIMIT: number;
  PNG_LIMIT: number;
  ATTACHMENT_LIMIT: number;
  sanitizeDiagnostic: (input: unknown, secrets?: string[]) => string | Buffer;
  registerControlledScreenshot: (bytes: Buffer, url: string) => unknown;
}
const moduleUrl = new URL('../../scripts/lib/test-diagnostics.mjs', import.meta.url);
const diagnostics = (await import(moduleUrl.href)) as Diagnostics;
const { sanitizeDiagnostic, registerControlledScreenshot } = diagnostics;
// Synthetic one-pixel local fixture PNG; no browser or external screenshot.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=',
  'base64',
);

describe('safe test diagnostics', () => {
  it('redacts structured secrets and useful text before persistence', () => {
    const secrets = ['synthetic-known-secret'];
    const metadata = {
      status: 'failed',
      pid: 42,
      password: 'synthetic-password',
      apiKey: 'synthetic-key',
      headers: { Authorization: 'Bearer synthetic-bearer', Cookie: 'sid=synthetic-cookie' },
      message: 'navigation failed synthetic-known-secret https://user:synthetic-proxy@proxy.invalid',
      stack:
        'Error: token=synthetic-token\n at fixture:1\nws://localhost:9222/devtools/browser/synthetic-cdp',
    };
    const result = sanitizeDiagnostic(metadata, secrets);
    for (const secret of [
      'synthetic-password',
      'synthetic-key',
      'synthetic-bearer',
      'synthetic-cookie',
      'synthetic-proxy',
      'synthetic-token',
      'synthetic-known-secret',
      'synthetic-cdp',
    ]) {
      expect(result).not.toContain(secret);
    }
    expect(result).toContain('navigation failed');
    expect(result).toContain('fixture:1');
  });

  it('redacts mixed-case headers, quoted fields, encoded known secrets and CDP HTTP capabilities', () => {
    const input =
      'AUTHORIZATION: Basic synthetic-basic\nSet-Cookie: value=synthetic-session\n' +
      '"password": "synthetic-spaced password"\napi_key=synthetic-api\n' +
      'https://localhost:9222/cdp/synthetic-capability?token=synthetic-query\n' +
      'synthetic%20encoded';
    const output = sanitizeDiagnostic(input, ['synthetic encoded']);
    for (const value of [
      'synthetic-basic',
      'synthetic-session',
      'synthetic-spaced',
      'synthetic-api',
      'synthetic-capability',
      'synthetic-query',
      'synthetic%20encoded',
    ]) {
      expect(output).not.toContain(value);
    }
  });

  it('rejects environment dumps, circular values, unknown binary and oversized text', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const oversized = 'x'.repeat(diagnostics.TEXT_LIMIT + 1);
    const unknown = Buffer.from('unknown binary');
    for (const value of [{ env: { SECRET: 'synthetic' } }, circular, unknown, oversized]) {
      expect(() => sanitizeDiagnostic(value)).toThrow();
    }
  });

  it('accepts only registered controlled-local PNG and copies its bytes', () => {
    const registered = registerControlledScreenshot(png, 'http://127.0.0.1:1234/fixture');
    const output = sanitizeDiagnostic(registered);
    expect(Buffer.isBuffer(output)).toBe(true);
    expect(output).not.toBe(png);
    expect(output).toEqual(png);
    const forged = { bytes: png, provenance: 'controlled-local' };
    expect(() => sanitizeDiagnostic(forged)).toThrow();
  });

  it('rejects remote, credential-bearing, invalid and oversized screenshots', () => {
    const largeChunk = Buffer.alloc(diagnostics.PNG_LIMIT + 12);
    largeChunk.writeUInt32BE(diagnostics.PNG_LIMIT);
    largeChunk.write('IDAT', 4, 'ascii');
    const oversized = Buffer.concat([png.subarray(0, 33), largeChunk, png.subarray(png.length - 12)]);
    const bad = Buffer.from('not a PNG');
    for (const url of [
      'https://external.invalid',
      'http://user:password@localhost/fixture',
      'file:///tmp/image',
    ]) {
      expect(() => registerControlledScreenshot(png, url)).toThrow();
    }
    for (const bytes of [oversized, bad]) {
      expect(() => registerControlledScreenshot(bytes, 'http://localhost/fixture')).toThrow();
    }
  });

  it('redacts key fields and private-key blocks', () => {
    const input = {
      key: 'synthetic-key-field',
      proxyPassword: 'synthetic-proxy-field',
      clientSecret: 'synthetic-client-field',
      message: '-----BEGIN PRIVATE KEY-----\nsynthetic-private-material\n-----END PRIVATE KEY-----',
    };
    const output = sanitizeDiagnostic(input);
    for (const value of [
      'synthetic-key-field',
      'synthetic-proxy-field',
      'synthetic-client-field',
      'synthetic-private-material',
    ]) {
      expect(output).not.toContain(value);
    }
  });

  it('neutralizes HTML and rejects metadata-bearing PNGs', () => {
    const output = sanitizeDiagnostic('<script>alert(1)</script>');
    expect(output).not.toContain('<script>');
    const chunk = Buffer.alloc(12);
    chunk.write('tEXt', 4, 'ascii');
    const metadataPng = Buffer.concat([
      png.subarray(0, png.length - 12),
      chunk,
      png.subarray(png.length - 12),
    ]);
    expect(() => registerControlledScreenshot(metadataPng, 'http://localhost')).toThrow();
  });

  it('rejects accessor metadata without invoking user code', () => {
    let calls = 0;
    const metadata = {
      get message() {
        calls += 1;
        return 'unsafe getter';
      },
    };
    expect(() => sanitizeDiagnostic(metadata)).toThrow('Test evidence');
    expect(calls).toBe(0);
  });
});
