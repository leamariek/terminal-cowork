// Same-user control channel: newline-delimited JSON over a Unix socket inside the private runtime directory, or on
// native Windows over a named pipe. A pipe can be opened by other local accounts, so there every request carries the
// session's random token (COWORK_TOKEN, inherited by the terminals, hooks and MCP server the app starts).
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function socketPath() {
  if (process.env.COWORK_SOCK) return process.env.COWORK_SOCK;
  const base = process.env.XDG_RUNTIME_DIR ?? (process.platform === 'darwin' ? tmpdir() : undefined);   // macOS: the private per-user temp folder.
  if (!base) throw new Error('XDG_RUNTIME_DIR is not set, so there is no private place for the socket');
  return join(base, 'cowork.sock');
}

export function call(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath());
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`${method} timed out`)); }, timeoutMs);
    sock.once('connect', () => sock.write(JSON.stringify({ method, params, token: process.env.COWORK_TOKEN }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const end = buf.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      sock.destroy();
      const reply = JSON.parse(buf.slice(0, end));
      if (reply.error) reject(new Error(reply.error));
      else resolve(reply.result);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new Error('The cowork pane is not running. Start it with: cowork') : e);
    });
  });
}
