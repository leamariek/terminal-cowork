// Encoder speed at the real pane size (990 x 1080), for a text page and a photo-like page.
import sharp from 'sharp'; import { encodeFast, encodeFine, decode } from '../../src/sixel.js';
const W = 990, H = 1080;
const text = await sharp({ text: { text: `<span foreground="black">${'The quick brown fox jumps over the lazy dog, 0123456789. '.repeat(60)}</span>`, width: W - 40, rgba: true, dpi: 110 } }).extend({ top: 20, bottom: 20, left: 20, right: 20, background: '#fff' }).flatten({ background: '#fff' }).png().toBuffer();
const noise = Buffer.alloc(320 * 360 * 3); for (let i = 0; i < noise.length; i++) noise[i] = (Math.sin(i / 97) * 90 + 128 + Math.random() * 40) | 0;
const photo = await sharp(noise, { raw: { width: 320, height: 360, channels: 3 } }).resize(W, H).blur(2).png().toBuffer();
const time = async (fn) => { await fn(); const t = Date.now(); let r; for (let i = 0; i < 6; i++) r = await fn(); return [(Date.now() - t) / 6, r]; };
for (const [n, b] of [['text', text], ['photo', photo]]) {
  const [dms, rgb] = await time(() => decode(b, W, H));
  const [fms, fast] = await time(() => encodeFast(rgb, W, 0, H));
  const [qms, fine] = await time(() => encodeFine(rgb, W, H));
  const [sms, strip] = await time(() => encodeFast(rgb, W, 120, 180));
  console.log(n.padEnd(6), `decode ${dms | 0} ms | fast ${fms | 0} ms ${fast.length >> 10} KB (${(1000 / (dms + fms)).toFixed(1)} fps) | fine ${qms | 0} ms ${fine.length >> 10} KB | 60px stripe ${sms | 0} ms ${strip.length >> 10} KB`);
}
