import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createMcpClient } from "./mcp-app-client.mjs";
import { addImage, readState, transformState, updateObject } from "../src/store.mjs";
import { automaticImagePlacement } from "../src/canvas-image-layout.mjs";
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
    const args = { action: "import", sourceBoardId: sourceBoard.id, groupId: "import_test_group", sessionId: target._meta.canvasSession.sessionId, objectIds: imageIds.slice(0, 20), importedAt: "2026-10-21T00:00:00Z" };
    const first = await library(args);
    assert.equal(first.objects.length, 20); assert.equal(first.errors.length, 0);
    assert.equal(first.objects[4].y, first.objects[0].y);
    assert.ok(first.objects[4].x > first.objects[0].x);
    assert.equal(first.objects[5].x, first.objects[0].x);
    assert.ok(first.objects[5].y > first.objects[0].y);
    assert.equal((await library(args)).objects.length, 0, "Retry must not copy the chunk twice");
    let lastOfFirstBlock;
    let firstOfSecondBlock;
    for (let offset = 20; offset < 1000; offset += 20) {
      const result = await library({ ...args, offset, objectIds: imageIds.slice(offset, offset + 20) });
      if (offset === 80) lastOfFirstBlock = result.objects.at(-1);
      if (offset === 100) firstOfSecondBlock = result.objects[0];
    }
    assert.equal(lastOfFirstBlock.autoImageGroup.blockId, first.objects[0].autoImageGroup.blockId);
    assert.equal(lastOfFirstBlock.autoImageGroup.slot, 99);
    assert.notEqual(firstOfSecondBlock.autoImageGroup.blockId, first.objects[0].autoImageGroup.blockId);
    assert.equal(firstOfSecondBlock.y, first.objects[0].y);
    assert.ok(firstOfSecondBlock.x > lastOfFirstBlock.x + lastOfFirstBlock.width);
    const imported = await library({ action: "import-status", sessionId: target._meta.canvasSession.sessionId, groupId: args.groupId });
    assert.equal(imported.entries.length, 1000);
    assert.equal(new Set(imported.entries.map(({ object }) => object.autoImageGroup.panelId)).size, 10);
    assert.equal(new Set(imported.entries.map(({ object }) => `${object.x},${object.y}`)).size, 1000);
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
    const targetOptions = { canvasId: canvasIdForThread("target-thread") };
    const far = await addImage(targetDir, {
      dataUrl: `data:image/png;base64,${png}`, autoPosition: { x: 2_000_000, y: 120 }
    }, targetOptions);
    const dragged = await updateObject(targetDir, far.id, { x: 2_010_000 }, targetOptions);
    assert.equal(dragged.x, 2_010_000);
    assert.equal((await readState(targetDir, targetOptions)).objects.find(item => item.id === far.id).x, 2_010_000);
    const queued = await addImage(targetDir, {
      dataUrl: `data:image/png;base64,${png}`, layoutMode: "draft-grid", batchId: "片头", x: -150, y: -175
    }, targetOptions);
    assert.ok(queued.x > dragged.x);
    assert.equal(queued.y, dragged.y);
    assert.equal(queued.autoImageGroup.blockId, dragged.autoImageGroup.blockId);
    assert.equal(queued.autoImageGroup.title, "片头");
    assert.notEqual(queued.x, -150);
    const derived = await addImage(targetDir, {
      dataUrl: `data:image/png;base64,${png}`, layoutMode: "draft-grid", sourceObjectId: queued.id, x: -150, y: -175
    }, targetOptions);
    assert.equal(derived.autoImageGroup, undefined);
    assert.equal(derived.x, -150);
    assert.equal(derived.y, -175);
    await fs.unlink(original.assetPath);
    assert.equal((await fs.readFile(imported.entries[0].object.assetPath)).toString("base64"), png, "Imported copy survives removal of the source asset");
    console.log("1000 images copied; source untouched; provenance, idempotency, restart recovery and independent originals verified.");
  } finally {
    await client.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Automatic placement respects occupied areas and continues a moved panel", () => {
  const obstacle = { x: 100, y: 100, width: 230, height: 360 };
  const image = { width: 1200, height: 600, batchId: "collection" };
  const first = automaticImagePlacement(image, { autoGroupTitle: "上传图片" }, [obstacle]);
  assert.ok(first.x > obstacle.x + obstacle.width);
  assert.equal(first.width, 320);
  assert.equal(first.height, 160);
  const moved = { ...first, x: first.x + 100, y: first.y + 50 };
  const second = automaticImagePlacement(image, {}, [obstacle, moved]);
  assert.equal(second.autoImageGroup.panelId, first.autoImageGroup.panelId);
  assert.ok(second.x > moved.x + moved.width);
  assert.equal(second.y, moved.y);
  const other = automaticImagePlacement({ ...image, batchId: "another-collection" }, {}, [obstacle, moved, second]);
  assert.ok(other.x > second.x + second.width);
  assert.equal(other.y, second.y);
  assert.equal(other.autoImageGroup.blockId, second.autoImageGroup.blockId);
  assert.notEqual(other.autoImageGroup.key, second.autoImageGroup.key);
  const legacy = { ...moved, x: 120, autoImageGroup: { panelId: "legacy-grid", slot: 0, columnId: "legacy-column", columnOffsetY: 0 } };
  const firstNew = automaticImagePlacement(image, {}, [legacy]);
  assert.equal(firstNew.autoImageGroup.slot, 0);
  assert.notEqual(firstNew.autoImageGroup.panelId, legacy.autoImageGroup.panelId);
  assert.ok(firstNew.x > legacy.x + legacy.width);
  const far = automaticImagePlacement({ ...image, imagegenPrompt: "Draw" }, { autoPosition: { x: 2_000_000, y: 120 } }, []);
  assert.equal(far.x, 2_000_000);
  assert.equal(far.autoImageGroup.title, "生成图片");
});

test("Small batches share a block of five images per row across 20 rows", () => {
  const images = [];
  for (let index = 0; index < 101; index++) {
    images.push(automaticImagePlacement({
      width: 200, height: index === 3 ? 120 : 60, batchId: `batch-${Math.floor(index / 3)}`
    }, {}, images));
  }
  assert.ok(images.slice(0, 5).every(image => image.y === images[0].y));
  assert.ok(images[1].x > images[0].x);
  assert.equal(images[5].x, images[0].x);
  assert.equal(images[5].y - images[0].y, 170);
  assert.notEqual(images[3].autoImageGroup.key, images[2].autoImageGroup.key);
  assert.ok(images.slice(0, 100).every(image => image.autoImageGroup.blockId === images[0].autoImageGroup.blockId));
  assert.ok(images[100].x > images[99].x);
  assert.equal(images[100].y, images[0].y);
  const obstacle = { type: "text", x: images[1].x, y: images[1].y, width: 320, height: 80 };
  const next = automaticImagePlacement({ width: 200, height: 60, batchId: "batch-0" }, {}, [images[0], obstacle]);
  assert.ok(next.x > obstacle.x + obstacle.width);
  assert.equal(next.autoImageGroup.slot, 0);
});
