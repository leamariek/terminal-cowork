#!/usr/bin/env python3
"""Runs one real take: a real shell, the real launch command, real Claude Code, real browser actions.
Writes marks.jsonl with what happened when. Usage: take.py <take folder>. Demo site must be serving on port 18413."""
import json, os, subprocess, sys, time
T = sys.argv[1]; os.makedirs(T, exist_ok=True)
root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
marks = open(T + "/marks.jsonl", "w"); t0 = time.time()
def mark(kind, **k):
    marks.write(json.dumps({"t": round(time.time() - t0, 3), "kind": kind, **k}) + "\n"); marks.flush(); print(round(time.time() - t0, 1), kind, k, flush=True)
def cw(sock, *a):
    return subprocess.run(["node", "bin/cowork.js", *a], cwd=root, env=dict(os.environ, COWORK_SOCK=sock), capture_output=True, text=True, timeout=40)
PS, AS = T + "/plain.sock", T + "/app.sock"
def ui(sock, js):
    r = cw(sock, "call", "testUi", json.dumps({"js": js})); return r.stdout.rstrip("\n")
def call(method, **p): return cw(AS, "call", method, json.dumps(p)).stdout
def send(sock, text): ui(sock, "send('input'," + json.dumps(text) + "),1")
def type_in(sock, text, cps=15):
    for ch in text: send(sock, ch); time.sleep(max(0, 1 / cps - .09))
SCREEN = "(()=>{const b=term.buffer.active;let s=[];for(let i=0;i<b.length;i++)s.push(b.getLine(i).translateToString(true));return s.join('\\n')})()"
def wait(fn, t=60, what=""):
    end = time.time() + t
    while time.time() < end:
        try:
            if fn(): return True
        except Exception: pass
        time.sleep(.3)
    mark("timeout", what=what); return False
def idle_after(n):
    # While Claude works, its status line offers "esc to interrupt".
    time.sleep(1.5)
    return wait(lambda: "esc to interrupt" not in ui(AS, SCREEN), 75, "idle")

base = dict(os.environ, COWORK_TEST="1", COWORK_CWD=os.path.expanduser("~/harbor-roast"))
base.pop("CLAUDE_CODE_CHILD_SESSION", None)
node = subprocess.run("command -v node", shell=True, capture_output=True, text=True).stdout.strip()
base["COWORK_NODE"] = node
electron = os.path.join(root, "node_modules/electron/dist/electron")
shell = ("export PS1='\\[\\e[1m\\]~/harbor-roast\\[\\e[0m\\] %% ' COWORK_SOCK=%s COWORK_NODE=%s COWORK_TEST=1 COWORK_WIDTH=1280 COWORK_HEIGHT=760 COWORK_RECORD=%s/app "
         "COWORK_HOST_RULES='MAP localhost:1212 127.0.0.1:18413' TERMINAL_COWORK_ELECTRON=%s TERMINAL_COWORK_ARGS='--force-device-scale-factor=1.5 --user-data-dir=%s/appdata'; "
         "export PATH=%s/.bin:$PATH; unset COWORK_SHELL_COMMAND COWORK_PLAIN COWORK_RECORD_MS; exec bash --norc --noprofile") % (AS, node, T, electron, T, T)
os.makedirs(T + "/.bin", exist_ok=True)
link = T + "/.bin/terminal-cowork"
if not os.path.exists(link): os.symlink(root + "/bin/terminal-cowork.js", link)
plain = subprocess.Popen([electron, root + "/app", "--no-sandbox", "--force-device-scale-factor=1.5", "--user-data-dir=" + T + "/plaindata"],
    env=dict(base, COWORK_PLAIN="1", COWORK_SOCK=PS, COWORK_WIDTH="900", COWORK_HEIGHT="560", COWORK_RECORD=T + "/plain", COWORK_RECORD_MS="14000", COWORK_SHELL_COMMAND=shell), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
wait(lambda: "harbor-roast" in ui(PS, SCREEN), 30, "shell")
time.sleep(1); ui(PS, "send('input','clear\\r'),1"); time.sleep(1.2)
mark("plain_ready"); type_in(PS, "terminal-cowork"); time.sleep(.5)
mark("launch"); send(PS, "\r")
wait(lambda: "bypass" in ui(AS, SCREEN) or "auto mode" in ui(AS, SCREEN), 40, "claude up")
mark("app_ready"); time.sleep(1.5)
ST = lambda: json.loads(cw(AS, "status").stdout)
def prompt(text, kind):
    mark(kind); type_in(AS, text); time.sleep(.4); send(AS, "\r"); mark(kind + "_sent")
prompt("open localhost:1212 and tell me what the hero says", "p1")
wait(lambda: "Harbor Roast" in json.dumps(ST()), 60, "site open"); mark("site_open")
idle_after(1); mark("p1_done"); time.sleep(1.5)
call("testPick"); mark("point_on", at=[ui(AS, "JSON.stringify(document.getElementById('point').getBoundingClientRect())")]); time.sleep(.8)
hero = json.loads(cw(AS, "call", "pageEval", json.dumps({"js": "(()=>{const b=document.querySelector('h1').getBoundingClientRect();return {x:b.x+120,y:b.y+b.height/2}})()"})).stdout)
call("testMove", x=int(hero["x"]), y=int(hero["y"])); mark("point_hover", **hero); time.sleep(1.1)
call("testClick", x=int(hero["x"]), y=int(hero["y"])); mark("point_click", **hero); time.sleep(1)
prompt("make it much bigger, 52px, and reload the page", "p2")
wait(lambda: float(cw(AS, "call", "pageEval", json.dumps({"js": "parseFloat(getComputedStyle(document.querySelector('h1')).fontSize)"})).stdout or 0) > 31, 90, "bigger")
mark("bigger"); idle_after(2); mark("p2_done"); time.sleep(1.5)
prompt("write a short notes.md about this change", "p3")
wait(lambda: any(t["kind"] == "preview" for t in ST()["tabs"]), 90, "preview"); mark("preview_open"); idle_after(3); mark("p3_done"); time.sleep(2)
ui(AS, "send('switchTab',view.tabs.find(t=>t.kind==='web').id),1"); time.sleep(1)
mark("hold_on"); ui(AS, "send('hold'),1"); time.sleep(.9)
box = json.loads(cw(AS, "call", "pageEval", json.dumps({"js": "(()=>{const b=document.getElementById('email').getBoundingClientRect();return {x:b.x+60,y:b.y+b.height/2}})()"})).stdout)
call("testClick", x=int(box["x"]), y=int(box["y"])); mark("field_click", **box); time.sleep(.4)
for i, ch in enumerate("you@example.com"): call("testInsert", text=ch); time.sleep(.03)
mark("typed"); time.sleep(1); ui(AS, "send('hold'),1"); mark("hold_off"); time.sleep(2.5)
mark("end"); cw(AS, "quit"); cw(PS, "quit"); time.sleep(1); plain.terminate()
