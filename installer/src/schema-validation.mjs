// Value validation shared by install --config, configure --set and
// --values-stdin. Nothing is written here: invalid values are refused while
// the user is present (USER DECISION Q10).
import { SabmError } from './envelope.mjs';
import { DOCUMENT_SETTINGS_KEYS } from '../vendor/lib/settings-precedence.mjs';

const BOOLEANS = new Map([
  ['true', 'true'],
  ['false', 'false'],
  ['1', 'true'],
  ['0', 'false'],
  ['yes', 'true'],
  ['no', 'false'],
  ['on', 'true'],
  ['off', 'false'],
]);

function refused(key, value, reason, remedy) {
  throw new SabmError(
    'refused',
    'invalid-value',
    `"${key}" ${reason} (got ${JSON.stringify(String(value))}); nothing was written.`,
    remedy,
  );
}

export function parseKeyValue(input) {
  const at = String(input).indexOf('=');
  if (at <= 0) {
    throw new SabmError(
      'usage',
      'invalid-key-value',
      `Expected key=value, got ${JSON.stringify(String(input))}.`,
      'Use --set key=value or --config key=value.',
    );
  }
  return { key: String(input).slice(0, at).trim(), value: String(input).slice(at + 1) };
}

export function validateSettingValue(schema, key, raw) {
  if (!DOCUMENT_SETTINGS_KEYS.includes(key)) {
    throw new SabmError(
      'refused',
      'session-only-key',
      `"${key}" is session-only or unknown, so it cannot be stored in a broker settings document.`,
      `Document-settable keys: ${DOCUMENT_SETTINGS_KEYS.join(', ')}.`,
    );
  }
  const definition = schema.settings.find((setting) => setting.key === key);
  if (!definition) refused(key, raw, 'is not in the bundled schema', 'Use a documented settings key.');
  const value = String(raw);
  if (/\r|\n/.test(value)) refused(key, raw, 'must be one line', 'Remove the newline.');
  if (definition.type === 'boolean') {
    if (!BOOLEANS.has(value.toLowerCase())) {
      refused(key, raw, 'must be a boolean', 'Use true or false.');
    }
    return { key, value: BOOLEANS.get(value.toLowerCase()) };
  }
  if (definition.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || !/^\d+(?:\.\d+)?$/.test(value)) {
      refused(key, raw, 'must be a non-negative number', 'Use a finite number >= 0.');
    }
    return { key, value: String(number) };
  }
  if (definition.options?.length > 0 && !definition.options.includes(value)) {
    refused(key, raw, 'is not a documented choice', `Use one of: ${definition.options.join(', ')}.`);
  }
  return { key, value };
}

export function validateAll(schema, pairs) {
  return pairs.map((pair) => validateSettingValue(schema, pair.key, pair.value));
}
