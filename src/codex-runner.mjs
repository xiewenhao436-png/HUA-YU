import { spawn } from "node:child_process";
import crossSpawn from "cross-spawn";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const executableNames = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];

// These are Codex execution-model settings. The native imagegen tool owns its
// image-model selection; its model must never be passed to Codex's --model.
export function resolveImageExecutionPolicy(action, env = process.env) {
  const suffix = String(action).replace(/-/g, "_").toUpperCase();
  const configured = (name) => String(env[`${name}_${suffix}`] || env[name] || "").trim();
  const executionModel = configured("CODEX_CANVAS_CODEX_MODEL") || undefined;
  if (/^gpt-image(?:-|$)/i.test(executionModel || "")) {
    throw new Error("CODEX_CANVAS_CODEX_MODEL configures the Codex execution model, not the image model. Remove the gpt-image value; native imagegen selects its own image model.");
  }
  const requestedEffort = configured("CODEX_CANVAS_CODEX_REASONING_EFFORT") || "low";
  return {
    executionModel,
    reasoningEffort: requestedEffort === "minimal" ? "low" : requestedEffort,
    imageModelSelection: "native-default",
    maxImagegenCalls: action === "recognize-text" ? 0 : 1
  };
}

export async function resolveCodexExecutable() {
  const configured = process.env.CODEX_CANVAS_CODEX_CLI;
  const candidates = [
    configured,
    ...platformBundledCandidates(),
    ...pathCandidates()
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }

  const error = new Error("Codex CLI was not found. Open or install Codex App, or set CODEX_CANVAS_CODEX_CLI.");
  error.statusCode = 503;
  throw error;
}

export async function startCodexImageJob({ projectDir, action, imagePath, outputDir, logPath, prompt: userPrompt, transparentLayerMode = false }) {
  const policy = resolveImageExecutionPolicy(action);
  const prompt = promptForAction({ action, outputDir, userPrompt, transparentLayerMode });
  const executable = await resolveCodexExecutable();
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(path.dirname(logPath), { recursive: true });

  const imagePaths = (Array.isArray(imagePath) ? imagePath : [imagePath]).filter(Boolean);
  const args = [
    "exec",
    "--ephemeral"
  ];
  if (policy.executionModel) args.push("--model", policy.executionModel);
  args.push(
    "--skip-git-repo-check",
    "--color", "never",
    "-c", `model_reasoning_effort=${JSON.stringify(policy.reasoningEffort)}`,
    "-c", "project_doc_max_bytes=0",
    "-c", "features.memories=false",
    "--cd", projectDir,
    "--sandbox", "danger-full-access"
  );
  for (const attachedImagePath of imagePaths) {
    args.push("--image", attachedImagePath);
  }
  args.push("--", "-");

  const child = spawnCodexProcess(executable, args, {
    cwd: projectDir,
    env: {
      ...process.env,
      CODEX_CANVAS_JOB_OUTPUT_DIR: outputDir,
      NO_COLOR: "1"
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);

  const done = new Promise((resolve, reject) => {
    const output = [];
    const collect = (chunk) => {
      const text = chunk.toString();
      output.push(text);
      fs.appendFile(logPath, text).catch(() => {});
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const log = output.join("");
      if (code === 0) {
        resolve({ executable, code, signal, log });
        return;
      }
      const detail = summarizeCodexFailure(log);
      const error = new Error(detail
        ? `Codex image job failed: ${detail}`
        : `Codex image job failed with ${signal || `exit code ${code}`}.`);
      error.code = code;
      error.signal = signal;
      error.log = log;
      reject(error);
    });
  });

  return { child, done, executable, prompt, executionPolicy: policy };
}

export function spawnCodexProcess(executable, args, options = {}) {
  return crossSpawn(executable, args, {
    ...options,
    shell: false
  });
}

export function stopCodexProcess(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(false);
  }
  if (process.platform !== "win32") {
    try {
      return Promise.resolve(child.kill(signal));
    } catch {
      return Promise.resolve(false);
    }
  }
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (stopped) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(stopped);
    };
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    const timeout = setTimeout(() => {
      try {
        killer.kill();
      } catch {}
      finish(false);
    }, 2500);
    timeout.unref?.();
    killer.once("error", () => finish(false));
    killer.once("close", (code) => finish(code === 0));
  });
}

export async function runCodexImageJob(options) {
  const job = await startCodexImageJob(options);
  return job.done;
}

