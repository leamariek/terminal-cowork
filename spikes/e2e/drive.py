#!/usr/bin/env python3
"""End-to-end test through a private PTY. Imitates Windows Terminal: ioctl pixel size 0, answers CSI 14t and 18t."""
import fcntl, json, os, pty, re, select, struct, subprocess, sys, termios, threading, time
S = sys.argv[1]
root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sock_env = dict(os.environ, COWORK_SOCK=S + "/t.sock", COWORK_PROFILE=S + "/tprofile", COWORK_CELL="10x20")
ts = "cwt-%d" % os.getpid()
right = "COWORK_SOCK=%s COWORK_PROFILE=%s COWORK_CELL=10x20 node src/pane.js 2>%s/pane.err" % (sock_env["COWORK_SOCK"], sock_env["COWORK_PROFILE"], S)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root); os.environ["TERM"] = "xterm-256color"
    os.execvp("python3", ["python3", "-P", "src/ptyproxy.py", "10", "20", "tmux", "-L", ts, "-f", "tmux.conf", "new-session", "sleep 120", ";", "split-window", "-h", "-l", "65", right])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 34, 130, 0, 0))
buf = bytearray(); stop = False
def reader():
    while not stop:
        if select.select([fd], [], [], 0.05)[0]:
            try: d = os.read(fd, 1 << 20)
            except OSError: return
            buf.extend(d)
            if b"\x1b[14t" in d: os.write(fd, b"\x1b[4;680;1300t")
            if b"\x1b[18t" in d: os.write(fd, b"\x1b[8;34;130t")
threading.Thread(target=reader, daemon=True).start()
def cw(*a, ok=True):
    r = subprocess.run(["node", "bin/cowork.js", *a], cwd=root, env=sock_env, capture_output=True, text=True, timeout=40)
    if ok and r.returncode: raise RuntimeError(a[0] + ": " + r.stderr.strip())
    return r
def js(*a): return json.loads(cw(*a).stdout)
fails = []
def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name, info if not cond or info else "")
    if not cond: fails.append(name)
def sixels(): return len(re.findall(rb"\x1bP[0-9;]*q", bytes(buf)))
def wait(fn, t=8):
    end = time.time() + t
    while time.time() < end:
        try:
            if fn(): return True
        except Exception: pass
        time.sleep(0.1)
    return False
