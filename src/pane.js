// The right-hand pane: owns Chrome, paints it as Sixel, routes input, and serves the agent.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, openTab, resizeTab } from './chrome.js';
import { buildPreview } from './preview.js';
import { socketPath } from './rpc.js';
import { decode, encodeFast, encodeFine } from './sixel.js';

const [cellW, cellH] = (process.env.COWORK_CELL ?? '10x20').split('x').map(Number);
const stateDir = join(process.env.XDG_RUNTIME_DIR ?? homedir(), 'cowork-state');
const profile = process.env.COWORK_PROFILE ?? join(homedir(), '.local/share/terminal-cowork/profile');
const BAR_ROWS = 1;
const FOOT_ROWS = 1;
const LOG_LIMIT = 300;
const FINE_DELAY_MS = 250;
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const STRIPE = (6 * cellH) / gcd(6, cellH);

const out = process.stdout;
const size = () => {
  const width = out.columns * cellW;
  const rows = out.rows - BAR_ROWS - FOOT_ROWS;
  return { width, height: rows * cellH - ((rows * cellH) % 6) };
};

const state = {
  active: 'browser', hold: false, picking: false, editing: null, picked: null, agentNote: '', agentUntil: 0,
  logs: [], tabs: {}, urls: { browser: 'about:blank', preview: 'about:blank' }, frame: null, painting: false, lastFrameMs: 0,
};

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const chrome = await launchChrome({ profile });
const tab = () => state.tabs[state.active];

// ---- Screen ----

function fit(text, width) {
  const s = [...text];
  return s.length > width ? s.slice(0, width - 1).join('') + '…' : text.padEnd(width);
}

function drawBars() {
  const w = out.columns;
  const name = (id, label) => (state.active === id ? `\x1b[7m ${label} \x1b[27m` : ` ${label} `);
  const tabs = `${name('browser', 'Browser')}${name('preview', 'Preview')} `;
  const shown = state.editing !== null ? `Go to: ${state.editing}_` : state.urls[state.active];
  const room = Math.max(w - 20, 1);
  const agent = Date.now() < state.agentUntil ? `Claude: ${state.agentNote}` : '';
  const who = state.hold ? 'You have control, Claude is paused' : agent || 'Shared with Claude';
  const help = state.picking ? 'Click an element to send it to Claude' : 'F1 tabs  F2 hold  F3 point  Ctrl+L url  F12 chat';
  out.write(`\x1b[1;1H\x1b[0m${tabs}${fit(shown, room)}\x1b[${out.rows};1H\x1b[2m${fit(`${who}  |  ${help}`, w - 1)}\x1b[0m`);
}

async function paintLoop() {
  if (state.painting) return;
  state.painting = true;
  while (state.frame) {
    const frame = state.frame;
    state.frame = null;
    const { width, height } = size();
    const t0 = Date.now();
    const rgb = await decode(frame, width, height);
    const regions = changedRegions(state.shown, rgb, width, height);
    for (const [y0, y1] of regions) {
      await send(Buffer.concat([cursorAt(y0), encodeFast(rgb, width, y0, y1)]));
    }
    state.shown = rgb;
    state.shownSize = `${width}x${height}`;
    state.lastFrameMs = Date.now() - t0;
    if (regions.length) {
      drawBars();
      clearTimeout(state.fineTimer);
      state.fineTimer = setTimeout(paintFine, FINE_DELAY_MS);
    }
  }
  state.painting = false;
}

// Motion is painted coarsely, so once the page is still the whole frame is repainted sharp.
async function paintFine() {
  if (state.painting || state.frame || !state.shown) return;
  const { width, height } = size();
  if (state.shownSize !== `${width}x${height}`) return;
  const six = await encodeFine(state.shown, width, height);
  if (state.frame) return;
  await send(Buffer.concat([cursorAt(0), six]));
  drawBars();
}

