import readline from "node:readline";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { main as cliMain, normalizePort } from "./cli.mjs";
import { collectRecentImages } from "./collector.mjs";
import { sendImageToBoundChat, sendMentionToBoundChat } from "./codex-chat.mjs";
import { createImageJob } from "./jobs.mjs";
import { addImage, promptHistory, readState, searchObjects, versionGroups } from "./store.mjs";
import { pluginRoot, resolveProjectDir } from "./paths.mjs";
import { canvasIdForThread, normalizeThreadId } from "./runtime.mjs";
import { APP_VERSION } from "./version.mjs";
import { createAppSession } from "./server.mjs";
import { recordCanvas, listCanvases, knownBoard, localThreads, boardIdFor, boardScopeKey, assertBoardAvailable } from "./canvas-index.mjs";
import { trashBoard, restoreBoard, permanentlyDeleteBoard, onBoardTrashed } from "./canvas-trash.mjs";
import { CANVAS_LIBRARY_ACTIONS, browseBoard, libraryAsset, importBoardImages } from "./canvas-library.mjs";
import { updateProjectMeta } from "./store.mjs";

// Keep resources and handlers in the same process generation. Reading the file
// again after an in-place update would serve new controls to an old handler.
const canvasAppHtml = await fs.readFile(path.join(pluginRoot, "public", "canvas-app.html"), "utf8");
const canvasAppRevision = crypto.createHash("sha256").update(canvasAppHtml).digest("hex").slice(0, 12);
const libraryActions = CANVAS_LIBRARY_ACTIONS;
const canvasResourceUri = `ui://huayu/canvas-${APP_VERSION}-${canvasAppRevision}.html`;
const canvasResourceMeta = {
  ui: { csp: { connectDomains: [], resourceDomains: [] }, permissions: { clipboardWrite: {} }, prefersBorder: false },
  "openai/ui": { availableDisplayModes: ["fullscreen"], preferredDisplayMode: "fullscreen" }
};
const appSessions = new Map();
const openingSessions = new Map();
onBoardTrashed(async board => {
  const scope = await boardScopeKey(board.projectDir, board.canvasId);
  for (const [id, session] of appSessions) if (await boardScopeKey(session.projectDir, session.canvasId) === scope) { session.close(); appSessions.delete(id); }
  for (const [key] of openingSessions) {
    const [projectDir, canvasId] = JSON.parse(key);
    if (await boardScopeKey(projectDir, canvasId) === scope) openingSessions.delete(key);
  }
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

const defaultToolLimit = 20;
const maxToolLimit = 100;
const defaultSinceMinutes = 120;
const millisecondsPerMinute = 60_000;
rl.on("close", () => { for (const session of appSessions.values()) session.close(); });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method?.startsWith("notifications/")) return;

  try {
    const result = await handle(message.method, message.params || {});
    respond(message.id, result);
  } catch (error) {
    respondError(message.id, error);
  }
});

