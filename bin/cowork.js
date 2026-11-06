#!/usr/bin/env node
// cowork: starts the workspace, or sends one command to a running pane.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call } from '../src/rpc.js';

const root = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..');
const TMUX = ['-L', 'cowork', '-f', join(root, 'tmux.conf')];
const cellFile = join(homedir(), '.local/share/terminal-cowork/cell');

// Asks the real terminal what it supports, before tmux sits in between.
function probeTerminal() {
  const script = `
import os, re, select, sys, termios, time, tty
fd = os.open('/dev/tty', os.O_RDWR)
old = termios.tcgetattr(fd)
tty.setraw(fd)
try:
    os.write(fd, b'\\x1b[16t\\x1b[c')
    buf, end = b'', time.time() + 1.5
    while time.time() < end and not re.search(rb'\\x1b\\[\\?[\\d;]*c', buf):
        if select.select([fd], [], [], 0.05)[0]:
            buf += os.read(fd, 1024)
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
print(buf.decode('latin1').replace('\\x1b', 'E'))
`;
  const reply = execFileSync('python3', ['-I', '-c', script], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  const da = /E\[\?([\d;]*)c/.exec(reply);
  const cell = /E\[6;(\d+);(\d+)t/.exec(reply);
  return {
    sixel: Boolean(da && da[1].split(';').includes('4')),
    cell: cell ? `${cell[2]}x${cell[1]}` : null,
  };
}

function writeClaudeConfig() {
  const dir = join(homedir(), '.local/share/terminal-cowork');
  mkdirSync(dir, { recursive: true });
  const mcp = join(dir, 'mcp.json');
  const settings = join(dir, 'settings.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: { cowork: { command: process.execPath, args: [join(root, 'src/mcp.js')] } } }, null, 2));
  writeFileSync(settings, JSON.stringify({
    hooks: {
      PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: `${process.execPath} ${join(root, 'src/autopreview.js')}` }] }],
    },
  }, null, 2));
  return { mcp, settings };
}

function up(claudeArgs) {
  const running = spawnSync('tmux', [...TMUX, 'has-session', '-t', 'cowork'], { stdio: 'ignore' }).status === 0;
  if (running) {
    // Reattaching goes through the proxy too, or tmux falls back to its default cell and shrinks the images.
    const cell = readFileSync(cellFile, 'utf8').trim().split('x');
    spawnSync('python3', ['-P', join(root, 'src/ptyproxy.py'), ...cell, 'tmux', ...TMUX, 'attach', '-t', 'cowork'], { stdio: 'inherit' });
    return;
  }
  const term = probeTerminal();
  if (!term.sixel) {
    console.error('This terminal does not report Sixel support. Windows Terminal 1.22 or later does.');
    process.exit(1);
  }
  if (!term.cell) {
    console.error('This terminal does not report its cell size, and tmux would silently drop every image.');
    process.exit(1);
  }
  const { mcp, settings } = writeClaudeConfig();
  const skill = readFileSync(join(root, 'skills/cowork/SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '');
  const promptFile = join(dirname(mcp), 'prompt.md');
  writeFileSync(promptFile, skill);
  const left = ['claude', '--mcp-config', mcp, '--settings', settings, '--append-system-prompt-file', promptFile, ...claudeArgs]
    .map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const chat = `${left}; tmux -L cowork kill-session -t cowork`; // The browser pane closes with the chat.
  const right = `COWORK_CELL=${term.cell} ${process.execPath} ${join(root, 'src/pane.js')} 2>>${join(dirname(mcp), 'pane.log')}`;
  writeFileSync(cellFile, term.cell);
  spawnSync('python3', ['-P', join(root, 'src/ptyproxy.py'), ...term.cell.split('x'), 'tmux', ...TMUX,
    'new-session', '-s', 'cowork', '-c', process.cwd(), chat, ';',
    'split-window', '-h', '-l', '50%', right, ';', 'select-pane', '-L'], { stdio: 'inherit' });
}

const [cmd, ...args] = process.argv.slice(2);
const print = (r) => console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
const commands = {
  open: () => call('open', { url: args[0] }),
  preview: () => call('preview', { path: resolve(args[0]) }),
  click: () => (args.length === 1 ? call('click', { ref: +args[0] }) : call('click', { x: +args[0], y: +args[1] })),
  type: () => call('type', { text: args.join(' ') }),
  key: () => call('key', { key: args[0] }),
  scroll: () => call('scroll', { dy: +args[0] }),
  shot: () => call('shot', { path: args[0] && resolve(args[0]) }),
  snapshot: () => call('snapshot'),
  logs: () => call('logs', { limit: +(args[0] ?? 50) }),
  picked: () => call('picked'),
  status: () => call('status'),
  tab: () => call('tab', { name: args[0] }),
  quit: () => call('quit'),
  call: () => call(args[0], JSON.parse(args[1] ?? '{}')),
};

if (cmd === undefined || cmd === 'up') up(cmd ? args : []);
else if (cmd === '--') up(args);
else if (commands[cmd]) {
  commands[cmd]().then(print, (e) => { console.error(e.message); process.exit(1); });
} else {
  console.error(`Unknown command: ${cmd}\nCommands: up, ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
