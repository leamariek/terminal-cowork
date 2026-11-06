// Writes what Claude Code needs to see the workspace, and returns the flags. Global settings stay untouched.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// The events that drive the Agents board.
const AGENT_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop'];

export const dataDir = join(homedir(), '.local/share/terminal-cowork');

export function claudeFlags(root) {
  mkdirSync(dataDir, { recursive: true });
  const mcp = join(dataDir, 'mcp.json');
  const settings = join(dataDir, 'settings.json');
  const prompt = join(dataDir, 'prompt.md');
  writeFileSync(mcp, JSON.stringify({ mcpServers: { cowork: { command: process.execPath, args: [resolve(root, 'src/mcp.js')] } } }, null, 2));
  writeFileSync(settings, JSON.stringify({
    hooks: {
      PostToolUse: [{ matcher: 'Write|Edit|Bash', hooks: [{ type: 'command', command: `${process.execPath} ${resolve(root, 'src/autopreview.js')}` }] }],
      ...Object.fromEntries(AGENT_EVENTS.map((event) => [event, [{ hooks: [{ type: 'command', command: `${process.execPath} ${resolve(root, 'src/agent-hook.js')}` }] }]])),
    },
  }, null, 2));
  writeFileSync(prompt, readFileSync(resolve(root, 'skills/cowork/SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, ''));
  return ['--mcp-config', mcp, '--settings', settings, '--append-system-prompt-file', prompt];
}
