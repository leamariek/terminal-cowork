#!/usr/bin/env python3
"""Runs the real launcher with real Claude Code through a private PTY, answering as Windows Terminal did. No prompt is sent."""
import fcntl, os, pty, select, struct, subprocess, sys, termios, threading, time
root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
pid, fd = pty.fork()
if pid == 0:
    os.chdir(os.path.expanduser("~")); os.environ["TERM"] = "xterm-256color"; os.environ.pop("TMUX", None)  # an already trusted folder
    os.execvp("node", ["node", root + "/bin/cowork.js"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 56, 198, 0, 0))
stop = False; total = [0]
def reader():
    while not stop:
        if select.select([fd], [], [], 0.05)[0]:
            try: d = os.read(fd, 1 << 20)
            except OSError: return
            total[0] += len(d)
            if b"\x1b[16t" in d: os.write(fd, b"\x1b[6;20;10t")
            if b"\x1b[c" in d: os.write(fd, b"\x1b[?61;4;6;7;14;21;22;23;24;28;32;42;52c")
            if b"\x1b[14t" in d: os.write(fd, b"\x1b[4;1120;1980t")
            if b"\x1b[18t" in d: os.write(fd, b"\x1b[8;56;198t")
threading.Thread(target=reader, daemon=True).start()
T = ["tmux", "-L", "cowork"]
def sh(*a): return subprocess.run(T + list(a), capture_output=True, text=True).stdout
def left(): return sh("capture-pane", "-p", "-t", "cowork:0.0")
time.sleep(12)
print("panes:", sh("list-panes", "-t", "cowork", "-F", "#{pane_index} #{pane_width}x#{pane_height} active=#{pane_active} #{pane_current_command}").strip())
print("cell:", sh("display", "-p", "#{window_cell_width}x#{window_cell_height}").strip())
if "trust this folder" in left(): print("TRUST DIALOG SHOWN, stopping here"); 
print("--- left pane at start"); print("\n".join(l[:95] for l in left().splitlines() if l.strip())[:900])
sh("send-keys", "-t", "cowork:0.0", "-l", "/mcp"); time.sleep(0.5); sh("send-keys", "-t", "cowork:0.0", "Enter"); time.sleep(4)
print("--- left pane after /mcp"); print("\n".join(l[:95] for l in left().splitlines() if "cowork" in l.lower() or "connected" in l.lower() or "failed" in l.lower())[:700])
print("--- panes now:", sh("list-panes", "-t", "cowork", "-F", "#{pane_index} dead=#{pane_dead} status=#{pane_dead_status} #{pane_current_command}").strip())
print("--- full left:"); print("\n".join(l[:110] for l in left().splitlines() if l.strip())[-1400:])
print("status:", subprocess.run(["node", "bin/cowork.js", "status"], cwd=root, capture_output=True, text=True).stdout.replace("\n", " ")[:220])
print("bytes to terminal:", total[0])
sh("send-keys", "-t", "cowork:0.0", "Escape"); time.sleep(1)
sh("send-keys", "-t", "cowork:0.0", "-l", "/exit"); time.sleep(0.5); sh("send-keys", "-t", "cowork:0.0", "Enter"); time.sleep(5)
gone = subprocess.run(T + ["has-session", "-t", "cowork"], capture_output=True).returncode != 0
print("session closes with Claude:", gone)
print("pane socket removed:", not os.path.exists(os.environ["XDG_RUNTIME_DIR"] + "/cowork.sock"))
stop = True
if not gone: sh("kill-session", "-t", "cowork")
