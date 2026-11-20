import { meaningfulTitle, projectKeyForPath, resolveBoardIdentity } from "./canvas-identity.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { canvasIdForThread } from "./runtime.mjs";
import { canvasDataDirFor, projectRegistryPath, statePathFor } from "./paths.mjs";

export const libraryPath = () => process.env.CODEX_CANVAS_LIBRARY_PATH || path.join(os.homedir(), ".agents", "codex-canvas", "library.json");
export const libraryProjectCatalogPath = () => `${libraryPath().replace(/\.json$/i, "")}.projects.json`;
export const boardIdFor = (projectDir, canvasId) => crypto.createHash("sha256").update(JSON.stringify([path.resolve(projectDir), canvasId || null])).digest("hex").slice(0, 24);
const clean = (value, max = 500) => typeof value === "string" ? value.slice(0, max) : "";
let writeQueue = Promise.resolve();
let metadataCache;

async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }
export async function readLibraryIndex() {
  let data;
  try { data = JSON.parse(await fs.readFile(libraryPath(), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; data = {}; }
  // A previously running plugin can still rewrite the index without this new key.
  const projectCatalog = Array.isArray(data.projectCatalog) ? data.projectCatalog : await readJson(libraryProjectCatalogPath(), []);
  return { version: 2, projectCatalog: Array.isArray(projectCatalog) ? projectCatalog : [], boards: Array.isArray(data.boards) ? data.boards.filter(b => b && path.isAbsolute(b.projectDir || "")) : [],
    tombstones: Array.isArray(data.tombstones) ? data.tombstones : [], hiddenProjects: Array.isArray(data.hiddenProjects) ? data.hiddenProjects.filter(key => typeof key === "string").map(key => path.isAbsolute(key) ? projectKeyForPath(key) : key) : [], hiddenBoards: Array.isArray(data.hiddenBoards) ? data.hiddenBoards : [], lastByThread: data.lastByThread || {} };
}
export function updateLibraryIndex(change) {
  const task = writeQueue.catch(() => {}).then(async () => {
    const file = libraryPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fs.mkdir(lock); acquired = true; break; }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        try { if (Date.now() - (await fs.stat(lock)).mtimeMs > 30000) await fs.rmdir(lock); } catch {}
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (!acquired) throw new Error("Canvas library is busy. Retry shortly.");
    const heartbeat = setInterval(() => { const now = new Date(); fs.utimes(lock, now, now).catch(() => {}); }, 5000);
    heartbeat.unref();
    try {
      const data = await readLibraryIndex();
      await change(data);
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify(data, null, 2));
        // Windows briefly denies replacement while another reader or an indexer
        // holds the destination. Keep the lifecycle lock and old file intact;
        // deleting the destination would create a data-loss window.
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(tmp, file); break; }
          catch (error) {
            if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 7) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.min(25 * 2 ** attempt, 200)));
          }
        }
      } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
    } finally { clearInterval(heartbeat); await fs.rmdir(lock).catch(() => {}); }
  });
  writeQueue = task;
  return task;
}
const updateIndex = updateLibraryIndex;

