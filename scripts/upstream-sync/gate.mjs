// The in-workflow gate runner. The command list itself lives in constants.mjs
// so the workflow README, this runner and the tests cannot disagree.
import { spawnSync } from 'node:child_process';
import { gateCommands, spawnableCommand } from './constants.mjs';
import { listPlugins } from './pins.mjs';

/**
 * Run every gate command in order, streaming each command's output.
 *
 * @param {{root: string, spawn?: typeof spawnSync, platform?: string, write?: (line: string) => void}} options Runner options.
 * @returns {{ok: boolean, failed: string|null, commands: {label: string, command: string, args: string[]}[]}} Result.
 */
export function runGate({
  root,
  spawn = spawnSync,
  platform = process.platform,
  write = (line) => process.stdout.write(`${line}\n`),
}) {
  const commands = gateCommands({ plugins: listPlugins(root) });
  for (const [index, step] of commands.entries()) {
    write(`[gate ${index + 1}/${commands.length}] ${step.label}: ${step.command} ${step.args.join(' ')}`);
    const command = spawnableCommand(step.command, platform);
    const result = spawn(command, step.args, {
      cwd: root,
      stdio: 'inherit',
      // Windows runs npm/claude through .cmd shims, which need a shell. The
      // workflow gate itself is Linux; this only keeps a local dry gate working.
      shell: platform === 'win32' && command.endsWith('.cmd'),
    });
    if (result.error !== undefined) {
      write(`[gate] ${step.label} could not start: ${result.error.message}`);
      return { ok: false, failed: step.label, commands };
    }
    if (result.status !== 0) {
      write(`[gate] ${step.label} failed with exit ${result.status}`);
      return { ok: false, failed: step.label, commands };
    }
  }
  write(`[gate] ${commands.length} command(s) passed`);
  return { ok: true, failed: null, commands };
}
