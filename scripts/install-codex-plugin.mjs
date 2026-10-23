#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repository = "https://github.com/xiewenhao436-png/HUA-YU.git";
const pluginId = "huayu@personal";
let options = { json: process.argv.includes("--json") };
let commands;
let codexHome;
let sourceDir;

await main().catch(fail);

async function main() {
  options = parseArgs(process.argv.slice(2));
  codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  sourceDir = path.resolve(
    options.sourceDir
      || process.env.CODEX_CANVAS_PLUGIN_SOURCE_DIR
      || path.join(codexHome, "plugin-sources", "huayu")
  );
  commands = await commandNames();

  if (options.dryRun) {
    writeResult({
      ok: true,
      dryRun: true,
      pluginId,
      repository,
      sourceDir,
      withOcr: options.withOcr,
      source: options.source,
      plan: await buildPlan()
    });
    return;
  }

  await fs.mkdir(codexHome, { recursive: true });
  await assertPrerequisites();
  await prepareStableSource();
  if (options.source === "stable") {
    await run(commands.npm, ["run", "checkout:stable"], { cwd: sourceDir, timeout: 120_000 });
  } else {
    await prepareMainSource();
  }
  await validateSourceIdentity();
  await run(commands.npm, ["ci", "--omit=dev", "--ignore-scripts"], { cwd: sourceDir, timeout: 600_000 });
  await run(
    commands.npm,
    options.withOcr
      ? ["run", "install:personal"]
      : ["run", "install:personal", "--", "--skip-ocr"],
    { cwd: sourceDir, timeout: options.withOcr ? 900_000 : 120_000 }
  );
  await run(commands.codex, ["plugin", "add", pluginId, "--json"], { cwd: sourceDir, timeout: 120_000 });

  const packageJson = JSON.parse(await fs.readFile(path.join(sourceDir, "package.json"), "utf8"));
  const listResult = await run(commands.codex, ["plugin", "list", "--json"], {
    cwd: sourceDir,
    timeout: 60_000,
    quiet: true
  });
  const installed = findInstalledPlugin(listResult.stdout, pluginId);

  if (!installed?.installed || !installed?.enabled) {
    throw new Error(`${pluginId} was not reported as installed and enabled after codex plugin add.`);
  }
  if (installed.version !== packageJson.version) {
    throw new Error(
      `${pluginId} installed version ${JSON.stringify(installed.version)} does not match stable source ${JSON.stringify(packageJson.version)}.`
    );
  }

  writeResult({
    ok: true,
    dryRun: false,
    pluginId,
    version: installed.version,
    sourceDir,
    installed: true,
    enabled: true,
    withOcr: options.withOcr,
    source: options.source,
    nextStep: "Close any old 画屿 window and start a new Codex task before using the plugin."
  });
}

async function buildPlan() {
  const plan = [];
  if (!(await pathExists(sourceDir))) {
    plan.push({ command: commands.git, args: ["clone", repository, sourceDir], cwd: path.dirname(sourceDir) });
  }
  if (options.source === "stable") {
    plan.push({ command: commands.npm, args: ["run", "checkout:stable"], cwd: sourceDir });
  } else {
    plan.push(
      { command: commands.git, args: ["fetch", "origin", "main"], cwd: sourceDir },
      { command: commands.git, args: ["switch", "main"], cwd: sourceDir },
      { command: commands.git, args: ["merge", "--ff-only", "origin/main"], cwd: sourceDir }
    );
  }
  plan.push(
    { command: commands.npm, args: ["ci", "--omit=dev", "--ignore-scripts"], cwd: sourceDir },
    {
      command: commands.npm,
      args: options.withOcr
        ? ["run", "install:personal"]
        : ["run", "install:personal", "--", "--skip-ocr"],
      cwd: sourceDir
    },
    { command: commands.codex, args: ["plugin", "add", pluginId, "--json"], cwd: sourceDir },
    { command: commands.codex, args: ["plugin", "list", "--json"], cwd: sourceDir }
  );
  return plan;
}

