import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { selectProjectCanvases } from "../public/canvas-library.js";
import { createMcpClient } from "./mcp-app-client.mjs";
import { mountApp } from "./app-test-host.mjs";

const windowsBoards = [
  { id: "a", projectDir: "F:\\项目\\_codex\\a\\work\\board", canvasId: "one" },
  { id: "alias", projectDir: "\\\\?\\F:\\项目\\_codex\\a\\work\\board", canvasId: "one" },
  { id: "b", projectDir: "f:\\项目\\_codex\\b\\work\\board", canvasId: "two" },
  { id: "other", projectDir: "F:\\项目二\\_codex\\c", canvasId: "three" }
];
assert.deepEqual(selectProjectCanvases({ boards: windowsBoards }, { ...windowsBoards[1], boardId: "alias" }).boards.map(b => b.id), ["alias", "b"]);
assert.equal(selectProjectCanvases({ boards: [{ id: "a", projectDir: "/work/Film/_codex/a" }, { id: "b", projectDir: "/work/film/_codex/b" }] }, { boardId: "a" }).boards.length, 1, "POSIX paths remain case sensitive");
assert.equal(selectProjectCanvases({ boards: [{ id: "a", projectDir: "/work/film/boards/a", threadId: "a" }, { id: "b", projectDir: "/work/film/boards/b", threadId: "b" }], threads: [{ id: "a", cwd: "/work/film" }, { id: "b", cwd: "/work/film" }] }, { boardId: "a" }).boards.length, 2);

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-project-switcher-"));
const artifactDir = path.resolve(process.env.CANVAS_TEST_ARTIFACT_DIR || "dist/test-ui");
await fs.mkdir(artifactDir, { recursive: true });
const project = path.join(root, "十五五"), other = path.join(root, "另一个项目");
const definitions = [
  { id: "a", title: "算力分镜 | 原版与Logo-MG修订对照", cwd: project, viewport: { x: 111, y: 222, zoom: 0.65 } },
  { id: "b", title: "算力分镜 | 红白平面MG草稿", cwd: project, viewport: { x: -77, y: 88, zoom: 0.9 } },
  { id: "c", title: "服务短视频 | 分镜参考", cwd: project },
  { id: "outside", title: "另一个项目的画布", cwd: other }
];
const env = { CODEX_CANVAS_LIBRARY_PATH: path.join(root, "library.json"), CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(root, "projects.json"), CODEX_CANVAS_THREADS_FILE: path.join(root, "threads.json") };
await fs.writeFile(env.CODEX_CANVAS_THREADS_FILE, JSON.stringify(definitions));
const pluginRoot = process.env.CODEX_CANVAS_TEST_ROOT ? pathToFileURL(path.resolve(process.env.CODEX_CANVAS_TEST_ROOT) + path.sep) : undefined;
const client = createMcpClient(pluginRoot, env);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined });
const call = (name, args) => client.request("tools/call", { name, arguments: args });
const api = async (opened, route, method = "GET", body) => (await call("canvas_app_request", { sessionId: opened._meta.canvasSession.sessionId, path: route, method, body })).structuredContent;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8hgGAAAAABJRU5ErkJggg==";
const boards = {};
const summary = [];
try {
  for (const item of definitions) {
    const dir = path.join(item.cwd, "_codex", "task-" + item.id, "work", "board");
    const opened = await call("open_canvas", { projectDir: dir, threadId: item.id });
    if (["a", "b"].includes(item.id)) await call("add_image", { projectDir: dir, threadId: item.id, dataUrl: `data:image/png;base64,${png}`, name: item.title, x: 120, y: 120 });
    await api(opened, "/api/state", "POST", { title: item.title });
    if (item.viewport) await api(opened, "/api/state", "POST", { viewport: item.viewport });
    boards[item.id] = { opened, before: (await api(opened, "/api/state")).body, id: opened._meta.canvasSession.boardId };
  }
  const resource = (await client.request("resources/list")).resources[0];
  const html = (await client.request("resources/read", { uri: resource.uri })).contents[0].text;
  for (const width of [1100, 440]) {
    const page = await browser.newPage({ viewport: { width, height: 820 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const frame = await mountApp(page, client, { opened: boards.a.opened, html });
    await frame.waitForFunction(title => document.querySelector("#projectTitle")?.value === title && document.querySelector("#objects img")?.naturalWidth === 1, definitions[0].title);
    await frame.locator(".project-header > button").first().click();
    await frame.waitForSelector("#projectMenu [data-board-id]");
    assert.equal(await frame.locator("#projectMenu [data-board-id]").count(), 3);
    assert.equal(await frame.locator(`#projectMenu [data-board-id="${boards.outside.id}"]`).count(), 0);
    assert.equal(await frame.locator("#projectMenu .project-menu-current").count(), 1);
    assert.equal(await frame.locator("#projectMenu .active").getAttribute("data-board-id"), boards.a.id);
    await page.screenshot({ path: path.join(artifactDir, `project-switcher-${width}.png`) });
    await frame.locator(`#projectMenu [data-board-id="${boards.b.id}"]`).click();
    await frame.waitForFunction(title => document.querySelector("#projectTitle").value === title && document.querySelector("#objects img")?.naturalWidth === 1, definitions[1].title);
    assert.equal(await frame.evaluate(() => window.codexCanvasApp.scope.boardId), boards.b.id);
    assert.deepEqual((await api(boards.b.opened, "/api/state")).body.viewport, definitions[1].viewport, "The previous canvas must never overwrite the destination viewport");
    assert.equal(await frame.locator("#canvasLibrary").evaluate(d => d.open), false, "Switching opens the board directly, not the image importer");
    await frame.locator("#objects .canvas-object").first().click();
    await frame.locator(".project-header > button").first().click();
    await frame.locator("[data-canvas-home]").click();
    await frame.waitForSelector("#canvasConnection .library-launcher-list [data-board-id]");
    assert.equal(await frame.locator("#canvasConnection .library-launcher-list [data-board-id]").count(), 4);
    assert.equal(await frame.evaluate(() => window.codexCanvasApp.inLauncher && !window.codexCanvasApp.active && document.querySelector(".app-shell").inert), true);
    // Replayed chat metadata and hidden-editor shortcuts cannot dismiss the
    // center or change objects on the previously viewed board.
    await page.evaluate(opened => document.querySelector("iframe").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: opened }, "*"), boards.a.opened);
    await frame.locator("#canvasConnection [data-board-id]").first().press("Delete");
    await frame.evaluate(() => {
      const data = new DataTransfer(); data.setData("text/plain", "Must not paste into hidden board");
      document.querySelector("#canvasConnection").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    });
    assert.deepEqual((await api(boards.b.opened, "/api/state")).body.objects, boards.b.before.objects);
    assert.notEqual(await frame.locator("#canvasConnection").evaluate(n => n.style.display), "none");
    await page.screenshot({ path: path.join(artifactDir, `project-switcher-center-${width}.png`) });
    await frame.locator(`#canvasConnection [data-board-id="${boards.a.id}"]`).click();
    await frame.waitForFunction(title => document.querySelector("#canvasConnection").style.display === "none" && document.querySelector("#projectTitle").value === title, definitions[0].title);
    assert.equal(await frame.locator(".app-shell").evaluate(n => n.inert), false);
    await frame.locator('[data-tool="hand"]').click(); await frame.locator('[data-tool="select"]').click();
    assert.equal(await page.evaluate(() => window.chatMessages.length), 0);
    assert.deepEqual(errors, []);
    summary.push({ width, sameProjectBoards: 3, unrelatedProjectHidden: true, directSwitch: true, independentViewport: true, explicitCenterStaysOpen: true, hiddenCanvasProtected: true, returnToSavedCanvas: true, chatTurns: 0, errors });
    await page.close();
  }
  for (const item of definitions) assert.deepEqual((await api(boards[item.id].opened, "/api/state")).body.objects, boards[item.id].before.objects);
  console.log(JSON.stringify(summary, null, 2));
} finally { await browser.close(); await client.close(); await fs.rm(root, { recursive: true, force: true }); }
