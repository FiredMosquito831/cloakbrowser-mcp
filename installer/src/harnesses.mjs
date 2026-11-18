import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SabmError } from './envelope.mjs';
import { pathExists } from './paths.mjs';

export const HARNESS_IDS = Object.freeze([
  'claude-code',
  'codex',
  'antigravity',
  'opencode',
  'openclaw',
  'hermes',
]);

export const HARNESS_INFO = Object.freeze({
  'claude-code': {
    label: 'Claude Code',
    scopes: ['user', 'project'],
    managed: true,
    format: null,
    parent: [],
    envKey: null,
    keyLabel: 'plugin-managed (claude plugin)',
  },
  codex: {
    label: 'Codex',
    scopes: ['user', 'project'],
    managed: false,
    format: 'toml',
    parent: ['mcp_servers'],
    envKey: 'env',
    keyLabel: '[mcp_servers.<name>]',
  },
  antigravity: {
    label: 'Antigravity',
    scopes: ['user', 'project'],
    managed: false,
    format: 'json',
    parent: ['mcpServers'],
    envKey: 'env',
    keyLabel: 'mcpServers.<name>',
  },
  opencode: {
    label: 'OpenCode',
    scopes: ['user', 'project'],
    managed: false,
    format: 'jsonc',
    parent: ['mcp', 'servers'],
    envKey: 'environment',
    keyLabel: 'mcp.servers.<name>',
  },
  openclaw: {
    label: 'OpenClaw',
    scopes: ['user'],
    managed: false,
    format: 'json5',
    parent: ['mcp', 'servers'],
    envKey: 'env',
    keyLabel: 'mcp.servers.<name>',
  },
  hermes: {
    label: 'Hermes',
    scopes: ['user'],
    managed: false,
    format: 'yaml',
    parent: ['mcp_servers'],
    envKey: 'env',
    keyLabel: 'mcp_servers.<name>',
  },
});

export function getHarness(id) {
  if (!HARNESS_IDS.includes(id)) {
    throw new SabmError(
      'usage',
      'unknown-harness',
      `Unknown harness "${id}".`,
      `Use one of: ${HARNESS_IDS.join(', ')}.`,
    );
  }
  return { id, ...HARNESS_INFO[id] };
}

export function validateScope(harness, scope) {
  if (!['user', 'project'].includes(scope)) {
    throw new SabmError(
      'usage',
      'unknown-scope',
      `Unknown scope "${scope}".`,
      'Use --scope user or --scope project.',
    );
  }
  if (!harness.scopes.includes(scope)) {
    const reason =
      harness.id === 'openclaw'
        ? 'openclaw documents no project-level config file; run `install openclaw --scope user` or point `OPENCLAW_CONFIG_PATH` at the file you want.'
        : 'hermes documents no project-level config file; run `install hermes --scope user` or point `HERMES_HOME` at the config you want.';
    throw new SabmError('refused', 'unsupported-scope', reason, `Run ${harness.id} with --scope user.`);
  }
}

export function windowsRefusal(id) {
  if (id === 'opencode') {
    return 'opencode: the global config path on Windows is UNVERIFIED (upstream docs give only "~" and no Windows spelling). Refusing to guess; use a documented path via XDG_CONFIG_HOME or run on macOS/Linux. Phase 3 will verify with a live test.';
  }
  if (id === 'hermes') {
    return 'hermes: the user config path on Windows is UNVERIFIED (upstream docs give only HERMES_HOME and no Windows spelling). Refusing to guess; set HERMES_HOME to a documented path or run on macOS/Linux. Phase 3 will verify with a live test.';
  }
  return null;
}

async function existingOpenCodeProject(project) {
  const candidates = [
    join(project, 'opencode.jsonc'),
    join(project, 'opencode.json'),
    join(project, '.opencode', 'opencode.jsonc'),
    join(project, '.opencode', 'opencode.json'),
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return { path: candidate, source: 'documented' };
    } catch {
      continue;
    }
  }
  return { path: join(project, '.opencode', 'opencode.jsonc'), source: 'documented' };
}

