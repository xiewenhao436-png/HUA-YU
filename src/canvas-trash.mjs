import fs from "node:fs/promises";
import path from "node:path";
import { assertBoardAvailable, boardScopeKey, knownBoard, normalizePhysicalPath, updateLibraryIndex, readLibraryIndex, libraryPath } from "./canvas-index.mjs";
import { canvasDataDirFor, statePathFor } from "./paths.mjs";
import { activeOperationLeases } from "./operation-leases.mjs";
import { hasActiveCanvasJobs } from "./jobs.mjs";
import { withCanvasWriteLock } from "./canvas-write-lock.mjs";

const listeners = new Set();
export function onBoardTrashed(listener) { listeners.add(listener); return () => listeners.delete(listener); }
async function notify(board) { for (const listener of listeners) await Promise.resolve().then(() => listener(board)).catch(() => {}); }
const clientError = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

export async function trashBoard(boardId) {
  const board = await knownBoard(boardId);
  return withCanvasWriteLock(board.projectDir, () => trashBoardLocked(board));
}
async function trashBoardLocked(board) {
  const scopeKey = await boardScopeKey(board.projectDir, board.canvasId);
  const trashedAt = new Date().toISOString();
  await updateLibraryIndex(async data => {
    if (data.tombstones.some(t => t.scopeKey === scopeKey)) throw clientError("画布已经在回收站中。");
    data.tombstones.push({ id: board.id, scopeKey, projectDir: board.projectDir, canvasId: board.canvasId || null, trashedAt, board });
    const removed = new Set([board.id]);
    for (const candidate of data.boards) if (await boardScopeKey(candidate.projectDir, candidate.canvasId) === scopeKey) removed.add(candidate.id);
    data.boards = data.boards.filter(b => !removed.has(b.id));
    for (const [thread, id] of Object.entries(data.lastByThread)) if (removed.has(id)) delete data.lastByThread[thread];
  });
  await notify(board);
  return { ok: true, boardId: board.id, trashedAt };
}

export async function restoreBoard(boardId) {
  const { tombstones } = await readLibraryIndex();
  const tombstone = tombstones.find(t => t.id === boardId && !t.purgedAt);
  if (!tombstone) throw clientError("回收站中没有这个画布。", 404);
  return withCanvasWriteLock(tombstone.projectDir, () => restoreBoardLocked(boardId));
}
async function restoreBoardLocked(boardId) {
  let board;
  await updateLibraryIndex(async data => {
    const tombstone = data.tombstones.find(t => t.id === boardId && !t.purgedAt);
    if (!tombstone) throw clientError("回收站中没有这个画布。", 404);
    if (tombstone.purgeStartedAt) throw clientError("这个画布已开始彻底删除，不能恢复，请重试彻底删除以完成清理。");
    board = tombstone.board;
    if (await boardScopeKey(board.projectDir, board.canvasId) !== tombstone.scopeKey) throw clientError("画布目录已变化，无法安全恢复。");
    const state = JSON.parse(await fs.readFile(statePathFor(board.projectDir, board.canvasId), "utf8").catch(() => { throw clientError("画布文件已移动或缺失，无法恢复。", 404); }));
    if (!Array.isArray(state.objects)) throw clientError("画布文件无法识别，无法恢复。");
    data.tombstones = data.tombstones.filter(t => t !== tombstone);
    data.boards = [...data.boards.filter(b => b.id !== board.id), board];
  });
  return { ok: true, boardId: board.id, board };
}

