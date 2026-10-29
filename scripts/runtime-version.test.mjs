// Runtime update regression tests use only disposable plugin and board fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMcpClient } from "./mcp-app-client.mjs";

const sourceRoot = process.env.CODEX_CANVAS_TEST_ROOT
  ? path.resolve(process.env.CODEX_CANVAS_TEST_ROOT)
  : fileURLToPath(new URL("../", import.meta.url));

test("MCP freezes UI and capability identity until its process restarts", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-runtime-version-"));
  const plugin = path.join(fixture, "plugin"), modules = path.join(plugin, "node_modules");
  const env = { CODEX_CANVAS_LIBRARY_PATH: path.join(fixture, "library.json"), CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(fixture, "projects.json"), CODEX_CANVAS_DISABLE_THREAD_DISCOVERY: "1" };
  let client;
  try {
    await fs.mkdir(path.join(plugin, "public"), { recursive: true });
    await fs.cp(path.join(sourceRoot, "src"), path.join(plugin, "src"), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, "package.json"), path.join(plugin, "package.json"));
    // Dependencies are read-only. Remove the junction before fixture cleanup.
    await fs.symlink(path.join(sourceRoot, "node_modules"), modules, process.platform === "win32" ? "junction" : "dir");
    const generationA = '<!doctype html><p>isolated generation A</p>';
    const generationB = '<!doctype html><p>isolated generation B</p>';
    const htmlPath = path.join(plugin, "public", "canvas-app.html");
    await fs.writeFile(htmlPath, generationA);
    const pluginUrl = pathToFileURL(plugin + path.sep);
    client = createMcpClient(pluginUrl, env);
    const resourceA = (await client.request("resources/list")).resources[0];
    const read = uri => client.request("resources/read", { uri }).then(result => result.contents[0].text);
    const library = action => client.request("tools/call", { name: "canvas_library", arguments: { action } }).then(result => result.structuredContent);
    assert.equal(await read(resourceA.uri), generationA);
    const list = await library("list"), bootstrap = await library("bootstrap");
    const revisionA = crypto.createHash("sha256").update(generationA).digest("hex").slice(0, 12);
    assert.equal(bootstrap.runtimeRevision, revisionA);
    assert.equal(list.runtimeRevision, revisionA);
    assert.ok(resourceA.uri.includes(revisionA));
    const tools = (await client.request("tools/list")).tools;
    assert.deepEqual(bootstrap.libraryActions, tools.find(tool => tool.name === "canvas_library").inputSchema.properties.action.enum);
    assert.deepEqual(list.libraryActions, bootstrap.libraryActions);
    for (const action of ["trash", "restore", "delete-permanently"]) assert.ok(bootstrap.libraryActions.includes(action));
    await fs.writeFile(htmlPath, generationB);
    const savedUri = "ui://codex-canvas/canvas-0.4.0-000000000000.html";
    assert.equal(await read(resourceA.uri), generationA, "An in-place update must not replace a running handler's UI");
    assert.equal(await read(savedUri), generationA, "Historical aliases must use the same process snapshot");
    assert.equal((await library("bootstrap")).runtimeRevision, revisionA);
    await client.close(); client = createMcpClient(pluginUrl, env);
    const resourceB = (await client.request("resources/list")).resources[0];
    assert.notEqual(resourceB.uri, resourceA.uri);
    assert.equal(await read(resourceB.uri), generationB);
    assert.equal(await read(resourceA.uri), generationB, "A fresh process may reopen a saved widget with its current snapshot");
    assert.equal((await library("bootstrap")).runtimeRevision, crypto.createHash("sha256").update(generationB).digest("hex").slice(0, 12));
  } finally {
    await client?.close();
    await fs.rm(modules, { force: true });
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test("new canvas center refuses unsupported deletion before calling an old MCP", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined });
  try {
    const page = await browser.newPage({ locale: "zh-CN" });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<div id="center"></div>');
    const settings = await fs.readFile(path.join(sourceRoot, "public", "home-settings.js"), "utf8");
    const settingsUrl = "data:text/javascript;base64," + Buffer.from(settings).toString("base64");
    const source = (await fs.readFile(path.join(sourceRoot, "public", "canvas-center.js"), "utf8")).replace("./home-settings.js", settingsUrl);
    await page.evaluate(async moduleUrl => {
      const { showProjectCanvasCenter } = await import(moduleUrl);
      window.runtimeCalls = [];
      await showProjectCanvasCenter({
        container: document.querySelector("#center"), threadId: "isolated-old-runtime", isBound: () => false, onOpen: () => {}, autoOpen: false,
        groupBoards: data => data.boards.length ? [{ root: "C:/fixture/project", boards: data.boards }] : [],
        call: async args => {
          window.runtimeCalls.push(args);
          if (args.action !== "bootstrap") throw new Error("Unknown canvas library action.");
          return { structuredContent: { boards: [{ id: "active-fixture", title: "测试空白画布", projectDir: "C:/fixture/project", updatedAt: "2026-10-23T01:00:00Z" }], trash: [{ id: "trash-fixture", title: "回收站测试画布", projectDir: "C:/fixture/project", trashedAt: "2026-10-23T02:00:00Z" }], threads: [] } };
        }
      });
    }, "data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    const warning = page.locator(".center-runtime-notice");
    assert.equal(await warning.isVisible(), true);
    assert.match(await warning.textContent(), /完整退出并重新打开 Codex/);
    await page.getByRole("searchbox", { name: "搜索画布" }).fill("fixture");
    await page.locator('[data-canvas-id="active-fixture"]').click({ button: "right" });
    const trash = page.getByRole("menuitem", { name: "移到回收站", exact: true });
    assert.equal(await trash.isDisabled(), true);
    await trash.dispatchEvent("click"); // Also exercise the final handler guard.
    await page.locator('[data-center-view="trash"]').click();
    for (const name of ["恢复画布", "永久删除…"]) {
      await page.locator('[data-canvas-id="trash-fixture"]').click({ button: "right" });
      const item = page.getByRole("menuitem", { name, exact: true });
      assert.equal(await item.isDisabled(), true);
      await item.dispatchEvent("click");
    }
    assert.equal(await page.locator(".center-confirm-dialog").evaluate(dialog => dialog.open), false);
    assert.deepEqual(await page.evaluate(() => window.runtimeCalls.filter(call => call.action !== "app-update-status").map(call => call.action)), ["bootstrap"], "No unsupported write may reach the MCP");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
