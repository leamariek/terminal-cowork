#!/usr/bin/env python3
"""Functional test of the running app (spikes/e2e/app-up.sh) through the same socket Claude uses. Usage: app-check.py <scratch folder>"""
import json, os, subprocess, sys, time
S = sys.argv[1]; root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
env = dict(os.environ, COWORK_SOCK=S + "/app.sock")
def cw(*a, ok=True):
    r = subprocess.run(["node", "bin/cowork.js", *a], cwd=root, env=env, capture_output=True, text=True, timeout=40)
    if ok and r.returncode: raise RuntimeError(" ".join(a[:2]) + ": " + r.stderr.strip())
    return r
def js(*a): return json.loads(cw(*a).stdout)
def ui(code):
    out = cw("call", "testUi", json.dumps({"js": code})).stdout.rstrip("\n")
    try: return json.loads(out)
    except ValueError: return out  # The CLI prints plain strings as they are.
fails = []
def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name, str(info)[:140] if not cond else "")
    if not cond: fails.append(name)
def wait(fn, t=10):
    end = time.time() + t
    while time.time() < end:
        try:
            if fn(): return True
        except Exception: pass
        time.sleep(0.15)
    return False
def pagey():
    subprocess.run(["true"]); return json.loads(cw("call", "pageEval", json.dumps({"js": "scrollY"})).stdout)
