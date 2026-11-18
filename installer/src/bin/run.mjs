#!/usr/bin/env node
import { runShim } from './shim-runtime.mjs';

process.exitCode = await runShim(process.argv.slice(2));
