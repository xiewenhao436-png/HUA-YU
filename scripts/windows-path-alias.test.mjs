import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addImage, readState, writeState, updateProjectMeta } from "../src/store.mjs";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("Windows normal and extended-length paths preserve image references across reads and writes", { skip: process.platform !== "win32" }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-path-alias-"));
  const canvasId = "path-alias-board";
  const previousLibrary = process.env.CODEX_CANVAS_LIBRARY_PATH;
  process.env.CODEX_CANVAS_LIBRARY_PATH = path.join(projectDir, "test-library.json");
  try {
    const image = await addImage(projectDir, { dataUrl: `data:image/png;base64,${png}`, name: "Persistent image" }, { canvasId });
    const extended = path.toNamespacedPath(projectDir);
    let state = await readState(extended, { canvasId, readOnly: true });
    assert.equal(state.objects[0].src, image.src, "Opening through an equivalent Windows path must keep the image URL");
    assert.ok(state.objects[0].assetPath);
    await updateProjectMeta(extended, { title: "Saved from another chat" }, { canvasId });
    state = await readState(projectDir, { canvasId, readOnly: true });
    assert.equal(state.objects[0].src, image.src, "Saving through an alias must never blank persisted image fields");
    state.objects[0].assetPath = path.toNamespacedPath(state.objects[0].assetPath);
    await writeState(projectDir, state, { canvasId });
    assert.equal((await readState(extended, { canvasId, readOnly: true })).objects[0].src, image.src);
    // Keep the scope boundary: genuinely outside paths still get rejected.
    state.objects[0].assetPath = path.join(projectDir, "outside-current-board.png");
    await writeState(extended, state, { canvasId });
    const rejected = (await readState(projectDir, { canvasId, readOnly: true })).objects[0];
    assert.equal(rejected.assetPath, null);
    assert.equal(rejected.src, "");
  } finally {
    if (previousLibrary === undefined) delete process.env.CODEX_CANVAS_LIBRARY_PATH;
    else process.env.CODEX_CANVAS_LIBRARY_PATH = previousLibrary;
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});
