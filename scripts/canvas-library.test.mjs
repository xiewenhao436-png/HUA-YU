import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createMcpClient } from "./mcp-app-client.mjs";
import { transformState } from "../src/store.mjs";
import { canvasIdForThread } from "../src/runtime.mjs";
import { statePathFor } from "../src/paths.mjs";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
test("Persistent launcher, local-only discovery, provenance copies, resumable batches and 1000-image import", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-library-test-"));
  const previous = {};
  const env = { CODEX_CANVAS_LIBRARY_PATH: path.join(root, "library.json"), CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(root, "projects.json"), CODEX_CANVAS_THREADS_FILE: path.join(root, "threads.json") };
  for (const [key, value] of Object.entries(env)) { previous[key] = process.env[key]; process.env[key] = value; }
  const sourceDir = path.join(root, "source"), targetDir = path.join(root, "target");
  await fs.mkdir(sourceDir); await fs.mkdir(targetDir);
  await fs.writeFile(env.CODEX_CANVAS_THREADS_FILE, JSON.stringify([{ id: "source-thread", title: "整理服务短视频参考", cwd: sourceDir }, { id: "target-thread", title: "当前创作会话", cwd: targetDir }]));
  let client = createMcpClient(undefined, env);
  let call = (name, args) => client.request("tools/call", { name, arguments: args });
  const library = async args => (await call("canvas_library", args)).structuredContent;
  try {
    const source = await call("open_canvas", { projectDir: sourceDir, threadId: "source-thread" });
    const target = await call("open_canvas", { projectDir: targetDir, threadId: "target-thread" });
    const original = (await call("add_image", { projectDir: sourceDir, threadId: "source-thread", dataUrl: `data:image/png;base64,${png}`, name: "SC01A.png", prompt: "summary", imagegenPrompt: "完整提示词\n保留换行" })).structuredContent;
    const imageIds = [];
    await transformState(sourceDir, { canvasId: canvasIdForThread("source-thread") }, state => {
      const objects = Array.from({ length: 1000 }, (_, index) => ({ ...state.objects[0], id: `source_image_${index}`, name: `shot-${String(index).padStart(4, "0")}.png`, x: index * 20, y: 180 }));
      imageIds.push(...objects.map(o => o.id));
      return { ...state, objects };
    });
    const before = createHash("sha256").update(await fs.readFile(statePathFor(sourceDir, canvasIdForThread("source-thread")))).digest("hex");
    const list = await library({ action: "list" });
    const sourceBoard = list.boards.find(b => b.threadId === "source-thread");
    assert.equal(sourceBoard.threadTitle, "整理服务短视频参考"); assert.equal(sourceBoard.imageCount, 1000);
    const bootstrap = await library({ action: "bootstrap", threadId: "target-thread" });
    assert.equal(bootstrap.suggestedBoardId, target._meta.canvasSession.boardId);
    assert.equal((await library({ action: "browse", boardId: sourceBoard.id })).images.length, 1000);
    const bytes = await library({ action: "asset", boardId: sourceBoard.id, objectId: imageIds[0] });
    assert.equal(bytes.base64, png);
    const args = { action: "import", sourceBoardId: sourceBoard.id, groupId: "import_test_group", sessionId: target._meta.canvasSession.sessionId, objectIds: imageIds.slice(0, 20), importedAt: "2026-10-21T00:00:00Z", x: 120, y: 160 };
    const first = await library(args);
    assert.equal(first.objects.length, 20); assert.equal(first.errors.length, 0);
    assert.equal((await library(args)).objects.length, 0, "Retry must not copy the chunk twice");
    for (let offset = 20; offset < 1000; offset += 20) await library({ ...args, offset, objectIds: imageIds.slice(offset, offset + 20) });
    const imported = await library({ action: "import-status", sessionId: target._meta.canvasSession.sessionId, groupId: args.groupId });
    assert.equal(imported.entries.length, 1000);
    for (const entry of imported.entries) {
      assert.ok(entry.object.assetPath.startsWith(targetDir));
      assert.notEqual(entry.object.assetPath, original.assetPath);
      assert.equal(entry.object.imagegenPrompt, "完整提示词\n保留换行");
      assert.equal(entry.object.importedFrom.threadTitle, "整理服务短视频参考");
    }
    assert.equal((await fs.readFile(imported.entries[0].object.assetPath)).toString("base64"), png);
    assert.equal(createHash("sha256").update(await fs.readFile(statePathFor(sourceDir, canvasIdForThread("source-thread")))).digest("hex"), before, "Source canvas is never modified by browsing/importing");
    await assert.rejects(library({ ...args, sessionId: source._meta.canvasSession.sessionId }), /其他会话/);
    await assert.rejects(library({ action: "asset", boardId: "../../secrets", objectId: imageIds[0] }));
    await client.close(); client = createMcpClient(undefined, env);
    call = (name, args) => client.request("tools/call", { name, arguments: args });
    assert.equal((await library({ action: "bootstrap", threadId: "target-thread" })).suggestedBoardId, target._meta.canvasSession.boardId);
    const reopened = await call("canvas_library", { action: "open", boardId: target._meta.canvasSession.boardId, threadId: "target-thread" });
    assert.equal((await library({ action: "import-status", sessionId: reopened._meta.canvasSession.sessionId, groupId: args.groupId })).entries.length, 1000);
    await fs.unlink(original.assetPath);
    assert.equal((await fs.readFile(imported.entries[0].object.assetPath)).toString("base64"), png, "Imported copy survives removal of the source asset");
    console.log("1000 images copied; source untouched; provenance, idempotency, restart recovery and independent originals verified.");
  } finally {
    await client.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  }
});
