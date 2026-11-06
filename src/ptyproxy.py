#!/usr/bin/env python3
"""Runs a command in a PTY that reports real pixel sizes.

Windows Terminal over WSL reports 0 pixels through the PTY. tmux then keeps its default 16x32 cell for
the window and shrinks every Sixel, even though the terminal answers the size query correctly.

Usage: ptyproxy.py CELL_WIDTH CELL_HEIGHT command [args...]
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import tty

cell_w, cell_h = int(sys.argv[1]), int(sys.argv[2])
command = sys.argv[3:]


def copy_size(fd):
    rows, cols = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))[:2]
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, cols * cell_w, rows * cell_h))


pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)

copy_size(fd)
signal.signal(signal.SIGWINCH, lambda *_: copy_size(fd))
saved = termios.tcgetattr(0)
tty.setraw(0)
try:
    while True:
        try:
            ready = select.select([0, fd], [], [])[0]
        except InterruptedError:
            continue
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                break
            os.write(fd, data)
        if fd in ready:
            try:
                data = os.read(fd, 1 << 20)
            except OSError:
                break
            if not data:
                break
            view = memoryview(data)
            while view:
                view = view[os.write(1, view):]
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, saved)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
