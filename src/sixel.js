// Sixel encoding in two grades: a fixed palette that is quick enough for motion, and an adaptive
// 256-colour palette for the sharp frame shown once the page is still.
import sharp from 'sharp';

// Fixed palette: a 6x6x6 colour cube plus 38 greys, because page text is mostly grey antialiasing.
const FIXED = [];
for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) FIXED.push([r * 51, g * 51, b * 51]);
for (let i = 0; i < 38; i++) { const v = Math.round(((i + 1) * 255) / 39); FIXED.push([v, v, v]); }

const LUT = new Uint8Array(1 << 15);
for (let i = 0; i < LUT.length; i++) {
  const r = ((i >> 10) & 31) * 8.226;
  const g = ((i >> 5) & 31) * 8.226;
  const b = (i & 31) * 8.226;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread < 12) {
    const grey = (r + g + b) / 3;
    if (grey > 250) LUT[i] = 215;
    else if (grey < 4) LUT[i] = 0;
    else LUT[i] = 216 + Math.min(37, Math.max(0, Math.round((grey * 39) / 255) - 1));
  } else {
    LUT[i] = Math.round(r / 51) * 36 + Math.round(g / 51) * 6 + Math.round(b / 51);
  }
}

// Turns any image into packed RGB at exactly the pane's size.
export async function decode(input, width, height) {
  return sharp(input)
    .resize(width, height, { fit: 'contain', position: 'top', background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer();
}

function emit(idx, width, height, palette) {
  let out = Buffer.allocUnsafe(1 << 20);
  let n = 0;
  const room = (need) => {
    if (n + need <= out.length) return;
    const bigger = Buffer.allocUnsafe((out.length + need) * 2);
    out.copy(bigger, 0, 0, n);
    out = bigger;
  };
  const text = (s) => { room(s.length); n += out.write(s, n, 'latin1'); };

  text(`\x1bP0;1;0q"1;1;${width};${height}`);
  const pct = (v) => Math.round((v * 100) / 255);
  const seen = new Uint8Array(256);
  for (let i = 0; i < idx.length; i++) seen[idx[i]] = 1;
  palette.forEach((c, i) => { if (seen[i]) text(`#${i};2;${pct(c[0])};${pct(c[1])};${pct(c[2])}`); });

  const bits = new Uint8Array(256 * width);
  const used = new Uint8Array(256);
  for (let y = 0; y < height; y += 6) {
    bits.fill(0);
    used.fill(0);
    const rows = Math.min(6, height - y);
    for (let r = 0; r < rows; r++) {
      const row = (y + r) * width;
      for (let x = 0; x < width; x++) {
        const c = idx[row + x];
        bits[c * width + x] |= 1 << r;
        used[c] = 1;
      }
    }
    let first = true;
    for (let c = 0; c < 256; c++) {
      if (!used[c]) continue;
      room(width * 6 + 16);
      if (!first) out[n++] = 36; // $
      first = false;
      n += out.write(`#${c}`, n, 'latin1');
      const base = c * width;
      let x = 0;
      while (x < width) {
        const v = bits[base + x];
        let run = 1;
        while (x + run < width && bits[base + x + run] === v) run++;
        const ch = 63 + v;
        if (run > 3) {
          out[n++] = 33; // !
          n += out.write(String(run), n, 'latin1');
          out[n++] = ch;
        } else {
          for (let i = 0; i < run; i++) out[n++] = ch;
        }
        x += run;
      }
    }
    room(4);
    out[n++] = 45; // -
  }
  room(4);
  out[n++] = 0x1b;
  out[n++] = 0x5c;
  return out.subarray(0, n);
}

// Rows y0 to y1 of a packed RGB frame, with the fixed palette.
export function encodeFast(rgb, width, y0, y1) {
  const height = y1 - y0;
  const idx = new Uint8Array(width * height);
  let p = y0 * width * 3;
  for (let i = 0; i < idx.length; i++, p += 3) {
    idx[i] = LUT[((rgb[p] >> 3) << 10) | ((rgb[p + 1] >> 3) << 5) | (rgb[p + 2] >> 3)];
  }
  return emit(idx, width, height, FIXED);
}

// A whole packed RGB frame, with a palette fitted to it.
export async function encodeFine(rgb, width, height) {
  const png = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .png({ palette: true, colours: 256, dither: 0.4, effort: 1 })
    .toBuffer();
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const lookup = new Map();
  const palette = [];
  const idx = new Uint8Array(width * height);
  for (let i = 0; i < idx.length; i++) {
    const key = (data[i * ch] << 16) | (data[i * ch + 1] << 8) | data[i * ch + 2];
    let c = lookup.get(key);
    if (c === undefined) {
      c = Math.min(palette.length, 255);
      if (palette.length < 256) palette.push([key >> 16, (key >> 8) & 255, key & 255]);
      lookup.set(key, c);
    }
    idx[i] = c;
  }
  return emit(idx, width, height, palette);
}

export async function toSixel(input, width, height) {
  const h = height - (height % 6);
  return encodeFine(await decode(input, width, h), width, h);
}