const send = (bytes) => new Promise((r) => { if (out.write(bytes)) r(); else out.once('drain', r); });
const cursorAt = (y) => Buffer.from(`\x1b[${BAR_ROWS + 1 + y / cellH};1H`);

// Compares two frames in stripes that sit on both a cell row and a Sixel band, and merges neighbours.
function changedRegions(before, after, width, height) {
  if (!before || before.length !== after.length) return [[0, height]];
  const regions = [];
  for (let y = 0; y < height; y += STRIPE) {
    const end = Math.min(y + STRIPE, height);
    const a = y * width * 3;
    const b = end * width * 3;
    if (before.compare(after, a, b, a, b) === 0) continue;
    if (regions.length && regions.at(-1)[1] === y) regions.at(-1)[1] = end;
    else regions.push([y, end]);
  }
  return regions;
}

async function startCast() {
  const { width, height } = size();
  await tab().send('Page.startScreencast', { format: 'png', maxWidth: width, maxHeight: height, everyNthFrame: 1 });
}

async function switchTab(id) {
  if (id === state.active) return;
  await tab().send('Page.stopScreencast');
  state.active = id;
  state.shown = null;
  await tab().send('Page.bringToFront'); // A background tab never acknowledges wheel events.
  await startCast();
  drawBars();
}

async function refreshFrame() {
  state.shown = null;
  const shot = await tab().send('Page.captureScreenshot', { format: 'png' });
  state.frame = Buffer.from(shot.data, 'base64');
  paintLoop();
}

chrome.onEvent((method, p, sessionId) => {
  const id = Object.keys(state.tabs).find((k) => state.tabs[k].sessionId === sessionId);
  if (!id) return;
  const log = (level, text) => {
    state.logs.push({ tab: id, level, text: String(text).slice(0, 2000), at: new Date().toISOString() });
    if (state.logs.length > LOG_LIMIT) state.logs.shift();
  };
  if (method === 'Page.screencastFrame') {
    state.tabs[id].send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
    if (id === state.active) {
      state.frame = Buffer.from(p.data, 'base64');
      paintLoop();
    }
  } else if (method === 'Page.frameNavigated' && !p.frame.parentId && !p.frame.url.startsWith('chrome-error:')) {
    state.urls[id] = p.frame.url;
    drawBars();
  } else if (method === 'Page.javascriptDialogOpening') {
    log('dialog', `${p.type}: ${p.message}`);
    state.tabs[id].send('Page.handleJavaScriptDialog', { accept: p.type !== 'beforeunload' ? false : true }).catch(() => {});
  } else if (method === 'Runtime.consoleAPICalled') {
    log(p.type, p.args.map((a) => a.value ?? a.description ?? '').join(' '));
  } else if (method === 'Runtime.exceptionThrown') {
    log('exception', p.exceptionDetails.exception?.description ?? p.exceptionDetails.text);
  } else if (method === 'Log.entryAdded') {
    log(p.entry.level, `${p.entry.text} ${p.entry.url ?? ''}`);
  } else if (method === 'Network.responseReceived' && p.response.status >= 400) {
    log('network', `${p.response.status} ${p.response.url}`);
  } else if (method === 'Network.loadingFailed' && !p.canceled) {
    log('network', `${p.errorText} ${p.type}`);
  }
});

// ---- Page actions, shared by the person and the agent ----

const normalizeUrl = (u) => (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u
  : /^(localhost|127\.0\.0\.1)(:|\/|$)/.test(u) ? `http://${u}`
    : /\s/.test(u) || !u.includes('.') ? `https://www.google.com/search?q=${encodeURIComponent(u)}` : `https://${u}`);

