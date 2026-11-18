// Runtime shim written into <dataRoot>/bin. It reads current.json on every
// start, resolves the broker's two documents with the vendored module, applies
// the CLI's entry/project scopes above them and below the host environment,
// then spawns the bundled broker with stdio inherited.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SabmError } from './envelope.mjs';

const FALLBACK_MODULES = ['./vendor/lib/settings-precedence.mjs', '../vendor/lib/settings-precedence.mjs'];

async function precedenceModule() {
  let lastError;
  for (const relative of FALLBACK_MODULES) {
    try {
      return await import(new URL(relative, import.meta.url).href);
    } catch (error) {
      lastError = error;
    }
  }
  throw new SabmError(
    'refused',
    'vendor-missing',
    'The vendored settings-precedence module is missing.',
    'Reinstall this CLI.',
  );
}

export function parseShimArgs(argv) {
  const options = { harness: null, entry: null, project: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--harness' || flag === '--entry' || flag === '--project') {
      options[flag.slice(2)] = argv[index + 1] ?? null;
      index += 1;
    }
  }
  if (!options.harness || !options.entry) {
    throw new SabmError(
      'usage',
      'shim-args',
      'The shim needs --harness <id> and --entry <name>.',
      'Restart through the harness entry.',
    );
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readScopes(harnessDocument) {
  if (!harnessDocument) return null;
  try {
    return JSON.parse(await readFile(harnessDocument, 'utf8')).scopes ?? null;
  } catch {
    return null;
  }
}

export async function composeEnvironment({
  dataRoot,
  harness,
  entry,
  env = process.env,
  cwd = process.cwd(),
  log = () => {},
}) {
  const precedence = await precedenceModule();
  const root = resolve(dataRoot);
  let current;
  try {
    current = await readJson(join(root, 'current.json'));
  } catch (error) {
    throw new SabmError(
      'refused',
      'not-installed',
      `No usable current.json under ${root}: ${error?.code ?? 'invalid JSON'}.`,
      'Run `sabm install <harness>` first.',
    );
  }
  const engineDir = join(root, 'engine', current.pluginVersion);
  let manifest;
  let mcp;
  try {
    manifest = await readJson(join(engineDir, '.claude-plugin', 'plugin.json'));
    mcp = await readJson(join(engineDir, '.mcp.json'));
  } catch (error) {
    throw new SabmError(
      'refused',
      'engine-missing',
      `The bundled engine tree is incomplete under ${engineDir}.`,
      'Run `sabm update` to reinstall it.',
    );
  }
  const settingsLevel = precedence.resolveSettingsLevel(env, log);
  const documents = precedence.readSettingsDocuments({
    env,
    dataDir: root,
    harnessId: harness,
    settingsLevel: settingsLevel.value,
    log,
  });
  const layered = precedence.resolveLayeredSettings({
    env,
    documents: documents.documents,
    settingsLevel: settingsLevel.value,
    dataRootEnabled: documents.enabled,
    log,
  });
  const scopes = await readScopes(documents.documents?.harness?.path);
  const scopedValues = {
    entry: scopes?.entries?.[entry]?.settings ?? {},
    project: scopes?.projects?.[resolve(cwd)]?.settings ?? {},
  };
  const childEnv = { ...layered.env };
  for (const key of precedence.DOCUMENT_SETTINGS_KEYS) {
    const envName = precedence.SETTINGS_ENV_NAMES[key];
    if (!envName || !env) continue;
    const host = env[envName];
    const engineValue = key === 'ping_timeout_ms' ? env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS : undefined;
    if ((host !== undefined && String(host).trim() !== '') || engineValue !== undefined) continue;
    const scoped = scopedValues.project[key] ?? scopedValues.entry[key];
    if (typeof scoped !== 'string') continue;
    if (scoped === '') delete childEnv[envName];
    else childEnv[envName] = scoped;
  }
  const server = mcp[Object.keys(mcp)[0]] ?? {};
  for (const [name, raw] of Object.entries(server.env ?? {})) {
    const match = /^\$\{user_config\.([^}]+)\}$/.exec(String(raw));
    if (!match) {
      childEnv[name] = String(raw);
      continue;
    }
    const key = match[1];
    if (Object.hasOwn(childEnv, name)) continue;
    const definition = manifest.userConfig?.[key] ?? {};
    const fallback = definition.default ?? '';
    childEnv[name] = String(fallback);
  }
  childEnv.STEALTH_DATA_DIR = root;
  childEnv.STEALTH_HARNESS = harness;
  const brokerReport = documents.enabled
    ? precedence.settingsPrecedenceReport({}, { ...layered, documents: documents.documents, settingsLevel })
    : null;
  return {
    env: childEnv,
    current,
    engineDir,
    brokerPath: join(engineDir, 'broker.mjs'),
    precedence: brokerReport,
    precedenceNote: documents.enabled ? layered.note : null,
    scopedValues,
  };
}

export async function runShim(argv = process.argv.slice(2), io = {}) {
  const options = parseShimArgs(argv);
  const dataRoot = process.env.STEALTH_DATA_DIR ?? resolve(io.dataRoot ?? process.cwd());
  const composed = await composeEnvironment({
    dataRoot,
    harness: options.harness,
    entry: options.entry,
    env: process.env,
    cwd: options.project ?? process.cwd(),
  });
  const child = spawn(process.execPath, [composed.brokerPath], {
    env: composed.env,
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  return new Promise((resolveCode) => {
    child.on('error', (error) => {
      process.stderr.write(`sabm shim: ${error.message}\n`);
      resolveCode(3);
    });
    child.on('exit', (code, signal) => resolveCode(signal ? 3 : (code ?? 0)));
  });
}
