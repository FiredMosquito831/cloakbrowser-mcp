import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupDistributionE2e,
  createTempRoot,
  expectDistributionStdioBridge,
  packAndInstallCurrentPackage,
} from './distributionHarness.js';
import { startNpmBrowserFixture } from '@tests/e2e/npm-browser-fixture.js';
afterEach(() => {
  cleanupDistributionE2e();
});
describe('npm package distribution E2E', () => {
  it('runs the installed package as a stdio MCP bridge and forwards every fake upstream tool', async () => {
    const packAndInstallCurrentPackageResult = packAndInstallCurrentPackage();
    await expectDistributionStdioBridge(packAndInstallCurrentPackageResult);
  });
  it('keeps navigation alive and exercises every tool through the installed package', async () => {
    const command = packAndInstallCurrentPackage();
    const outputDir = command.env.PLAYWRIGHT_MCP_OUTPUT_DIR;
    if (!outputDir) throw new Error('Missing temporary Playwright MCP output directory');
    const filename = path.join(outputDir, 'find-results.md');
    const dirnameResult = path.dirname(outputDir);
    const upstreamCli = path.join(dirnameResult, 'node_modules', '@playwright', 'mcp', 'cli.js');
    const env: Record<string, string> = {
      ...command.env,
      PLAYWRIGHT_MCP_BROWSER_ENGINE: 'cloak',
      CLOAKBROWSER_AUTO_UPDATE: 'false',
      CLOAK_PLAYWRIGHT_MCP_CONSOLE_FALLBACK: 'true',
      DEBUG: 'pw:browser',
    };
    delete env.PLAYWRIGHT_MCP_CLI_PATH;
    const stdioClientTransportOptions = { command: command.command, env, stderr: 'pipe' } as const;
    const transport = new StdioClientTransport(stdioClientTransportOptions);
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const clientOptions = { name: 'npm package real upstream e2e client', version: '1.0.0' } as const;
    const client = new Client(clientOptions);
    const stdioClientTransportOptions2: import('@modelcontextprotocol/sdk/client/stdio.js').StdioServerParameters =
      {
        command: process.execPath,
        args: [upstreamCli],
        env,
        stderr: 'pipe',
      };
    const upstreamTransport = new StdioClientTransport(stdioClientTransportOptions2);
    const clientOptions2 = { name: 'official Playwright MCP e2e client', version: '1.0.0' } as const;
    const upstreamClient = new Client(clientOptions2);
    const fixture = await startNpmBrowserFixture();
    const visited = new Set<string>();
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      visited.add(name);
      const callToolOptions = { name, arguments: args } as const;
      const result = await client.callTool(callToolOptions);
      if (result.isError) {
        const serialized = JSON.stringify(result);
        const exits = serialized.match(/exitCode=\d+/gu) ?? [];
        const message = `${name}: ${exits.join(', ')}\n${serialized.replaceAll('\\n', '\n')}\n${stderr}`;
        throw new Error(message);
      }
      return JSON.stringify(result);
    };
    try {
      const values2: [Promise<void>, Promise<void>] = [
        client.connect(transport),
        upstreamClient.connect(upstreamTransport),
      ];
      await Promise.all(values2);
      const tools = await client.listTools();
      const upstreamTools = await upstreamClient.listTools();
      const sliceResult = tools.tools.slice(0, -2);
      expect(sliceResult).toEqual(upstreamTools.tools);
      expect(upstreamTools.tools).toHaveLength(25);
      const find = tools.tools.find((tool) => tool.name === 'browser_find');
      const receiverActual = find?.inputSchema.properties?.filename;
      const toMatchObjectOptions = { type: 'string' } as const;
      expect(receiverActual).toMatchObject(toMatchObjectOptions);
      const callOptions = { url: fixture.url } as const;
      const callResult = await call('browser_navigate', callOptions);
      expect(callResult).toContain(fixture.url);
      const immediateSnapshot = await call('browser_snapshot');
      expect(immediateSnapshot).toContain(fixture.url);
      expect(immediateSnapshot).toContain('Release marker');
      await setTimeout(500);
      const delayedSnapshot = await call('browser_snapshot');
      expect(delayedSnapshot).toContain(fixture.url);
      expect(delayedSnapshot).toContain('Release marker');
      const callOptions2 = { text: 'Release marker', filename } as const;
      await call('browser_find', callOptions2);
      const existsSyncResult = existsSync(filename);
      expect(existsSyncResult).toBe(true);
      const fileSyncResult = readFileSync(filename, 'utf8');
      expect(fileSyncResult).toContain('Release marker');
      const callOptions3 = { width: 1200, height: 900 } as const;
      await call('browser_resize', callOptions3);
      const callOptions4 = { target: '#name', text: 'Typed name' } as const;
      await call('browser_type', callOptions4);
      const callOptions5 = { function: '() => document.querySelector("#name").value' } as const;
      const callResult2 = await call('browser_evaluate', callOptions5);
      expect(callResult2).toContain('Typed name');
      const callOptions6 = { key: 'Enter' } as const;
      await call('browser_press_key', callOptions6);
      const callOptions7: Record<string, unknown> | undefined = {
        fields: [{ target: '#consent', name: 'Consent', type: 'checkbox', value: 'true' }],
      };
      await call('browser_fill_form', callOptions7);
      const callOptions8: Record<string, unknown> | undefined = { target: '#choice', values: ['b'] };
      await call('browser_select_option', callOptions8);
      const callOptions9 = { target: '#action' } as const;
      await call('browser_click', callOptions9);
      const callOptions10 = { text: 'Clicked' } as const;
      await call('browser_wait_for', callOptions10);
      const callResult3 = await call('browser_snapshot');
      expect(callResult3).toContain('Clicked');
      const callOptions11 = { target: '#hover' } as const;
      await call('browser_hover', callOptions11);
      const callResult4 = await call('browser_snapshot');
      expect(callResult4).toContain('Hovered');
      const callOptions12 = { startTarget: '#source', endTarget: '#drop' } as const;
      await call('browser_drag', callOptions12);
      const callOptions13 = { target: '#drop', data: { 'text/plain': 'Dropped' } } as const;
      await call('browser_drop', callOptions13);
      const callResult5 = await call('browser_snapshot');
      expect(callResult5).toContain('Dropped');
      const upload = path.join(outputDir, 'upload.txt');
      writeFileSync(upload, 'Fixture upload');
      const callOptions14 = { target: '#file' } as const;
      await call('browser_click', callOptions14);
      const callOptions15: Record<string, unknown> | undefined = { paths: [upload] };
      await call('browser_file_upload', callOptions15);
      const callResult6 = await call('browser_snapshot');
      expect(callResult6).toContain('upload.txt');
      const callOptions16 = { target: '#dialog' } as const;
      await call('browser_click', callOptions16);
      const callOptions17 = { accept: true } as const;
      await call('browser_handle_dialog', callOptions17);
      const callOptions18 = { level: 'warning' } as const;
      const callResult7 = await call('browser_console_messages', callOptions18);
      expect(callResult7).toContain('Fixture console');
      const callOptions19 = { static: true } as const;
      const callResult8 = await call('browser_network_requests', callOptions19);
      expect(callResult8).toContain('/api');
      const callOptions20 = { index: 1 } as const;
      const callResult9 = await call('browser_network_request', callOptions20);
      expect(callResult9).toContain(fixture.url);
      const callOptions21 = { colorScheme: 'dark' } as const;
      await call('browser_emulate_media', callOptions21);
      const callOptions22 = {
        function: '() => matchMedia("(prefers-color-scheme: dark)").matches',
      } as const;
      const callResult10 = await call('browser_evaluate', callOptions22);
      expect(callResult10).toContain('true');
      const screenshot = path.join(outputDir, 'fixture.png');
      const callOptions23 = { filename: screenshot, scale: 'css' } as const;
      await call('browser_take_screenshot', callOptions23);
      const existsSyncResult2 = existsSync(screenshot);
      expect(existsSyncResult2).toBe(true);
      const callOptions24 = { code: 'async (page) => page.title()' } as const;
      const callResult11 = await call('browser_run_code_unsafe', callOptions24);
      expect(callResult11).toContain('Release fixture');
      const callOptions25 = { action: 'new', url: `${fixture.url}/new` } as const;
      await call('browser_tabs', callOptions25);
      const callResult12 = await call('browser_snapshot');
      expect(callResult12).toContain('Release marker');
      const callOptions26 = { action: 'close' } as const;
      await call('browser_tabs', callOptions26);
      const callOptions27 = { url: `${fixture.url}/second` } as const;
      await call('browser_navigate', callOptions27);
      const callResult13 = await call('browser_navigate_back');
      expect(callResult13).toContain(fixture.url);
      await call('cloakbrowser_binary_info');
      await call('cloakbrowser_bridge_info');
      await call('browser_close');
      const sortResult = [...visited].sort();
      const receiver2Actual = sortResult;
      const sortResult2 = tools.tools.map((tool) => tool.name).sort();
      expect(receiver2Actual).toEqual(sortResult2);
    } catch (cause) {
      const message2 = `Packaged browser E2E failed. Browser PID/exit diagnostics:\n${stderr}`;
      const errorOptions = { cause } as const;
      throw new Error(message2, errorOptions);
    } finally {
      const values3: [Promise<void>, Promise<void>] = [client.close(), upstreamClient.close()];
      await Promise.allSettled(values3);
      await fixture.close();
    }
  });
  it('reuses the persistent profile seed after restarting the installed bridge', async () => {
    const command = packAndInstallCurrentPackage();
    const fixture = await startNpmBrowserFixture();
    const computedValue = command.env.PLAYWRIGHT_MCP_OUTPUT_DIR ?? '';
    const dirnameResult2 = path.dirname(computedValue);
    const profile = path.join(dirnameResult2, 'profile');
    const env: Record<string, string> = {
      ...command.env,
      PLAYWRIGHT_MCP_BROWSER_ENGINE: 'cloak',
      PLAYWRIGHT_MCP_USER_DATA_DIR: profile,
      CLOAKBROWSER_AUTO_UPDATE: 'false',
    };
    delete env.PLAYWRIGHT_MCP_CLI_PATH;
    let seed: string | undefined;
    try {
      for (let run = 0; run < 2; run += 1) {
        const clientOptions3 = { name: 'profile restart e2e', version: '1' } as const;
        const client = new Client(clientOptions3);
        const stdioClientTransportOptions3 = { command: command.command, env, stderr: 'pipe' } as const;
        const transport = new StdioClientTransport(stdioClientTransportOptions3);
        try {
          await client.connect(transport);
          const callToolOptions2 = {
            name: 'browser_navigate',
            arguments: { url: fixture.url },
          } as const;
          const navigation = await client.callTool(callToolOptions2);
          expect(navigation.isError).not.toBe(true);
          const joinedPath = path.join(profile, '.cloakbrowser-seed');
          const current = readFileSync(joinedPath, 'utf8');
          expect(current).toMatch(/^[1-9][0-9]{4}\n$/u);
          seed ??= current;
          expect(current).toBe(seed);
          const callToolOptions3 = { name: 'browser_close', arguments: {} } as const;
          const close = await client.callTool(callToolOptions3);
          expect(close.isError).not.toBe(true);
        } finally {
          await client.close();
        }
      }
    } finally {
      await fixture.close();
    }
  });
  const values4: readonly string[] = ['default', 'careful'];
  it.each(values4)('runs the revised humanize engine with preset %s', async (preset) => {
    const command = packAndInstallCurrentPackage();
    const fixture = await startNpmBrowserFixture();
    const options = { ...command.env };
    const propertyValue = 'cloak';
    const propertyValue2 = 'true';
    const currentPreset = preset;
    const propertyValue3 = 'false';
    const propertyValue4 = 'pw:browser';
    const computedValue2 = command.env.PLAYWRIGHT_MCP_OUTPUT_DIR ?? '';
    const dirnameResult3 = path.dirname(computedValue2);
    const joinedPath2 = path.join(dirnameResult3, 'profile');
    const env: Record<string, string> = {
      ...options,
      PLAYWRIGHT_MCP_BROWSER_ENGINE: propertyValue,
      CLOAK_PLAYWRIGHT_MCP_HUMANIZE: propertyValue2,
      CLOAK_PLAYWRIGHT_MCP_HUMAN_PRESET: currentPreset,
      CLOAKBROWSER_AUTO_UPDATE: propertyValue3,
      DEBUG: propertyValue4,
      PLAYWRIGHT_MCP_USER_DATA_DIR: joinedPath2,
    };
    delete env.PLAYWRIGHT_MCP_CLI_PATH;
    const stdioClientTransportOptions4 = { command: command.command, env, stderr: 'pipe' } as const;
    const transport = new StdioClientTransport(stdioClientTransportOptions4);
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const clientOptions4 = { name: 'humanized npm e2e', version: '1' } as const;
    const client = new Client(clientOptions4);
    const call = async (name: string, args: Record<string, unknown>) => {
      const callToolOptions4 = { name, arguments: args } as const;
      const result = await client.callTool(callToolOptions4);
      if (result.isError) {
        const message3 = `${name}: ${JSON.stringify(result).replaceAll('\\n', '\n')}\n${stderr}`;
        throw new Error(message3);
      }
      return JSON.stringify(result);
    };
    try {
      await client.connect(transport);
      const callOptions28 = { url: fixture.url } as const;
      await call('browser_navigate', callOptions28);
      await setTimeout(500);
      const callOptions29 = {} as const;
      const callResult14 = await call('browser_snapshot', callOptions29);
      expect(callResult14).toContain('Release marker');
      const code = `async (page) => {
        page.setDefaultTimeout(5000);
        const filterOptions = { hasText: /^Action$/ };
        const clickOptions = { modifiers: ['Shift'] };
        await page.getByRole('button').filter(filterOptions).click(clickOptions);
        const frameButtonOptions = { name: 'Frame action' };
        await page.frameLocator('iframe').getByRole('button', frameButtonOptions).click();
        await page.locator('.duplicate').nth(1).click();
        await page.locator('#name').fill('Humanized');
        await page.locator('#name').press('ControlOrMeta+A');
        await page.locator('#name').press('Backspace');
        await page.locator('#date').fill('2026-10-09');
        await page.locator('#choice').selectOption('b');
        if (await page.locator('#name').inputValue() !== '') throw new Error('Select-all did not clear input');
        if (await page.locator('#choice').inputValue() !== 'b') throw new Error('Selection did not change');
        return { frame: await page.frameLocator('iframe').getByRole('button').innerText(),
          date: await page.locator('#date').inputValue() };
      }`;
      const callOptions30 = { code } as const;
      const result = await call('browser_run_code_unsafe', callOptions30);
      expect(result).toContain('Frame clicked');
      expect(result).toContain('2026-10-09');
      for (const [code, expected] of [
        [
          "async (page) => { const clickOptions = { timeout: 1000 }; return page.locator('.duplicate').click(clickOptions); }",
          'strict mode violation',
        ],
        [
          "async (page) => { const fillOptions = { timeout: 1000 }; return page.locator('#color').fill('#123456', fillOptions); }",
          'color',
        ],
      ]) {
        const callToolOptions5 = { name: 'browser_run_code_unsafe', arguments: { code } } as const;
        const failure = await client.callTool(callToolOptions5);
        expect(failure.isError).toBe(true);
        const serializedValue = JSON.stringify(failure);
        expect(serializedValue).toContain(expected);
      }
      for (const [property, hiddenValue, visibleValue, expectedError] of [
        ['visibility', 'hidden', 'visible', 'element is not visible'],
        ['display', 'none', 'block', 'TimeoutError: locator.click: Timeout 1000ms exceeded.'],
      ]) {
        const callToolOptions6 = {
          name: 'browser_run_code_unsafe',
          arguments: {
            code: `async (page) => {
              await page.locator('iframe').evaluate((element) => { element.style.${property} = '${hiddenValue}'; });
              const clickOptions = { timeout: 1000 };
              await page.frameLocator('iframe').getByRole('button').click(clickOptions);
            }`,
          },
        } as const;
        const hiddenFrame = await client.callTool(callToolOptions6);
        expect(hiddenFrame.isError).toBe(true);
        const serializedValue2 = JSON.stringify(hiddenFrame);
        expect(serializedValue2).toContain(expectedError);
        const callOptions31 = {
          code: `async (page) => page.locator('iframe').evaluate((element) => { element.style.${property} = '${visibleValue}'; })`,
        } as const;
        await call('browser_run_code_unsafe', callOptions31);
        const callOptions32 = {
          code: `async (page) => {
            const clicks = await page.frameLocator('iframe').getByRole('button').getAttribute('data-clicks');
            if (clicks !== '1') throw new Error('A hidden iframe received a click');
            return 'Hidden iframe click count unchanged';
          }`,
        } as const;
        await call('browser_run_code_unsafe', callOptions32);
      }
      const callOptions33 = { action: 'new', url: `${fixture.url}/new` } as const;
      await call('browser_tabs', callOptions33);
      const callOptions34 = { target: '#action' } as const;
      await call('browser_click', callOptions34);
      const callOptions35 = {} as const;
      const callResult15 = await call('browser_snapshot', callOptions35);
      expect(callResult15).toContain('Clicked');
      const callOptions36 = {
        code: `async (page) => {
          const session = await page.context().newCDPSession(page);
          try {
            const liveId = await page._stealth.evaluate("__cloakH.resolve('#action', true).id");
            await session.send('HeapProfiler.collectGarbage');
            const liveElementExpression = '__cloakH.el(' + liveId + ').isConnected';
            if (!(await page._stealth.evaluate(liveElementExpression))) {
              throw new Error('Humanize lost a live DOM element during garbage collection');
            }
            const baseline = await session.send('Memory.getDOMCounters');
            for (let round = 0; round < 2; round++) {
              await page._stealth.evaluate(
                "(() => { for (let i = 0; i < 1000; i++) { const el = document.createElement('button'); el.id = 'memory-probe'; document.body.append(el); __cloakH.resolve('#memory-probe', true); el.remove(); } return true; })()"
              );
              await session.send('HeapProfiler.collectGarbage');
              const current = await session.send('Memory.getDOMCounters');
              if (current.nodes > baseline.nodes + 10) {
                const message = 'Humanize retained detached DOM nodes: ' + baseline.nodes + ' -> ' + current.nodes;
                throw new Error(message);
              }
            }
          } finally {
            await session.detach();
          }
          return 'Detached DOM nodes collected';
        }`,
      } as const;
      await call('browser_run_code_unsafe', callOptions36);
      const profile = env.PLAYWRIGHT_MCP_USER_DATA_DIR;
      if (!profile) throw new Error('Missing temporary persistent profile');
      const joinedPath3 = path.join(profile, '.cloakbrowser-seed');
      const fileSyncResult2 = readFileSync(joinedPath3, 'utf8');
      expect(fileSyncResult2).toMatch(/^[1-9][0-9]{4}\n$/u);
    } finally {
      await client.close();
      await fixture.close();
    }
  });
  it('downloads safely from two processes into a cold cache without stdout status messages', async () => {
    const command = packAndInstallCurrentPackage();
    const computedValue3 = command.env.PLAYWRIGHT_MCP_OUTPUT_DIR ?? '';
    const installDir = path.dirname(computedValue3);
    const home = createTempRoot('cloak-cold-cache-');
    const env: Record<string, string> = {
      ...command.env,
      HOME: home,
      USERPROFILE: home,
      CLOAKBROWSER_CACHE_DIR: path.join(home, 'cache'),
      CLOAKBROWSER_LICENSE_KEY: '',
      CLOAKBROWSER_AUTO_UPDATE: 'false',
    };
    delete env.CLOAKBROWSER_BINARY_PATH;
    const code =
      "import { ensureBinary } from 'cloakbrowser'; const binary = await ensureBinary(); const result = { binary }; const encoded = JSON.stringify(result); const output = encoded + '\\n'; process.stdout.write(output);";
    const children: ReturnType<typeof spawn>[] = [];
    let outputs: string[];
    try {
      const fromOptions = { length: 2 } as const;
      const fromResult = Array.from(
        fromOptions,
        () =>
          new Promise<string>((resolve, reject) => {
            const values5: readonly string[] | undefined = ['--input-type=module', '-e', code];
            const spawnOptions = {
              cwd: installDir,
              env,
            } as const;
            const child = spawn(process.execPath, values5, spawnOptions);
            children.push(child);
            const timeout = globalThis.setTimeout(() => {
              child.kill('SIGKILL');
            }, 120000);
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk: Buffer) => {
              stdout += chunk.toString();
            });
            child.stderr.on('data', (chunk: Buffer) => {
              stderr += chunk.toString();
            });
            child.once('error', (error) => {
              globalThis.clearTimeout(timeout);
              reject(error);
            });
            child.once('close', (exitCode, signal) => {
              globalThis.clearTimeout(timeout);
              if (exitCode === 0) resolve(stdout);
              else {
                const message4 = `Concurrent download failed: exit=${String(exitCode)} signal=${String(signal)}\n${stderr}`;
                const error2 = new Error(message4);
                reject(error2);
              }
            });
          }),
      );
      outputs = await Promise.all(fromResult);
    } finally {
      const mappedValues = children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
        child.kill('SIGKILL');
        await closed;
      });
      await Promise.all(mappedValues);
    }
    expect(outputs[0]).toBe(outputs[1]);
    expect(outputs[0]).toMatch(/^\{"binary":"[^\n]+"\}\n$/u);
    const computedValue4 = outputs[0] ?? '';
    const result = JSON.parse(computedValue4) as {
      binary: string;
    };
    const existsSyncResult3 = existsSync(result.binary);
    expect(existsSyncResult3).toBe(true);
  });
});
import { spawn } from 'node:child_process';
