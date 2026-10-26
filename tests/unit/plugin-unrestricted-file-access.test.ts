import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Opt-in unrestricted file access (2.9.6). The setting is a deliberate security
// trade-off: it is off by default, it is mapped to the upstream variable in both
// plugins, and the launchers pass that variable only when it is explicitly on.
// The reference child environments below are the outputs of the 2.9.5 launchers
// (git 840f4c1, shared/core/launch*.mjs) for the same input, captured before the
// change: an absent, empty or "false" setting must reproduce them byte for byte.

interface PluginManifest {
  version: string;
  userConfig: Record<string, { type?: string; title?: string; default?: unknown; description?: string }>;
}

interface McpServer {
  env?: Record<string, string>;
}

interface LauncherModule {
  buildChildEnv(source: Record<string, string | undefined>, ...rest: never[]): Record<string, string>;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const VAR = 'PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS';
const SETTING = 'allow_unrestricted_file_access';

function readPlugin(plugin: string): PluginManifest {
  return JSON.parse(
    readFileSync(path.join(repoRoot, 'plugins', plugin, '.claude-plugin', 'plugin.json'), 'utf8'),
  ) as PluginManifest;
}

function readEnv(plugin: string): Record<string, string> {
  const servers = JSON.parse(
    readFileSync(path.join(repoRoot, 'plugins', plugin, '.mcp.json'), 'utf8'),
  ) as Record<string, McpServer>;
  return servers[plugin].env ?? {};
}

function envReferences(env: Record<string, string>): string[] {
  return [...JSON.stringify(env).matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
}

async function loadLauncher(file: string): Promise<LauncherModule> {
  return (await import(
    new URL(`../../plugins/cloakbrowser/${file}`, import.meta.url).href
  )) as LauncherModule;
}

const baseEnv: Record<string, string> = {
  CLAUDE_PLUGIN_DATA: 'D:/scratch/plugin-data',
  PLAYWRIGHT_MCP_HEADLESS: 'false',
  PLAYWRIGHT_MCP_USER_DATA_DIR: '',
  PLAYWRIGHT_MCP_OUTPUT_DIR: '',
  PATH: 'C:/Windows/System32',
};

describe('the setting is declared and documented as a security trade-off', () => {
  it.each(['cloakbrowser', 'camoufox'])('declares %s with default false', (pluginName) => {
    const plugin = readPlugin(pluginName);
    expect(plugin.userConfig[SETTING]).toMatchObject({
      type: 'boolean',
      title: 'Unrestricted file access',
      default: false,
    });
    const description = plugin.userConfig[SETTING].description ?? '';
    expect(description).toContain('any file your operating-system user can');
    expect(description).toContain('deliberate security trade-off');
    expect(description).toContain('prompt-injected page');
    expect(description).toContain('file://');
    expect(description).toContain('Leave this off');
  });

  it('maps the setting to the upstream variable exactly once in both plugins', () => {
    for (const pluginName of ['cloakbrowser', 'camoufox']) {
      const env = readEnv(pluginName);
      expect(env[VAR]).toBe(`\${user_config.${SETTING}}`);
      expect(envReferences(env).filter((ref) => ref === SETTING)).toHaveLength(1);
    }
  });

  it('keeps the userConfig and env-reference counts in step', () => {
    const cloakKeys = Object.keys(readPlugin('cloakbrowser').userConfig);
    expect(cloakKeys).toHaveLength(30);
    expect(envReferences(readEnv('cloakbrowser'))).toHaveLength(31);

    const camoufoxKeys = Object.keys(readPlugin('camoufox').userConfig);
    expect(camoufoxKeys).toHaveLength(19);
    expect(envReferences(readEnv('camoufox'))).toHaveLength(19);
  });

  it('documents the trade-off in both plugin READMEs', () => {
    for (const pluginName of ['cloakbrowser', 'camoufox']) {
      const readme = readFileSync(path.join(repoRoot, 'plugins', pluginName, 'README.md'), 'utf8');
      expect(readme).toContain('Unrestricted file access');
      expect(readme).toContain('deliberate security trade-off');
    }
  });
});

describe('engines that honour the variable and engines that ignore it', () => {
  function ignoredSettings(engine: string): string[] {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'plugins', 'cloakbrowser', 'engines', `${engine}.json`), 'utf8'),
    ) as { ignoredSettings?: string[] };
    return manifest.ignoredSettings ?? [];
  }

  it('reports the setting as ignored by camoufox-native, which has no file-path tools', () => {
    expect(ignoredSettings('camoufox-native')).toContain(SETTING);
  });

