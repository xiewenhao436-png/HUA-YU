import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpClient } from "./mcp-app-client.mjs";
import { recordCanvas, readLibraryIndex, boardIdFor, normalizePhysicalPath, listCanvases, assertBoardAvailable } from "../src/canvas-index.mjs";
import { trashBoard, restoreBoard, permanentlyDeleteBoard } from "../src/canvas-trash.mjs";
import { statePathFor, assetsDirFor } from "../src/paths.mjs";
import { createOperationLease } from "../src/operation-leases.mjs";
import { canvasIdForThread } from "../src/runtime.mjs";
import { createServer } from "../src/server.mjs";
import { addImage, addObject, ensureProjectStore, writeState } from "../src/store.mjs";
import { withCanvasWriteLock } from "../src/canvas-write-lock.mjs";
const pngData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("Recycle bin is durable, alias-safe and deletes only the confirmed board scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-trash-test-"));
  const env = { CODEX_CANVAS_LIBRARY_PATH: path.join(root, "library.json"), CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(root, "projects.json"), CODEX_CANVAS_THREADS_FILE: path.join(root, "threads.json"), CODEX_CANVAS_DISABLE_THREAD_DISCOVERY: "1" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  await fs.writeFile(env.CODEX_CANVAS_THREADS_FILE, "[]");
  let client = createMcpClient(undefined, env), peer, browserServer;
  let call = (name, args) => client.request("tools/call", { name, arguments: args });
  const library = async args => (await call("canvas_library", args)).structuredContent;
  const project = path.join(root, "project");
  await fs.mkdir(project);
  async function fixture(dir, canvasId, title = "Fixture") {
    const assets = assetsDirFor(dir, canvasId);
    await fs.mkdir(assets, { recursive: true });
    await fs.writeFile(path.join(assets, "original.png"), "synthetic fixture image bytes");
    await fs.writeFile(statePathFor(dir, canvasId), JSON.stringify({ title, objects: [{ id: "image-1", type: "image", src: "/assets/original.png", assetPath: path.join(assets, "original.png"), width: 20, height: 20 }] }));
    return recordCanvas({ projectDir: dir, canvasId, title, threadTitle: "创作会话" });
  }
  try {
    const threadId = "trash-test-thread", canvasId = canvasIdForThread(threadId);
    const id = await fixture(project, canvasId, "应完整恢复的画布");
    const stateBefore = await fs.readFile(statePathFor(project, canvasId));
    const opened = await call("canvas_library", { action: "open", boardId: id });
    peer = createMcpClient(undefined, env);
    const peerOpened = await peer.request("tools/call", { name: "canvas_library", arguments: { action: "open", boardId: id } });
    assert.equal((await library({ action: "list" })).boards.length, 1);
    await assert.rejects(library({ action: "delete-permanently", boardId: id, confirmed: true }), /回收站/);
    const trashed = await library({ action: "trash", boardId: id });
    assert.ok(trashed.trashedAt);
    assert.deepEqual(await fs.readFile(statePathFor(project, canvasId)), stateBefore, "Soft delete never modifies state or files");
    let data = await library({ action: "list", refresh: true });
    assert.equal(data.boards.length, 0); assert.equal(data.trash.length, 1);
    assert.equal(data.trash[0].title, "应完整恢复的画布"); assert.equal(data.trash[0].imageCount, 1);
    await assert.rejects(library({ action: "open", boardId: id }), /不存在/);
    await assert.rejects(library({ action: "browse", boardId: id }), /不存在/);
    await assert.rejects(library({ action: "asset", boardId: id, objectId: "image-1" }), /不存在/);
    await assert.rejects(call("canvas_app_request", { sessionId: opened._meta.canvasSession.sessionId, path: "/api/state" }), /expired/);
    await assert.rejects(peer.request("tools/call", { name: "canvas_app_request", arguments: { sessionId: peerOpened._meta.canvasSession.sessionId, path: "/api/state" } }), /回收站|删除/);
    await assert.rejects(call("add_image", { projectDir: project, canvasId, dataUrl: "data:image/png;base64,AA==" }), /回收站|删除/);
    await assert.rejects(recordCanvas({ projectDir: project, canvasId }), /回收站|删除/);
    // Legacy registry and normal/extended Windows spellings cannot revive it.
    const alias = process.platform === "win32" ? path.toNamespacedPath(project).toUpperCase() : project;
    await fs.writeFile(env.CODEX_CANVAS_PROJECT_REGISTRY_PATH, JSON.stringify({ projects: [{ projectDir: alias, canvasId }] }));
    assert.equal((await library({ action: "list", refresh: true })).boards.length, 0);
    await assert.rejects(recordCanvas({ projectDir: alias, canvasId }), /回收站|删除/);
    assert.equal(normalizePhysicalPath("\\\\?\\C:\\Users\\Example\\Project"), normalizePhysicalPath("c:\\users\\example\\project"));
    assert.equal(normalizePhysicalPath("\\\\?\\UNC\\Host\\Share\\Board"), normalizePhysicalPath("\\\\host\\share\\board"));
    await client.close(); client = createMcpClient(undefined, env);
    call = (name, args) => client.request("tools/call", { name, arguments: args });
    data = await library({ action: "bootstrap", refresh: true });
    assert.equal(data.boards.length, 0); assert.equal(data.trash[0].id, id);
    await library({ action: "restore", boardId: id });
    assert.deepEqual(await fs.readFile(statePathFor(project, canvasId)), stateBefore);
    assert.equal((await library({ action: "list" })).boards[0].id, id);
    const reopened = await call("canvas_library", { action: "open", boardId: id });
    assert.ok(reopened._meta.canvasSession.sessionId);
    const lease = await createOperationLease("synthetic-test", { projectDir: project, canvasId });
    const chatLease = await createOperationLease("chat-turn", { projectDir: project, threadId });
    try {
      await library({ action: "trash", boardId: id });
      await assert.rejects(library({ action: "delete-permanently", boardId: id }), /确认/);
      await assert.rejects(library({ action: "delete-permanently", boardId: id, confirmed: false }), /确认/);
      await assert.rejects(library({ action: "delete-permanently", boardId: id, confirmed: true }), /操作进行/);
    }
    finally { await lease.release(); }
    try { await assert.rejects(library({ action: "delete-permanently", boardId: id, confirmed: true }), /操作进行/); }
    finally { await chatLease.release(); }
    await assert.rejects(createOperationLease("late-operation", { projectDir: project, canvasId }), /回收站|删除/);
    const lock = `${statePathFor(project, canvasId)}.lock`;
    await fs.mkdir(lock);
    try { await assert.rejects(library({ action: "delete-permanently", boardId: id, confirmed: true }), /保存/); }
    finally { await fs.rmdir(lock); }
    await library({ action: "delete-permanently", boardId: id, confirmed: true });
    await assert.rejects(fs.access(statePathFor(project, canvasId)));
    assert.equal((await library({ action: "list", refresh: true })).trash.length, 0);
    await assert.rejects(library({ action: "restore", boardId: id }), /没有/);
    // Even a stale writer recreating the old state is hidden by durable purge.
    await fs.mkdir(path.dirname(statePathFor(project, canvasId)), { recursive: true });
    await fs.writeFile(statePathFor(project, canvasId), stateBefore);
    assert.equal((await library({ action: "list", refresh: true })).boards.length, 0);
    await assert.rejects(recordCanvas({ projectDir: alias, canvasId }), /回收站|删除/);

    const shared = path.join(root, "shared"); await fs.mkdir(shared);
    const defaultId = await fixture(shared, null, "默认画布"), siblingId = await fixture(shared, "thread-sibling", "兄弟画布");
    await fs.writeFile(path.join(shared, "canvas", ".codex-canvas-runtime.json"), "shared metadata");
    await fs.writeFile(path.join(shared, "project-document.txt"), "preserve workspace");
    await trashBoard(defaultId); await permanentlyDeleteBoard(defaultId, { confirmed: true });
    assert.equal(await fs.readFile(path.join(shared, "canvas", ".codex-canvas-runtime.json"), "utf8"), "shared metadata");
    assert.equal(await fs.readFile(path.join(shared, "project-document.txt"), "utf8"), "preserve workspace");
    assert.equal((await listCanvases({ refresh: true })).boards.find(b => b.id === siblingId).title, "兄弟画布");
    await fs.access(path.join(assetsDirFor(shared, "thread-sibling"), "original.png"));
    const siblingState = await fs.readFile(statePathFor(shared, "thread-sibling"));
    const secondId = await fixture(shared, "second-thread");
    await trashBoard(secondId); await permanentlyDeleteBoard(secondId, { confirmed: true });
    assert.deepEqual(await fs.readFile(statePathFor(shared, "thread-sibling")), siblingState);

    const unsafe = path.join(root, "unsafe"), outside = path.join(root, "outside"); await fs.mkdir(unsafe); await fs.mkdir(outside);
    const unsafeId = await fixture(unsafe, "safe-board");
    await fs.writeFile(path.join(outside, "do-not-delete.txt"), "preserved");
    const link = path.join(assetsDirFor(unsafe, "safe-board"), "escape");
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await trashBoard(unsafeId);
    await assert.rejects(permanentlyDeleteBoard(unsafeId, { confirmed: true }), /链接|跳转/);
    assert.equal(await fs.readFile(path.join(outside, "do-not-delete.txt"), "utf8"), "preserved");
    await fs.access(statePathFor(unsafe, "safe-board"));
    await restoreBoard(unsafeId);
    const traversal = path.join(root, "traversal"); await fs.mkdir(traversal);
    const traversalId = await fixture(traversal, "..");
    await trashBoard(traversalId);
    await assert.rejects(permanentlyDeleteBoard(traversalId, { confirmed: true }), /不安全/);
    await fs.access(statePathFor(traversal, ".."));
    const index = await readLibraryIndex();
    assert.ok(index.tombstones.some(t => t.id === id && t.purgedAt));
    await assert.rejects(assertBoardAvailable(project, canvasId), /回收站|删除/);
    const browserProject = path.join(root, "browser"); await fs.mkdir(browserProject);
    const browserId = await fixture(browserProject, null);
    const browser = await createServer({ projectDir: browserProject, port: 0, autoCollect: false, persistentRegistryPath: path.join(root, "browser-registry.json") });
    browserServer = browser.server;
    const browserLibrary = async args => {
      const response = await fetch(new URL("/api/library", browser.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await browserLibrary({ action: "trash", boardId: browserId })).status, 200);
    assert.equal((await fetch(new URL("/api/state", browser.url))).status, 410);
    assert.equal((await (await fetch(new URL("/api/projects", browser.url))).json()).projects.some(p => p.projectDir === browserProject), false);
    assert.equal((await browserLibrary({ action: "list" })).body.trash.some(b => b.id === browserId), true);
    assert.equal((await browserLibrary({ action: "restore", boardId: browserId })).status, 200);
    assert.equal((await fetch(new URL("/api/state", browser.url))).status, 200);
    assert.equal((await browserLibrary({ action: "trash", boardId: browserId })).status, 200);
    assert.equal((await browserLibrary({ action: "delete-permanently", boardId: browserId })).status, 400);
    assert.equal((await browserLibrary({ action: "delete-permanently", boardId: browserId, confirmed: true })).status, 200);
    await assert.rejects(addImage(browserProject, { dataUrl: pngData }), /回收站|删除/);
    await assert.rejects(addObject(browserProject, { type: "text", text: "late" }), /回收站|删除/);
    await assert.rejects(ensureProjectStore(browserProject), /回收站|删除/);
    await assert.rejects(writeState(browserProject, { objects: [] }), /回收站|删除/);
    await assert.rejects(fs.access(statePathFor(browserProject)));

    const racing = path.join(root, "racing"); await fs.mkdir(racing);
    const racingId = await fixture(racing, "board");
    const originalMkdir = fs.mkdir;
    let reached, resume;
    const barrier = new Promise(resolve => { reached = resolve; });
    const proceed = new Promise(resolve => { resume = resolve; });
    fs.mkdir = async function(file, ...args) {
      if (path.resolve(file) === assetsDirFor(racing, "board")) { reached(); await proceed; }
      return originalMkdir.call(this, file, ...args);
    };
    let write, deleting;
    try {
      write = addImage(racing, { dataUrl: pngData }, { canvasId: "board" });
      await barrier;
      let deletionFinished = false;
      deleting = trashBoard(racingId).then(value => { deletionFinished = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(deletionFinished, false, "Trash waits for the complete asset/state mutation");
      resume(); await write; await deleting;
    } finally { resume(); fs.mkdir = originalMkdir; await write?.catch(() => {}); await deleting?.catch(() => {}); }
    await permanentlyDeleteBoard(racingId, { confirmed: true });
    await assert.rejects(addImage(racing, { dataUrl: pngData }, { canvasId: "board" }), /回收站|删除/);
    await assert.rejects(fs.access(path.dirname(statePathFor(racing, "board"))));

    const failure = path.join(root, "failure"); await fs.mkdir(failure);
    const failureId = await fixture(failure, "board");
    await fs.writeFile(path.join(assetsDirFor(failure, "board"), "a.png"), "a");
    const occupied = path.join(assetsDirFor(failure, "board"), "b.png"); await fs.writeFile(occupied, "b");
    const occupiedCanonical = await fs.realpath(occupied);
    await trashBoard(failureId);
    const originalUnlink = fs.unlink;
    fs.unlink = async function(file, ...args) { if (normalizePhysicalPath(file) === normalizePhysicalPath(occupiedCanonical)) throw Object.assign(new Error("Synthetic occupied asset"), { code: "EPERM" }); return originalUnlink.call(this, file, ...args); };
    try { await assert.rejects(permanentlyDeleteBoard(failureId, { confirmed: true }), /Synthetic occupied/); }
    finally { fs.unlink = originalUnlink; }
    const partial = (await listCanvases()).trash.find(b => b.id === failureId);
    assert.ok(partial.purgeStartedAt); assert.equal(partial.canRestore, false);
    await assert.rejects(restoreBoard(failureId), /不能恢复/);
    await client.close(); client = createMcpClient(undefined, env);
    call = (name, args) => client.request("tools/call", { name, arguments: args });
    await library({ action: "delete-permanently", boardId: failureId, confirmed: true });
    await assert.rejects(fs.access(path.dirname(statePathFor(failure, "board"))));

    let detached, resumeDetached, detachedRan = false;
    const detachedGate = new Promise(resolve => { resumeDetached = resolve; });
    await withCanvasWriteLock(racing, async () => {
      detached = (async () => { await detachedGate; await withCanvasWriteLock(racing, () => { detachedRan = true; }); })();
    });
    await withCanvasWriteLock(racing, async () => {
      resumeDetached(); await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(detachedRan, false, "Detached work cannot reuse an expired ALS lock token");
    });
    await detached; assert.equal(detachedRan, true);
    console.log("Verified: durable trash/restore/purge, restart, refresh/legacy tombstones, Windows aliases, session eviction, cross-process request guards, operation/save locks, default/sibling preservation, junction and traversal rejection.");
  } finally {
    await client.close(); await peer?.close();
    if (browserServer) await new Promise(resolve => browserServer.close(resolve));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
});