async function handle(method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: params.protocolVersion || "2024-11-05",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "huayu", version: APP_VERSION }
    };
  }

  if (method === "ping") return {};
  if (method === "resources/list") return { resources: [{ uri: canvasResourceUri, name: "画屿", mimeType: "text/html;profile=mcp-app", _meta: canvasResourceMeta }] };
  if (method === "resources/read") {
    // Saved panels can reference a previous local build after an app restart.
    // Resolve only our own historical widget URIs to the current bundled UI.
    // Saved host panels can still reference a pre-画屿 widget URI.
    const savedCanvasUri = /^ui:\/\/(?:huayu|codex-canvas)\/canvas(?:-\d+\.\d+\.\d+(?:-[a-f0-9]{12})?)?\.html$/;
    if (params.uri !== canvasResourceUri && !savedCanvasUri.test(params.uri || "")) throw Object.assign(new Error("Unknown canvas resource."), { statusCode: 404 });
    return { contents: [{ uri: params.uri, mimeType: "text/html;profile=mcp-app", text: canvasAppHtml, _meta: canvasResourceMeta }] };
  }

  if (method === "tools/list") {
    return {
      tools: [
        {
          name: "canvas_library",
          title: "画屿画布库",
          description: "Private local canvas launcher, saved-board browser and cross-chat image importer. No chat turns are sent.",
          _meta: { ui: { visibility: ["app"] } },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
          inputSchema: { type: "object", required: ["action"], properties: {
            action: { type: "string", enum: libraryActions },
            boardId: { type: "string" }, threadId: { type: "string" }, refresh: { type: "boolean" }, sessionId: { type: "string" },
            objectId: { type: "string" }, original: { type: "boolean" }, sourceBoardId: { type: "string" }, objectIds: { type: "array", items: { type: "string" } },
            groupId: { type: "string" }, importedAt: { type: "string" }, offset: { type: "number" }, x: { type: "number" }, y: { type: "number" }, columns: { type: "number" }, confirmed: { type: "boolean" }
          } }
        },
        {
          name: "canvas_app_request",
          title: "画屿侧栏请求",
          description: "Private transport for the 画屿 sidebar's scoped API and image requests.",
          _meta: { ui: { visibility: ["app"] } },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
          inputSchema: { type: "object", required: ["sessionId", "path"], properties: {
            sessionId: { type: "string" }, path: { type: "string" },
            method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"] }, body: { type: "object" }
          } }
        },
        {
          name: "open_canvas",
          title: "打开画屿",
          description: "Open 画屿 directly in the plugin sidebar. Pass the active workspace projectDir and threadId. Use presentation=browser only for an explicit browser fallback.",
          _meta: { ui: { resourceUri: canvasResourceUri }, "openai/ui": { entrypoints: [{ type: "thread" }] } },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          inputSchema: {
            type: "object",
            properties: {
              presentation: { type: "string", enum: ["sidebar", "browser"], description: "Defaults to the native plugin sidebar; browser is a compatibility fallback." },
              projectDir: { type: "string", description: "Absolute path to the active Codex project." },
              port: { type: "number", description: "Local port. Defaults to 43217." },
              threadId: { type: "string", description: "Codex thread id to bind this canvas to for canvas-to-chat and thread-scoped canvas state. Defaults to the current Codex thread when available." }
            }
          }
        },
        {
          name: "add_image",
          title: "添加图片到画屿",
          description: "Copy or register an image into the current project canvas.",
          inputSchema: {
            type: "object",
            required: ["projectDir"],
            oneOf: [
              { required: ["path"] },
              { required: ["url"] },
              { required: ["dataUrl"] }
            ],
            properties: {
              projectDir: { type: "string", description: "Absolute path to the active Codex project." },
              path: { type: "string", description: "Local image path to copy into the canvas assets folder." },
              url: { type: "string", description: "Remote image URL to place on the canvas." },
              dataUrl: { type: "string", description: "Base64 image data URL." },
              name: { type: "string" },
              prompt: { type: "string" },
              imagegenPrompt: { type: "string", description: "Full prompt sent to the image generation runner, when available." },
              threadId: { type: "string", description: "Codex thread id whose canvas should receive the image. Pass this explicitly for thread-scoped canvases; omitted means the default project canvas." },
              canvasId: { type: "string", description: "Explicit 画屿 canvas id. Overrides the canvas id derived from threadId." }
            }
          }
        },
        {
          name: "canvas_status",
          title: "画屿画布状态",
          description: "Read 画屿 state for the active project.",
          inputSchema: {
            type: "object",
            required: ["projectDir"],
            properties: {
              projectDir: { type: "string", description: "Absolute path to the active Codex project." },
              threadId: { type: "string", description: "Codex thread id whose canvas status should be read. Pass this explicitly for thread-scoped canvases; omitted means the default project canvas." },
              canvasId: { type: "string", description: "Explicit 画屿 canvas id. Overrides the canvas id derived from threadId." }
            }
          }
        },
        {
          name: "search_canvas",
          title: "搜索画屿画布",
          description: "Search 画屿 objects by name, prompt, text, source path, or layer metadata.",
          inputSchema: {
            type: "object",
            required: ["projectDir"],
            properties: {
              projectDir: { type: "string", description: "Absolute path to the active Codex project." },
              query: { type: "string", description: "Search text. Empty query returns the first matching objects." },
              type: { type: "string", enum: ["image", "text", "drawing", "annotation", "job"], description: "Optional canvas object type filter." },
              limit: { type: "number", description: "Maximum number of results. Defaults to 20, capped at 100." },
              threadId: { type: "string", description: "Codex thread id whose canvas should be searched. Pass explicitly for thread-scoped canvases; omitted means the default project canvas." },
              canvasId: { type: "string", description: "Explicit 画屿 canvas id. Overrides the canvas id derived from threadId." }
            }
          }
        },
        {
          name: "prompt_history",
          title: "画屿提示词历史",
          description: "List recent unique prompts used by 画屿 objects.",
          inputSchema: {
            type: "object",
            required: ["projectDir"],
            properties: {
              projectDir: { type: "string", description: "Absolute path to the active Codex project." },
              query: { type: "string", description: "Optional text to filter prompts." },
              limit: { type: "number", description: "Maximum number of prompts. Defaults to 20, capped at 100." },
              threadId: { type: "string", description: "Codex thread id whose canvas prompt history should be read. Pass explicitly for thread-scoped canvases; omitted means the default project canvas." },
              canvasId: { type: "string", description: "Explicit 画屿 canvas id. Overrides the canvas id derived from threadId." }
            }
          }
        },
        {
          name: "version_groups",
          title: "画屿图片版本",
          description: "Group 画屿 object version history by sourceObjectId, batchId, layoutMode, or prompt.",
          inputSchema: {
            type: "object",
            required: ["projectDir"],
            properties: {
              projectDir: { type: "string", description: "Absolute path to the active Codex project." },
              query: { type: "string", description: "Optional text to filter version groups or grouped objects." },
              groupBy: { type: "string", enum: ["sourceObjectId", "batchId", "layoutMode", "prompt"], description: "Version grouping field. Defaults to sourceObjectId." },
              limit: { type: "number", description: "Maximum number of groups. Defaults to 20, capped at 100." },
              objectLimit: { type: "number", description: "Maximum number of objects returned per group. Defaults to 20, capped at 100." },
              threadId: { type: "string", description: "Codex thread id whose canvas version groups should be read. Pass explicitly for thread-scoped canvases; omitted means the default project canvas." },
              canvasId: { type: "string", description: "Explicit 画屿 canvas id. Overrides the canvas id derived from threadId." }
            }
          }
        },
        {
          name: "collect_recent_images",
          title: "收集近期生成图片",
          description: "Import recent images from the bound Codex thread directory, or from explicit recovery roots. Use as a fallback after imagegen when exact output paths are not known.",
          inputSchema: {
            type: "object",
            required: ["projectDir"],
            properties: {
              projectDir: { type: "string", description: "Absolute path to the active Codex project." },
              roots: {
                type: "array",
                items: { type: "string" },
                description: "Optional absolute or project-relative recovery directories. When omitted, only ~/.codex/generated_images/<threadId> is scanned; without a bound thread the default scan is a safe no-op."
              },
              sourceObjectId: {
                type: "string",
                description: "When collecting an image generated from a selected canvas object, place results in a row to the right of that source object."
              },
              threadId: { type: "string", description: "Codex thread id whose generated_images directory and canvas should be used. Pass explicitly for thread-scoped collection; omitted collection is a no-op unless roots are provided." },
              canvasId: { type: "string", description: "Explicit 画屿 canvas id. Overrides the canvas id derived from threadId." },
              sinceMinutes: { type: "number", description: "Only import images modified in the last N minutes. Defaults to 120." },
              limit: { type: "number", description: "Maximum number of images to import. Defaults to 20." },
              prompt: { type: "string" }
            }
          }
        },
        {
          name: "start_image_job",
          title: "开始画屿图片编辑任务",
          description: "Start an 画屿 background image action for a selected canvas image using a stable action id.",
          inputSchema: {
            type: "object",
            required: ["projectDir", "objectId", "action"],
            properties: {
              projectDir: { type: "string", description: "Absolute path to the active Codex project." },
              objectId: { type: "string", description: "Canvas image object id to edit." },
              action: {
                type: "string",
                enum: ["quick-edit", "remove-bg", "expand", "edit-elements"],
                description: "Stable 画屿 action id."
              },
              prompt: { type: "string", description: "Optional user guidance for quick-edit or expand." },
              threadId: { type: "string", description: "Codex thread id whose canvas owns the selected object. Pass explicitly for thread-scoped canvases." },
              canvasId: { type: "string", description: "Explicit 画屿 canvas id. Overrides the canvas id derived from threadId." }
            }
          }
        },
        {
          name: "send_to_chat",
          title: "将画屿图片发送到会话",
          description: "Send a selected 画屿 image to the explicitly bound Codex thread.",
          inputSchema: {
            type: "object",
            required: ["projectDir", "objectId", "action"],
            properties: {
              projectDir: { type: "string", description: "Absolute path to the active Codex project." },
              action: {
                type: "string",
                enum: ["send-to-chat", "mention-file"],
                description: "Stable 画屿 chat action id. send-to-chat sends visual input; mention-file sends a Codex @file-style mention."
              },
              objectId: { type: "string", description: "Canvas image object id to send." },
              threadId: { type: "string", description: "Codex thread id to receive the selected image. Defaults to the current Codex thread when available." },
              canvasId: { type: "string", description: "Explicit 画屿 canvas id. Overrides the canvas id derived from threadId." },
              includeImage: { type: "boolean", description: "For mention-file only, also attach the local image visual input in the same turn." }
            }
          }
        }
      ]
    };
  }

  if (method === "tools/call") {
    const args = params.arguments || {};
    if (params.name === "canvas_library") {
      if (args.action === "trash") return { content: [], structuredContent: await trashBoard(args.boardId) };
      if (args.action === "restore") return { content: [], structuredContent: await restoreBoard(args.boardId) };
      if (args.action === "delete-permanently") return { content: [], structuredContent: await permanentlyDeleteBoard(args.boardId, { confirmed: args.confirmed }) };
      if (["list", "bootstrap"].includes(args.action)) {
        const data = await listCanvases({ refresh: args.refresh === true });
        const callerThreadId = normalizeThreadId(args.threadId) || environmentThreadId();
        const current = data.threads.find(t => t.id === callerThreadId);
        const remembered = data.boards.find(b => b.id === data.lastByThread[callerThreadId]);
        const suggested = remembered || data.boards.find(b => b.threadId === callerThreadId);
        return { content: [], structuredContent: { ...data, libraryActions, runtimeRevision: canvasAppRevision, callerThreadId, currentThread: current || null, suggestedBoardId: suggested?.id || null } };
      }
      if (args.action === "open") {
        const board = await knownBoard(args.boardId);
        return openSidebar(board.projectDir, board.threadId, { canvasId: board.canvasId, title: board.threadTitle, openedBy: normalizeThreadId(args.threadId) || environmentThreadId() || "launcher" });
      }
      if (args.action === "create") {
        const thread = (await localThreads()).find(t => t.id === args.threadId);
        if (!thread || !path.isAbsolute(thread.cwd || "")) throw new Error("无法确定这个会话的工作目录，请选择已有画布。");
        const existing = (await listCanvases()).boards.find(b => b.threadId === thread.id);
        if (existing) return openSidebar(existing.projectDir, existing.threadId, { canvasId: existing.canvasId, title: thread.title, openedBy: thread.id });
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
        const projectDir = path.join(thread.cwd, "_codex", `${stamp}-canvas-${thread.id.slice(0, 8)}`, "work", "board");
        const canvasId = canvasIdForThread(thread.id);
        await fs.mkdir(projectDir, { recursive: true });
        const result = await openSidebar(projectDir, thread.id, { canvasId, title: thread.title, openedBy: thread.id });
        await updateProjectMeta(projectDir, { title: thread.title || "Untitled" }, { canvasId });
        return result;
      }
      if (args.action === "browse") return { content: [], structuredContent: await browseBoard(args.boardId) };
      if (args.action === "asset") return { content: [], structuredContent: await libraryAsset(args.boardId, args.objectId, args.original === true) };
      if (args.action === "import") {
        const session = appSessions.get(args.sessionId);
        if (!session) throw new Error("当前画布连接已失效，请在画布中重新连接。");
        await assertBoardAvailable(session.projectDir, session.canvasId);
        return { content: [], structuredContent: await importBoardImages(args, session) };
      }
      if (args.action === "import-status") {
        const session = appSessions.get(args.sessionId);
        if (!session) throw new Error("画布连接已失效。");
        await assertBoardAvailable(session.projectDir, session.canvasId);
        const state = await readState(session.projectDir, { canvasId: session.canvasId, readOnly: true });
        return { content: [], structuredContent: { entries: state.objects.map((object, index) => ({ object, index })).filter(e => e.object.importGroupId === args.groupId) } };
      }
      throw new Error("Unknown canvas library action.");
    }
    if (params.name === "canvas_app_request") {
      const session = appSessions.get(args.sessionId);
      if (!session) throw Object.assign(new Error("Canvas session expired. Call open_canvas again."), { statusCode: 404 });
      return { content: [], structuredContent: await session.request(args) };
    }
    if (params.name === "open_canvas") {
      if (args.presentation !== undefined && !["sidebar", "browser"].includes(args.presentation)) throw Object.assign(new Error("Unknown canvas presentation."), { statusCode: 400 });
      if (!args.projectDir && args.presentation !== "browser") return {
        ...textResult("Open the saved-canvas launcher directly in the sidebar.", { presentation: "sidebar", needsProject: true, launcher: true, threadId: normalizeThreadId(args.threadId) || environmentThreadId() }),
        _meta: { "openai/widgetSessionId": "huayu" }
      };
      let projectDir = requireProjectDir(args);
      if (args.presentation !== "browser") {
        const threadId = normalizeThreadId(args.threadId) || environmentThreadId();
        const saved = (await listCanvases()).boards.find(b => b.threadId === threadId && (b.projectDir === projectDir || path.relative(projectDir, b.projectDir).startsWith(`_codex${path.sep}`)));
        if (saved) projectDir = saved.projectDir;
        return openSidebar(projectDir, threadId, { canvasId: saved?.canvasId, title: saved?.threadTitle, openedBy: threadId });
      }
      const entrypoint = path.join(pluginRoot, "bin", "codex-canvas.mjs");
      const cliArgs = ["open", "--project", projectDir, "--port", String(normalizePort(args.port))];
      if (args.threadId) cliArgs.push("--thread-id", args.threadId);
      const output = await captureConsole(() => cliMain(
        cliArgs,
        { entrypoint }
      ));
      const url = output.trim().split(/\s+/).pop();
      return textResult(`画屿已就绪：[打开画屿](${url})`, { url, projectDir, threadId: normalizeThreadId(args.threadId) || environmentThreadId() });
    }

    if (params.name === "add_image") {
      const projectDir = requireProjectDir(args);
      requireSingleImageInput(args);
      const canvas = await resolveCanvasOptions(projectDir, args);
      const object = await addImage(projectDir, args, { canvasId: canvas.canvasId });
      return textResult(`已添加图片到画屿：${object.name}`, object);
    }

    if (params.name === "canvas_status") {
      const projectDir = requireProjectDir(args);
      const canvas = await resolveCanvasOptions(projectDir, args);
      const state = await readState(projectDir, { canvasId: canvas.canvasId, readOnly: true });
      return textResult(`画屿当前有 ${state.objects.length} 个对象。`, {
        projectDir,
        canvasId: canvas.canvasId,
        objects: state.objects.length,
        selection: state.selection,
        chatThreadId: canvas.threadId || null,
        chatBound: Boolean(canvas.threadId),
        updatedAt: state.updatedAt
      });
    }

    if (params.name === "search_canvas") {
      const projectDir = requireProjectDir(args);
      const canvas = await resolveCanvasOptions(projectDir, args);
      const result = await searchObjects(projectDir, {
        query: args.query || "",
        type: args.type || null,
        limit: normalizeToolLimit(args.limit),
        canvasId: canvas.canvasId
      });
      return textResult(`在画屿中找到 ${result.total} 个对象。`, result);
    }

    if (params.name === "prompt_history") {
      const projectDir = requireProjectDir(args);
      const canvas = await resolveCanvasOptions(projectDir, args);
      const result = await promptHistory(projectDir, {
        query: args.query || "",
        limit: normalizeToolLimit(args.limit),
        canvasId: canvas.canvasId
      });
      return textResult(`在画屿中找到 ${result.total} 条提示词。`, result);
    }

    if (params.name === "version_groups") {
      const projectDir = requireProjectDir(args);
      const canvas = await resolveCanvasOptions(projectDir, args);
      const result = await versionGroups(projectDir, {
        query: args.query || "",
        groupBy: args.groupBy || "sourceObjectId",
        limit: normalizeToolLimit(args.limit),
        objectLimit: normalizeToolLimit(args.objectLimit),
        canvasId: canvas.canvasId
      });
      return textResult(`在画屿中找到 ${result.total} 组版本。`, result);
    }

    if (params.name === "collect_recent_images") {
      const projectDir = requireProjectDir(args);
      const canvas = await resolveCanvasOptions(projectDir, args);
      const result = await collectRecentImages(projectDir, {
        roots: Array.isArray(args.roots) ? args.roots : [],
        sinceMs: sinceMsFromMinutes(args.sinceMinutes),
        limit: normalizeToolLimit(args.limit),
        prompt: args.prompt || "Collected after image generation",
        sourceObjectId: args.sourceObjectId || null,
        canvasId: canvas.canvasId,
        threadId: canvas.threadId
      });
      return textResult(`已将 ${result.imported.length} 张近期图片收集到画屿。`, result);
    }

    if (params.name === "start_image_job") {
      const projectDir = requireProjectDir(args);
      const canvas = await resolveCanvasOptions(projectDir, args);
      const job = await createImageJob(projectDir, {
        objectId: args.objectId,
        action: args.action,
        prompt: args.prompt || ""
      }, { canvasId: canvas.canvasId });
      return textResult(`已为画屿对象 ${args.objectId} 启动 ${args.action}。`, job);
    }

    if (params.name === "send_to_chat") {
      const projectDir = requireProjectDir(args);
      const canvas = await resolveCanvasOptions(projectDir, args);
      requireSendToChatAction(args);
      if (!canvas.threadId) {
        const error = new Error("send_to_chat requires an explicit Codex threadId.");
        error.statusCode = 400;
        throw error;
      }
      const state = await readState(projectDir, { canvasId: canvas.canvasId, readOnly: true });
      const object = state.objects.find((item) => item.id === args.objectId);
      if (!object || (object.type || "image") !== "image") {
        const error = new Error("A selected canvas image object is required before sending to chat.");
        error.statusCode = 400;
        throw error;
      }
      const imagePath = object.assetPath || object.sourcePath;
      const result = args.action === "mention-file"
        ? await sendMentionToBoundChat({
          projectDir,
          threadId: canvas.threadId,
          filePath: imagePath,
          prompt: `画屿将 @${object.name || "selected-image"} 添加为文件上下文。暂时不要分析或编辑，只回复文件已可用，并等待下一条指令。`,
          includeImage: args.includeImage === true
        })
        : await sendImageToBoundChat({
          projectDir,
          threadId: canvas.threadId,
          imagePath,
          prompt: "将这张选中的画屿图片作为上下文。"
        });
      return textResult(`已将画屿对象 ${object.id} 发送到 Codex 会话 ${canvas.threadId}。`, {
        ...result,
        action: args.action,
        objectId: object.id,
        imagePath
      });
    }
  }

  throw new Error(`Unsupported MCP method: ${method}`);
}

