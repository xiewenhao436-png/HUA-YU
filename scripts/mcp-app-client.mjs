import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
export function createMcpClient(root = new URL("../", import.meta.url), env = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("src/mcp-server.mjs", root))], {
    env: { ...process.env, CODEX_THREAD_ID: "", CODEX_CANVAS_CODEX_THREAD_ID: "", ...env }, stdio: ["pipe", "pipe", "inherit"]
  });
  let sequence = 0;
  let closed = false;
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  const rejectPending = () => {
    closed = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("MCP connection closed.")); }
    pending.clear();
  };
  child.once("exit", rejectPending);
  child.stdin.on("error", rejectPending);
  lines.on("line", line => {
    const message = JSON.parse(line);
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id); clearTimeout(p.timer);
    if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result);
  });
  return {
    request(method, params = {}) {
      if (closed) return Promise.reject(new Error("MCP connection closed."));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 20000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) { lines.close(); return; }
      child.stdin.end();
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill(), 1500);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      lines.close();
    }
  };
}
