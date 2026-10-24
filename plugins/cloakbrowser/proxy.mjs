#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const disabled = new Set(
  (process.env.CLOAK_DISABLED_TOOLS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
);

const launcher = fileURLToPath(new URL('./launch.mjs', import.meta.url));
const child = spawn(process.execPath, [launcher], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

const childLines = readline.createInterface({ input: child.stdout });
childLines.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(line + '\n');
    return;
  }
  if (disabled.size > 0 && message?.result && Array.isArray(message.result.tools)) {
    message.result.tools = message.result.tools.filter((tool) => !disabled.has(tool?.name));
  }
  write(message);
});

const inputLines = readline.createInterface({ input: process.stdin });
inputLines.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    child.stdin.write(line + '\n');
    return;
  }
  if (
    message?.method === 'tools/call' &&
    message?.params &&
    typeof message.params.name === 'string' &&
    disabled.has(message.params.name)
  ) {
    write({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32601,
        message: `Tool "${message.params.name}" is disabled by the cloakbrowser plugin.`,
      },
    });
    return;
  }
  child.stdin.write(line + '\n');
});

inputLines.on('close', () => {
  child.stdin.end();
});

child.on('error', (error) => {
  process.stderr.write(`[cloakbrowser-proxy] ${error.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code === null ? 1 : code);
});
