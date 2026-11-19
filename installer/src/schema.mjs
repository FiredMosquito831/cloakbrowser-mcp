import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { redact, SabmError } from './envelope.mjs';
import { DOCUMENT_SETTINGS_KEYS } from '../vendor/lib/settings-precedence.mjs';

const DEFAULT_FROM = fileURLToPath(new URL('../../plugins/cloakbrowser', import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLACEHOLDER = /^\$\{user_config\.([^}]+)\}$/;

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new SabmError(
      'refused',
      'config-not-found',
      `Cannot read schema file ${path}: ${error?.code ?? 'invalid JSON'}.`,
      'Run this reporter from a checkout or pass --from <dir> pointing at a cloakbrowser plugin tree.',
    );
  }
}

export async function loadSchema(options = {}, context) {
  let from = options.from ? resolve(context.cwd, options.from) : resolve(context.cwd, DEFAULT_FROM);
  try {
    await readFile(join(from, '.claude-plugin', 'plugin.json'));
  } catch (error) {
    if (options.from) {
      throw new SabmError(
        'refused',
        'config-not-found',
        `Cannot read schema file ${join(from, '.claude-plugin', 'plugin.json')}: ${error?.code ?? 'invalid JSON'}.`,
        'Run this reporter from a checkout or pass --from <dir> pointing at a cloakbrowser plugin tree.',
      );
    }
    if (error?.code !== 'ENOENT') throw error;
    const bundle = JSON.parse(await readFile(join(PACKAGE_ROOT, 'dist', 'bundle.json'), 'utf8'));
    from = join(PACKAGE_ROOT, 'dist', 'engine', bundle.pluginVersion);
  }
  const manifest = await readJson(join(from, '.claude-plugin', 'plugin.json'));
  const mcp = await readJson(join(from, '.mcp.json'));
  const server = mcp.cloakbrowser ?? Object.values(mcp)[0] ?? {};
  const envByName = new Map();
  const fixed = [];
  for (const [name, value] of Object.entries(server.env ?? {})) {
    const match = PLACEHOLDER.exec(String(value));
    if (match) {
      const key = match[1];
      envByName.set(key, [...(envByName.get(key) ?? []), name]);
    } else {
      fixed.push({ name, value });
    }
  }
  const settings = Object.entries(manifest.userConfig ?? {}).map(([key, definition]) => ({
    key,
    type: definition.type,
    default: definition.default ?? '',
    options: definition.options ?? [],
    sensitive: Boolean(definition.sensitive) || ['licence_key', 'proxy_server'].includes(key),
    env: envByName.get(key) ?? [],
    title: definition.title ?? key,
  }));
  return {
    from,
    pluginVersion: manifest.version,
    settings,
    fixed,
    unmappedEnv: [...envByName.keys()].filter((key) => !settings.some((setting) => setting.key === key)),
  };
}

export function effectiveSettings(schema, context) {
  return schema.settings.map((setting) => {
    let value = setting.default;
    let source = 'plugin.json';
    for (const name of setting.env) {
      if (context.env[name] !== undefined) {
        value = context.env[name];
        source = `host environment (${name})`;
        break;
      }
    }
    return {
      key: setting.key,
      value: setting.sensitive ? redact(setting.key, value) : value,
      source,
      note: setting.sensitive ? 'redacted; never printed' : 'default',
      type: setting.type,
      options: setting.options,
    };
  });
}
