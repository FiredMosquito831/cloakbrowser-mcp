import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { patchHelpers, patchWorld } from '@/runtime/humanizeCompatibilityLoader.js';
const require = createRequire(import.meta.url);
const resolvedValue = require.resolve('cloakbrowser');
const dependencyDir = path.dirname(resolvedValue);
const joinedPath = path.join(dependencyDir, 'human', 'worldHelpers.js');
const helpers = readFileSync(joinedPath, 'utf8');
const joinedPath2 = path.join(dependencyDir, 'human', 'world.js');
const world = readFileSync(joinedPath2, 'utf8');
interface Helpers {
  resolve(
    selector: string,
    strict: boolean,
  ): {
    id: number;
  };
  el(id: number): unknown;
  states(id: number, states: string[], frameVisible: boolean): Promise<unknown>;
}
interface Frame {
  parentFrame(): Frame | null;
  frameElement(): Promise<{
    isVisible(): Promise<boolean>;
    dispose(): Promise<void>;
  }>;
}
interface World {
  evaluate(frame: Frame, expression: string): Promise<unknown>;
  call(frame: Frame, method: string, ...args: unknown[]): Promise<unknown>;
}
describe('verified installed CloakBrowser humanize compatibility', () => {
  it('rejects dependency source changes before applying any patch', () => {
    expect(() => {
      const message = `${helpers}\n`;
      return patchHelpers(message);
    }).toThrow('does not match');
    expect(() => {
      const message2 = `${world}\n`;
      return patchWorld(message2);
    }).toThrow('does not match');
  });
  it('reuses element IDs and removes collected entries without retaining elements', async () => {
    const source = patchHelpers(helpers);
    const message3 = `${source.replaceAll('export const ', 'const ')}\nHELPERS_JS;`;
    const helperJs = runInNewContext(message3) as string;
    const element = {};
    const callbacks: Array<(id: number) => void> = [];
    class Collector {
      constructor(callback: (id: number) => void) {
        callbacks.push(callback);
      }
      register() {}
    }
    const checkStates = vi.fn(async (_element: unknown, _states: string[], visible: boolean) =>
      visible ? undefined : { missingState: 'visible' },
    );
    const context = {
      document: {},
      FinalizationRegistry: Collector,
      __cloakInjected: {
        parseSelector: (selector: string) => selector,
        querySelectorAll: () => [element],
        checkElementStates: checkStates,
      },
    };
    runInNewContext(helperJs, context);
    const patched = runInNewContext('__cloakH', context) as Helpers;
    const id = patched.resolve('button', true).id;
    const argumentValue = patched.resolve('button', true).id;
    expect(argumentValue).toBe(id);
    const elResult = patched.el(id);
    expect(elResult).toBe(element);
    const values: string[] = ['visible'];
    const statesResult = await patched.states(id, values, true);
    expect(statesResult).toBeNull();
    const values2: string[] = ['visible'];
    const statesResult2 = await patched.states(id, values2, false);
    const receiverActual = statesResult2;
    const toEqualOptions = { missing: 'visible' } as const;
    expect(receiverActual).toEqual(toEqualOptions);
    const receiver2Actual = checkStates;
    const values3: string[] = ['visible'];
    expect(receiver2Actual).toHaveBeenCalledWith(element, values3, true);
    expect(checkStates).toHaveBeenCalledTimes(1);
    for (const callback of callbacks) callback(id);
    expect(() => patched.el(id)).toThrow('cloak:stale-element');
  });
  const values4: readonly boolean[] = [true, false];
  it.each(values4)('checks ancestor iframe visibility %s and releases its handle', async (visible) => {
    const source = patchWorld(world)
      .replace(/^import .*$/gmu, '')
      .replaceAll('export ', '');
    const message4 = `${source}\nWorlds;`;
    const runInNewContextOptions = { HELPERS: '__cloakH' } as const;
    const Worlds = runInNewContext(message4, runInNewContextOptions) as new (page: unknown) => World;
    const worldsOptions = { on: vi.fn() } as const;
    const runtime = new Worlds(worldsOptions);
    runtime.evaluate = vi.fn(async (_frame: Frame, expression: string): Promise<unknown> => expression);
    const dispose = vi.fn(async () => undefined);
    const root: Frame = { parentFrame: () => null, frameElement: vi.fn() };
    const child: Frame = {
      parentFrame: () => root,
      frameElement: vi.fn(async () => ({ isVisible: async () => visible, dispose })),
    };
    const values5 = ['visible'];
    const callResult = await runtime.call(child, 'states', 1, values5);
    const receiver3Actual = callResult;
    const message5 = `__cloakH.states(1, ["visible"], ${String(visible)})`;
    expect(receiver3Actual).toBe(message5);
    expect(dispose).toHaveBeenCalledTimes(1);
    const values6 = ['visible'];
    const callResult2 = await runtime.call(root, 'states', 1, values6);
    expect(callResult2).toBe('__cloakH.states(1, ["visible"], true)');
    const callResult3 = await runtime.call(root, 'resolve', 'button', true, 0);
    expect(callResult3).toBe('__cloakH.resolve("button", true, 0)');
  });
});
