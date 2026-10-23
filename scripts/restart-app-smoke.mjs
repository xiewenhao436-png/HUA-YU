import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMcpClient } from "./mcp-app-client.mjs";
import { mountApp } from "./app-test-host.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-restart-ui-"));
const env = { CODEX_CANVAS_LIBRARY_PATH: path.join(root, "library.json"), CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(root, "projects.json"), CODEX_CANVAS_DISABLE_THREAD_DISCOVERY: "1" };
const pluginRoot = process.env.CODEX_CANVAS_TEST_ROOT ? pathToFileURL(path.resolve(process.env.CODEX_CANVAS_TEST_ROOT) + path.sep) : undefined;
let client = createMcpClient(pluginRoot, env);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined });
const call = (name, args) => client.request("tools/call", { name, arguments: args });
let loseWriteAcknowledgement = false;
const adapter = { async request(...args) {
  const result = await client.request(...args);
  if (loseWriteAcknowledgement && args[1]?.name === "canvas_app_request" && args[1]?.arguments?.method === "POST") {
    loseWriteAcknowledgement = false;
    throw new Error("MCP connection closed.");
  }
  return result;
} };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8hgGAAAAABJRU5ErkJggg==";
const summary = [];
try {
  const opened = await call("open_canvas", { projectDir: path.join(root, "board"), threadId: "restart-owner" });
  await call("add_image", { projectDir: path.join(root, "board"), threadId: "restart-owner", dataUrl: `data:image/png;base64,${png}`, name: "saved-before-reboot.png" });
  const resource = (await client.request("resources/list")).resources[0];
  const html = (await client.request("resources/read", { uri: resource.uri })).contents[0].text;
  const stopped = client;
  client = createMcpClient(pluginRoot, env);
  await stopped.close();
  const page = await browser.newPage({ viewport: { width: 1000, height: 780 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const frame = await mountApp(page, adapter, { opened, html });
  try {
    await frame.waitForFunction(() => document.querySelector("#canvasConnection")?.style.display === "none" && [...document.querySelectorAll("#objects img")].some(img => img.naturalWidth === 1), null, { timeout: 10000 });
  } catch (error) {
    console.log(JSON.stringify({ phase: "reopen-after-real-process-restart", overlay: await frame.locator("#canvasConnection").textContent(), imageCount: await frame.locator("#objects img").count(), errors }, null, 2));
    throw error;
  }
  const freshId = await frame.evaluate(() => window.codexCanvasApp.scope.sessionId);
  assert.notEqual(freshId, opened._meta.canvasSession.sessionId, "Old transport id must be replaced after restarting the MCP process");
  // Hosts can replay an old result after the new connection is already ready.
  await page.evaluate(opened => document.querySelector("iframe").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: opened }, "*"), opened);
  await frame.evaluate(() => window.codexCanvasApp.fetch(`/api/state?project=${window.codexCanvasApp.scope.projectId}`).then(response => { if (!response.ok) throw new Error("State reload failed"); }));
  assert.equal(await frame.evaluate(() => window.codexCanvasApp.scope.sessionId), freshId, "Delayed replay must not overwrite the recovered transport id");
  summary.push({ restoredAfterProcessRestart: true, ignoredOldReplay: true });

  // A second chat has an independent MCP process and reuses persisted board data.
  const parallel = createMcpClient(pluginRoot, env);
  const secondPage = await browser.newPage();
  try {
    const second = await mountApp(secondPage, parallel, { opened, html });
    await second.waitForFunction(() => [...document.querySelectorAll("#objects img")].some(img => img.naturalWidth === 1), null, { timeout: 10000 });
    assert.equal(await second.evaluate(() => window.codexCanvasApp.scope.boardId), opened._meta.canvasSession.boardId);
    assert.equal(await secondPage.evaluate(() => window.chatMessages.length), 0);
    summary.push({ independentChatProcess: true });
  } finally { await secondPage.close(); await parallel.close(); }

  // An already open panel also survives a backend restart without a chat turn.
  const replaced = client;
  client = createMcpClient(pluginRoot, env);
  await replaced.close();
  await frame.evaluate(() => window.codexCanvasApp.onScopeChange());
  await frame.waitForFunction(() => document.querySelector("#canvasConnection").style.display === "none" && [...document.querySelectorAll("#objects img")].some(img => img.naturalWidth === 1), null, { timeout: 10000 });
  assert.notEqual(await frame.evaluate(() => window.codexCanvasApp.scope.sessionId), freshId);
  assert.equal(await page.evaluate(() => window.chatMessages.length), 0);
  assert.deepEqual(errors, []);
  summary.push({ liveBackendRestart: true, chatTurns: 0, errors });
  // Concurrent reads and a write all see an explicitly expired transport id.
  // Recovery is shared, and the write runs once on its original board.
  const preMutation = client;
  client = createMcpClient(pluginRoot, env);
  await preMutation.close();
  const results = await frame.evaluate(async () => {
    const responses = await Promise.all([
      window.codexCanvasApp.fetch("/api/state"),
      window.codexCanvasApp.fetch("/api/state"),
      window.codexCanvasApp.fetch("/api/objects", { method: "POST", body: JSON.stringify({ type: "text", text: "Only once after reconnect", x: 10, y: 10 }) })
    ]);
    return responses.map(r => r.status);
  });
  assert.deepEqual(results, [200, 200, 201]);
  const latest = await call("canvas_library", { action: "open", boardId: opened._meta.canvasSession.boardId });
  const state = (await call("canvas_app_request", { sessionId: latest._meta.canvasSession.sessionId, path: "/api/state" })).structuredContent.body;
  assert.equal(state.objects.filter(o => o.text === "Only once after reconnect").length, 1);
  await assert.rejects(call("canvas_app_request", { sessionId: latest._meta.canvasSession.sessionId, path: "/api/state?threadId=other-chat" }), /scope mismatch/);
  summary.push({ concurrentRecovery: true, writeExactlyOnce: true, originalScopePreserved: true });
  loseWriteAcknowledgement = true;
  const lostResult = await frame.evaluate(async () => {
    try { await window.codexCanvasApp.fetch("/api/objects", { method: "POST", body: JSON.stringify({ type: "text", text: "Lost acknowledgement", x: 20, y: 20 }) }); }
    catch (error) { return error.message; }
  });
  assert.match(lostResult, /确认刚才的操作结果/);
  const persisted = (await call("canvas_app_request", { sessionId: latest._meta.canvasSession.sessionId, path: "/api/state" })).structuredContent.body;
  assert.equal(persisted.objects.filter(o => o.text === "Lost acknowledgement").length, 1, "A write with a lost acknowledgement must not be duplicated");
  assert.equal(await page.evaluate(() => window.chatMessages.length), 0);
  summary.push({ lostWriteAcknowledgementNotReplayed: true });
  console.log(JSON.stringify(summary, null, 2));
} finally { await browser.close(); await client.close(); await fs.rm(root, { recursive: true, force: true }); }
