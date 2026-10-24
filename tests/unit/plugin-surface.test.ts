import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface AliasEntry {
  canonical: string;
  native?: string;
  support: string;
  dispatch?: Record<string, string>;
  args?: Record<string, string>;
  ignore?: string[];
  reject?: string[];
  transform?: string;
  send?: Record<string, string[]>;
  required?: Record<string, string[]>;
  [key: string]: unknown;
}

interface NativeManifest {
  schemaVersion: number;
  id: string;
  contract: string;
  defaultToolProfile: string;
  contractSchemas: string;
  nativePrefix: string;
  profileArgument: {
    name: string;
    env?: string;
    setting?: string;
    default?: string;
    except?: string[];
  };
  toolAliases: AliasEntry[];
  toolSupport: Record<string, string>;
  [key: string]: unknown;
}

interface ContractDocument {
  schemaVersion: number;
  tools: Record<string, { description: string; inputSchema: Record<string, unknown> }>;
}

interface ProfilesDocument {
  schemaVersion: number;
  profiles: { full: { kind: string }; portable: { kind: string; tools: string[] } };
}

interface BackendTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface SurfaceResult {
  error: string | null;
  tools: { name: string }[];
  exposedNames: Set<string>;
  exposedSupport: Map<string, string>;
  canonicalNames: Set<string>;
  prefixedNames: Set<string>;
  backendNatives: Set<string>;
  hiddenByProfile: string[];
  hiddenByManifest: string[];
  hiddenByCollision: string[];
  counts: { backend: number; canonical: number; nativeOnly: number };
}

interface CallResult {
  native?: string;
  arguments?: Record<string, unknown>;
  error?: string;
}

interface SurfaceModule {
  aliasSummary(manifest: NativeManifest): unknown[];
  buildNativeSurface(options: {
    manifest: NativeManifest;
    contracts: Record<string, unknown> | null;
    backendTools: BackendTool[];
    toolProfile: string;
    profiles: ProfilesDocument;
    disabled: Set<string>;
  }): SurfaceResult;
  classifyExposedTool(
    index: unknown,
    manifest: NativeManifest,
    name: string,
  ): { kind: string; support?: string; native?: string };
  createAliasIndex(manifest: NativeManifest): {
    error: string | null;
    byCanonical: Map<string, AliasEntry>;
    byNative: Map<string, AliasEntry[]>;
    consumedNatives: Set<string>;
  };
  isNativeContract(manifest: { contract?: string }): boolean;
  projectCanonicalSchema(schema: Record<string, unknown>, alias: AliasEntry): Record<string, unknown>;
  resolveNativeCall(options: {
    manifest: NativeManifest;
    contracts: Record<string, unknown> | null;
    surface: SurfaceResult | null;
    exposedName: string;
    args: unknown;
    profileValue: string | null;
  }): CallResult;
}

interface RegistryModule {
  availableProfileNames(profiles: ProfilesDocument): string[];
  validateManifest(
    manifest: unknown,
    expectedId: string,
    profileNames: string[],
    launcherDir?: string,
  ): string | null;
}

const surface = (await import(
  new URL('../../plugins/cloakbrowser/lib/surface.mjs', import.meta.url).href
)) as unknown as SurfaceModule;
const registry = (await import(
  new URL('../../plugins/cloakbrowser/engine-registry.mjs', import.meta.url).href
)) as unknown as RegistryModule;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginRoot = path.join(repoRoot, 'plugins', 'cloakbrowser');
const manifestPath = path.join(pluginRoot, 'engines', 'camoufox-native.json');
const profilesPath = path.join(pluginRoot, 'engines', 'profiles.json');
const contractsPath = path.join(pluginRoot, 'contracts', 'playwright-canonical.json');
const brokerPath = path.join(pluginRoot, 'broker.mjs');
const surfacePath = path.join(pluginRoot, 'lib', 'surface.mjs');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as NativeManifest;
const profiles = JSON.parse(readFileSync(profilesPath, 'utf8')) as ProfilesDocument;
const contracts = (JSON.parse(readFileSync(contractsPath, 'utf8')) as ContractDocument).tools;
const profileNames = registry.availableProfileNames(profiles);

