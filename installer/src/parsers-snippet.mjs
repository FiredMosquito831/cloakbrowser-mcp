// Backwards-compatible --print-config implementation for the Phase 0 surface.
import { success } from './envelope.mjs';
import { resolveTarget } from './harnesses.mjs';
import { snippetFor } from './parsers.mjs';
import { resolveDataRoot } from './paths.mjs';
import { printJsonLine } from './envelope.mjs';

export async function printConfigSnippet(options, context, io) {
  const target = await resolveTarget(
    options.harness,
    { scope: options.scope ?? 'user', project: options.project },
    context,
  );
  if (target.refused) {
    const error = new Error(target.message);
    error.code = 'refused';
    error.kind = 'windows-path-unverified';
    error.remedy = 'Use a documented path on macOS/Linux; Phase 3 will verify Windows paths.';
    throw error;
  }
  const root = resolveDataRoot(options, context);
  const snippet = snippetFor(target, { dataRoot: root.path, name: options.name ?? 'cloakbrowser' });
  if (options.json) {
    printJsonLine(
      io,
      success('print-config', { harness: target.harness, scope: target.scope, path: target.path, snippet }),
    );
    return;
  }
  io.stdout.write(`${snippet}\n`);
  io.stdout.write('read-only; nothing written\n');
}
