// Runs inside WSL. Owns the terminal and the agent socket, and talks to the window over stdin and stdout.
import { writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import pty from 'node-pty';
import { claudeFlags, dataDir } from '../src/claude-config.js';
import { buildPreview, setFileUrl } from '../src/preview.js';
import { socketPath } from '../src/rpc.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const stateDir = join(dataDir, 'state');
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
if (process.env.COWORK_WINDOWS === '1') {
  const distro = process.env.WSL_DISTRO_NAME;
  setFileUrl((p) => `file://wsl.localhost/${distro}${encodeURI(p)}`);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const quote = (a) => `'${a.replace(/'/g, `'\\''`)}'`;

let term;
const early = [];
function startTerminal(cols, rows) {
  const command = process.env.COWORK_SHELL_COMMAND ?? `claude ${claudeFlags(root).map(quote).join(' ')}; exec bash -l`;
  term = pty.spawn('bash', ['-lic', command], { name: 'xterm-256color', cols, rows, cwd: process.env.COWORK_CWD ?? homedir(), env: { ...process.env, COLORTERM: 'truecolor', TERM_PROGRAM: 'Cowork' } });
  term.onData((d) => send({ t: 'pty', d }));
  term.write(early.splice(0).join('')); // Keys typed before the shell existed still count.
  term.onExit(() => send({ t: 'ptyExit' }));
}

// Calls that the window answers.
let nextId = 0;
const waiting = new Map();
const ask = (method, params) => new Promise((res, rej) => {
  const id = ++nextId;
  waiting.set(id, { res, rej });
  send({ t: 'rpc', id, method, params });
});

const savePng = (base64, path) => { writeFileSync(path, Buffer.from(base64, 'base64')); return path; };

async function handle(method, params) {
  if (method === 'preview') {
    const url = buildPreview(params.path, stateDir);
    return ask('showPreview', { url, title: params.path.split('/').pop() });
  }
  if (method === 'shot') {
    const { png } = await ask('shot', {});
    return { path: savePng(png, params.path ?? join(stateDir, 'shot.png')) };
  }
  if (method === 'uiShot') {
    const { png } = await ask('uiShot', {});
    return { path: savePng(png, params.path) };
  }
  if (method === 'picked') {
    const picked = await ask('picked', {});
    if (picked?.png) { picked.screenshot = savePng(picked.png, join(stateDir, 'picked.png')); delete picked.png; }
    return picked;
  }
  return ask(method, params);
}

const sock = socketPath();
rmSync(sock, { force: true });
const server = createServer((c) => {
  let buf = '';
  c.on('error', () => {});
  c.on('data', async (d) => {
    buf += d;
    const end = buf.indexOf('\n');
    if (end < 0) return;
    const { method, params } = JSON.parse(buf.slice(0, end));
    buf = '';
    const reply = await handle(method, params ?? {}).then((result) => ({ result: result ?? null }), (e) => ({ error: e.message }));
    c.end(JSON.stringify(reply) + '\n');
  });
});
server.listen(sock, () => chmodSync(sock, 0o600));

function quit() {
  server.close();
  rmSync(sock, { force: true });
  term?.kill();
  process.exit(0);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.t === 'start') startTerminal(m.cols, m.rows);
  else if (m.t === 'input') { if (term) term.write(m.d); else early.push(m.d); }
  else if (m.t === 'resize') term?.resize(m.cols, m.rows);
  else if (m.t === 'rpcReply') {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.error) w?.rej(new Error(m.error)); else w?.res(m.result);
  }
});
lines.on('close', quit); // The window closed, so everything here closes with it.
process.on('SIGTERM', quit);
