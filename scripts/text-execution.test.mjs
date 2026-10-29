// Exercise the public Edit Text workflow with a fake Codex CLI; no image service
// or optional Python OCR/image dependencies are used by these fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { addImage, readState } from "../src/store.mjs";
import { createTextRecognitionJob, getTextRecognitionJob, submitTextRecognitionEdit } from "../src/jobs.mjs";

test("Edit Text uses short recognition and generation CLI executions", async (t) => {
  // Environment settings are shared in-process; keep these subtests sequential.
  await t.test("recognition exits while the user edits, then one generation is collected", async () => {
    await withFixture(async ({ projectDir, source, events, scope }) => {
      const sourceHash = hash(await fs.readFile(source.assetPath));
      const started = await createTextRecognitionJob(projectDir, { objectId: source.id }, scope);
      await waitForJob(started.id, scope, (job) => job.stage === "ready");
      const recognition = await waitFor(async () => (await events()).find((event) => event.type === "start"));
      assert.equal(recognition.kind, "recognition", "The first child must only recognize text, without an interactive file-polling session");
      await waitFor(async () => !isAlive(recognition.pid), "Recognition child must exit before waiting for the user's edit plan");
      await delay(1100); // Cover the old prompt's one-second model polling interval.
      assert.equal(getTextRecognitionJob(started.id, scope).stage, "ready");
      assert.equal((await events()).filter((event) => event.type === "start").length, 1, "No generation process may start before confirmation");

      await submitTextRecognitionEdit(projectDir, started.id, {
        action: "edit-text",
        changes: [{ index: 1, from: "旧标题", to: "新标题", location: "top center" }]
      }, scope);
      await assert.rejects(submitTextRecognitionEdit(projectDir, started.id, {
        action: "edit-text", changes: [{ from: "旧标题", to: "重复提交" }]
      }, scope), /not ready/i, "A repeated Run request must not start another generation");

      const done = await waitForJob(started.id, scope, (job) => job.status === "done");
      assert.equal(done.stage, "done");
      assert.equal(done.imported.length, 1);
      const state = await waitFor(async () => {
        const value = await readState(projectDir, scope);
        return value.objects.length === 2 && !value.objects.some((object) => object.type === "job") ? value : null;
      }, "The output must replace its placeholder while preserving the source");
      const imported = state.objects.find((object) => object.id !== source.id);
      assert.equal(imported.sourceObjectId, source.id);
      assert.ok(imported.x > source.x, "The result stays to the right of the source");
      assert.equal(hash(await fs.readFile(source.assetPath)), sourceHash, "The source image remains unchanged");
      assert.notEqual(hash(await fs.readFile(imported.assetPath)), sourceHash, "The distinct mock output was collected");

      const invocations = (await events()).filter((event) => event.type === "start");
      assert.deepEqual(invocations.map((event) => event.kind), ["recognition", "generation"]);
      assert.deepEqual(invocations[1].images, [source.assetPath]);
      assert.match(invocations[1].prompt, /旧标题/);
      assert.match(invocations[1].prompt, /新标题/);
      assert.doesNotMatch(invocations[1].prompt, /Poll for that file|Do not exit after recognition/);
    });
  });

  await t.test("cancelling a ready plan never launches image generation", async () => {
    await withFixture(async ({ projectDir, source, events, scope }) => {
      const started = await createTextRecognitionJob(projectDir, { objectId: source.id }, scope);
      await waitForJob(started.id, scope, (job) => job.stage === "ready");
      await submitTextRecognitionEdit(projectDir, started.id, { cancelled: true }, scope);
      const done = await waitForJob(started.id, scope, (job) => job.status === "done");
      assert.equal(done.stage, "cancelled");
      assert.deepEqual(done.imported, []);
      assert.deepEqual((await events()).filter((event) => event.type === "start").map((event) => event.kind), ["recognition"]);
      assert.deepEqual((await readState(projectDir, scope)).objects.map((object) => object.id), [source.id]);
    });
  });

  await t.test("cancelling during recognition stops the child without generating", async () => {
    await withFixture(async ({ projectDir, source, events, scope }) => {
      process.env.HUAYU_TEXT_TEST_RECOGNITION_DELAY = "2500";
      const started = await createTextRecognitionJob(projectDir, { objectId: source.id }, scope);
      const recognition = await waitFor(async () => (await events()).find((event) => event.type === "start"));
      await submitTextRecognitionEdit(projectDir, started.id, { cancelled: true }, scope);
      const done = await waitForJob(started.id, scope, (job) => job.status === "done");
      assert.equal(done.stage, "cancelled");
      await waitFor(async () => !isAlive(recognition.pid), "Cancellation must terminate recognition work");
      assert.deepEqual((await events()).filter((event) => event.type === "start").map((event) => event.kind), ["recognition"]);
      assert.deepEqual((await readState(projectDir, scope)).objects.map((object) => object.id), [source.id]);
    });
  });
});

