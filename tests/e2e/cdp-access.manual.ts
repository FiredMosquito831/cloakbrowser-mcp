import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { request as createHttpsRequest } from 'node:https';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { binaryInfo } from 'cloakbrowser';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RawData, WebSocket } from 'ws';
import { LOCAL_TOOL_BRIDGE_INFO } from '@/bridge/tools.js';
import { BRIDGE_INITIALIZE_META_KEY, JSON_RPC_VERSION, MCP_SESSION_ID_HEADER } from '@/protocol/constants.js';
import {
  cleanupDistributionE2e,
  createTempRoot,
  type DistributionCommand,
  packAndInstallCurrentPackage,
} from '@tests/e2e/distributionHarness.js';
import { createFreeBrowserRuntime, type FreeBrowserRuntime } from '@tests/helpers/browser-test-runtime.js';
import { startTestTlsTerminator } from '@tests/helpers/tls-terminator.js';
type BrowserEngine = 'cloak' | 'playwright';
const nodeBrowserEngines = ['cloak', 'playwright'] as const satisfies readonly BrowserEngine[];
interface ReadyCdpInfo {
  activeConnections: number;
  discoveryUrl: string;
  enabled: true;
  generation: number;
  port: number;
  state: 'ready';
}
interface UnavailableCdpInfo {
  activeConnections: 0;
  discoveryUrl: null;
  enabled: true;
  generation: number;
  port: number;
  state: 'unavailable';
}
interface RunningHttpBridge {
  child: ChildProcessWithoutNullStreams;
  stderr: {
    text: string;
  };
  stdout: {
    text: string;
  };
  url: URL;
}
interface RawHttpSession {
  id: string;
  server: RunningHttpBridge;
}
interface RunningTlsBridge {
  cdp: ReadyCdpInfo;
  client: Client;
  stderr: {
    text: string;
  };
}
interface RunningBridge {
  browser: Browser;
  browserProcess: {
    arguments: string[];
    pid: number;
  };
  client: Client;
  cdp: ReadyCdpInfo;
  stderr: {
    text: string;
  };
}
let packagedCommand: DistributionCommand;
let freeRuntime: FreeBrowserRuntime;
beforeAll(async () => {
  const cache = dirname(binaryInfo().cacheDir);
  const entries = await readdir(cache);
  const versions = entries
    .filter((entry) => /^chromium-[\d.]+$/u.test(entry))
    .sort()
    .reverse();
  const override = process.env.CLOAKBROWSER_BINARY_PATH;
  const requested = override ? await realpath(override) : undefined;
  let executable: string | undefined;
  for (const entry of versions) {
    const version = entry.slice('chromium-'.length);
    const info = binaryInfo(version);
    if (!info.installed || info.tier !== 'free') continue;
    const candidate = await realpath(info.binaryPath);
    if (!requested || requested === candidate) {
      executable = candidate;
      break;
    }
  }
  if (!executable) throw new Error('CDP E2E requires a cached, verified Free CloakBrowser binary');
  const playwrightExecutable = chromium.executablePath();
  const installed = existsSync(playwrightExecutable);
  if (!installed) throw new Error('CDP E2E requires an installed controlled Playwright Chromium executable');
  packagedCommand = packAndInstallCurrentPackage();
  const parentEnv = { ...packagedCommand.env };
  for (const key of Object.keys(parentEnv)) {
    if (key.startsWith('PLAYWRIGHT_MCP_') || key.startsWith('CLOAK_PLAYWRIGHT_MCP_')) delete parentEnv[key];
  }
  parentEnv.PLAYWRIGHT_MCP_OUTPUT_DIR = packagedCommand.env.PLAYWRIGHT_MCP_OUTPUT_DIR ?? '';
  const root = createTempRoot('cloak-cdp-free-');
  const options = { root, freeExecutable: executable, parentEnv };
  freeRuntime = await createFreeBrowserRuntime(options);
  packagedCommand.env = freeRuntime.env;
  packagedCommand.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH = playwrightExecutable;
  packagedCommand.env.PLAYWRIGHT_MCP_ISOLATED = 'true';
});
afterAll(async () => {
  try {
    await freeRuntime?.dispose();
  } finally {
    cleanupDistributionE2e();
  }
});
it('uses a verified Free Cloak binary and clears inherited license configuration', () => {
  const executable = packagedCommand.env.CLOAKBROWSER_BINARY_PATH;
  expect(executable).toBeDefined();
  expect(packagedCommand.env.CLOAKBROWSER_LICENSE_KEY).toBeUndefined();
  expect(packagedCommand.env.CLOAKBROWSER_CACHE_DIR).toBeDefined();
  expect(packagedCommand.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH).toBeDefined();
  expect(packagedCommand.env.PLAYWRIGHT_MCP_ISOLATED).toBe('true');
});
it('redacts managed CDP capabilities from E2E diagnostics', () => {
  const capability = 'A'.repeat(43);
  const diagnostic = `connection failed for ws://127.0.0.1:9222/cdp/${capability}/devtools/browser/id`;
  const redacted = redactCdpCapabilities(diagnostic);
  const includesResult = redacted.includes(capability);
  expect(includesResult).toBe(false);
  expect(redacted).toContain('/cdp/<redacted>/devtools/browser/id');
});
it('declares the complete packaged Node browser-engine matrix', () => {
  const receiverActual = nodeBrowserEngines;
  const values: string[] = ['cloak', 'playwright'];
  expect(receiverActual).toEqual(values);
});
it('matches the declared native architecture evidence', () => {
  const expected = process.env.CLOAKBROWSER_MCP_CDP_EXPECTED_ARCHITECTURE;
  if (expected === undefined) return;
  const nativeArchitectureResult = readNativeArchitecture();
  expect(nativeArchitectureResult).toBe(expected);
});
describe.each<BrowserEngine>(nodeBrowserEngines)('packaged Node managed CDP with %s', (engine) => {
  it('shares browser state across MCP and multiple CDP clients without global read blocking', async () => {
    const fixture = await startFixtureServer();
    let bridge: RunningBridge | undefined;
    let secondBrowser: Browser | undefined;
    try {
      bridge = await startPackagedBridge(engine);
      const argumentValue = bridge.client;
      const expectToolSuccessOptions = { url: fixture.url } as const;
      await expectToolSuccess(argumentValue, 'browser_navigate', expectToolSuccessOptions);
      const page = await findPage(bridge.browser, fixture.url);
      const titleResult = page.title();
      await expect(titleResult).resolves.toBe('MCP to CDP');
      const someResult = bridge.browserProcess.arguments.some((argument) =>
        argument.includes('--remote-debugging-pipe'),
      );
      expect(someResult).toBe(true);
      const message2 = `${bridge.cdp.discoveryUrl}/json/version`;
      const fetchResult = fetch(message2);
      const receiver2Actual = fetchResult;
      const toMatchObjectOptions = {
        status: 200,
      } as const;
      await expect(receiver2Actual).resolves.toMatchObject(toMatchObjectOptions);
      const expectToolSuccessOptions2 = {
        function:
          "() => { localStorage.setItem('mcp-shared', 'visible-through-cdp'); document.body.dataset.owner = 'mcp'; }",
      } as const;
      await expectToolSuccess(bridge.client, 'browser_evaluate', expectToolSuccessOptions2);
      const evaluateResult = page.evaluate("localStorage.getItem('mcp-shared')");
      await expect(evaluateResult).resolves.toBe('visible-through-cdp');
      await page.evaluate(
        "localStorage.setItem('cdp-shared', 'visible-through-mcp'); document.body.dataset.controller = 'cdp'",
      );
      const callToolOptions = {
        function:
          "() => ({ storage: localStorage.getItem('cdp-shared'), controller: document.body.dataset.controller })",
      } as const;
      const evaluation = await callTool(bridge.client, 'browser_evaluate', callToolOptions);
      const serializedValue = JSON.stringify(evaluation.content);
      expect(serializedValue).toContain('visible-through-mcp');
      secondBrowser = await connectOverManagedCdp(bridge.cdp.discoveryUrl);
      const secondPage = await findPage(secondBrowser, fixture.url);
      const evaluateResult2 = secondPage.evaluate('document.body.dataset.owner');
      await expect(evaluateResult2).resolves.toBe('mcp');
      const active = await readCdpInfo(bridge.client);
      expect(active.activeConnections).toBe(2);
      const values2: [
        Promise<{
          [x: string]: unknown;
          content: (
            | {
                type: 'text';
                text: string;
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
              }
            | {
                type: 'image';
                data: string;
                mimeType: string;
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
              }
            | {
                type: 'audio';
                data: string;
                mimeType: string;
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
              }
            | {
                uri: string;
                name: string;
                type: 'resource_link';
                description?: string | undefined;
                mimeType?: string | undefined;
                size?: number | undefined;
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
                icons?:
                  | {
                      src: string;
                      mimeType?: string | undefined;
                      sizes?: string[] | undefined;
                      theme?: 'light' | 'dark' | undefined;
                    }[]
                  | undefined;
                title?: string | undefined;
              }
            | {
                type: 'resource';
                resource:
                  | {
                      uri: string;
                      text: string;
                      mimeType?: string | undefined;
                      _meta?: Record<string, unknown> | undefined;
                    }
                  | {
                      uri: string;
                      blob: string;
                      mimeType?: string | undefined;
                      _meta?: Record<string, unknown> | undefined;
                    };
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
              }
          )[];
          _meta?:
            | {
                [x: string]: unknown;
                progressToken?: string | number | undefined;
                'io.modelcontextprotocol/related-task'?:
                  | {
                      taskId: string;
                    }
                  | undefined;
              }
            | undefined;
          structuredContent?: Record<string, unknown> | undefined;
          isError?: boolean | undefined;
        }>,
        Promise<string>,
        Promise<unknown>,
      ] = [
        callTool(bridge.client, 'browser_snapshot'),
        page.title(),
        secondPage.evaluate('document.body.dataset.controller'),
      ];
      await Promise.all(values2);
      await secondBrowser.close();
      secondBrowser = undefined;
      await expectToolSuccess(bridge.client, 'browser_snapshot');
      const bridgeClient = bridge.client;
      await expect.poll(async () => (await readCdpInfo(bridgeClient)).activeConnections).toBe(1);
      const afterDisconnect = await readCdpInfo(bridge.client);
      expect(afterDisconnect.generation).toBe(bridge.cdp.generation);
      expect(afterDisconnect.state).toBe('ready');
    } finally {
      await secondBrowser?.close().catch(() => undefined);
      if (bridge !== undefined) await closePackagedBridge(bridge);
      await fixture.close();
    }
  });
  it('rotates generation after raw Browser.close while keeping the MCP session usable', async () => {
    const bridge = await startPackagedBridge(engine);
    try {
      const initialBrowserProcess = bridge.browserProcess;
      const cdpSession = await bridge.browser.newBrowserCDPSession();
      const disconnected = new Promise<void>((resolve) =>
        bridge.browser.once('disconnected', () => resolve()),
      );
      void cdpSession.send('Browser.close').catch(() => undefined);
      const message3 = `Raw Browser.close did not disconnect ${engine}`;
      await withTimeout(disconnected, 10000, message3);
      await expect.poll(async () => (await readBridgeCdpInfo(bridge.client)).state).toBe('unavailable');
      const termination = { timeout: 10000 };
      await expect.poll(async () => await processExists(initialBrowserProcess.pid), termination).toBe(false);
      const callToolOptions2 = {
        name: 'browser_tabs',
        arguments: { action: 'list' },
      } as const;
      const tabs = (await bridge.client.callTool(callToolOptions2)) as CallToolResult;
      expect(tabs.isError).not.toBe(true);
      const callToolOptions3 = {
        name: 'browser_navigate',
        arguments: { url: 'data:text/html,<title>replacement-ready</title>' },
      } as const;
      const navigation = (await bridge.client.callTool(callToolOptions3)) as CallToolResult;
      expect(navigation.isError).not.toBe(true);
      const replacement = await readCdpInfo(bridge.client);
      expect(replacement.generation).toBeGreaterThan(bridge.cdp.generation);
      const computedValue = replacement.discoveryUrl === bridge.cdp.discoveryUrl;
      expect(computedValue).toBe(false);
      const replacementBrowser = await connectOverManagedCdp(replacement.discoveryUrl);
      try {
        const replacementProcess = await readManagedBrowserProcess(replacementBrowser);
        expect(replacementProcess.pid).not.toBe(initialBrowserProcess.pid);
        const findPageResult = findPage(replacementBrowser, 'data:text/html');
        await expect(findPageResult).resolves.toBeDefined();
      } finally {
        await replacementBrowser.close();
      }
    } finally {
      await closePackagedBridge(bridge);
    }
  });
  it('isolates two Streamable HTTP sessions with explicit CDP enablement', async () => {
    const fixture = await startFixtureServer();
    const range = await findFreePortRange(3);
    const server = await startPackagedHttpBridge(engine, false, range);
    const sessions: RawHttpSession[] = [];
    const browsers: Browser[] = [];
    try {
      const initializeRawHttpSessionOptions = { cdpEnabled: true } as const;
      const first = await initializeRawHttpSession(server, initializeRawHttpSessionOptions);
      sessions.push(first);
      const initializeRawHttpSessionOptions2 = { cdpEnabled: true } as const;
      const second = await initializeRawHttpSession(server, initializeRawHttpSessionOptions2);
      sessions.push(second);
      const initializeRawHttpSessionOptions3 = { cdpEnabled: false } as const;
      const disabled = await initializeRawHttpSession(server, initializeRawHttpSessionOptions3);
      sessions.push(disabled);
      const firstInfo = await readHttpCdpInfo(first);
      const secondInfo = await readHttpCdpInfo(second);
      expect(firstInfo.port).not.toBe(secondInfo.port);
      expect(firstInfo.discoveryUrl).not.toBe(secondInfo.discoveryUrl);
      const httpCdpStateResult = await readHttpCdpState(disabled);
      const receiver3Actual = httpCdpStateResult;
      const toEqualOptions = { enabled: false } as const;
      expect(receiver3Actual).toEqual(toEqualOptions);
      const callHttpToolOptions = { url: `${fixture.url}?session=first` } as const;
      const callHttpToolResult = callHttpTool(first, 'browser_navigate', callHttpToolOptions);
      const callHttpToolOptions2 = { url: `${fixture.url}?session=second` } as const;
      const callHttpToolResult2 = callHttpTool(second, 'browser_navigate', callHttpToolOptions2);
      const values4: [
        Promise<{
          [x: string]: unknown;
          content: (
            | {
                type: 'text';
                text: string;
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
              }
            | {
                type: 'image';
                data: string;
                mimeType: string;
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
              }
            | {
                type: 'audio';
                data: string;
                mimeType: string;
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
              }
            | {
                uri: string;
                name: string;
                type: 'resource_link';
                description?: string | undefined;
                mimeType?: string | undefined;
                size?: number | undefined;
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
                icons?:
                  | {
                      src: string;
                      mimeType?: string | undefined;
                      sizes?: string[] | undefined;
                      theme?: 'light' | 'dark' | undefined;
                    }[]
                  | undefined;
                title?: string | undefined;
              }
            | {
                type: 'resource';
                resource:
                  | {
                      uri: string;
                      text: string;
                      mimeType?: string | undefined;
                      _meta?: Record<string, unknown> | undefined;
                    }
                  | {
                      uri: string;
                      blob: string;
                      mimeType?: string | undefined;
                      _meta?: Record<string, unknown> | undefined;
                    };
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
              }
          )[];
          _meta?:
            | {
                [x: string]: unknown;
                progressToken?: string | number | undefined;
                'io.modelcontextprotocol/related-task'?:
                  | {
                      taskId: string;
                    }
                  | undefined;
              }
            | undefined;
          structuredContent?: Record<string, unknown> | undefined;
          isError?: boolean | undefined;
        }>,
        Promise<{
          [x: string]: unknown;
          content: (
            | {
                type: 'text';
                text: string;
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
              }
            | {
                type: 'image';
                data: string;
                mimeType: string;
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
              }
            | {
                type: 'audio';
                data: string;
                mimeType: string;
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
              }
            | {
                uri: string;
                name: string;
                type: 'resource_link';
                description?: string | undefined;
                mimeType?: string | undefined;
                size?: number | undefined;
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
                icons?:
                  | {
                      src: string;
                      mimeType?: string | undefined;
                      sizes?: string[] | undefined;
                      theme?: 'light' | 'dark' | undefined;
                    }[]
                  | undefined;
                title?: string | undefined;
              }
            | {
                type: 'resource';
                resource:
                  | {
                      uri: string;
                      text: string;
                      mimeType?: string | undefined;
                      _meta?: Record<string, unknown> | undefined;
                    }
                  | {
                      uri: string;
                      blob: string;
                      mimeType?: string | undefined;
                      _meta?: Record<string, unknown> | undefined;
                    };
                annotations?:
                  | {
                      audience?: ('user' | 'assistant')[] | undefined;
                      priority?: number | undefined;
                      lastModified?: string | undefined;
                    }
                  | undefined;
                _meta?: Record<string, unknown> | undefined;
              }
          )[];
          _meta?:
            | {
                [x: string]: unknown;
                progressToken?: string | number | undefined;
                'io.modelcontextprotocol/related-task'?:
                  | {
                      taskId: string;
                    }
                  | undefined;
              }
            | undefined;
          structuredContent?: Record<string, unknown> | undefined;
          isError?: boolean | undefined;
        }>,
      ] = [callHttpToolResult, callHttpToolResult2];
      await Promise.all(values4);
      const firstBrowser = await connectOverManagedCdp(firstInfo.discoveryUrl);
      const secondBrowser = await connectOverManagedCdp(secondInfo.discoveryUrl);
      browsers.push(firstBrowser, secondBrowser);
      const firstPage = await findPage(firstBrowser, fixture.url);
      const secondPage = await findPage(secondBrowser, fixture.url);
      await firstPage.evaluate("localStorage.setItem('session-owner', 'first')");
      await secondPage.evaluate("localStorage.setItem('session-owner', 'second')");
      const receiver4 = firstPage.context();
      const values5: readonly {
        name: string;
        value: string;
        url?: string;
        domain?: string;
        path?: string;
        expires?: number;
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: 'Strict' | 'Lax' | 'None';
        partitionKey?: string;
      }[] = [{ name: 'session-owner', value: 'first', url: fixture.url }];
      await receiver4.addCookies(values5);
      const receiver5 = secondPage.context();
      const values6: readonly {
        name: string;
        value: string;
        url?: string;
        domain?: string;
        path?: string;
        expires?: number;
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: 'Strict' | 'Lax' | 'None';
        partitionKey?: string;
      }[] = [{ name: 'session-owner', value: 'second', url: fixture.url }];
      await receiver5.addCookies(values6);
      const evaluateResult3 = firstPage.evaluate("localStorage.getItem('session-owner')");
      await expect(evaluateResult3).resolves.toBe('first');
      const evaluateResult4 = secondPage.evaluate("localStorage.getItem('session-owner')");
      await expect(evaluateResult4).resolves.toBe('second');
      const cookiesResult = firstPage.context().cookies(fixture.url);
      const receiver6Actual = cookiesResult;
      const objectContainingOptions = { name: 'session-owner', value: 'first' } as const;
      const objectContainingResult = expect.objectContaining(objectContainingOptions);
      const values7 = [objectContainingResult];
      const arrayContainingResult = expect.arrayContaining(values7);
      await expect(receiver6Actual).resolves.toEqual(arrayContainingResult);
      const cookiesResult2 = secondPage.context().cookies(fixture.url);
      const receiver7Actual = cookiesResult2;
      const objectContainingOptions2 = { name: 'session-owner', value: 'second' } as const;
      const objectContainingResult2 = expect.objectContaining(objectContainingOptions2);
      const values8 = [objectContainingResult2];
      const arrayContainingResult2 = expect.arrayContaining(values8);
      await expect(receiver7Actual).resolves.toEqual(arrayContainingResult2);
      const firstContext = firstBrowser.contexts()[0];
      const secondContext = secondBrowser.contexts()[0];
      if (firstContext === undefined || secondContext === undefined) {
        throw new Error('Expected default browser contexts for both HTTP sessions');
      }
      const secondTargetCount = secondContext.pages().length;
      const targetCreated = firstContext.waitForEvent('page');
      const newTarget = await firstContext.newPage();
      await expect(targetCreated).resolves.toBe(newTarget);
      const message4 = `${fixture.url}?target=first`;
      await newTarget.goto(message4);
      const pagesResult = secondContext.pages();
      expect(pagesResult).toHaveLength(secondTargetCount);
    } finally {
      const mappedValues = browsers.map((browser) => browser.close());
      await Promise.allSettled(mappedValues);
      const mappedValues2 = sessions.map((session) => closeRawHttpSession(session));
      await Promise.allSettled(mappedValues2);
      await closePackagedHttpBridge(server);
      await fixture.close();
    }
  });
  it('honors the HTTP process default and an explicit disabled session', async () => {
    const range = await findFreePortRange(2);
    const server = await startPackagedHttpBridge(engine, true, range);
    const sessions: RawHttpSession[] = [];
    const browsers: Browser[] = [];
    try {
      const inherited = await initializeRawHttpSession(server);
      const initializeRawHttpSessionOptions4 = { cdpEnabled: false } as const;
      const disabled = await initializeRawHttpSession(server, initializeRawHttpSessionOptions4);
      sessions.push(inherited, disabled);
      const inheritedInfo = await readHttpCdpInfo(inherited);
      const httpCdpStateResult2 = await readHttpCdpState(disabled);
      const receiver8Actual = httpCdpStateResult2;
      const toEqualOptions2 = { enabled: false } as const;
      expect(receiver8Actual).toEqual(toEqualOptions2);
      const connectOverManagedCdpResult = await connectOverManagedCdp(inheritedInfo.discoveryUrl);
      browsers.push(connectOverManagedCdpResult);
    } finally {
      const mappedValues3 = browsers.map((browser) => browser.close());
      await Promise.allSettled(mappedValues3);
      const mappedValues4 = sessions.map((session) => closeRawHttpSession(session));
      await Promise.allSettled(mappedValues4);
      await closePackagedHttpBridge(server);
    }
  });
  it('routes advertised HTTPS and WSS through an operator TLS terminator', async () => {
    const port = await findFreePort();
    const bridge = await startPackagedTlsBridge(engine, port);
    const startTestTlsTerminatorOptions = { host: '127.0.0.2', port } as const;
    const terminator = await startTestTlsTerminator(port, startTestTlsTerminatorOptions);
    let socket: WebSocket | undefined;
    try {
      const message5 = `${bridge.cdp.discoveryUrl}/json/version`;
      const uRL = new URL(message5);
      const discovery = (await requestHttpsJson(uRL)) as {
        webSocketDebuggerUrl: string;
      };
      const receiver9Actual = discovery.webSocketDebuggerUrl;
      const message6 = `^wss://127\\.0\\.0\\.2:${String(port)}/cdp/`;
      const regExp = new RegExp(message6, 'u');
      expect(receiver9Actual).toMatch(regExp);
      socket = await openTlsWebSocket(discovery.webSocketDebuggerUrl);
      const version = await sendCdpCommand(socket, 'Browser.getVersion');
      const receiver10Actual = version;
      const toMatchObjectOptions2 = { product: expect.any(String) } as const;
      expect(receiver10Actual).toMatchObject(toMatchObjectOptions2);
      expect(terminator.port).toBe(bridge.cdp.port);
      const receiver11Actual = terminator.requests;
      const objectContainingOptions3 = { host: `127.0.0.2:${String(port)}` } as const;
      const objectContainingResult3 = expect.objectContaining(objectContainingOptions3);
      const objectContainingOptions4 = {
        headers: objectContainingResult3,
      } as const;
      const objectContainingResult4 = expect.objectContaining(objectContainingOptions4);
      const values9 = [objectContainingResult4];
      const arrayContainingResult3 = expect.arrayContaining(values9);
      expect(receiver11Actual).toEqual(arrayContainingResult3);
      const receiver12Actual = terminator.upgrades;
      const objectContainingOptions5 = { host: `127.0.0.2:${String(port)}` } as const;
      const objectContainingResult5 = expect.objectContaining(objectContainingOptions5);
      const objectContainingOptions6 = {
        headers: objectContainingResult5,
      } as const;
      const objectContainingResult6 = expect.objectContaining(objectContainingOptions6);
      const values10 = [objectContainingResult6];
      const arrayContainingResult4 = expect.arrayContaining(values10);
      expect(receiver12Actual).toEqual(arrayContainingResult4);
    } finally {
      await closeWebSocket(socket);
      await terminator.close();
      await bridge.client.close().catch(() => undefined);
      expect(bridge.stderr.text).not.toMatch(/fatal:|Unhandled|Error:/iu);
    }
  });
});
async function startPackagedTlsBridge(engine: BrowserEngine, port: number): Promise<RunningTlsBridge> {
  const { PLAYWRIGHT_MCP_CLI_PATH: _fakeUpstream, ...baseEnv } = packagedCommand.env;
  const stdioClientTransportOptions = {
    command: packagedCommand.command,
    args: packagedCommand.args,
    env: {
      ...baseEnv,
      PLAYWRIGHT_MCP_BROWSER_ENGINE: engine,
      PLAYWRIGHT_MCP_HEADLESS: 'true',
      CLOAK_PLAYWRIGHT_MCP_CDP_ADVERTISED_HOST: '127.0.0.2',
      CLOAK_PLAYWRIGHT_MCP_CDP_ADVERTISED_SCHEME: 'https',
      CLOAK_PLAYWRIGHT_MCP_CDP_ENABLED: 'true',
      CLOAK_PLAYWRIGHT_MCP_CDP_PORT_RANGE: String(port),
    },
    stderr: 'pipe',
  } as const;
  const transport = new StdioClientTransport(stdioClientTransportOptions);
  const stderr = { text: '' };
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderr.text += chunk.toString();
  });
  const clientOptions = { name: `managed-cdp-tls-${engine}-e2e`, version: '1.0.0' } as const;
  const client = new Client(clientOptions);
  try {
    const connectResult = client.connect(transport);
    const message7 = `Packaged ${engine} TLS MCP timed out`;
    await withTimeout(connectResult, 75000, message7);
    const cdp = await readCdpInfo(client);
    expect(cdp.discoveryUrl).toMatch(/^https:\/\/127\.0\.0\.2:/u);
    return { cdp, client, stderr };
  } catch (error) {
    await client.close().catch(() => undefined);
    throwManagedCdpStartupError(engine, stderr.text, error);
  }
}
async function requestHttpsJson(url: URL): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const createHttpsRequestOptions = {
      headers: { Host: url.host, Origin: `${url.protocol}//${url.host}` },
      rejectUnauthorized: false,
    } as const;
    const request = createHttpsRequest(url, createHttpsRequestOptions, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        if (response.statusCode !== 200) {
          const message8 = `TLS discovery returned ${String(response.statusCode)}`;
          const error2 = new Error(message8);
          reject(error2);
          return;
        }
        try {
          const toStringResult = Buffer.concat(chunks).toString('utf8');
          const parsedValue = JSON.parse(toStringResult) as unknown;
          resolve(parsedValue);
        } catch (error) {
          const argumentValue2 =
            error instanceof Error
              ? error
              : (() => {
                  const stringResult = String(error);
                  return new Error(stringResult);
                })();
          reject(argumentValue2);
        }
      });
    });
    request.once('error', reject);
    request.end();
  });
}
async function openTlsWebSocket(url: string): Promise<WebSocket> {
  const parsed = new URL(url);
  const webSocketOptions = {
    headers: { Host: parsed.host, Origin: `https://${parsed.host}` },
    rejectUnauthorized: false,
  } as const;
  const socket = new WebSocket(url, webSocketOptions);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}
