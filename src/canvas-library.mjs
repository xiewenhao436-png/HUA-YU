import fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { knownBoard } from "./canvas-index.mjs";
import { assetsDirFor } from "./paths.mjs";
import { readState, addImagesBatch } from "./store.mjs";

// One capability vocabulary for both transports. The browser omits MCP-only
// opening/creation actions when advertising its subset.
export const CANVAS_LIBRARY_ACTIONS = Object.freeze(["app-update-status", "app-update-check", "app-update-run", "list", "bootstrap", "open", "create", "browse", "asset", "import", "import-status", "trash", "restore", "delete-permanently", "rename", "importance", "project-visibility", "board-visibility", "copy-board"]);

const maxAssetBytes = 32 * 1024 * 1024;
export async function browseBoard(boardId) {
  const board = await knownBoard(boardId);
  const state = await readState(board.projectDir, { canvasId: board.canvasId, readOnly: true });
  return { board, images: state.objects.filter(o => (o.type || "image") === "image" && o.src).map(o => ({
    id: o.id, name: o.name, width: o.width, height: o.height, naturalWidth: o.naturalWidth, naturalHeight: o.naturalHeight, crop: o.crop || null
  })) };
}
async function sourceImage(boardId, objectId) {
  const board = await knownBoard(boardId);
  const state = await readState(board.projectDir, { canvasId: board.canvasId, readOnly: true });
  const object = state.objects.find(o => o.id === objectId && (o.type || "image") === "image");
  if (!object?.src) throw new Error("来源图片不存在，可能已被移除。");
  return { board, object };
}
async function readOriginal(board, object) {
  if (object.src.startsWith("/assets/")) {
    const name = decodeURIComponent(object.src.slice("/assets/".length));
    if (path.basename(name) !== name || /[/\\]/.test(name)) throw new Error("Invalid image asset.");
    const file = path.join(assetsDirFor(board.projectDir, board.canvasId), name);
    const stat = await fs.stat(file);
    if (stat.size > maxAssetBytes) throw new Error("来源图片超过 32 MiB。");
    const bytes = await fs.readFile(file);
    return { bytes, file, mime: mimeFor(file) };
  }
  if (/^https?:\/\//i.test(object.src)) {
    const response = await fetch(object.src, { signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) throw new Error("来源远程图片暂时无法读取。");
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > maxAssetBytes) throw new Error("来源图片超过 32 MiB。"); chunks.push(chunk); }
    return { bytes: Buffer.concat(chunks), mime: response.headers.get("content-type").split(";")[0] };
  }
  throw new Error("来源图片格式不受支持。");
}
function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif" })[ext] || "image/png";
}
export async function libraryAsset(boardId, objectId, original = false) {
  const { board, object } = await sourceImage(boardId, objectId);
  let { bytes, mime } = await readOriginal(board, object);
  if (!original && mime === "image/png") {
    try {
      // Bound decoded pixel count before pngjs allocates the complete image.
      const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
      if (w * h <= 36_000_000) {
        const src = PNG.sync.read(bytes);
        if (src.width > 320 || src.height > 240) {
          const scale = Math.min(320 / src.width, 240 / src.height);
          const dest = new PNG({ width: Math.max(1, Math.round(src.width * scale)), height: Math.max(1, Math.round(src.height * scale)) });
          for (let y = 0; y < dest.height; y++) for (let x = 0; x < dest.width; x++) {
            const a = (Math.min(src.height - 1, Math.floor(y / scale)) * src.width + Math.min(src.width - 1, Math.floor(x / scale))) * 4;
            dest.data.set(src.data.subarray(a, a + 4), (y * dest.width + x) * 4);
          }
          bytes = PNG.sync.write(dest);
        }
      }
    } catch { /* A readable nonstandard PNG can still use the original. */ }
  }
  return { mime, base64: bytes.toString("base64") };
}
export async function importBoardImages({ sourceBoardId, objectIds, groupId, importedAt, offset = 0, x = 120, y = 160, columns = 4 }, target) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(groupId || "")) throw new Error("导入批次编号无效。");
  if (!Array.isArray(objectIds) || !objectIds.length || objectIds.length > 20 || objectIds.some(id => typeof id !== "string")) throw new Error("每次导入分段最多 20 张图片。");
  const source = await knownBoard(sourceBoardId);
  if (path.resolve(source.projectDir) === path.resolve(target.projectDir) && (source.canvasId || null) === (target.canvasId || null)) throw new Error("请选择其他会话的画布作为来源。");
  const state = await readState(source.projectDir, { canvasId: source.canvasId, readOnly: true });
  const selected = new Map(state.objects.filter(o => (o.type || "image") === "image").map(o => [o.id, o]));
  const inputs = [], errors = [];
  columns = Math.max(1, Math.min(8, Math.round(columns) || 4));
  x = Number.isFinite(x) ? Math.max(-900000, Math.min(900000, x)) : 120;
  y = Number.isFinite(y) ? Math.max(-900000, Math.min(900000, y)) : 160;
  offset = Math.max(0, Math.min(100000, Math.round(offset) || 0));
  for (const [index, id] of [...new Set(objectIds)].entries()) {
    try {
      const object = selected.get(id);
      if (!object) throw new Error("图片已被移除。");
      const asset = await readOriginal(source, object);
      const scale = Math.min(320 / (object.width || 320), 240 / (object.height || 240));
      inputs.push({ ...(asset.file ? { path: asset.file } : { dataUrl: `data:${asset.mime};base64,${asset.bytes.toString("base64")}` }),
        name: object.name, prompt: object.prompt, imagegenPrompt: object.imagegenPrompt, crop: object.crop,
        width: Math.round((object.width || 320) * scale), height: Math.round((object.height || 240) * scale),
        x: x + ((offset + index) % columns) * 356, y: y + Math.floor((offset + index) / columns) * 290,
        layoutMode: "manual", importGroupId: groupId, importedFrom: { boardId: source.id, objectId: id, threadId: source.threadId,
          threadTitle: source.threadTitle, boardTitle: source.title, importedAt: importedAt || new Date().toISOString() }
      });
    } catch (error) { errors.push({ id, message: error.message }); }
  }
  const objects = inputs.length ? await addImagesBatch(target.projectDir, inputs, { canvasId: target.canvasId }) : [];
  return { objects, errors, source: { boardId: source.id, title: source.threadTitle || source.title }, groupId };
}
