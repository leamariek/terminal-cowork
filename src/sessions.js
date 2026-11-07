// Every Claude Code session on this machine, including ones started outside the app (tmux, other terminals),
// with the background work each one is running. Read only: Claude Code's own records, nothing is configured.
//   ~/.claude/sessions/<pid>.json   one per running session: id, folder, name, live status
//   ~/.claude/projects/*/<id>.jsonl the transcript: background tool calls and their end notices
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const claudeDir = () => process.env.COWORK_CLAUDE_DIR ?? join(homedir(), '.claude');
const RECENT_MS = 10 * 60 * 1000; // Finished work stays on the card this long, then it drops off.

// A record is live only if its pid still runs the same process: pids get reused.
function alive(s) {
  try {
    const stat = readFileSync(`/proc/${s.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return !s.procStart || fields[19] === String(s.procStart);
  } catch { return false; }
}

export function liveSessions() {
  const dir = join(claudeDir(), 'sessions');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (s.sessionId && alive(s)) out.push(s);
    } catch { /* A record being rewritten right now: next scan. */ }
  }
  return out;
}

// Transcripts are append-only, so each one is read once and then only its new bytes.
const followed = new Map();

function transcriptFor(s) {
  const slug = s.cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const direct = join(claudeDir(), 'projects', slug, `${s.sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  const projects = join(claudeDir(), 'projects');
  for (const d of existsSync(projects) ? readdirSync(projects) : []) {
    const p = join(projects, d, `${s.sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

const KINDS = { Workflow: 'Workflow', Monitor: 'Monitor', Bash: 'Shell', Agent: 'Agent', Task: 'Agent' };
const TASK_ID = /(?:Task ID: |with ID: |\(task |agentId: )([a-z0-9]+)/;
const firstLine = (t) => String(t ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';

function labelFor(name, input) {
  if (name === 'Workflow') {
    // Named like Claude Code's own task list (the script name), plus the argument that tells runs apart.
    let script = String(input.script ?? '');
    if (!script && input.scriptPath) { try { script = readFileSync(input.scriptPath, 'utf8').slice(0, 4000); } catch { /* Gone: fall back below. */ } }
    const title = /name:\s*['"`]([^'"`]+)/.exec(script)?.[1] ?? input.name ?? String(input.scriptPath ?? '').split('/').pop().replace(/\.m?js$/, '') ?? 'Workflow';
    const args = input.args && typeof input.args === 'object' ? input.args : {};
    const which = ['key', 'name', 'title', 'task', 'id'].map((k) => args[k]).find((v) => typeof v === 'string' && v.length <= 60);
    return which ? `${title || 'Workflow'} · ${which}` : title || 'Workflow';
  }
  return firstLine(input.description) || firstLine(input.command || input.prompt).slice(0, 80) || KINDS[name];
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join(' ');
  return '';
}

function readLine(t, line, isMain = true) {
  if (!/"tool_use"|"tool_result"|task-notification|"type":"user"/.test(line)) return;
  let d;
  try { d = JSON.parse(line); } catch { return; }
  const at = Date.parse(d.timestamp ?? '') || Date.now();
  if (d.type === 'queue-operation' || d.type === 'user') {
    const text = d.type === 'queue-operation' ? String(d.content ?? '') : textOf(d.message?.content);
    for (const m of text.matchAll(/<task-notification>[\s\S]*?<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>([^<]+)<\/status>/g)) {
      const state = m[2] === 'completed' ? 'done' : m[2];
      const task = t.tasks.get(m[1]);
      if (task && task.state === 'running') { task.state = state; task.ended = at; } else if (!task) t.endings.set(m[1], { state, at });   // The task may sit in a subagent file read later.
    }
    if (isMain && d.type === 'user' && typeof d.message?.content === 'string' && !d.message.content.startsWith('<') && !d.isMeta) t.prompt = d.message.content.slice(0, 200);
    if (isMain && d.type === 'queue-operation' && d.operation === 'enqueue' && text && !text.startsWith('<')) t.prompt = text.slice(0, 200);
  }
  const content = d.message?.content;
  if (!Array.isArray(content) || (d.type !== 'assistant' && d.type !== 'user')) return;   // api-request copies repeat old calls.
  for (const b of content) {
    if (b.type === 'tool_use' && d.type === 'assistant' && KINDS[b.name]) {
      const input = b.input ?? {};
      const background = b.name === 'Workflow' || b.name === 'Monitor' || input.run_in_background;
      if (b.name === 'Bash' && !background) continue;
      // A foreground agent runs until its result comes back; background work until its end notice.
      const end = t.endings.get(b.id);
      t.tasks.set(b.id, { id: b.id, kind: KINDS[b.name], label: labelFor(b.name, input), state: end?.state ?? 'running', started: at, ended: end?.at, background: Boolean(background), file: t.reading });
    } else if (b.type === 'tool_use' && d.type === 'assistant' && b.name === 'TaskStop') {
      const stopped = [...t.tasks.values()].find((x) => x.taskId === b.input?.task_id && x.state === 'running');
      if (stopped) { stopped.state = 'stopped'; stopped.ended = at; }
    } else if (b.type === 'tool_result' && t.tasks.has(b.tool_use_id)) {
      const task = t.tasks.get(b.tool_use_id);
      const text = textOf(b.content);
      task.taskId = TASK_ID.exec(text)?.[1];
      task.dir = /Transcript dir: (\S+)/.exec(text)?.[1];
      if (!task.background || b.is_error || !task.taskId) { task.state = b.is_error ? 'failed' : 'done'; task.ended = at; }
    }
  }
}

// One task list per session, fed by the main transcript and by its subagent transcripts:
// workflow agents start shells and monitors of their own, and their end notices reach the main transcript.
const SUBAGENT_WINDOW_MS = 3 * 60 * 60 * 1000;

function readNew(t, path, isMain) {
  let f = t.files.get(path);
  if (!f) { f = { offset: 0, rest: '' }; t.files.set(path, f); }
  const size = statSync(path).size;
  if (size === f.offset) return;
  if (size < f.offset) { f.offset = 0; f.rest = ''; }
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - f.offset);
    readSync(fd, buf, 0, buf.length, f.offset);
    f.offset = size;
    const lines = (f.rest + buf.toString('utf8')).split('\n');
    f.rest = lines.pop();
    t.reading = path;
    for (const line of lines) readLine(t, line, isMain);
  } finally { closeSync(fd); }
}

function subagentFiles(dir, now, known) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl') && (known.has(p) || now - statSync(p).mtimeMs < SUBAGENT_WINDOW_MS)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function follow(sessionId, path, now) {
  let t = followed.get(sessionId);
  if (!t) { t = { files: new Map(), tasks: new Map(), endings: new Map(), prompt: '' }; followed.set(sessionId, t); }
  readNew(t, path, true);
  for (const p of subagentFiles(path.replace(/\.jsonl$/, '/subagents'), now, t.files)) {
    try { readNew(t, p, false); } catch { /* Being written: next scan. */ }
  }
  return t;
}

const STATES = { busy: 'working', shell: 'working', waiting: 'needs', idle: 'done' };

export function scanSessions(now = Date.now()) {
  return liveSessions().map((s) => {
    let t = { tasks: new Map(), prompt: '' };
    const path = transcriptFor(s);
    try { if (path) t = follow(s.sessionId, path, now); } catch { /* Unreadable transcript: show the session without its work. */ }
    // Work started inside a workflow ends with that workflow, notice or not.
    const ended = [...t.tasks.values()].filter((x) => x.dir && x.state !== 'running');
    for (const x of t.tasks.values()) {
      const owner = x.state === 'running' && x.file && ended.find((w) => x.file.startsWith(w.dir));
      if (owner) { x.state = 'stopped'; x.ended = owner.ended; }
    }
    const tasks = [...t.tasks.values()]
      .filter((x) => x.state === 'running' || now - (x.ended ?? 0) < RECENT_MS)
      .sort((a, b) => (b.state === 'running') - (a.state === 'running') || b.started - a.started)
      .map(({ id, kind, label, state, started, ended }) => ({ id, kind, label, state, started, ended }));
    const state = s.status === 'idle' && !t.prompt ? 'ready' : STATES[s.status] ?? 'working';
    return {
      sessionId: s.sessionId, pid: s.pid, name: s.name ?? 'Claude Code', cwd: s.cwd, folder: s.cwd.split('/').pop() || '/',
      state, since: s.statusUpdatedAt ?? s.updatedAt ?? now, prompt: t.prompt, tasks,
    };
  });
}
