// Runs inside WSL. Owns the terminal and the agent socket, and talks to the window over stdin and stdout.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import pty from 'node-pty';
import { claudeFlags, dataDir, prepareGrok } from '../src/claude-config.js';
import { buildPreview, setFileUrl } from '../src/preview.js';
import { scanSessions } from '../src/sessions.js';
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

// opts.resume: { claude: sessionId, working } reopens a Claude Code session, { tmux: name } reattaches a tmux session.
function addTerminal(kind, opts = {}) {
  const id = ++termCount;
  const isAgent = kind !== 'shell';
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : startFolder;
  const grokHome = kind === 'grok' ? { GROK_HOME: prepareGrok(root) } : {};
  const r = opts.resume ?? {};
  const resume = r.claude ? ['--resume', r.claude, ...(r.working ? ['The app restarted while you were working. Continue where you left off.'] : [])] : [];
  const command = kind === 'claude' ? process.env.COWORK_SHELL_COMMAND ?? `claude ${[...claudeFlags(root), ...resume].map(quote).join(' ')}; exec bash -l`
    : kind === 'grok' ? 'grok; exec bash -l'
      : r.tmux ? `tmux attach -t ${quote(r.tmux)}; exec bash -l` : 'exec bash -l';
  const name = opts.name ?? nameFor(kind);
  const proc = pty.spawn('bash', ['-lic', command], {
    name: 'xterm-256color', ...lastSize, cwd,
    env: { ...process.env, COLORTERM: 'truecolor', TERM_PROGRAM: 'terminal-cowork', COWORK_TERM: String(id), ...grokHome },
  });
  const entry = { id, kind, name, proc, cwd, sessionId: r.claude, folder: cwd.split('/').pop(), agent: isAgent ? { kind, state: 'ready', prompt: '', activity: r.claude ? 'Resuming' : 'Starting', since: Date.now(), subagents: 0 } : null };
  terms.set(id, entry);
  send({ t: 'termAdded', id, kind, name });
  proc.onData((d) => send({ t: 'pty', id, d }));
  proc.onExit(() => closed(id));
  if (id === 1) proc.write(early.splice(0).join('')); // Keys typed before the shell existed still count.
  pushAgents();
}

// ---- Continue after a restart or an update: what each terminal holds is written down and reopened on the next start. ----

const restoreFile = join(dataDir, 'restore.json');
const childrenOf = (pid) => { try { return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; } };
const descendants = (pid) => { const out = []; const walk = (p, depth) => { if (depth > 12) return; for (const c of childrenOf(p)) { out.push(c); walk(c, depth + 1); } }; walk(pid, 0); return out; };
const cmdline = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return []; } };
const cwdOf = (pid) => { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } };
function tmuxClients() {
  try { return new Map(execFileSync('tmux', ['list-clients', '-F', '#{client_pid} #{session_name}'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean).map((l) => { const i = l.indexOf(' '); return [Number(l.slice(0, i)), l.slice(i + 1)]; })); } catch { return new Map(); }
}

function snapshot() {
  const clients = tmuxClients();
  return [...terms.values()].map((t) => {
    const kids = descendants(t.proc.pid);
    const claudePid = [t.proc.pid, ...kids].find((p) => /(^|\/)claude$/.test(cmdline(p)[0] ?? ''));   // Started in the shell, or exec'd in its place.
    const live = claudePid && sessions.find((s) => s.pid === claudePid);
    const sessionId = live?.sessionId ?? (t.kind === 'claude' ? t.sessionId : undefined);
    const tmux = kids.map((p) => clients.get(p)).find(Boolean);
    const cwd = live?.cwd ?? cwdOf(kids.at(-1) ?? t.proc.pid) ?? t.cwd;
    const working = live ? live.state === 'working' || live.state === 'needs' : t.agent ? t.agent.state === 'working' || t.agent.state === 'needs' : false;
    if (sessionId) return { kind: 'claude', name: t.name, cwd, resume: { claude: sessionId, working } };
    if (tmux) return { kind: 'shell', name: t.name, cwd, resume: { tmux } };
    return { kind: t.kind === 'claude' ? 'claude' : t.kind, name: t.name, cwd };
  });
}
let lastSaved = '';
const RESTORE = process.env.COWORK_TEST !== '1' || Boolean(process.env.COWORK_RESTORE);   // Test instances never touch the person's list.
function saveRestore(force = false) {
  if (!RESTORE) return;
  if (!terms.size && !force) return;   // Shutting down closes terminals one by one: keep the last full picture.
  try {
    const text = JSON.stringify(snapshot());
    if (text !== lastSaved) { writeFileSync(restoreFile, text); lastSaved = text; }
  } catch { /* Never let bookkeeping take the app down. */ }
}
function restore() {
  if (!RESTORE) return false;   // Tests start clean unless they test this.
  let list = [];
  try { list = JSON.parse(readFileSync(restoreFile, 'utf8')); } catch { return false; }
  if (!Array.isArray(list) || !list.length) return false;
  for (const t of list) addTerminal(['claude', 'grok', 'shell'].includes(t.kind) ? t.kind : 'shell', t);
  return true;
}

function closed(id) {
  if (!terms.delete(id)) return;
  send({ t: 'termClosed', id });
  pushAgents();
}

// The board: the app's own agent terminals (live state from hooks) plus every other Claude Code session on this
// machine, read from Claude Code's records. Each card carries that session's background work.
let sessions = [];
const parentOf = (pid) => { try { const st = readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); } catch { return 0; } };
function terminalOf(pid) {
  const shells = new Map([...terms.values()].map((t) => [t.proc.pid, t.id]));
  for (let p = pid, hops = 0; p > 1 && hops < 40; p = parentOf(p), hops++) if (shells.has(p)) return shells.get(p);
  return null;
}
const running = (tasks) => {
  const n = {};
  for (const x of tasks) if (x.state === 'running') n[x.kind] = (n[x.kind] ?? 0) + 1;
  const words = { Workflow: 'workflow', Shell: 'shell', Monitor: 'monitor', Agent: 'agent' };
  return Object.entries(n).map(([k, c]) => `${c} ${words[k] ?? k.toLowerCase()}${c > 1 ? 's' : ''}`).join(', ');
};
const ACTIVITY = { working: 'Working', needs: 'Needs you', done: 'Finished', ready: 'Waiting for a prompt' };

