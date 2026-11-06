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
    d = S + "/pv"
    for f, want in (("a.md", "Heading"), ("a.csv", "Lea, K"), ("a.xlsx", "sheetcell"), ("a.png", "a.png"), ("a.mp4", "a.mp4")):
        js("preview", d + "/" + f); check("preview " + f, want in js("snapshot")["text"])
    js("preview", d + "/a.pdf"); check("preview pdf", wait(lambda: js("snapshot")["text"] is not None and "pdf" in js("snapshot")["text"]))
    kinds = [t["kind"] for t in js("status")["tabs"]]; check("previews reuse one Preview tab", kinds.count("preview") == 1, kinds)
    print("window sizes", js("status")["viewport"])
except Exception as e:
    fails.append("crash"); print("CRASH", repr(e)[:300])
print("FAILED:", fails if fails else "none")
