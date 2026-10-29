import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { addImage, addJobPlaceholder, readState } from "../src/store.mjs";
import { placeImportedElementLayersForTest } from "../src/jobs.mjs";

// Fail before image integration, so these tests need neither Python nor a real
// Codex/image service. They exercise the actual background-task lifetime.
test("background completion releases its running state on startup and process failures", { timeout: 8000 }, async (t) => {
  await t.test("image-model misconfiguration fails before spawn without blocking later work", async () => {
    await withFixture("gpt-image-2.5", async (fixture) => {
      await fixture.start();
      assert.equal(fixture.job.backgroundCompletionRunning, false);
      await fixture.assertPreserved();
      await assert.rejects(fs.access(fixture.invocations), { code: "ENOENT" });
      const log = await fs.readFile(fixture.job.logPath, "utf8");
      assert.match(log, /execution model, not the image model/);
    });
  });

  await t.test("a failed CLI leaves existing layers intact and stops output polling", async () => {
    await withFixture("", async (fixture) => {
      await fixture.start();
      assert.equal(fixture.job.backgroundCompletionRunning, false);
      await fixture.assertPreserved();
      assert.equal((await fs.readFile(fixture.invocations, "utf8")).trim().split(/\r?\n/).length, 1);
      const log = await fs.readFile(fixture.job.logPath, "utf8");
      assert.match(log, /background completion failed/i);
      assert.match(log, /fixture background failure/);
    });
  });
});

async function withFixture(backgroundModel, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "huayu-background-failure-"));
  const projectDir = path.join(root, "project with spaces");
  const outputDir = path.join(projectDir, "job-output");
  const layersDir = path.join(outputDir, "elements");
  const executable = path.join(root, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
  const invocations = path.join(root, "invocations.txt");
  const scope = { canvasId: "background-failure-fixture" };
  const settings = {
    CODEX_CANVAS_TEST_HELPERS: "1",
    CODEX_CANVAS_CODEX_CLI: executable,
    CODEX_CANVAS_CODEX_MODEL: "",
    CODEX_CANVAS_CODEX_MODEL_EDIT_ELEMENTS_BACKGROUND: backgroundModel,
    CODEX_CANVAS_LIBRARY_PATH: path.join(root, "library.json"),
    CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(root, "projects.json"),
    CODEX_CANVAS_DISABLE_THREAD_DISCOVERY: "1",
    HUAYU_BACKGROUND_TEST_INVOCATIONS: invocations
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, settings);
    await fs.mkdir(layersDir, { recursive: true });
    await writeNodeExecutable(executable, [
      'import fs from "node:fs";',
      'fs.readFileSync(0, "utf8");',
      'fs.appendFileSync(process.env.HUAYU_BACKGROUND_TEST_INVOCATIONS, "started\\n");',
      'console.error("fixture background failure");',
      'process.exitCode = 9;'
    ].join("\n"));
    const sourcePath = path.join(root, "source.png");
    const backgroundPath = path.join(layersDir, "element-01-background.png");
    await fs.writeFile(sourcePath, png([230, 70, 30, 255]));
    await fs.writeFile(backgroundPath, png([245, 245, 245, 0]));
    const source = await addImage(projectDir, { path: sourcePath, name: "source.png" }, scope);
    const background = await addImage(projectDir, { path: backgroundPath, name: "element-01-background.png" }, scope);
    const placeholder = await addJobPlaceholder(projectDir, {
      id: "background-failure-placeholder", action: "edit-elements", status: "running",
      sourceObjectId: source.id, width: 8, height: 8, x: 100, y: 100
    }, scope);
    const manifestPath = path.join(layersDir, "elements-manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify({
      sourceSize: { width: 8, height: 8 }, backgroundCompleted: false,
      layers: [{ index: 0, kind: "background", path: backgroundPath, bbox: [0, 0, 8, 8], areaPixels: 64 }]
    }));
    const originalSource = hash(await fs.readFile(source.assetPath));
    const originalBackground = hash(await fs.readFile(background.assetPath));
    const job = {
      id: "background-failure-contract", action: "edit-elements", projectDir,
      canvasId: scope.canvasId, sourceObjectId: source.id, imagePath: source.assetPath,
      outputDir, logPath: path.join(projectDir, "job.log"), placeholder,
      placeholderId: placeholder.id, imported: [background], backgroundCompletionRunning: false
    };
    await run({
      job, invocations,
      async start() {
        await placeImportedElementLayersForTest(projectDir, job);
        assert.ok(job.backgroundCompletionPromise, "The placement must schedule its existing background pass");
        await job.backgroundCompletionPromise;
      },
      async assertPreserved() {
        const state = await readState(projectDir, scope);
        const savedBackground = state.objects.find((object) => object.id === background.id);
        assert.equal(savedBackground.layerGroupBackgroundStatus, "failed");
        assert.equal(state.objects.some((object) => object.id === source.id), true);
        assert.equal(state.objects.some((object) => object.id === placeholder.id), false);
        assert.equal(hash(await fs.readFile(source.assetPath)), originalSource);
        assert.equal(hash(await fs.readFile(background.assetPath)), originalBackground);
        assert.equal(JSON.parse(await fs.readFile(manifestPath, "utf8")).backgroundCompleted, false);
      }
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
}

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function png(color) {
  const image = new PNG({ width: 8, height: 8 });
  for (let offset = 0; offset < image.data.length; offset += 4) image.data.set(color, offset);
  return PNG.sync.write(image);
}
async function writeNodeExecutable(executable, source) {
  const script = executable + ".mjs";
  await fs.writeFile(script, source);
  if (process.platform === "win32") {
    await fs.writeFile(executable, `@echo off\r\n"${process.execPath}" "%~dp0${path.basename(script)}" %*\r\n`);
  } else {
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  }
}
