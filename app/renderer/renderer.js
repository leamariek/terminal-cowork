// The window's interface: terminal, toolbar and tab strip. All real work happens in main.cjs.
const { send, on } = window.cowork;
const $ = (id) => document.getElementById(id);

// ---- Terminals ----

const THEME = {
  background: '#fcfbfa', foreground: '#1d1d1f', cursor: '#1d1d1f', cursorAccent: '#fcfbfa', selectionBackground: '#b3d7ff',
  black: '#1d1d1f', red: '#c8102e', green: '#1a7f37', yellow: '#946c00', blue: '#0060d6', magenta: '#8a3ffc', cyan: '#00798c', white: '#6e6e73',
  brightBlack: '#8e8e93', brightRed: '#e0313e', brightGreen: '#2a9d4a', brightYellow: '#b58900', brightBlue: '#0a84ff', brightMagenta: '#a65ef0', brightCyan: '#0e93a8', brightWhite: '#aeaeb2',
};
const terminals = new Map();
let term = null; // The terminal in front.
let termId = null;
let agents = [];

function addTerminal({ id, kind, name }) {
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  $('terminal').append(pane);
  const xterm = new Terminal({
    fontFamily: "'Cell Blocks', 'JetBrains Mono', 'Cascadia Mono', Consolas, 'Segoe UI Symbol', monospace",
    fontSize: 13, lineHeight: 1, cursorBlink: true, cursorStyle: 'block', scrollback: 20000, allowProposedApi: true, allowTransparency: true, theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(pane);
  xterm.onData((d) => send('input', { id, d }));
  xterm.onResize((s) => send('resize', { id, ...s }));
  // Copy and paste work like Windows Terminal: Ctrl+C copies only when text is selected (otherwise it interrupts),
  // Ctrl+Shift+C always copies, Ctrl+V, Ctrl+Shift+V and Shift+Insert paste, right-click copies a selection or pastes.
  const copy = () => { if (xterm.hasSelection()) send('copy', xterm.getSelection()); xterm.clearSelection(); };
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    const take = (fn) => { e.preventDefault(); fn(); return false; };
    if (e.shiftKey && !e.ctrlKey && e.key === 'Insert') return take(() => send('paste', id));
    if (!e.ctrlKey || e.altKey) return true;
    if (k === 'c' && (e.shiftKey || xterm.hasSelection())) return take(copy);
    if (k === 'v') return take(() => send('paste', id));
    if (e.shiftKey && k === 't') return take(() => send('termNew', 'claude'));
    if (e.key === ',') return take(openAppearance);
    return true;
  });
  pane.addEventListener('contextmenu', (e) => { e.preventDefault(); if (xterm.hasSelection()) copy(); else send('paste', id); xterm.focus(); });
  terminals.set(id, { id, kind, name, xterm, fit, pane });
  showTerminal(id);
}

function showTerminal(id) {
  const t = terminals.get(id);
  if (!t) return;
  closeBoard();
  termId = id;
  term = t.xterm;
  send('termFocus', id);
  for (const x of terminals.values()) x.pane.classList.toggle('current', x.id === id);
  t.fit.fit();
  t.xterm.focus();
  renderTerminals();
}

function removeTerminal(id) {
  const t = terminals.get(id);
  if (!t) return;
  t.xterm.dispose();
  t.pane.remove();
  terminals.delete(id);
  if (termId === id) { const next = [...terminals.keys()].at(-1); if (next !== undefined) showTerminal(next); else { term = null; termId = null; } }
  renderTerminals();
}

const fitFront = () => { const t = terminals.get(termId); if (t) t.fit.fit(); };

Promise.all([document.fonts.load("13px 'JetBrains Mono'"), document.fonts.load("13px 'Cell Blocks'", '█')]).finally(() => {
  send('ready');
  reportBounds();
});

on('termAdded', addTerminal);
on('termClosed', ({ id }) => removeTerminal(id));
on('pty', ({ id, d }) => terminals.get(id)?.xterm.write(d));
on('pasted', ({ id, text, raw }) => {
  const t = terminals.get(id)?.xterm ?? term;
  if (raw) send('input', { id, d: raw }); else t?.paste(text);   // raw: an image, which Claude Code reads from the clipboard itself on Ctrl+V.
});
on('focusTerminal', () => term?.focus());

// ---- Layout ----

