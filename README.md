# terminal-cowork

Cowork: one window with a real WSL terminal running Claude Code and a real browser beside it. Designed to macOS 27 light, with sizes and colours measured from a real Finder window.

## How it works

    Cowork.exe (Electron: window, browser tabs) <-- stdin and stdout through wsl.exe --> backend/server.js (terminal, agent socket)

- `app/` is the window. It holds no terminal code, so no native module has to be built for Windows.
- `backend/` runs in WSL. Claude reaches it over a Unix socket, so no port is opened.
- `src/mcp.js`, `src/autopreview.js` and `skills/cowork/` are Claude's side, passed by flags, so global settings stay untouched.
- First-run problems land in `%APPDATA%\Cowork\backend.log`.

## Build and test

    node scripts/vendor.mjs && node scripts/package-windows.mjs     # result in dist/Cowork-win32-x64
    spikes/e2e/app-up.sh <scratch> &                                # test instance, off-screen
    python3 spikes/e2e/app-check.py <scratch>                       # 26 checks, on a fresh boot only

`src/pane.js`, `src/ptyproxy.py`, `tmux.conf` and `cowork` with no arguments are the earlier Windows Terminal version, kept until the app has proven itself.