// The 27 tools PyPI mcp-camoufox 0.4.5 registers, one module each.
const NATIVE_TOOLS = [
  'click',
  'click_at',
  'close_page',
  'close_session',
  'evaluate',
  'fill',
  'fill_form',
  'find',
  'get_element',
  'get_html',
  'get_network_request',
  'go_back',
  'handle_dialog',
  'list_console_messages',
  'list_network_requests',
  'list_pages',
  'list_sessions',
  'navigate',
  'new_page',
  'press_key',
  'reload',
  'screenshot',
  'scroll',
  'select_page',
  'snapshot',
  'upload_file',
  'wait_for',
];

const ALIASED_NATIVES = [
  'navigate',
  'go_back',
  'snapshot',
  'click',
  'fill',
  'fill_form',
  'press_key',
  'find',
  'evaluate',
  'screenshot',
  'list_pages',
  'new_page',
  'close_page',
  'select_page',
  'list_network_requests',
  'list_console_messages',
  'handle_dialog',
  'close_session',
];

const NATIVE_ONLY = [
  'get_element',
  'get_html',
  'get_network_request',
  'scroll',
  'upload_file',
  'wait_for',
  'click_at',
  'reload',
  'list_sessions',
];

const ABSENT_CANONICAL = [
  'browser_cookie_clear',
  'browser_cookie_delete',
  'browser_cookie_get',
  'browser_cookie_list',
  'browser_cookie_set',
  'browser_drag',
  'browser_file_upload',
  'browser_hover',
  'browser_network_request',
  'browser_wait_for',
];

const CANONICAL_TOOLS = [
  'browser_click',
  'browser_close',
  'browser_console_messages',
  'browser_evaluate',
  'browser_fill_form',
  'browser_find',
  'browser_handle_dialog',
  'browser_navigate',
  'browser_navigate_back',
  'browser_network_requests',
  'browser_press_key',
  'browser_select_option',
  'browser_snapshot',
  'browser_tabs',
  'browser_take_screenshot',
  'browser_type',
];

function backendTools(names: string[] = NATIVE_TOOLS): BackendTool[] {
  return names.map((name) => ({
    name,
    description: `native ${name}`,
    inputSchema: { type: 'object', properties: { profile: { type: 'string' } } },
  }));
}

function build(profile: string, names: string[] = NATIVE_TOOLS, disabled = new Set<string>()): SurfaceResult {
  return surface.buildNativeSurface({
    manifest,
    contracts,
    backendTools: backendTools(names),
    toolProfile: profile,
    profiles,
    disabled,
  });
}

function classify(args: Record<string, unknown>, exposedName = 'browser_click'): CallResult {
  return surface.resolveNativeCall({
    manifest,
    contracts,
    surface: null,
    exposedName,
    args,
    profileValue: 'acct-one',
  });
}