async function withFixture(run) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "huayu-text-execution-"));
  const projectDir = path.join(fixture, "project with spaces");
  const executable = path.join(fixture, process.platform === "win32" ? "codex.cmd" : "codex");
  const eventPath = path.join(fixture, "cli-events.jsonl");
  const scope = { projectDir, canvasId: "text-execution-fixture" };
  const settings = {
    CODEX_CANVAS_CODEX_CLI: executable,
    CODEX_CANVAS_LOCAL_OCR: "0",
    CODEX_CANVAS_LIBRARY_PATH: path.join(fixture, "library.json"),
    CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(fixture, "projects.json"),
    CODEX_CANVAS_DISABLE_THREAD_DISCOVERY: "1",
    CODEX_CANVAS_GENERATED_IMAGES_ROOT: path.join(fixture, "generated-images"),
    HUAYU_TEXT_TEST_EVENTS: eventPath,
    HUAYU_TEXT_TEST_RESULT: path.join(fixture, "result.png"),
    HUAYU_TEXT_TEST_RECOGNITION_DELAY: "0"
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  const events = async () => {
    const text = await fs.readFile(eventPath, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  };
  try {
    Object.assign(process.env, settings);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(fixture, "source.png"), solidPng(210, 40, 30));
    await fs.writeFile(settings.HUAYU_TEXT_TEST_RESULT, solidPng(30, 80, 210));
    await writeNodeExecutable(executable, fakeCliSource);
    const source = await addImage(projectDir, { path: path.join(fixture, "source.png"), name: "source.png", x: 40, y: 60 }, scope);
    await run({ projectDir, source, events, scope });
  } finally {
    // Also clean up promptly when a regression fails while a fixture job is live.
    const { jobsDirFor } = await import("../src/paths.mjs");
    for (const name of await fs.readdir(jobsDirFor(projectDir, scope.canvasId)).catch(() => [])) {
      if (!name.startsWith("text_")) continue;
      try {
        const job = getTextRecognitionJob(name, scope);
        if (job.status === "running" || job.status === "queued") {
          await submitTextRecognitionEdit(projectDir, name, { cancelled: true }, scope);
          await waitForJob(name, scope, (value) => value.status === "done" || value.status === "failed");
        }
      } catch {}
    }
    for (const event of await events()) {
      if (event.type === "start" && isAlive(event.pid)) {
        try { process.kill(event.pid); } catch {}
        await waitFor(async () => !isAlive(event.pid), "Fixture CLI process cleanup").catch(() => {});
      }
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.ok(path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep), "Only remove the disposable fixture");
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

async function waitForJob(id, scope, condition) {
  return waitFor(async () => {
    const job = getTextRecognitionJob(id, scope);
    if (job.status === "failed") throw new Error(job.error || "Edit Text fixture failed");
    return condition(job) ? job : null;
  }, `Edit Text ${id} did not reach the expected state`);
}

async function waitFor(read, message = "Fixture state timed out", timeoutMs = 12_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    await delay(40);
  }
  throw new Error(message);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function solidPng(red, green, blue) {
  const png = new PNG({ width: 8, height: 8 });
  for (let offset = 0; offset < png.data.length; offset += 4) png.data.set([red, green, blue, 255], offset);
  return PNG.sync.write(png);
}

async function writeNodeExecutable(executable, source) {
  const script = `${executable}.mjs`;
  await fs.writeFile(script, source);
  if (process.platform === "win32") {
    await fs.writeFile(executable, `@echo off\r\n"${process.execPath}" "%~dp0${path.basename(script)}" %*\r\n`);
  } else {
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  }
}

const fakeCliSource = `
import fs from "node:fs";
import path from "node:path";
const prompt = fs.readFileSync(0, "utf8");
const outputDir = process.env.CODEX_CANVAS_JOB_OUTPUT_DIR;
const eventPath = process.env.HUAYU_TEXT_TEST_EVENTS;
const args = process.argv.slice(2);
const images = args.flatMap((arg, index) => arg === "--image" ? [args[index + 1]] : []);
const legacySession = /Do not exit after recognition|Poll for that file/.test(prompt);
const kind = legacySession ? "interactive-session" : prompt.includes("recognized-text.json") ? "recognition" : "generation";
const record = (type) => fs.appendFileSync(eventPath, JSON.stringify({ type, kind, pid: process.pid, args, images, prompt }) + "\\n");
record("start");
process.on("exit", () => record("exit"));
fs.mkdirSync(outputDir, { recursive: true });
if (kind === "recognition" || kind === "interactive-session") {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.HUAYU_TEXT_TEST_RECOGNITION_DELAY) || 0));
  fs.writeFileSync(path.join(outputDir, "recognized-text.json"), JSON.stringify({ items: [{ text: "旧标题", location: "top center", style: "bold", confidence: "high" }] }));
  if (legacySession) await new Promise((resolve) => {
    const timer = setInterval(() => { if (fs.existsSync(path.join(outputDir, "edit-plan.json"))) { clearInterval(timer); resolve(); } }, 100);
  });
} else {
  const result = path.join(outputDir, "edit-text-result.png");
  fs.copyFileSync(process.env.HUAYU_TEXT_TEST_RESULT, result);
  const now = new Date();
  fs.utimesSync(result, now, now);
}
`;
