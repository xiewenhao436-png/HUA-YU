import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { createMcpClient } from "./mcp-app-client.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-app-visual-"));
const client = createMcpClient(undefined, { CODEX_CANVAS_LIBRARY_PATH: path.join(projectDir, "test-library.json"), CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(projectDir, "test-projects.json"), CODEX_CANVAS_DISABLE_THREAD_DISCOVERY: "1" });
const browser = await chromium.launch(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {});
const call = (name, args) => client.request("tools/call", { name, arguments: args });
const fixture = new PNG({ width: 320, height: 220 });
for (let y = 0; y < 220; y++) for (let x = 0; x < 320; x++) {
  const i = (y * 320 + x) * 4;
  fixture.data.set([45 + Math.round(x / 2), 100 + Math.round(y / 2), 200, 255], i);
}
const png = PNG.sync.write(fixture).toString("base64");
try {
  const opened = await call("open_canvas", { projectDir, threadId: "visual-thread" });
  const added = await call("add_image", { projectDir, threadId: "visual-thread", dataUrl: `data:image/png;base64,${png}`, name: "Sidebar test image", x:200, y:200, width:280, height:190 });
  const resource = (await client.request("resources/list")).resources[0];
  const html = (await client.request("resources/read", { uri: resource.uri })).contents[0].text;
  for (const width of [1100, 440]) {
    const page = await browser.newPage({ locale: "zh-CN", viewport: { width, height: 820 } });
    const errors = [];
    const network = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith("blob:") && !request.url().startsWith("data:")) network.push(request.url()); });
    let releaseImages;
    const imagesReady = new Promise(resolve => { releaseImages = resolve; });
    await page.exposeFunction("mcpRequest", async params => {
      if (params.arguments?.path?.startsWith("/api/app-assets/")) await imagesReady;
      return client.request("tools/call", params);
    });
    await page.setContent('<style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style><iframe sandbox="allow-scripts allow-downloads"></iframe>');
    await page.evaluate(({ html, opened }) => {
      window.downloads = [];
      window.opened = opened;
      window.addEventListener("message", async event => {
        const message = event.data;
        if (message?.jsonrpc !== "2.0") return;
        if (message.method === "ui/notifications/initialized") {
          event.source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: window.opened }, "*"); return;
        }
        if (message.id === undefined) return;
        try {
          let result = {};
          if (message.method === "ui/initialize") result = {
            protocolVersion: message.params.protocolVersion, hostInfo: { name: "Canvas test host", version: "1" },
            hostCapabilities: { serverTools: {}, downloadFile: {}, message: {} },
            hostContext: { displayMode: "fullscreen", availableDisplayModes: ["fullscreen"], theme: "light" }
          };
          else if (message.method === "tools/call") {
            if (message.params.arguments?.path?.startsWith("/api/app-assets/") && !window.reopenedWhileLoading) {
              window.reopenedWhileLoading = true;
              event.source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: window.opened }, "*");
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            result = await window.mcpRequest(message.params);
          }
          else if (message.method === "ui/download-file") window.downloads.push(message.params);
          event.source.postMessage({ jsonrpc: "2.0", id: message.id, result }, "*");
        } catch (error) { event.source.postMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error.message } }, "*"); }
      });
      document.querySelector("iframe").srcdoc = html.replace('<meta charset="utf-8" />', '<meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'">');
    }, { html, opened });
    const frame = page.frames()[1];
    await frame.locator('[data-tool="hand"]').click();
    assert.equal(await frame.locator("#board").evaluate(b => b.classList.contains("tool-hand")), true, "Tools must work while image requests are held");
    await frame.locator('[data-tool="select"]').click();
    releaseImages();
    await frame.waitForSelector("#objects img", { timeout: 15000, state: "attached" });
    await frame.waitForFunction(() => [...document.querySelectorAll("#objects img")].every(img => img.complete && img.naturalWidth > 0));
    await frame.waitForFunction(() => document.querySelector("#objects img")?.naturalWidth === 320);
    const image = frame.locator("#objects img").first();
    if (width === 1100) {
      await frame.locator('.tool-dock [data-view-action="reset"]').click();
      await frame.evaluate(() => document.querySelector("#board").dispatchEvent(new KeyboardEvent("keydown", {key:" ",code:"Space",bubbles:true})));
      await frame.locator('[data-tool="select"]').click();
      assert.equal(await frame.locator("#board").evaluate(b => b.classList.contains("space-pan")), false, "Tool choice must clear a lost Space keyup");
      await frame.locator('[data-tool="hand"]').click();
      const lostPan = await frame.evaluate(() => {
        const b=document.querySelector("#board");
        b.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,isPrimary:true,pointerId:1,pointerType:"mouse",button:0,buttons:1,clientX:800,clientY:500}));
        const active=b.classList.contains("dragging");
        window.dispatchEvent(new Event("blur"));
        return {active,stuck:b.classList.contains("dragging")};
      });
      assert.equal(lostPan.active, true);
      assert.equal(lostPan.stuck, false, "Focus loss must release a pan gesture");
      const lostUp = await frame.evaluate(() => {
        const b=document.querySelector("#board");
        b.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,isPrimary:true,pointerId:1,pointerType:"mouse",button:0,buttons:1,clientX:800,clientY:500}));
        window.dispatchEvent(new PointerEvent("pointermove",{bubbles:true,isPrimary:true,pointerId:1,pointerType:"mouse",buttons:0,clientX:850,clientY:550}));
        return b.classList.contains("dragging");
      });
      assert.equal(lostUp, false, "Button-free mouse movement must recover a lost pointerup");
      await frame.locator('[data-tool="select"]').click();
      await frame.evaluate(() => document.querySelector("#board").dispatchEvent(new KeyboardEvent("keydown", {key:" ",code:"Space",bubbles:true})));
      await frame.locator("#board").press("Escape");
      assert.equal(await frame.locator("#board").evaluate(b => b.classList.contains("space-pan")), false, "Escape must clear a stuck temporary tool");
      const viewportBox=await frame.locator("#board").boundingBox();
      await frame.locator('[data-tool="hand"]').click();
      const beforePan=await frame.locator("#world").getAttribute("style");
      await page.mouse.move(viewportBox.x+900,viewportBox.y+570);
      await page.mouse.down();
      await page.mouse.move(viewportBox.x+950,viewportBox.y+610,{steps:5});
      await page.mouse.up();
      assert.notEqual(await frame.locator("#world").getAttribute("style"),beforePan,"Hand tool must pan normally");
      await frame.locator('[data-tool="select"]').click();
      await page.keyboard.down("Control");
      const beforeZoom=await frame.locator("#zoomLabel").textContent();
      await page.mouse.move(viewportBox.x+900,viewportBox.y+550);
      await page.mouse.wheel(0,-100);
      await frame.waitForFunction(value=>document.querySelector("#zoomLabel").textContent!==value,beforeZoom);
      await page.keyboard.up("Control");
      const afterZoom=await frame.locator("#zoomLabel").textContent();
      await page.mouse.wheel(0,80);
      await new Promise(r=>setTimeout(r,120));
      assert.equal(await frame.locator("#zoomLabel").textContent(),afterZoom,"Normal wheel must stop zooming after Ctrl release");
      await frame.locator('.tool-dock [data-view-action="reset"]').click();
      const selectionBox=await image.boundingBox();
      await page.mouse.move(selectionBox.x-14,selectionBox.y-14);
      await page.mouse.down();
      await page.mouse.move(selectionBox.x+selectionBox.width+14,selectionBox.y+selectionBox.height+14,{steps:8});
      await page.mouse.up();
      assert.equal(await frame.locator("#objects .canvas-object.selected").count(),1,"Marquee must select the image");

    }
    await frame.locator("#objects .image-content").first().click();
    await frame.locator('[data-action="download"]').click();
    await page.waitForFunction(() => window.downloads.length === 1);
    assert.equal((await page.evaluate(() => window.downloads[0])).contents[0].resource.blob, png);
    const dragBefore = (await call("canvas_app_request", { sessionId: opened._meta.canvasSession.sessionId, path: "/api/state" })).structuredContent.body.objects[0].x;
    const box = await image.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 + 30, { steps: 5 }); await page.mouse.up();
    await new Promise(resolve => setTimeout(resolve, 350));
    const state = (await call("canvas_app_request", { sessionId: opened._meta.canvasSession.sessionId, path: "/api/state" })).structuredContent.body;
    assert.notEqual(state.objects[0].x, dragBefore);
    await page.mouse.wheel(0, -100);
    const reopened = await call("open_canvas", { projectDir, threadId: "visual-thread" });
    assert.equal(reopened._meta.canvasSession.sessionId, opened._meta.canvasSession.sessionId);
    await page.evaluate(opened => document.querySelector("iframe").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: opened }, "*"), reopened);
    if (width === 1100) {
      const other = await call("open_canvas", { projectDir, threadId: "other-visual-thread" });
      const otherImage = await call("add_image", { projectDir, threadId: "other-visual-thread", dataUrl: `data:image/png;base64,${png}`, name: "Other chat image" });
      await page.evaluate(opened => {
        window.opened = opened;
        document.querySelector("iframe").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: opened }, "*");
      }, other);
      await frame.waitForFunction(id => document.querySelector(`#objects [data-id="${id}"] img`)?.naturalWidth === 320, otherImage.structuredContent.id);
      assert.equal(await frame.locator(`#objects [data-id="${added.structuredContent.id}"]`).count(), 0);
    }
    await fs.mkdir("dist", { recursive: true });
    await page.screenshot({ path: `dist/canvas-sidebar-${width}.png` });
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
    await page.close();
  }
  console.log("Interaction regressions passed: held assets, lost Space keyup, blur, lost pointerup, Esc, hand pan, Ctrl wheel release, marquee; data-only images, reopen during image load, chat scope switch, drag, zoom, host download, panel reuse; no network requests.");
} finally { await browser.close(); await client.close(); await fs.rm(projectDir, { recursive: true, force: true }); }
