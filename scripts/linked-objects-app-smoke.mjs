import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { createMcpClient } from "./mcp-app-client.mjs";
import { mountApp } from "./app-test-host.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const temp = await fs.realpath(os.tmpdir());
const root = await fs.mkdtemp(path.join(temp, "huayu-linked-object-ui-"));
const client = createMcpClient(undefined, {
  CODEX_CANVAS_LIBRARY_PATH: path.join(root, "library.json"),
  CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(root, "projects.json"),
  CODEX_CANVAS_DISABLE_THREAD_DISCOVERY: "1"
});
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined });
const call = (name, args) => client.request("tools/call", { name, arguments: args });
const png = new PNG({ width: 320, height: 180 });
for (let offset = 0; offset < png.data.length; offset += 4) png.data.set([76, 112, 180, 255], offset);
const dataUrl = "data:image/png;base64," + PNG.sync.write(png).toString("base64");
const shortcut = process.platform === "darwin" ? "Meta" : "Control";

try {
  const resource = (await client.request("resources/list")).resources[0];
  const html = (await client.request("resources/read", { uri: resource.uri })).contents[0].text;
  for (const width of [1100, 440]) {
    const scope = { projectDir: path.join(root, `case-${width}`), threadId: `linked-${width}` };
    await fs.mkdir(scope.projectDir);
    const opened = await call("open_canvas", scope);
    const sessionId = opened._meta.canvasSession.sessionId;
    const api = async (path, method, body) => (await call("canvas_app_request", { sessionId, path, method, body })).structuredContent.body;
    const picture = (await call("add_image", { ...scope, dataUrl, name: "作品", autoGroupTitle: "分镜演示", width: 215, height: 121 })).structuredContent;
    const addNote = (text, x, y) => api("/api/objects", "POST", { type: "text", name: text, text, x, y, width: 130, height: 34, fontSize: 17 });
    const note = await addNote("跟随说明", picture.x, picture.y + 235);
    const free = await addNote("独立文字", picture.x + 210, picture.y + 235);

    const page = await browser.newPage({ viewport: { width, height: 790 }, locale: "zh-CN" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const frame = await mountApp(page, client, { html, opened });
    const element = id => frame.locator(`#objects [data-id="${id}"]`);
    const pictureContent = element(picture.id).locator(".image-content");
    const noteContent = element(note.id).locator(".text-content");
    await frame.waitForFunction(() => document.querySelector(".image-content img")?.naturalWidth === 320);
    await frame.locator('[data-minimap="fit"]').click();

    const backdrop = frame.locator(".canvas-auto-image-frame");
    const originalFrame = await backdrop.boundingBox();
    const originalCaption = await backdrop.locator(".canvas-import-caption").boundingBox();
    const originalImage = await pictureContent.boundingBox();
    const release = await dragPointer(page, await backdrop.locator("button").boundingBox());
    await frame.waitForFunction(({ id, x }) => document.querySelector(`[data-id="${id}"]`).getBoundingClientRect().left > x + 12, { id: picture.id, x: originalImage.x });
    assertSameOffset(originalImage, await pictureContent.boundingBox(), originalFrame, await backdrop.boundingBox());
    assertSameOffset(originalImage, await pictureContent.boundingBox(), originalCaption, await backdrop.locator(".canvas-import-caption").boundingBox());
    await release();
    await waitForSavedX(frame, picture.id, picture.x, false);
    await frame.locator("#board").press(`${shortcut}+z`);
    await waitForSavedX(frame, picture.id, picture.x, true);

    await pictureContent.click();
    await noteContent.click({ modifiers: ["Shift"] });
    await frame.locator('[data-action="bind-text"]').click();
    await waitForAnchor(frame, note.id, picture.id);
    await frame.getByText("跟随说明", { exact: true }).click();
    await frame.locator('[data-action="unbind-text"]').click();
    await waitForAnchor(frame, note.id, null);
    await frame.locator("#board").press(`${shortcut}+z`);
    await waitForAnchor(frame, note.id, picture.id);

    await frame.locator("#board").click({ position: { x: width - 24, y: 590 } });
    const tracked = [picture.id, note.id, free.id];
    const before = await positions(api, tracked);
    const releasePicture = await dragPointer(page, await pictureContent.boundingBox());
    await releasePicture();
    await waitForSavedX(frame, picture.id, before[0].x, false);
    const moved = await positions(api, tracked);
    const delta = [moved[0].x - before[0].x, moved[0].y - before[0].y];
    assert.ok(delta.every(offset => offset > 0));
    assert.deepEqual([moved[1].x - before[1].x, moved[1].y - before[1].y], delta);
    assert.deepEqual(moved[2], before[2]);
    await frame.locator("#board").press(`${shortcut}+z`);
    await waitForSavedX(frame, picture.id, before[0].x, true);
    assert.deepEqual(await positions(api, tracked), before);
    await frame.locator("#board").press(`${shortcut}+Shift+z`);
    await waitForSavedX(frame, picture.id, moved[0].x, true);
    assert.deepEqual(await positions(api, tracked), moved);
    assert.deepEqual(errors, []);
    console.log(`Verified live frame, caption, bound text, and undo/redo at ${width}px.`);
    await page.close();
  }
} finally {
  await browser.close();
  await client.close();
  assert.ok(path.resolve(root).startsWith(temp + path.sep));
  await fs.rm(root, { recursive: true, force: true });
}

async function waitForSavedX(frame, id, x, equals) {
  await frame.waitForFunction(async ({ id, x, equals }) => {
    const state = await (await window.codexCanvasApp.fetch("/api/state")).json();
    return (state.objects.find(object => object.id === id)?.x === x) === equals;
  }, { id, x, equals });
}

async function waitForAnchor(frame, id, imageId) {
  await frame.waitForFunction(async ({ id, imageId }) => {
    const state = await (await window.codexCanvasApp.fetch("/api/state")).json();
    return (state.objects.find(object => object.id === id)?.anchorImageId ?? null) === imageId;
  }, { id, imageId });
}

async function positions(api, ids) {
  const { objects } = await api("/api/state", "GET");
  return ids.map(id => {
    const { x, y } = objects.find(object => object.id === id);
    return { x, y };
  });
}

async function dragPointer(page, box) {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 31, y + 18, { steps: 4 });
  return () => page.mouse.up();
}

function assertSameOffset(fromA, toA, fromB, toB) {
  for (const axis of ["x", "y"]) {
    assert.ok(Math.abs((toA[axis] - fromA[axis]) - (toB[axis] - fromB[axis])) < 1);
  }
}
