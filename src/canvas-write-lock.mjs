import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { boardScopeKey, libraryPath } from "./canvas-index.mjs";

const held = new AsyncLocalStorage();
const queues = new Map();
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };

// The lifecycle lock lives outside canvas/, so deleting a board never removes
// its own lock. Project-level serialization also protects legacy migration from
// the default board to a thread while a sibling/default is being deleted.
// Reentry is limited to the same async operation; unrelated writes still wait.
export async function withCanvasWriteLock(projectDir, operation) {
  const key = await boardScopeKey(projectDir, null);
  if (held.getStore()?.get(key)?.active) return operation();
  const previous = queues.get(key) || Promise.resolve();
  let release;
  const turn = new Promise(resolve => { release = resolve; });
  const chain = previous.catch(() => {}).then(() => turn);
  queues.set(key, chain);
  await previous.catch(() => {});
  let handle, file, token;
  const context = { active: true };
  try {
    const dir = path.join(path.dirname(libraryPath()), ".canvas-write-locks");
    await fs.mkdir(dir, { recursive: true });
    file = path.join(dir, `${crypto.createHash("sha256").update(key).digest("hex")}.lock`);
    token = crypto.randomUUID();
    const startedAt = Date.now();
    while (!handle) {
      try {
        handle = await fs.open(file, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      } catch (error) {
        if (handle) { await handle.close().catch(() => {}); handle = null; await fs.unlink(file).catch(() => {}); throw error; }
        if (!["EEXIST", "EACCES", "EPERM"].includes(error.code)) throw error;
        const owner = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
        if (Number.isInteger(owner?.pid) && !isAlive(owner.pid)) await fs.unlink(file).catch(() => {});
        if (!owner) {
          const stat = await fs.stat(file).catch(() => null);
          if (stat && Date.now() - stat.mtimeMs > 30000) await fs.unlink(file).catch(() => {});
        }
        if (Date.now() - startedAt > 60000) throw Object.assign(new Error("画布仍在保存或导入，请稍后重试。"), { statusCode: 409 });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    return await held.run(new Map([...(held.getStore() || []), [key, context]]), operation);
  } finally {
    context.active = false;
    if (handle) {
      await handle.close().catch(() => {});
      const owner = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
      if (owner?.token === token) await fs.unlink(file).catch(() => {});
    }
    release();
    if (queues.get(key) === chain) queues.delete(key);
  }
}
