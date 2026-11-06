#!/usr/bin/env python3
"""Shows what size tmux delivers a 520x396 Sixel at, per way of learning the pixel size. No network."""
import fcntl, os, pty, re, select, struct, subprocess, sys, termios, time
S = sys.argv[1]; root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
url = "file://" + root + "/spikes/e2e/page.html"
def run(mode):
    ts = "cwsc-%d-%s" % (os.getpid(), mode)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(root); os.environ["TERM"] = "xterm-256color"
        os.execvp("tmux", ["tmux", "-L", ts, "-f", "tmux.conf", "new-session", "sleep 30", ";", "split-window", "-h", "-l", "65", "node spikes/e2e/viewer-once.js %s 520 400 %s/psc" % (url, S)])
    px = (1300, 680) if mode == "ioctl" else (0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 34, 130, *px))
    buf, end = b"", time.time() + 7
    while time.time() < end:
        if select.select([fd], [], [], 0.05)[0]:
            d = os.read(fd, 1 << 20); buf += d
            if mode == "query":
                if b"\x1b[14t" in d: os.write(fd, b"\x1b[4;680;1300t")
                if b"\x1b[18t" in d: os.write(fd, b"\x1b[8;34;130t")
    fm = "client=#{client_cell_width}x#{client_cell_height} window=#{window_cell_width}x#{window_cell_height}"
    info = subprocess.run(["tmux", "-L", ts, "display", "-p", fm], cwd=root, capture_output=True, text=True).stdout.strip()
    subprocess.run(["tmux", "-L", ts, "kill-server"], cwd=root, capture_output=True)
    dims = sorted(set(re.findall(rb'"\d+;\d+;(\d+);(\d+)', buf)))
    print(mode.ljust(6), "delivered", [(int(a), int(b)) for a, b in dims], info)
for m in ("query", "ioctl"): run(m)
