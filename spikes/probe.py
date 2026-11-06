#!/usr/bin/env python3
"""Measures what this terminal can really do: Sixel, Kitty graphics, cell size, Sixel frame rate.
Run it in a normal terminal tab. Result goes to probe-result.json next to this file."""
import json, os, re, select, sys, termios, time, tty

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe-result.json")
W, H = 800, 480


def ask(seq, wait=0.6, until=b"c"):
    """Write a query, collect the reply until the DA1 terminator or timeout."""
    os.write(1, seq)
    buf, end = b"", time.time() + wait
    while time.time() < end:
        if select.select([0], [], [], 0.05)[0]:
            buf += os.read(0, 4096)
            if re.search(rb"\x1b\[\?[\d;]*" + until, buf):
                break
    return buf


def frame(shift):
    """Encode a text-dense test frame in 8 colours, close to the byte weight of a real page."""
    pal = [(100, 100, 100), (10, 10, 10), (80, 20, 20), (20, 60, 20), (20, 20, 80), (70, 60, 10), (40, 40, 40), (55, 75, 90)]
    head = "\x1bP0;1;0q\"1;1;%d;%d" % (W, H) + "".join("#%d;2;%d;%d;%d" % (i, *c) for i, c in enumerate(pal))

    def px(x, y):
        if y % 16 > 11 or (x + shift * 7) % 90 > 78:
            return 0  # line gap and word gap
        h = (x * 2654435761 ^ y * 40503 ^ shift * 97) >> 7  # glyph-like noise, so run-length coding cannot flatter the result
        return 0 if h % 3 else 1 + (h >> 3) % 7

    bands = []
    for b in range(0, H, 6):
        cols = [[px(x, b + r) for r in range(6)] for x in range(W)]
        parts = []
        for c in range(8):
            line, run, last = [], 0, None
            for col in cols:
                ch = chr(63 + sum(1 << r for r in range(6) if col[r] == c))
                if ch == last:
                    run += 1
                else:
                    if last:
                        line.append(("!%d%s" % (run, last)) if run > 3 else last * run)
                    last, run = ch, 1
            line.append(("!%d%s" % (run, last)) if run > 3 else last * run)
            s = "".join(line)
            if s.strip("?!0123456789"):
                parts.append("#%d%s" % (c, s))
        bands.append("$".join(parts))
    return (head + "-".join(bands) + "\x1b\\").encode()


def main():
    res = {"env": {k: os.environ.get(k) for k in ("TERM", "TERM_PROGRAM", "WT_SESSION", "TMUX")}}
    old = termios.tcgetattr(0)
    tty.setraw(0)
    try:
        da = ask(b"\x1b[c")
        res["da1"] = da.decode("latin1")
        res["sixel"] = bool(re.search(rb"\x1b\[\?[\d;]*\b4\b[\d;]*c", da))
        k = ask(b"\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[c")
        res["kitty_reply"] = k.decode("latin1")
        res["kitty_graphics"] = b"\x1b_Gi=31" in k
        res["xtversion"] = ask(b"\x1b[>q\x1b[c").decode("latin1")
        res["cell_px"] = ask(b"\x1b[16t\x1b[c").decode("latin1")
        res["text_area_px"] = ask(b"\x1b[14t\x1b[c").decode("latin1")
        res["pixel_mouse_1016"] = ask(b"\x1b[?1016$p\x1b[c").decode("latin1")
    finally:
        termios.tcsetattr(0, termios.TCSADRAIN, old)

    if res["sixel"]:
        frames = [frame(i) for i in range(4)]
        res["sixel_frame_bytes"] = len(frames[0])
        os.write(1, b"\x1b[2J\x1b[?25l")
        n, t0 = 0, time.time()
        while time.time() - t0 < 4:
            os.write(1, b"\x1b[H" + frames[n % 4])
            n += 1
        ask(b"\x1b[c", wait=3)  # the reply arrives only after the terminal has drained its input
        dt = time.time() - t0
        res["sixel_fps"] = round(n / dt, 1)
        res["sixel_mb_per_s"] = round(n * len(frames[0]) / dt / 1e6, 2)
        os.write(1, b"\x1b[?25h\x1b[2J\x1b[H")

    with open(OUT, "w") as f:
        json.dump(res, f, indent=2)
    print("sixel:", res["sixel"], "| kitty:", res["kitty_graphics"], "| fps:", res.get("sixel_fps", "n/a"))
    print("Saved:", OUT)


main()
