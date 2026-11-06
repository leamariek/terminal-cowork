// Claude Code hook: when Claude writes a previewable file, show it in the Preview tab.
import { extname } from 'node:path';
import { call } from './rpc.js';

const SHOWN = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.md', '.html', '.pdf', '.csv', '.xlsx', '.mp4', '.webm']);

let input = '';
for await (const chunk of process.stdin) input += chunk;
const path = JSON.parse(input).tool_input?.file_path;
if (path && SHOWN.has(extname(path).toLowerCase())) {
  await call('preview', { path }, 10000).catch(() => {}); // A preview must never get in the way of Claude's work.
}