async function sendCdpCommand(socket: WebSocket, method: string): Promise<Record<string, unknown>> {
  const id = 1;
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    const onMessage = (data: RawData): void => {
      const toStringResult2 = Buffer.from(data as ArrayBuffer).toString('utf8');
      const envelope = JSON.parse(toStringResult2) as {
        error?: unknown;
        id?: number;
        result?: Record<string, unknown>;
      };
      if (envelope.id !== id) return;
      socket.off('message', onMessage);
      if (envelope.error !== undefined) {
        const serializedValue2 = JSON.stringify(envelope.error);
        const error3 = new Error(serializedValue2);
        reject(error3);
      } else {
        const computedValue3 = envelope.result ?? {};
        resolve(computedValue3);
      }
    };
    socket.on('message', onMessage);
    socket.once('error', reject);
  });
  const stringifyOptions = { id, method } as const;
  const serializedValue3 = JSON.stringify(stringifyOptions);
  socket.send(serializedValue3);
  const message9 = `Timed out waiting for ${method}`;
  return await withTimeout(response, 10000, message9);
}
async function closeWebSocket(socket: WebSocket | undefined): Promise<void> {
  if (socket === undefined || socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.close();
  await withTimeout(closed, 5000, 'TLS WebSocket did not close');
}
async function startPackagedHttpBridge(
  engine: BrowserEngine,
  processEnabled: boolean,
  range: {
    end: number;
    start: number;
  },
): Promise<RunningHttpBridge> {
  const { PLAYWRIGHT_MCP_CLI_PATH: _fakeUpstream, ...baseEnv } = packagedCommand.env;
  const argumentValue3 = packagedCommand.command;
  const values11: readonly string[] | undefined = [
    ...(packagedCommand.args ?? []),
    '--transport',
    'streamable-http',
    '--http-host',
    '127.0.0.1',
    '--http-port',
    '0',
  ];
  const spawnOptions = {
    env: {
      ...baseEnv,
      PLAYWRIGHT_MCP_BROWSER_ENGINE: engine,
      PLAYWRIGHT_MCP_HEADLESS: 'true',
      CLOAK_PLAYWRIGHT_MCP_CDP_ENABLED: String(processEnabled),
      CLOAK_PLAYWRIGHT_MCP_CDP_PORT_RANGE: `${String(range.start)}-${String(range.end)}`,
    },
  } as const;
  const child = spawn(argumentValue3, values11, spawnOptions);
  const stdout = collectChildStream(child.stdout);
  const stderr = collectChildStream(child.stderr);
  try {
    const line = await waitForChildLine(child, stderr, /streamable-http listening/u, 75000);
    const match = /url=(?<url>\S+)$/u.exec(line);
    if (match?.groups?.url === undefined) {
      const message10 = `Could not parse HTTP URL from: ${line}`;
      throw new Error(message10);
    }
    return { child, stderr, stdout, url: new URL(match.groups.url) };
  } catch (error) {
    await terminateChild(child);
    const message11 = `Packaged ${engine} HTTP startup failed: ${redactCdpCapabilities(stderr.text)}; reason: ${safeErrorMessage(error)}`;
    const errorOptions = { cause: error } as const;
    throw new Error(message11, errorOptions);
  }
}
async function closePackagedHttpBridge(server: RunningHttpBridge): Promise<void> {
  await terminateChild(server.child);
  expect(server.stderr.text).not.toMatch(/fatal:|Unhandled|Error:/iu);
  expect(server.stdout.text).toBe('');
}
async function initializeRawHttpSession(
  server: RunningHttpBridge,
  bridgeMeta?: Record<string, unknown>,
): Promise<RawHttpSession> {
  const argumentValue4 = server.url;
  const postJsonRpcOptions = {
    jsonrpc: JSON_RPC_VERSION,
    id: randomUUID(),
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'managed-cdp-http-e2e', version: '1.0.0' },
      ...(bridgeMeta === undefined ? {} : { _meta: { [BRIDGE_INITIALIZE_META_KEY]: bridgeMeta } }),
    },
  } as const;
  const response = await postJsonRpc(argumentValue4, postJsonRpcOptions);
  expect(response.status).toBe(200);
  await readJsonRpcResult(response);
  const id = response.headers.get(MCP_SESSION_ID_HEADER);
  if (id === null) throw new Error('HTTP initialize response did not include a session id');
  const postJsonRpcOptions2 = { jsonrpc: JSON_RPC_VERSION, method: 'notifications/initialized' } as const;
  const initialized = await postJsonRpc(server.url, postJsonRpcOptions2, id);
  expect(initialized.status).toBe(202);
  return { id, server };
}
async function closeRawHttpSession(session: RawHttpSession): Promise<void> {
  const argumentValue5 = session.server.url;
  const fetchOptions = {
    method: 'DELETE',
    headers: { [MCP_SESSION_ID_HEADER]: session.id },
  } as const;
  await fetch(argumentValue5, fetchOptions);
}
async function callHttpTool(
  session: RawHttpSession,
  name: string,
  arguments_: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const argumentValue6 = session.server.url;
  const postJsonRpcOptions3 = {
    jsonrpc: JSON_RPC_VERSION,
    id: randomUUID(),
    method: 'tools/call',
    params: { name, arguments: arguments_ },
  } as const;
  const response = await postJsonRpc(argumentValue6, postJsonRpcOptions3, session.id);
  expect(response.status).toBe(200);
  const result = (await readJsonRpcResult(response)) as CallToolResult;
  if (result.isError === true) {
    const serializedValue4 = JSON.stringify(result.content);
    throw new Error(serializedValue4);
  }
  return result;
}
async function readHttpCdpState(session: RawHttpSession): Promise<
  | {
      enabled: false;
    }
  | ReadyCdpInfo
  | UnavailableCdpInfo
