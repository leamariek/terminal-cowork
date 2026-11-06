// Claude Code hook: reports what this session is doing to the Agents board.
import { call } from './rpc.js';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const hook = JSON.parse(input);
const term = process.env.COWORK_TERM;
if (term) await call('agent', { term, event: hook.hook_event_name, hook }, 3000).catch(() => {}); // The board must never get in Claude's way.
