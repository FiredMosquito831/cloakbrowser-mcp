export const SCHEMA = 'sabm/1';

export const EXIT_CODES = Object.freeze({
  usage: 1,
  refused: 2,
  verification_failed: 3,
});

const SECRET_KEYS = new Set(['licence_key', 'proxy_server']);
const SECRET_ENV = new Set(['CLOAKBROWSER_LICENSE_KEY', 'PLAYWRIGHT_MCP_PROXY_SERVER']);

export class SabmError extends Error {
  constructor(code, kind, message, remedy) {
    super(message);
    this.name = 'SabmError';
    this.code = code;
    this.kind = kind;
    this.remedy = remedy;
  }
}

export function isSecretKey(key) {
  return SECRET_KEYS.has(key) || SECRET_ENV.has(key);
}

export function redact(key, value) {
  if (!isSecretKey(key)) return value;
  return value === undefined || value === null || value === '' ? '(unset)' : 'configured: true';
}

export function success(command, extra = {}) {
  // Writes are opt-in: read-only commands and dry runs leave the default [].
  // Writing commands pass their real write records through.
  return { schema: SCHEMA, ok: true, command, writes: [], ...extra };
}

export function failure({ command = 'cli', code, kind, message, remedy, ...extra }) {
  if (!(code in EXIT_CODES)) throw new Error(`unknown error code: ${code}`);
  return {
    schema: SCHEMA,
    ok: false,
    command,
    error: { code, kind, message, remedy },
    ...extra,
    writes: [],
  };
}

export function errorEnvelope(error, command = 'cli') {
  if (error instanceof SabmError || (error && error.code in EXIT_CODES)) {
    return failure({
      command,
      code: error.code,
      kind: error.kind ?? 'command-error',
      message: error.message,
      remedy: error.remedy ?? 'Check the command and try again.',
    });
  }
  return failure({
    command,
    code: 'usage',
    kind: 'internal-error',
    message: error instanceof Error ? error.message : String(error),
    remedy: 'Check the command line and try again; report this message if it persists.',
  });
}

export function exitCodeFor(envelope) {
  return envelope.ok ? 0 : (EXIT_CODES[envelope.error.code] ?? 1);
}

export function printJsonLine(io, value) {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}