async function openSidebar(projectDir, threadId, { canvasId = canvasIdForThread(threadId), title, openedBy } = {}) {
  await assertBoardAvailable(projectDir, canvasId);
  const key = JSON.stringify([projectDir, canvasId]);
  if (!openingSessions.has(key)) openingSessions.set(key, createAppSession({ projectDir, threadId, canvasId }).then(session => {
    const sessionId = crypto.randomUUID();
    appSessions.set(sessionId, { ...session, projectDir, canvasId, threadId });
    return { sessionId, projectId: session.projectId, projectDir, canvasId, threadId, boardId: boardIdFor(projectDir, canvasId), threadTitle: title || "" };
  }).catch(error => { openingSessions.delete(key); throw error; }));
  const session = await openingSessions.get(key);
  if (title) session.threadTitle = title;
  await recordCanvas({ projectDir, canvasId, threadId, threadTitle: title, openedBy });
  return { ...textResult("已在插件侧栏打开画屿。", { presentation: "sidebar", projectDir, threadId, projectId: session.projectId }),
    _meta: { "openai/widgetSessionId": "huayu", canvasSession: session } };
}

function requireProjectDir(args = {}) {
  const projectDir = typeof args.projectDir === "string" ? args.projectDir.trim() : "";
  if (!projectDir) {
    const error = new Error("MCP tool call requires projectDir.");
    error.statusCode = 400;
    throw error;
  }
  if (!path.isAbsolute(projectDir)) {
    const error = new Error("MCP tool call requires an absolute projectDir.");
    error.statusCode = 400;
    throw error;
  }
  return resolveProjectDir(projectDir);
}

