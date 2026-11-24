import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PNG } from "pngjs";
import { copyBoardToProject } from "../src/canvas-copy.mjs";
import { knownBoard, recordCanvas } from "../src/canvas-index.mjs";
import { importBoardImages } from "../src/canvas-library.mjs";
import { createImageJob, getImageJob } from "../src/jobs.mjs";
import { addImage, readState } from "../src/store.mjs";

test("reference generation forwards ordered attachments and preserves canvas relationships", { timeout: 15000 }, async () => {
  const tempDir = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(tempDir, "huayu-reference-test-")));
  const project = path.join(root, "source");
  const target = path.join(root, "target");
  const trace = path.join(root, "worker.json");
  const fixtureOutput = path.join(root, "result.png");
  const executable = path.join(root, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
  const worker = executable + ".mjs";
  const environment = {
    CODEX_CANVAS_CODEX_CLI: executable,
    CODEX_CANVAS_CODEX_MODEL: "",
    CODEX_CANVAS_CODEX_MODEL_REFERENCE_GENERATE: "",
    CODEX_CANVAS_LIBRARY_PATH: path.join(root, "library.json"),
    CODEX_CANVAS_PROJECT_REGISTRY_PATH: path.join(root, "projects.json"),
    CODEX_CANVAS_DISABLE_THREAD_DISCOVERY: "1",
    HUAYU_REFERENCE_TRACE: trace,
    HUAYU_REFERENCE_OUTPUT: fixtureOutput
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, environment);
    await Promise.all([fs.mkdir(project), fs.mkdir(target)]);
    await fs.writeFile(fixtureOutput, png(200));
    await fs.writeFile(worker, [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const prompt = fs.readFileSync(0, "utf8");',
      'fs.writeFileSync(process.env.HUAYU_REFERENCE_TRACE, JSON.stringify({ prompt, args: process.argv.slice(2) }));',
      'const directory = prompt.match(/Copy the PNG into this exact directory: (.+)/)[1];',
      'fs.copyFileSync(process.env.HUAYU_REFERENCE_OUTPUT, path.join(directory, "reference-generate-result.png"));'
    ].join("\n"));
    if (process.platform === "win32") {
      await fs.writeFile(executable, `@echo off\r\n"${process.execPath}" "%~dp0${path.basename(worker)}" %*\r\n`);
    } else {
      await fs.writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${worker}" "$@"\n`, { mode: 0o755 });
    }

    const sourceScope = { canvasId: "reference-source" };
    const targetScope = { canvasId: "reference-target" };
    const sourceBoard = await recordCanvas({ projectDir: project, ...sourceScope, title: "Source" });
    const targetBoard = await recordCanvas({ projectDir: target, ...targetScope, title: "Target" });
    const [first, second] = await Promise.all([
      addImage(project, { dataUrl: dataUrl(20), name: "first" }, sourceScope),
      addImage(project, { dataUrl: dataUrl(50), name: "second" }, sourceScope)
    ]);
    const referenceObjectIds = [second.id, first.id];
    const request = { action: "reference-generate", objectId: second.id, referenceObjectIds, prompt: "Mix both references" };
    for (const fields of [
      { prompt: "" },
      { referenceObjectIds: [first.id, second.id] },
      { referenceObjectIds: [second.id, second.id] },
      { referenceObjectIds: [second.id, "missing"] },
      { referenceObjectIds: [second.id, "a", "b", "c", "d", "e"] }
    ]) {
      await assert.rejects(createImageJob(project, { ...request, ...fields }, sourceScope), { statusCode: 400 });
    }

    let job = await createImageJob(project, request, sourceScope);
    for (let attempt = 0; attempt < 100 && !["done", "failed"].includes(job.status); attempt++) {
      await delay(40);
      job = getImageJob(job.id, { projectDir: project, ...sourceScope });
    }
    assert.equal(job.status, "done", job.error);
    const result = (await readState(project, sourceScope)).objects.find(object => object.id === job.imported[0].id);
    assert.equal(result.sourceObjectId, null);
    assert.deepEqual(result.referenceObjectIds, referenceObjectIds);
    const { args, prompt } = JSON.parse(await fs.readFile(trace, "utf8"));
    assert.deepEqual(args.flatMap((arg, index) => arg === "--image" ? [args[index + 1]] : []), [second.assetPath, first.assetPath]);
    assert.ok(prompt.includes(JSON.stringify([second.assetPath, first.assetPath])));
    assert.match(prompt, /referenced_image_paths/);

    await fs.writeFile(fixtureOutput, png(210));
    let edit = await createImageJob(project, { ...request, useFirstAsBase: true }, sourceScope);
    for (let attempt = 0; attempt < 100 && !["done", "failed"].includes(edit.status); attempt++) {
      await delay(40);
      edit = getImageJob(edit.id, { projectDir: project, ...sourceScope });
    }
    assert.equal(edit.status, "done", edit.error);
    const edited = (await readState(project, sourceScope)).objects.find(object => object.id === edit.imported[0].id);
    assert.equal(edited.sourceObjectId, second.id);
    assert.deepEqual(edited.referenceObjectIds, [first.id]);
    const editTrace = JSON.parse(await fs.readFile(trace, "utf8"));
    assert.deepEqual(editTrace.args.flatMap((arg, index) => arg === "--image" ? [editTrace.args[index + 1]] : []), [second.assetPath, first.assetPath]);
    assert.match(editTrace.prompt, /Edit the first attached image as the visual base/);

    const exactPath = path.join(root, "external-derived.png");
    await fs.writeFile(exactPath, png(70));
    const alreadyCollected = await addImage(project, { path: exactPath }, sourceScope);
    const derived = await addImage(project, {
      path: exactPath, sourceObjectId: second.id, referenceObjectIds: [first.id, first.id, alreadyCollected.id]
    }, sourceScope);
    assert.equal(derived.id, alreadyCollected.id);
    assert.equal(derived.sourceObjectId, second.id);
    assert.deepEqual(derived.referenceObjectIds, [first.id]);
    const importToTarget = (ids, groupId) => importBoardImages({ sourceBoardId: sourceBoard, groupId, objectIds: ids },
      { projectDir: target, ...targetScope });
    const partial = await importToTarget([derived.id, result.id], "fixture-import");
    assert.equal(partial.objects[0].sourceObjectId, null);
    assert.deepEqual(partial.objects[1].referenceObjectIds, []);
    const [foreign] = (await importToTarget([first.id], "other-group")).objects;
    const [copiedFirst] = (await importToTarget([first.id], "fixture-import")).objects;
    const [copiedSecond] = (await importToTarget([second.id], "fixture-import")).objects;
    const targetState = await readState(target, targetScope);
    const saved = id => targetState.objects.find(object => object.id === id);
    assert.equal(saved(partial.objects[0].id).sourceObjectId, copiedSecond.id);
    assert.deepEqual(saved(partial.objects[0].id).referenceObjectIds, [copiedFirst.id]);
    assert.deepEqual(saved(partial.objects[1].id).referenceObjectIds, [copiedSecond.id, copiedFirst.id]);
    assert.ok(!saved(partial.objects[1].id).referenceObjectIds.includes(foreign.id));

    assert.equal((await knownBoard(targetBoard)).projectDir, target);
    const copiedBoard = await knownBoard((await copyBoardToProject(sourceBoard, target)).boardId);
    const copy = await readState(copiedBoard.projectDir, { canvasId: copiedBoard.canvasId });
    assert.deepEqual(copy.objects.find(object => object.id === result.id).referenceObjectIds, referenceObjectIds);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.ok(path.resolve(root).startsWith(path.resolve(tempDir) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
});

function png(red) {
  const image = new PNG({ width: 8, height: 8 });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data.set([red, 0, 0, 255], offset);
  }
  return PNG.sync.write(image);
}

function dataUrl(red) {
  return `data:image/png;base64,${png(red).toString("base64")}`;
}
