#!/usr/bin/env node
// terminal-cowork: opens the app from any WSL or macOS terminal, in the folder you are in.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..');

// Filming and tests start the Linux build directly.
if (process.env.TERMINAL_COWORK_ELECTRON) {
  const args = [resolve(root, 'app'), '--no-sandbox', ...(process.env.TERMINAL_COWORK_ARGS ?? '').split(' ').filter(Boolean)];
  spawn(process.env.TERMINAL_COWORK_ELECTRON, args, { detached: true, stdio: 'ignore', env: { ...process.env, COWORK_CWD: process.cwd() } }).unref();
  console.log('Opening terminal-cowork');
  process.exit(0);
}

// macOS: the checkout's own Electron opens the window, and the backend runs on this same Node, whatever PATH the app sees.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  let electron;
  try { electron = require(resolve(root, 'node_modules/electron')); } catch {
    console.error('Electron is not installed. Run "npm install" in the terminal-cowork folder first.');
    process.exit(1);
  }
  spawn(electron, [resolve(root, 'app'), `--cwd=${process.cwd()}`], { detached: true, stdio: 'ignore', env: { ...process.env, COWORK_NODE: process.execPath, COWORK_CWD: process.cwd() } }).unref();
  console.log('Opening terminal-cowork');
  process.exit(0);
}

// The app must run from the Windows drive: a GUI app started from the WSL disk does not open reliably.
function findExe() {
  if (process.env.TERMINAL_COWORK_EXE) return process.env.TERMINAL_COWORK_EXE;
  const users = '/mnt/c/Users';
  for (const user of existsSync(users) ? readdirSync(users) : []) {
    const exe = join(users, user, 'Apps/terminal-cowork/terminal-cowork.exe');
    if (existsSync(exe)) return exe;
  }
  return null;
}

const exe = findExe();
if (!exe) {
  console.error('terminal-cowork.exe was not found. Copy dist/terminal-cowork-win32-x64 to Apps/terminal-cowork in your Windows user folder, or set TERMINAL_COWORK_EXE.');
  process.exit(1);
}

const windowsPath = execFileSync('wslpath', ['-w', exe], { encoding: 'utf8' }).trim();
// "start" hands the app to Windows and returns at once. Its first quoted argument is a window title.
const args = ['/c', 'start', '', windowsPath, `--cwd=${process.cwd()}`];
if (process.env.TERMINAL_COWORK_DRY) {
  console.log(['cmd.exe', ...args].join(' '));
  process.exit(0);
}
const result = spawnSync('cmd.exe', args, { cwd: dirname(exe), stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
if (result.error || result.status !== 0) {
  console.error(`Could not open terminal-cowork: ${result.error?.message ?? result.stderr?.trim() ?? `exit code ${result.status}`}`);
  process.exit(1);
}
console.log('Opening terminal-cowork');
