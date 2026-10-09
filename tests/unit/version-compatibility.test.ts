import { describe, expect, it } from 'vitest';
interface VersionCompatibilityModule {
  code(value: string): string;
  codePlatformList(value: string): string;
  escapeRegex(value: string): string;
  renderFullTable(rows: CompatibilityRow[]): string;
  renderHomepageTable(rows: CompatibilityRow[]): string;
  renderReadmeTable(rows: CompatibilityRow[]): string;
  renderTable(headers: string[], tableRows: string[][]): string;
  renderTableRow(row: string[], widths: number[]): string;
  replaceGeneratedBlock(content: string, heading: string, table: string): string;
  validateRows(value: unknown, dataPath?: string): void;
}
interface CompatibilityRow {
  version: string;
  playwrightMcp: string;
  playwrightMcpDockerBase: string;
  cloakbrowser: string;
  node: string;
  readmePlatforms: string;
  testedPlatform: string;
  parity: string;
  transports: string[];
}
const argumentValue = new URL('../../scripts/lib/version-compatibility.mjs', import.meta.url).href;
const compatibility = (await import(argumentValue)) as unknown as VersionCompatibilityModule;
const row: CompatibilityRow = {
  cloakbrowser: '0.4.8',
  node: '>=22.12.0',
  parity: 'Compared in CI',
  playwrightMcp: '0.0.77',
  playwrightMcpDockerBase: 'v0.0.77',
  readmePlatforms: 'linux/amd64, linux/arm64',
  testedPlatform: 'linux/amd64',
  transports: ['stdio', 'streamable-http'],
  version: '1.6.1',
};
describe('version compatibility helpers', () => {
  it('validates compatibility row shape', () => {
    expect(() => {
      const values = [row];
      return compatibility.validateRows(values, 'compat.json');
    }).not.toThrow();
    expect(() => {
      const values2: unknown[] = [];
      return compatibility.validateRows(values2, 'compat.json');
    }).toThrow('compat.json must contain at least one compatibility row');
    expect(() => {
      const values3 = [{ ...row, transports: ['stdio', 42] }];
      return compatibility.validateRows(values3, 'compat.json');
    }).toThrow('compat.json[0].transports must be an array of strings');
  });
  it('renders padded markdown tables for all compatibility targets', () => {
    const values4: string[] = ['A', 'Long'];
    const values5: string[][] = [['x', 'y']];
    const renderTableResult = compatibility.renderTable(values4, values5);
    const receiverActual = renderTableResult;
    const joinedPath = ['| A   | Long |', '| --- | ---- |', '| x   | y    |'].join('\n');
    expect(receiverActual).toBe(joinedPath);
    const values6: string[] = ['x', 'y'];
    const values7: number[] = [1, 3];
    const renderTableRowResult = compatibility.renderTableRow(values6, values7);
    expect(renderTableRowResult).toBe('| x | y   |');
    const values8: CompatibilityRow[] = [row];
    const renderReadmeTableResult = compatibility.renderReadmeTable(values8);
    expect(renderReadmeTableResult).toContain('`linux/amd64`, `linux/arm64`');
    const values9: CompatibilityRow[] = [row];
    const renderHomepageTableResult = compatibility.renderHomepageTable(values9);
    expect(renderHomepageTableResult).toContain('Compared in CI');
    const values10: CompatibilityRow[] = [row];
    const renderFullTableResult = compatibility.renderFullTable(values10);
    expect(renderFullTableResult).toContain('@playwright/mcp dependency');
  });
  it('replaces existing generated blocks or legacy tables', () => {
    const table = '| A |\n| - |\n| x |';
    const joinedPath2 = [
      '## Version compatibility',
      '<!-- compatibility-table:start -->',
      '',
      'old',
      '',
      '<!-- compatibility-table:end -->',
      '',
    ].join('\n');
    const replaceGeneratedBlockResult = compatibility.replaceGeneratedBlock(
      joinedPath2,
      '## Version compatibility',
      table,
    );
    expect(replaceGeneratedBlockResult).toContain(table);
    const joinedPath3 = ['## Version compatibility', '| Old |', '| --- |', '| x |', '', 'Next'].join('\n');
    const replaceGeneratedBlockResult2 = compatibility.replaceGeneratedBlock(
      joinedPath3,
      '## Version compatibility',
      table,
    );
    const receiver2Actual = replaceGeneratedBlockResult2;
    const joinedPath4 = [
      '## Version compatibility',
      '<!-- compatibility-table:start -->',
      '',
      table,
      '',
      '<!-- compatibility-table:end -->',
      '',
      'Next',
    ].join('\n');
    expect(receiver2Actual).toBe(joinedPath4);
    expect(() => compatibility.replaceGeneratedBlock('No heading\n', '## Missing', table)).toThrow(
      'missing heading',
    );
  });
  it('formats inline code and regex fragments', () => {
    const codeResult = compatibility.code('value');
    expect(codeResult).toBe('`value`');
    const codePlatformListResult = compatibility.codePlatformList('linux/amd64');
    expect(codePlatformListResult).toBe('`linux/amd64`');
    const escapeRegexResult = compatibility.escapeRegex('a+b?');
    expect(escapeRegexResult).toBe('a\\+b\\?');
  });
});
