#!/usr/bin/env python3
"""Edits a real take into the film: real window frames on a background, with camera and cursor. No sound.
Usage: compose.py <take> <wallpaper> <end plate> <from frame> <to frame> <out.mp4>"""
import json, os, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
T, WALL, PLATE, F0, F1, OUT = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
W, H, FPS = 1920, 1080, 60
marks = [json.loads(l) for l in open(T + '/marks.jsonl')]
M = {}
for m in marks: M.setdefault(m['kind'], m)
t_end = M['end']['t']; t0 = os.path.getmtime(T + '/marks.jsonl') - t_end
def load(n):
    rows = [json.loads(l) for l in open(f'{T}/{n}/index.jsonl')]
    start = os.path.getmtime(f"{T}/{n}/{rows[0]['id']}-ui.jpg") - t0 - rows[0]['at'] / 1000
    return rows, start, np.array([r['at'] / 1000 + start for r in rows])
PLAIN, APP = load('plain'), load('app')

# (source start, source end, speed): real time, with waits and typing sped up.
SEG = [(M['plain_ready']['t'] - .2, M['launch']['t'] + .5, 1), (M['launch']['t'] + .5, M['p1']['t'], 1.2), (M['p1']['t'], M['p1_sent']['t'], 3),
       (M['p1_sent']['t'], M['p1_done']['t'], 2), (M['p1_done']['t'], M['p2']['t'], 1.2), (M['p2']['t'], M['p2_sent']['t'], 3),
       (M['p2_sent']['t'], M['p2_done']['t'] + 1.2, 2.2), (M['p3']['t'], M['p3_sent']['t'], 3), (M['p3_sent']['t'], M['p3_done']['t'] + 1.4, 1.8),
       (M['p3_done']['t'] + 1.4, M['hold_off']['t'] + 1, 1.6)]
cum = [0]
for a, b, s in SEG: cum.append(cum[-1] + (b - a) / s)
BODY = cum[-1]; TAIL = 5.0; DUR = BODY + TAIL; TOTAL = int(DUR * FPS)
def src(t):
    t = min(t, BODY - 1e-3)
    for i, (a, b, s) in enumerate(SEG):
        if t < cum[i + 1]: return a + (t - cum[i]) * s
    return SEG[-1][1]
def film(s):
    for i, (a, b, sp) in enumerate(SEG):
        if a <= s <= b: return cum[i] + (s - a) / sp
    return BODY
if len(sys.argv) > 7 or F1 < 0: print(TOTAL, round(DUR, 2)); sys.exit()
ease = lambda p: (lambda x: x * x * x * (x * (6 * x - 15) + 10))(min(1, max(0, p)))
tL = film(M['launch']['t'] + .35)   # The app window arrives just after Enter.

K = .9                              # Window pixels to frame pixels at rest.
L1, R1 = (-260, 170, 1.26), (250, -60, 1.3)
CAM = [(0, 0, 0, 1), (tL + 1.2, 0, 0, 1), (film(M['p1']['t']) - .1, 0, 0, 1), (film(M['p1']['t']) + .75, *L1), (film(M['p1_sent']['t']), *L1), (film(M['p1_sent']['t']) + 1.2, 0, 0, 1),
       (film(M['p1_done']['t']), 0, 0, 1), (film(M['point_on']['t']), *R1), (film(M['point_click']['t']) + .3, *R1), (film(M['p2']['t']) + .2, *L1), (film(M['p2_sent']['t']), *L1),
       (film(M['p2_sent']['t']) + 1.2, 0, 0, 1), (film(M['hold_on']['t']) - .4, 0, 0, 1), (film(M['hold_on']['t']) + .5, 230, 40, 1.28), (film(M['hold_off']['t']), 230, 40, 1.28), (BODY - .3, 0, 0, 1), (DUR, 0, 0, 1)]
def camera(t):
    for (a, ax, ay, az), (b, bx, by, bz) in zip(CAM, CAM[1:]):
        if t <= b:
            p = ease((t - a) / max(b - a, 1e-3)); return ax + (bx - ax) * p, ay + (by - ay) * p, az * (bz / az) ** p
    return CAM[-1][1:]
pt = json.loads(M['point_on']['at'][0]); POINT = (pt['x'] + pt['width'] / 2, pt['y'] + 18); HOLD = (1163, 26)
hero = (741 + M['point_click']['x'], 53 + M['point_click']['y']); field = (741 + M['field_click']['x'], 53 + M['field_click']['y'])
CUR = [(tL + 1, 640, 560), (film(M['p1_done']['t']), 640, 560), (film(M['point_on']['t']) - .1, *POINT), (film(M['point_on']['t']) + .3, *POINT), (film(M['point_hover']['t']), *hero), (film(M['point_click']['t']) + .2, *hero),
       (film(M['p2']['t']) + .5, 420, 640), (film(M['hold_on']['t']) - .6, 420, 640), (film(M['hold_on']['t']), *HOLD), (film(M['hold_on']['t']) + .3, *HOLD), (film(M['field_click']['t']), *field), (film(M['typed']['t']) + .2, *field), (film(M['hold_off']['t']), *HOLD), (film(M['hold_off']['t']) + .6, *HOLD)]