async function assertNoWork(board) {
  const scopeKey = await boardScopeKey(board.projectDir, board.canvasId);
  if (hasActiveCanvasJobs({ projectDir: board.projectDir, canvasId: board.canvasId || null })) throw clientError("这个画布仍有任务进行中，请完成后再彻底删除。");
  for (const lease of await activeOperationLeases()) {
    const projectMatches = lease.projectDir && await boardScopeKey(lease.projectDir, null) === await boardScopeKey(board.projectDir, null);
    if (!lease.projectDir || (!Object.hasOwn(lease, "canvasId") && projectMatches) || await boardScopeKey(lease.projectDir, lease.canvasId || null) === scopeKey) throw clientError("这个画布仍有操作进行中，请完成后再彻底删除。");
  }
  try { await fs.lstat(`${statePathFor(board.projectDir, board.canvasId)}.lock`); throw clientError("画布正在保存，请稍后再彻底删除。"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Persisted placeholders can outlive a crashed process. Live jobs and their
  // cross-process leases are authoritative; a stale 'running' label alone must
  // never make a recycle-bin entry impossible to clean up.
}

// Never delete projectDir or the shared canvas/threads root. Build an exact
// manifest first, reject all links/reparse targets, then unlink individual
// validated files. Default-board deletion excludes every sibling thread and
// the shared runtime/migration metadata.
async function deletionManifest(board, scopeKey, journal = null) {
  if (!path.isAbsolute(board.projectDir || "") || [".", ".."].includes(board.canvasId)) throw clientError("画布目录不安全，已取消彻底删除。", 400);
  const project = await fs.realpath(board.projectDir);
  const root = canvasDataDirFor(project, board.canvasId);
  if (normalizePhysicalPath(root) !== scopeKey || root === project || path.basename(root) === "threads") throw clientError("画布目录范围不匹配，已取消彻底删除。", 400);
  const expectedParent = board.canvasId ? path.join(project, "canvas", "threads") : project;
  if (path.dirname(root) !== expectedParent || (!board.canvasId && path.basename(root) !== "canvas")) throw clientError("画布目录范围不匹配。", 400);
  async function validate(file, allowMissing = false) {
    if (typeof file !== "string" || !path.isAbsolute(file)) throw clientError("删除清单路径无效。", 400);
    const inside = path.relative(root, file);
    if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside) || (!board.canvasId && !["codex-canvas.json", "assets", "jobs"].includes(inside.split(path.sep)[0]))) throw clientError("删除清单超出画布范围。", 400);
    const relative = path.relative(project, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw clientError("删除范围超出画布目录。", 400);
    let current = project;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(error => { if (allowMissing && error.code === "ENOENT") return null; throw error; });
      if (!stat) return false;
      if (stat.isSymbolicLink() || normalizePhysicalPath(await fs.realpath(current)) !== normalizePhysicalPath(current)) throw clientError("画布包含链接或目录跳转，已取消彻底删除。", 400);
    }
    return true;
  }
  // Default root itself is shared with sibling threads; validate its ancestry
  // without treating the shared directory as a deletion target.
  if (board.canvasId) await validate(root, Boolean(journal));
  else {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || normalizePhysicalPath(await fs.realpath(root)) !== normalizePhysicalPath(root)) throw clientError("画布包含链接或目录跳转。", 400);
  }
  if (journal) {
    if (journal.scopeKey !== scopeKey || !Array.isArray(journal.files) || !Array.isArray(journal.dirs) || journal.files.length + journal.dirs.length > 200000) throw clientError("删除恢复清单无效，已停止清理。", 400);
    for (const file of [...journal.files, ...journal.dirs]) await validate(file, true);
    return { files: journal.files, dirs: journal.dirs, validate };
  }
  await validate(statePathFor(project, board.canvasId));
  const state = JSON.parse(await fs.readFile(statePathFor(project, board.canvasId), "utf8"));
  if (!Array.isArray(state.objects)) throw clientError("无法识别画布数据，已取消彻底删除。", 400);
  const files = [], dirs = [];
  let count = 0;
  async function visit(file) {
    if (++count > 200000) throw clientError("画布文件过多，请先分批整理后再删除。");
    await validate(file);
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(file)) await visit(path.join(file, entry));
      dirs.push(file);
    } else if (stat.isFile()) files.push(file);
    else throw clientError("画布包含特殊文件，已取消彻底删除。", 400);
  }
  if (board.canvasId) await visit(root);
  else for (const name of ["codex-canvas.json", "assets", "jobs"]) {
    const file = path.join(root, name);
    try { await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    await visit(file);
  }
  return { files, dirs, validate };
}

export async function permanentlyDeleteBoard(boardId, { confirmed = false } = {}) {
  if (confirmed !== true) throw clientError("彻底删除前需要明确确认。", 400);
  const { tombstones } = await readLibraryIndex();
  const tombstone = tombstones.find(t => t.id === boardId && !t.purgedAt);
  if (!tombstone) throw clientError("只能彻底删除回收站中的画布。", 400);
  return withCanvasWriteLock(tombstone.projectDir, () => permanentlyDeleteBoardLocked(boardId));
}
async function permanentlyDeleteBoardLocked(boardId) {
  const tombstone = (await readLibraryIndex()).tombstones.find(t => t.id === boardId && !t.purgedAt);
  if (!tombstone) throw clientError("只能彻底删除回收站中的画布。", 400);
  const board = tombstone.board;
  if (!/^[a-f0-9]{24}$/.test(boardId)) throw clientError("画布编号无效。", 400);
  const journalFile = path.join(path.dirname(libraryPath()), ".canvas-trash-journals", `${boardId}.json`);
  const journal = tombstone.purgeStartedAt ? JSON.parse(await fs.readFile(journalFile, "utf8")) : null;
  await assertNoWork(board);
  const manifest = await deletionManifest(board, tombstone.scopeKey, journal);
  if (!journal) {
    await fs.mkdir(path.dirname(journalFile), { recursive: true });
    const temp = `${journalFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ scopeKey: tombstone.scopeKey, files: manifest.files, dirs: manifest.dirs }));
    await fs.rename(temp, journalFile);
    // Persist the irreversible stage before unlinking any asset. If Windows
    // refuses one file, restoration cannot silently return a damaged board;
    // the next confirmed deletion resumes this exact, bounded manifest.
    await updateLibraryIndex(data => {
      const current = data.tombstones.find(t => t.id === boardId && !t.purgedAt);
      if (!current) throw clientError("回收站记录已变化，已停止删除。");
      current.purgeStartedAt = new Date().toISOString();
    });
  }
  await assertNoWork(board);
  for (const file of manifest.files) if (await manifest.validate(file, true)) await fs.unlink(file);
  for (const dir of manifest.dirs) if (await manifest.validate(dir, true)) await fs.rmdir(dir);
  await updateLibraryIndex(data => {
    const current = data.tombstones.find(t => t.id === boardId);
    current.purgedAt = new Date().toISOString();
    current.board = { id: board.id, projectDir: board.projectDir, canvasId: board.canvasId || null };
  });
  await fs.unlink(journalFile).catch(() => {});
  await notify(board);
  return { ok: true, boardId, permanentlyDeleted: true };
}

export { assertBoardAvailable };
