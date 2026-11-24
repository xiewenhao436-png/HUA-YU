import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { readChatReferenceImages, resolveChatReferenceImages } from "../src/codex-chat.mjs";

test("chat attachment extraction recognizes only the requested message and preserves requested order", async () => {
  const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "huayu-chat-reference-test-"));
  const localFile = path.join(directory, "image.png");
  try {
    await fs.writeFile(localFile, png);
    const selected = {
      type: "userMessage",
      content: [
        { type: "text", text: "use " },
        { type: "localImage", path: localFile },
        { type: "text", text: "these" },
        { type: "image", url: dataUrl },
        { type: "image", fileId: "file-demo" },
        { type: "image", url: "https://example.invalid/image.png" },
        { type: "image", url: "data:image/png;base64,dGV4dA==" },
        { type: "localImage", path: "relative.png" }
      ]
    };
    const other = { type: "userMessage", content: [{ type: "text", text: "older" }, { type: "image", url: dataUrl }] };
    const options = { userMessageText: "use these", indexes: [2, 1, 2] };
    assert.deepEqual(await resolveChatReferenceImages([other, selected], options), [
      { dataUrl }, { path: localFile }, { dataUrl }
    ]);
    for (const index of [3, 4, 5, 6]) {
      await assert.rejects(resolveChatReferenceImages([selected], { indexes: [index] }), { statusCode: 422 });
    }
    await assert.rejects(resolveChatReferenceImages([selected], { indexes: [7] }), { statusCode: 404 });
    await assert.rejects(resolveChatReferenceImages([other], options), { statusCode: 404 });
    await assert.rejects(resolveChatReferenceImages([selected, selected], options), { statusCode: 404 });
    await assert.rejects(readChatReferenceImages("bound", { indexes: [1] }), { statusCode: 400 });
    await assert.rejects(readChatReferenceImages("", options), { statusCode: 409 });
  } finally {
    await fs.rm(localFile, { force: true });
    await fs.rmdir(directory);
  }
});
