// The timing-budget contract (item 41, PR C; spec 2026-10-28-inv-test-flakes §F7).
//
// A wall-clock claim is a number that is different on a loaded CI runner: an
// elapsed-time assertion, a poll with no bound of its own, or a fixed sleep used
// as a synchronisation primitive. Every one of them is a budget, and the reason
// for the number is the part that is missing when the test fails on a runner
// nobody can look at. This meta-test makes the author write it down.
//
// Three static rules, each over every `tests/**/*.ts` file:
//
//   1. `elapsed-assertion` — `expect(<duration>).toBeLessThan|toBeLessThanOrEqual|
//      toBeGreaterThan|toBeGreaterThanOrEqual(...)`. A duration is an expression
//      computed from a monotonic or wall clock (`Date.now()`, `performance.now()`,
//      `process.hrtime`), an identifier bound to such an expression in the same
//      file, an identifier or property that is a duration by convention
//      (`…Ms`, `elapsed`, `waited`, `duration`, `took`), `Number(…)` of one, or
//      the same shape in the matcher's argument.
//   2. `waitfor-without-timeout` — `vi.waitFor()` / `vi.waitUntil()` whose options
//      carry no `timeout`; an options identifier is resolved to its declaration
//      in the same file, so `const waitForOptions = { timeout: 5000 }` counts.
//      Vitest's default 1 000 ms is a hidden budget.
//   3. `fixed-sleep` — a directly awaited bare timer promise with a literal
//      delay: `await new Promise((resolve) => setTimeout(resolve, 150))`, or
//      `await setTimeout(500)` from `node:timers/promises`. Deliberately NOT
//      flagged: a timer arm inside `Promise.race([...])` (a bounded shutdown
//      guard that fails fast), `const timer = setTimeout(...)` (a deadline guard
//      that is cleared), and the body of a `delay(milliseconds)` helper — its
//      delay is a parameter, so the budget is at the call site, which this rule
//      does not resolve.
//
// The contract: every claim carries `// budget: <why this number>` on its line or
// on the line directly above it; the text after `budget:` must not be empty. The
// comment is the point — it records what the number is measured against, which
// has to be the product's own bound or a measured cost, never a guess.
//
// This test is static (no subprocess, no timing) and cannot be skipped: there is
// deliberately no environment escape hatch, because a check that can be turned
// off is the check that is turned off on the day it matters.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

export type WallClockRule = 'elapsed-assertion' | 'waitfor-without-timeout' | 'fixed-sleep';

export interface WallClockClaim {
  rule: WallClockRule;
  /** 1-based line of the claim. */
  line: number;
  /** The claim's source line, trimmed, for the failure message. */
  text: string;
}