function textResult(text, data) {
  return {
    content: [{ type: "text", text }],
    structuredContent: data
  };
}

function requireSingleImageInput(args = {}) {
  const present = ["path", "url", "dataUrl"].filter((field) => typeof args[field] === "string" && args[field].trim());
  if (present.length === 1) return;
  const error = new Error("add_image requires exactly one image input: path, url, or dataUrl.");
  error.statusCode = 400;
  throw error;
}

function requireSendToChatAction(args = {}) {
  if (args.action === "send-to-chat" || args.action === "mention-file") return;
  const error = new Error("send_to_chat requires a stable chat action: send-to-chat or mention-file.");
  error.statusCode = 400;
  throw error;
}

function normalizeToolLimit(value) {
  if (value === undefined || value === null || value === "") return defaultToolLimit;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return defaultToolLimit;
  return Math.min(maxToolLimit, Math.max(1, Math.round(number)));
}

function sinceMsFromMinutes(value) {
  const minutes = normalizeSinceMinutes(value);
  const now = Date.now();
  const deltaMs = minutes * millisecondsPerMinute;
  const sinceMs = now - deltaMs;
  if (!Number.isFinite(deltaMs) || !Number.isFinite(sinceMs)) {
    return now - defaultSinceMinutes * millisecondsPerMinute;
  }
  return sinceMs;
}