> {
  const result = await callHttpTool(session, LOCAL_TOOL_BRIDGE_INFO);
  const cdp = result.structuredContent?.cdp as
    | {
        enabled: false;
      }
    | ReadyCdpInfo
    | UnavailableCdpInfo
    | undefined;
  if (cdp === undefined) throw new Error('HTTP bridge info omitted managed CDP state');
  return cdp;
}
async function readHttpCdpInfo(session: RawHttpSession): Promise<ReadyCdpInfo> {
  const cdp = await readHttpCdpState(session);
  if (cdp.enabled !== true || cdp.state !== 'ready') {
    const message12 = `Managed HTTP CDP is not ready: ${JSON.stringify(cdp)}`;
    throw new Error(message12);
  }
  return cdp;
}
async function postJsonRpc(url: URL, body: unknown, sessionId?: string): Promise<Response> {
  const fetchOptions2 = {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...(sessionId === undefined ? {} : { [MCP_SESSION_ID_HEADER]: sessionId }),
    },
    body: JSON.stringify(body),
  } as const;
  return await fetch(url, fetchOptions2);
}
async function readJsonRpcResult(response: Response): Promise<unknown> {
  const text = await response.text();
  const serialized = response.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split(/\r?\n/u)
        .find((line) => line.startsWith('data: '))
        ?.slice('data: '.length)
    : text;
  if (serialized === undefined || serialized.length === 0) {
    const message13 = `Expected JSON-RPC response body, got: ${text}`;
    throw new Error(message13);
  }
  const envelope = JSON.parse(serialized) as {
    error?: unknown;
    result?: unknown;
  };
  if (envelope.error !== undefined) {
    const serializedValue5 = JSON.stringify(envelope.error);
    throw new Error(serializedValue5);
  }
  return envelope.result;
}
function collectChildStream(stream: Readable): {
  text: string;
} {
  const collected = { text: '' };
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    collected.text += chunk;
  });
  return collected;
}
async function waitForChildLine(
  child: ChildProcessWithoutNullStreams,
  stream: {
    text: string;
  },
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = stream.text.split(/\r?\n/u).find((candidate) => pattern.test(candidate));
    if (line !== undefined) return line;
    if (child.exitCode !== null)
      throw (() => {
        const message14 = `HTTP bridge exited with ${String(child.exitCode)}`;
        return new Error(message14);
      })();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const message15 = `Timed out waiting for child output matching ${String(pattern)}`;
  throw new Error(message15);
}
async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await withTimeout(exited, 10000, 'Packaged HTTP bridge did not exit after SIGTERM');
}
async function readManagedBrowserProcess(browser: Browser): Promise<{ arguments: string[]; pid: number }> {
  const session = await browser.newBrowserCDPSession();
  try {
    const result = await session.send('SystemInfo.getProcessInfo');
    const processInfo = result.processInfo.find((info) => info.type === 'browser');
    if (!processInfo) throw new Error('Missing owned managed browser PID');
    let arguments_: string[];
    if (process.platform === 'linux') {
      const filename = `/proc/${processInfo.id}/cmdline`;
      const bytes = await readFile(filename);
      arguments_ = bytes.toString('utf8').split('\0').filter(Boolean);
    } else {
      const commandLine = await session.send('Browser.getBrowserCommandLine');
      arguments_ = commandLine.arguments;
    }
    return { arguments: arguments_, pid: processInfo.id };
  } finally {
    await session.detach();
  }
}
async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}
async function startPackagedBridge(engine: BrowserEngine): Promise<RunningBridge> {
  const port = await findFreePort();
  const { PLAYWRIGHT_MCP_CLI_PATH: _fakeUpstream, ...baseEnv } = packagedCommand.env;
  const stdioClientTransportOptions2 = {
    command: packagedCommand.command,
    args: packagedCommand.args,
    env: {
      ...baseEnv,
      PLAYWRIGHT_MCP_BROWSER_ENGINE: engine,
      PLAYWRIGHT_MCP_HEADLESS: 'true',
      CLOAK_PLAYWRIGHT_MCP_CDP_ENABLED: 'true',
      CLOAK_PLAYWRIGHT_MCP_CDP_PORT_RANGE: String(port),
    },
    stderr: 'pipe',
  } as const;
  const transport = new StdioClientTransport(stdioClientTransportOptions2);
  const stderr = { text: '' };
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderr.text += chunk.toString();
  });
  const clientOptions2 = { name: `managed-cdp-${engine}-e2e`, version: '1.0.0' } as const;
  const client = new Client(clientOptions2);
  try {
    const connectResult2 = client.connect(transport);
    const message18 = `Packaged ${engine} MCP initialize timed out`;
    await withTimeout(connectResult2, 75000, message18);
    const cdp = await readCdpInfo(client);
    const browser = await connectOverManagedCdp(cdp.discoveryUrl);
    const browserProcess = await readManagedBrowserProcess(browser);
    const argumentValue7 = new URL(cdp.discoveryUrl).pathname;
    const includesResult2 = stderr.text.includes(argumentValue7);
    expect(includesResult2).toBe(false);
    return { browser, browserProcess, cdp, client, stderr };
  } catch (error) {
    await client.close().catch(() => undefined);
    throwManagedCdpStartupError(engine, stderr.text, error);
  }
}
async function closePackagedBridge(bridge: RunningBridge): Promise<void> {
  await bridge.browser.close().catch(() => undefined);
  const callToolOptions4 = { name: 'browser_close', arguments: {} } as const;
  await bridge.client.callTool(callToolOptions4).catch(() => undefined);
  await bridge.client.close().catch(() => undefined);
}
async function readCdpInfo(client: Client): Promise<ReadyCdpInfo> {
  const cdp = await readBridgeCdpInfo(client);
  if (cdp?.enabled !== true || cdp.state !== 'ready') {
    const message19 = `Managed CDP is not ready: ${describeCdpInfo(cdp)}`;
    throw new Error(message19);
  }
  return cdp;
}
async function readBridgeCdpInfo(client: Client): Promise<ReadyCdpInfo | UnavailableCdpInfo> {
  const result = await callTool(client, LOCAL_TOOL_BRIDGE_INFO);
  const cdp = result.structuredContent?.cdp as ReadyCdpInfo | UnavailableCdpInfo | undefined;
  if (cdp?.enabled !== true) {
    const message20 = `Managed CDP is disabled: ${describeCdpInfo(cdp)}`;
    throw new Error(message20);
  }
  return cdp;
}
async function connectOverManagedCdp(discoveryUrl: string): Promise<Browser> {
  try {
    return await chromium.connectOverCDP(discoveryUrl);
  } catch (error) {
    throwManagedCdpConnectionError(error);
  }
}
function throwManagedCdpStartupError(engine: BrowserEngine, stderr: string, error: unknown): never {
  const safeMessage = safeErrorMessage(error);
  const message21 = `Packaged ${engine} managed CDP startup failed: ${redactCdpCapabilities(stderr)}; reason: ${safeMessage}`;
  const errorOptions2 = { cause: new Error(safeMessage) } as const;
  throw new Error(message21, errorOptions2);
}
function throwManagedCdpConnectionError(error: unknown): never {
  const safeMessage = safeErrorMessage(error);
  const message22 = `Managed CDP connection failed: ${safeMessage}`;
  const errorOptions3 = {
    cause: new Error(safeMessage),
  } as const;
  throw new Error(message22, errorOptions3);
}
function describeCdpInfo(cdp: ReadyCdpInfo | UnavailableCdpInfo | undefined): string {
  if (cdp === undefined) return 'missing';
  return [
    `state=${cdp.state}`,
    `generation=${String(cdp.generation)}`,
    `port=${String(cdp.port)}`,
    `activeConnections=${String(cdp.activeConnections)}`,
  ].join(', ');
}
function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactCdpCapabilities(error.message);
  if (typeof error === 'string') return redactCdpCapabilities(error);
  return 'unknown error';
}
function redactCdpCapabilities(value: string): string {
  return value.replace(/\/cdp\/[A-Za-z0-9_-]{43}(?=[/?#]|$)/gu, '/cdp/<redacted>');
}
function readNativeArchitecture(): 'linux/amd64' | 'linux/arm64' {
  if (process.platform !== 'linux') throw new Error('Managed CDP runtime evidence requires Linux');
  if (process.arch === 'x64') return 'linux/amd64';
  if (process.arch === 'arm64') return 'linux/arm64';
  const message23 = `Unsupported managed CDP runtime architecture: ${process.arch}`;
  throw new Error(message23);
}
async function callTool(
  client: Client,
  name: string,
  arguments_: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const callToolOptions5 = { name, arguments: arguments_ } as const;
  const result = (await client.callTool(callToolOptions5)) as CallToolResult;
  if (result.isError === true) {
    const serializedValue6 = JSON.stringify(result.content);
    throw new Error(serializedValue6);
  }
  return result;
}
async function expectToolSuccess(
  client: Client,
  name: string,
  arguments_: Record<string, unknown> = {},
): Promise<void> {
  await callTool(client, name, arguments_);
}
async function findPage(browser: Browser, urlPrefix: string): Promise<Page> {
  await expect
    .poll(() =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().startsWith(urlPrefix)),
    )
    .toBeDefined();
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((item) => item.url().startsWith(urlPrefix));
  if (page === undefined) {
    const message24 = `Expected page with URL prefix ${urlPrefix}`;
    throw new Error(message24);
  }
  return page;
}
async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Expected TCP address');
  await closeServer(server);
  return address.port;
}
async function findFreePortRange(size: number): Promise<{
  end: number;
  start: number;
}> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const start = await findFreePort();
    if (start + size - 1 > 65535) continue;
    const reservations: Server[] = [];
    try {
      for (let offset = 0; offset < size; offset += 1) {
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          const computedValue4 = start + offset;
          server.listen(computedValue4, '127.0.0.1', resolve);
        });
        reservations.push(server);
      }
      const mappedValues7 = reservations.map(async (server) => await closeServer(server));
      await Promise.all(mappedValues7);
      return { end: start + size - 1, start };
    } catch {
      const mappedValues8 = reservations.map(async (server) => await closeServer(server));
      await Promise.allSettled(mappedValues8);
    }
  }
  const message25 = `Unable to reserve a contiguous ${String(size)}-port range`;
  throw new Error(message25);
}
async function startFixtureServer(): Promise<{
  close(): Promise<void>;
  url: string;
}> {
  const server = createServer((_request, response) => {
    const writeHeadOptions = { 'content-type': 'text/html; charset=utf-8' } as const;
    response.writeHead(200, writeHeadOptions);
    response.end('<!doctype html><title>MCP to CDP</title><main>shared state</main>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Expected fixture address');
  return {
    close: async () => await closeServer(server),
    url: `http://127.0.0.1:${String(address.port)}/`,
  };
}
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const values12: [Promise<T>, Promise<T>] = [
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error4 = new Error(message);
          return reject(error4);
        }, timeoutMs);
        timer.unref();
      }),
    ];
    return await Promise.race(values12);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
