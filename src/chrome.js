// Starts headless Chrome and speaks the DevTools protocol over a private pipe, so no port is opened.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export async function launchChrome({ profile }) {
  mkdirSync(profile, { recursive: true });
  const proc = spawn('google-chrome', [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--password-store=basic', // WSL has no desktop keyring, and waiting for one hangs every network page.
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  // The d3d12 GPU flags give transparent frames in headless screenshots on WSL, so Chrome keeps its defaults.

  const toChrome = proc.stdio[3];
  const fromChrome = proc.stdio[4];
  let id = 0;
  let tail = Buffer.alloc(0);
  const pending = new Map();
  const listeners = new Set();

  fromChrome.on('data', (chunk) => {
    tail = Buffer.concat([tail, chunk]);
    let end;
    while ((end = tail.indexOf(0)) >= 0) {
      const msg = JSON.parse(tail.subarray(0, end).toString());
      tail = tail.subarray(end + 1);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg.method, msg.params, msg.sessionId);
      }
    }
  });

  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej });
    toChrome.write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });

  const exited = new Promise((res) => proc.once('exit', res));
  return {
    send,
    exited,
    onEvent: (fn) => listeners.add(fn),
    close: () => proc.kill(),
  };
}

// One page, with everything the pane and the agent need switched on.
export async function openTab(chrome, { width, height }) {
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
  const tab = {
    targetId,
    sessionId,
    send: (method, params) => chrome.send(method, params, sessionId),
  };
  await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable'].map((m) => tab.send(m)));
  await tab.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await resizeTab(tab, { width, height });
  return tab;
}

export const resizeTab = (tab, { width, height }) => tab.send('Emulation.setDeviceMetricsOverride', {
  width, height, deviceScaleFactor: 1, mobile: false,
});
