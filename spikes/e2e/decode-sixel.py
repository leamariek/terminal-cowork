#!/usr/bin/env python3
"""Finds Sixel images in a captured terminal stream and decodes the largest one to a PNG."""
import re
import sys

from PIL import Image

raw = open(sys.argv[1], "rb").read()
seqs = re.findall(rb"\x1bP[0-9;]*q(.*?)\x1b\\", raw, re.S)
print("captured bytes", len(raw), "| sixel sequences", len(seqs), "| sizes", [len(s) for s in seqs][:6])
if not seqs:
    sys.exit("no Sixel reached the outer terminal")
body = max(seqs, key=len).decode("latin1")

m = re.match(r'"\d+;\d+;(\d+);(\d+)', body)
w, h = (int(m[1]), int(m[2])) if m else (1200, 1200)
img = Image.new("RGB", (w, h), (255, 0, 255))
px = img.load()
pal, color, x, y = {}, 0, 0, 0
for t in re.finditer(r'"[\d;]*|#(\d+)(?:;2;(\d+);(\d+);(\d+))?|!(\d+)(.)|([?-~])|(\$)|(-)', body):
    if t[1] is not None:
        color = int(t[1])
        if t[2] is not None:
            pal[color] = tuple(round(int(t[i]) * 255 / 100) for i in (2, 3, 4))
    elif t[5] is not None or t[7] is not None:
        n, ch = (int(t[5]), t[6]) if t[5] is not None else (1, t[7])
        bits = ord(ch) - 63
        for i in range(n):
            for r in range(6):
                if bits >> r & 1 and x + i < w and y + r < h:
                    px[x + i, y + r] = pal.get(color, (0, 0, 0))
        x += n
    elif t[8]:
        x = 0
    elif t[9]:
        x, y = 0, y + 6
img.save(sys.argv[2])
print("decoded", w, "x", h, "palette", len(pal), "->", sys.argv[2])