// Persist physical scope separately from the public id: existing saved panels
// keep their ids while Windows namespace/case and junction aliases cannot evade
// a deletion tombstone. The canonical project survives deletion of its canvas.
export function normalizePhysicalPath(value) {
  let normalized = String(value || "");
  if (/^\\\\\?\\UNC\\/i.test(normalized)) normalized = `\\\\${normalized.slice(8)}`;
  else if (/^\\\\\?\\/.test(normalized)) normalized = normalized.slice(4);
  if (/^[a-z]:[\\/]/i.test(normalized) || normalized.startsWith("\\\\")) return path.win32.normalize(normalized).replace(/[\\/]+$/, "").toLowerCase();
  return path.resolve(normalized);
}
export async function boardScopeKey(projectDir, canvasId = null) {
  const canonical = await fs.realpath(projectDir).catch(() => path.resolve(projectDir));
  return normalizePhysicalPath(canvasDataDirFor(canonical, canvasId));
}
export async function boardTombstone(projectDir, canvasId = null, data) {
  data ||= await readLibraryIndex();
  const key = await boardScopeKey(projectDir, canvasId);
  return data.tombstones.find(b => b.scopeKey === key) || null;
}
export async function assertBoardAvailable(projectDir, canvasId = null) {
  if (await boardTombstone(projectDir, canvasId)) throw Object.assign(new Error("画布已移入回收站或已彻底删除，请返回画布中心。"), { statusCode: 410, code: "canvas-trashed" });
}
export function threadFromCanvasId(canvasId) {
  return String(canvasId || "").match(/^thread-([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})-/i)?.[1] || null;
}
export async function recordCanvas({ projectDir, canvasId = null, threadId = null, title, threadTitle, openedBy, projectOverride } = {}) {
  if (!path.isAbsolute(projectDir || "")) return;
  const id = boardIdFor(projectDir, canvasId);
  const scopeKey = await boardScopeKey(projectDir, canvasId);
  await updateIndex(data => {
    if (data.tombstones.some(b => b.scopeKey === scopeKey)) throw Object.assign(new Error("画布已移入回收站或已彻底删除。"), { statusCode: 410 });
    const previous = data.boards.find(b => b.id === id) || {};
    const board = { ...previous, id, scopeKey, projectDir: path.resolve(projectDir), canvasId, threadId: threadId || previous.threadId || threadFromCanvasId(canvasId),
      ...(title ? { title: clean(title) } : {}), ...(projectOverride !== undefined ? { projectOverride: clean(projectOverride, 120).trim() } : {}), ...(threadTitle ? { threadTitle: clean(threadTitle) } : {}), updatedAt: new Date().toISOString() };
    data.boards = [...data.boards.filter(b => b.id !== id), board];
    if (openedBy) data.lastByThread[openedBy] = id;
  });
  return id;
}

// Read only chat identity/title/cwd metadata. No turns, rollout bodies, auth or credentials.
export async function localThreads(refresh = false) {
  if (metadataCache && !refresh && Date.now() - metadataCache.at < 15000) return metadataCache.threads;
  let threads = [];
  if (process.env.CODEX_CANVAS_THREADS_FILE) threads = await readJson(process.env.CODEX_CANVAS_THREADS_FILE, []);
  else if (process.env.CODEX_CANVAS_DISABLE_THREAD_DISCOVERY !== "1") {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const names = (await fs.readdir(home)).filter(n => /^state_\d+\.sqlite$/.test(n)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
      if (names.length) {
        const db = new DatabaseSync(path.join(home, names[0]), { readOnly: true });
        try {
          const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map(c => c.name));
          const optional = ["name", "agent_path"].filter(c => columns.has(c));
          threads = db.prepare(`SELECT id,cwd,title,updated_at${optional.map(c => `,${c}`).join("")} FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 2000`).all()
            .filter(t => !t.agent_path || t.agent_path === "/root")
            .map(t => ({ id: t.id, cwd: t.cwd, title: t.name || t.title, updatedAt: t.updated_at }));
        } finally { db.close(); }
      }
    } catch {
      // Older Node builds can still open registered boards; this is enrichment only.
      try { threads = (await fs.readFile(path.join(home, "session_index.jsonl"), "utf8")).trim().split(/\r?\n/).filter(Boolean).slice(-2000).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); } catch {}
    }
  }
  threads = threads.filter(t => t && typeof t.id === "string").map(t => ({ id: clean(t.id, 200), cwd: clean(t.cwd, 4000), title: clean(t.title || t.thread_name), updatedAt: t.updatedAt || t.updated_at }));
  metadataCache = { at: Date.now(), threads };
  return threads;
}

export async function canvasIdentity(projectDir, canvasId, state = {}, options = {}) {
  const threadId = options.threadId || threadFromCanvasId(canvasId);
  const index = await readLibraryIndex();
  const entry = index.boards.find(board => board.id === boardIdFor(projectDir, canvasId));
  const threadTitle = options.threadTitle || (threadId && (await localThreads()).find(thread => thread.id === threadId)?.title) || entry?.threadTitle;
  return resolveBoardIdentity({
    projectDir, canvasId, displayTitle: entry?.displayTitle || options.displayTitle,
    title: meaningfulTitle(state.title) || entry?.title, threadTitle,
    projectOverride: entry?.projectOverride ?? state.projectOverride ?? options.projectOverride,
    objects: state.objects
  }, index.projectCatalog);
}