function normalizeSinceMinutes(value) {
  if (value === undefined || value === null || value === "") return defaultSinceMinutes;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return defaultSinceMinutes;
  return number;
}

function respond(id, result) {
  if (id === undefined || id === null) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, error) {
  if (id === undefined || id === null) return;
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: jsonRpcErrorCode(statusCode),
      message: error?.message || String(error),
      data: { statusCode }
    }
  })}\n`);
}

function jsonRpcErrorCode(statusCode) {
  if (statusCode === 400) return -32602;
  if (statusCode === 403) return -32003;
  if (statusCode === 404) return -32004;
  if (statusCode === 409) return -32009;
  if (statusCode === 503) return -32003;
  return -32000;
}

async function captureConsole(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

async function resolveCanvasOptions(projectDir, args = {}, runtime = null) {
  const explicitThreadId = normalizeThreadId(args.threadId);
  const explicitCanvasId = normalizeThreadId(args.canvasId);
  const threadId = explicitThreadId || environmentThreadId();
  const canvasId = explicitCanvasId || canvasIdForThread(explicitThreadId);
  await assertBoardAvailable(projectDir, canvasId || canvasIdForThread(threadId) || null);
  return {
    threadId,
    canvasId: canvasId || canvasIdForThread(threadId) || null
  };
}

function environmentThreadId() {
  return normalizeThreadId(process.env.CODEX_CANVAS_CODEX_THREAD_ID || process.env.CODEX_THREAD_ID);
}
