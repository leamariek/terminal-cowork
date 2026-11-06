// The window: chrome, real browser tabs, and the bridge to the backend inside WSL.
const { app, BrowserWindow, WebContentsView, clipboard, ipcMain, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');

const TEST = process.env.COWORK_TEST === '1';
const START_URL = pathToFileURL(path.join(__dirname, 'renderer/start.html')).href;
const LOG_LIMIT = 300;
if (TEST) app.commandLine.appendSwitch('no-sandbox');

let win;
let backend;
let bounds = { x: 0, y: 0, width: 800, height: 600 };
const tabs = [];
let active = null;
let nextTab = 1;
const state = { hold: false, picking: false, note: '', noteUntil: 0, picked: null, logs: [] };
const current = () => tabs.find((t) => t.id === active);

// ---- Backend ----

function startBackend() {
  const configFile = path.join(__dirname, 'config.json');
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : null;
  backend = process.platform === 'win32'
    ? spawn('wsl.exe', ['-d', config.distro, '--cd', '~', '--', 'env', 'COWORK_WINDOWS=1', `PATH=${config.path}`, `COWORK_SOCK=${config.sock}`, `XDG_RUNTIME_DIR=${config.runtime}`, config.node, config.backend], { stdio: 'pipe', windowsHide: true })
    : spawn(process.env.COWORK_NODE ?? 'node', [path.join(__dirname, '../backend/server.js')], { stdio: 'pipe' });
  const logFile = path.join(app.getPath('userData'), 'backend.log');
  const note = (text) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`); } catch { /* Logging must never stop the app. */ } };
  backend.stderr.on('data', (d) => note(d.toString()));
  backend.on('error', (e) => { note(`start failed: ${e.message}`); ui('notice', `Could not reach WSL: ${e.message}`); });
  readline.createInterface({ input: backend.stdout }).on('line', (line) => {
    try { onBackend(line); } catch (e) { note(`bad line: ${line.slice(0, 300)} ${e.message}`); }
  });
  backend.on('exit', (code) => { note(`backend exited ${code}`); if (!app.isQuitting) ui('notice', 'The WSL side stopped. Reopen Cowork to continue.'); });
}

const toBackend = (msg) => backend?.stdin.write(JSON.stringify(msg) + '\n');
const ui = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };

function onBackend(line) {
  const m = JSON.parse(line);
  if (m.t === 'pty') ui('pty', m.d);
  else if (m.t === 'ptyExit') ui('notice', 'The terminal session ended.');
  else if (m.t === 'rpc') {
    const fn = agent[m.method];
    Promise.resolve()
      .then(() => { if (!fn) throw new Error(`Unknown method ${m.method}`); return fn(m.params ?? {}); })
      .then((result) => toBackend({ t: 'rpcReply', id: m.id, result }), (e) => toBackend({ t: 'rpcReply', id: m.id, error: e.message }));
  }
}

// ---- Tabs ----

function pushState() {
  ui('state', {
    tabs: tabs.map(({ id, kind, title, url, loading }) => ({ id, kind, title, url, loading })),
    active,
    canBack: current()?.view.webContents.navigationHistory.canGoBack() ?? false,
    canForward: current()?.view.webContents.navigationHistory.canGoForward() ?? false,
    hold: state.hold,
    picking: state.picking,
    note: Date.now() < state.noteUntil ? state.note : '',
  });
}

function log(tab, level, text) {
  state.logs.push({ tab: tab.title, level, text: String(text).slice(0, 2000), at: new Date().toISOString() });
  if (state.logs.length > LOG_LIMIT) state.logs.shift();
}

function layout() {
  for (const t of tabs) {
    t.view.setVisible(t.id === active);
    if (t.id === active) t.view.setBounds(bounds);
  }
}

function newTab(url, kind = 'web') {
  const view = new WebContentsView({ webPreferences: { partition: 'persist:cowork', sandbox: !TEST, contextIsolation: true, nodeIntegration: false } });
  view.setBackgroundColor('#fcfbfa');
  const tab = { id: nextTab++, kind, title: 'New Tab', url: '', loading: false, view };
  const wc = view.webContents;
  wc.setUserAgent(wc.getUserAgent().replace(/\s(Electron|cowork)\/\S+/gi, ''));
  wc.setWindowOpenHandler(({ url: target }) => { switchTo(newTab(target).id); return { action: 'deny' }; });
  wc.on('dom-ready', () => wc.insertCSS('html { scrollbar-width: none } ::-webkit-scrollbar { display: none }').catch(() => {}));
  wc.on('page-title-updated', (_e, title) => { tab.title = title; pushState(); });
  const went = (_e, u) => { tab.url = u === START_URL ? '' : u; pushState(); };
  wc.on('did-navigate', went);
  wc.on('did-navigate-in-page', went);
  wc.on('did-start-loading', () => { tab.loading = true; pushState(); });
  wc.on('did-stop-loading', () => { tab.loading = false; pushState(); });
  wc.on('did-fail-load', (_e, code, desc, u, isMain) => {
    if (!isMain || code === -3) return; // -3 means the load was replaced by a newer one.
    log(tab, 'error', `${desc} ${u}`);
    tab.title = 'Could not load page';
    ui('notice', `Could not load ${u}`);
    pushState();
  });
  wc.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') log(tab, e.level, e.message); });
  wc.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && shortcut(input)) e.preventDefault(); });
  win.contentView.addChildView(view);
  tabs.push(tab);
  wc.loadURL(url ?? START_URL).catch(() => {});
  return tab;
}

function switchTo(id) {
  if (!tabs.some((t) => t.id === id)) return;
  active = id;
  layout();
  pushState();
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [tab] = tabs.splice(i, 1);
  win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  if (!tabs.length) switchTo(newTab().id);
  else if (active === id) switchTo(tabs[Math.max(0, i - 1)].id);
  else pushState();
}

function shortcut(input) {
  if (!input.control) return false;
  const key = input.key.toLowerCase();
  if (key === 'l') ui('focusAddress');
  else if (key === 't') switchTo(newTab().id);
  else if (key === 'w') closeTab(active);
  else if (key === 'r') current()?.view.webContents.reload();
  else if (key === 'tab') { const i = tabs.findIndex((t) => t.id === active); switchTo(tabs[(i + (input.shift ? tabs.length - 1 : 1)) % tabs.length].id); } else return false;
  return true;
}

const normalizeUrl = (u) => (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u
  : /^(localhost|127\.0\.0\.1)(:|\/|$)/.test(u) ? `http://${u}`
    : /\s/.test(u) || !u.includes('.') ? `https://www.google.com/search?q=${encodeURIComponent(u)}` : `https://${u}`);

// ---- Point at an element ----

const PICK_JS = `new Promise((done) => {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #0a84ff;border-radius:4px;background:rgba(10,132,255,.14)';
  document.documentElement.append(box);
  const move = (e) => { const b = e.target.getBoundingClientRect(); Object.assign(box.style, { left: b.x + 'px', top: b.y + 'px', width: b.width + 'px', height: b.height + 'px' }); };
  const finish = (value) => { removeEventListener('mousemove', move, true); removeEventListener('click', pick, true); removeEventListener('keydown', esc, true); box.remove(); done(value); };
  const esc = (e) => { if (e.key === 'Escape') finish(null); };
  const pick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const parts = [];
    for (let n = e.target; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''));
    const b = e.target.getBoundingClientRect();
    finish({ selector: parts.join(' > '), text: (e.target.innerText || '').slice(0, 500), html: e.target.outerHTML.slice(0, 1500), box: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }, url: location.href });
  };
  addEventListener('mousemove', move, true); addEventListener('click', pick, true); addEventListener('keydown', esc, true);
})`;

async function startPick() {
  if (state.picking) return;
  state.picking = true;
  pushState();
  const wc = current().view.webContents;
  const picked = await wc.executeJavaScript(PICK_JS, true).catch(() => null);
  state.picking = false;
  if (picked) {
    // The element matters more than the picture, so a failed capture must not lose it.
    const image = await wc.capturePage().catch(() => null);
    state.picked = { ...picked, png: image?.toPNG().toString('base64') };
    toBackend({ t: 'input', d: `(the element I pointed at: ${picked.selector}) ` });
    ui('focusTerminal');
  }
  pushState();
}

// ---- Agent ----

function agentActs(note) {
  if (state.hold) throw new Error('The person has control right now. Wait until they hand it back.');
  state.note = note;
  state.noteUntil = Date.now() + 2500;
  pushState();
  setTimeout(pushState, 2600);
}

const settle = () => new Promise((r) => setTimeout(r, 150));
const page = () => current().view.webContents;
const evaluate = (js) => page().executeJavaScript(js, true);

const SNAPSHOT_JS = `(() => {
  const found = [...document.querySelectorAll('a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[onclick],[contenteditable=true]')];
  const elements = [];
  for (const el of found) {
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2 || b.bottom < 0 || b.top > innerHeight) continue;
    elements.push({ ref: elements.length + 1, tag: el.tagName.toLowerCase(), label: (el.innerText || el.value || el.placeholder || el.ariaLabel || el.title || '').trim().slice(0, 100), x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) });
  }
  return { title: document.title, url: location.href, text: document.body ? document.body.innerText.slice(0, 20000) : '', elements };
})()`;

async function clickAt(x, y, button = 'left') {
  const wc = page();
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
  await settle();
}

const KEY_NAMES = { Enter: 'Return', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };

const agent = {
  status: () => ({ active, tabs: tabs.map(({ id, kind, title, url }) => ({ id, kind, title, url })), hold: state.hold, viewport: { width: bounds.width, height: bounds.height } }),
  open: async ({ url }) => {
    agentActs(`Opening ${url}`);
    const target = normalizeUrl(url);
    let tab = current();
    if (tab.kind !== 'web') { tab = tabs.find((t) => t.kind === 'web') ?? newTab(); switchTo(tab.id); }
    await tab.view.webContents.loadURL(target);
    return { url: tab.url };
  },
  showPreview: async ({ url, title }) => {
    let tab = tabs.find((t) => t.kind === 'preview');
    if (!tab) tab = newTab('about:blank', 'preview');
    await tab.view.webContents.loadURL(url);
    tab.title = title;
    switchTo(tab.id);
    return { url };
  },
  tab: async ({ name }) => {
    const tab = tabs.find((t) => t.kind === (name === 'preview' ? 'preview' : 'web'));
    if (!tab) throw new Error(`No ${name} tab is open`);
    switchTo(tab.id);
    return { active };
  },
  snapshot: () => evaluate(SNAPSHOT_JS),
  click: async ({ x, y, ref, button }) => {
    let at = { x, y };
    if (ref !== undefined) {
      at = (await evaluate(SNAPSHOT_JS)).elements.find((e) => e.ref === ref);
      if (!at) throw new Error(`No element with ref ${ref}. Take a new snapshot.`);
    }
    agentActs('Clicking');
    await clickAt(at.x, at.y, button);
    return { clicked: at };
  },
  type: async ({ text }) => { agentActs('Typing'); await page().insertText(text); return { typed: text.length }; },
  key: async ({ key, ctrl }) => {
    agentActs(`Pressing ${key}`);
    const keyCode = KEY_NAMES[key] ?? key;
    const modifiers = ctrl ? ['control'] : [];
    page().sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (key.length === 1) page().sendInputEvent({ type: 'char', keyCode, modifiers });
    page().sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await settle();
    return { key };
  },
  scroll: async ({ dy, x, y }) => {
    agentActs('Scrolling');
    page().sendInputEvent({ type: 'mouseWheel', x: x ?? bounds.width / 2, y: y ?? bounds.height / 2, deltaX: 0, deltaY: -dy, canScroll: true });
    await settle();
    return { dy };
  },
  shot: async () => ({ png: (await page().capturePage()).toPNG().toString('base64') }),
  uiShot: async () => ({ png: (await win.webContents.capturePage()).toPNG().toString('base64') }),
  logs: ({ limit = 50 }) => state.logs.slice(-limit),
  picked: () => state.picked,
  testHold: ({ on }) => { state.hold = on; pushState(); return { hold: on }; },
  testPick: () => { startPick(); return {}; },
  testUi: ({ js }) => win.webContents.executeJavaScript(js, true),
  pageEval: ({ js }) => evaluate(js),
  quit: () => { setTimeout(() => app.quit(), 50); return {}; },
};

// ---- Window ----

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 940, minWidth: 900, minHeight: 560, show: false, frame: false,
    backgroundColor: '#fcfbfa',
    title: 'Cowork', icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: !TEST },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault()); // The window's own page never navigates.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) switchTo(newTab(url).id); return { action: 'deny' }; });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  win.once('ready-to-show', () => {
    if (TEST) { win.setPosition(-4000, -4000); win.showInactive(); } else win.show(); // Capture needs a rendered window.
  });
  for (const name of ['focus', 'blur']) win.on(name, () => ui('windowFocus', name === 'focus'));
  for (const name of ['maximize', 'unmaximize']) win.on(name, () => ui('maximized', name === 'maximize'));
  win.on('closed', () => { win = null; });
}

