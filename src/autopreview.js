// Claude Code hook: when Claude writes a previewable file, show it in the Preview tab.
import { extname, resolve } from 'node:path';
import { call } from './rpc.js';

const SHOWN = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.md', '.html', '.pdf', '.csv', '.xlsx', '.mp4', '.webm']);
// Claude also writes files from the shell, such as: cat > notes.md
const REDIRECT = /(?:^|[^>0-9&])>\s*["']?([^\s"'|;&<>]+)/g;

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { tool_input: tool = {}, cwd = process.cwd() } = JSON.parse(input);
const written = tool.file_path ? [tool.file_path] : [...String(tool.command ?? '').matchAll(REDIRECT)].map((m) => resolve(cwd, m[1]));
const path = written.filter((p) => SHOWN.has(extname(p).toLowerCase())).at(-1);
if (path) await call('preview', { path }, 10000).catch(() => {}); // A preview must never get in the way of Claude's work.
