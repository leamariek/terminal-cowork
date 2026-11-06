#!/usr/bin/env python3
"""Builds a tiny font whose block characters fill a terminal cell exactly, so pixel art such as the Claude Code
logo renders without gaps. Metrics match JetBrains Mono: 1000 units, 600 wide, ascent 1020, descent 300."""
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
A, D, W = 1020, -300, 600
H = A - D
def rects(*rs):
    pen = TTGlyphPen(None)
    for x0, y0, x1, y1 in rs:  # Fractions of the cell, y from the top.
        # A small overlap at cell edges, so no seam shows between neighbouring blocks at fractional scaling.
        l, r = round(W * x0) - (12 if x0 == 0 else 0), round(W * x1) + (12 if x1 == 1 else 0); t, b = round(A - H * y0) + (12 if y0 == 0 else 0), round(A - H * y1) - (12 if y1 == 1 else 0)
        pen.moveTo((l, b)); pen.lineTo((l, t)); pen.lineTo((r, t)); pen.lineTo((r, b)); pen.closePath()
    return pen.glyph()
def poly(*pts):
    pen = TTGlyphPen(None); pen.moveTo(pts[0])
    for p in pts[1:]: pen.lineTo(p)
    pen.closePath(); return pen.glyph()
TL, TR, BL, BR = (0, 0, .5, .5), (.5, 0, 1, .5), (0, .5, .5, 1), (.5, .5, 1, 1)
G = {0x2580: rects((0, 0, 1, .5)), 0x2584: rects((0, .5, 1, 1)), 0x2588: rects((0, 0, 1, 1)), 0x258C: rects((0, 0, .5, 1)), 0x2590: rects((.5, 0, 1, 1)),
     0x2596: rects(BL), 0x2597: rects(BR), 0x2598: rects(TL), 0x259D: rects(TR), 0x2599: rects(TL, BL, BR), 0x259A: rects(TL, BR), 0x259B: rects(TL, TR, BL),
     0x259C: rects(TL, TR, BR), 0x259E: rects(TR, BL), 0x259F: rects(TR, BL, BR)}
for i in range(1, 8):
    G[0x2580 + i] = rects((0, 1 - i / 8, 1, 1))
    G[0x2590 - i] = rects((0, 0, i / 8, 1))
G[0x23F5] = poly((120, 120), (120, 640), (500, 380))                    # play arrow in Claude's mode line
G[0x23BF] = rects((.42, .02, .54, .62), (.42, .52, .98, .62))           # result corner in Claude's tool output
names = {cp: f'u{cp:04X}' for cp in G}
order = ['.notdef'] + list(names.values())
fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(order); fb.setupCharacterMap({cp: n for cp, n in names.items()})
fb.setupGlyf({'.notdef': TTGlyphPen(None).glyph(), **{names[cp]: g for cp, g in G.items()}})
fb.setupHorizontalMetrics({n: (W, 0) for n in order})
fb.setupHorizontalHeader(ascent=A, descent=D)
fb.setupNameTable({'familyName': 'Cell Blocks', 'styleName': 'Regular'})
fb.setupOS2(sTypoAscender=A, sTypoDescender=D, usWinAscent=A, usWinDescent=-D)
fb.setupPost()
fb.save('app/renderer/cells.ttf')
print('glyphs', len(G))