try:
    check("pane boots and serves the socket", wait(lambda: os.path.exists(sock_env["COWORK_SOCK"]) and js("status"), 15))
    check("Sixel reaches outer terminal with pixel size only from CSI 14t", wait(lambda: sixels() > 0), "sixels=%d" % sixels())
    cell = subprocess.run(["tmux", "-L", ts, "display", "-p", "#{window_cell_width}x#{window_cell_height}"], cwd=root, capture_output=True, text=True).stdout.strip()
    check("window cell is the real 10x20, not the 16x32 default", cell == "10x20", cell)
    st = js("status"); print("  viewport", st["viewport"]); check("viewport from pane size", st["viewport"]["width"] == 650, st["viewport"])
    app = "file://" + root + "/spikes/e2e/app.html"
    os.write(fd, b"\x1b[<0;80;3M\x1b[<0;80;3m"); time.sleep(0.3)  # focus the right pane, then use the URL bar like a person
    os.write(fd, b"\x0c"); time.sleep(0.2); os.write(fd, b"example.com"); time.sleep(0.2); os.write(fd, b"\r")
    check("person loads a real internet page through the URL bar", wait(lambda: js("snapshot")["title"] == "Example Domain", 12), js("status")["urls"]["browser"])
    os.write(fd, b"\x0c"); time.sleep(0.2); os.write(fd, b"nonexistent.invalid"); time.sleep(0.2); os.write(fd, b"\r")
    check("a failed page says so and input stays alive", wait(lambda: "Could not load" in js("status")["urls"]["browser"], 12), js("status")["urls"]["browser"])
    js("open", app); check("agent open", "app.html" in js("status")["urls"]["browser"])
    os.write(fd, b"\x1b[<0;80;3M\x1b[<0;80;3m")   # person: tmux column 80 is pane column 14; row 3 is the input
    time.sleep(0.4)
    for c in b"hello": os.write(fd, bytes([c])); time.sleep(0.03)
    time.sleep(0.4)
    snap = js("snapshot"); val = [e for e in snap["elements"] if e["tag"] == "input"]
    check("person mouse + keyboard reach the page", val and val[0]["label"] == "hello", val)
    btn = [e for e in snap["elements"] if e["tag"] == "button"][0]
    js("click", str(btn["ref"])); time.sleep(0.3)
    check("agent click by ref", js("snapshot")["title"] == "clicked:hello", js("snapshot")["title"])
    check("console errors reach logs", any("boom from page" in l["text"] for l in js("logs")))
    js("scroll", "1000"); time.sleep(0.5)
    os.write(fd, b"\x1b[12~"); os.write(fd, b"\x1bOQ"); time.sleep(0.3)
    print("  hold state after F2 twice-encoded:", js("status")["hold"])
    if not js("status")["hold"]: os.write(fd, b"\x1bOQ"); time.sleep(0.3)
    h = cw("click", "5", "5", ok=False); check("F2 hold blocks the agent", h.returncode != 0 and "control" in h.stderr, h.stderr)
    os.write(fd, b"\x1bOQ"); time.sleep(0.3)
    if js("status")["hold"]: os.write(fd, b"\x1bOQ"); time.sleep(0.3)
    check("hold released", not js("status")["hold"])
    js("open", app); os.write(fd, b"\x1bOR"); time.sleep(0.3); os.write(fd, b"\x1b[<0;80;7M\x1b[<0;80;7m"); time.sleep(0.6)
    p = js("picked"); check("F3 point sends element", p and "button" in p["selector"], p)
    d = S + "/pv"; os.makedirs(d, exist_ok=True)
    open(d + "/a.md", "w").write("# Heading\n\n**bold** body\n")
    open(d + "/a.csv", "w").write('name,value\n"Lea, K",772\n')
    import openpyxl; wb = openpyxl.Workbook(); wb.active.append(["sheetcell", 5]); wb.save(d + "/a.xlsx")
    from PIL import Image; Image.new("RGB", (300, 200), (200, 30, 30)).save(d + "/a.png")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=1", "-pix_fmt", "yuv420p", d + "/a.mp4"], check=True)
    subprocess.run(["google-chrome", "--headless=new", "--no-pdf-header-footer", "--print-to-pdf=" + d + "/a.pdf", "--user-data-dir=" + S + "/pdfp", "file://" + root + "/spikes/e2e/page.html"], capture_output=True, timeout=30)
    for f, want in (("a.md", "Heading"), ("a.csv", "Lea, K"), ("a.xlsx", "sheetcell")):
        js("preview", d + "/" + f); check("preview " + f, want in js("snapshot")["text"])
    js("preview", d + "/a.png"); s = js("snapshot"); check("preview image", "a.png" in s["text"])
    js("preview", d + "/a.pdf"); check("preview pdf renders pages", os.path.exists(os.environ.get("XDG_RUNTIME_DIR", "") + "/cowork-state/pdf"))
    js("preview", d + "/a.mp4"); check("preview video", "a.mp4" in js("snapshot")["text"])
    n0 = sixels(); t0 = time.time(); js("tab", "browser"); js("open", "file://" + root + "/spikes/e2e/app.html")
    for i in range(30): js("scroll", "60" if i % 2 == 0 else "-60")
    dt = time.time() - t0; print("  sixels during scroll test:", sixels() - n0, "in %.1fs" % dt, "last paint ms", js("status")["lastPaintMs"], "bytes so far", len(buf))
    open(S + "/stream.bin", "wb").write(bytes(buf))
    widths = sorted(set(int(w) for w in re.findall(rb'"\d+;\d+;(\d+);\d+', bytes(buf))))
    check("every image arrives at full pane width", widths == [650], widths)
    js("quit"); time.sleep(0.8)
    check("Chrome exits with the pane", subprocess.run(["pgrep", "-f", "user-data-dir=" + sock_env["COWORK_PROFILE"]], capture_output=True).returncode != 0)
except Exception as e:
    fails.append("crash"); print("CRASH", repr(e))
finally:
    stop = True
    subprocess.run(["tmux", "-L", ts, "kill-server"], cwd=root, capture_output=True)
    if os.path.exists(S + "/pane.err"): print("pane.err:", open(S + "/pane.err").read()[-800:])
print("FAILED:", fails if fails else "none")