function summarizeCodexFailure(log) {
  const lines = String(log || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("[codex-canvas]"))
    .filter((line) => !/^Reading additional input from stdin/i.test(line));
  const detail = lines.at(-1);
  if (!detail) return "";
  return detail.length > 240 ? `${detail.slice(0, 237)}...` : detail;
}

function platformBundledCandidates() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Codex.app/Contents/Resources/codex",
      path.join(os.homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex")
    ];
  }

  if (process.platform === "win32") {
    const roots = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Codex"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Codex"),
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Codex"),
      process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Codex")
    ].filter(Boolean);
    return roots.flatMap((root) => [
      path.join(root, "resources", "codex.exe"),
      path.join(root, "resources", "codex.cmd"),
      path.join(root, "codex.exe"),
      path.join(root, "codex.cmd")
    ]);
  }

  return [];
}

function pathCandidates() {
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((entry) => executableNames.map((name) => path.join(entry, name)));
}

async function isExecutable(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function transparentLayerChromaInstructions() {
  return [
    "The source image is a transparent layer. The edited content may have a different silhouette than the source.",
    "Render the edited layer on a perfectly flat solid #ff00ff chroma-key background, not on white, checkerboard, gray, transparent-preview, or scene background.",
    "Do not use #ff00ff anywhere in the edited layer content.",
    "画屿 will remove the chroma-key background locally and create the final alpha channel after generation."
  ].join("\n");
}

function maybeTransparentLayerChromaInstruction(transparentLayerMode) {
  return transparentLayerMode ? transparentLayerChromaInstructions() : "";
}

function imageWorkerPrompt(outputDir, instructions, filename) {
  return [
    "Isolated 画屿 worker: use the native imagegen tool and its required imagegen skill.",
    "Parent handles collection/post-processing. Do not open a canvas, load canvas operation skills, start workers, or read unrelated files.",
    "Call imagegen exactly once. Do not create variants, retry generation, or run extra visual QA. If it fails, report the failure and stop. No external API fallback.",
    ...instructions.filter(Boolean),
    `Copy the PNG into this exact directory: ${outputDir}`,
    `Suggested filename: ${filename}. Do not modify other project files.`,
    "Return only the saved path; no follow-up questions."
  ].join("\n");
}

export function promptForAction({ action, outputDir, userPrompt, transparentLayerMode = false }) {
  if (action === "recognize-text") {
    const textInventoryPath = path.join(outputDir, "recognized-text.json");
    return [
      "You are an isolated 画屿 text-recognition worker. Inspect the attached image directly.",
      "Do not call imagegen. Do not generate or edit an image.",
      "Do not open a canvas, load canvas operation skills, start other workers, or inspect unrelated files.",
      "Recognize every visible text fragment in natural reading order (top-to-bottom, left-to-right).",
      `Write the text inventory to this exact path: ${textInventoryPath}`,
      "Use JSON with this shape: {\"items\":[{\"text\":\"...\",\"location\":\"...\",\"style\":\"...\",\"confidence\":\"high|medium|low\"}]}.",
      "If there is no visible text, write {\"items\":[]}.",
      "Do not modify other project files. Finish with only the text inventory path."
    ].join("\n");
  }

  // Compatibility for existing callers. New jobs wait for the edit plan in Node
  // between recognize-text and edit-text rather than holding a CLI worker open.
  if (action === "edit-text-session") {
    const textInventoryPath = path.join(outputDir, "recognized-text.json");
    const editPlanPath = path.join(outputDir, "edit-plan.json");
    return imageWorkerPrompt(outputDir, [
      "This legacy interactive session is coordinated through files. Do not exit after recognition.",
      `First recognize every visible text fragment in natural reading order and write: ${textInventoryPath}`,
      "Use JSON with this shape: {\"items\":[{\"text\":\"...\",\"location\":\"...\",\"style\":\"...\",\"confidence\":\"high|medium|low\"}]}.",
      "If there is no visible text, write {\"items\":[]}.",
      `Wait for the user's edit plan at: ${editPlanPath}`,
      "Use one bounded local polling command (1 second interval, up to 10 minutes), not a separate tool call per poll. Do not call imagegen before the plan exists.",
      "If cancelled or timed out, finish without generating. Otherwise read the plan and create the requested text edit.",
      "Preserve non-text content, composition, aspect ratio, colors, perspective, typography style, and design intent.",
      "Only change text requested by the edit plan. Keep unchanged recognized text as-is.",
      maybeTransparentLayerChromaInstruction(transparentLayerMode)
    ], "edit-text-result.png");
  }

  if (action === "quick-edit") {
    return imageWorkerPrompt(outputDir, [
      "Edit the attached source image according to this request:",
      userPrompt || "Improve the image according to the user's selected Quick Edit request.",
      "When two images are attached, image 1 is the clean source and image 2 is the annotation board. Use image 1 as the visual base and image 2 only to locate and interpret the requested changes.",
      "Apply all provided annotation instructions, then remove temporary arrows, masks, strokes, labels, notes, and annotation-board surroundings from the result.",
      "Preserve the source image's important subject identity, composition, aspect ratio, visible text, and design intent unless the edit explicitly says to change them.",
      maybeTransparentLayerChromaInstruction(transparentLayerMode)
    ], "quick-edit-result.png");
  }

  if (action === "expand") {
    return imageWorkerPrompt(outputDir, [
      "Outpaint the attached padded canvas according to this instruction:",
      userPrompt || "Expand the image naturally beyond its current frame.",
      "The original source image is pasted inside the padded canvas at the user-chosen position. Keep that original content visually unchanged.",
      "Replace all padding/blurred surrounding area with coherent generated content; do not leave blur, blank margins, checkerboards, seams, or borders.",
      "Preserve the source subject identity, visible text, perspective, lighting, colors, and design intent.",
      "Extend outside the current frame; do not crop, zoom in, replace the main subject, or redesign unrelated content."
    ], "expand-result.png");
  }

  if (action === "edit-text") {
    return imageWorkerPrompt(outputDir, [
      "Edit the attached image according to this user-confirmed text edit plan:",
      userPrompt || "Edit the visible text according to the user's selected Edit Text request.",
      "The frontend already ran text recognition and the user may have edited the recognized text fields.",
      "Do not run a separate recognition pass unless the edit plan is unusable.",
      "Preserve non-text content, composition, aspect ratio, colors, perspective, typography style, and design intent.",
      "Only change text requested by the edit instruction. Keep unchanged visible text as-is.",
      maybeTransparentLayerChromaInstruction(transparentLayerMode)
    ], "edit-text-result.png");
  }

  if (action === "edit-elements") {
    return imageWorkerPrompt(outputDir, [
      "Create an instance segmentation map of the attached image as an image edit/reference task.",
      "The output must match the source image aspect ratio.",
      "Use this exact visual prompt without adding object examples, category examples, palette examples, or case-specific rules:",
      "对这张图进行实例分割，背景用纯洋红色 #ff00ff 表示。每个前景实例使用不同的纯色表示。完整物体作为一个实例，不要拆分物体内部部件。文字按视觉文本块作为独立实例保留。输出平涂分割图，不要渐变、阴影、纹理、图例或说明文字。",
      "Return only the segmentation map. Do not run the local splitting algorithm; 画屿 handles it after collection."
    ], "edit-elements-segmentation.png");
  }

  if (action === "edit-elements-background") {
    return imageWorkerPrompt(outputDir, [
      "Attached image 1 is the original source image.",
      "Attached image 2 is the locally segmented background layer with transparent holes where foreground objects/text were removed.",
      "Create one complete clean background image for layer reconstruction as an image edit/inpainting task.",
      "Fill only the transparent or missing regions from attached image 2 using visual context from attached image 1.",
      "Remove foreground objects and text from the filled background. Do not recreate products, badges, foreground props, or readable text that belong to separated object layers.",
      "Preserve the source image aspect ratio, canvas size, perspective, lighting, color palette, background style, and design intent.",
      "The result must be a full-frame background PNG with no transparency requirement and no extra border, labels, legend, mask colors, or side-by-side comparison.",
      "Return only the completed background. Do not run the local splitting algorithm; 画屿 integrates the result."
    ], "edit-elements-background-completed.png");
  }

  if (action !== "remove-bg") {
    throw new Error(`Unsupported Codex image action: ${action}`);
  }

  return imageWorkerPrompt(outputDir, [
    "Task: isolate the foreground subject for background removal.",
    "Preserve only the primary foreground subject, its proportions, and visual quality as much as possible.",
    "Do not preserve or recreate readable text, captions, labels, logos, watermarks, UI text, or decorative typography; the cutout should contain the subject only, without text.",
    "Generate the foreground subject on a perfectly flat solid #ff00ff chroma-key background.",
    "The background must be one uniform #ff00ff color with no shadows, gradients, texture, reflections, floor plane, or lighting variation.",
    "Do not use #ff00ff anywhere in the subject. Keep the subject fully separated from the background with crisp edges, no cast shadow, no contact shadow, no reflection, and generous padding.",
    "画屿 will remove the chroma key locally and verify the final PNG alpha channel before collecting it."
  ], "remove-bg-chroma-source.png");
}