describe('native alias classification', () => {
  it('classifies all 27 native tools exactly once', () => {
    const aliased = new Set<string>();
    for (const alias of manifest.toolAliases) {
      if (typeof alias.native === 'string') {
        aliased.add(alias.native);
      }
      for (const native of Object.values(alias.dispatch ?? {})) {
        aliased.add(native);
      }
    }
    expect([...aliased].sort()).toEqual([...ALIASED_NATIVES].sort());
    expect(Object.keys(manifest.toolSupport).sort()).toEqual([...NATIVE_ONLY, ...ABSENT_CANONICAL].sort());
    const classified = new Set([...aliased, ...NATIVE_ONLY]);
    expect([...classified].sort()).toEqual([...NATIVE_TOOLS].sort());
    for (const native of NATIVE_ONLY) {
      expect(aliased.has(native)).toBe(false);
      expect(manifest.toolSupport[native]).toBe('full');
    }
    for (const canonical of ABSENT_CANONICAL) {
      expect(manifest.toolSupport[canonical]).toBe('none');
    }
  });

  it('produces 16 canonical and 9 prefixed tools at full', () => {
    const built = build('full');
    expect(built.error).toBeNull();
    expect(built.tools).toHaveLength(25);
    expect(built.tools.map((tool) => tool.name)).toEqual(
      [...CANONICAL_TOOLS, ...NATIVE_ONLY.map((name) => `camoufox_native_${name}`)].sort(),
    );
    expect([...built.canonicalNames].sort()).toEqual([...CANONICAL_TOOLS].sort());
    expect([...built.prefixedNames]).toHaveLength(9);
    expect(built.counts).toEqual({ backend: 27, canonical: 16, nativeOnly: 9 });
    expect(built.hiddenByProfile).toEqual([]);
    expect(built.hiddenByManifest).toEqual([]);
  });

  it('produces the 14 available canonical tools at portable and records the rest', () => {
    const built = build('portable');
    expect(built.error).toBeNull();
    expect(built.tools.map((tool) => tool.name)).toEqual([
      'browser_click',
      'browser_close',
      'browser_console_messages',
      'browser_evaluate',
      'browser_handle_dialog',
      'browser_navigate',
      'browser_navigate_back',
      'browser_network_requests',
      'browser_press_key',
      'browser_select_option',
      'browser_snapshot',
      'browser_tabs',
      'browser_take_screenshot',
      'browser_type',
    ]);
    expect(built.hiddenByProfile).toEqual(
      ['browser_fill_form', 'browser_find', ...NATIVE_ONLY.map((name) => `camoufox_native_${name}`)].sort(),
    );
  });

  it('applies disabled_tools to exposed names, not native names', () => {
    const built = build('full', NATIVE_TOOLS, new Set(['browser_click', 'camoufox_native_scroll']));
    expect(built.exposedNames.has('browser_click')).toBe(false);
    expect(built.exposedNames.has('camoufox_native_scroll')).toBe(false);
    expect(built.exposedNames.has('click')).toBe(false);
    expect(built.exposedNames.has('scroll')).toBe(false);
    expect(built.exposedNames.has('browser_type')).toBe(true);
  });

  it('is deterministic and sorted', () => {
    const first = build('full').tools.map((tool) => tool.name);
    const second = build('full').tools.map((tool) => tool.name);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
  });
});

describe('advertised canonical schemas', () => {
  it('keeps canonical names and drops rejected arguments from the schema', () => {
    const built = build('full');
    const byName = new Map(built.tools.map((tool) => [tool.name, tool]));
    const screenshot = byName.get('browser_take_screenshot') as unknown as {
      description: string;
      inputSchema: { properties: Record<string, unknown>; required?: string[] };
    };
    expect(screenshot.description).toBe(contracts.browser_take_screenshot.description);
    expect(Object.keys(screenshot.inputSchema.properties).sort()).toEqual(['element', 'fullPage', 'target']);
    expect(screenshot.inputSchema.required).toBeUndefined();
    const network = byName.get('browser_network_requests') as unknown as {
      inputSchema: { properties: Record<string, unknown>; required?: string[] };
    };
    expect(Object.keys(network.inputSchema.properties)).toEqual([]);
    expect(network.inputSchema.required).toBeUndefined();
    const consoleTools = byName.get('browser_console_messages') as unknown as {
      inputSchema: { properties: Record<string, unknown>; required?: string[] };
    };
    expect(Object.keys(consoleTools.inputSchema.properties).sort()).toEqual(['all', 'level']);
    expect(consoleTools.inputSchema.required).toEqual(['level']);
    const snapshot = byName.get('browser_snapshot') as unknown as {
      inputSchema: { properties: Record<string, unknown>; required?: string[] };
    };
    expect(Object.keys(snapshot.inputSchema.properties)).toEqual([]);
  });

  it('ships a schema for every aliased canonical name and nothing engine-specific', () => {
    expect(Object.keys(contracts).sort()).toEqual([...CANONICAL_TOOLS].sort());
    for (const name of CANONICAL_TOOLS) {
      expect(contracts[name].description.trim()).not.toBe('');
      expect(contracts[name].inputSchema).toBeTypeOf('object');
    }
  });
});

