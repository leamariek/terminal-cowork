// Copies the interface's third-party files into the app, and draws its icon.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const nm = fileURLToPath(new URL('../node_modules/', import.meta.url));
const out = fileURLToPath(new URL('../app/renderer/vendor/', import.meta.url));
mkdirSync(out, { recursive: true });
for (const [from, to] of [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', 'inter.woff2'],
  ['@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', 'jetbrains.woff2'],
]) copyFileSync(nm + from, out + to);

const svg = readFileSync(fileURLToPath(new URL('../app/icon.svg', import.meta.url)));
const sizes = [256, 128, 64, 48, 32, 16];
const pngs = await Promise.all(sizes.map((n) => sharp(svg, { density: 300 }).resize(n, n).png().toBuffer()));
writeFileSync(fileURLToPath(new URL('../app/icon.png', import.meta.url)), await sharp(svg, { density: 300 }).resize(512, 512).png().toBuffer());

// Windows picks the closest size from the ICO, so small sizes stay crisp instead of being scaled down.
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((n, i) => {
  const at = 6 + 16 * i;
  head[at] = n % 256;
  head[at + 1] = n % 256;
  head.writeUInt16LE(1, at + 4);
  head.writeUInt16LE(32, at + 6);
  head.writeUInt32LE(pngs[i].length, at + 8);
  head.writeUInt32LE(offset, at + 12);
  offset += pngs[i].length;
});
writeFileSync(fileURLToPath(new URL('../app/icon.ico', import.meta.url)), Buffer.concat([head, ...pngs]));