export interface WallClockOffender extends WallClockClaim {
  /** Path relative to the repository root, e.g. `tests/unit/foo.test.ts`. */
  file: string;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const testsRoot = path.join(repoRoot, 'tests');

const COMPARISON_MATCHERS = new Set([
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
]);

// The clock reads a duration is measured from.
const CLOCK_CALLS = new Set(['Date.now', 'performance.now', 'process.hrtime', 'hrtime.bigint']);

// A capital `Ms` suffix is the suite's convention for a millisecond value; the case
// matters on purpose, so a plural like `items` is not a duration.
function isMillisecondName(name: string): boolean {
  return name.endsWith('Ms');
}

// The words cover the same values before they were given a unit suffix.
const DURATION_WORDS = /^(?:elapsed|waited|duration|took)$/iu;

const BUDGET_COMMENT = /\/\/\s*budget:\s*\S/u;

function parse(sourceText: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** True when any part of the expression reads a clock. */
function readsClock(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isCallExpression(child) && CLOCK_CALLS.has(child.expression.getText())) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Identifiers declared in this file from a clock expression. */
function collectDurationIdentifiers(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      readsClock(node.initializer)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function isDurationValue(node: ts.Expression, durations: ReadonlySet<string>): boolean {
  if (readsClock(node)) {
    return true;
  }
  if (ts.isIdentifier(node)) {
    return durations.has(node.text) || isMillisecondName(node.text) || DURATION_WORDS.test(node.text);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return isMillisecondName(node.name.text) || DURATION_WORDS.test(node.name.text);
  }
  if (ts.isParenthesizedExpression(node)) {
    return isDurationValue(node.expression, durations);
  }
  if (ts.isCallExpression(node) && node.expression.getText() === 'Number') {
    const [argument] = node.arguments;
    return argument !== undefined && isDurationValue(argument, durations);
  }
  return false;
}

function findVariableInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | null {
  let initializer: ts.Expression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      initializer === null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      initializer = node.initializer ?? null;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return initializer;
}

/** `vi.waitFor(...)` counts as bounded only when its options name a timeout. */
function hasExplicitWaitForTimeout(sourceFile: ts.SourceFile, options: ts.Expression | undefined): boolean {
  if (options === undefined) {
    return false;
  }
  let object: ts.Expression = options;
  if (ts.isIdentifier(object)) {
    const initializer = findVariableInitializer(sourceFile, object.text);
    if (initializer === null) {
      return false;
    }
    object = initializer;
  }
  // `const options = { timeout: 5000 } as const;` is the suite's usual shape.
  while (
    ts.isAsExpression(object) ||
    ts.isSatisfiesExpression(object) ||
    ts.isParenthesizedExpression(object)
  ) {
    object = object.expression;
  }
  if (!ts.isObjectLiteralExpression(object)) {
    return false;
  }
  return object.properties.some(
    (property) => property.name !== undefined && property.name.getText() === 'timeout',
  );
}

function isTimerCall(expression: ts.Expression): expression is ts.CallExpression {
  return (
    ts.isCallExpression(expression) &&
    (expression.expression.getText() === 'setTimeout' ||
      expression.expression.getText() === 'globalThis.setTimeout')
  );
}

/** A timer call whose delay is a literal: a fixed sleep, not a computed wait. */
function isLiteralTimerCall(expression: ts.Expression): boolean {
  if (!isTimerCall(expression)) {
    return false;
  }
  const delay: ts.Expression | undefined = expression.arguments[1];
  return delay !== undefined && ts.isNumericLiteral(delay);
}

function isAwaitableTimerPromise(expression: ts.Expression): boolean {
  if (ts.isNewExpression(expression) && expression.expression.getText() === 'Promise') {
    const executor: ts.Expression | undefined = expression.arguments?.[0];
    if (executor === undefined || !ts.isArrowFunction(executor)) {
      return false;
    }
    if (!ts.isBlock(executor.body)) {
      return isLiteralTimerCall(executor.body);
    }
    // The executor's whole body must be the timer: anything else is a guard or
    // a real wait for a signal, not a bare sleep.
    const statements = executor.body.statements;
    return (
      statements.length > 0 &&
      statements.every(
        (statement) => ts.isExpressionStatement(statement) && isLiteralTimerCall(statement.expression),
      )
    );
  }
  // `await setTimeout(500)` from `node:timers/promises`: the delay is the first
  // argument. A computed delay is not a fixed sleep.
  if (ts.isCallExpression(expression) && expression.expression.getText() === 'setTimeout') {
    const delay: ts.Expression | undefined = expression.arguments[0];
    return delay !== undefined && ts.isNumericLiteral(delay);
  }
  return false;
}

/** Every wall-clock claim in one source text, with no annotation check. */
export function findWallClockClaims(sourceText: string, fileName = 'source.ts'): WallClockClaim[] {
  const sourceFile = parse(sourceText, fileName);
  const durations = collectDurationIdentifiers(sourceFile);
  const lines = sourceText.split(/\r?\n/u);
  const claims: WallClockClaim[] = [];
  const claim = (rule: WallClockRule, node: ts.Node): void => {
    const line = lineOf(sourceFile, node);
    claims.push({ rule, line, text: lines.at(line - 1)?.trim() ?? '' });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const matcher = node.expression.name.text;
      const receiver = node.expression.expression;
      if (COMPARISON_MATCHERS.has(matcher) && ts.isCallExpression(receiver)) {
        if (receiver.expression.getText() === 'expect') {
          const [received, ...expected] = receiver.arguments;
          const compared = [received, ...expected].filter(
            (argument): argument is ts.Expression => argument !== undefined,
          );
          if (compared.some((argument) => isDurationValue(argument, durations))) {
            claim('elapsed-assertion', node);
          }
        }
      }
      if (
        receiver.getText() === 'vi' &&
        (matcher === 'waitFor' || matcher === 'waitUntil') &&
        !hasExplicitWaitForTimeout(sourceFile, node.arguments[1])
      ) {
        claim('waitfor-without-timeout', node);
      }
    }
    if (ts.isAwaitExpression(node) && node.expression !== undefined) {
      if (isAwaitableTimerPromise(node.expression)) {
        claim('fixed-sleep', node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return claims;
}

/** True when the claim's line carries `// budget: <why>`, or the line above does. */
export function isAnnotated(lines: readonly string[], claimLine: number): boolean {
  const own = lines.at(claimLine - 1);
  if (own !== undefined && BUDGET_COMMENT.test(own)) {
    return true;
  }
  const above = lines.at(claimLine - 2);
  return above !== undefined && above.trim().startsWith('//') && BUDGET_COMMENT.test(above);
}

/** The unannotated claims in one source text — the unit the rules are tested on. */
export function findUnannotatedClaims(sourceText: string, fileName = 'source.ts'): WallClockClaim[] {
  const lines = sourceText.split(/\r?\n/u);
  return findWallClockClaims(sourceText, fileName).filter((claim) => !isAnnotated(lines, claim.line));
}

function testSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(full);
      }
    }
  };
  walk(testsRoot);
  return files.sort();
}

function relativeToRepo(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

function describeOffenders(offenders: readonly WallClockOffender[]): string {
  if (offenders.length === 0) {
    return '';
  }
  const rows = offenders.map(
    (offender) => `  ${offender.file}:${offender.line}  [${offender.rule}]  ${offender.text}`,
  );
  return [
    `${offenders.length} wall-clock claim(s) carry no "// budget: <why this number>" comment:`,
    ...rows,
    '',
    "Add the comment on the claim's line or on the line directly above it, and say what the",
    "number is measured against (the product's own bound, or a measured cost), never a guess.",
  ].join('\n');
}

const scannedFiles = testSourceFiles();

describe('timing-budget contract', () => {
  it('annotates every wall-clock claim under tests/ with a // budget: comment', () => {
    const offenders: WallClockOffender[] = [];
    for (const file of scannedFiles) {
      const text = readFileSync(file, 'utf8');
      for (const claim of findUnannotatedClaims(text, file)) {
        offenders.push({ ...claim, file: relativeToRepo(file) });
      }
    }
    expect(describeOffenders(offenders)).toBe('');
  });

  it('scans the whole tests tree, not a hand-listed subset', () => {
    expect(scannedFiles.length).toBeGreaterThanOrEqual(140);
    expect(scannedFiles.some((file) => relativeToRepo(file) === 'tests/helpers/engine-lock-holder.ts')).toBe(
      true,
    );
    expect(
      scannedFiles.some((file) => relativeToRepo(file) === 'tests/unit/timing-budget-contract.test.ts'),
    ).toBe(true);
  });

  it('flags an unannotated elapsed assertion and accepts the annotation', () => {
    const unannotated = [
      'it("x", async () => {',
      '  const startedAt = Date.now();',
      '  await work();',
      '  const elapsed = Date.now() - startedAt;',
      '  expect(elapsed).toBeLessThan(500);',
      '});',
    ].join('\n');
    expect(findUnannotatedClaims(unannotated)).toEqual([
      { rule: 'elapsed-assertion', line: 5, text: 'expect(elapsed).toBeLessThan(500);' },
    ]);

    const inline = unannotated.replace(
      '  expect(elapsed).toBeLessThan(500);',
      '  expect(elapsed).toBeLessThan(500); // budget: an in-process call, 100x headroom',
    );
    expect(findUnannotatedClaims(inline)).toEqual([]);

    const above = unannotated.replace(
      '  expect(elapsed).toBeLessThan(500);',
      '  // budget: an in-process call, 100x headroom\n  expect(elapsed).toBeLessThan(500);',
    );
    expect(findUnannotatedClaims(above)).toEqual([]);

    const empty = unannotated.replace(
      '  expect(elapsed).toBeLessThan(500);',
      '  expect(elapsed).toBeLessThan(500); // budget:',
    );
    expect(findUnannotatedClaims(empty)).toHaveLength(1);
  });

  it('flags a comparison on a conventional duration name and on Number(...)', () => {
    const source = [
      'it("x", async () => {',
      '  const status = await status();',
      '  expect(Number(status.waitMs)).toBeGreaterThanOrEqual(0);',
      '  expect(status.startupMs).toBeLessThan(8000);',
      '});',
    ].join('\n');
    expect(findUnannotatedClaims(source).map((claim) => claim.line)).toEqual([3, 4]);
  });

  it('flags a vi.waitFor with no explicit timeout', () => {
    const source = [
      'it("x", async () => {',
      '  await vi.waitFor(() => expect(events).toContain("ready"));',
      '  await vi.waitFor(() => expect(events).toContain("ready"), { timeout: 5_000 });',
      '  const named = { timeout: 5_000 } as const;',
      '  await vi.waitFor(() => expect(events).toContain("ready"), named);',
      '});',
    ].join('\n');
    expect(findUnannotatedClaims(source).map((claim) => [claim.rule, claim.line])).toEqual([
      ['waitfor-without-timeout', 2],
    ]);
  });

  it('flags a fixed sleep with a literal delay', () => {
    const source = [
      'it("x", async () => {',
      '  await new Promise((resolve) => setTimeout(resolve, 150));',
      '  await setTimeout(500);',
      '});',
    ].join('\n');
    expect(findUnannotatedClaims(source)).toEqual([
      {
        rule: 'fixed-sleep',
        line: 2,
        text: 'await new Promise((resolve) => setTimeout(resolve, 150));',
      },
      { rule: 'fixed-sleep', line: 3, text: 'await setTimeout(500);' },
    ]);
  });

  it('leaves a race guard, a cleared deadline and a parameterised delay alone', () => {
    const source = [
      'async function delay(milliseconds: number): Promise<void> {',
      '  await new Promise((resolve) => setTimeout(resolve, milliseconds));',
      '}',
      'it("x", async () => {',
      '  const timer = setTimeout(() => reject(new Error("timeout")), 20_000);',
      '  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);',
      '  await delay(5);',
      '});',
    ].join('\n');
    expect(findUnannotatedClaims(source)).toEqual([]);
  });
});
