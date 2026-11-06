// Turns a local file into a page the Preview tab can show.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { marked } from 'marked';

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp']);
const VIDEO = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const AUDIO = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);
const MAX_ROWS = 2000;
const MAX_TEXT = 2_000_000;

// Under Windows, a page reaches WSL files through a different kind of file URL.
let toUrl = (p) => pathToFileURL(p).href;
export const setFileUrl = (fn) => { toUrl = fn; };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STYLE = `
:root{color-scheme:light}html{scrollbar-width:none}body{margin:0;padding:24px 28px;background:#fff;color:#1b1b1b;
font:16px/1.55 system-ui,sans-serif}h1,h2,h3{line-height:1.25}img,video{max-width:100%}pre{white-space:pre-wrap;
word-break:break-word;font:14px/1.5 ui-monospace,monospace;margin:0}code{font-family:ui-monospace,monospace}
table{border-collapse:collapse;font-size:14px}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}
th{background:#f0f0f0}.meta{color:#555;font-size:14px;margin-bottom:14px}.add{background:#dcf5e0}.del{background:#fbe0e0}
.hunk{color:#0a58a8}.center{display:flex;justify-content:center}`;

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}</style>
<div class="meta">${esc(title)}</div>${body}`;

const table = (rows) => {
  const shown = rows.slice(0, MAX_ROWS);
  const [head, ...rest] = shown;
  const cells = (r, tag) => `<tr>${r.map((c) => `<${tag}>${esc(c ?? '')}</${tag}>`).join('')}</tr>`;
  const cut = rows.length > MAX_ROWS ? `<p class="meta">First ${MAX_ROWS} of ${rows.length} rows</p>` : '';
  return `${cut}<table>${head ? cells(head, 'th') : ''}${rest.map((r) => cells(r, 'td')).join('')}</table>`;
};

function parseDelimited(text, sep) {
  const rows = [[]];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { rows.at(-1).push(cell); cell = ''; } else if (c === '\n') { rows.at(-1).push(cell.replace(/\r$/, '')); cell = ''; rows.push([]); } else cell += c;
  }
  if (cell) rows.at(-1).push(cell);
  if (rows.at(-1).length === 0) rows.pop();
  return rows;
}

const XLSX_READER = `
import json, sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
print(json.dumps({ws.title: [["" if c is None else str(c) for c in r] for _, r in zip(range(${MAX_ROWS}), ws.iter_rows(values_only=True))] for ws in wb}))
`;

function renderPdf(file, dir) {
  const out = join(dir, 'pdf');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  execFileSync('pdftoppm', ['-r', '110', '-png', '-l', '40', file, join(out, 'p')]);
  return readdirSync(out).sort().map((f) => `<p class="center"><img src="${toUrl(join(out, f))}"></p>`).join('');
}

export function buildPreview(input, stateDir) {
  const file = resolve(input);
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
  const ext = extname(file).toLowerCase();
  const name = basename(file);
  const url = toUrl(file);
  if (ext === '.html' || ext === '.htm') return url;

  let body;
  if (IMAGE.has(ext)) body = `<div class="center"><img src="${esc(url)}"></div>`;
  else if (VIDEO.has(ext)) body = `<video src="${esc(url)}" controls autoplay muted loop></video>`;
  else if (AUDIO.has(ext)) body = `<audio src="${esc(url)}" controls></audio>`;
  else if (ext === '.pdf') body = renderPdf(file, stateDir);
  else if (ext === '.xlsx' || ext === '.xlsm') {
    const sheets = JSON.parse(execFileSync('python3', ['-P', '-c', XLSX_READER, file], { maxBuffer: 1 << 28 }));
    body = Object.entries(sheets).map(([n, rows]) => `<h2>${esc(n)}</h2>${table(rows)}`).join('');
  } else {
    if (stat.size > MAX_TEXT) throw new Error(`Too large to preview as text: ${file}`);
    const text = readFileSync(file, 'utf8');
    if (ext === '.md' || ext === '.markdown') body = marked.parse(text);
    else if (ext === '.csv') body = table(parseDelimited(text, ','));
    else if (ext === '.tsv') body = table(parseDelimited(text, '\t'));
    else if (ext === '.diff' || ext === '.patch') {
      body = `<pre>${text.split('\n').map((l) => {
        const cls = l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
        return `<div class="${cls}">${esc(l) || ' '}</div>`;
      }).join('')}</pre>`;
    } else body = `<pre>${esc(text)}</pre>`;
  }

  mkdirSync(stateDir, { recursive: true });
  const target = join(stateDir, 'preview.html');
  writeFileSync(target, page(name, body));
  return toUrl(target);
}
