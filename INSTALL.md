# 画屿安装说明

正式来源：<https://github.com/xiewenhao436-png/HUA-YU>。产品名称为“画屿”，技术插件编号为 `huayu@personal`。

## 先检查环境

需要 Git、Node.js 22.13+ 和支持插件 / MCP App 的 Codex。先执行 `node --version`、`git --version`、`codex plugin --help`。在 Mac 上还要确认从 Dock 打开的 Codex 可以找到 Node；如果终端正常而插件找不到 Node，应检查 GUI 的 PATH 或使用系统可发现的 Node 安装方式。

安装目录应长期保留。不要在下载临时目录或运行中的旧插件缓存内覆盖安装。已有图片与画布应留在项目原位置。

## 安装已发布的稳定版本

Windows PowerShell 与 macOS 终端均可逐行执行：

```bash
git clone https://github.com/xiewenhao436-png/HUA-YU.git
cd HUA-YU
node scripts/install-codex-plugin.mjs
```

默认安装器会查找本仓库带有校验产物的稳定 Release。第一次仓库发布、尚无稳定 Release 时，会明确报出尚未发布；此时使用下面的源码安装，不会退回原作者仓库。

## 首版 / 开发源码安装

```bash
git clone https://github.com/xiewenhao436-png/HUA-YU.git
cd HUA-YU
node scripts/install-codex-plugin.mjs --source main --source-dir .
```

这是明确选择 `main` 的源码安装。安装器检查环境、安装锁定的运行依赖、登记 personal marketplace 并运行 `codex plugin add huayu@personal`。默认不安装可选 OCR，可按需使用 `--with-ocr`。

已经把源码 clone 到长期保留目录的用户，也可逐行执行：

```bash
npm ci --omit=dev --ignore-scripts
npm run install:personal -- --skip-ocr
codex plugin add huayu@personal
codex plugin list --json
```

确认 `huayu@personal` 已安装且启用。打开新聊天后选择“画屿”。如果旧 MCP 后台仍然运行，完整重启一次 Codex；单独刷新面板无法更新后台处理器。

## 从原版切换

1. 等待旧插件正在生成、导入或编辑的任务结束。
2. 保留项目整个 `canvas/` 目录，不删除旧图片、画布状态或生成缓存。
3. 安装并启用 `huayu@personal`，停用 `codex-canvas@personal`，避免两个插件同时编辑同一画布。
4. 在画屿的画布中心选择原来的画布。内部旧文件名及索引目录是兼容机制，不是安装错误。

## 更新与卸载

画屿只从 `xiewenhao436-png/HUA-YU` 检查和安装自己的稳定版本；打开画布只做更新检查。更新前结束正在运行的图像操作，更新后重新加载插件后台。

卸载时在 Codex 插件设置中停用或移除 `huayu@personal`。保留项目 `canvas/` 目录即可保留素材和画布。不要删除共享的 `.agents`、`.codex`、Python 环境或其他插件配置。

## 可选图像处理与 Mac 状态

普通画布不要求 OCR。去背景、拆分元素、PSD 等功能可能需要 Python 3.11+、Pillow、NumPy；文字识别可选 RapidOCR。可执行 `npm run doctor:deps` 检查，并按提示安装。若系统 Python 禁止 `pip --user`，应在独立虚拟环境中安装依赖并配置该 Python 路径，避免修改系统托管环境。

目前的 Mac 支持属于跨平台实现和自动测试覆盖阶段，仍需要真实 Mac 上的 Codex 面板、外部应用复制、Finder 拖入及触控板操作验收。请在反馈中附系统、Codex、Node 版本及不含密钥的错误信息。
