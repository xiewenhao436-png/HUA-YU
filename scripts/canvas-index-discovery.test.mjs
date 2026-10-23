// Cross-platform discovery fixtures: only disposable databases and board metadata.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { canvasIdForThread } from "../src/runtime.mjs";
import { updateLibraryIndex } from "../src/canvas-index.mjs";
const execFileAsync = promisify(execFile);
const indexUrl = new URL("../src/canvas-index.mjs", import.meta.url).href;

test("Windows index replacement retries sharing violations without deleting the saved index", { skip: process.platform !== "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "huayu-index-sharing-"));
  const file = path.join(root, "library.json"), previousPath = process.env.CODEX_CANVAS_LIBRARY_PATH;
  const initial = { version: 2, boards: [], tombstones: [], lastByThread: { retained: "saved-board" } };
  const originalRename = fs.rename;
  process.env.CODEX_CANVAS_LIBRARY_PATH = file;
  await fs.writeFile(file, JSON.stringify(initial));
  let attempts = 0, permanentlyBlocked = false;
  try {
    fs.rename = async (source, destination) => {
      if (destination !== file) return originalRename(source, destination);
      attempts++;
      assert.equal(JSON.parse(await fs.readFile(file, "utf8")).lastByThread.retained, "saved-board", "The original destination remains readable throughout retries");
      if (permanentlyBlocked || attempts < 3) throw Object.assign(new Error("Synthetic Windows sharing violation"), { code: "EPERM" });
      return originalRename(source, destination);
    };
    await updateLibraryIndex(data => { data.lastByThread.added = "new-board"; });
    assert.equal(attempts, 3);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).lastByThread.added, "new-board");
    attempts = 0; permanentlyBlocked = true;
    await assert.rejects(updateLibraryIndex(data => { data.lastByThread.added = "must-not-replace"; }), { code: "EPERM" });
    assert.equal(attempts, 8, "Permanent failures stop after a bounded number of attempts");
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).lastByThread.added, "new-board");
    assert.deepEqual(await fs.readdir(root), ["library.json"], "A failed write releases its lock and removes only its own temporary file");
  } finally {
    fs.rename = originalRename;
    if (previousPath === undefined) delete process.env.CODEX_CANVAS_LIBRARY_PATH; else process.env.CODEX_CANVAS_LIBRARY_PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const withOptionalColumns of [true, false]) {
  test(`SQLite chat discovery keeps cwd and discovers task boards (${withOptionalColumns ? "current" : "legacy"} schema)`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "huayu-discovery-"));
    const home = path.join(root, "isolated codex home"), project = path.join(root, "项目 with spaces");
    const threadId = "12345678-1234-4234-8234-123456789012";
    const canvasId = canvasIdForThread(threadId);
    const boardProject = path.join(project, "_codex", "20261023-storyboard");
    const boardDir = path.join(boardProject, "canvas", "threads", canvasId);
    try {
      await fs.mkdir(home, { recursive: true });
      await fs.mkdir(boardDir, { recursive: true });
      await fs.writeFile(path.join(boardDir, "codex-canvas.json"), JSON.stringify({
        version: 1, title: "发现已有分镜", objects: [{ id: "preview", type: "image", src: "/assets/fixture.png" }]
      }));
      // Metadata discovery must choose the newest numeric database, not a string sort.
      const older = new DatabaseSync(path.join(home, "state_2.sqlite"));
      older.exec("CREATE TABLE unrelated (id TEXT)"); older.close();
      const db = new DatabaseSync(path.join(home, "state_12.sqlite"));
      try {
        db.exec(`CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, updated_at INTEGER, archived INTEGER${withOptionalColumns ? ", name TEXT, agent_path TEXT" : ""})`);
        const insert = db.prepare(`INSERT INTO threads VALUES (${Array(withOptionalColumns ? 7 : 5).fill("?").join(",")})`);
        const row = (id, archived, agentPath = "/root") => [id, project, "原始会话标题", 1780000000, archived, ...(withOptionalColumns ? ["用户命名会话", agentPath] : [])];
        insert.run(...row(threadId, 0)); insert.run(...row("archived-thread", 1));
        if (withOptionalColumns) insert.run(...row("child-worker", 0, "/root/worker"));
      } finally { db.close(); }
      const env = { ...process.env, CODEX_HOME: home, CODEX_CANVAS_LIBRARY_PATH: path.join(root, "library.json"), CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(root, "projects.json") };
      delete env.CODEX_CANVAS_DISABLE_THREAD_DISCOVERY; delete env.CODEX_CANVAS_THREADS_FILE;
      const source = `const {localThreads,listCanvases}=await import(${JSON.stringify(indexUrl)}); const threads=await localThreads(true); const data=await listCanvases({refresh:true}); console.log(JSON.stringify({threads,boards:data.boards}));`;
      const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], { env, windowsHide: true });
      const result = JSON.parse(stdout);
      assert.equal(result.threads.length, 1, "Archived chats and child workers are excluded");
      assert.equal(result.threads[0].cwd, project, "SQLite discovery preserves the project directory on macOS, Linux and Windows");
      assert.equal(result.threads[0].title, withOptionalColumns ? "用户命名会话" : "原始会话标题");
      assert.equal(result.boards.length, 1, "A board is discovered from a known project without an existing registry");
      assert.equal(result.boards[0].projectDir, boardProject);
      assert.equal(result.boards[0].threadId, threadId);
      assert.equal(result.boards[0].imageCount, 1);
      assert.equal(result.boards[0].threadTitle, result.threads[0].title);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
