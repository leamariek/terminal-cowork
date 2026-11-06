<p align="center"><img src="app/icon.png" width="128" alt="terminal-cowork icon"></p>

<h1 align="center">terminal-cowork</h1>

<p align="center">Claude Code and a real browser in one window, on Windows with WSL.</p>

You and Claude share the same browser. Claude opens pages, clicks, types and reads errors while you watch, and you can step in at any moment. Everything Claude makes appears right beside the chat.

## Features

- **Real terminal:** a full WSL terminal that starts Claude Code for you.
- **Real browser:** Chromium with tabs, logins that persist and popups that open as new tabs.
- **Shared control:** 12 MCP tools let Claude open pages, read them, click, type, scroll, take screenshots and read console and network errors. A `cowork` command does the same from any WSL shell.
- **Take control:** one button pauses Claude in the browser, for example during a login.
- **Point:** click any element on a page to send its selector, text, HTML and a screenshot to Claude.
- **Preview:** images, video, audio, PDF, Markdown, HTML, CSV, Excel, diffs and text. Previewable files Claude writes open by themselves.
- **macOS look:** a light design with sizes and colours measured from macOS 27 windows.

## Requirements

- Windows 11 with WSL2 and an Ubuntu distribution
- Node.js 22 or later inside WSL
- [Claude Code](https://code.claude.com) inside WSL
- For Excel previews: `python3` with `openpyxl`. For PDF previews: `pdftoppm`.

## Install

Run this inside WSL:

```sh
git clone https://github.com/leamariek/terminal-cowork.git
cd terminal-cowork
npm install
node scripts/vendor.mjs
node scripts/package-windows.mjs
```

Copy `dist/terminal-cowork-win32-x64` to a folder on your Windows drive and open `terminal-cowork.exe`. Keep the cloned folder in WSL, because the app starts its backend from there.

The build is not code signed, so Windows SmartScreen may warn on first launch.

## Shortcuts

Inside the browser:

| Keys | Action |
| --- | --- |
| Ctrl+L | Go to the address bar |
| Ctrl+T | New tab |
| Ctrl+W | Close tab |
| Ctrl+Tab | Next tab |
| Ctrl+R | Reload |

## How it works

```
terminal-cowork.exe (window, browser)  <-- stdin and stdout through wsl.exe -->  backend/server.js (terminal, agent socket)
```

- `app/` is the Electron window. It holds no terminal code, so no native module is built for Windows.
- `backend/` runs inside WSL. Claude reaches it over a private Unix socket, so the app opens no network port.
- `src/mcp.js`, `src/autopreview.js` and `skills/cowork/` are Claude's side. They are passed as launch flags, so your global Claude Code settings stay unchanged.
- The browser has its own profile, separate from your normal browser. Web pages get no camera, microphone or location access.
- Problems on startup are written to `%APPDATA%\terminal-cowork\backend.log`.

`src/pane.js`, `src/sixel.js`, `src/ptyproxy.py` and `tmux.conf` are a second variant that runs inside Windows Terminal with Sixel graphics, started with `cowork` in a terminal.

## Test

```sh
spikes/e2e/app-up.sh <scratch folder> &
python3 spikes/e2e/app-check.py <scratch folder>
```

## Credits

Inspired by [terminal-mac](https://github.com/govijr/terminal-mac) and [terminal-browser](https://github.com/zenbu-labs/terminal-browser). Interface type is [Inter](https://rsms.me/inter/) and [JetBrains Mono](https://www.jetbrains.com/lp/mono/).

Not affiliated with Apple or Anthropic.

## License

[MIT](LICENSE)