CLICKS = [film(M[k]['t']) for k in ('point_on', 'point_click', 'hold_on', 'field_click', 'hold_off')]
def cursor(t):
    if t <= CUR[0][0]: return CUR[0][1:]
    for (a, ax, ay), (b, bx, by) in zip(CUR, CUR[1:]):
        if t <= b:
            p = ease((t - a) / max(b - a, 1e-3)); return ax + (bx - ax) * p, ay + (by - ay) * p
    return CUR[-1][1:]

wall = Image.open(WALL).convert('RGB').crop((60, 40, 60 + W, 40 + H))
plate = Image.open(PLATE).convert('RGB')
def rounded(w, h, r):
    m = Image.new('L', (w * 3, h * 3), 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, w * 3 - 1, h * 3 - 1), r * 3, fill=255); return m.resize((w, h), Image.LANCZOS)
def arrow():
    c = Image.new('RGBA', (120, 120), (0, 0, 0, 0)); d = ImageDraw.Draw(c)
    pts = [(20, 8), (20, 86), (40, 66), (54, 98), (68, 92), (54, 61), (82, 61)]
    d.polygon(pts, fill=(255, 255, 255, 255)); d.polygon([(26, 22), (26, 72), (40, 58), (56, 90), (61, 88), (46, 55), (68, 55)], fill=(15, 15, 18, 255))
    return c.resize((40, 40), Image.LANCZOS)
ARROW = arrow()
cache = {}
def frame_img(kind, s):
    rows, start, times = PLAIN if kind == 'plain' else APP
    r = rows[max(0, int(np.searchsorted(times, s, 'right')) - 1)]
    key = kind + r['id']
    if key not in cache:
        cache.clear()
        u = Image.open(f"{T}/{kind}/{r['id']}-ui.jpg").convert('RGB')
        p = f"{T}/{kind}/{r['id']}-page.jpg"
        if kind == 'app' and os.path.exists(p):
            b = r['bounds']; sc = u.width / 1280
            u.paste(Image.open(p).convert('RGB').resize((round(b['width'] * sc), round(b['height'] * sc)), Image.BICUBIC), (round(b['x'] * sc), round(b['y'] * sc)))
        cache[key] = u
    return cache[key]
def place(canvas, img, cx, cy, w, h, alpha=1):
    w, h = int(w), int(h); x, y = int(cx - w / 2), int(cy - h / 2)
    r = max(6, int(14 * w / 1280))
    sh = Image.new('L', canvas.size, 0); sh.paste(rounded(w, h, r).point(lambda v: int(v * .5 * alpha)), (x, y + int(26 * w / 1280)))
    sh = sh.resize((W // 4, H // 4), Image.BILINEAR).filter(ImageFilter.GaussianBlur(9)).resize(canvas.size, Image.BILINEAR)
    canvas.paste((0, 0, 0), (0, 0), sh)
    canvas.paste(img.resize((w, h), Image.BICUBIC), (x, y), rounded(w, h, r).point(lambda v: int(v * alpha)))

enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-', '-an',
    '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p', '-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', '14', '-b:v', '0',
    '-spatial-aq', '1', '-temporal-aq', '1', '-profile:v', 'high', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', OUT], stdin=subprocess.PIPE)
for f in range(F0, min(F1, TOTAL)):
    t = f / FPS; s = src(t); c = wall.copy()
    cx, cy, z = camera(t)
    if t < tL + .5:
        place(c, frame_img('plain', min(s, M['launch']['t'] + 1)), W / 2, H / 2 + 10, 1350 * .78, 840 * .78)
    if t >= tL:
        p = ease((t - tL) / .45)
        ws = K * z * (.95 + .05 * p)
        place(c, frame_img('app', s), W / 2 - cx * K * z, H / 2 - cy * K * z, 1920 / 1.5 * 1.5 * ws, 1140 / 1.5 * 1.5 * ws, alpha=p)
        if t > tL + 1:
            ax, ay = cursor(t); press = any(k <= t < k + .12 for k in CLICKS)
            sx = W / 2 + ((ax - 640) * 1.5 - cx) * K * z / 1 if False else W / 2 + (ax * 1.5 - 960 - cx) * K * z
            sy = H / 2 + (ay * 1.5 - 570 - cy) * K * z
            a = ARROW.resize((int(40 * (.86 if press else 1)),) * 2, Image.LANCZOS)
            c.paste(a, (int(sx - 6), int(sy - 3)), a)
    if t > BODY - .1:
        c = Image.blend(c, plate, ease((t - BODY + .1) / 1.0))
    enc.stdin.write(c.tobytes())
enc.stdin.close(); enc.wait()
