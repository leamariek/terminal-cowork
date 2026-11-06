// The window's interface: terminal, toolbar and tab strip. All real work happens in main.cjs.
const { send, on } = window.cowork;
const $ = (id) => document.getElementById(id);

// ---- Terminal ----

const term = new Terminal({
  fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, 'Segoe UI Symbol', monospace",
  fontSize: 13,
  lineHeight: 1,
  cursorBlink: true,
  cursorStyle: 'block',
  scrollback: 20000,
  allowProposedApi: true,
  theme: {
    background: '#fcfbfa', foreground: '#1d1d1f', cursor: '#1d1d1f', cursorAccent: '#fcfbfa', selectionBackground: '#b3d7ff',
    black: '#1d1d1f', red: '#c8102e', green: '#1a7f37', yellow: '#946c00', blue: '#0060d6', magenta: '#8a3ffc', cyan: '#00798c', white: '#6e6e73',
    brightBlack: '#8e8e93', brightRed: '#e0313e', brightGreen: '#2a9d4a', brightYellow: '#b58900', brightBlue: '#0a84ff', brightMagenta: '#a65ef0', brightCyan: '#0e93a8', brightWhite: '#aeaeb2',
  },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);

document.fonts.load("13px 'JetBrains Mono'").finally(() => {
  term.open($('terminal'));
  fit.fit();
  term.focus();
  send('ready', { cols: term.cols, rows: term.rows });
  reportBounds();
});

term.onData((d) => send('input', d));
term.onResize((s) => send('resize', s));
on('pty', (d) => term.write(d));
on('pasted', (text) => term.paste(text));
on('focusTerminal', () => term.focus());
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown' || !e.ctrlKey) return true;
  if (e.key === 'c' && term.hasSelection()) { send('copy', term.getSelection()); term.clearSelection(); return false; }
  if (e.key === 'v') { send('paste'); return false; }
  return true;
});

// ---- Layout ----

function reportBounds() {
  const r = $('stage').getBoundingClientRect();
  send('bounds', { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
}
new ResizeObserver(() => { reportBounds(); if (term.element) fit.fit(); }).observe(document.body);
new ResizeObserver(reportBounds).observe($('stage'));
new ResizeObserver(() => { if (term.element) fit.fit(); }).observe($('terminal'));

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
  if (document.activeElement !== address) address.value = shortUrl(t?.url);
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
  $('title').textContent = t?.title && t.title !== 'New Tab' ? t.title : 'Claude Code';
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
$('row-terminal').addEventListener('click', () => term.focus());
