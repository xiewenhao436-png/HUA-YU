import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promptForAction, resolveImageExecutionPolicy, startCodexImageJob } from "../src/codex-runner.mjs";

test("execution policy keeps CLI defaults separate from the native image model", () => {
  assert.deepEqual(resolveImageExecutionPolicy("quick-edit", {}), {
    executionModel: undefined,
    reasoningEffort: "low",
    imageModelSelection: "native-default",
    maxImagegenCalls: 1
  });
  assert.equal(resolveImageExecutionPolicy("recognize-text", {}).maxImagegenCalls, 0);
  const env = {
    CODEX_CANVAS_CODEX_MODEL: "existing-text-model",
    CODEX_CANVAS_CODEX_REASONING_EFFORT: "minimal",
    CODEX_CANVAS_CODEX_MODEL_RECOGNIZE_TEXT: "ocr-text-model",
    CODEX_CANVAS_CODEX_REASONING_EFFORT_RECOGNIZE_TEXT: "medium"
  };
  assert.equal(resolveImageExecutionPolicy("quick-edit", env).executionModel, "existing-text-model");
  assert.equal(resolveImageExecutionPolicy("quick-edit", env).reasoningEffort, "low");
  assert.equal(resolveImageExecutionPolicy("recognize-text", env).executionModel, "ocr-text-model");
  assert.equal(resolveImageExecutionPolicy("recognize-text", env).reasoningEffort, "medium");
  assert.equal(resolveImageExecutionPolicy("edit-elements", { CODEX_CANVAS_CODEX_REASONING_EFFORT_EDIT_ELEMENTS: "high" }).reasoningEffort, "high");
  assert.throws(() => resolveImageExecutionPolicy("quick-edit", { CODEX_CANVAS_CODEX_MODEL: "gpt-image-2.5" }), /execution model, not the image model/);
  assert.throws(() => resolveImageExecutionPolicy("quick-edit", { CODEX_CANVAS_CODEX_MODEL_QUICK_EDIT: "GPT-IMAGE-2" }), /execution model, not the image model/);
});

