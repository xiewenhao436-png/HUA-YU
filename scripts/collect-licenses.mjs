#!/usr/bin/env node
// Derive notices from installed runtime dependencies and actual bundled inputs.
// Preserves full upstream LICENSE/NOTICE wording; metadata is not a substitute.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const json = file => fs.readFile(file, "utf8").then(JSON.parse);
const own = await json(path.join(root, "package.json"));
const packages = new Map();
async function findPackage(entry) {
  let dir = path.dirname(entry);
  for (;;) {
    const file = path.join(dir, "package.json");
    try { const pkg = await json(file); if (pkg.name) return { dir, file, pkg }; } catch {}
    const parent = path.dirname(dir); if (parent === dir) throw new Error(`Package root not found: ${entry}`); dir = parent;
  }
}
async function dependency(name, from) {
  const require = createRequire(from);
  try { const file = require.resolve(`${name}/package.json`); return { dir: path.dirname(file), file, pkg: await json(file) }; }
  catch { return findPackage(require.resolve(name)); }
}
async function addPackage(item, recursive = false) {
  const key = `${item.pkg.name}@${item.pkg.version}`;
  if (packages.has(key)) return;
  packages.set(key, item);
  if (recursive) for (const name of Object.keys(item.pkg.dependencies || {})) await addPackage(await dependency(name, item.file), true);
}
for (const name of Object.keys(own.dependencies || {})) await addPackage(await dependency(name, path.join(root, "package.json")), true);
const bundle = await build({ entryPoints: [path.join(root, "ui/canvas-app.js")], bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, write: false, metafile: true });
for (const input of Object.keys(bundle.metafile.inputs)) {
  const file = path.resolve(input);
  if (file.split(path.sep).includes("node_modules")) await addPackage(await findPackage(file));
}
const files = new Map();
const rows = [];
for (const [key, item] of [...packages].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
  const names = (await fs.readdir(item.dir)).filter(name => /^(?:licen[cs]e|notice|copying)(?:[.-]|$)/i.test(name));
  if (!names.length) throw new Error(`Missing full license for distributed dependency ${key}`);
  const filename = `${item.pkg.name.replace(/^@/, "").replaceAll("/", "--")}.txt`;
  const sections = [];
  for (const name of names.sort()) {
    const file = path.join(item.dir, name);
    if ((await fs.stat(file)).isFile()) sections.push(`Source file: ${name}\n\n${(await fs.readFile(file, "utf8")).trimEnd()}`);
  }
  if (!sections.length) throw new Error(`No license text for ${key}`);
  files.set(`LICENSES/${filename}`, `${key}\n\n${sections.join("\n\n---\n\n")}\n`);
  rows.push(`| ${item.pkg.name} | ${item.pkg.version} | [原始许可与 NOTICE](LICENSES/${filename}) |`);
}
files.set("LICENSES/lucide.txt", await fs.readFile(path.join(root, "assets/lucide-license.txt"), "utf8"));
files.set("THIRD_PARTY_NOTICES.md", [
  "# 第三方许可", "",
  "画屿的派生关系及原作者版权见 [UPSTREAM.md](UPSTREAM.md) 与 [LICENSE](LICENSE)。以下清单由已安装的运行依赖及界面实际打包输入生成。完整 LICENSE / NOTICE 原文保存在 `LICENSES/`，它们各自的许可条款保持有效。", "",
  "MCP Apps SDK 的本次分发许可证包含 MIT 向 Apache-2.0 过渡的说明；此处保留完整原文，不以 package.json 中的单个 license 字段替代。Zod 等组件亦保留其完整许可。", "",
  "| 组件 | 版本 | 许可原文 |", "| --- | --- | --- |", ...rows, "",
  "界面内联图标来自 Lucide，包含 Feather 衍生图标，完整 ISC / MIT 许可见 [Lucide](LICENSES/lucide.txt)。", "",
  "重新构建前运行 `node scripts/collect-licenses.mjs` 可更新清单；使用 `--check` 验证已提交的清单是否与当前锁定依赖及实际打包输入一致。", ""
].join("\n"));
for (const [name, text] of files) {
  const file = path.join(root, name);
  if (check) { if (await fs.readFile(file, "utf8") !== text) throw new Error(`License snapshot differs: ${name}`); }
  else { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
}
console.log(`${check ? "Verified" : "Collected"} full licenses for ${packages.size} dependencies and Lucide.`);
