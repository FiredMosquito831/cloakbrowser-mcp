import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

interface ProfilesDocument {
  schemaVersion: number;
  profiles: { full: { kind: string }; portable: { kind: string; tools: string[] } };
}

interface JsonRpcResponse {
  id?: number;
  result?: {
    tools?: { name: string }[];
    content?: { type: string; text?: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    instructions?: string;
    serverInfo?: { name?: string; version?: string };
  };
  error?: { code: number; message: string };
}

interface BrokerSession {
  responses: Map<number, JsonRpcResponse>;
  stderr: () => string;
  exited: Promise<number | null>;
  close: () => Promise<void>;
}

function structuredContent(response: JsonRpcResponse): Record<string, unknown> {
  return response.result?.structuredContent ?? {};
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginRoot = path.join(repoRoot, 'plugins', 'cloakbrowser');
const brokerPath = path.join(pluginRoot, 'broker.mjs');
const profiles = JSON.parse(
  readFileSync(path.join(pluginRoot, 'engines', 'profiles.json'), 'utf8'),
) as ProfilesDocument;
const PORTABLE_TOOLS = profiles.profiles.portable.tools;
const EXTRA_TOOLS = ['browser_pdf_save', 'browser_annotate', 'browser_mouse_click_xy', 'browser_start_video'];
const STUB_TOOLS = [...PORTABLE_TOOLS, ...EXTRA_TOOLS];
const MISSING_PROFILE_REASON =
  'The kameleo engine needs a profile ID. Set "Kameleo profile ID" (kameleo_profile_id) ' +
  'in the cloakbrowser plugin configuration and restart Claude Code.';
const HINT =
  'Kameleo is not answering at ws://127.0.0.1:5050/playwright/test-profile. Start the Kameleo ' +
  'app, sign in, and confirm the profile ID exists. Kameleo starts the profile itself when the ' +
  'endpoint is opened.';

const STUB_SOURCE = `#!/usr/bin/env node
// Deterministic stand-in for @playwright/mcp in the broker test. It answers the
// MCP handshake and tool list from memory and fails only browser_navigate, so
// the broker's lazy-surface, filter and error-enrichment paths are exercised
// without a browser or a network connection. The temp directory has no
// package.json, so this file is CommonJS.
const readline = require('node:readline');

const TOOLS = __TOOLS__;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'stub-playwright-mcp', version: '0.0.83' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: TOOLS.map((name) => ({
          name,
          description: 'stub ' + name,
          inputSchema: { type: 'object', properties: {} },
        })),
      },
    });
    return;
  }
  if (message.method === 'tools/call') {
    const fail = message.params?.name === 'browser_navigate';
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [
          {
            type: 'text',
            text: fail ? 'Error: async initializeServer: WebSocket error: connect ECONNREFUSED 127.0.0.1:5050' : 'ok',
          },
        ],
        isError: fail,
      },
    });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: {} });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (line.trim() === '') return;
  try {
    handle(JSON.parse(line));
  } catch {
    // Ignore malformed input, exactly as a real MCP server would not answer it.
  }
});
rl.on('close', () => process.exit(0));
`;

const tempRoots: string[] = [];
const sessions: BrokerSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close();
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createRuntime(stubTools: string[] = STUB_TOOLS): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cloakbrowser-kameleo-broker-'));
  tempRoots.push(root);
  const runtime = path.join(root, 'runtime');
  const modules = path.join(runtime, 'node_modules');
  mkdirSync(path.join(modules, 'cloakbrowser'), { recursive: true });
  mkdirSync(path.join(modules, 'playwright-core'), { recursive: true });
  mkdirSync(path.join(modules, 'playwright'), { recursive: true });
  mkdirSync(path.join(modules, '@playwright', 'mcp'), { recursive: true });
  writeJson(path.join(runtime, '.installed.json'), {
    package: 'cloakbrowser-mcp@1.15.1',
    engine: '0.6.3',
    driver: 'patchright@1.64.1',
  });
  writeJson(path.join(modules, 'cloakbrowser', 'package.json'), {
    name: 'cloakbrowser',
    version: '0.6.3',
  });
  writeJson(path.join(modules, 'playwright-core', 'package.json'), {
    name: 'patchright-core',
    version: '1.64.1',
  });
  writeJson(path.join(modules, 'playwright', 'package.json'), {
    name: 'patchright',
    version: '1.64.1',
  });
  writeFileSync(
    path.join(modules, '@playwright', 'mcp', 'cli.js'),
    STUB_SOURCE.replace('__TOOLS__', JSON.stringify(stubTools)),
  );
  return root;
}

function startBroker(options: {
  dataDir: string;
  profileId: string;
  toolProfile: string;
  endpoint?: string;
}): BrokerSession {
  const child = spawn(process.execPath, [brokerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      STEALTH_ENGINE: 'kameleo',
      STEALTH_TOOL_PROFILE: options.toolProfile,
      KAMELEO_PROFILE_ID: options.profileId,
      KAMELEO_ENDPOINT: options.endpoint ?? '',
      CLAUDE_PLUGIN_DATA: options.dataDir,
      // Keep the launcher's runtime identity deterministic even if the test
      // process inherited a different pin from the developer's environment.
      CLOAK_PLAYWRIGHT_MCP_PACKAGE: 'cloakbrowser-mcp@1.15.1',
    },
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim() === '') return;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id) as (response: JsonRpcResponse) => void;
      pending.delete(message.id);
      resolve(message);
    }
  });
  let nextId = 1;
  const request = (method: string, params?: Record<string, unknown>, timeoutMs = 8000) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}; stderr=${stderr.slice(-500)}`));
      }, timeoutMs);
      pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  };
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  };
  const session: BrokerSession = {
    responses: new Map(),
    stderr: () => stderr,
    exited,
    close,
  };
  sessions.push(session);
  return Object.assign(session, { request });
}

describe('kameleo broker configuration errors', () => {
  it('answers initialize and tools/list meta-only when the profile id is missing', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'cloakbrowser-kameleo-empty-'));
    tempRoots.push(dataDir);
    const session = startBroker({ dataDir, profileId: '', toolProfile: 'full' }) as BrokerSession & {
      request: (method: string, params?: Record<string, unknown>) => Promise<JsonRpcResponse>;
    };
    const initialize = await session.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(initialize.result?.instructions).toContain('needs a profile ID');
    expect(initialize.result?.instructions).toContain('kameleo_profile_id');
    const list = await session.request('tools/list', {});
    expect(list.result?.tools?.map((tool) => tool.name)).toEqual([
      'browser_capabilities',
      'browser_engine_status',
    ]);
    const status = await session.request('tools/call', {
      name: 'browser_engine_status',
      arguments: {},
    });
    const payload = structuredContent(status);
    expect(payload.backendState).toBe('failed');
    expect(payload.lastError).toBe(MISSING_PROFILE_REASON);
    expect(payload.engineError).toBe(MISSING_PROFILE_REASON);
    expect(payload.backendPid).toBeNull();
    const capabilities = await session.request('tools/call', {
      name: 'browser_capabilities',
      arguments: {},
    });
    const caps = structuredContent(capabilities);
    expect(caps.engine).toBe('kameleo');
    expect(caps.engineError).toBe(MISSING_PROFILE_REASON);
    expect(caps.groupSwitchesApply).toBe(true);
    expect(caps.cdpAttach).toBe(true);
  });

  it('answers initialize with the launcher rule when the endpoint setting is invalid', async () => {
    const dataDir = createRuntime();
    const session = startBroker({
      dataDir,
      profileId: 'test-profile',
      toolProfile: 'full',
      endpoint: 'http://127.0.0.1:5050',
    }) as BrokerSession & {
      request: (method: string, params?: Record<string, unknown>) => Promise<JsonRpcResponse>;
    };
    const initialize = await session.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(initialize.result?.instructions).toContain('kameleo_endpoint must use the ws:// or wss:// scheme');
    expect(initialize.result?.instructions).toContain('Backend exited (code 1)');
    const list = await session.request('tools/list', {});
    expect(list.result?.tools).toHaveLength(2);
    const status = await session.request('tools/call', {
      name: 'browser_engine_status',
      arguments: {},
    });
    const payload = structuredContent(status);
    expect(payload.backendState).toBe('failed');
    expect(String(payload.lastError)).toContain('kameleo_endpoint must use the ws:// or wss:// scheme');
    expect(payload.kameleoEndpoint).toBe('http://127.0.0.1:5050');
    expect(payload.kameleoProfileId).toBe('test-profile');
  });
});

describe('kameleo broker with a lazy backend', () => {
  it('advertises the portable surface and enriches only the first failed call', async () => {
    const dataDir = createRuntime();
    const session = startBroker({
      dataDir,
      profileId: 'test-profile',
      toolProfile: 'portable',
    }) as BrokerSession & {
      request: (method: string, params?: Record<string, unknown>) => Promise<JsonRpcResponse>;
    };
    const initialize = await session.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(initialize.result?.serverInfo?.name).toBe('stub-playwright-mcp');
    expect(initialize.result?.instructions).toBeUndefined();

    const list = await session.request('tools/list', {});
    const names = list.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toHaveLength(PORTABLE_TOOLS.length + 2);
    for (const toolName of PORTABLE_TOOLS) {
      expect(names).toContain(toolName);
    }
    expect(names).not.toContain('browser_pdf_save');
    expect(names).toContain('browser_capabilities');
    expect(names).toContain('browser_engine_status');

    const first = await session.request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: 'http://127.0.0.1:9/' },
    });
    expect(first.result?.isError).toBe(true);
    const firstText = first.result?.content?.[0]?.text ?? '';
    expect(firstText).toContain('ECONNREFUSED');
    expect(firstText.endsWith(HINT)).toBe(true);

    const success = await session.request('tools/call', {
      name: 'browser_snapshot',
      arguments: {},
    });
    expect(success.result?.isError).toBe(false);

    const afterSuccess = await session.request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: 'http://127.0.0.1:9/' },
    });
    expect(afterSuccess.result?.isError).toBe(true);
    expect(afterSuccess.result?.content?.[0]?.text).toBe(
      'Error: async initializeServer: WebSocket error: connect ECONNREFUSED 127.0.0.1:5050',
    );

    const status = await session.request('tools/call', {
      name: 'browser_engine_status',
      arguments: {},
    });
    const statusPayload = structuredContent(status);
    expect(statusPayload.backendState).toBe('running');
    expect(statusPayload.kameleoEndpoint).toBe('ws://127.0.0.1:5050/playwright/test-profile');
    expect(statusPayload.kameleoProfileId).toBe('test-profile');

    const capabilities = await session.request('tools/call', {
      name: 'browser_capabilities',
      arguments: {},
    });
    const caps = structuredContent(capabilities);
    expect(caps.toolProfile).toBe('portable');
    expect(caps.exposedToolCount).toBe(PORTABLE_TOOLS.length + 2);
    expect(caps.groupSwitchesApply).toBe(true);
    expect(caps.cdpAttach).toBe(true);
  });

  it('exposes the full stub surface plus the two meta-tools', async () => {
    const dataDir = createRuntime();
    const session = startBroker({
      dataDir,
      profileId: 'test-profile',
      toolProfile: 'full',
    }) as BrokerSession & {
      request: (method: string, params?: Record<string, unknown>) => Promise<JsonRpcResponse>;
    };
    await session.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    const list = await session.request('tools/list', {});
    const names = list.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toHaveLength(STUB_TOOLS.length + 2);
    expect(names).toContain('browser_pdf_save');
    expect(names).toContain('browser_annotate');
    expect(names).toContain('browser_capabilities');
    expect(names).toContain('browser_engine_status');
  });
});
