"""Writes a fake Claude Code session (record plus transcript) that the Agents board reads. Used by the checks."""
import json, os, subprocess, time


def proc_start(pid):
    stat = open(f"/proc/{pid}/stat").read()
    return stat[stat.rindex(")") + 2:].split(" ")[19]


def make(claude_dir, cwd, session_id="11111111-2222-3333-4444-555555555555", name="outside-1", status="busy", argv0=None):
    """Starts a stand-in process and returns it. argv0 names the process (a fake 'claude' for restore checks)."""
    cmd = ["bash", "-c", f"exec -a {argv0} sleep 600"] if argv0 else ["sleep", "600"]
    p = subprocess.Popen(cmd)
    time.sleep(0.2)
    os.makedirs(f"{claude_dir}/sessions", exist_ok=True)
    slug = "".join(c if c.isalnum() else "-" for c in cwd)
    os.makedirs(f"{claude_dir}/projects/{slug}", exist_ok=True)
    now = int(time.time() * 1000)
    json.dump({"pid": p.pid, "sessionId": session_id, "cwd": cwd, "procStart": proc_start(p.pid), "name": name, "status": status, "updatedAt": now, "statusUpdatedAt": now},
              open(f"{claude_dir}/sessions/{p.pid}.json", "w"))
    ts = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    lines = [
        {"type": "user", "timestamp": ts, "message": {"role": "user", "content": "ship the report"}},
        {"type": "assistant", "timestamp": ts, "message": {"content": [
            {"type": "tool_use", "id": "toolu_wf1", "name": "Workflow", "input": {"script": "export const meta = { name: 'nightly-build' }", "args": {"key": "build-42"}}},
            {"type": "tool_use", "id": "toolu_sh1", "name": "Bash", "input": {"command": "npm test", "description": "Run the tests", "run_in_background": True}}]}},
        {"type": "user", "timestamp": ts, "message": {"content": [
            {"type": "tool_result", "tool_use_id": "toolu_wf1", "content": "Workflow launched in background. Task ID: wabc123\nSummary: x"},
            {"type": "tool_result", "tool_use_id": "toolu_sh1", "content": "Command running in background with ID: bdef456. Output is being written to: /tmp/x"}]}},
        {"type": "api-request-blob", "message": {"content": [{"type": "tool_use", "id": "toolu_ghost", "name": "Workflow", "input": {}}]}},
        {"type": "queue-operation", "operation": "enqueue", "timestamp": ts, "content": "<task-notification>\n<task-id>bdef456</task-id>\n<tool-use-id>toolu_sh1</tool-use-id>\n<status>completed</status>\n</task-notification>"},
    ]
    with open(f"{claude_dir}/projects/{slug}/{session_id}.jsonl", "w") as f:
        for l in lines: f.write(json.dumps(l) + "\n")
    return p
