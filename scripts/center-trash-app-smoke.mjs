// Isolated real-MCP UI verification. Never enumerates or deletes user boards.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { createMcpClient } from "./mcp-app-client.mjs";
import { mountApp } from "./app-test-host.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-center-trash-ui-"));
const artifactDir = path.resolve(process.env.CANVAS_TEST_ARTIFACT_DIR || "dist/test-ui");
await fs.mkdir(artifactDir, { recursive: true });
const projects = [path.join(root, "十五五品牌短片"), path.join(root, "山水沉浸体验")];
const definitions = [
  { id: "computing", title: "算力分镜｜原版与 Logo·MG 修订对照", cwd: projects[0] },
  { id: "service", title: "服务短视频｜分镜参考", cwd: projects[0] },
  { id: "connection", title: "连接短视频｜节奏与转场", cwd: projects[0] },
  { id: "landscape", title: "千里江山｜空间与光影", cwd: projects[1] },
  { id: "route", title: "观众动线｜体验节点", cwd: projects[1] },
  { id: "empty", title: "待整理的参考", cwd: projects[1] }
];
const env = { CODEX_CANVAS_LIBRARY_PATH: path.join(root, "library.json"), CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(root, "projects.json"), CODEX_CANVAS_THREADS_FILE: path.join(root, "threads.json"), CODEX_CANVAS_DISABLE_THREAD_DISCOVERY: "1" };
await fs.writeFile(env.CODEX_CANVAS_THREADS_FILE, JSON.stringify(definitions));
const pluginRoot = process.env.CODEX_CANVAS_TEST_ROOT ? pathToFileURL(path.resolve(process.env.CODEX_CANVAS_TEST_ROOT) + path.sep) : undefined;
const client = createMcpClient(pluginRoot, env);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined });
const call = (name, args) => client.request("tools/call", { name, arguments: args });
const library = async args => (await call("canvas_library", args)).structuredContent;
const boards = new Map();
function graphic(index) {
  const p = new PNG({ width: 480, height: 270 });
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const red = index < 3, accent = red ? [190, 53, 56] : [64, 111, 123];
    const shapes = red ? ((x > 76 && x < 165 && y > 90 && y < 190) || (x > 211 && x < 300 && y > 60 && y < 160) || (x > 340 && x < 396 && y > 118 && y < 190)) : y > 205 - 68 * Math.sin(x / 74 + index) - 17 * Math.cos(x / 23);
    const line = red && y > 206 && y < 211 && x > 60 && x < 418;
    p.data.set(shapes || line ? [...accent, 255] : [248 - index, 246, 241 + index, 255], (y * p.width + x) * 4);
  }
  return PNG.sync.write(p).toString("base64");
}
const summary = [];
try {
  for (const [index, definition] of definitions.entries()) {
    const projectDir = path.join(definition.cwd, "_codex", "fixture-" + definition.id, "work", "board");
    const opened = await call("open_canvas", { projectDir, threadId: definition.id });
    const sessionId = opened._meta.canvasSession.sessionId;
    await call("canvas_app_request", { sessionId, path: "/api/state", method: "POST", body: { title: definition.title } });
    if (definition.id !== "empty") await call("add_image", { projectDir, threadId: definition.id, dataUrl: `data:image/png;base64,${graphic(index)}`, name: definition.title, imagegenPrompt: "UI fixture; no AI generation." });
    boards.set(definition.id, { ...definition, id: opened._meta.canvasSession.boardId, canvasId: opened._meta.canvasSession.canvasId, projectDir });
  }
  const resource = (await client.request("resources/list")).resources[0];
  const html = (await client.request("resources/read", { uri: resource.uri })).contents[0].text;
  const victim = boards.get("service");
  const board = (frame, id) => frame.locator(`.center-board-card[data-canvas-id="${id}"]`);
  for (const width of [1200, 440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    const opened = await call("open_canvas", { threadId: "unbound-fixture-" + width });
    const frame = await mountApp(page, client, { opened, html });
    await frame.waitForFunction(() => document.querySelectorAll(".center-board-card").length === 6);
    assert.equal(await frame.locator("[data-project-group]").count(), 2);
    for (const preview of await frame.locator("[data-preview-board]").all()) {
      await preview.scrollIntoViewIfNeeded();
      await preview.locator("img").waitFor();
      await preview.locator("img").evaluate(i => i.decode());
      assert.equal(await preview.locator("img").evaluate(i => i.naturalWidth), 320);
    }
    await frame.locator(".center-main").evaluate(e => { e.scrollTop = 0; });
    await frame.locator(".center-heading").scrollIntoViewIfNeeded();
    await frame.waitForFunction(() => document.querySelector(".center-main").scrollTop === 0);
    await page.screenshot({ path: path.join(artifactDir, `canvas-center-${width}.png`) });
    assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "No horizontal overflow");
    await frame.locator("[data-center-project]").filter({ hasText: "十五五品牌短片" }).click();
    assert.equal(await frame.locator(".center-board-card").count(), 3);
    await frame.getByRole("searchbox", { name: "搜索画布" }).fill("服务");
    assert.equal(await frame.locator(".center-board-card").count(), 1);
    await frame.getByRole("searchbox", { name: "搜索画布" }).fill("");
    await frame.getByRole("combobox", { name: "画布排序" }).selectOption("name");
    const names = await frame.locator(".center-board-card h3").allTextContents();
    assert.deepEqual(names, [...names].sort((a,b) => a.localeCompare(b,"zh-CN")));
    await frame.locator('[data-center-view="all"]').click();
    let peerPage, peerFrame;
    if (width === 1200) {
      peerPage = await browser.newPage({ viewport: { width: 1000, height: 780 } });
      peerFrame = await mountApp(peerPage, client, { opened: await call("canvas_library", { action: "open", boardId: victim.id }), html });
      await peerFrame.waitForFunction(() => document.querySelector("#canvasConnection").style.display === "none");
    }
    await board(frame, victim.id).click({ button: "right" });
    await frame.getByRole("menuitem", { name: "移到回收站", exact: true }).click();
    await frame.waitForFunction(() => document.querySelectorAll(".center-board-card").length === 5);
    if (peerFrame) {
      await peerFrame.evaluate(() => window.codexCanvasApp.fetch("/api/state").catch(() => {}));
      await peerFrame.waitForFunction(() => window.codexCanvasApp.inLauncher && document.querySelectorAll(".center-board-card").length === 5);
      await peerPage.close();
    }
    await fs.access(path.join(victim.projectDir, "canvas"));
    await frame.locator(".center-toast").getByRole("button", { name: "撤销", exact: true }).click();
    await frame.waitForFunction(() => document.querySelectorAll(".center-board-card").length === 6);
    await board(frame, victim.id).getByRole("button", { name: /画布操作/ }).click();
    await frame.getByRole("menuitem", { name: "移到回收站", exact: true }).click();
    await frame.waitForFunction(() => document.querySelectorAll(".center-board-card").length === 5);
    await frame.locator('[data-center-view="trash"]').click();
    assert.equal(await frame.locator(".center-board-card").count(), 1);
    await page.screenshot({ path: path.join(artifactDir, `canvas-trash-${width}.png`) });
    await board(frame, victim.id).click({ button: "right" });
    await frame.getByRole("menuitem", { name: "永久删除…", exact: true }).click();
    const dialog = frame.getByRole("dialog", { name: "确认永久删除画布" });
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /服务短视频/);
    assert.equal(await dialog.getByRole("button", { name: "取消", exact: true }).evaluate(b => b === document.activeElement), true, "Cancel gets initial focus");
    await page.screenshot({ path: path.join(artifactDir, `canvas-confirm-${width}.png`) });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.ok((await library({ action: "list" })).trash.find(b => b.id === victim.id));
    await board(frame, victim.id).click({ button: "right" });
    await frame.getByRole("menuitem", { name: "恢复画布", exact: true }).click();
    await frame.waitForFunction(() => document.querySelectorAll(".center-board-card").length === 0);
    await frame.locator('[data-center-view="all"]').click();
    assert.equal(await frame.locator(".center-board-card").count(), 6);
    // Direct open, explicit home and re-entry should retain controls, not grow listeners.
    await board(frame, victim.id).locator("[data-board-id]").click();
    await frame.waitForFunction(() => document.querySelector("#canvasConnection").style.display === "none" && document.querySelector("#objects img")?.naturalWidth === 480);
    await frame.locator(".project-header > button").first().click();
    await frame.locator("[data-canvas-home]").click();
    await frame.waitForFunction(() => document.querySelectorAll(".center-board-card").length === 6);
    await frame.locator('[data-center-view="trash"]').click();
    await frame.locator('[data-center-view="all"]').click();
    assert.equal(await frame.locator(".center-board-card").count(), 6);
    if (width === 440) {
      await board(frame, victim.id).click({ button: "right" });
      await frame.getByRole("menuitem", { name: "移到回收站", exact: true }).click();
      await frame.waitForFunction(() => document.querySelectorAll(".center-board-card").length === 5);
      await frame.locator('[data-center-view="trash"]').click();
      await board(frame, victim.id).click({ button: "right" });
      await frame.getByRole("menuitem", { name: "永久删除…", exact: true }).click();
      await dialog.getByRole("button", { name: "永久删除", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal((await library({ action: "list", refresh: true })).trash.length, 0);
      assert.equal((await library({ action: "list" })).boards.length, 5);
      const stateFile = path.join(victim.projectDir, "canvas", "threads", victim.canvasId, "codex-canvas.json");
      await assert.rejects(fs.access(stateFile));
    }
    assert.equal(await page.evaluate(() => window.chatMessages.length), 0);
    assert.deepEqual(errors, []);
    summary.push({ width, groupedProjects: 2, originalBoards: 6, previews: 5, projectFilter: true, search: true, sort: true, rightClickTrash: true, undo: true, restore: true, cancelConfirmation: true, permanentDelete: width === 440, centerReentry: true, crossPanelDeletionReturnsCenter: width === 1200, chatTurns: 0, errors });
    await page.close();
  }
  // A partially completed permanent removal must never offer a false restore.
  const incomplete = boards.get("route");
  await library({ action: "trash", boardId: incomplete.id });
  const index = JSON.parse(await fs.readFile(env.CODEX_CANVAS_LIBRARY_PATH, "utf8"));
  index.tombstones.find(t => t.id === incomplete.id).purgeStartedAt = new Date().toISOString();
  await fs.writeFile(env.CODEX_CANVAS_LIBRARY_PATH, JSON.stringify(index));
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  const frame = await mountApp(page, client, { opened: await call("open_canvas", { threadId: "incomplete-fixture" }), html });
  await frame.waitForSelector('[data-center-view="trash"]');
  await frame.locator('[data-center-view="trash"]').click();
  await frame.waitForSelector(`[data-canvas-id="${incomplete.id}"]`);
  assert.match(await board(frame, incomplete.id).textContent(), /删除未完成/);
  await board(frame, incomplete.id).click({ button: "right" });
  assert.equal(await frame.getByRole("menuitem", { name: "恢复画布", exact: true }).count(), 0);
  await frame.getByRole("menuitem", { name: "继续永久删除…", exact: true }).click();
  const retry = frame.getByRole("dialog", { name: "确认永久删除画布" });
  assert.match(await retry.textContent(), /上次永久删除未完成/);
  await retry.getByRole("button", { name: "取消", exact: true }).click();
  await page.close();
  summary.push({ incompletePurge: "retry-only", falseRestoreHidden: true });
  console.log(JSON.stringify({ target: process.env.CODEX_CANVAS_TEST_ROOT || "source", checks: summary }, null, 2));
} finally {
  await browser.close(); await client.close();
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(root, { recursive: true, force: true });
}
