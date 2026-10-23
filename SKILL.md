---
name: huayu
description: 安装、更新并使用画屿，为 Codex 提供按项目整理的本地无限画布。用于打开画布、收集生成图片、跨会话导入，以及按用户要求编辑图片。技术插件标识为 huayu，产品名称只使用画屿。
---

# 画屿

画屿用于分镜、图片和项目素材整理，基于 Codex Canvas 二次开发。源码仓库为 <https://github.com/xiewenhao436-png/HUA-YU>。保留原项目的许可证与致谢，不把上游版本或第三方分发渠道当作画屿的更新来源。

## 安装与更新

1. 优先阅读仓库的 `INSTALL.md`。如果用户要求安装、升级或修复插件，使用仓库提供的 `scripts/install-codex-plugin.mjs`，不要手工改写 Codex 的版本化插件缓存。
2. 只运行实际存在的安装器：`node <huayu-root>/scripts/install-codex-plugin.mjs --json`。安装器负责稳定版本校验、锁定依赖和 personal marketplace 注册；技术插件标识为 `huayu@personal`。
3. 默认不额外安装可选 OCR。只有用户要求本地 OCR 时，才使用安装器支持的 `--with-ocr`。
4. 首个版本尚未发布、网络不可用、权限不足，或缺少 `git`、`node`、`npm`、`codex` 时，如实报告具体阻碍。不要自动退回原项目的 Release，也不要把未校验的主分支宣称为稳定发行版。
5. 现有目标目录属于其他仓库、存在未提交改动或有用户文件时，停止覆盖并保留现场。不要卸载旧插件或移动用户的旧画布，除非用户明确要求。
6. 安装后用 `codex plugin list --json` 验证名称、启用状态和版本。当前任务可能仍持有旧的 MCP 进程；需要时让用户保存工作并重启 Codex，再打开画屿。未经明确授权不要结束其他任务。

## 打开与使用

1. 默认调用 `huayu.open_canvas`，传入当前工作区的绝对路径 `projectDir` 和当前对话的 `threadId`。工具尚未加载时先发现已安装的画屿工具，不能凭名称伪造调用。
2. 默认 `presentation: "sidebar"`，直接在原生插件侧栏打开画布。成功后不再打开浏览器。
3. 从插件入口打开未绑定的面板时，使用画布中心选择已有画布，或明确为指定会话创建新画布。浏览、切换、重新连接不需要发送聊天消息。
4. 继续旧项目时使用工具返回的实际 `projectDir`、`threadId` 和 `canvasId`。画布可能位于项目的 `_codex/` 任务文件夹中，不能改用新目录造成重复画布。
5. 只有宿主不支持 MCP App、原生工具不可用，或用户明确要求时，才使用 `presentation: "browser"`；优先复用 Codex 内置浏览器返回的 URL，不启动系统浏览器。
6. 需要兼容 CLI 时，先确认文件存在，再运行 `node <huayu-root>/bin/codex-canvas.mjs <command>`。这个历史入口保留用于兼容，产品名称仍是画屿。

## 图片收集与批量制作

- 图片生成或编辑仍由宿主可用的图像工具完成。不要声称安装画屿就自动获得第三方图像 API、额外额度或无限并发。
- 已有准确输出路径时，调用 `huayu.add_image`，或运行 `node <huayu-root>/bin/codex-canvas.mjs import <image-path> --project <projectDir> --thread-id <threadId>`。
- 输出路径不明确时，可调用 `huayu.collect_recent_images`，或执行 `collect --project <projectDir> --thread-id <threadId> --since-minutes 30 --limit 5`。默认只扫描当前绑定会话的 `~/.codex/generated_images/<thread-id>`；手动恢复范围必须得到用户指定。
- 批量草稿完成一张就存档并入画布，保留提示词、来源和版本。用户要求先看全部草稿时，不要自动逐图审美评审或反复重做。
- 同一批图片横向排列；从指定对象衍生的版本放在源图右侧，保留原图。打开其他画布不会改变后台制作任务明确绑定的目标。

## 图片操作

只在用户请求相应操作时加载对应技能：

- 快速修改：`skills/canvas-quick-edit/SKILL.md`
- 去除背景：`skills/canvas-remove-bg/SKILL.md`
- 扩展画面：`skills/canvas-expand/SKILL.md`
- 修改图中文字：`skills/canvas-edit-text/SKILL.md`
- 拆分元素图层：`skills/canvas-edit-elements/SKILL.md`

使用现有稳定 action id 与后台 job，不将具体用户提示词硬编码到前端。平移、缩放、选择、复制、粘贴和卡片编辑是本地交互，不需要让模型反复思考或发起任务。

## 项目、回收站与数据兼容

- 画布中心按工作区项目分组，并提供搜索、排序、缩略图和回收站。右键“移到回收站”只隐藏画布并保留文件；可撤销或恢复。
- 只有回收站中的明确确认操作才可永久删除，范围只限该画布的状态、复制素材和任务文件。不要为修复连接而删除真实画布。
- 跨会话导入复制素材和提示词，并保留来源分组；不要改动来源画布或向来源会话发消息。
- 为兼容历史画布，保留 `canvas/`、`codex-canvas.json`、原索引和 `CODEX_CANVAS_*` 环境变量。不要因改名批量迁移或重命名用户数据。
- 保存的面板可能仍引用 `ui://codex-canvas/`，运行时会接受旧资源 URI；新资源使用 `ui://huayu/`。临时 session id 不是永久画布地址。
- 索引只保存画布位置和会话标题、工作目录等轻量元数据，不为浏览画布读取完整聊天记录。

## 跨平台边界

核心实现兼容 Windows、macOS 和 Linux 的 Node.js 环境，但发布时必须区分自动测试和真机验收。不要将未实测平台标注为已验证。优先使用原生 MCP、CLI 和后端任务，避免依赖系统坐标点击、模拟按键或特定系统的浏览器启动方式。