ipcMain.on('ready', (_e, size) => {
  if (!tabs.length) switchTo(newTab().id);
  toBackend({ t: 'start', cols: size.cols, rows: size.rows });
});
ipcMain.on('input', (_e, d) => toBackend({ t: 'input', d }));
ipcMain.on('resize', (_e, s) => toBackend({ t: 'resize', ...s }));
ipcMain.on('bounds', (_e, b) => { bounds = b; layout(); });
ipcMain.on('control', (_e, name) => {
  if (name === 'close') win.close();
  else if (name === 'minimize') win.minimize();
  else if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('navigate', (_e, text) => current()?.view.webContents.loadURL(normalizeUrl(text)).catch(() => {}));
ipcMain.on('back', () => current()?.view.webContents.navigationHistory.goBack());
ipcMain.on('forward', () => current()?.view.webContents.navigationHistory.goForward());
ipcMain.on('reload', () => current()?.view.webContents.reload());
ipcMain.on('newTab', () => switchTo(newTab().id));
ipcMain.on('closeTab', (_e, id) => closeTab(id));
ipcMain.on('switchTab', (_e, id) => switchTo(id));
ipcMain.on('hold', () => { state.hold = !state.hold; pushState(); });
ipcMain.on('point', () => startPick());
ipcMain.on('copy', (_e, text) => clipboard.writeText(text));
ipcMain.on('paste', () => ui('pasted', clipboard.readText()));
ipcMain.on('openExternal', (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });

app.whenReady().then(() => {
  // Web pages get nothing sensitive by default: no camera, microphone, location or notifications.
  session.fromPartition('persist:cowork').setPermissionRequestHandler((_wc, permission, done) => done(['clipboard-sanitized-write', 'fullscreen'].includes(permission)));
  session.fromPartition('persist:cowork').webRequest.onCompleted((d) => {
    if (d.statusCode >= 400) { const t = tabs.find((x) => x.view.webContents.id === d.webContentsId); if (t) log(t, 'network', `${d.statusCode} ${d.url}`); }
  });
  startBackend();
  createWindow();
});
app.on('before-quit', () => { app.isQuitting = true; backend?.stdin.end(); });
app.on('window-all-closed', () => app.quit());
