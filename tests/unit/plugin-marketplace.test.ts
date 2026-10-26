import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface MarketplaceEntry {
  name: string;
  description?: string;
  author?: { name?: string };
  category?: string;
  keywords?: string[];
  source: string;
  version?: string;
}

interface Marketplace {
  name: string;
  description?: string;
  owner?: { name?: string };
  plugins: MarketplaceEntry[];
}

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  userConfig: Record<string, { type?: string; default?: unknown; options?: string[] }>;
}

interface McpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

type McpConfig = Record<string, McpServer>;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const marketplacePath = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8')) as Marketplace;

function pluginRoot(name: string): string {
  return path.join(repoRoot, 'plugins', name);
}

function readPlugin(name: string): PluginManifest {
  return JSON.parse(
    readFileSync(path.join(pluginRoot(name), '.claude-plugin', 'plugin.json'), 'utf8'),
  ) as PluginManifest;
}

function readMcp(name: string): McpConfig {
  return JSON.parse(readFileSync(path.join(pluginRoot(name), '.mcp.json'), 'utf8')) as McpConfig;
}

function configReferences(env: Record<string, string>): string[] {
  const text = JSON.stringify(env);
  return [...text.matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
}

function pluginDirectories(): string[] {
  return readdirSync(path.join(repoRoot, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const CLOAKBROWSER_ENTRY: MarketplaceEntry = {
  name: 'cloakbrowser',
  description:
    'CloakBrowser stealth Chromium with the full Playwright MCP tool surface (72 browser_* tools), via cloakbrowser-mcp.',
  author: { name: 'FiredMosquito831' },
  category: 'automation',
  keywords: ['browser', 'mcp', 'playwright', 'stealth', 'cloakbrowser', 'automation'],
  source: './plugins/cloakbrowser',
};

const CLOAKBROWSER_SETTINGS = [
  'headless',
  'browser_engine',
  'tool_profile',
  'camoufox_profile',
  'camoufox_data_dir',
  'kameleo_profile_id',
  'kameleo_endpoint',
  'tools_vision',
  'tools_pdf',
  'tools_devtools',
  'tools_storage',
  'tools_network',
  'tools_testing',
  'tools_config',
  'disabled_tools',
  'humanize',
  'human_preset',
  'release_channel',
  'geoip_proxy_match',
  'profile_isolation',
  'identity_mode',
  'account',
  'profile_dir',
  'proxy_server',
  'proxy_bypass',
  'licence_key',
  'engine_version',
  'output_dir',
  'allow_unrestricted_file_access',
].sort();

const CAMOUFOX_SETTINGS = [
  'headless',
  'tool_profile',
  'tools_vision',
  'tools_pdf',
  'tools_devtools',
  'tools_storage',
  'tools_network',
  'tools_testing',
  'tools_config',
  'disabled_tools',
  'profile_isolation',
  'identity_mode',
  'account',
  'profile_dir',
  'proxy_server',
  'proxy_bypass',
  'output_dir',
  'allow_unrestricted_file_access',
].sort();

describe('marketplace integrity', () => {
  it('keeps the marketplace identity and the universal plugin entry unchanged', () => {
    expect(marketplace.name).toBe('cloakbrowser-mcp');
    expect(marketplace.owner).toEqual({ name: 'FiredMosquito831' });
    const universal = marketplace.plugins.find((entry) => entry.name === 'cloakbrowser');
    expect(universal).toEqual(CLOAKBROWSER_ENTRY);
  });

  it('lists exactly the shipped plugins, with no Kameleo entry', () => {
    expect(marketplace.plugins.map((entry) => entry.name)).toEqual(['cloakbrowser', 'camoufox']);
    expect(marketplace.plugins.some((entry) => entry.name === 'kameleo')).toBe(false);
    expect(existsSync(path.join(repoRoot, 'plugins', 'kameleo'))).toBe(false);
  });

  it('has unique names, existing sources and matching plugin manifests', () => {
    const names = marketplace.plugins.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of marketplace.plugins) {
      const source = path.resolve(repoRoot, entry.source);
      expect(existsSync(source)).toBe(true);
      expect(path.basename(source)).toBe(entry.name);
      expect(readPlugin(entry.name).name).toBe(entry.name);
      expect(Object.hasOwn(entry, 'version')).toBe(false);
    }
  });

  it('gives every plugin its own MCP server key', () => {
    const serverKeys = marketplace.plugins.map((entry) => {
      const servers = readMcp(entry.name);
      const keys = Object.keys(servers);
      expect(keys).toEqual([entry.name]);
      expect(servers[entry.name].command).toBe('node');
      expect(servers[entry.name].args).toEqual(['${CLAUDE_PLUGIN_ROOT}/broker.mjs']);
      return keys[0];
    });
    expect(new Set(serverKeys).size).toBe(serverKeys.length);
  });

  it('pins each plugin to its engine', () => {
    const universal = readMcp('cloakbrowser').cloakbrowser.env ?? {};
    expect(universal.STEALTH_ENGINE).toBe('${user_config.browser_engine}');
    expect(universal.PLAYWRIGHT_MCP_BROWSER_ENGINE).toBe('${user_config.browser_engine}');

    const engine = readMcp('camoufox').camoufox.env ?? {};
    expect(engine.STEALTH_ENGINE).toBe('camoufox');
    expect(engine.CAMOUFOX_MCP_PACKAGE).toBe('camoufox-playwright-mcp==0.1.5');
    expect(engine.CAMOUFOX_BROWSER_BUILD).toBe('v156.0.1-beta.39');
    expect(Object.hasOwn(engine, 'STEALTH_ENGINES')).toBe(false);
  });

  it('maps every userConfig key to exactly one env reference and nothing else', () => {
    for (const entry of marketplace.plugins) {
      const plugin = readPlugin(entry.name);
      const env = readMcp(entry.name)[entry.name].env ?? {};
      const keys = Object.keys(plugin.userConfig).sort();
      const refs = configReferences(env).sort();
      const counts = new Map<string, number>();
      for (const ref of refs) {
        counts.set(ref, (counts.get(ref) ?? 0) + 1);
      }
      expect([...counts.keys()].sort()).toEqual(keys);
      for (const [key, count] of counts) {
        // The universal plugin passes browser_engine twice on purpose: the
        // canonical STEALTH_ENGINE plus the legacy PLAYWRIGHT_MCP_BROWSER_ENGINE.
        const allowed = entry.name === 'cloakbrowser' && key === 'browser_engine' ? 2 : 1;
        expect(count).toBe(allowed);
      }
    }
  });

  it('keeps the universal plugin settings unchanged', () => {
    const plugin = readPlugin('cloakbrowser');
    expect(Object.keys(plugin.userConfig).sort()).toEqual(CLOAKBROWSER_SETTINGS);
    expect(plugin.userConfig.browser_engine.options).toEqual([
      'camoufox-native',
      'camoufox',
      'cloak',
      'kameleo',
      'playwright',
    ]);
    expect(plugin.userConfig.browser_engine.default).toBe('cloak');
    expect(plugin.userConfig.tool_profile.default).toBe('default');
    expect(plugin.userConfig.headless.default).toBe(false);
    for (const name of [
      'tools_vision',
      'tools_pdf',
      'tools_devtools',
      'tools_storage',
      'tools_network',
      'tools_testing',
      'tools_config',
    ]) {
      expect(plugin.userConfig[name].default).toBe(true);
    }
  });

  it('declares only the settings the Camoufox engine honours', () => {
    const plugin = readPlugin('camoufox');
    expect(Object.keys(plugin.userConfig).sort()).toEqual(CAMOUFOX_SETTINGS);
    for (const forbidden of [
      'browser_engine',
      'licence_key',
      'engine_version',
      'humanize',
      'human_preset',
      'release_channel',
      'geoip_proxy_match',
      'camoufox_profile',
      'camoufox_data_dir',
      'kameleo_profile_id',
      'kameleo_endpoint',
    ]) {
      expect(Object.hasOwn(plugin.userConfig, forbidden)).toBe(false);
    }
    expect(plugin.userConfig.tool_profile.options).toEqual(['default', 'portable', 'full']);
    expect(plugin.userConfig.tool_profile.default).toBe('default');
  });

  it('ships only the Camoufox engine manifest plus the shared profiles document', () => {
    const config = JSON.parse(
      readFileSync(path.join(pluginRoot('camoufox'), 'plugin-config.json'), 'utf8'),
    ) as { core: boolean; engines: string[] };
    expect(config).toEqual({ core: true, engines: ['camoufox'] });
    const engineFiles = readdirSync(path.join(pluginRoot('camoufox'), 'engines')).sort();
    expect(engineFiles).toEqual(['camoufox.json', 'profiles.json']);
    expect(pluginDirectories()).toEqual(['camoufox', 'cloakbrowser']);
  });
});