test("worker instructions retain editing contracts without canvas recursion or automatic retries", () => {
  const outputDir = path.join("project", "one job", "outputs");
  for (const action of ["quick-edit", "expand", "edit-text", "edit-elements", "edit-elements-background", "remove-bg", "edit-text-session"]) {
    const prompt = promptForAction({ action, outputDir, userPrompt: "Only change the requested region." });
    assert.match(prompt, /native imagegen tool and its required imagegen skill/);
    assert.equal(prompt.split("Call imagegen exactly once.").length - 1, 1, action);
    assert.match(prompt, /Do not create variants, retry generation/);
    assert.match(prompt, /If it fails, report the failure and stop/);
    assert.match(prompt, /Do not open a canvas, load canvas operation skills/);
    assert.ok(prompt.includes(outputDir));
    assert.doesNotMatch(prompt, /Use the canvas-|quality=|GPT Image 2\.5/);
  }
  const quick = promptForAction({ action: "quick-edit", outputDir, transparentLayerMode: true });
  assert.match(quick, /image 1 is the clean source and image 2 is the annotation board/);
  assert.match(quick, /remove temporary arrows, masks, strokes, labels, notes/);
  assert.match(quick, /perfectly flat solid #ff00ff chroma-key background/);
  assert.match(quick, /final alpha channel after generation/);
  assert.match(promptForAction({ action: "expand", outputDir }), /user-chosen position.*visually unchanged/);
  assert.match(promptForAction({ action: "expand", outputDir }), /Replace all padding\/blurred surrounding area/);
  assert.match(promptForAction({ action: "edit-text", outputDir }), /Do not run a separate recognition pass unless the edit plan is unusable/);
  assert.match(promptForAction({ action: "edit-elements", outputDir }), /文字按视觉文本块作为独立实例保留/);
  assert.match(promptForAction({ action: "edit-elements-background", outputDir }), /Fill only the transparent or missing regions from attached image 2/);
  const ocr = promptForAction({ action: "recognize-text", outputDir });
  assert.match(ocr, /Do not call imagegen/);
  assert.match(ocr, /"confidence":"high\|medium\|low"/);
  assert.match(ocr, /recognized-text\.json/);
  assert.doesNotMatch(ocr, /Call imagegen exactly once|canvas-edit-text skill/);
  assert.throws(() => promptForAction({ action: "invalid", outputDir }), /Unsupported Codex image action/);
});

test("mock CLI receives one ephemeral job, ordered references, stdin and compatible model settings", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "huayu-runner-"));
  const executable = path.join(root, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
  await writeMockCli(executable);
  const original = new Map(Object.entries(process.env).filter(([key]) => /^(CODEX_CANVAS_CODEX_|HUAYU_RUNNER_TEST_)/.test(key)));
  for (const key of original.keys()) delete process.env[key];
  process.env.CODEX_CANVAS_CODEX_CLI = executable;
  try {
    const projectDir = path.join(root, "project space & 100%");
    await fs.mkdir(projectDir);
    const imagePaths = [path.join(projectDir, "clean source.png"), path.join(projectDir, "annotation 100%.png")];
    // The mock records only inputs; it never calls imagegen or produces an image.
    for (const file of imagePaths) await fs.writeFile(file, "reference fixture");
    const run = async (label, action = "quick-edit") => {
      const outputDir = path.join(projectDir, label);
      const job = await startCodexImageJob({
        projectDir, action, imagePath: imagePaths, outputDir,
        logPath: path.join(outputDir, "codex.log"),
        prompt: "Keep this exact text: $(not-a-command) `literal` & 100%\n中文第二行。"
      });
      const result = await job.done;
      const capture = JSON.parse(await fs.readFile(path.join(outputDir, "capture.json"), "utf8"));
      return { job, result, capture };
    };

    await t.test("default low uses native image model selection and no forced text model", async () => {
      const { job, result, capture } = await run("defaults");
      assert.equal(result.code, 0);
      assert.equal(capture.cwd, projectDir);
      assert.equal(capture.invocations, 1);
      assert.deepEqual(capture.args.slice(0, 2), ["exec", "--ephemeral"]);
      assert.deepEqual(capture.args.slice(-2), ["--", "-"]);
      assert.ok(capture.args.includes("--skip-git-repo-check"));
      assert.ok(!capture.args.includes("--ignore-rules"));
      assert.ok(capture.args.includes("project_doc_max_bytes=0"));
      assert.ok(capture.args.includes("features.memories=false"));
      // Keep the configured provider/proxy/auth and the required image skill available.
      assert.ok(!capture.args.includes("--ignore-user-config"));
      assert.ok(capture.args.includes('model_reasoning_effort="low"'));
      assert.ok(!capture.args.includes("--model"));
      assert.ok(!capture.args.some(value => /image_model|gpt-image/.test(value)));
      assert.deepEqual(capture.imageArgs, imagePaths);
      assert.equal(capture.prompt, job.prompt);
      assert.match(capture.prompt, /\$\(not-a-command\) `literal` & 100%\n中文第二行。/);
      assert.equal(job.executionPolicy.imageModelSelection, "native-default");
    });

    await t.test("existing global model and minimal effort remain compatible", async () => {
      process.env.CODEX_CANVAS_CODEX_MODEL = "existing-text-model";
      process.env.CODEX_CANVAS_CODEX_REASONING_EFFORT = "minimal";
      const { job, capture } = await run("global");
      assert.equal(capture.args[capture.args.indexOf("--model") + 1], "existing-text-model");
      assert.ok(capture.args.includes('model_reasoning_effort="low"'));
      assert.equal(job.executionPolicy.executionModel, "existing-text-model");
    });

    await t.test("OCR has an independent execution override and no image generation", async () => {
      process.env.CODEX_CANVAS_CODEX_MODEL_RECOGNIZE_TEXT = "ocr-text-model";
      process.env.CODEX_CANVAS_CODEX_REASONING_EFFORT_RECOGNIZE_TEXT = "medium";
      const { job, capture } = await run("ocr", "recognize-text");
      assert.equal(capture.args[capture.args.indexOf("--model") + 1], "ocr-text-model");
      assert.ok(capture.args.includes('model_reasoning_effort="medium"'));
      assert.match(capture.prompt, /Do not call imagegen/);
      assert.equal(job.executionPolicy.maxImagegenCalls, 0);
      assert.equal((await run("global-still-applies")).job.executionPolicy.reasoningEffort, "low");
    });

    await t.test("CLI failure is surfaced once, without runner respawn", async () => {
      process.env.HUAYU_RUNNER_TEST_FAIL = "1";
      const outputDir = path.join(projectDir, "failed");
      const job = await startCodexImageJob({ projectDir, action: "remove-bg", imagePath: imagePaths[0], outputDir, logPath: path.join(outputDir, "codex.log") });
      await assert.rejects(job.done, error => error.code === 9 && /mock native tool unavailable/.test(error.message));
      const capture = JSON.parse(await fs.readFile(path.join(outputDir, "capture.json"), "utf8"));
      assert.equal(capture.invocations, 1);
      delete process.env.HUAYU_RUNNER_TEST_FAIL;
    });

    await t.test("image-model confusion is rejected before starting a CLI process", async () => {
      process.env.CODEX_CANVAS_CODEX_MODEL = "gpt-image-2.5";
      const outputDir = path.join(projectDir, "invalid-model");
      await assert.rejects(startCodexImageJob({ projectDir, action: "quick-edit", outputDir, logPath: path.join(outputDir, "codex.log") }), /execution model, not the image model/);
      await assert.rejects(fs.access(outputDir), { code: "ENOENT" });
    });
  } finally {
    for (const key of Object.keys(process.env)) if (/^(CODEX_CANVAS_CODEX_|HUAYU_RUNNER_TEST_)/.test(key)) delete process.env[key];
    for (const [key, value] of original) process.env[key] = value;
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function writeMockCli(executable) {
  const script = `${executable}.cjs`;
  await fs.writeFile(script, `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const imageArgs = args.flatMap((arg, index) => arg === "--image" ? [args[index + 1]] : []);
const capturePath = path.join(process.env.CODEX_CANVAS_JOB_OUTPUT_DIR, "capture.json");
const invocations = fs.existsSync(capturePath) ? JSON.parse(fs.readFileSync(capturePath, "utf8")).invocations + 1 : 1;
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync(capturePath, JSON.stringify({ args, imageArgs, prompt, cwd: process.cwd(), invocations }));
if (process.env.HUAYU_RUNNER_TEST_FAIL) { console.error("mock native tool unavailable"); process.exit(9); }
console.log("mock job complete");
`);
  if (process.platform === "win32") {
    await fs.writeFile(executable, `@echo off\r\n"${process.execPath}" "%~dp0${path.basename(script)}" %*\r\n`);
  } else {
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  }
}
