import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { createMcpClient } from "./mcp-app-client.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-media-test-"));
const artifactDir = path.resolve(process.env.CANVAS_TEST_ARTIFACT_DIR || "dist/test-ui");
await fs.mkdir(artifactDir, { recursive: true });
const client = createMcpClient(undefined, { CODEX_CANVAS_LIBRARY_PATH: path.join(root, "test-library.json"), CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(root, "test-projects.json"), CODEX_CANVAS_DISABLE_THREAD_DISCOVERY: "1" });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined });
const call = (name, args) => client.request("tools/call", { name, arguments: args });
const fixture = new PNG({ width: 1000, height: 640 });
for (let y = 0; y < 640; y++) for (let x = 0; x < 1000; x++) {
  const i = (y * 1000 + x) * 4;
  fixture.data.set([35 + x % 170, 65 + y % 170, 180, x < 15 ? 0 : 255], i);
}
const bytes = PNG.sync.write(fixture);
const png = bytes.toString("base64");
const summary = [];
// Exercise the actual platform's shortcut modifier in headless Chromium. This
// checks event handling, not native clipboard permissions or trackpad behavior.
const shortcutModifier = process.platform === "darwin" ? "Meta" : "Control";
try {
  for (const width of [1100, 440]) {
    const projectDir = path.join(root, `case-${width}`);
    await fs.mkdir(projectDir);
    const threadId = `media-${width}`;
    const opened = await call("open_canvas", { projectDir, threadId });
    const request = async (route, method = "GET", body) => (await call("canvas_app_request", { sessionId: opened._meta.canvasSession.sessionId, path: route, method, body })).structuredContent;
    const getState = async () => (await request("/api/state")).body;
    const add = async (name, x, y, extra = {}) => (await call("add_image", { projectDir, threadId, dataUrl: `data:image/png;base64,${png}`, name, x, y, width: 180, height: 115, ...extra })).structuredContent;
    const a = await add("SC01A.png", 100, 160, { prompt: "short prompt", imagegenPrompt: "真实完整生成提示词\n保持透明背景与文字。" });
    const b = await add("SC01B.png", 350, 160);
    const c = await add("SC02A.png", 100, 420);
    const resource = (await client.request("resources/list")).resources[0];
    const html = (await client.request("resources/read", { uri: resource.uri })).contents[0].text;
    const page = await browser.newPage({ viewport: { width, height: 820 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let holdImport = false;
    let releaseImport;
    let noticeImport;
    let importGate;
    await page.exposeFunction("mcpRequest", async params => {
      if (holdImport && params.arguments?.method === "POST" && params.arguments?.path?.startsWith("/api/images")) {
        noticeImport();
        await importGate;
      }
      return client.request("tools/call", params);
    });
    // Secure test origin enables the real ClipboardItem implementation. Only
    // write/writeText are replaced: tests never touch the user's OS clipboard.
    await page.route("https://canvas.test/", route => route.fulfill({ contentType: "text/html", body: '<style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style><iframe sandbox="allow-scripts allow-same-origin allow-downloads" allow="clipboard-write"></iframe>' }));
    await page.goto("https://canvas.test/");
    await page.evaluate(({ html, opened }) => {
      window.downloads = [];
      window.addEventListener("message", async event => {
        const m = event.data;
        if (m?.jsonrpc !== "2.0") return;
        if (m.method === "ui/notifications/initialized") { event.source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: opened }, "*"); return; }
        if (m.id === undefined) return;
        try {
          let result = {};
          if (m.method === "ui/initialize") result = { protocolVersion: m.params.protocolVersion, hostInfo: { name: "Media test host", version: "1" }, hostCapabilities: { serverTools: {}, downloadFile: {}, message: {} }, hostContext: { displayMode: "fullscreen", availableDisplayModes: ["fullscreen"], theme: "light" } };
          else if (m.method === "tools/call") result = await window.mcpRequest(m.params);
          else if (m.method === "ui/download-file") window.downloads.push(m.params);
          event.source.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
        } catch (e) { event.source.postMessage({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: e.message } }, "*"); }
      });
      const clipboardHarness = `<script>window.testClipboard={images:[],texts:[],reject:false};Object.defineProperty(navigator,'clipboard',{value:{async write(items){if(testClipboard.reject)throw new DOMException('Denied','NotAllowedError');for(const item of items){const blob=await item.getType('image/png');const reader=new FileReader();const data=await new Promise((resolve,reject)=>{reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob)});testClipboard.images.push(data)}},async writeText(text){if(testClipboard.reject)throw new DOMException('Denied','NotAllowedError');testClipboard.texts.push(text)}}});</scr` + `ipt>`;
      document.querySelector("iframe").srcdoc = html.replace('<meta charset="utf-8" />', '<meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'">' + clipboardHarness);
    }, { html, opened });
    const frame = page.frames()[1];
    await frame.waitForFunction(() => [...document.querySelectorAll("#objects img")].length === 3 && [...document.querySelectorAll("#objects img")].every(img => img.naturalWidth === 1000));
    // Force Chinese without relying on an opaque origin's saved preferences.
    await frame.locator("#settingsButton").click();
    await frame.locator('[data-settings-row="language"]').click();
    await frame.locator('[data-language="zh"]').click();
    const imageA = frame.locator(`[data-id="${a.id}"] .image-content`);
    await frame.locator('.tool-dock [data-view-action="reset"]').click();
    if (width === 440) {
      // Frame the first image using the existing keyboard control on a narrow panel.
      await imageA.click();
      await frame.locator("#board").press("Enter");
    }
    const before = await frame.locator("#world").getAttribute("style");
    const coords = (await getState()).objects.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }));
    await imageA.dblclick();
    await frame.waitForFunction(() => document.querySelector("#imagePreview").open && document.querySelector("#previewImage").naturalWidth === 1000 && !document.querySelector("#previewImage").hidden);
    assert.match(await frame.locator("#previewInfo").textContent(), /镜头 SC01 · 1 \/ 2/);
    await frame.locator('[data-preview="actual"]').click();
    assert.equal(await frame.locator("#previewZoom").textContent(), "100%");
    const stage = await frame.locator("#previewStage").boundingBox();
    const transformBefore = await frame.locator("#previewImage").getAttribute("style");
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await page.mouse.down(); await page.mouse.move(stage.x + stage.width / 2 + 55, stage.y + stage.height / 2 + 32, { steps: 4 }); await page.mouse.up();
    assert.notEqual(await frame.locator("#previewImage").getAttribute("style"), transformBefore);
    await page.mouse.wheel(0, -120);
    await frame.waitForFunction(() => document.querySelector("#previewZoom").textContent !== "100%");
    await frame.locator('[data-preview="fit"]').click();
    await page.keyboard.press("ArrowRight");
    await frame.waitForFunction(() => document.querySelector("#previewTitle").textContent === "SC01B.png");
    assert.equal(await frame.locator('[data-preview="next"]').isDisabled(), true);
    await page.keyboard.press("ArrowLeft");
    await frame.waitForFunction(() => document.querySelector("#previewTitle").textContent === "SC01A.png");
    await frame.waitForFunction(() => !document.querySelector("#previewImage").hidden);
    await page.screenshot({ path: path.join(artifactDir, `media-preview-${width}.png`) });
    await frame.locator('[data-preview="close"]').click();
    assert.equal(await frame.locator("#world").getAttribute("style"), before, "Closing preview preserves the viewport");
    assert.deepEqual((await getState()).objects.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })), coords, "Preview must not change object geometry");
    await imageA.click({ button: "right" });
    await frame.locator('[data-media-action="copy"]').click();
    await frame.waitForFunction(() => testClipboard.images.length === 1);
    assert.equal(await frame.evaluate(() => testClipboard.images[0]), `data:image/png;base64,${png}`);
    await imageA.click({ button: "right" });
    await frame.locator('[data-media-action="prompt"]').click();
    assert.equal(await frame.evaluate(() => testClipboard.texts[0]), "真实完整生成提示词\n保持透明背景与文字。");
    await imageA.click({ button: "right" });
    await frame.locator('[data-media-action="save"]').click();
    await page.waitForFunction(() => window.downloads.length === 1);
    assert.equal((await page.evaluate(() => window.downloads[0])).contents[0].resource.blob, png);
    await frame.evaluate(() => { testClipboard.reject = true; });
    await imageA.click({ button: "right" });
    await frame.locator('[data-media-action="copy"]').click();
    await frame.waitForFunction(() => document.querySelector("#toast").textContent.includes("未允许复制图片"));
    assert.equal(await frame.evaluate(() => testClipboard.images.length), 1);
    await frame.evaluate(() => { testClipboard.reject = false; });
    const paste = async ({ text = "", files = [] }) => frame.evaluate(({ text, files, png }) => {
      document.querySelector("#board").focus();
      const data = new DataTransfer();
      if (text) data.setData("text/plain", text);
      for (const name of files) data.items.add(new File([Uint8Array.from(atob(png), ch => ch.charCodeAt(0))], name, { type: "image/png" }));
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
      document.querySelector("#board").dispatchEvent(event);
      return event.defaultPrevented;
    }, { text, files, png });
    assert.equal(await paste({ files: ["pasted.png"], text: "image wins over text" }), true);
    await frame.waitForFunction(() => document.querySelectorAll("#objects .canvas-object").length === 4);
    let saved = (await getState()).objects.find(o => o.name === "pasted.png");
    assert.ok(saved.assetPath.startsWith(projectDir));
    assert.equal((await fs.readFile(saved.assetPath)).toString("base64"), png, "Pasted original is saved byte-for-byte");
    await frame.locator("#board").press(`${shortcutModifier}+z`);
    await frame.waitForFunction(() => document.querySelectorAll("#objects .canvas-object").length === 3);
    await frame.locator("#board").press(`${shortcutModifier}+Shift+z`);
    await frame.waitForFunction(() => document.querySelectorAll("#objects .canvas-object").length === 4);
    assert.equal(await paste({ text: "第一行\r\n第二行\n\n第四行 <b>保持纯文字</b>" }), true);
    await frame.waitForSelector(".text-content");
    let textObject = (await getState()).objects.find(o => o.type === "text");
    assert.equal(textObject.text, "第一行\n第二行\n\n第四行 <b>保持纯文字</b>");
    assert.equal(await frame.locator(".text-content b").count(), 0, "Pasted text is never interpreted as HTML");
    // Synthetic events do not invoke the browser's default paste. Assert we do
    // not cancel them or create cards while the user is editing a field.
    const editorPaste = await frame.evaluate(() => {
      const input = document.querySelector("#quickEditPrompt");
      const data = new DataTransfer(); data.setData("text/plain", "in editor");
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(editorPaste, false);
    assert.equal((await getState()).objects.length, 5);
    // Real contenteditable rendering must keep line breaks when saved on blur.
    await frame.locator(".text-content").dblclick();
    await frame.locator('.text-content[contenteditable="true"]').fill("编辑第一行\n编辑第二行");
    await frame.locator('.text-content[contenteditable="true"]').press("Escape");
    await frame.waitForFunction(() => !document.querySelector('.text-content[contenteditable="true"]'));
    await new Promise(resolve => setTimeout(resolve, 100));
    textObject = (await getState()).objects.find(o => o.type === "text");
    assert.equal(textObject.text, "编辑第一行\n编辑第二行");
    await frame.evaluate(({ png }) => {
      const data = new DataTransfer();
      for (const name of ["drop-01.png", "drop-02.png", "drop-03.png"]) data.items.add(new File([Uint8Array.from(atob(png), ch => ch.charCodeAt(0))], name, { type: "image/png" }));
      const board = document.querySelector("#board");
      board.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
      board.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: 180, clientY: 380, dataTransfer: data }));
    }, { png });
    await frame.waitForFunction(() => document.querySelectorAll("#objects .canvas-object").length === 8);
    const dropped = (await getState()).objects.filter(o => o.name.startsWith("drop-"));
    assert.deepEqual(dropped.map(o => o.name), ["drop-01.png", "drop-02.png", "drop-03.png"]);
    assert.ok(dropped[1].y > dropped[0].y || dropped[1].x > dropped[0].x);
    for (const object of dropped) assert.equal((await fs.readFile(object.assetPath)).toString("base64"), png);
    await frame.locator("#board").press(`${shortcutModifier}+z`);
    await frame.waitForFunction(() => document.querySelectorAll("#objects .canvas-object").length === 5);
    await frame.locator("#board").press(`${shortcutModifier}+Shift+z`);
    await frame.waitForFunction(() => document.querySelectorAll("#objects .canvas-object").length === 8);
    // Batch imports leave the full set selected: preview must use just that set.
    await frame.locator(`[data-id="${dropped[0].id}"] .image-content`).dblclick();
    await frame.waitForFunction(() => document.querySelector("#previewInfo").textContent.includes("当前选中 · 1 / 3"));
    await page.keyboard.press("ArrowRight");
    await frame.waitForFunction(() => document.querySelector("#previewTitle").textContent === "drop-02.png");
    await page.keyboard.press("Escape");
    assert.equal(await frame.locator("#imagePreview").evaluate(d => d.open), false);
    assert.equal(await frame.locator("#objects .canvas-object.selected").count(), 3);
    const longText = "长段脚本：保留每一行。\n".repeat(260);
    await paste({ text: longText });
    await frame.waitForFunction(() => document.querySelectorAll("#objects .canvas-object").length === 9);
    assert.equal((await getState()).objects.at(-1).text, longText, "Text longer than the old 2000-character limit survives");
    await frame.locator("#board").press(`${shortcutModifier}+z`);
    await frame.waitForFunction(() => document.querySelectorAll("#objects .canvas-object").length === 8);
    await frame.locator("#board").press(`${shortcutModifier}+Shift+z`);
    await frame.waitForFunction(() => document.querySelectorAll("#objects .canvas-object").length === 9);
    assert.equal((await getState()).objects.at(-1).text, longText, "Undo/redo keeps long text and newlines");
    await frame.locator("#board").press(`${shortcutModifier}+z`);
    await frame.waitForFunction(() => document.querySelectorAll("#objects .canvas-object").length === 8);
    const jpeg = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 24; canvas.height = 16;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "#ef7850"; ctx.fillRect(0, 0, 24, 16);
      return canvas.toDataURL("image/jpeg");
    });
    const jpgObject = (await call("add_image", { projectDir, threadId, dataUrl: jpeg, name: "JPEG source", x: 100, y: 160 })).structuredContent;
    await frame.waitForSelector(`[data-id="${jpgObject.id}"]`, { state: "attached" });
    await frame.locator(`[data-id="${jpgObject.id}"]`).dispatchEvent("contextmenu", { clientX: 40, clientY: 200 });
    await frame.locator('[data-media-action="copy"]').click();
    await frame.waitForFunction(() => testClipboard.images.length === 2);
    const converted = PNG.sync.read(Buffer.from((await frame.evaluate(() => testClipboard.images[1])).split(",")[1], "base64"));
    assert.equal(converted.width, 24); assert.equal(converted.height, 16);
    await frame.locator(`[data-id="${jpgObject.id}"]`).dispatchEvent("contextmenu", { clientX: 40, clientY: 200 });
    await frame.locator('[data-media-action="save"]').click();
    await page.waitForFunction(() => window.downloads.length === 2);
    const jpgDownload = await page.evaluate(() => window.downloads[1].contents[0].resource);
    assert.equal(jpgDownload.blob, jpeg.split(",")[1]);
    assert.ok(jpgDownload.uri.endsWith(".jpg") || jpgDownload.uri.endsWith(".jpeg"), "Original format gets the correct file extension");
    await frame.locator(`[data-id="${jpgObject.id}"]`).dispatchEvent("dblclick", { button: 0 });
    await frame.waitForFunction(() => document.querySelector("#imagePreview").open && !document.querySelector("#previewImage").hidden);
    await frame.locator("#previewStage").click({ button: "right" });
    assert.equal(await frame.locator("#imageContextMenu").evaluate(menu => menu.parentElement.id), "imagePreview");
    await frame.locator('[data-media-action="copy"]').click();
    await frame.waitForFunction(() => testClipboard.images.length === 3);
    await page.keyboard.press("Escape");
    // Switching chat while a paste is in flight must never import into the new scope.
    importGate = new Promise(resolve => { releaseImport = resolve; });
    const importNoticed = new Promise(resolve => { noticeImport = resolve; });
    holdImport = true;
    await paste({ files: ["scope-pending.png"] });
    await importNoticed;
    const other = await call("open_canvas", { projectDir, threadId: `${threadId}-other` });
    await page.evaluate(opened => document.querySelector("iframe").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: opened }, "*"), other);
    releaseImport();
    holdImport = false;
    try {
      await frame.waitForFunction(() => document.querySelectorAll("#objects .canvas-object").length === 0);
    } catch (error) {
      // Diagnostics contain only this script's synthetic fixture metadata.
      console.error("Scope-switch fixture:", await frame.evaluate(() => ({ scope: window.codexCanvasApp.scope, inLauncher: window.codexCanvasApp.inLauncher, status: document.querySelector("#canvasConnection").textContent, objects: [...document.querySelectorAll("#objects .canvas-object")].map(el => el.dataset.id) })));
      await page.screenshot({ path: path.join(artifactDir, `media-scope-failed-${width}.png`) });
      throw error;
    }
    const otherState = (await call("canvas_app_request", { sessionId: other._meta.canvasSession.sessionId, path: "/api/state" })).structuredContent.body;
    assert.equal(otherState.objects.length, 0);
    assert.ok((await getState()).objects.some(o => o.name === "scope-pending.png"), "In-flight import remains with its originating project/chat");
    assert.deepEqual(errors, []);
    summary.push({ width, passed: true, objectCount: (await getState()).objects.length, originalBytesPreserved: true, clipboard: "real ClipboardItem; mocked write only; OS clipboard untouched", errors });
    await page.close();
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
  await client.close();
  await fs.rm(root, { recursive: true, force: true });
}
