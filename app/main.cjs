// The window: chrome, real browser tabs, and the bridge to the backend inside WSL.
const { app, BrowserWindow, ClipboardItem, WebContentsView, clipboard, dialog, ipcMain, nativeImage, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');

const TEST = process.env.COWORK_TEST === '1';
const START_URL = pathToFileURL(path.join(__dirname, 'renderer/start.html')).href;
const LOG_LIMIT = 300;
if (TEST) app.commandLine.appendSwitch('no-sandbox');
if (TEST && process.env.COWORK_HOST_RULES) app.commandLine.appendSwitch('host-resolver-rules', process.env.COWORK_HOST_RULES);
const PLAIN = process.env.COWORK_PLAIN === '1'; // Terminal only, used to film the launch command.

let win;
let backend;
let bounds = { x: 0, y: 0, width: 800, height: 600 };
const tabs = [];
let active = null;
let nextTab = 1;
let activeTerm = 1;
let boardOpen = false;
let sheetOpen = false; // The Appearance sheet is HTML, so the native page view steps aside while it shows.
const state = { hold: false, picking: false, note: '', noteUntil: 0, picked: null, logs: [] };
const current = () => tabs.find((t) => t.id === active);

// ---- Backend ----

function startBackend() {
  const startFolder = process.argv.find((a) => a.startsWith('--cwd='))?.slice(6); // From the terminal-cowork command.
  const configFile = path.join(__dirname, 'config.json');
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : null;
  // WSL only, by design: the backend, Claude Code and the agents all live in WSL. The build writes config.json;
  // without it there is no WSL side to start, so say so instead of failing on a missing field.
  if (process.platform === 'win32' && !config) {
    dialog.showErrorBox('terminal-cowork needs WSL', 'This copy has no WSL setup (app\\config.json is missing).\n\nBuild it inside WSL with "node scripts/package-windows.mjs" and use the folder it writes to dist.');
    app.exit(1);
    return;
  }
  backend = process.platform === 'win32'
    ? spawn('wsl.exe', ['-d', config.distro, '--cd', '~', '--', 'env', 'COWORK_WINDOWS=1', ...(startFolder ? [`COWORK_CWD=${startFolder}`] : []), `PATH=${config.path}`, `COWORK_SOCK=${config.sock}`, `XDG_RUNTIME_DIR=${config.runtime}`, config.node, config.backend], { stdio: 'pipe', windowsHide: true })
    : spawn(process.env.COWORK_NODE ?? 'node', [path.join(__dirname, '../backend/server.js')], { stdio: 'pipe' });
  const logFile = path.join(app.getPath('userData'), 'backend.log');
  const note = (text) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`); } catch { /* Logging must never stop the app. */ } };
  backend.stderr.on('data', (d) => note(d.toString()));
  backend.on('error', (e) => { note(`start failed: ${e.message}`); ui('notice', `Could not reach WSL: ${e.message}`); });
  readline.createInterface({ input: backend.stdout }).on('line', (line) => {
    try { onBackend(line); } catch (e) { note(`bad line: ${line.slice(0, 300)} ${e.message}`); }
  });
  backend.on('exit', (code) => { note(`backend exited ${code}`); if (!app.isQuitting) ui('notice', 'The WSL side stopped. Reopen terminal-cowork to continue.'); });
}

const toBackend = (msg) => backend?.stdin.write(JSON.stringify(msg) + '\n');
const ui = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };

function onBackend(line) {
  const m = JSON.parse(line);
  if (m.t === 'pty' || m.t === 'termAdded' || m.t === 'termClosed' || m.t === 'termRenamed' || m.t === 'agents') ui(m.t, m);
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
    t.view.setVisible(t.id === active && !boardOpen && !sheetOpen);
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
  const finish = (value) => { delete window.__coworkCancelPick; removeEventListener('mousemove', move, true); removeEventListener('click', pick, true); removeEventListener('keydown', esc, true); box.remove(); done(value); };
  const esc = (e) => { if (e.key === 'Escape') finish(null); };
  const pick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const parts = [];
    for (let n = e.target; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''));
    const b = e.target.getBoundingClientRect();
    finish({ selector: parts.join(' > '), text: (e.target.innerText || '').slice(0, 500), html: e.target.outerHTML.slice(0, 1500), box: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }, url: location.href });
  };
  window.__coworkCancelPick = () => finish(null);
  addEventListener('mousemove', move, true); addEventListener('click', pick, true); addEventListener('keydown', esc, true);
})`;

let pickRun = 0, pickPage = null;
async function startPick() {
  // A second press lets go: it ends the pick in the page and frees the button even if that page is gone.
  if (state.picking) {
    pickRun++; state.picking = false; pushState();
    if (pickPage && !pickPage.isDestroyed()) pickPage.executeJavaScript('window.__coworkCancelPick?.()', true).catch(() => {});
    return;
  }
  const run = ++pickRun;
  state.picking = true;
  pushState();
  const wc = pickPage = current().view.webContents;
  const picked = await wc.executeJavaScript(PICK_JS, true).catch(() => null);
  if (run !== pickRun) return;
  state.picking = false;
  if (picked) {
    // The element matters more than the picture, so a failed capture must not lose it.
    const image = await wc.capturePage().catch(() => null);
    state.picked = { ...picked, png: image?.toPNG().toString('base64') };
    toBackend({ t: 'input', id: activeTerm, d: `(the element I pointed at: ${picked.selector}) ` });
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
  testMove: ({ x, y }) => { page().sendInputEvent({ type: 'mouseMove', x, y }); return {}; },
  testClick: async ({ x, y }) => { await clickAt(x, y); return {}; },
  testInsert: async ({ text }) => { await page().insertText(text); return {}; },
  testUi: ({ js }) => win.webContents.executeJavaScript(js, true),
  testClipboard: async ({ text, png }) => {
    clipboard.clear();
    if (png) await clipboard.write([new ClipboardItem({ 'image/png': new Blob([Buffer.from(png, 'base64')], { type: 'image/png' }) })]);
    else await clipboard.writeText(text ?? '');
    return {};
  },
  testClipboardRead: async () => ({ text: await clipboard.readText(), png: await clipboard.has('image/png'), types: (await clipboard.read()).flatMap((i) => i.types) }),
  testKey: ({ key, mods = [] }) => { win.focus(); win.webContents.focus(); for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: key, modifiers: mods }); return {}; },
  testCapture: async ({ file }) => { writeFileSync(file, (await win.webContents.capturePage()).toPNG()); return { file }; },
  pageEval: ({ js }) => evaluate(js),
  quit: () => { setTimeout(() => app.quit(), 50); return {}; },
};

// ---- Window ----

function createWindow() {
  win = new BrowserWindow({
    width: +(process.env.COWORK_WIDTH ?? 1500), height: +(process.env.COWORK_HEIGHT ?? 940), minWidth: 900, minHeight: 560, show: false, frame: false,
    backgroundColor: '#fcfbfa',
    title: 'terminal-cowork', icon: path.join(__dirname, 'icon.png'),
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

ipcMain.on('ready', () => {
  sendAppearance();
  if (!tabs.length && !PLAIN) switchTo(newTab().id);
  toBackend({ t: 'start' });
});
ipcMain.on('input', (_e, m) => toBackend(typeof m === 'string' ? { t: 'input', id: activeTerm, d: m } : { t: 'input', ...m }));
ipcMain.on('resize', (_e, s) => toBackend({ t: 'resize', ...s }));
ipcMain.on('termNew', (_e, kind) => toBackend({ t: 'new', kind }));
ipcMain.on('termClose', (_e, id) => toBackend({ t: 'close', id }));
ipcMain.on('termRename', (_e, m) => toBackend({ t: 'rename', id: m.id, name: m.name }));
ipcMain.on('termFocus', (_e, id) => { activeTerm = id; });
ipcMain.on('board', (_e, on) => { boardOpen = on; layout(); });
ipcMain.on('sheet', (_e, on) => { sheetOpen = on; layout(); });

// ---- Appearance: Light, or Glass over a wallpaper. Kept per user, outside the app folder. ----

const appearanceFile = () => path.join(app.getPath('userData'), 'appearance.json');
const customFile = () => path.join(app.getPath('userData'), 'wallpaper-custom.jpg');
function readAppearance() {
  let a = {};
  try { a = JSON.parse(readFileSync(appearanceFile(), 'utf8')); } catch { /* First run: defaults. */ }
  return { mode: a.mode === 'glass' ? 'glass' : 'light', wallpaper: a.wallpaper ?? 'tahoe', tint: Number.isFinite(a.tint) ? a.tint : 0.5 };
}
function sendAppearance() {
  const a = readAppearance();
  const custom = existsSync(customFile()) ? `data:image/jpeg;base64,${readFileSync(customFile()).toString('base64')}` : null;
  const list = JSON.parse(readFileSync(path.join(__dirname, 'renderer/wallpapers/wallpapers.json'), 'utf8'));
  ui('appearance', { ...a, custom, list });
}
ipcMain.on('appearance', (_e, change) => {
  writeFileSync(appearanceFile(), JSON.stringify({ ...readAppearance(), ...change }));
  sendAppearance();
});
ipcMain.on('pickWallpaper', async () => {
  const r = TEST && process.env.COWORK_PICK_FILE ? { filePaths: [process.env.COWORK_PICK_FILE] }   // Tests cannot click a system dialog.
    : await dialog.showOpenDialog(win, { title: 'Choose a picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }] });
  if (r.canceled || !r.filePaths[0]) return;
  let image = nativeImage.createFromPath(r.filePaths[0]);
  if (image.isEmpty()) return ui('notice', 'That file is not a picture this app can read.');
  if (image.getSize().width > 2560) image = image.resize({ width: 2560, quality: 'best' });
  writeFileSync(customFile(), image.toJPEG(85));
  writeFileSync(appearanceFile(), JSON.stringify({ ...readAppearance(), mode: 'glass', wallpaper: 'custom' }));
  sendAppearance();
});
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
// The clipboard API is asynchronous since Electron 45, and readImage is gone: has('image/png') tells an image apart.
ipcMain.on('copy', (_e, text) => { clipboard.writeText(text).catch(() => {}); });
ipcMain.on('paste', async (_e, id) => {
  const text = await clipboard.readText().catch(() => '');
  if (text) return ui('pasted', { id, text });
  if (await clipboard.has('image/png').catch(() => false)) ui('pasted', { id, raw: '\x16' });
});
ipcMain.on('openExternal', (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });

// Film recorder: writes the window's own pixels to disk, so nothing outside the app can ever be captured.
function startRecorder(dir) {
  const fs = require('node:fs');
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  let n = 0;
  const index = fs.createWriteStream(path.join(dir, 'index.jsonl'));
  const tick = async () => {
    const at = Date.now() - t0;
    if (!win || win.isDestroyed() || at > +(process.env.COWORK_RECORD_MS ?? Infinity)) return;
    const tab = current();
    const [ui, page] = await Promise.all([win.webContents.capturePage(), tab ? tab.view.webContents.capturePage().catch(() => null) : null]);
    const id = String(n++).padStart(6, '0');
    fs.writeFile(path.join(dir, `${id}-ui.jpg`), ui.toJPEG(94), () => {});
    if (page && !page.isEmpty()) fs.writeFile(path.join(dir, `${id}-page.jpg`), page.toJPEG(94), () => {});
    index.write(`${JSON.stringify({ id, at, bounds })}\n`);
    setTimeout(tick, Math.max(0, 33 - (Date.now() - t0 - at)));
  };
  tick();
}

app.whenReady().then(() => {
  // Web pages get nothing sensitive by default: no camera, microphone, location or notifications.
  session.fromPartition('persist:cowork').setPermissionRequestHandler((_wc, permission, done) => done(['clipboard-sanitized-write', 'fullscreen'].includes(permission)));
  session.fromPartition('persist:cowork').webRequest.onCompleted((d) => {
    if (d.statusCode >= 400) { const t = tabs.find((x) => x.view.webContents.id === d.webContentsId); if (t) log(t, 'network', `${d.statusCode} ${d.url}`); }
  });
  startBackend();
  createWindow();
  if (process.env.COWORK_RECORD) win.webContents.once('did-finish-load', () => startRecorder(process.env.COWORK_RECORD));
});
app.on('before-quit', () => { app.isQuitting = true; backend?.stdin.end(); });
app.on('window-all-closed', () => app.quit());