describe('identity for contract engines', () => {
  it('does not treat cloak or playwright as native', () => {
    const cloak = JSON.parse(readFileSync(path.join(pluginRoot, 'engines', 'cloak.json'), 'utf8')) as {
      contract: string;
    };
    const playwright = JSON.parse(
      readFileSync(path.join(pluginRoot, 'engines', 'playwright.json'), 'utf8'),
    ) as { contract: string };
    expect(surface.isNativeContract(cloak)).toBe(false);
    expect(surface.isNativeContract(playwright)).toBe(false);
    expect(surface.createAliasIndex(cloak as NativeManifest).byCanonical.size).toBe(0);
    expect(surface.createAliasIndex(playwright as NativeManifest).byCanonical.size).toBe(0);
  });
});

describe('argument translation for every aliased canonical tool', () => {
  const cases: [string, Record<string, unknown>, string, Record<string, unknown>][] = [
    ['browser_navigate', { url: 'https://example.com' }, 'navigate', { url: 'https://example.com' }],
    ['browser_navigate_back', {}, 'go_back', {}],
    ['browser_snapshot', {}, 'snapshot', {}],
    [
      'browser_click',
      { target: 'e1', doubleClick: true, element: 'button' },
      'click',
      { uid: 'e1', double_click: true },
    ],
    [
      'browser_type',
      { target: 'e1', text: 'hello', element: 'field' },
      'fill',
      { uid: 'e1', value: 'hello' },
    ],
    [
      'browser_select_option',
      { target: 'e1', values: ['blue'], element: 'select' },
      'fill',
      { uid: 'e1', value: 'blue' },
    ],
    [
      'browser_fill_form',
      { fields: [{ target: 'e1', value: 'x', name: 'first', type: 'textbox', element: 'field' }] },
      'fill_form',
      { fields: [{ uid: 'e1', value: 'x' }] },
    ],
    ['browser_press_key', { key: 'Enter' }, 'press_key', { key: 'Enter' }],
    ['browser_find', { text: 'sign in' }, 'find', { text: 'sign in' }],
    [
      'browser_evaluate',
      { function: '() => 1', target: 'e1' },
      'evaluate',
      { script: '() => 1', uids: ['e1'] },
    ],
    [
      'browser_take_screenshot',
      { target: 'e1', fullPage: true },
      'screenshot',
      { uid: 'e1', full_page: true },
    ],
    ['browser_tabs', { action: 'list' }, 'list_pages', {}],
    [
      'browser_tabs',
      { action: 'new', url: 'https://example.com' },
      'new_page',
      { url: 'https://example.com' },
    ],
    ['browser_tabs', { action: 'close', index: 2 }, 'close_page', { page_idx: 2 }],
    ['browser_tabs', { action: 'select', index: 1 }, 'select_page', { page_idx: 1 }],
    ['browser_network_requests', {}, 'list_network_requests', {}],
    [
      'browser_console_messages',
      { level: 'error', all: true },
      'list_console_messages',
      { levels: ['error'], include_preserved: true },
    ],
    [
      'browser_handle_dialog',
      { accept: true, promptText: 'ok' },
      'handle_dialog',
      { action: 'accept', prompt_text: 'ok' },
    ],
    ['browser_close', {}, 'close_session', {}],
  ];

  it.each(cases)('%s calls the mapped native tool', (exposedName, args, native, expected) => {
    const result = classify(args, exposedName);
    expect(result.error).toBeNull();
    expect(result.native).toBe(native);
    expect(result.arguments).toEqual({ ...expected, profile: 'acct-one' });
  });

  it('does not inject the profile into list_sessions', () => {
    const result = classify({}, 'camoufox_native_list_sessions');
    expect(result.native).toBe('list_sessions');
    expect(result.arguments).toEqual({});
  });

  it('passes native-only tools through with the profile injected', () => {
    const result = classify({ direction: 'down', amount: 300 }, 'camoufox_native_scroll');
    expect(result.native).toBe('scroll');
    expect(result.arguments).toEqual({ direction: 'down', amount: 300, profile: 'acct-one' });
  });
});