async function navigate(id, url) {
  const t = state.tabs[id];
  const loaded = new Promise((res) => {
    const timer = setTimeout(res, 15000);
    const fn = (m, _p, s) => { if (m === 'Page.loadEventFired' && s === t.sessionId) { clearTimeout(timer); chromeOff(fn); res(); } };
    waiters.add(fn);
  });
  const r = await Promise.race([
    t.send('Page.navigate', { url }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${url}: no answer from Chrome`)), 20000)),
  ]);
  if (r.errorText) { throw new Error(`${url}: ${r.errorText}`); }
  await loaded;
}
const waiters = new Set();
const chromeOff = (fn) => waiters.delete(fn);
chrome.onEvent((m, p, s) => { for (const fn of waiters) fn(m, p, s); });

// Chrome can leave an input event unanswered, and one stuck event must not block the whole input queue.
const mouse = (type, x, y, extra = {}) => Promise.race([
  tab().send('Input.dispatchMouseEvent', { type, x, y, ...extra }),
  new Promise((r) => setTimeout(r, 1000)),
]);

async function click(x, y, button = 'left', clickCount = 1) {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, { button, clickCount, buttons: 1 });
  await mouse('mouseReleased', x, y, { button, clickCount });
}

const KEYS = {
  Enter: [13, '\r'], Tab: [9], Backspace: [8], Delete: [46], Escape: [27], ArrowUp: [38], ArrowDown: [40],
  ArrowLeft: [37], ArrowRight: [39], Home: [36], End: [35], PageUp: [33], PageDown: [34],
};

async function pressKey(key, modifiers = 0) {
  const known = KEYS[key];
  const upper = key.length === 1 ? key.toUpperCase() : key;
  const code = known ? known[0] : upper.charCodeAt(0);
  const text = known?.[1] ?? (key.length === 1 && !(modifiers & 3) ? key : undefined);
  const base = { key, modifiers, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await tab().send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
  await tab().send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

const evaluate = async (expression) => {
  const r = await tab().send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

const SNAPSHOT_JS = `(() => {
  const seen = [...document.querySelectorAll('a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[onclick],[contenteditable=true]')];
  const items = [];
  for (const el of seen) {
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2 || b.bottom < 0 || b.top > innerHeight) continue;
    items.push({ ref: items.length + 1, tag: el.tagName.toLowerCase(), label: (el.innerText || el.value || el.placeholder || el.ariaLabel || el.title || '').trim().slice(0, 100),
      x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) });
  }
  return { title: document.title, url: location.href, text: document.body ? document.body.innerText.slice(0, 20000) : '', elements: items };
})()`;

const pickAt = (x, y) => `(() => {
  const el = document.elementFromPoint(${x}, ${y});
  if (!el) return null;
  const path = [];
  for (let n = el; n && n.nodeType === 1 && path.length < 6; n = n.parentElement) {
    path.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''));
  }
  const b = el.getBoundingClientRect();
  return { selector: path.join(' > '), text: (el.innerText || '').slice(0, 500), html: el.outerHTML.slice(0, 1500),
    box: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }, url: location.href };
})()`;

// ---- Person's input ----

async function handleMouse(btn, cx, cy, release) {
  const wheel = btn & 64;
  const motion = btn & 32;
  const button = ['left', 'middle', 'right'][btn & 3];
  if (cy <= BAR_ROWS) {
    if (!release && !motion && !wheel) {
      if (cx <= 10) await switchTab('browser');
      else if (cx <= 20) await switchTab('preview');
      else { state.editing = ''; drawBars(); }
    }
    return;
  }
  if (cy >= out.rows) return;
  const x = Math.round((cx - 0.5) * cellW);
  const y = Math.round((cy - BAR_ROWS - 0.5) * cellH);
  if (wheel) {
    await mouse('mouseWheel', x, y, { deltaX: 0, deltaY: btn & 1 ? 120 : -120 });
  } else if (motion) {
    await mouse('mouseMoved', x, y, (btn & 3) === 3 ? {} : { button, buttons: 1 });
  } else if (release) {
    await mouse('mouseReleased', x, y, { button, clickCount: 1 });
  } else if (state.picking && button === 'left') {
    state.picking = false;
    state.picked = await evaluate(pickAt(x, y));
    const shot = await tab().send('Page.captureScreenshot', { format: 'png' });
    state.picked.screenshot = join(stateDir, 'picked.png');
    writeFileSync(state.picked.screenshot, Buffer.from(shot.data, 'base64'));
    drawBars();
  } else {
    await mouse('mousePressed', x, y, { button, clickCount: 1, buttons: 1 });
  }
}

const ESC_KEYS = {
  '\x1b[A': 'ArrowUp', '\x1b[B': 'ArrowDown', '\x1b[C': 'ArrowRight', '\x1b[D': 'ArrowLeft', '\x1b[H': 'Home', '\x1b[F': 'End',
  '\x1b[1~': 'Home', '\x1b[4~': 'End', '\x1b[3~': 'Delete', '\x1b[5~': 'PageUp', '\x1b[6~': 'PageDown', '\x1b[Z': 'Tab',
};

async function handleEdit(ch) {
  if (ch === '\r') {
    const url = normalizeUrl(state.editing);
    const id = state.active;
    state.editing = null;
    state.urls[id] = url;
    // Not awaited: a slow page must never stop the person's typing and clicking.
    navigate(id, url).catch((e) => {
      state.logs.push({ tab: id, level: 'error', text: e.message });
      state.urls[id] = `Could not load ${url}`;
      drawBars();
    });
  } else if (ch === '\x7f') state.editing = state.editing.slice(0, -1);
  else if (ch === '\x1b') state.editing = null;
  else if (ch >= ' ') state.editing += ch;
  drawBars();
}

async function handleInput(data) {
  let s = data;
  while (s.length) {
    let m;
    if ((m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s))) {
      await handleMouse(+m[1], +m[2], +m[3], m[4] === 'm');
    } else if ((m = /^\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(s))) {
      if (state.editing !== null) { state.editing += m[1]; drawBars(); } else await tab().send('Input.insertText', { text: m[1] });
    } else if ((m = /^\x1bOP|^\x1b\[11~/.exec(s))) {
      await switchTab(state.active === 'browser' ? 'preview' : 'browser');
    } else if ((m = /^\x1bOQ|^\x1b\[12~/.exec(s))) {
      state.hold = !state.hold; drawBars();
    } else if ((m = /^\x1bOR|^\x1b\[13~/.exec(s))) {
      state.picking = !state.picking; drawBars();
    } else if ((m = /^\x1b\[1;3D/.exec(s))) {
      await tab().send('Runtime.evaluate', { expression: 'history.back()' });
    } else if ((m = /^\x1b\[1;3C/.exec(s))) {
      await tab().send('Runtime.evaluate', { expression: 'history.forward()' });
    } else if ((m = /^\x1b\[[0-9;]*[A-Z~]/.exec(s))) {
      if (ESC_KEYS[m[0]] && state.editing === null) await pressKey(ESC_KEYS[m[0]]);
    } else if (s[0] === '\x0c') {
      m = [s[0]]; state.editing = ''; drawBars();
    } else if (s[0] === '\x12') {
      m = [s[0]]; await tab().send('Page.reload');
    } else if (state.editing !== null) {
      m = [[...s][0]]; await handleEdit(m[0]);
    } else if (s[0] === '\r') {
      m = [s[0]]; await pressKey('Enter');
    } else if (s[0] === '\x7f') {
      m = [s[0]]; await pressKey('Backspace');
    } else if (s[0] === '\t') {
      m = [s[0]]; await pressKey('Tab');
    } else if (s[0] === '\x1b') {
      m = [s[0]]; await pressKey('Escape');
    } else if (s[0] < ' ') {
      m = [s[0]]; await pressKey(String.fromCharCode(s.charCodeAt(0) + 96), 2);
    } else {
      m = [[...s][0]]; await pressKey(m[0]);
    }
    s = s.slice(m[0].length);
  }
}

// ---- Agent's interface ----

function agentActs(note) {
  if (state.hold) throw new Error('The person has control right now. Wait, or ask them to press F2 to hand it back.');
  state.agentNote = note;
  state.agentUntil = Date.now() + 2500;
  drawBars();
}

const settle = () => new Promise((r) => setTimeout(r, 150));

const methods = {
  status: async () => ({ active: state.active, hold: state.hold, urls: state.urls, viewport: size(), lastPaintMs: state.lastFrameMs }),
  open: async ({ url }) => {
    agentActs(`opening ${url}`);
    const target = normalizeUrl(url);
    await switchTab('browser');
    await navigate('browser', target);
    return { url: state.urls.browser };
  },
  preview: async ({ path }) => {
    const url = buildPreview(path, stateDir);
    await navigate('preview', url);
    await switchTab('preview');
    return { url };
  },
  tab: async ({ name }) => { await switchTab(name); return { active: state.active }; },
  snapshot: async () => evaluate(SNAPSHOT_JS),
  click: async ({ x, y, ref, button }) => {
    let at = { x, y };
    if (ref !== undefined) {
      const snap = await evaluate(SNAPSHOT_JS);
      at = snap.elements.find((e) => e.ref === ref);
      if (!at) throw new Error(`No element with ref ${ref}. Take a new snapshot.`);
    }
    agentActs(`click ${at.x},${at.y}`);
    await click(at.x, at.y, button);
    await settle();
    return { clicked: at };
  },
  type: async ({ text }) => { agentActs('typing'); await tab().send('Input.insertText', { text }); return { typed: text.length }; },
  key: async ({ key, ctrl }) => { agentActs(`key ${key}`); await pressKey(key, ctrl ? 2 : 0); await settle(); return { key }; },
  scroll: async ({ dy, x, y }) => {
    agentActs('scrolling');
    const v = size();
    await mouse('mouseWheel', x ?? v.width / 2, y ?? v.height / 2, { deltaX: 0, deltaY: dy });
    await settle();
    return { dy };
  },
  shot: async ({ path }) => {
    const shot = await tab().send('Page.captureScreenshot', { format: 'png' });
    const target = path ?? join(stateDir, 'shot.png');
    writeFileSync(target, Buffer.from(shot.data, 'base64'));
    return { path: target };
  },
  logs: async ({ limit = 50 }) => state.logs.slice(-limit),
  picked: async () => state.picked,
  repaint: async () => { await refreshFrame(); return {}; },
  quit: async () => { setTimeout(shutdown, 50); return {}; },
};

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
    const reply = await (methods[method] ? methods[method](params ?? {}) : Promise.reject(new Error(`Unknown method ${method}`)))
      .then((result) => ({ result: result ?? null }), (e) => ({ error: e.message }));
    c.end(JSON.stringify(reply) + '\n');
  });
});
server.listen(sock, () => chmodSync(sock, 0o600));

function shutdown() {
  out.write('\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h');
  server.close();
  rmSync(sock, { force: true });
  chrome.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
chrome.exited.then(shutdown);

// ---- Start ----

state.tabs.browser = await openTab(chrome, size());
state.tabs.preview = await openTab(chrome, size());
await tab().send('Page.bringToFront');

out.write('\x1b[2J\x1b[?25l\x1b[?1003h\x1b[?1006h\x1b[?2004h');
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
let inputQueue = Promise.resolve();
process.stdin.on('data', (d) => { inputQueue = inputQueue.then(() => handleInput(d)).catch((e) => state.logs.push({ tab: state.active, level: 'pane', text: e.message })); });
out.on('resize', async () => {
  out.write('\x1b[2J');
  for (const t of Object.values(state.tabs)) await resizeTab(t, size());
  await tab().send('Page.stopScreencast');
  await startCast();
  await refreshFrame();
});

await startCast();
await navigate('browser', process.env.COWORK_HOME_URL ?? 'data:text/html,<body style="font:18px system-ui;padding:32px"><h2>Cowork</h2><p>Ctrl+L to go to a page. Claude sees this browser too.</p>');
await refreshFrame();
drawBars();