function parseArgs(args) {
  const parsed = {
    dryRun: false,
    json: false,
    sourceDir: "",
    withOcr: false,
    source: "stable"
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--with-ocr") {
      parsed.withOcr = true;
      continue;
    }
    if (arg === "--source") {
      const value = args[index + 1];
      if (!["stable", "main"].includes(value)) throw new Error("--source must be stable or main.");
      parsed.source = value;
      index += 1;
      continue;
    }
    if (arg === "--source-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--source-dir requires a path.");
      parsed.sourceDir = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

async function commandNames() {
  return {
    codex: process.env.CODEX_CANVAS_CODEX_BIN || (process.platform === "win32"
      ? await findCommandOnPath("codex.exe") || await findCommandOnPath("codex.cmd") || "codex.exe"
      : "codex"),
    git: process.env.CODEX_CANVAS_GIT_BIN || (process.platform === "win32" ? "git.exe" : "git"),
    npm: process.env.CODEX_CANVAS_NPM_BIN || (process.platform === "win32" ? "npm.cmd" : "npm")
  };
}

async function findCommandOnPath(command) {
  const pathValue = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory.replace(/^"|"$/g, ""), command);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function assertPrerequisites() {
  assertNodeVersion();
  await run(commands.git, ["--version"], { timeout: 30_000, quiet: true });
  await run(commands.npm, ["--version"], { timeout: 30_000, quiet: true });
  await run(commands.codex, ["plugin", "--help"], { timeout: 30_000, quiet: true });
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Node.js 22.13 or newer is required; found ${process.versions.node}.`);
  }
}

async function prepareMainSource() {
  await run(commands.git, ["fetch", "origin", "main"], { cwd: sourceDir, timeout: 120_000 });
  await run(commands.git, ["switch", "main"], { cwd: sourceDir, timeout: 30_000 });
  await run(commands.git, ["merge", "--ff-only", "origin/main"], { cwd: sourceDir, timeout: 30_000 });
}

async function validateSourceIdentity() {
  const packageJson = JSON.parse(await fs.readFile(path.join(sourceDir, "package.json"), "utf8"));
  const pluginJson = JSON.parse(await fs.readFile(path.join(sourceDir, ".codex-plugin", "plugin.json"), "utf8"));
  if (packageJson.name !== "huayu" || pluginJson.name !== "huayu" || packageJson.version !== pluginJson.version) {
    throw new Error("The selected source is not a consistent 画屿 release.");
  }
}

async function prepareStableSource() {
  if (!(await pathExists(sourceDir))) {
    await fs.mkdir(path.dirname(sourceDir), { recursive: true });
    await run(commands.git, ["clone", repository, sourceDir], {
      cwd: path.dirname(sourceDir),
      timeout: 180_000
    });
    return;
  }

  const stat = await fs.stat(sourceDir);
  if (!stat.isDirectory()) throw new Error(`Plugin source path is not a directory: ${sourceDir}`);

  const topLevel = (await run(commands.git, ["-C", sourceDir, "rev-parse", "--show-toplevel"], {
    timeout: 30_000,
    quiet: true
  })).stdout.trim();
  if (normalizePath(topLevel) !== normalizePath(sourceDir)) {
    throw new Error(`Existing source path is not the 画屿 repository root: ${sourceDir}`);
  }

  const origin = (await run(commands.git, ["-C", sourceDir, "config", "--get", "remote.origin.url"], {
    timeout: 30_000,
    quiet: true
  })).stdout.trim();
  if (normalizeRepository(origin) !== normalizeRepository(repository)) {
    throw new Error(`Refusing to use a repository with an unexpected origin: ${origin || "<missing>"}`);
  }

  const status = (await run(commands.git, ["-C", sourceDir, "status", "--porcelain"], {
    timeout: 30_000,
    quiet: true
  })).stdout.trim();
  if (status) {
    throw new Error(`画屿 stable source has local changes; refusing to overwrite ${sourceDir}.`);
  }
}

function normalizeRepository(value) {
  const raw = String(value || "").trim().replace(/\.git$/, "");
  const ssh = /^git@github\.com:(.+)$/i.exec(raw);
  if (ssh) return `github.com/${ssh[1]}`.toLowerCase();
  try {
    const url = new URL(raw);
    return `${url.hostname}${url.pathname}`.replace(/^\/+|\/+$/g, "").toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function normalizePath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

async function run(command, args, { cwd, timeout = 60_000, quiet = false } = {}) {
  if (!quiet) log(`Running: ${formatCommand(command, args)}`);
  try {
    const result = await portableExec(command, args, {
      cwd,
      env: process.env,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    });
    if (!quiet && !options.json) {
      if (result.stdout?.trim()) process.stdout.write(`${result.stdout.trimEnd()}\n`);
      if (result.stderr?.trim()) process.stderr.write(`${result.stderr.trimEnd()}\n`);
    }
    return result;
  } catch (error) {
    const detail = [error?.stderr, error?.stdout].map((value) => String(value || "").trim()).filter(Boolean).join("\n");
    const wrapped = new Error(
      `Command failed: ${formatCommand(command, args)}${detail ? `\n${detail}` : `\n${error?.message || error}`}`
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

async function portableExec(command, args, runOptions) {
  if (/\.(?:mjs|cjs|js)$/i.test(command)) {
    return execFileAsync(process.execPath, [command, ...args], runOptions);
  }
  if (!(process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command))) {
    return execFileAsync(command, args, runOptions);
  }
  // Windows cannot execFile a .cmd shim. Invoke the known Node entry point
  // directly, preserving argv without shell quoting or command interpretation.
  const script = await nodeEntrypointForWindowsShim(command);
  return execFileAsync(process.execPath, [script, ...args], runOptions);
}

async function nodeEntrypointForWindowsShim(command) {
  const knownEntrypoints = {
    "npm.cmd": ["node_modules", "npm", "bin", "npm-cli.js"],
    "npx.cmd": ["node_modules", "npm", "bin", "npx-cli.js"],
    "codex.cmd": ["node_modules", "@openai", "codex", "bin", "codex.js"]
  };
  const relative = knownEntrypoints[path.basename(command).toLowerCase()];
  if (!relative) throw new Error(`Cannot execute an unknown Windows batch shim directly: ${command}. Use a native executable or JavaScript entry point.`);
  const pathValue = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  const candidates = path.isAbsolute(command) || command.includes(path.sep)
    ? [path.resolve(command)]
    : pathValue.split(path.delimiter).filter(Boolean).map((directory) => path.join(directory.replace(/^"|"$/g, ""), command));
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    const entrypoint = path.join(path.dirname(candidate), ...relative);
    if (await pathExists(entrypoint)) return entrypoint;
  }
  throw new Error(`Could not locate the Node entry point behind ${command}. Set CODEX_CANVAS_NPM_BIN or CODEX_CANVAS_CODEX_BIN to its full JavaScript entry point.`);
}

function findInstalledPlugin(stdout, expectedPluginId) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`codex plugin list --json returned invalid JSON: ${error.message}`);
  }
  return (Array.isArray(payload?.installed) ? payload.installed : [])
    .find((plugin) => plugin?.pluginId === expectedPluginId);
}

function formatCommand(command, args) {
  return [command, ...args].map((part) => (/^[A-Za-z0-9_./:@=-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}

function log(message) {
  process.stderr.write(`[huayu installer] ${message}\n`);
}

function writeResult(payload) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (payload.dryRun) {
    process.stdout.write(`画屿 plugin install dry run for ${payload.sourceDir}.\n`);
    return;
  }
  process.stdout.write(`画屿 ${payload.version || ""} installed as ${payload.pluginId}.\n`);
  process.stdout.write(`${payload.nextStep || ""}\n`);
}

function fail(error) {
  const message = error?.message || String(error);
  if (options.json) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = 1;
}
