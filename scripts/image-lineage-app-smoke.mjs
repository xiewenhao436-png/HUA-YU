import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { createMcpClient } from "./mcp-app-client.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const temporary = await fs.realpath(os.tmpdir());
const root = await fs.mkdtemp(path.join(temporary, "huayu-lineage-app-"));
const artifacts = path.resolve(process.env.CANVAS_TEST_ARTIFACT_DIR || "dist/test-ui");
const executable = path.join(root, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
const worker = executable + ".mjs";
const generated = path.join(root, "generated.png");
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(generated, makePng([61, 116, 107], [217, 177, 120]));
await fs.writeFile(worker, [
  'import fs from "node:fs";',
  'import path from "node:path";',
  'const prompt = fs.readFileSync(0, "utf8");',
  'const output = prompt.match(/Copy the PNG into this exact directory: (.+)/)[1];',
  'fs.writeFileSync(path.join(output, "result.png"), fs.readFileSync(process.env.HUAYU_TEST_GENERATED_PNG));'
].join("\n"));
if (process.platform === "win32") {
  await fs.writeFile(executable, `@echo off\r\n"${process.execPath}" "%~dp0${path.basename(worker)}" %*\r\n`);
} else {
  await fs.writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${worker}" "$@"\n`, { mode: 0o755 });
}

const client = createMcpClient(undefined, {
  CODEX_CANVAS_CODEX_CLI: executable,
  CODEX_CANVAS_CODEX_MODEL: "",
  CODEX_CANVAS_CODEX_MODEL_REFERENCE_GENERATE: "",
  CODEX_CANVAS_LIBRARY_PATH: path.join(root, "library.json"),
  CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(root, "projects.json"),
  CODEX_CANVAS_DISABLE_THREAD_DISCOVERY: "1",
  HUAYU_TEST_GENERATED_PNG: generated
});
const call = (name, args) => client.request("tools/call", { name, arguments: args });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined });
try {
  const resource = (await client.request("resources/list")).resources[0];
  const html = (await client.request("resources/read", { uri: resource.uri })).contents[0].text;
  for (const width of [1100, 440]) {
    const projectDir = path.join(root, `board-${width}`);
    const threadId = `lineage-${width}`;
    await fs.mkdir(projectDir);
    const opened = await call("open_canvas", { projectDir, threadId, displayTitle: "山野取景" });
    const sessionId = opened._meta.canvasSession.sessionId;
    const state = async () => (await call("canvas_app_request", { sessionId, path: "/api/state" })).structuredContent.body;
    const add = async (name, x, y, hills, sky, extra = {}) => {
      const dataUrl = `data:image/png;base64,${makePng(hills, sky).toString("base64")}`;
      return (await call("add_image", { projectDir, threadId, dataUrl, name, x, y, width: 166, height: 108, ...extra })).structuredContent;
    };
    const base = await add("林间小径", 58, 130, [37, 87, 68], [170, 184, 140]);
    const warm = await add("暖色晨光", 58, 270, [147, 80, 73], [245, 189, 152]);
    const mist = await add("远山云雾", 58, 410, [61, 121, 129], [167, 203, 191]);
    const result = await add("山间晨雾", 332, 206, [75, 123, 91], [245, 199, 123], {
      width: 218, height: 151, sourceObjectId: base.id, referenceObjectIds: [warm.id, mist.id]
    });
    const page = await browser.newPage({ locale: "zh-CN", viewport: { width, height: 770 } });
    page.setDefaultTimeout(12000);
    const errors = [];
    const jobRequests = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.exposeFunction("mcpRequest", async params => {
      const response = await client.request("tools/call", params);
      if (params.arguments?.path?.split("?")[0] === "/api/jobs" && params.arguments?.method === "POST") {
        jobRequests.push({ input: params.arguments.body, response: response.structuredContent });
      }
      return response;
    });
    await page.route("https://canvas.test/", route => route.fulfill({ contentType: "text/html", body: '<style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style><iframe sandbox="allow-scripts allow-same-origin"></iframe>' }));
    await page.goto("https://canvas.test/");
    await page.evaluate(({ html, opened }) => {
      window.addEventListener("message", async event => {
        const message = event.data;
        if (message?.jsonrpc !== "2.0") return;
        if (message.method === "ui/notifications/initialized") {
          event.source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: opened }, "*");
          return;
        }
        if (message.id === undefined) return;
        try {
          let result = {};
          if (message.method === "ui/initialize") {
            result = {
              protocolVersion: message.params.protocolVersion, hostInfo: { name: "Lineage test host", version: "1" },
              hostCapabilities: { serverTools: {} }, hostContext: { displayMode: "fullscreen", availableDisplayModes: ["fullscreen"], theme: "light" }
            };
          } else if (message.method === "tools/call") {
            result = await window.mcpRequest(message.params);
          }
          event.source.postMessage({ jsonrpc: "2.0", id: message.id, result }, "*");
        } catch (error) {
          event.source.postMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error.message } }, "*");
        }
      });
      const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'">`;
      document.querySelector("iframe").srcdoc = html.replace('<meta charset="utf-8" />', '<meta charset="utf-8" />' + csp);
    }, { html, opened });
    const frame = page.frames()[1];
    await frame.waitForFunction(() => [...document.querySelectorAll("#objects img")].filter(image => image.naturalWidth).length === 4);
    await frame.locator("#settingsButton").click();
    await frame.locator('[data-settings-row="language"]').click();
    await frame.locator('[data-language="zh"]').click();
    const strip = frame.locator("#lineageStrip");
    const image = id => frame.locator(`[data-id="${id}"] .image-content`);
    const reset = frame.locator('.tool-dock [data-view-action="reset"]');
    await reset.click();
    assert.equal(await strip.isVisible(), false);
    await image(result.id).click();
    const originEdge = frame.locator("#lineageEdges path.source");
    const referenceEdges = frame.locator("#lineageEdges path.reference");
    await originEdge.waitFor({ state: "attached" });
    assert.equal(await referenceEdges.count(), 2);
    assert.deepEqual(await strip.locator("[data-lineage-id]").evaluateAll(cards => cards.map(card => card.dataset.lineageId)), [base.id, warm.id, mist.id]);
    await frame.waitForFunction(() => [...document.querySelectorAll("#lineageStrip img")].every(image => image.naturalWidth));
    const resultBox = await image(result.id).boundingBox();
    const stripBox = await strip.boundingBox();
    assert.ok(stripBox.y >= resultBox.y + resultBox.height);
    assert.ok(stripBox.x >= 0 && stripBox.x + stripBox.width <= width);
    await page.screenshot({ path: path.join(artifacts, `lineage-${width}.png`) });

    const edgeBefore = await originEdge.getAttribute("d");
    await page.mouse.move(resultBox.x + resultBox.width / 2, resultBox.y + resultBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(resultBox.x + resultBox.width / 2 + 21, resultBox.y + resultBox.height / 2 + 12, { steps: 3 });
    await frame.waitForFunction(before => document.querySelector("#lineageEdges path.source")?.getAttribute("d") !== before, edgeBefore);
    await page.mouse.up();
    const viewportBefore = await frame.locator("#world").getAttribute("style");
    await strip.locator(`[data-lineage-id="${mist.id}"]`).click();
    await frame.locator(`[data-id="${mist.id}"].lineage-target`).waitFor();
    assert.notEqual(await frame.locator("#world").getAttribute("style"), viewportBefore);
    assert.equal(await frame.locator(`#objects [data-id="${result.id}"].selected`).count(), 1);
    await strip.locator("[data-lineage-return]").click();
    await frame.locator("#board").click({ position: { x: width - 20, y: 560 } });
    await strip.waitFor({ state: "hidden" });
    assert.equal(await referenceEdges.count(), 0);

    await reset.click();
    await image(mist.id).click();
    await image(base.id).click({ modifiers: ["Shift"] });
    await frame.locator('[data-action="reference-generate"]').click();
    assert.equal(await frame.locator("#quickEditComposer .reference-thumbnail").count(), 2);
    assert.equal(await frame.locator("#quickEditRun").isDisabled(), true);
    const useFirstAsBase = width === 1100;
    if (useFirstAsBase) {
      await frame.locator("#referenceUseFirstAsBase").check();
      assert.deepEqual(await frame.locator("#referenceComposerImages .reference-thumbnail span").allTextContents(), ["底图", "参考 1"]);
    }
    await frame.locator("#quickEditPrompt").fill("保留远山的构图，参考晨光的配色。");
    await frame.locator("#quickEditRun").click();
    const saved = await waitForResult(state, result.id, useFirstAsBase ? 1 : 2);
    assert.equal(jobRequests.length, 1);
    const [{ input, response }] = jobRequests;
    assert.ok(response?.status >= 200 && response.status < 300, JSON.stringify(response));
    assert.equal(input.objectId, mist.id);
    assert.deepEqual(input.referenceObjectIds, [mist.id, base.id]);
    assert.equal(input.useFirstAsBase, useFirstAsBase ? true : undefined);
    assert.deepEqual(saved.referenceObjectIds, useFirstAsBase ? [base.id] : [mist.id, base.id]);
    assert.equal(saved.sourceObjectId, useFirstAsBase ? mist.id : null);
    await image(saved.id).waitFor({ state: "attached" });
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`Lineage and ordered reference generation passed at ${width}px.`);
  }
} finally {
  await browser.close();
  await client.close();
  assert.ok(path.resolve(root).startsWith(temporary + path.sep));
  await fs.rm(root, { recursive: true, force: true });
}

async function waitForResult(state, seedId, referenceCount) {
  let objects;
  for (let attempt = 0; attempt < 90; attempt++) {
    objects = (await state()).objects;
    const object = objects.find(item => item.type === "image" && item.id !== seedId && item.referenceObjectIds?.length === referenceCount && item.assetPath);
    if (object) return object;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`Reference generation result was never saved. ${JSON.stringify(objects.map(({ type, name, status, error }) => ({ type, name, status, error })))}`);
}

function makePng(hills, sky) {
  const png = new PNG({ width: 144, height: 96 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const ridge = 48 + 12 * Math.sin(x * 0.045 + hills[0] * 0.05) + 7 * Math.cos(x * 0.105);
      const color = y > ridge ? hills : sky;
      const shade = Math.round(15 * (1 - y / png.height));
      png.data.set([...color.map(channel => Math.min(255, channel + shade)), 255], (y * png.width + x) * 4);
    }
  }
  return PNG.sync.write(png);
}