  it.each(['cloak', 'playwright', 'camoufox', 'kameleo'])('does not mark %s as ignoring it', (engine) => {
    expect(ignoredSettings(engine)).not.toContain(SETTING);
  });
});

describe('launcher child environment', () => {
  it('reproduces the 2.9.5 child environment when the setting is absent, empty or false', async () => {
    const launch = await loadLauncher('launch.mjs');
    const camoufox = await loadLauncher('launch-camoufox.mjs');
    const kameleo = await loadLauncher('launch-kameleo.mjs');
    const native = await loadLauncher('launch-camoufox-native.mjs');

    const reference: Record<string, Record<string, string>> = {
      launch: {
        CLAUDE_PLUGIN_DATA: 'D:/scratch/plugin-data',
        PLAYWRIGHT_MCP_HEADLESS: 'false',
        PATH: 'C:/Windows/System32',
      },
      camoufox: {
        CLAUDE_PLUGIN_DATA: 'D:/scratch/plugin-data',
        PLAYWRIGHT_MCP_HEADLESS: 'false',
        PATH: 'C:/Windows/System32',
        // 2.14.1 always writes the server-heartbeat deadline (0 = disabled):
        // the wrapper's own 5 s default must never apply by omission. Every
        // other key here is the 2.9.5 reference, unchanged.
        PLAYWRIGHT_MCP_PING_TIMEOUT_MS: '0',
      },
      kameleo: {
        CLAUDE_PLUGIN_DATA: 'D:/scratch/plugin-data',
        PATH: 'C:/Windows/System32',
        PLAYWRIGHT_MCP_CAPS: 'vision,pdf,devtools,storage,network,testing,config',
        PLAYWRIGHT_MCP_CDP_ENDPOINT: 'ws://127.0.0.1:5050/playwright/abc',
      },
      native: {
        CLAUDE_PLUGIN_DATA: 'D:/scratch/plugin-data',
        PLAYWRIGHT_MCP_HEADLESS: 'false',
        PLAYWRIGHT_MCP_USER_DATA_DIR: '',
        PLAYWRIGHT_MCP_OUTPUT_DIR: '',
        PATH: 'C:/Windows/System32',
        CAMOUFOX_PROFILE: 'acct-one',
        CAMOUFOX_DATA_DIR: path.join('D:/scratch/plugin-data', 'profiles', 'camoufox-native'),
        CAMOUFOX_DAEMON: 'false',
        CAMOUFOX_HEADLESS: 'false',
        CAMOUFOX_BROWSER_VERSION: '156.0.1-beta.39',
        CAMOUFOX_FINGERPRINT_OS: 'windows',
      },
    };

    const offValues = [undefined, '', 'false', '0', 'no', ' FALSE '];
    const cases: {
      name: string;
      run: (env: Record<string, string | undefined>) => Record<string, string>;
    }[] = [
      { name: 'launch', run: (env) => launch.buildChildEnv(env) },
      { name: 'camoufox', run: (env) => camoufox.buildChildEnv(env) },
      {
        name: 'kameleo',
        run: (env) =>
          (
            kameleo.buildChildEnv as unknown as (
              source: Record<string, string | undefined>,
              endpoint: string,
            ) => Record<string, string>
          )(
            { ...env, KAMELEO_PROFILE_ID: 'abc', KAMELEO_ENDPOINT: '' },
            'ws://127.0.0.1:5050/playwright/abc',
          ),
      },
      {
        name: 'native',
        run: (env) =>
          (
            native.buildChildEnv as unknown as (
              source: Record<string, string | undefined>,
              platform: string,
            ) => Record<string, string>
          )({ ...env, CAMOUFOX_PROFILE: 'acct-one' }, 'win32'),
      },
    ];

    for (const { name, run } of cases) {
      for (const value of offValues) {
        const env = value === undefined ? { ...baseEnv } : { ...baseEnv, [VAR]: value };
        const actual = run(env);
        expect(actual, `${name} with ${JSON.stringify(value)}`).toEqual(reference[name]);
        expect(Object.hasOwn(actual, VAR), `${name} must not pass ${VAR}`).toBe(false);
      }
    }
  });

  it('passes the upstream spelling when the setting is on', async () => {
    const launchers = await Promise.all(
      ['launch.mjs', 'launch-camoufox.mjs', 'launch-kameleo.mjs', 'launch-camoufox-native.mjs'].map(
        loadLauncher,
      ),
    );
    for (const launcher of launchers) {
      for (const value of ['true', '1', ' TRUE ']) {
        const env = launcher.buildChildEnv({ ...baseEnv, [VAR]: value });
        expect(env[VAR]).toBe('true');
      }
    }
  });
});
