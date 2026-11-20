// Browser smoke using an isolated library and disposable fixture boards.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { mountApp } from "./app-test-host.mjs";
import { createMcpClient } from "./mcp-app-client.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-center-rating-ui-"));
const cwd = path.join(root, "视觉策划");
const definitions = [
  { id: "scene", title: "展厅序章｜空间气氛", importance: 0 },
  { id: "rhythm", title: "品牌短片｜镜头节奏", importance: 3 },
  { id: "palette", title: "山水体验｜色彩参考", importance: 5 }
];
const env = {
  CODEX_CANVAS_LIBRARY_PATH: path.join(root, "library.json"),
  CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(root, "projects.json"),
  CODEX_CANVAS_THREADS_FILE: path.join(root, "threads.json"),
  CODEX_CANVAS_DISABLE_THREAD_DISCOVERY: "1"
};
const artifactDir = path.resolve(process.env.CANVAS_TEST_ARTIFACT_DIR || "dist/test-ui");
const pluginRoot = process.env.CODEX_CANVAS_TEST_ROOT ? pathToFileURL(path.resolve(process.env.CODEX_CANVAS_TEST_ROOT) + path.sep) : undefined;
const client = createMcpClient(pluginRoot, env);
const call = (name, args) => client.request("tools/call", { name, arguments: args });
const library = async args => (await call("canvas_library", args)).structuredContent;
const ids = new Map();

function fixtureImage(index) {
  const image = new PNG({ width: 480, height: 270 });
  const palettes = [
    [[237, 225, 206], [205, 146, 103], [139, 93, 78], [69, 60, 70]],
    [[240, 216, 218], [206, 132, 151], [135, 74, 103], [84, 47, 77]],
    [[209, 228, 221], [125, 178, 174], [73, 134, 144], [39, 86, 108]]
  ];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const ridge = Math.sin(x / 104 + index) * 42 + Math.sin(x / 37) * 13;
      const coloring = palettes[index];
      const layer = y > 223 + ridge * 0.6 ? 3 : y > 171 - ridge * 0.8 ? 2 : y > 128 + ridge ? 1 : 0;
      const sun = Math.hypot(x - 365 + index * 107, y - 71) < 25;
      image.data.set([...(sun && !layer ? [254, 244, 204] : coloring[layer]), 255], (y * image.width + x) * 4);
    }
  }
  return PNG.sync.write(image).toString("base64");
}

function card(frame, id) {
  return frame.locator('article[data-canvas-id="' + ids.get(id) + '"]');
}

async function expectRating(frame, id, value) {
  const group = card(frame, id).locator(".center-card-rating");
  await group.waitFor({ state: "visible" });
  const buttons = group.locator("button[data-rating]");
  const state = await buttons.evaluateAll(elements => elements.map(button => ({
    rating: Number(button.dataset.rating),
    pressed: button.getAttribute("aria-pressed"),
    lit: button.classList.contains("is-lit")
  })));
  assert.deepEqual(state, [1, 2, 3, 4, 5].map(rating => ({
    rating,
    pressed: String(rating === value),
    lit: rating <= value
  })));
}

async function changeRating(frame, id, value, perform) {
  await perform();
  await frame.waitForFunction(({ boardId, rating }) => {
    const buttons = document.querySelectorAll('article[data-canvas-id="' + boardId + '"] .center-card-rating button[data-rating]');
    return buttons.length === 5 && Array.from(buttons).filter(button => button.classList.contains("is-lit")).length === rating;
  }, { boardId: ids.get(id), rating: value });
  await expectRating(frame, id, value);
  const index = JSON.parse(await fs.readFile(env.CODEX_CANVAS_LIBRARY_PATH, "utf8"));
  assert.equal(index.boards.find(board => board.id === ids.get(id)).importance, value);
  assert.equal(await frame.locator("#canvasConnection.canvas-center").isVisible(), true, "Rating keeps the Canvas Center open");
}

