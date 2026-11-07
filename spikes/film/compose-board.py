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
t_end = M['end']['t']; t0 = M['epoch']['t0'] if 'epoch' in M else os.path.getmtime(T + '/marks.jsonl') - t_end
def load(n):
    rows = [json.loads(l) for l in open(f'{T}/{n}/index.jsonl')]
    if 'abs' in rows[0]: return rows, 0, np.array([r['abs'] / 1000 - t0 for r in rows])   # Windows Terminal frames carry wall-clock times.
    if os.path.exists(T + '/timing.json'): start = json.load(open(T + '/timing.json'))[n]   # Measured offsets win over file times, which a copy resets.
    else: start = os.path.getmtime(f"{T}/{n}/{rows[0]['id']}-ui.jpg") - t0 - rows[0]['at'] / 1000
    return rows, start, np.array([r['at'] / 1000 + start for r in rows])
PLAIN, APP = load('plain'), load('app')

# Claude Code's start-up wait between launch + 2 s and app_ready is cut out.
# (source start, source end, speed): real time, with waits and typing sped up. One agent works at a time.
P = lambda k: M[k]['t']
SEG = [(P('plain_ready') - .2, P('launch') + .5, 1), (P('launch') + .5, P('launch') + 2, 1.2), (P('app_ready') - .2, P('p1'), 1.5), (P('p1'), P('p1_sent'), 5.5), (P('p1_sent'), P('p1_done') + .8, 5.5),
       (P('p1_done') + .8, P('menu') + 1, 1.3), (P('menu') + 1, P('t2_ready'), 5), (P('t2_ready'), P('p2'), 1.5), (P('p2'), P('p2_sent'), 5.5),
       (P('p2_sent'), P('board') + 1, 1.7), (P('board') + 1, P('all_done'), 6), (P('all_done'), P('end'), 1.6)]
# WT_OPEN=<dir of frames>: the opening is Lea's own Windows Terminal recording (30 fps, Enter on frame 124, app window from frame 161).
WT = os.environ.get('WT_OPEN'); WT_ENTER, WT_LAST, WT_BOX = 124 / 30, 160, (89, 81, 2009, 1297)
if WT: SEG[0] = (P('launch') - WT_ENTER, P('launch') + .5, 1)
def wt_frame(s):
    i = min(WT_LAST, max(0, round((s - P('launch') + WT_ENTER) * 30)))
    if ('wt', i) not in cache: cache.clear(); cache[('wt', i)] = Image.open(f'{WT}/{i + 1:04d}.png').convert('RGB').crop(WT_BOX)
    return cache[('wt', i)]
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
def ctr(k): r = M[k]['at']; return r['x'] + r['width'] / 2, r['y'] + r['height'] / 2
def look(k, z): x, y = ctr(k); return ((x * 1.5 - 960) * .75, (y * 1.5 - 570) * .75, z)
L1 = (-260, 170, 1.26); SB = look('plus', 1.32); f = lambda k, d=0: film(P(k)) + d
CAM = [(0, 0, 0, 1), (tL + 1.2, 0, 0, 1), (f('p1', -.1), 0, 0, 1), (f('p1', .75), *L1), (f('p1_sent'), *L1), (f('p1_sent', 1.2), 0, 0, 1),
       (f('plus', -.7), 0, 0, 1), (f('plus', .1), *SB), (f('menu', .9), *SB), (f('p2', .1), *L1), (f('p2_sent'), *L1), (f('board', .2), 0, 0, 1), (DUR, 0, 0, 1)]
def camera(t):
    for (a, ax, ay, az), (b, bx, by, bz) in zip(CAM, CAM[1:]):
        if t <= b:
            p = ease((t - a) / max(b - a, 1e-3)); return ax + (bx - ax) * p, ay + (by - ay) * p, az * (bz / az) ** p
    return CAM[-1][1:]
REST = (640, 560); TYPE = (420, 640)
CUR = [(tL + 1, *REST), (f('p1_done', .8), *REST), (f('plus'), *ctr('plus')), (f('plus', .7), *ctr('plus')), (f('menu'), *ctr('menu')), (f('menu', .7), *ctr('menu')),
       (f('p2', -.2), *TYPE), (f('p2_sent'), *TYPE), (f('board'), *ctr('board')), (f('board', .7), *ctr('board')), (f('all_done', -.3), 700, 330), (f('card'), *ctr('card')),
       (f('card', .7), *ctr('card')), (f('web'), *ctr('web')), (f('web', .7), *ctr('web'))]
CLICKS = [f(k, .5) for k in ('plus', 'menu', 'board', 'card', 'web')]
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
        if kind == 'plain': u = u.crop(u.convert('L').point(lambda v: 255 if v > 12 else 0).getbbox())   # Drop the invisible resize border.
        p = f"{T}/{kind}/{r['id']}-page.jpg"
        if kind == 'app' and os.path.exists(p) and r['bounds']['width'] > 0 and r['bounds']['height'] > 0:
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
        pl = wt_frame(s) if WT else frame_img('plain', min(s, M['launch']['t'] + 1)); place(c, pl, W / 2, H / 2 + 10, 1080, 1080 * pl.height / pl.width)
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
