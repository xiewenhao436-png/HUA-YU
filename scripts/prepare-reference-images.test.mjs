import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { createMcpClient } from "./mcp-app-client.mjs";

test("Codex reference files reuse identical canvas assets and carry ordered lineage", async () => {
  const temporary = await fs.realpath(os.tmpdir());
  const projectDir = await fs.mkdtemp(path.join(temporary, "huayu-chat-references-"));
  const threadId = "reference-chat";
  const client = createMcpClient(undefined, {
    CODEX_CANVAS_LIBRARY_PATH: path.join(projectDir, "library.json"),
    CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(projectDir, "projects.json"),
    CODEX_CANVAS_DISABLE_THREAD_DISCOVERY: "1"
  });
  const scope = { projectDir, threadId };
  const call = async (name, args = {}) => client.request("tools/call", { name, arguments: { ...scope, ...args } });
  try {
    const a = path.join(projectDir, "base.png");
    const b = path.join(projectDir, "new-reference.png");
    const copy = path.join(projectDir, "renamed-copy.png");
    const output = path.join(projectDir, "created.png");
    await Promise.all([fs.writeFile(a, tile(20)), fs.writeFile(copy, tile(20)), fs.writeFile(b, tile(100)), fs.writeFile(output, tile(180))]);
    const base = (await call("add_image", { path: a })).structuredContent;
    const prepare = images => call("prepare_reference_images", { images });
    const state = async () => (await call("canvas_status")).structuredContent;

    await assert.rejects(prepare([{ path: b }, { objectId: "not-on-this-board" }]), /not a readable image/);
    assert.equal((await state()).objects, 1, "Validate the complete input before importing any files");
    const prepared = await prepare([{ path: copy }, { path: b }, { objectId: base.id }]);
    assert.ok(!prepared.isError, JSON.stringify(prepared.content));
    const [reused, added] = prepared.structuredContent.references;
    assert.equal(prepared.structuredContent.references.length, 2);
    assert.equal(reused.objectId, base.id);
    assert.equal(reused.imported, false);
    assert.equal(added.imported, true);
    assert.deepEqual(await fs.readFile(added.assetPath), await fs.readFile(b));
    assert.equal((await state()).objects, 2);

    const again = (await prepare([{ path: b }, { path: copy }])).structuredContent.references;
    assert.deepEqual(again.map(({ objectId, imported }) => [objectId, imported]), [[added.objectId, false], [base.id, false]]);
    const result = (await call("add_image", {
      path: output, sourceObjectId: reused.objectId, referenceObjectIds: [added.objectId]
    })).structuredContent;
    assert.equal(result.sourceObjectId, base.id);
    assert.deepEqual(result.referenceObjectIds, [added.objectId]);

    await fs.writeFile(a, tile(55));
    const changed = (await prepare([{ path: a }])).structuredContent.references[0];
    assert.equal(changed.imported, true);
    assert.notEqual(changed.objectId, base.id, "A new file under the same name must not link to the old asset");
    assert.equal((await state()).objects, 4);
  } finally {
    await client.close();
    assert.ok(path.resolve(projectDir).startsWith(temporary + path.sep));
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

function tile(red) {
  const image = new PNG({ width: 6, height: 6 });
  for (let offset = 0; offset < image.data.length; offset += 4) image.data.set([red, 0, 0, 255], offset);
  return PNG.sync.write(image);
}
