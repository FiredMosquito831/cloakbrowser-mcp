import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface SourceLine {
  index: number;
  indent: number;
  text: string;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const canonicalPath = path.join(repoRoot, 'shared', 'core', 'camoufox_entry.py');
const pluginPaths = [
  path.join(repoRoot, 'plugins', 'cloakbrowser', 'camoufox_entry.py'),
  path.join(repoRoot, 'plugins', 'camoufox', 'camoufox_entry.py'),
];

function pythonLines(source: string): SourceLine[] {
  return source
    .split('\n')
    .map((text, index) => ({ index, indent: text.length - text.trimStart().length, text }));
}

function mainBody(source: string): SourceLine[] {
  const lines = pythonLines(source);
  const start = lines.findIndex((line) => line.text.trimStart().startsWith('def main()'));
  expect(start).toBeGreaterThanOrEqual(0);
  const body: SourceLine[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.text.trim() !== '' && line.indent === 0) break;
    body.push(line);
  }
  return body;
}

function exactlyOne(
  lines: SourceLine[],
  predicate: (line: SourceLine) => boolean,
  label: string,
): SourceLine {
  const found = lines.filter(predicate);
  expect(found, `${label} must appear exactly once in main()`).toHaveLength(1);
  return found[0];
}

describe('camoufox entry warm-up import', () => {
  const source = readFileSync(canonicalPath, 'utf8');
  const body = mainBody(source);

  it('runs the import on Windows only, guarded by try/except, before wrapper_main()', () => {
    const win32 = exactlyOne(
      body,
      (line) => line.text.trim() === "if sys.platform == 'win32':",
      'win32 branch',
    );
    const tryBlock = exactlyOne(body, (line) => line.text.trim() === 'try:', 'try block');
    const warmup = exactlyOne(
      body,
      (line) => line.text.trim().startsWith('import camoufox.async_api'),
      'warm-up import',
    );
    const wrapper = exactlyOne(body, (line) => line.text.trim() === 'wrapper_main()', 'wrapper_main() call');

    // Exactly one warm-up import in the whole file: no stray copy outside the guard.
    expect(source.match(/^\s*import camoufox\.async_api\b/gm)).toHaveLength(1);

    // Indentation encodes the nesting: the try sits in the win32 body (8) and the
    // import in the try body (12); wrapper_main() stays at function-body level (4).
    expect(win32.indent).toBe(4);
    expect(tryBlock.indent).toBe(8);
    expect(warmup.indent).toBe(12);
    expect(wrapper.indent).toBe(4);

    // Order: win32 -> try -> import -> wrapper_main(). Moving the warm-up after
    // the wrapper (where its lazy import would run inside the async handler
    // again) fails this.
    expect(win32.index).toBeLessThan(tryBlock.index);
    expect(tryBlock.index).toBeLessThan(warmup.index);
    expect(warmup.index).toBeLessThan(wrapper.index);

    // Nothing at function-body level between the win32 branch and the import:
    // the warm-up is inside that branch, so POSIX never runs it.
    const closedEarly = body.filter(
      (line) =>
        line.index > win32.index && line.index < warmup.index && line.text.trim() !== '' && line.indent <= 4,
    );
    expect(closedEarly).toEqual([]);
  });

  it('swallows a failed warm-up: stderr only, flushed, never stdout', () => {
    const handler = exactlyOne(
      body,
      (line) => line.text.trim().startsWith('except Exception as exc:'),
      'except handler',
    );
    const report = exactlyOne(body, (line) => line.text.trim().startsWith('print('), 'stderr report');

    expect(handler.indent).toBe(8);
    expect(report.indent).toBe(12);
    expect(report.index).toBeGreaterThan(handler.index);
    expect(report.text).toContain('camoufox warm-up import failed');
    expect(report.text).toContain('file=sys.stderr');
    expect(report.text).toContain('flush=True');

    // stdout carries JSON-RPC only: the entry point has no other print.
    expect(body.filter((line) => line.text.trim().startsWith('print('))).toHaveLength(1);
  });

  it('ships the identical entry point in both plugins', () => {
    const canonical = readFileSync(canonicalPath);
    for (const file of pluginPaths) {
      expect(
        readFileSync(file).equals(canonical),
        `${path.relative(repoRoot, file)} must match shared/core`,
      ).toBe(true);
    }
  });
});
