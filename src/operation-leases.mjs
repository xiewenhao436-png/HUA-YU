import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withCanvasWriteLock } from "./canvas-write-lock.mjs";
import { assertBoardAvailable, boardScopeKey, readLibraryIndex } from "./canvas-index.mjs";
import { canvasIdForThread } from "./runtime.mjs";

const staleUpdateLockMs = 30 * 60_000;
const userScope = createHash("sha256").update(os.homedir()).digest("hex").slice(0, 16);
const coordinationDir = path.join(os.tmpdir(), `codex-canvas-${userScope}`);

export function updateLockPath() {
  return path.join(coordinationDir, "update.lock");
}

export async function createOperationLease(kind, details = {}) {
  if (typeof details.projectDir === "string" && details.projectDir) return withCanvasWriteLock(details.projectDir, async () => {
    await assertBoardAvailable(details.projectDir, details.canvasId || canvasIdForThread(details.threadId));
    if (details.threadId) {
      const projectKey = await boardScopeKey(details.projectDir, null);
      for (const t of (await readLibraryIndex()).tombstones) if (t.board?.threadId === details.threadId && await boardScopeKey(t.projectDir, null) === projectKey) throw Object.assign(new Error("画布已移入回收站或已彻底删除，无法开始新操作。"), { statusCode: 410 });
    }
    return createOperationLeaseUnlocked(kind, details);
  });
  return createOperationLeaseUnlocked(kind, details);
}

async function createOperationLeaseUnlocked(kind, details = {}) {
  await fs.mkdir(coordinationDir, { recursive: true, mode: 0o700 });
  if (await updateLockIsActive()) throw updateInProgressError();

  const token = randomUUID();
  const leasePath = path.join(coordinationDir, `operation-${token}.json`);
  const pendingPath = path.join(coordinationDir, `.operation-${token}.tmp`);
  const handle = await fs.open(pendingPath, "wx", 0o600);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await handle.close().catch(() => {});
    await fs.rm(leasePath, { force: true }).catch(() => {});
    await fs.rm(pendingPath, { force: true }).catch(() => {});
  };

  try {
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      token,
      kind: String(kind || "operation"),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...sanitizeDetails(details)
    })}\n`);
    await handle.close();
    await fs.rename(pendingPath, leasePath);
    // Close the race with an updater that created update.lock after our first
    // check. The updater scans leases only after its lock exists, so either it
    // sees this lease or this second check rejects the operation.
    if (await updateLockIsActive()) {
      await release();
      throw updateInProgressError();
    }
    return { token, path: leasePath, release };
  } catch (error) {
    await release();
    throw error;
  }
}

export async function activeOperationLeases() {
  await fs.mkdir(coordinationDir, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(coordinationDir, { withFileTypes: true }).catch(() => []);
  const active = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("operation-") || !entry.name.endsWith(".json")) continue;
    const leasePath = path.join(coordinationDir, entry.name);
    const contents = await fs.readFile(leasePath, "utf8").catch(() => "");
    let lease = null;
    try {
      lease = JSON.parse(contents);
    } catch {
      lease = null;
    }
    const live = Number.isInteger(lease?.pid) && processIsAlive(lease.pid);
    if (lease?.schemaVersion === 1 && live) {
      active.push(lease);
    } else {
      const stat = await fs.stat(leasePath).catch(() => null);
      // An older process can still be publishing a lease in place. Never erase
      // a just-created partial record or treat it as proof that no work exists.
      if (!lease && stat && Date.now() - stat.mtimeMs < 30000) active.push({ kind: "initializing-operation" });
      else await fs.rm(leasePath, { force: true }).catch(() => {});
    }
  }
  return active;
}

export async function removeStaleUpdateLock() {
  const lockPath = updateLockPath();
  const stat = await fs.stat(lockPath).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs > staleUpdateLockMs) {
    await fs.rm(lockPath, { force: true }).catch(() => {});
    return true;
  }
  return false;
}

function sanitizeDetails(details) {
  const result = {};
  for (const key of ["action", "projectDir", "canvasId", "threadId"]) {
    if (typeof details?.[key] === "string" && details[key].trim()) result[key] = details[key].trim();
  }
  return result;
}

async function updateLockIsActive() {
  await removeStaleUpdateLock();
  try {
    await fs.access(updateLockPath());
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function updateInProgressError() {
  const error = new Error("画屿 is installing an update; wait for it to finish before starting another background operation.");
  error.statusCode = 409;
  error.code = "update-in-progress";
  return error;
}
