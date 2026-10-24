import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Manifest {
  schemaVersion: number;
  id: string;
  label: string;
  transport: string;
  contract: string;
  defaultToolProfile: string;
  launch?: { launcher?: string };
  requirements?: string[];
  ignoredSettings?: string[];
  toolSupport: Record<string, string>;
  toolSupportNotes?: Record<string, string>;
  notes: string;
}

interface ProfilesDocument {
  schemaVersion: number;
  profiles: { full: { kind: string }; portable: { kind: string; tools: string[] } };
}

interface RegistryModule {
  findPortableGaps(manifest: Manifest, profiles: ProfilesDocument): string[];
  manifestSupport(manifest: Manifest, toolName: string): string;
  portableToolNames(profiles: ProfilesDocument): string[];
  resolveLauncherName(manifest: Manifest | null): string;
  validateManifest(
    manifest: unknown,
    expectedId: string,
    profileNames: string[],
    launcherDir?: string,
  ): string | null;
}

const registry = (await import(
  new URL('../../plugins/cloakbrowser/engine-registry.mjs', import.meta.url).href
)) as unknown as RegistryModule;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginRoot = path.join(repoRoot, 'plugins', 'cloakbrowser');
const enginesDir = path.join(pluginRoot, 'engines');
const manifestPath = path.join(enginesDir, 'camoufox.json');
const profilesPath = path.join(enginesDir, 'profiles.json');
const mcpConfigPath = path.join(pluginRoot, '.mcp.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const profiles = JSON.parse(readFileSync(profilesPath, 'utf8')) as ProfilesDocument;
const profileNames = Object.keys(profiles.profiles).sort();
const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8')) as {
  cloakbrowser: { env: Record<string, string> };
};

// The four canonical tools camoufox-playwright-mcp 0.1.5 does not implement,
// plus browser_pdf_save, which it lists but cannot run on Firefox.
const UNAVAILABLE_TOOLS = [
  'browser_annotate',
  'browser_emulate_media',
  'browser_pdf_save',
  'browser_start_recording',
  'browser_stop_recording',
];

const IGNORED_SETTINGS = [
  'humanize',
  'human_preset',
  'release_channel',
  'geoip_proxy_match',
  'licence_key',
  'engine_version',
];

describe('camoufox engine manifest', () => {
  it('declares the identity, transport, contract and portable default', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.id).toBe('camoufox');
    expect(manifest.label.trim()).not.toBe('');
    expect(manifest.transport).toBe('launch');
    expect(manifest.contract).toBe('playwright-mcp');
    expect(manifest.defaultToolProfile).toBe('portable');
    expect(manifest.notes).toContain('camoufox-playwright-mcp');
  });

  it('passes the shared manifest validation, including the real launcher file', () => {
    expect(registry.validateManifest(manifest, 'camoufox', profileNames, pluginRoot)).toBeNull();
  });

  it('names the Camoufox launcher adapter and ships its files', () => {
    expect(registry.resolveLauncherName(manifest)).toBe('launch-camoufox.mjs');
    expect(existsSync(path.join(pluginRoot, 'launch-camoufox.mjs'))).toBe(true);
    expect(existsSync(path.join(pluginRoot, 'camoufox_bootstrap.py'))).toBe(true);
  });

  it('marks the five unavailable tools none with a reason each', () => {
    for (const toolName of UNAVAILABLE_TOOLS) {
      expect(registry.manifestSupport(manifest, toolName)).toBe('none');
      expect(manifest.toolSupportNotes?.[toolName]?.trim()).not.toBe('');
    }
    expect(registry.manifestSupport(manifest, 'browser_pdf_save')).toBe('none');
    const listedNone = Object.entries(manifest.toolSupport)
      .filter(([name, support]) => name !== '*' && support === 'none')
      .map(([name]) => name)
      .sort();
    expect(listedNone).toEqual(UNAVAILABLE_TOOLS);
  });

  it('marks browser_run_code_unsafe partial because it runs Python, not JavaScript', () => {
    expect(registry.manifestSupport(manifest, 'browser_run_code_unsafe')).toBe('partial');
    expect(manifest.toolSupportNotes?.browser_run_code_unsafe).toContain('Python');
    expect(manifest.toolSupportNotes?.browser_run_code_unsafe).toContain('not JavaScript');
  });

  it('keeps every other tool full through the "*" rule', () => {
    expect(manifest.toolSupport['*']).toBe('full');
    expect(registry.manifestSupport(manifest, 'browser_navigate')).toBe('full');
    expect(registry.manifestSupport(manifest, 'browser_evaluate')).toBe('full');
  });

  it('exposes every portable tool (no portable gaps)', () => {
    expect(registry.findPortableGaps(manifest, profiles)).toEqual([]);
    expect(registry.portableToolNames(profiles)).toHaveLength(24);
    for (const toolName of registry.portableToolNames(profiles)) {
      expect(registry.manifestSupport(manifest, toolName)).toBe('full');
      expect(UNAVAILABLE_TOOLS).not.toContain(toolName);
    }
  });

  it('declares the dependencies the launcher auto-provisions', () => {
    const requirements = (manifest.requirements ?? []).join(' ');
    expect(requirements).toContain('uv (pinned 0.13.5)');
    expect(requirements).toContain('Plugin-managed CPython 3.13.17');
    expect(requirements).toContain('camoufox-playwright-mcp==0.1.5');
    expect(requirements).toContain('v156.0.1-beta.39');
    expect(requirements).toContain('SHA-256');
    expect(requirements).toContain('UV_PYTHON or PYTHON override');
  });

  it('names the settings the Camoufox engine cannot honour', () => {
    expect(manifest.ignoredSettings).toEqual(IGNORED_SETTINGS);
  });

  it('pins the wrapper package and the browser build in .mcp.json', () => {
    const env = mcpConfig.cloakbrowser.env;
    expect(env.CAMOUFOX_MCP_PACKAGE).toMatch(/^camoufox-playwright-mcp==0\.1\.5$/);
    expect(env.CAMOUFOX_BROWSER_BUILD).toMatch(/^v\d+\.\d+\.\d+-beta\.\d+$/);
    expect(manifest.requirements?.join(' ')).toContain(env.CAMOUFOX_MCP_PACKAGE);
    expect(manifest.requirements?.join(' ')).toContain(env.CAMOUFOX_BROWSER_BUILD);
  });
});