function reportBounds() {
  const r = $('stage').getBoundingClientRect();
  send('bounds', { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
}
new ResizeObserver(() => { reportBounds(); fitFront(); }).observe(document.body);
new ResizeObserver(reportBounds).observe($('stage'));
new ResizeObserver(fitFront).observe($('terminal'));

const divider = $('divider');
divider.addEventListener('pointerdown', (e) => {
  divider.setPointerCapture(e.pointerId);
  const left = $('split').getBoundingClientRect().x;
  const move = (m) => document.documentElement.style.setProperty('--split', `${Math.min(Math.max(m.clientX - left, 300), innerWidth - left - 321)}px`);
  const up = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', up); };
  divider.addEventListener('pointermove', move);
  divider.addEventListener('pointerup', up);
});

// ---- Window controls ----

document.querySelectorAll('[data-control]').forEach((b) => b.addEventListener('click', () => send('control', b.dataset.control)));
on('windowFocus', (focused) => document.body.classList.toggle('blurred', !focused));
document.documentElement.dataset.platform = window.cowork.platform;
if (window.cowork.plain) { document.body.classList.add('plain'); $('title').textContent = 'Terminal'; }

// ---- Toolbar ----

const address = $('address');
let view = { tabs: [], active: null };
const activeTab = () => view.tabs.find((t) => t.id === view.active);

const shortUrl = (url) => {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.protocol === 'file:' ? decodeURIComponent(u.pathname.split('/').pop()) : u.host.replace(/^www\./, '');
  } catch { return url; }
};

$('address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (address.value.trim()) send('navigate', address.value.trim());
  address.blur();
});
address.addEventListener('focus', () => { address.value = activeTab()?.url ?? ''; address.select(); });
address.addEventListener('blur', render);
address.addEventListener('keydown', (e) => { if (e.key === 'Escape') address.blur(); });
on('focusAddress', () => address.focus());

for (const id of ['back', 'forward', 'reload', 'hold', 'point']) $(id).addEventListener('click', () => send(id));
$('new-tab').addEventListener('click', () => send('newTab'));

const GLOBE = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 1.700 3 3.700 3 6s-1 4.300-3 6c-2-1.700-3-3.700-3-6s1-4.300 3-6z"/></svg>';
const PAGE = '<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4zM9 2v3h3"/></svg>';

function tabRow(t) {
  const el = document.createElement('div');
  el.className = `row tab${t.id === view.active ? ' current' : ''}`;
  el.innerHTML = t.kind === 'preview' ? PAGE : GLOBE;
  el.addEventListener('click', () => send('switchTab', t.id));
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = t.title || shortUrl(t.url) || 'New Tab';
  const close = document.createElement('button');
  close.setAttribute('aria-label', `Close ${name.textContent}`);
  close.innerHTML = '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
  close.addEventListener('click', (e) => { e.stopPropagation(); send('closeTab', t.id); });
  el.append(name, close);
  return el;
}

function render() {
  const t = activeTab();
  if (document.activeElement !== address) address.value = t?.kind === 'preview' ? t.title : shortUrl(t?.url);
  $('lock').toggleAttribute('hidden', !t?.url?.startsWith('https:'));
  $('progress').classList.toggle('loading', Boolean(t?.loading));
  $('back').disabled = !view.canBack;
  $('forward').disabled = !view.canForward;
  $('hold').classList.toggle('on', Boolean(view.hold));
  $('hold').querySelector('span').textContent = view.hold ? 'Hand back to Claude' : 'Take control';
  $('point').classList.toggle('on', Boolean(view.picking));
  const web = view.tabs.filter((x) => x.kind !== 'preview');
  const previews = view.tabs.filter((x) => x.kind === 'preview');
  $('web-tabs').replaceChildren(...web.map(tabRow));
  $('preview-tabs').replaceChildren(...previews.map(tabRow));
  $('preview-group').hidden = previews.length === 0;
  if (!window.cowork.plain && !document.body.classList.contains('board')) $('title').textContent = t?.title && t.title !== 'New Tab' ? t.title : 'Claude Code';
  showStatus(view.note);
}

on('state', (s) => { view = s; render(); });

// ---- Status line ----

const IDLE = () => (view.hold ? 'You have control, Claude is paused' : 'Shared with Claude');
let noticeTimer;
function showStatus(text) {
  if (noticeTimer) return;
  $('status').textContent = text || IDLE();
  $('status').classList.toggle('busy', Boolean(text));
}
on('notice', (text) => {
  clearTimeout(noticeTimer);
  noticeTimer = null;
  showStatus(text);
  noticeTimer = setTimeout(() => { noticeTimer = null; showStatus(view.note); }, 5000);
});

// ---- Sidebar ----