async function boardSummary(board, titles, projectCatalog) {
  try {
    const file = statePathFor(board.projectDir, board.canvasId);
    const stat = await fs.stat(file);
    if (stat.size > 64 * 1024 * 1024) return null;
    const state = await readJson(file, null);
    if (!Array.isArray(state?.objects)) return null;
    const images = state.objects.filter(o => (o.type || "image") === "image" && o.src);
    const threadTitle = titles.get(board.threadId)?.title || board.threadTitle || "";
    const identity = resolveBoardIdentity({
      ...board, title: meaningfulTitle(state.title) || board.title, threadTitle,
      projectOverride: board.projectOverride ?? state.projectOverride,
      objects: images
    }, projectCatalog);
    return { ...board, ...identity, threadTitle,
      imageCount: images.length, updatedAt: stat.mtime.toISOString(), coverId: images[0]?.id || null };
  } catch { return null; }
}
export async function listCanvases({ refresh = false } = {}) {
  const threads = await localThreads(refresh);
  const byCanvasId = new Map(threads.map(t => [canvasIdForThread(t.id), t]));
  const titles = new Map(threads.map(t => [t.id, t]));
  const index = await readLibraryIndex();
  const records = new Map(index.boards.map(b => [b.id, b]));
  const legacy = await readJson(projectRegistryPath(), {});
  for (const b of Array.isArray(legacy) ? legacy : legacy.projects || []) {
    if (!path.isAbsolute(b?.projectDir || "")) continue;
    const canvasId = b.canvasId || canvasIdForThread(b.chatThreadId);
    const id = boardIdFor(b.projectDir, canvasId);
    if (!records.has(id)) records.set(id, { id, projectDir: b.projectDir, canvasId, threadId: b.chatThreadId || byCanvasId.get(canvasId)?.id || threadFromCanvasId(canvasId) });
  }
  if (refresh) {
    const roots = [...new Set([...records.values()].map(b => b.projectDir).concat(threads.map(t => t.cwd)).filter(p => path.isAbsolute(p || "")))].slice(0, 240);
    let visited = 0;
    async function scan(dir, depth = 0) {
      if (depth > 9 || ++visited > 22000) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      if (entries.some(e => e.isFile() && e.name === ".huayu-ignore")) return;
      if (entries.some(e => e.isFile() && e.name === "codex-canvas.json")) {
        const parent = path.basename(dir) === "canvas" ? path.dirname(dir) : path.basename(path.dirname(dir)) === "threads" && path.basename(path.dirname(path.dirname(dir))) === "canvas" ? path.dirname(path.dirname(path.dirname(dir))) : null;
        if (parent) {
          const canvasId = path.basename(dir) === "canvas" ? null : path.basename(dir);
          const id = boardIdFor(parent, canvasId);
          const previous = records.get(id) || {};
          records.set(id, { ...previous, id, projectDir: parent, canvasId, threadId: previous.threadId || byCanvasId.get(canvasId)?.id || threadFromCanvasId(canvasId) });
        }
      }
      for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && !["assets", "jobs", "node_modules", ".git", "backups", "archive", "logs", "outputs", "node-tests", "test-runs", "installed-test-runs"].includes(e.name)) await scan(path.join(dir, e.name), depth + 1);
    }
    // Only known roots' canvas stores and organized task folders, never whole drives.
    for (const root of roots) { await scan(path.join(root, "canvas")); await scan(path.join(root, "_codex")); }
  }
  const physical = new Map();
  for (const b of records.values()) {
    const scopeKey = await boardScopeKey(b.projectDir, b.canvasId);
    if (index.tombstones.some(t => t.scopeKey === scopeKey) || physical.has(scopeKey)) continue;
    physical.set(scopeKey, { ...b, scopeKey });
  }
  let boards = (await Promise.all([...physical.values()].map(b => boardSummary(b, titles, index.projectCatalog)))).filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (refresh) await updateIndex(data => { for (const b of boards) { if (data.tombstones.some(t => t.scopeKey === b.scopeKey)) continue; const i = data.boards.findIndex(x => x.id === b.id); if (i < 0) data.boards.push(b); else { const { displayTitle, projectOverride, importance, ...derived } = b; data.boards[i] = { ...data.boards[i], ...derived }; } } });
  // Re-read after an awaited scan so a concurrent deletion is never rendered as
  // active by a refresh that began before the user moved it to the recycle bin.
  const latest = await readLibraryIndex();
  boards = boards.filter(b => !latest.tombstones.some(t => t.scopeKey === b.scopeKey));
  const trash = latest.tombstones.filter(t => !t.purgedAt).map(t => ({ ...t.board, id: t.id, trashedAt: t.trashedAt,
    ...(t.purgeStartedAt ? { purgeStartedAt: t.purgeStartedAt, canRestore: false } : { canRestore: true }) }));
  const namedThreads = threads.map(thread => {
    if (!path.isAbsolute(thread.cwd)) return thread;
    const { projectKey, projectName } = resolveBoardIdentity({ projectDir: thread.cwd }, index.projectCatalog);
    return { ...thread, projectKey, projectName };
  });
  const projectCatalog = latest.projectCatalog.filter(entry => entry && typeof entry.root === "string" && path.isAbsolute(entry.root) && meaningfulTitle(entry.name))
    .map(entry => ({ root: entry.root, name: entry.name, key: projectKeyForPath(entry.root) }));
  return { boards, trash, threads: namedThreads, projectCatalog, hiddenProjects: latest.hiddenProjects, hiddenBoards: latest.hiddenBoards, lastByThread: latest.lastByThread };
}
export async function knownBoard(id) {
  const data = await listCanvases();
  const board = data.boards.find(b => b.id === id);
  if (!board) throw new Error("画布不存在或素材目录已移动，请刷新画布列表。");
  return board;
}

