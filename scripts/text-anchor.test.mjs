import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { addImage, addObject, deleteObject, readState, restoreObjects, updateObjects } from "../src/store.mjs";

test("text anchors persist, detach, and restore through existing history operations", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "huayu-text-anchor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previousLibrary = process.env.CODEX_CANVAS_LIBRARY_PATH;
  process.env.CODEX_CANVAS_LIBRARY_PATH = path.join(root, "library.json");
  t.after(() => {
    if (previousLibrary === undefined) delete process.env.CODEX_CANVAS_LIBRARY_PATH;
    else process.env.CODEX_CANVAS_LIBRARY_PATH = previousLibrary;
  });

  const bytes = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  const image = await addImage(root, { dataUrl: `data:image/png;base64,${bytes.toString("base64")}` });
  const text = await addObject(root, { type: "text", text: "Caption", anchorImageId: image.id });
  const free = await addObject(root, { type: "text", text: "Free" });
  const saved = async id => (await readState(root)).objects.find(object => object.id === id);
  assert.equal((await saved(text.id)).anchorImageId, image.id);
  assert.equal((await saved(free.id)).anchorImageId, undefined);

  await updateObjects(root, [
    { id: text.id, patch: { anchorImageId: null } },
    { id: image.id, patch: { anchorImageId: text.id } }
  ]);
  assert.equal((await saved(text.id)).anchorImageId, null);
  assert.equal((await saved(image.id)).anchorImageId, undefined);
  await updateObjects(root, [{ id: text.id, patch: { anchorImageId: image.id } }]);
  const snapshot = await saved(text.id);
  assert.equal(snapshot.anchorImageId, image.id);

  await deleteObject(root, image.id);
  assert.equal((await saved(text.id)).anchorImageId, image.id);
  await deleteObject(root, text.id);
  await restoreObjects(root, [snapshot, image]);
  assert.equal((await saved(text.id)).anchorImageId, image.id);
});
