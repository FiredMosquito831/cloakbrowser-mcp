import { createHash } from 'node:crypto';
import type { LoadHook } from 'node:module';
let helpersUrl: string | undefined;
let worldUrl: string | undefined;
export function initialize(data: { helpersUrl: string; worldUrl: string }): void {
  helpersUrl = data.helpersUrl;
  worldUrl = data.worldUrl;
}
const helperHash = '3b698b81b3ceb5dc400237b088eb80178fbbc3ce6ab0fcf84ce3d83041913919';
const worldHash = '2949df4184c14d6022bac0f552d0428481ab199fb7658e4ed584e96071d81258';
function requireSource(source: string, hash: string): void {
  if (createHash('sha256').update(source).digest('hex') !== hash) {
    throw new Error('CloakBrowser 0.6.0 humanize source does not match the verified compatibility patch');
  }
}
// Patch only the verified dependency sources; never write to node_modules.
export function patchHelpers(source: string): string {
  requireSource(source, helperHash);
  return source
    .replace(
      "const els = new Map(); let seq = 0;\nconst put = (e) => { const id = ++seq; els.set(id, e); return id; };\nconst get = (id) => { const e = els.get(id); if (!e) throw new Error('cloak:stale-element'); return e; };",
      `const els = new Map(); const ids = new WeakMap(); let seq = 0;
const collected = new FinalizationRegistry((id) => els.delete(id));
const put = (e) => {
  const existing = ids.get(e); if (existing !== undefined) return existing;
  const id = ++seq; ids.set(e, id); const ref = new WeakRef(e); els.set(id, ref); collected.register(e, id); return id;
};
const get = (id) => { const e = els.get(id)?.deref(); if (!e) throw new Error('cloak:stale-element'); return e; };`,
    )
    .replace(
      'async states(id, states) {\n    const e = get(id);',
      "async states(id, states, frameVisible) {\n    const e = get(id);\n    if (!frameVisible && states.includes('visible')) return { missing: 'visible' };",
    )
    .replace('I.checkElementStates(e, states)', 'I.checkElementStates(e, states, frameVisible)')
    .replace('I.elementState(e, s)', 'I.elementState(e, s, frameVisible)');
}
export function patchWorld(source: string): string {
  requireSource(source, worldHash);
  return source.replace(
    '    call(frame, method, ...args) {',
    `    async call(frame, method, ...args) {
        if (method === 'states') {
            let frameVisible = true;
            for (let current = frame; current.parentFrame(); current = current.parentFrame()) {
                const owner = await current.frameElement();
                try {
                    if (!(await owner.isVisible())) { frameVisible = false; break; }
                } finally {
                    await owner.dispose();
                }
            }
            args.push(frameVisible);
        }`,
  );
}
export const load: LoadHook = async (url, context, nextLoad) => {
  const result = await nextLoad(url, context);
  if (url !== helpersUrl && url !== worldUrl) return result;
  if (result.source === undefined || result.source === null) {
    throw new Error('CloakBrowser humanize source is unavailable for the compatibility patch');
  }
  const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
  return { ...result, source: url === helpersUrl ? patchHelpers(source) : patchWorld(source) };
};
