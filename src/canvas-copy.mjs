import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { knownBoard, listCanvases, recordCanvas, normalizePhysicalPath } from "./canvas-index.mjs";
import { canvasDataDirFor } from "./paths.mjs";
import { withCanvasWriteLock } from "./canvas-write-lock.mjs";

// Copies only the board state and its private asset tree. Jobs and runtime files
// are not portable: they refer to the original session and running processes.
export async function copyBoardToProject(boardId, targetProject) {
  const source = await knownBoard(boardId);
  const library = await listCanvases();
  const target = library.boards.find(b => b.projectDir === targetProject)?.projectDir;
  if (!target) throw new Error("目标项目不在画布列表中，请刷新后重试。");
  const realTarget = await fs.realpath(target);
  if (normalizePhysicalPath(realTarget) !== normalizePhysicalPath(target)) throw new Error("目标项目包含目录跳转，无法安全复制。");
  const id = `copy-${crypto.randomUUID()}`;
  const dest = canvasDataDirFor(target, id);
  return withCanvasWriteLock(source.projectDir, async () => {
    await knownBoard(boardId);
    const sourceDir = canvasDataDirFor(source.projectDir, source.canvasId);
    const checked = async file => {
      const st = await fs.lstat(file);
      if (st.isSymbolicLink() || normalizePhysicalPath(await fs.realpath(file)) !== normalizePhysicalPath(file)) throw new Error("画布包含链接或目录跳转，无法安全复制。");
      return st;
    };
    async function copyTree(from, to) {
      const st = await checked(from);
      if (st.isDirectory()) { await fs.mkdir(to); for (const name of await fs.readdir(from)) await copyTree(path.join(from, name), path.join(to, name)); }
      else if (st.isFile()) await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      else throw new Error("画布包含特殊文件，无法安全复制。");
    }
    await checked(sourceDir);
    await checked(path.join(sourceDir, "codex-canvas.json"));
    const state = JSON.parse(await fs.readFile(path.join(sourceDir, "codex-canvas.json"), "utf8"));
    if (!Array.isArray(state.objects)) throw new Error("画布数据无法识别。");
    if (source.displayTitle) state.title = source.displayTitle;
    const threads = path.dirname(dest);
    await fs.mkdir(threads, { recursive: true });
    if (normalizePhysicalPath(await fs.realpath(threads)) !== normalizePhysicalPath(threads)) throw new Error("目标画布目录包含目录跳转。");
    const staging = path.join(path.dirname(threads), `.copy-staging-${crypto.randomUUID()}`);
    await fs.mkdir(staging);
    let registered = false;
    try {
      const sourceAssets = path.join(sourceDir, "assets");
      const destAssets = path.join(dest, "assets");
      for (const object of state.objects) {
        if (!object || typeof object.assetPath !== "string" || !object.assetPath) continue;
        const relative = path.relative(sourceAssets, object.assetPath);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("画布包含不在素材目录内的本地文件，无法安全复制。");
        object.assetPath = path.join(destAssets, relative);
      }
      await fs.writeFile(path.join(staging, "codex-canvas.json"), JSON.stringify(state, null, 2), { flag: "wx" });
      const assets = path.join(sourceDir, "assets");
      if (await fs.lstat(assets).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) await copyTree(assets, path.join(staging, "assets"));
      await fs.rename(staging, dest);
      const newId = await recordCanvas({ projectDir: target, canvasId: id, title: source.title });
      registered = true;
      return { ok: true, boardId: newId };
    } finally { if (!registered) { await fs.rm(staging, { recursive: true, force: true }); await fs.rm(dest, { recursive: true, force: true }); } }
  });
}
