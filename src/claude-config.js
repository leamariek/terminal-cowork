// Writes what Claude Code needs to see the workspace, and returns the flags. Global settings stay untouched.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// The events that drive the Agents board.
const AGENT_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop'];

export const dataDir = process.env.COWORK_DATA_DIR ?? join(homedir(), '.local/share/terminal-cowork');   // Tests get their own.

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

// Grok has no per-session flag for hooks or tools, so sessions started here get a private GROK_HOME:
// links to the person's real Grok folder, plus a copy of their config with this app's hooks added.
// Their own ~/.grok stays untouched, and Grok sessions started elsewhere are unaffected.
export function prepareGrok(root) {
  const real = join(homedir(), '.grok');
  const home = join(dataDir, 'grok-home');
  mkdirSync(home, { recursive: true });
  for (const name of existsSync(real) ? readdirSync(real) : []) {
    const link = join(home, name);
    // The sign-in stays separate: Grok rewrites it, and a link could overwrite the person's real login.
    if (name.startsWith('auth')) { if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(link); continue; }
    if (name !== 'config.toml' && !lstatSync(link, { throwIfNoEntry: false })) symlinkSync(join(real, name), link);
  }
  const toml = (s) => JSON.stringify(s);
  const hook = (event, script) => `[[hooks.${event}]]\n  [[hooks.${event}.hooks]]\n  type = "command"\n  command = ${toml(`${process.execPath} ${resolve(root, script)}`)}\n  timeout = 10\n`;
  const own = existsSync(join(real, 'config.toml')) ? readFileSync(join(real, 'config.toml'), 'utf8') : '';
  const added = [`[mcp_servers.cowork]\ncommand = ${toml(process.execPath)}\nargs = [${toml(resolve(root, 'src/mcp.js'))}]\n`,
    ...AGENT_EVENTS.map((e) => hook(e, 'src/agent-hook.js')), hook('PostToolUse', 'src/autopreview.js')].join('\n');
  writeFileSync(join(home, 'config.toml'), `${own.trimEnd()}\n\n${added}`);
  return home;
}
