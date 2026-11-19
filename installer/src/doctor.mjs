// doctor --start: spawn exactly the installed entry and perform an MCP
// initialize -> tools/list -> browser_capabilities handshake. No browser, no
// provisioning request and no harness config write.
import { spawn, spawnSync } from 'node:child_process';
import { shimArgs } from './paths.mjs';
import { CLI_VERSION } from './engine.mjs';

export const DEFAULT_START_TIMEOUT_MS = 45000;

function check(name, status, message, details = {}) {
  return { name, status, message, details };
}

export function capabilitiesCoherent(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const { backendState, backendSubstate, startupMs } = capabilities;
  if (typeof backendState !== 'string' || backendState.trim() === '') return false;
  if (backendSubstate !== null && typeof backendSubstate !== 'string') return false;
  if (
    startupMs !== null &&
    !(typeof startupMs === 'number' && Number.isFinite(startupMs) && startupMs >= 0)
  ) {
    return false;
  }
  return true;
}

function contentPayload(response) {
  const result = response?.result ?? {};
  const text = result.content?.find?.((item) => item?.type === 'text')?.text ?? result.content?.[0]?.text;
  if (typeof text !== 'string') return result;
  try {
    return JSON.parse(text);
  } catch {
    return result;
  }
}

// The shim spawns the broker with inherited stdio. Killing only the shim can
// leave that grandchild holding doctor's pipes open forever, so kill the whole
// tree before resolving the check.
function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    if (killed.status === 0) return;
    try {
      child.kill();
    } catch {
      // already gone
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

function waitForClose(child, ms = 1000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('close', done);
      resolve();
    }, ms);
    function done() {
      clearTimeout(timer);
      resolve();
    }
    child.once('close', done);
  });
}

export async function startCheck({
  dataRoot,
  harness,
  entry,
  timeout = DEFAULT_START_TIMEOUT_MS,
  env = process.env,
}) {
  const args = shimArgs(harness, entry, dataRoot).slice(1);
  const child = spawn(process.execPath, args, {
    env: { ...env, STEALTH_DATA_DIR: dataRoot, STEALTH_HARNESS: harness },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let closed = false;
  child.once('close', () => {
    closed = true;
  });
  let stderr = '';
  let buffer = '';
  const pending = new Map();
  const timers = new Set();
  let nextId = 1;
  child.stdin.on('error', () => {});
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (message && typeof message.id === 'number' && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      } catch {
        // Non-JSON stdout lines are diagnostics, not MCP responses.
      }
    }
  });
  const writeLine = (line) => {
    try {
      child.stdin.write(line);
    } catch {
      // the tree is already being torn down
    }
  };
  const request = (method, params = {}) =>
    new Promise((resolveRequest, rejectRequest) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(
        () => {
          timers.delete(timer);
          pending.delete(id);
          rejectRequest(new Error(`${method} timed out`));
        },
        Math.max(1, timeout),
      );
      timers.add(timer);
      pending.set(id, (message) => {
        clearTimeout(timer);
        timers.delete(timer);
        resolveRequest(message);
      });
      writeLine(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const notify = (method, params = {}) => {
    writeLine(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  const handshake = async () => {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'sabm-doctor', version: CLI_VERSION },
    });
    if (init.error || !init.result?.serverInfo) {
      throw new Error(`initialize failed: ${init.error?.message ?? 'no serverInfo'}`);
    }
    notify('notifications/initialized');
    const listed = await request('tools/list', {});
    if (listed.error || !Array.isArray(listed.result?.tools)) {
      throw new Error(`tools/list failed: ${listed.error?.message ?? 'no tools'}`);
    }
    const capabilities = await request('tools/call', { name: 'browser_capabilities', arguments: {} });
    if (capabilities.error) throw new Error(`browser_capabilities failed: ${capabilities.error.message}`);
    return { init, listed, capabilities: contentPayload(capabilities) };
  };
  let timer;
  try {
    const result = await Promise.race([
      handshake(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`doctor --start exceeded ${timeout} ms`)), timeout);
      }),
    ]);
    clearTimeout(timer);
    const tools = result.listed.result.tools.map((tool) => tool.name);
    const metaCount = tools.filter((name) =>
      ['browser_capabilities', 'browser_engine_status', 'browser_profiles'].includes(name),
    ).length;
    const coherent = capabilitiesCoherent(result.capabilities);
    return {
      ok: tools.length > 0 && coherent,
      checks: [
        check(
          'start-initialize',
          'ok',
          `Initialized ${result.init.result.serverInfo?.name ?? 'server'}; ${result.init.result.protocolVersion ?? 'protocol'}`,
          {
            serverInfo: result.init.result.serverInfo,
          },
        ),
        check(
          'start-tools-list',
          tools.length > 0 ? 'ok' : 'error',
          `${tools.length} tool(s) listed; ${metaCount} meta tool(s)${tools.length === 3 ? ' (cold meta-only start is a PASS)' : ''}.`,
          { tools },
        ),
        check(
          'start-capabilities',
          coherent ? 'ok' : 'error',
          coherent
            ? `backendState=${result.capabilities.backendState}; backendSubstate=${String(result.capabilities.backendSubstate)}; startupMs=${String(result.capabilities.startupMs)}`
            : 'browser_capabilities did not report coherent backendState/backendSubstate/startupMs.',
          {
            dataDir: result.capabilities.dataDir ?? null,
            engine: result.capabilities.engine ?? null,
            toolProfile: result.capabilities.toolProfile ?? null,
            backendState: result.capabilities.backendState ?? null,
            backendSubstate: result.capabilities.backendSubstate ?? null,
            startupMs: result.capabilities.startupMs ?? null,
            provisioning: result.capabilities.provisioning ?? null,
          },
        ),
      ],
    };
  } catch (error) {
    clearTimeout(timer);
    return {
      ok: false,
      checks: [
        check(
          'start-handshake',
          'error',
          `${error.message}${stderr ? `; stderr: ${stderr.slice(-500)}` : ''}`,
        ),
      ],
    };
  } finally {
    clearTimeout(timer);
    for (const requestTimer of timers) clearTimeout(requestTimer);
    timers.clear();
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    killProcessTree(child);
    if (!closed) await waitForClose(child);
  }
}
