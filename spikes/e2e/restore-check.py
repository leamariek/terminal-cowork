#!/usr/bin/env python3
"""After a restart the app reopens its terminals: same names, same folders, tmux reattached, Claude sessions resumed.
Starts and stops its own app instances with a private data folder, Claude folder and tmux server.
Usage: restore-check.py <scratch folder>"""
import json, os, shutil, subprocess, sys, time
S = os.path.abspath(sys.argv[1]); root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.dirname(__file__)); import fake_session
for d in ("data", "claude", "tmux", "appdata"): shutil.rmtree(f"{S}/{d}", ignore_errors=True)
os.makedirs(f"{S}/tmux", exist_ok=True); os.makedirs(f"{S}/work/project-a", exist_ok=True)
env = dict(os.environ, COWORK_SOCK=S + "/app.sock", COWORK_DATA_DIR=S + "/data", COWORK_CLAUDE_DIR=S + "/claude", TMUX_TMPDIR=S + "/tmux", COWORK_RESTORE="1")
fails = []
def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name, str(info)[:160] if not cond else "")
    if not cond: fails.append(name)
def cw(*a): return subprocess.run(["node", "bin/cowork.js", *a], cwd=root, env=env, capture_output=True, text=True, timeout=40)
def ui(code):
    out = cw("call", "testUi", json.dumps({"js": code})).stdout.rstrip("\n")
    try: return json.loads(out)
    except ValueError: return out
def wait(fn, t=12):
    end = time.time() + t
    while time.time() < end:
        try:
            if fn(): return True
        except Exception: pass
        time.sleep(0.2)
    return False
text = lambda i: ui(f"(()=>{{const b=terminals.get({i}).xterm.buffer.active;let s='';for(let i=0;i<b.length;i++)s+=b.getLine(i).translateToString(true)+'\\n';return s}})()")
def start():
    app = subprocess.Popen([root + "/spikes/e2e/app-up.sh", S], env=env, stdout=open(S + "/restore-app.log", "a"), stderr=subprocess.STDOUT)
    wait(lambda: cw("status").returncode == 0, 40); time.sleep(1.5); return app
def stop(app):
    cw("quit"); 
    try: app.wait(15)
    except subprocess.TimeoutExpired: app.kill()
    time.sleep(0.5)
tmux = lambda *a: subprocess.run(["tmux", *a], env=env, capture_output=True, text=True)
fake = None
try:
    tmux("new-session", "-d", "-s", "cowork-check", "-c", S + "/work", "bash --norc")
    tmux("send-keys", "-t", "cowork-check", "echo tmux-alive-77", "Enter")
    app = start()
    check("first start opens one terminal", ui("terminals.size") == 1)
    ui(f"send('input',{{id:1,d:'cd {S}/work/project-a\\r'}}),1")
    ui("send('termNew','shell'),1"); wait(lambda: ui("terminals.size") == 2)
    time.sleep(1); ui("send('input',{id:2,d:'tmux attach -t cowork-check\\r'}),1")
    check("tmux runs in terminal 2", wait(lambda: "tmux-alive-77" in text(2)))
    ui("send('termNew','shell'),1"); wait(lambda: ui("terminals.size") == 3)
    # Terminal 3 runs a stand-in for claude, registered as a busy Claude Code session.
    time.sleep(1)
    ui(f"send('input',{{id:3,d:'cd {S}/work && exec -a claude sleep 600\\r'}}),1"); time.sleep(1)
    pid = int(subprocess.run(["pgrep", "-f", "-n", "^claude 600"], capture_output=True, text=True).stdout.split()[0])
    fake_session.make(S + "/claude", S + "/work", session_id="99999999-aaaa-bbbb-cccc-dddddddddddd", name="busy-one", status="busy").kill()
    rec = json.load(open(f"{S}/claude/sessions/" + [f for f in os.listdir(S + "/claude/sessions")][0]))
    os.remove(f"{S}/claude/sessions/{rec['pid']}.json"); rec.update(pid=pid, procStart=fake_session.proc_start(pid))
    json.dump(rec, open(f"{S}/claude/sessions/{pid}.json", "w"))
    time.sleep(3)
    stop(app)
    saved = json.load(open(S + "/data/restore.json"))
    check("quitting writes down all three terminals", len(saved) == 3, saved)
    check("terminal 1 keeps its folder", saved[0].get("cwd") == S + "/work/project-a", saved[0])
    check("terminal 2 remembers its tmux session", saved[1].get("resume") == {"tmux": "cowork-check"}, saved[1])
    check("terminal 3 remembers its Claude session, mid-task", saved[2].get("resume") == {"claude": "99999999-aaaa-bbbb-cccc-dddddddddddd", "working": True} and saved[2]["kind"] == "claude", saved[2])
    app = start()
    check("the next start brings all three back", wait(lambda: ui("terminals.size") == 3), ui("terminals.size"))
    check("names come back in order", ui("[...terminals.values()].map(t=>t.name).join('|')") == "|".join(t["name"] for t in saved), ui("[...terminals.values()].map(t=>t.name).join('|')"))
    ui("send('input',{id:1,d:'pwd\\r'}),1")
    check("terminal 1 opens in its folder", wait(lambda: (S + "/work/project-a") in text(1).replace("\n", "")), text(1)[-200:])   # Long paths wrap.
    check("terminal 2 is back inside tmux", wait(lambda: "tmux-alive-77" in text(2)), text(2)[-200:])
    check("terminal 3 comes back as a Claude terminal", ui("terminals.get(3).kind") == "claude")
    stop(app)
    os.remove(S + "/data/restore.json") if False else None
    # Closing the last terminal by hand means a clean start next time.
    app = start()
    for i in (3, 2): ui(f"send('termClose',{i}),1")
    wait(lambda: ui("terminals.size") == 1); ui("send('termClose',1),1"); time.sleep(1)
    check("closing every terminal clears the list", json.load(open(S + "/data/restore.json")) == [], open(S + "/data/restore.json").read()[:100])
    stop(app)
finally:
    tmux("kill-server")
    subprocess.run(["pkill", "-f", "^claude 600"], capture_output=True)
print("FAILED:", fails if fails else "none")
