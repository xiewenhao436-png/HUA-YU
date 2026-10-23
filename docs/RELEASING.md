# 画屿发布流程

画屿的独立包名和插件 ID 为 `huayu`，首个独立版本为 `0.1.0`，发布仓库为
[`xiewenhao436-png/HUA-YU`](https://github.com/xiewenhao436-png/HUA-YU)。
唯一的自动发布入口是 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)：
主分支的跨平台测试全部通过后，工作流才会发布尚不存在的版本。

## 仓库设置

- 默认发布分支为 `main`，GitHub Actions 必须能够运行。
- 发布任务显式申请 `contents: write`，使用 GitHub 自动提供的 `GITHUB_TOKEN`
  创建标签和 Release；不需要另外创建个人访问令牌。
- 如果仓库或组织规则限制 Actions 创建标签、Release 或写入仓库，需要允许此发布任务。
  Pull Request 只执行测试，不获得发布任务的写入权限，也不会创建 Release。

## 准备版本

每次要发布新版本时，在同一个提交中核对以下文件：

- `package.json`：包名 `huayu`、新版本号、Node.js 要求 `>=22.13`。
- `package-lock.json`：根版本和 `packages[""]` 的版本与包名同步。
- `.codex-plugin/plugin.json`：插件名 `huayu`，版本与包版本一致。
- `.release-please-manifest.json`：保留的版本记录文件，其中 `"."` 同步为包版本；
  它仅供一致性检查，当前发布工作流不使用它自动计算或提升版本号。
- `CHANGELOG.md`：写明这个版本实际交付的修改与兼容限制。

提交 UI 修改时，先运行 `npm run build:app` 并提交更新后的
`public/canvas-app.html`。变更依赖后，重新生成并提交第三方许可证资料；
CI 会通过 `node scripts/collect-licenses.mjs --check` 检查它们。

版本号由维护者明确修改。提交消息中的 `fix:`、`feat:` 等前缀不会自动更改版本。
第一版使用 `0.1.0`，不要沿用上游的 `0.4.0` 版本线。

## 自动发布的实际顺序

1. 将准备好的代码合入 `main`。也可在 Actions 的 **CI → Run workflow** 中
   选择 `main` 重跑当前版本。
2. CI 在 Linux、macOS、Windows 上分别使用 Node.js `22.13.1` 和 `24.x`
   执行核心、素材库、回收站与会话元数据测试，共六个矩阵任务。
3. 每个平台的 Node.js `24.x` 任务还会检查侧栏 bundle，并在独立 MCP App
   沙盒中执行 Chromium 界面测试。Linux / Node.js `24.x` 同时核对发布元数据、
   第三方许可证，并打包和安装测试归档文件。
4. 仅当所有矩阵任务成功，且运行来自本仓库 `main` 的 push 或手动执行，
   `publish` 才会运行。它检出刚通过验证的准确提交，不会改用后来更新的分支内容。
5. 工作流以包版本计算标签，例如 `v0.1.0`。若 Release 已存在，跳过发布并保留
   原标签和附件；若只有同名标签而没有可见 Release，任务失败，避免替换既有标签。
6. 对尚不存在的版本，发布任务重新打包、核验归档安装，然后一次创建标签、Release
   和三个附件：

   - `huayu-v0.1.0.tgz`，后续版本按 `huayu-vX.Y.Z.tgz` 命名。
   - `release-manifest.json`。
   - `SHA256SUMS`。

因此，普通文档提交也会触发 CI；如果包版本未变且该 Release 已存在，
测试仍会运行，但不会覆盖旧版本。正常发布不需要提前手动创建标签。

## 本地核验和归档约定

需要 Node.js `22.13` 或更新版本，以及 Python、Git。下面的步骤与 CI 的主要检查一致：

```sh
npm ci
python -m pip install Pillow numpy
npx playwright install chromium
npm run test:core
npm run test:ui
node scripts/build-app.mjs --check
npm run verify:release
node scripts/collect-licenses.mjs --check
node scripts/build-release.mjs --output-dir dist/release
node scripts/verify-release-archive.mjs dist/release/huayu-v0.1.0.tgz
```

Linux 等环境首次安装 Chromium 时可能需要
`npx playwright install --with-deps chromium` 安装浏览器的系统依赖。
测试后续版本时，请把最后一条命令中的版本号改为实际包版本。

构建器默认要求干净的 Git 工作区。发布清单记录包名、版本、标签、准确的源提交、
Node.js 最低要求、归档大小与 SHA-256；`SHA256SUMS` 同时覆盖归档和清单。
`--allow-dirty` 仅用于本地打包试验，产生的文件不能作为正式发布附件。
正式发布由 CI 设置 `RELEASE_TAG` 和 `RELEASE_COMMIT`，并验证它们与版本和提交一致。

归档是独立于操作系统的 npm 格式插件包，不需要把 `huayu` 发布到 npm 公共注册表。
原生侧栏通过 MCP 读写画布，不需要 HTTP 监听端口；CLI 浏览器模式仍作为兼容入口保留。
安装方法以 [README](../README.md) 和 [INSTALL.md](../INSTALL.md) 为准。
尚未创建首个 Release 时，可明确选择安装 `main` 源码；安装器不会回退到上游仓库。

## 平台验收边界

跨平台 CI 验证的是核心逻辑和 Chromium 沙盒内的侧栏功能，不能替代 macOS Codex
桌面应用的真机验收。macOS 的原生剪贴板、Cmd 快捷键、触控板操作和从 Finder
启动后的 Node.js 查找仍需实际检查；发布说明应保留这一限制，不能写成已完成全平台验收。

## 失败重试与版本不可覆盖

- 测试失败时，先修正代码，再通过 `main` 上的新提交触发 CI；测试未通过时不会进入发布。
- 如果发布步骤失败且标签、Release 均未创建，可在 `main` 重跑 CI。
- 如果只留下了标签，工作流会拒绝替换它。检查失败记录，优先提高修订版本后重新发布，
  不移动旧标签。
- 如果 Release 已创建，无论附件是否完整，当前流程都不会覆盖它的附件。修正问题后发布
  新修订版本；不要添加 `--clobber`，也不要删除旧版本来复用相同版本号。
- 如果已发布代码本身有错误，保留其标签和提交，说明问题并发布新版本。

发布完成后，确认 Release 中三个附件齐全，并按清单核验版本、提交与摘要，再对外宣布。