export async function updateBoardMetadata(id, { displayTitle, importance, projectName } = {}) {
  const board = await knownBoard(id);
  if (displayTitle !== undefined && (typeof displayTitle !== "string" || !meaningfulTitle(displayTitle) || displayTitle.trim().length > 200)) throw new Error("请输入 1 至 200 个字符的画布名称。");
  if (projectName !== undefined) validateProjectName(projectName);
  if (importance !== undefined && (!Number.isInteger(importance) || importance < 0 || importance > 5)) throw new Error("重要度须为 0 至 5 星。");
  await updateLibraryIndex(data => {
    if (data.tombstones.some(t => t.scopeKey === board.scopeKey)) throw new Error("画布已移入回收站。");
    let entry = data.boards.find(b => b.id === id);
    if (!entry) { entry = { ...board }; data.boards.push(entry); }
    if (displayTitle !== undefined) entry.displayTitle = displayTitle.trim();
    if (projectName !== undefined) entry.projectOverride = projectName.trim();
    if (importance !== undefined) entry.importance = importance;
  });
  return { id };
}

export function validateProjectName(value) {
  if (typeof value !== "string" || !meaningfulTitle(value) || value.trim().length > 120) {
    throw new Error("请输入 1 至 120 个字符的项目名称。");
  }
}

export async function setProjectHidden(root, hidden) {
  if (typeof root !== "string" || !root || root.length > 4000 || typeof hidden !== "boolean") throw new Error("项目参数无效。");
  if (path.isAbsolute(root)) root = projectKeyForPath(root);
  await updateLibraryIndex(data => { data.hiddenProjects = data.hiddenProjects.filter(x => x !== root); if (hidden) data.hiddenProjects.push(root); });
  return { root, hidden };
}

export async function setBoardHidden(id, hidden) {
  if (typeof id !== "string" || !id || typeof hidden !== "boolean") throw new Error("画布参数无效。");
  await knownBoard(id);
  await updateLibraryIndex(data => { data.hiddenBoards = data.hiddenBoards.filter(x => x !== id); if (hidden) data.hiddenBoards.push(id); });
  return { id, hidden };
}