let browser;
try {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(env.CODEX_CANVAS_THREADS_FILE, JSON.stringify(definitions.map(definition => ({ ...definition, cwd }))));
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined });
  for (const [index, definition] of definitions.entries()) {
    const projectDir = path.join(cwd, "_codex", "fixture-" + definition.id, "work", "board");
    const opened = await call("open_canvas", { projectDir, threadId: definition.id });
    const { sessionId, boardId } = opened._meta.canvasSession;
    ids.set(definition.id, boardId);
    await call("canvas_app_request", { sessionId, path: "/api/state", method: "POST", body: { title: definition.title } });
    await call("add_image", { projectDir, threadId: definition.id, name: definition.title, dataUrl: "data:image/png;base64," + fixtureImage(index), imagegenPrompt: "Synthetic browser fixture." });
    if (definition.importance) await library({ action: "importance", boardId, importance: definition.importance });
  }

  const resource = (await client.request("resources/list")).resources[0];
  const html = (await client.request("resources/read", { uri: resource.uri })).contents[0].text;
  for (const width of [1100, 440]) {
    const page = await browser.newPage({ locale: "zh-CN", viewport: { width, height: 850 }, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const opened = await call("open_canvas", { threadId: "unbound-rating-" + width });
    const frame = await mountApp(page, client, { opened, html });
    await frame.locator("[data-center-project]").filter({ hasText: "视觉策划" }).click();
    await frame.waitForFunction(() => document.querySelectorAll("article[data-canvas-id]").length === 3);
    await expectRating(frame, "scene", 0);
    await expectRating(frame, "rhythm", width === 1100 ? 3 : 4);
    await expectRating(frame, "palette", 5);
    assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Canvas Center fits the viewport");
    for (const star of await card(frame, "rhythm").locator(".center-card-rating button").all()) {
      await star.scrollIntoViewIfNeeded();
      assert.equal(await star.evaluate(button => {
        const rect = button.getBoundingClientRect();
        const card = button.closest("article").getBoundingClientRect();
        return rect.width >= 20 && rect.height >= 20 && rect.right <= card.right && rect.bottom <= card.bottom &&
          rect.left >= card.left + card.width / 2 &&
          button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }), true, "Each star has a reachable hitbox in the right half of the card");
    }
    if (width === 1100) {
      for (const preview of await frame.locator("[data-preview-board]").all()) {
        await preview.scrollIntoViewIfNeeded();
        const image = preview.locator("img");
        await image.waitFor();
        await image.evaluate(element => element.decode());
      }
    }
    if (width === 1100) await page.screenshot({ path: path.join(artifactDir, "canvas-card-rating.png") });

    const rating = value => card(frame, "rhythm").locator('button[data-rating="' + value + '"]');
    await changeRating(frame, "rhythm", 2, () => rating(2).click());
    await card(frame, "rhythm").click({ button: "right" });
    const oldRating = frame.getByRole("menuitem", { name: "2 星 ✓", exact: true });
    await oldRating.waitFor({ state: "visible" });
    await changeRating(frame, "rhythm", 4, () => frame.getByRole("menuitem", { name: "4 星", exact: true }).click());
    await changeRating(frame, "rhythm", 0, () => rating(4).click());
    if (width === 1100) await changeRating(frame, "rhythm", 4, () => rating(4).click());
    await expectRating(frame, "palette", 5);
    await expectRating(frame, "scene", 0);
    assert.equal(await page.evaluate(() => window.chatMessages.length), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  const refreshed = await library({ action: "list", refresh: true });
  assert.equal(refreshed.boards.find(board => board.id === ids.get("rhythm")).importance, 0);
  console.log(JSON.stringify({ widths: [1100, 440], existingAndUnset: true, cardAndMenu: true, activeStarClears: true, persistedAcrossViewsAndRefresh: true }));
} finally {
  await browser?.close();
  await client.close();
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(root, { recursive: true, force: true });
}
