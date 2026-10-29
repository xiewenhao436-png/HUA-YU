import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { createMcpClient } from "./mcp-app-client.mjs";
import { mountApp } from "./app-test-host.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-library-ui-"));
const artifactDir = path.resolve(process.env.CANVAS_TEST_ARTIFACT_DIR || "dist/test-ui");
await fs.mkdir(artifactDir, { recursive: true });
const env = { CODEX_CANVAS_LIBRARY_PATH: path.join(root, "library.json"), CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(root, "projects.json"), CODEX_CANVAS_THREADS_FILE: path.join(root, "threads.json") };
await fs.writeFile(env.CODEX_CANVAS_THREADS_FILE, JSON.stringify([{ id: "target-ui", title: "当前策划项目", cwd: path.join(root, "target") }, { id: "source-ui", title: "整理服务短视频参考", cwd: path.join(root, "source") }]));
await fs.mkdir(path.join(root, "target")); await fs.mkdir(path.join(root, "source"));
const client = createMcpClient(undefined, env);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined });
const call = (name, args) => client.request("tools/call", { name, arguments: args });
const library = async args => (await call("canvas_library", args)).structuredContent;
const fixture = new PNG({ width: 320, height: 180 });
for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) fixture.data.set([50 + x % 150, 95 + y % 120, 190, 255], (y * 320 + x) * 4);
const png = PNG.sync.write(fixture).toString("base64");
const summary = [];
try {
  await call("open_canvas", { projectDir: path.join(root, "source"), threadId: "source-ui" });
  for (let i = 1; i <= 7; i++) await call("add_image", { projectDir: path.join(root, "source"), threadId: "source-ui", dataUrl: `data:image/png;base64,${png}`, name: `SC0${i}.png`, imagegenPrompt: `分镜 ${i} 完整提示词` });
  const resource = (await client.request("resources/list")).resources[0];
  const html = (await client.request("resources/read", { uri: resource.uri })).contents[0].text;
  const source = (await library({ action: "list" })).boards.find(b => b.threadId === "source-ui");
  for (const width of [1100, 440]) {
    const page = await browser.newPage({ locale: "zh-CN", viewport: { width, height: 820 } });
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    const unbound = await call("open_canvas", { threadId: "target-ui" });
    const frame = await mountApp(page, client, { opened: unbound, html });
    if (width === 1100) {
      await frame.getByRole("button", { name: "新建画布", exact: true }).click();
      await frame.waitForSelector(".library-thread-select");
      await frame.locator(".library-thread-select").selectOption("target-ui");
      await frame.getByRole("button", { name: "创建画布", exact: true }).click();
    }
    await frame.waitForSelector("#canvasImportButton");
    await frame.waitForFunction(() => document.querySelector("#canvasConnection").style.display === "none");
    await frame.locator("#canvasImportButton").click();
    await frame.locator(`[data-source-board="${source.id}"]`).click();
    await frame.waitForFunction(() => document.querySelectorAll(".library-image-card").length === 7);
    await frame.waitForFunction(() => [...document.querySelectorAll(".library-image-card img")].every(img => img.naturalWidth === 320));
    await frame.locator(".library-image-card input").nth(0).check();
    await frame.locator(".library-image-card input").nth(2).check();
    await page.screenshot({ path: path.join(artifactDir, `library-picker-${width}.png`) });
    await frame.locator('[data-library="import-selected"]').click();
    await frame.waitForFunction(() => document.querySelector("#canvasLibrary .library-status").textContent.startsWith("已导入 2 张"));
    await frame.locator('[data-library="close"]').click();
    const countBefore = width === 1100 ? 0 : 7;
    assert.equal(await frame.locator("#objects .canvas-object").count(), countBefore + 2);
    const group = frame.locator(".canvas-import-frame").last();
    assert.match(await group.textContent(), /整理服务短视频参考 · 2 张/);
    const groupBefore = await group.getAttribute("style");
    const label = group.locator("button");
    const labelBox = await label.boundingBox();
    await page.mouse.move(labelBox.x + 20, labelBox.y + labelBox.height / 2); await page.mouse.down();
    await page.mouse.move(labelBox.x + 60, labelBox.y + labelBox.height / 2 + 25, { steps: 4 }); await page.mouse.up();
    assert.notEqual(await group.getAttribute("style"), groupBefore, "Source frame follows a whole-group drag");
    await frame.waitForFunction(() => !document.querySelector('[data-history-action="undo"]').disabled);
    await frame.locator("#board").press("Control+z"); // undo movement
    await frame.waitForFunction(style => document.querySelector(".canvas-import-frame:last-of-type")?.getAttribute("style") === style || [...document.querySelectorAll(".canvas-import-frame")].at(-1)?.getAttribute("style") === style, groupBefore);
    await frame.waitForFunction(() => !document.querySelector('[data-history-action="undo"]').disabled);
    await frame.locator("#board").press("Control+z"); // undo import
    await frame.waitForFunction(count => document.querySelectorAll("#objects .canvas-object").length === count, countBefore);
    assert.equal(await frame.locator(".canvas-import-frame").count(), width === 1100 ? 0 : 1);
    await frame.locator("#board").press("Control+Shift+z");
    await frame.waitForFunction(count => document.querySelectorAll("#objects .canvas-object").length === count, countBefore + 2);
    // Remove the selected import again, then import the whole source in one operation.
    await frame.locator("#board").press("Control+z");
    await frame.waitForFunction(count => document.querySelectorAll("#objects .canvas-object").length === count, countBefore);
    await frame.locator("#canvasImportButton").click();
    await frame.locator(`[data-source-board="${source.id}"]`).click();
    await frame.waitForFunction(() => document.querySelectorAll(".library-image-card").length === 7);
    await frame.locator('[data-library="import-all"]').click();
    await frame.waitForFunction(() => document.querySelector("#canvasLibrary .library-status").textContent.startsWith("已导入 7 张"));
    await frame.locator('[data-library="close"]').click();
    await frame.waitForFunction(count => document.querySelectorAll("#objects .canvas-object").length === count, countBefore + 7);
    await frame.waitForFunction(() => [...document.querySelectorAll("#objects img")].every(img => img.naturalWidth === 320));
    await page.screenshot({ path: path.join(artifactDir, `library-imported-${width}.png`) });
    await frame.evaluate(() => window.codexCanvasApp.fetch("/api/app-assets/missing-for-test").catch(() => {}));
    assert.equal(await frame.locator("#canvasConnection").evaluate(node => node.style.display), "none", "A missing image must not replace the editor with a reconnect overlay");
    // Persisted host results must never replace a working transport session.
    const target = (await library({ action: "list" })).boards.find(b => b.threadId === "target-ui");
    const valid = await call("canvas_library", { action: "open", boardId: target.id, threadId: "target-ui" });
    const expired = { ...valid, _meta: { ...valid._meta, canvasSession: { ...valid._meta.canvasSession, sessionId: "expired-for-test" } } };
    await page.evaluate(opened => document.querySelector("iframe").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: opened }, "*"), expired);
    await frame.evaluate(() => window.codexCanvasApp.fetch("/api/state"));
    assert.equal(await frame.evaluate(() => window.codexCanvasApp.scope.sessionId), valid._meta.canvasSession.sessionId);
    await frame.waitForFunction(() => document.querySelector("#canvasConnection").style.display === "none");
    await frame.waitForFunction(count => document.querySelectorAll("#objects .canvas-object").length === count, countBefore + 7);
    assert.equal(await page.evaluate(() => window.chatMessages.length), 0, "Launcher and importer must never send a chat turn");
    assert.deepEqual(errors, []);
    summary.push({ width, launcherWithoutChat: true, selectedImport: true, fullImport: true, sourceFrame: true, groupDrag: true, undoRedo: true, reconnectWithoutChat: true, reopenFromDisk: width === 440, errors });
    await page.close();
  }
  console.log(JSON.stringify(summary, null, 2));
} finally { await browser.close(); await client.close(); await fs.rm(root, { recursive: true, force: true }); }