export async function resolveTarget(harnessId, options = {}, context) {
  const harness = getHarness(harnessId);
  const scope = options.scope ?? 'user';
  validateScope(harness, scope);
  const base = {
    harness: harness.id,
    label: harness.label,
    scope,
    format: harness.format,
    parent: harness.parent,
    envKey: harness.envKey,
    keyLabel: harness.keyLabel,
  };
  if (harness.managed) {
    return { ...base, path: null, pathSource: 'plugin-managed', managed: true, refused: false };
  }
  const refusal = context.platform === 'win32' ? windowsRefusal(harness.id) : null;
  if (refusal) {
    return { ...base, path: null, pathSource: 'UNVERIFIED', refused: true, message: refusal };
  }
  const home = context.homedir;
  const env = context.env;
  const project = options.project ? resolve(context.cwd, options.project) : context.cwd;
  let path;
  let pathSource;
  if (harness.id === 'codex') {
    if (scope === 'project') {
      path = join(project, '.codex', 'config.toml');
      pathSource = 'documented';
    } else if (typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()) {
      path = join(env.CODEX_HOME.trim(), 'config.toml');
      pathSource = 'documented';
    } else {
      path = join(home, '.codex', 'config.toml');
      pathSource = context.platform === 'win32' ? 'derived' : 'documented';
    }
  } else if (harness.id === 'antigravity') {
    if (scope === 'project') {
      path = join(project, '.agents', 'mcp_config.json');
      pathSource = 'documented';
    } else {
      path = join(home, '.gemini', 'config', 'mcp_config.json');
      pathSource = context.platform === 'win32' ? 'derived' : 'documented';
    }
  } else if (harness.id === 'opencode') {
    if (scope === 'project') {
      const found = await existingOpenCodeProject(project);
      path = found.path;
      pathSource = found.source;
    } else if (typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim()) {
      path = join(env.XDG_CONFIG_HOME.trim(), 'opencode', 'opencode.jsonc');
      pathSource = 'derived';
    } else {
      path = join(home, '.config', 'opencode', 'opencode.jsonc');
      pathSource = 'documented';
    }
  } else if (harness.id === 'openclaw') {
    if (typeof env.OPENCLAW_CONFIG_PATH === 'string' && env.OPENCLAW_CONFIG_PATH.trim()) {
      path = resolve(context.cwd, env.OPENCLAW_CONFIG_PATH.trim());
      pathSource = 'documented';
    } else if (typeof env.OPENCLAW_HOME === 'string' && env.OPENCLAW_HOME.trim()) {
      path = join(env.OPENCLAW_HOME.trim(), 'openclaw.json');
      pathSource = 'documented';
    } else if (typeof env.OPENCLAW_STATE_DIR === 'string' && env.OPENCLAW_STATE_DIR.trim()) {
      path = join(env.OPENCLAW_STATE_DIR.trim(), 'openclaw.json');
      pathSource = 'documented';
    } else {
      path = join(home, '.openclaw', 'openclaw.json');
      pathSource = context.platform === 'win32' ? 'derived' : 'documented';
    }
  } else {
    if (typeof env.HERMES_HOME === 'string' && env.HERMES_HOME.trim()) {
      path = join(env.HERMES_HOME.trim(), 'config.yaml');
      pathSource = 'documented';
    } else {
      path = join(home, '.hermes', 'config.yaml');
      pathSource = 'documented';
    }
  }
  return { ...base, path, pathSource: pathSource ?? 'documented', refused: false, managed: false };
}

export async function allTargets(options = {}, context) {
  const harnesses = options.harness && options.harness.length > 0 ? options.harness : HARNESS_IDS;
  const scopes = options.scope ? [options.scope] : ['user', 'project'];
  const targets = [];
  for (const id of harnesses) {
    const harness = getHarness(id);
    for (const scope of scopes) {
      if (!harness.scopes.includes(scope)) continue;
      targets.push(await resolveTarget(id, { ...options, scope }, context));
    }
  }
  return targets;
}

export async function targetExists(target) {
  return target?.path ? pathExists(target.path) : false;
}
