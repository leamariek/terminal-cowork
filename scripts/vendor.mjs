// Copies the interface's third-party files into the app, and draws its icon.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const nm = new URL('../node_modules/', import.meta.url).pathname;
const out = new URL('../app/renderer/vendor/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const [from, to] of [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', 'inter.woff2'],
  ['@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', 'jetbrains.woff2'],
]) copyFileSync(nm + from, out + to);

const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3a3c"/><stop offset="1" stop-color="#1c1c1e"/></linearGradient></defs>
<rect x="32" y="32" width="448" height="448" rx="100" fill="url(#g)"/><path d="M140 176l92 80-92 80" fill="none" stroke="#f2f2f7" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/><path d="M268 344h104" stroke="#0a84ff" stroke-width="36" stroke-linecap="round"/></svg>`;
const png = await sharp(Buffer.from(icon)).resize(256, 256).png().toBuffer();
writeFileSync(new URL('../app/icon.png', import.meta.url).pathname, png);

// An ICO file can simply wrap one PNG.
const head = Buffer.alloc(22);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(1, 4);
head.writeUInt16LE(1, 10);
head.writeUInt16LE(32, 12);
head.writeUInt32LE(png.length, 14);
head.writeUInt32LE(22, 18);
writeFileSync(new URL('../app/icon.ico', import.meta.url).pathname, Buffer.concat([head, png]));
