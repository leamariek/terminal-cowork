#!/usr/bin/env node
// terminal-cowork: opens the app from any WSL terminal, in the folder you are in.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const root = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..');
const exe = process.env.TERMINAL_COWORK_EXE ?? resolve(root, 'dist/terminal-cowork-win32-x64/terminal-cowork.exe');
const [command, args] = process.env.TERMINAL_COWORK_ELECTRON
  ? [process.env.TERMINAL_COWORK_ELECTRON, [resolve(root, 'app'), '--no-sandbox', ...(process.env.TERMINAL_COWORK_ARGS ?? '').split(' ').filter(Boolean)]]
  : [exe, []];
if (!process.env.TERMINAL_COWORK_ELECTRON && !existsSync(exe)) {
  console.error(`App not found at ${exe}. Build it with node scripts/package-windows.mjs, or set TERMINAL_COWORK_EXE.`);
  process.exit(1);
}
spawn(command, args, { detached: true, stdio: 'ignore', env: { ...process.env, COWORK_CWD: process.cwd() } }).unref();
console.log('Opening terminal-cowork');