describe('strict argument rejection', () => {
  it.each([
    ['browser_click', { target: 'e1', button: 'right' }],
    ['browser_type', { target: 'e1', text: 'x', slowly: true }],
    ['browser_network_requests', { static: false }],
    ['browser_take_screenshot', { target: 'e1', scale: 'css' }],
    ['browser_snapshot', { target: 'e1' }],
    ['browser_evaluate', { function: '() => 1', filename: 'x.txt' }],
    ['browser_find', { text: 'x', regex: '/x/' }],
    ['browser_select_option', { target: 'e1', values: ['a', 'b'] }],
    ['browser_select_option', { target: 'e1', values: [] }],
    ['browser_tabs', { action: 'close' }],
    ['browser_tabs', { action: 'list', url: 'https://example.com' }],
    ['browser_tabs', { action: 'explode' }],
    ['browser_fill_form', { fields: [{ target: 'e1', value: 'x', type: 'checkbox' }] }],
    ['browser_navigate', { url: 'https://example.com', extra: true }],
  ])('rejects %s with unsupported arguments', (exposedName, args) => {
    const result = classify(args, exposedName);
    expect(result.error).toBeTypeOf('string');
    expect(result.native).toBeUndefined();
  });
});

describe('fail-closed mutations', () => {
  it('rejects an alias that names a native tool the backend does not expose', () => {
    const built = build(
      'full',
      NATIVE_TOOLS.filter((name) => name !== 'navigate'),
    );
    expect(built.error).toContain('navigate');
    expect(built.error).toContain('does not expose');
  });

  it('rejects a manifest that declares a canonical name twice', () => {
    const duplicate = {
      ...manifest,
      toolAliases: [
        ...manifest.toolAliases,
        { canonical: 'browser_navigate', native: 'reload', support: 'full' },
      ],
    };
    expect(registry.validateManifest(duplicate, 'camoufox-native', profileNames)).toContain('more than once');
    expect(surface.createAliasIndex(duplicate as NativeManifest).error).toContain('more than once');
  });

  it('rejects an unknown canonical name', () => {
    const result = classify({}, 'browser_hover');
    expect(result.error).toContain('Unknown tool');
  });

  it('rejects an unknown native name before and after tools/list', () => {
    expect(classify({}, 'camoufox_native_nope').error).toContain('Unknown native tool');
    const built = build('full');
    const result = surface.resolveNativeCall({
      manifest,
      contracts,
      surface: built,
      exposedName: 'camoufox_native_nope',
      args: {},
      profileValue: 'acct-one',
    });
    expect(result.error).toContain('Unknown native tool');
  });

  it('rejects an alias whose canonical name is a broker meta-tool', () => {
    const mutated = {
      ...manifest,
      toolAliases: [
        ...manifest.toolAliases,
        { canonical: 'browser_capabilities', native: 'reload', support: 'full' },
      ],
    };
    expect(registry.validateManifest(mutated, 'camoufox-native', profileNames)).toContain('meta-tool');
  });

  it('follows the manifest when an alias target changes', () => {
    const mutated = {
      ...manifest,
      toolAliases: manifest.toolAliases.map((alias) =>
        alias.canonical === 'browser_navigate' ? { ...alias, native: 'reload' } : alias,
      ),
    };
    const result = surface.resolveNativeCall({
      manifest: mutated as NativeManifest,
      contracts,
      surface: null,
      exposedName: 'browser_navigate',
      args: { url: 'https://example.com' },
      profileValue: 'acct-one',
    });
    expect(result.error).toBeNull();
    expect(result.native).toBe('reload');
    expect(result.arguments).toEqual({ url: 'https://example.com', profile: 'acct-one' });
  });
});

describe('modularity', () => {
  it('keeps the engine id and native tool names out of the broker and surface code', () => {
    const broker = readFileSync(brokerPath, 'utf8');
    const surfaceCode = readFileSync(surfacePath, 'utf8');
    for (const source of [broker, surfaceCode]) {
      expect(source).not.toContain('camoufox-native');
      expect(source).not.toContain("'navigate'");
      expect(source).not.toContain("'list_sessions'");
    }
  });
});