term_text = "(()=>{const b=term.buffer.active;let s='';for(let i=0;i<b.length;i++)s+=b.getLine(i).translateToString(true)+'\\n';return s})()"
try:
    check("app is up", wait(lambda: js("status")))
    ui("send('input','echo cowork-$((40+2))\\r'),1")
    check("terminal runs real commands", wait(lambda: "cowork-42" in ui(term_text)))
    ui("address.value='example.com';document.getElementById('address-form').requestSubmit(),1")
    check("person loads a real site through the address bar", wait(lambda: js("snapshot")["title"] == "Example Domain"))
    check("address capsule shows the short host", wait(lambda: ui("address.value") == "example.com"), ui("address.value"))
    check("padlock shows on https", ui("!document.getElementById('lock').hasAttribute('hidden')"))
    app = "file://" + root + "/spikes/e2e/app.html"
    js("open", app); snap = js("snapshot")
    check("agent open", snap["title"] == "Cowork test app", snap["title"])
    check("padlock hidden off https", ui("document.getElementById('lock').hasAttribute('hidden')"))
    inp = [e for e in snap["elements"] if e["tag"] == "input"][0]; btn = [e for e in snap["elements"] if e["tag"] == "button"][0]
    js("click", str(inp["ref"])); js("type", "hello")
    js("click", str(btn["ref"]))
    check("agent click and type", wait(lambda: js("snapshot")["title"] == "clicked:hello"), js("snapshot")["title"])
    check("console errors reach logs", wait(lambda: any("boom" in l["text"] for l in js("logs"))))
    js("scroll", "800")
    check("agent scroll moves the page", wait(lambda: pagey() > 100), pagey())
    ui("send('back'),1")
    check("back button goes back", wait(lambda: js("snapshot")["title"] == "Example Domain"))
    js("open", app)
    # A popup must become a real tab instead of vanishing.
    subprocess.run(["true"])
    n = len(js("status")["tabs"]); ui("send('newTab'),1")
    check("new tab appears in the sidebar", wait(lambda: len(js("status")["tabs"]) == n + 1 and ui("document.querySelectorAll('#web-tabs .row').length") == n + 1))
    ui("send('closeTab',view.active),1")
    check("closing a tab returns", wait(lambda: len(js("status")["tabs"]) == n))
    ui("send('hold'),1"); time.sleep(0.2)
    h = cw("click", "5", "5", ok=False); check("Take control blocks the agent", h.returncode != 0 and "control" in h.stderr, h.stderr)
    check("button says how to hand back", ui("document.querySelector('#hold span').textContent") == "Hand back to Claude")
    ui("send('hold'),1"); time.sleep(0.2)
    check("hand back restores the agent", cw("click", "5", "5", ok=False).returncode == 0)
    js("call", "testPick"); time.sleep(0.4); js("click", "120", "110")
    check("Point sends the element", wait(lambda: js("picked") and "button" in js("picked")["selector"]), cw("picked").stdout[:120])
    p = js("picked"); check("pointed element saved with a screenshot", os.path.exists(p.get("screenshot", "")))
    check("Point writes into the Claude prompt", wait(lambda: "the element I pointed at" in ui(term_text)))
    ui("send('input','\\u0003'),1")
    before = cw("picked").stdout
    ui("send('point'),1"); check("Point turns on", wait(lambda: ui("Boolean(view.picking)") is True))
    ui("send('point'),1"); check("second Point press lets go", wait(lambda: ui("Boolean(view.picking)") is False))
    js("click", "120", "110"); time.sleep(0.6)
    check("after letting go, a click is a normal click", cw("picked").stdout == before)
    check("pick listeners are gone from the page", cw("call", "pageEval", json.dumps({"js": "typeof window.__coworkCancelPick"})).stdout.strip().strip('"') == "undefined")
    # Copy and paste the Windows Terminal way.
    def keyp(k, mods): js("call", "testKey", json.dumps({"key": k, "mods": mods})); time.sleep(0.5)
    def fresh(): ui("send('input','\\u0003clear\\r'),1"); time.sleep(0.6)
    fresh(); js("call", "testClipboard", json.dumps({"text": "PASTEONE"})); keyp("v", ["control"])
    check("Ctrl+V pastes once", ui(term_text).count("PASTEONE") == 1, ui(term_text).count("PASTEONE"))
    fresh(); js("call", "testClipboard", json.dumps({"text": "PASTETWO"})); keyp("V", ["control", "shift"])
    check("Ctrl+Shift+V pastes once", ui(term_text).count("PASTETWO") == 1)
    fresh(); js("call", "testClipboard", json.dumps({"text": "PASTEINS"})); keyp("Insert", ["shift"])
    check("Shift+Insert pastes", ui(term_text).count("PASTEINS") == 1)
    fresh(); ui("send('input','echo COPY\"\"ME; sleep 3\\r'),1"); time.sleep(0.5)
    ui("(()=>{const b=term.buffer.active;for(let i=0;i<b.length;i++)if(b.getLine(i).translateToString(true)==='COPYME'){term.select(0,i,6);return 1}})()")
    ui("window.__sent=[];window.__tap=window.__tap||term.onData(d=>__sent.push(d)),1"); keyp("C", ["control", "shift"])
    check("Ctrl+Shift+C does not interrupt", ui("JSON.stringify(__sent)") == [], ui("JSON.stringify(__sent)"))
    time.sleep(3); keyp("v", ["control"])
    check("Ctrl+Shift+C copies", ui(term_text).rstrip().endswith("COPYME"), ui(term_text).rstrip()[-40:])
    fresh(); js("call", "testClipboard", json.dumps({"text": "PASTERIGHT"}))
    ui("document.querySelector('.term-pane.current').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})),1"); time.sleep(0.5)
    check("right-click pastes", ui(term_text).count("PASTERIGHT") == 1)
    fresh(); ui("send('input','stty -iexten; cat -v\\r'),1"); time.sleep(0.4)   # -iexten: the tty must not eat Ctrl+V as literal-next.
    png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
    js("call", "testClipboard", json.dumps({"png": png})); keyp("v", ["control"]); ui("send('input','\\r'),1"); time.sleep(0.4)
    check("Ctrl+V with an image passes Ctrl+V on for Claude Code", "^V" in ui(term_text), ui(term_text).rstrip()[-40:])
    ui("send('input','\\u0004'),1"); time.sleep(0.3)
    d = S + "/pv"
    for f, want in (("a.md", "Heading"), ("a.csv", "Lea, K"), ("a.xlsx", "sheetcell"), ("a.png", "a.png"), ("a.mp4", "a.mp4")):
        js("preview", d + "/" + f); check("preview " + f, want in js("snapshot")["text"])
    js("preview", d + "/a.pdf"); check("preview pdf", wait(lambda: js("snapshot")["text"] is not None and "pdf" in js("snapshot")["text"]))
    kinds = [t["kind"] for t in js("status")["tabs"]]; check("previews reuse one Preview tab", kinds.count("preview") == 1, kinds)
    # Terminals: a second one runs on its own, and switching keeps each session.
    n0 = ui("terminals.size")
    ui("send('termNew','shell'),1")
    check("a new terminal is added", wait(lambda: ui("terminals.size") == n0 + 1), ui("terminals.size"))
    check("the new terminal comes to the front", wait(lambda: ui("termId") == n0 + 1))
    time.sleep(1.2); ui("send('input','echo second-$((5+6))\\r'),1")
    check("the new terminal runs its own commands", wait(lambda: "second-11" in ui(term_text)))
    check("the first terminal is untouched", "second-11" not in ui("(()=>{const b=terminals.get(1).xterm.buffer.active;let s='';for(let i=0;i<b.length;i++)s+=b.getLine(i).translateToString(true);return s})()"))
    ui("showTerminal(1),1"); check("switching back works", ui("termId") == 1)
    # Board: driven by hook events through the real hook script.
    def hook(event, **k):
        subprocess.run(["node", "src/agent-hook.js"], cwd=root, env=dict(env, COWORK_TERM="1"), input=json.dumps({"hook_event_name": event, "cwd": "/tmp/demo-folder", **k}), text=True, timeout=20)
    state = lambda: js("call", "agents")[0]
    hook("UserPromptSubmit", prompt="fix the login page")
    check("prompt moves the card to Working", state()["state"] == "working" and state()["prompt"] == "fix the login page", state())
    hook("PreToolUse", tool_name="mcp__cowork__open", tool_input={"url": "x"})
    check("tool shows what the agent does", state()["activity"] == "Browser: open", state())
    hook("Notification", notification_type="idle_prompt", message="waiting")
    check("idle reminder does not raise an alert", state()["state"] == "working", state())
    hook("Notification", notification_type="permission_prompt", message="Claude needs your permission")
    check("permission moves the card to Needs you", state()["state"] == "needs", state())
    check("sidebar flags waiting agents", wait(lambda: ui("document.getElementById('agents-count').classList.contains('alert')")))
    hook("Stop"); check("Stop moves the card to Done", state()["state"] == "done", state())
    ui("openBoard(),1")
    check("board shows four lanes", wait(lambda: ui("document.querySelectorAll('.lane').length") == 4))
    check("card sits in the Done lane with its folder", wait(lambda: "demo-folder" in ui("document.querySelectorAll('.lane')[3].textContent")))
    check("shell terminals are not agents", len(js("call", "agents")) == 1)
    ui("document.querySelector('.card').click(),1")
    check("clicking a card opens that terminal", wait(lambda: ui("document.body.classList.contains('board')") is False and ui("termId") == 1))
    ui("send('termClose',2),1"); check("closing a terminal removes it", wait(lambda: ui("terminals.size") == n0))
    # Appearance: Light or Glass over a wallpaper, kept across restarts.
    vis = lambda: cw("call", "pageEval", json.dumps({"js": "document.visibilityState"})).stdout.strip().strip('"')
    ui("send('appearance',{mode:'light'}),1"); check("Light has no glass", wait(lambda: ui("document.body.classList.contains('glass')") is False))
    keyp(",", ["control"]); check("Ctrl+, opens Appearance", wait(lambda: ui("!document.getElementById('sheet-veil').hidden") is True))
    check("the page steps aside for the sheet", wait(lambda: vis() == "hidden"), vis())
    check("Light hides the glass settings", ui("getComputedStyle(document.getElementById('wallpapers').parentElement).display") == "none")
    ui("document.querySelector('.tile[data-mode=glass]').click(),1")
    check("Glass tile switches to glass", wait(lambda: ui("document.body.classList.contains('glass')") is True))
    check("eight wallpapers and a Choose tile", wait(lambda: ui("document.querySelectorAll('#wallpapers .wall').length") == 9))
    check("the terminal turns see-through", ui("term.options.theme.background") == "rgba(0,0,0,0)")
    ui("document.querySelectorAll('#wallpapers .wall')[4].click(),1")
    check("a wallpaper click paints the window", wait(lambda: "padar.jpg" in ui("getComputedStyle(document.body).backgroundImage")))
    check("each wallpaper credits its photographer", "Jakub" in ui("document.getElementById('wallpaper-credit').textContent"))
    ui("const t=document.getElementById('tint');t.value=20;t.dispatchEvent(new Event('input'));t.dispatchEvent(new Event('change')),1")
    check("the glass slider sets the tint", wait(lambda: ui("look.tint") == 0.2), ui("look.tint"))
    saved = json.load(open(S + "/appdata/appearance.json"))
    check("the choice is saved for next start", saved == {"mode": "glass", "wallpaper": "padar", "tint": 0.2}, saved)
    if os.environ.get("COWORK_PICK_FILE"):
        ui("send('pickWallpaper'),1")
        check("a picture of my own becomes the wallpaper", wait(lambda: ui("look.wallpaper") == "custom" and ui("look.custom.startsWith('data:image/jpeg')")))
        check("my picture joins the grid", wait(lambda: ui("document.querySelectorAll('#wallpapers .wall').length") == 10))
    keyp("Escape", []); check("Esc closes the sheet", wait(lambda: ui("document.getElementById('sheet-veil').hidden") is True))
    check("the page comes back", wait(lambda: vis() == "visible"), vis())
    ui("send('appearance',{mode:'light',wallpaper:'tahoe',tint:0.5}),1"); time.sleep(0.3)
    print("window sizes", js("status")["viewport"])
except Exception as e:
    fails.append("crash"); print("CRASH", repr(e)[:300])
print("FAILED:", fails if fails else "none")
