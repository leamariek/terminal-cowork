import json, subprocess, sys
p = subprocess.Popen(["node", "src/mcp.js"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def rpc(i, m, q):
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": m, "params": q}) + "\n"); p.stdin.flush()
    return json.loads(p.stdout.readline())
rpc(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})
p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"); p.stdin.flush()
print("tools:", [t["name"] for t in rpc(2, "tools/list", {})["result"]["tools"]])
r = rpc(3, "tools/call", {"name": "status", "arguments": {}})["result"]; print("status without pane:", r.get("isError"), r["content"][0]["text"][:70])
p.terminate()
