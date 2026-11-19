import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'npm-release.yml');
const packagePath = path.join(repoRoot, 'installer', 'package.json');
const workflow = readFileSync(workflowPath, 'utf8');
const installerPackage = JSON.parse(readFileSync(packagePath, 'utf8')) as {
  name: string;
  version: string;
};

describe('npm publish workflow contract', () => {
  it('publishes only the fork installer package, never the upstream root package', () => {
    expect(installerPackage.name).toBe('secret-agent-browser-mcps');
    expect(workflow).toContain('PACKAGE_DIR: installer');
    expect(workflow).toContain('working-directory: installer');
    expect(workflow).toContain('npm publish --access public --provenance');
    expect(workflow).not.toContain('npm publish "${{ steps.pack.outputs.package_file }}"');
    expect(workflow).not.toContain('cloakbrowser-mcp@');
  });

  it('fires on published releases, installer version bumps and manual reruns', () => {
    expect(workflow).toContain('release:');
    expect(workflow).toContain('types: [published]');
    expect(workflow).toContain('push:');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain("- 'installer/**'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('github.event.before');
    expect(workflow).toContain('previous="$(git show "$before:installer/package.json"');
  });

  it('uses trusted publishing with an empty npm environment and no stored token', () => {
    expect(workflow).toContain("if: github.repository_owner == 'FiredMosquito831'");
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain("NPM_VERSION: '11.19.0'");
    expect(workflow).toContain('registry-url: https://registry.npmjs.org');
    expect(workflow).not.toContain('environment:');
    expect(workflow).not.toContain('secrets.');
    expect(workflow).toContain('npm-release.yml');
    expect(workflow).toContain('Environment:          leave EMPTY');
  });

  it('checks version agreement, skips existing versions and reports a refused publish', () => {
    expect(workflow).toContain('tag_version="${RELEASE_TAG#sabm-v}"');
    expect(workflow).toContain('npm view "$name@$version" version');
    expect(workflow).toContain('echo \'publish=false\' >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('npm refused the trusted publish');
    expect(workflow).toContain('npm view $PACKAGE_NAME version');
  });

  it('builds and verifies the exact package before any publish', () => {
    for (const command of [
      'npm ci --prefix "$PACKAGE_DIR" --ignore-scripts --no-audit --fund=false',
      'npm --prefix "$PACKAGE_DIR" run build',
      'npm --prefix "$PACKAGE_DIR" run check',
      'npm --prefix "$PACKAGE_DIR" test',
      '(cd "$PACKAGE_DIR" && npm pack --dry-run >/dev/null)',
    ]) {
      expect(workflow).toContain(command);
    }
  });
});