function agentList() {
  const own = [...terms.values()].filter((t) => t.agent).map(({ id, name, folder, agent, sessionId }) => {
    const s = sessions.find((x) => x.sessionId === sessionId);
    return { id, term: id, name, folder, ...agent, tasks: s?.tasks ?? [] };
  });
  const ownIds = new Set([...terms.values()].map((t) => t.sessionId).filter(Boolean));
  const others = sessions.filter((s) => !ownIds.has(s.sessionId)).map((s) => {
    const busy = running(s.tasks);
    return { id: `s:${s.sessionId}`, term: terminalOf(s.pid), name: s.name, folder: s.folder, state: s.state, since: s.since, prompt: s.prompt,
      activity: busy ? `${ACTIVITY[s.state] ?? 'Working'}, ${busy} running` : ACTIVITY[s.state] ?? 'Working', subagents: 0, tasks: s.tasks, outside: true };
  });
  return [...own, ...others];
}
let lastPushed = '';
function pushAgents() {
  const list = agentList();
  const text = JSON.stringify(list);
  if (text === lastPushed) return;
  lastPushed = text;
  send({ t: 'agents', list });
}
function rescan() {
  try { sessions = scanSessions(); } catch { sessions = []; }
  pushAgents();
  saveRestore();
}
setInterval(rescan, 2000).unref();

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
  if (hook.session_id) entry.sessionId = hook.session_id;
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
  saveRestore();   // Before the terminals close, so the next start can bring them back.
  server.close();
  rmSync(sock, { force: true });
  for (const t of terms.values()) t.proc.kill();
  process.exit(0);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.t === 'start') { if (!restore()) addTerminal('claude'); }
  else if (m.t === 'new') addTerminal(m.kind);
  else if (m.t === 'rename') {
    const t = terms.get(m.id), name = String(m.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (t && name) { t.name = name; send({ t: 'termRenamed', id: m.id, name }); pushAgents(); saveRestore(true); }
  }
  else if (m.t === 'close') { terms.get(m.id)?.proc.kill(); closed(m.id); saveRestore(true); } else if (m.t === 'input') { const t = terms.get(m.id); if (t) t.proc.write(m.d); else early.push(m.d); } else if (m.t === 'resize') { lastSize = { cols: m.cols, rows: m.rows }; terms.get(m.id)?.proc.resize(m.cols, m.rows); }
  else if (m.t === 'rpcReply') {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.error) w?.rej(new Error(m.error)); else w?.res(m.result);
  }
});
lines.on('close', quit); // The window closed, so everything here closes with it.
process.on('SIGTERM', quit);
process.on('SIGHUP', quit);   // Closing the Windows window can end WSL's side this way.
