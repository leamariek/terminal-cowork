// Runs inside WSL. Owns the terminal and the agent socket, and talks to the window over stdin and stdout.
import { writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import pty from 'node-pty';
import { claudeFlags, dataDir, prepareGrok } from '../src/claude-config.js';
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

// Every terminal is its own PTY. The first one starts Claude Code, later ones are whatever the person adds.
const terms = new Map();
const early = [];
let termCount = 0;
let lastSize = { cols: 100, rows: 30 };
const startFolder = process.env.COWORK_CWD ?? homedir();

function nameFor(kind) {
  const base = { claude: 'Claude Code', grok: 'Grok' }[kind] ?? 'Shell';
  const same = [...terms.values()].filter((t) => t.kind === kind).length;
  return same ? `${base} ${same + 1}` : base;
}

function addTerminal(kind) {
  const id = ++termCount;
  const isAgent = kind !== 'shell';
  const grokHome = kind === 'grok' ? { GROK_HOME: prepareGrok(root) } : {};
  const command = kind === 'claude' ? process.env.COWORK_SHELL_COMMAND ?? `claude ${claudeFlags(root).map(quote).join(' ')}; exec bash -l`
    : kind === 'grok' ? 'grok; exec bash -l' : 'exec bash -l';
  const name = nameFor(kind);
  const proc = pty.spawn('bash', ['-lic', command], {
    name: 'xterm-256color', ...lastSize, cwd: startFolder,
    env: { ...process.env, COLORTERM: 'truecolor', TERM_PROGRAM: 'terminal-cowork', COWORK_TERM: String(id), ...grokHome },
  });
  const entry = { id, kind, name, proc, folder: startFolder.split('/').pop(), agent: isAgent ? { kind, state: 'ready', prompt: '', activity: 'Starting', since: Date.now(), subagents: 0 } : null };
  terms.set(id, entry);
  send({ t: 'termAdded', id, kind, name });
  proc.onData((d) => send({ t: 'pty', id, d }));
  proc.onExit(() => closed(id));
  if (id === 1) proc.write(early.splice(0).join('')); // Keys typed before the shell existed still count.
  pushAgents();
}

function closed(id) {
  if (!terms.delete(id)) return;
  send({ t: 'termClosed', id });
  pushAgents();
}

const agentList = () => [...terms.values()].filter((t) => t.agent).map(({ id, name, folder, agent }) => ({ id, name, folder, ...agent }));
const pushAgents = () => send({ t: 'agents', list: agentList() });

function describeTool(tool, input = {}) {
  if (tool === 'Bash') return `Running ${String(input.command ?? 'a command').split('\n')[0].slice(0, 70)}`;
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') return `Editing ${String(input.file_path ?? 'a file').split('/').pop()}`;
  if (tool === 'Read') return `Reading ${String(input.file_path ?? 'a file').split('/').pop()}`;
  if (tool === 'Grep' || tool === 'Glob') return 'Searching the project';
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'Searching the web';
  if (tool === 'Task' || tool === 'Agent') return 'Starting a subagent';
  const browser = /^(?:mcp__)?cowork__(.+)$/.exec(tool ?? '');
  if (browser) return `Browser: ${browser[1]}`;
  return `Using ${tool}`;
}

// One event from a Claude Code hook. Hooks are the source of truth, the screen is never parsed.
function agentEvent({ term, event, hook }) {
  const entry = terms.get(Number(term));
  if (!entry?.agent) return;
  const a = entry.agent;
  const move = (state, activity) => { if (a.state !== state) a.since = Date.now(); a.state = state; if (activity) a.activity = activity; };
  if (hook.cwd) entry.folder = hook.cwd.split('/').pop();
  if (event === 'SessionStart') move('ready', 'Waiting for a prompt');
  else if (event === 'UserPromptSubmit') { a.prompt = String(hook.prompt ?? '').slice(0, 200); move('working', 'Thinking'); } else if (event === 'PreToolUse') move('working', describeTool(hook.tool_name, hook.tool_input));
  else if (event === 'PermissionRequest') move('needs', `Asking to use ${hook.tool_name}`);
  else if (event === 'Notification') { if (['permission_prompt', 'elicitation_dialog'].includes(hook.notification_type)) move('needs', hook.message ?? 'Needs your input'); } else if (event === 'SubagentStart') a.subagents += 1;
  else if (event === 'SubagentStop') a.subagents = Math.max(0, a.subagents - 1);
  else if (event === 'Stop') { a.subagents = 0; move('done', 'Finished'); } else if (event === 'SessionEnd') { entry.agent = null; }
  pushAgents();
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
  if (method === 'agent') { agentEvent(params); return {}; }
  if (method === 'agents') return agentList();
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
  for (const t of terms.values()) t.proc.kill();
  process.exit(0);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.t === 'start') addTerminal('claude');
  else if (m.t === 'new') addTerminal(m.kind);
  else if (m.t === 'close') { terms.get(m.id)?.proc.kill(); closed(m.id); } else if (m.t === 'input') { const t = terms.get(m.id); if (t) t.proc.write(m.d); else early.push(m.d); } else if (m.t === 'resize') { lastSize = { cols: m.cols, rows: m.rows }; terms.get(m.id)?.proc.resize(m.cols, m.rows); }
  else if (m.t === 'rpcReply') {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.error) w?.rej(new Error(m.error)); else w?.res(m.result);
  }
});
lines.on('close', quit); // The window closed, so everything here closes with it.
process.on('SIGTERM', quit);