$('toggle-sidebar').addEventListener('click', () => document.body.classList.toggle('collapsed'));
$('add-terminal').addEventListener('click', () => { $('add-menu').hidden = !$('add-menu').hidden; });
$('add-menu').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { $('add-menu').hidden = true; send('termNew', b.dataset.kind); }));
$('row-agents').addEventListener('click', () => (document.body.classList.contains('board') ? closeBoard() : openBoard()));

const TERMINAL_ICON = '<svg viewBox="0 0 16 16"><path d="M3 4.5l3.5 3.5L3 11.5M8 12h5"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
const agentOf = (id) => agents.find((a) => a.id === id);

function renderTerminals() {
  const rows = [...terminals.values()].map((t) => {
    const a = agentOf(t.id);
    const el = document.createElement('div');
    el.className = `row terminal${t.id === termId && !document.body.classList.contains('board') ? ' current' : ''}`;
    el.innerHTML = TERMINAL_ICON;
    el.addEventListener('click', () => showTerminal(t.id));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t.name;
    el.append(name);
    if (a) { const dot = document.createElement('i'); dot.className = `dot ${a.state}`; dot.title = LANES.find((l) => l.state === a.state)?.title ?? ''; el.append(dot); }
    if (terminals.size > 1) {
      const close = document.createElement('button');
      close.setAttribute('aria-label', `Close ${t.name}`);
      close.innerHTML = CLOSE_ICON;
      close.addEventListener('click', (e) => { e.stopPropagation(); send('termClose', t.id); });
      el.append(close);
    }
    return el;
  });
  $('term-list').replaceChildren(...rows);
  const waiting = agents.filter((a) => a.state === 'needs').length;
  const count = $('agents-count');
  count.textContent = waiting || agents.filter((a) => a.state === 'working').length || '';
  count.classList.toggle('alert', waiting > 0);
  $('row-agents').classList.toggle('current', document.body.classList.contains('board'));
}

// ---- Agents board ----

const LANES = [{ state: 'ready', title: 'Ready' }, { state: 'working', title: 'Working' }, { state: 'needs', title: 'Needs you' }, { state: 'done', title: 'Done' }];

function elapsed(since) {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

function card(a) {
  const el = document.createElement('button');
  el.className = 'card' + (a.term ? '' : ' away');
  if (a.term) el.addEventListener('click', () => showTerminal(a.term));
  else el.title = 'Runs outside this app (for example in tmux), so there is no terminal here to open';
  const line = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; };
  const head = line('head', a.name);
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = elapsed(a.since);
  head.append(time);
  el.append(head, line('folder', a.folder));
  if (a.prompt) el.append(line('prompt', a.prompt));
  const more = a.subagents ? ` with ${a.subagents} subagent${a.subagents > 1 ? 's' : ''}` : '';
  el.append(line('doing', `${a.activity}${more}`));
  // Background work: workflows, shells, monitors and agents, running first, finished ones fade out after a while.
  const tasks = a.tasks ?? [];
  if (tasks.length) {
    const list = document.createElement('ul');
    list.className = 'tasks';
    const SHOW = 8;
    for (const x of tasks.slice(0, SHOW)) {
      const li = document.createElement('li');
      li.className = `task ${x.state}`;
      li.title = `${x.kind}: ${x.label}`;
      li.innerHTML = '<i class="dot"></i><span class="kind"></span><span class="label"></span><span class="time"></span>';
      li.querySelector('.kind').textContent = x.kind;
      li.querySelector('.label').textContent = x.label;
      li.querySelector('.time').textContent = x.state === 'running' ? elapsed(x.started) : x.state === 'done' ? 'done' : x.state;
      list.append(li);
    }
    if (tasks.length > SHOW) { const li = document.createElement('li'); li.className = 'task more'; li.textContent = `${tasks.length - SHOW} more`; list.append(li); }
    el.append(list);
  }
  return el;
}

function renderBoard() {
  if ($('board').hidden) return;
  $('board').replaceChildren(...LANES.map(({ state, title }) => {
    const lane = document.createElement('div');
    lane.className = 'lane';
    const inLane = agents.filter((a) => a.state === state);
    const h = document.createElement('h3');
    h.innerHTML = `<i class="dot ${state}"></i>`;
    h.append(title);
    const n = document.createElement('span');
    n.textContent = inLane.length || '';
    h.append(n);
    lane.append(h, ...inLane.map(card));
    return lane;
  }));
}

function openBoard() {
  document.body.classList.add('board');
  $('board').hidden = false;
  send('board', true);
  renderBoard();
  renderTerminals();
  $('title').textContent = 'Agents';
}

function closeBoard() {
  if (!document.body.classList.contains('board')) return;
  document.body.classList.remove('board');
  $('board').hidden = true;
  send('board', false);
  render();
  fitFront();
}

