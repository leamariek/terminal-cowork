#!/usr/bin/env python3
"""Runs tmux in a private PTY with a chosen pixel size and saves what reaches the outer terminal. No network."""
import fcntl, os, pty, select, struct, subprocess, sys, termios, time
out, secs, xpx, ypx, url, prof = sys.argv[1], float(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5], sys.argv[6]
root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sock = "cwcap-%d" % os.getpid()
viewer = "node spikes/e2e/viewer-once.js %s 520 400 %s" % (url, prof)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root); os.environ["TERM"] = "xterm-256color"
    os.execvp("tmux", ["tmux", "-L", sock, "-f", "tmux.conf", "new-session", "printf 'LEFT PANE\\n'; sleep 30", ";", "split-window", "-h", "-l", "62", viewer])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 34, 130, xpx, ypx))
buf, end = b"", time.time() + secs
while time.time() < end:
    if select.select([fd], [], [], 0.1)[0]:
        try: buf += os.read(fd, 65536)
        except OSError: break
open(out, "wb").write(buf)
subprocess.run(["tmux", "-L", sock, "kill-server"], cwd=root)