on('agents', ({ list }) => { agents = list; renderTerminals(); renderBoard(); });
setInterval(renderBoard, 1000);

// ---- Appearance: Light, or Glass over a wallpaper, laid out like System Settings > Appearance on macOS 27. ----

let look = { mode: 'light', wallpaper: 'tahoe', tint: 0.5, custom: null, list: [] };
// In Glass the terminal draws no background of its own, so the frosted pane behind it shows.
function termTheme() { return look.mode === 'glass' ? { ...THEME, background: 'rgba(0,0,0,0)' } : THEME; }
const wallpaperUrl = (id) => (id === 'custom' && look.custom ? look.custom : `wallpapers/${look.list.some((w) => w.id === id) ? id : 'tahoe'}.jpg`);

function applyAppearance() {
  const glass = look.mode === 'glass';
  document.body.classList.toggle('glass', glass);
  document.body.style.setProperty('--wallpaper', `url("${wallpaperUrl(look.wallpaper)}")`);
  document.body.style.setProperty('--tint', String(look.tint));
  for (const t of terminals.values()) t.xterm.options.theme = termTheme();
  renderAppearance();
}

function renderAppearance() {
  for (const tile of document.querySelectorAll('.tile')) {
    const on = tile.dataset.mode === look.mode;
    tile.classList.toggle('on', on);
    tile.setAttribute('aria-checked', String(on));
    tile.querySelector('.thumb').style.backgroundImage = `url("${look.wallpaper === 'custom' && look.custom ? look.custom : `wallpapers/${look.wallpaper}-thumb.jpg`}")`;
  }
  $('tint').value = Math.round(look.tint * 100);
  $('tint').style.setProperty('--v', `${look.tint * 100}%`);
  const box = $('wallpapers');
  const items = [...look.list.map((w) => ({ id: w.id, name: w.name, thumb: `wallpapers/${w.id}-thumb.jpg` })),
    ...(look.custom ? [{ id: 'custom', name: 'My Picture', thumb: look.custom }] : [])];
  box.replaceChildren(...items.map((w) => {
    const b = document.createElement('button');
    b.className = 'wall' + (w.id === look.wallpaper ? ' on' : '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(w.id === look.wallpaper));
    b.innerHTML = '<span class="pic"></span><span class="caption"></span>';
    b.querySelector('.pic').style.backgroundImage = `url("${w.thumb}")`;
    b.querySelector('.caption').textContent = w.name;
    b.addEventListener('click', () => send('appearance', { wallpaper: w.id, mode: 'glass' }));
    return b;
  }));
  const add = document.createElement('button');
  add.className = 'wall add';
  add.innerHTML = '<span class="pic"><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg></span><span class="caption">Choose…</span>';
  add.setAttribute('aria-label', 'Choose a picture');
  add.addEventListener('click', () => send('pickWallpaper'));
  box.append(add);
  const w = look.list.find((x) => x.id === look.wallpaper);
  $('wallpaper-credit').textContent = w ? `${w.name}: photo by ${w.artist}, ${w.license}, Wikimedia Commons` : '';
}

function openAppearance() {
  if (!$('sheet-veil').hidden) return;
  $('sheet-veil').hidden = false;
  send('sheet', true);
  requestAnimationFrame(() => $('appearance').focus());   // The sheet takes focus, so no tile shows a second ring.
}
function closeAppearance() {
  if ($('sheet-veil').hidden) return;
  $('sheet-veil').hidden = true;
  send('sheet', false);
  term?.focus();
}

on('appearance', (a) => { look = a; applyAppearance(); });
$('row-appearance').addEventListener('click', openAppearance);
$('appearance-done').addEventListener('click', closeAppearance);
$('sheet-veil').addEventListener('mousedown', (e) => { if (e.target === $('sheet-veil')) closeAppearance(); });
for (const tile of document.querySelectorAll('.tile')) tile.addEventListener('click', () => send('appearance', { mode: tile.dataset.mode }));
$('tint').addEventListener('input', () => {
  look.tint = $('tint').value / 100;   // Live while dragging, saved when let go.
  document.body.style.setProperty('--tint', String(look.tint));
  $('tint').style.setProperty('--v', `${$('tint').value}%`);
});
$('tint').addEventListener('change', () => send('appearance', { tint: $('tint').value / 100 }));
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === ',') { e.preventDefault(); openAppearance(); }
  else if (e.key === 'Escape' && !$('sheet-veil').hidden) { e.preventDefault(); closeAppearance(); }
});
