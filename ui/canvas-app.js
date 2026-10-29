import { App } from "@modelcontextprotocol/ext-apps";
import { showCanvasLauncher } from "../public/canvas-library.js";

const newApp = () => new App({ name: "画屿", version: "0.2.0" }, { availableDisplayModes: ["fullscreen"] }, { autoResize: false });
let app = newApp();
let session;
let started = false;
let disposed = false;
let callerThreadId = "";
let launcherPending = null;
let launcherCallerId = null;
let launcherEpoch = 0;
let reconnecting = false;
let recoveryPending = null;
let bindingPending = null;
let pendingBoardId = null;
let bindingEpoch = 0;
let launcherMode = false;
let locallyNavigated = false;
let scopeChangePending = Promise.resolve();
let resolveSession;
const sessionReady = new Promise(resolve => { resolveSession = resolve; });
const assets = new Map();
const emptyImage = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const assetStatus = document.createElement("button");
assetStatus.id = "canvasAssetStatus";
assetStatus.type = "button";
assetStatus.hidden = true;
Object.assign(assetStatus.style, { position: "fixed", left: "12px", bottom: "70px", maxWidth: "calc(100% - 24px)", zIndex: "9998", padding: "8px 12px", border: "1px solid #ddd", borderRadius: "8px", background: "#fff", color: "#202124", font: "12px system-ui" });
assetStatus.onclick = () => window.codexCanvasApp.onScopeChange?.().catch(() => {});
document.body.append(assetStatus);
const status = document.createElement("div");
status.id = "canvasConnection";
Object.assign(status.style, { position: "fixed", inset: "0", display: "grid", placeContent: "center", gap: "16px", background: "#f7f7f8", color: "#202124", font: "14px system-ui", zIndex: "9999", padding: "32px", textAlign: "center" });
status.textContent = "正在连接画屿…";
document.body.append(status);

function showOpenAction(message) {
  if (disposed) return;
  status.style.display = "grid";
  if (session) {
    status.replaceChildren();
    const label = document.createElement("div"); label.textContent = message;
    const button = document.createElement("button"); button.textContent = "重新连接画布";
    button.onclick = async () => {
      if (reconnecting) return;
      button.disabled = true; label.textContent = "正在重新连接…";
      try {
        await recoverSession(session, true);
      } catch { label.textContent = "连接尚未恢复，可重试。若 Codex 已停止插件进程，请重新打开插件面板。"; }
      finally { button.disabled = false; }
    };
    const home = document.createElement("button"); home.textContent = "返回画布中心";
    home.onclick = () => openCenter();
    status.append(label, button, home);
    return;
  }
  if (!launcherPending || launcherCallerId !== callerThreadId) {
    const generation = ++launcherEpoch;
    launcherCallerId = callerThreadId;
    const pending = showCanvasLauncher({ container: status, call: libraryCall, threadId: callerThreadId,
      isBound: () => Boolean(session) || generation !== launcherEpoch,
      onOpen: result => { if (generation === launcherEpoch) acceptSession(result); } })
      .finally(() => { if (launcherPending === pending) launcherPending = null; });
    launcherPending = pending;
  }
}

function openCenter() {
  if (disposed) return;
  locallyNavigated = true;
  launcherMode = true;
  ++bindingEpoch;
  pendingBoardId = null;
  const generation = ++launcherEpoch;
  document.querySelector(".app-shell").inert = true;
  status.style.display = "grid";
  return showCanvasLauncher({ container: status, call: libraryCall, threadId: callerThreadId, autoOpen: false,
    isBound: () => !launcherMode || generation !== launcherEpoch,
    onOpen: result => { if (generation === launcherEpoch) { acceptSession(result); return scopeChangePending; } }
  });
}

const expiredSession = message => /session expired|画布连接已失效|当前画布连接已失效/i.test(message || "");
const closedTransport = message => /not connected|connection.*closed|transport.*closed/i.test(message || "");
const unavailableBoard = message => /画布已移入回收站|画布已经在回收站|已彻底删除|画布不存在或素材目录已移动/.test(message || "");
function toolError(result, fallback) {
  if (result.isError || !result.structuredContent) throw new Error(result.content?.find(c => c.type === "text")?.text || fallback);
  return result;
}
async function rawLibraryCall(args) {
  const result = await app.callServerTool({ name: "canvas_library", arguments: args }, { timeout: 120000 });
  return toolError(result, "画布操作未完成，请重试。");
}
async function libraryCall(args) {
  const requestedSession = session;
  try { return await rawLibraryCall(args); }
  catch (error) {
    // The server rejects an expired id before running an import. Only this
    // explicit rejection is safe to retry; a lost write acknowledgement is not.
    if (!args.sessionId || !requestedSession || !expiredSession(error.message)) throw error;
    if (args.sessionId === requestedSession.sessionId) await recoverSession(requestedSession);
    if (session !== requestedSession) throw new Error("画布已切换，请在当前画布重试。");
    return rawLibraryCall({ ...args, sessionId: session.sessionId });
  }
}

async function recoverSession(expected, resetTransport = false) {
  if (disposed || !expected || session !== expected) throw new Error("Canvas scope changed.");
  if (recoveryPending) return recoveryPending;
  const pending = (async () => {
    reconnecting = true;
    try {
      if (resetTransport) {
        app.onclose = undefined;
        await app.close().catch(() => {});
        app = newApp(); wireApp();
        await app.connect(undefined, { timeout: 15000 });
      }
      const result = await rawLibraryCall({ action: "open", boardId: expected.boardId, threadId: callerThreadId });
      if (disposed || session !== expected || (pendingBoardId && pendingBoardId !== expected.boardId)) throw new Error("Canvas scope changed.");
      acceptSession(result, { restoreOnly: launcherMode });
      return session;
    } finally { reconnecting = false; }
  })().finally(() => { if (recoveryPending === pending) recoveryPending = null; });
  recoveryPending = pending;
  return pending;
}

function receiveToolResult(result) {
  // Once the user navigates inside the panel, saved chat tool results must not
  // redirect it back to the initially opened board or dismiss the center.
  if (locallyNavigated) return;
  const next = result._meta?.canvasSession;
  if (result.isError || !next) { acceptSession(result); return; }
  // Tool results are persisted by the host, while transport ids belong to one
  // MCP process. Resolve the saved board in the current process before loading
  // state or images. Replayed results for an already bound board are harmless.
  if (next.boardId && (pendingBoardId === next.boardId || (!bindingPending && session?.boardId === next.boardId))) return;
  const generation = ++bindingEpoch;
  pendingBoardId = next.boardId;
  ++launcherEpoch;
  callerThreadId ||= result.structuredContent?.threadId || next.threadId || "";
  status.style.display = "grid";
  status.textContent = "正在恢复已保存的画布…";
  const pending = (async () => {
    let boardId = next.boardId;
    if (!boardId) {
      const data = (await rawLibraryCall({ action: "list" })).structuredContent;
      boardId = data.boards.find(b => b.projectDir === next.projectDir && (b.canvasId || null) === (next.canvasId || null))?.id;
      if (!boardId) throw new Error("找不到已保存的画布，请从画布中心重新选择。");
    }
    const restored = await rawLibraryCall({ action: "open", boardId, threadId: callerThreadId });
    if (!disposed && generation === bindingEpoch) acceptSession(restored);
  })().catch(() => {
    if (!disposed && generation === bindingEpoch) showOpenAction("画布尚未恢复，请重新选择或重试。");
  }).finally(() => {
    if (bindingPending === pending) { bindingPending = null; pendingBoardId = null; }
  });
  bindingPending = pending;
}

function acceptSession(result, { restoreOnly = false } = {}) {
  if (result.isError) return;
  const next = result._meta?.canvasSession;
  if (!next) {
    callerThreadId ||= result.structuredContent?.threadId || "";
    if (!session && result.structuredContent?.needsProject) showOpenAction("Choose this chat's workspace to open the canvas. / 请绑定当前对话的工作区。");
    return;
  }
  const threadId = result.structuredContent?.threadId || next.threadId || "";
  ++launcherEpoch;
  callerThreadId ||= threadId;
  const changed = session && (next.projectId !== session.projectId || next.boardId !== session.boardId || threadId !== session.threadId);
  if (changed) {
    for (const asset of assets.values()) if (asset.url) URL.revokeObjectURL(asset.url);
    assets.clear();
    assetStatus.hidden = true;
  }
  // Reopening the same panel must preserve session identity. Replacing this
  // object mid-load cancels prepareAssets and strands entries without a URL.
  if (!session || changed) session = { ...next, threadId };
  else Object.assign(session, next, { threadId });
  if (!restoreOnly) {
    launcherMode = false;
    document.querySelector(".app-shell").inert = false;
    status.style.display = "none";
  }
  resolveSession(session);
  if (changed) scopeChangePending = Promise.resolve(window.codexCanvasApp.onScopeChange?.()).catch(() => showOpenAction("Could not load this canvas. Reopen it from the chat."));
}
function wireApp() {
 app.ontoolresult = receiveToolResult;
 app.onteardown = async () => {
  disposed = true;
  for (const asset of assets.values()) if (asset.url) URL.revokeObjectURL(asset.url);
  assets.clear();
  return {};
};
 app.onclose = () => {
   if (!reconnecting && !disposed) {
     if (session) recoverSession(session, true).catch(() => showOpenAction("画布连接已断开，可直接在这里重新连接。"));
     else showOpenAction("画布连接已断开，请重新打开插件面板。");
   }
 };
}
wireApp();

async function request(path, options = {}) {
  await sessionReady;
  if (disposed) throw new Error("Canvas panel is closed.");
  const requestedSession = session;
  const requestedId = requestedSession.sessionId;
  const method = options.method || "GET";
  async function send() {
    if (session !== requestedSession) throw new Error("Canvas scope changed.");
    return toolError(await app.callServerTool({ name: "canvas_app_request", arguments: {
      sessionId: session.sessionId, path, method,
      ...(options.body ? { body: JSON.parse(options.body) } : {})
    } }, { timeout: 120000 }), "Canvas request failed.");
  }
  let result;
  try { result = await send(); }
  catch (error) {
    if (session === requestedSession && unavailableBoard(error.message)) {
      if (!launcherMode) await openCenter();
      throw error;
    }
    const expired = expiredSession(error.message);
    const closed = closedTransport(error.message);
    if (session !== requestedSession || (!expired && !closed)) throw error;
    try {
      if (session.sessionId === requestedId) await recoverSession(requestedSession, closed);
      if (closed && method !== "GET") throw new Error("连接已恢复，请确认刚才的操作结果后再重试。");
      result = await send();
    } catch (recoveryError) {
      if (session === requestedSession && unavailableBoard(recoveryError.message)) { if (!launcherMode) await openCenter(); }
      else if (expiredSession(recoveryError.message) || closedTransport(recoveryError.message)) showOpenAction("画布连接暂时不可用，可直接重新连接。");
      throw recoveryError;
    }
  }
  const data = result.structuredContent;
  const bytes = data.encoding === "base64" ? Uint8Array.from(atob(data.body), ch => ch.charCodeAt(0)) : JSON.stringify(data.body);
  return new Response(bytes, { status: data.status, headers: data.headers });
}

function assetKey(object) { return `${object.src}\n${object.assetVersion || 0}`; }
function blobDataUrl(blob) {
  // MCP hosts may allow data: images while excluding blob: from img-src.
  // Keep the original Blob for downloads; rendering must not require a URL fetch.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read image bytes."));
    reader.readAsDataURL(blob);
  });
}
window.codexCanvasApp = {
  get scope() { return session; },
  get active() { return !disposed && !document.hidden && !launcherMode; },
  get inLauncher() { return launcherMode; },
  openCenter,
  fetch: request,
  async library(args) {
    const result = await libraryCall(args);
    if (result._meta?.canvasSession) { locallyNavigated = true; acceptSession(result); await scopeChangePending; }
    return result.structuredContent;
  },
  assetUrl(src, object) { return assets.get(assetKey({ ...object, src }))?.url || (src.startsWith("data:") ? src : emptyImage); },
  async imageBlob(object) {
    const cached = assets.get(assetKey(object))?.blob;
    if (cached) return cached;
    const requestedSession = session;
    const response = await request(`/api/app-assets/${encodeURIComponent(object.id)}`);
    if (!response.ok || session !== requestedSession) throw new Error("Original image unavailable.");
    return response.blob();
  },
  async prepareAssets(objects) {
    const assetSession = session;
    const wanted = new Set();
    const pending = [];
    for (const object of objects) {
      if (!object.src || object.src.startsWith("data:")) continue;
      const key = assetKey(object);
      wanted.add(key);
      if (!assets.has(key)) pending.push(object);
    }
    let completed = 0;
    let failed = 0;
    const progress = () => {
      if (disposed || session !== assetSession) return;
      assetStatus.hidden = completed === pending.length && failed === 0;
      assetStatus.textContent = completed < pending.length
        ? `正在载入图片 ${completed}/${pending.length}`
        : `${failed} 张图片未能加载，点此重试`;
      assetStatus.disabled = completed < pending.length;
    };
    progress();
    const load = async object => {
      if (disposed || session !== assetSession) return;
      const key = assetKey(object);
      const entry = {};
      assets.set(key, entry);
      try {
        const response = await request(`/api/app-assets/${encodeURIComponent(object.id)}`);
        if (!response.ok) throw new Error("Image unavailable");
        entry.blob = await response.blob();
        if (disposed || session !== assetSession) return;
        const url = await blobDataUrl(entry.blob);
        if (disposed || session !== assetSession) return;
        entry.url = url;
        window.codexCanvasApp.onAssetReady?.(object, url);
      } catch {
        failed++;
        if (assets.get(key) === entry) assets.delete(key);
      } finally { completed++; progress(); }
    };
    // Bound host RPC traffic while avoiding one round trip per image in series.
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (cursor < pending.length && !disposed && session === assetSession) {
        const object = pending[cursor++];
        if (assets.has(assetKey(object))) { completed++; progress(); continue; }
        await load(object);
      }
    }));
    if (disposed || session !== assetSession) return;
    for (const [key, entry] of assets) if (!wanted.has(key)) {
      if (entry.url) URL.revokeObjectURL(entry.url);
      assets.delete(key);
    }
  },
  async download(href, filename, object = null) {
    // Even fetch(blob:) is blocked by connect-src 'none' in an MCP sandbox.
    let blob = object ? await this.imageBlob(object) : [...assets.values()].find(asset => asset.url === href)?.blob;
    if (!blob && href.startsWith("data:")) {
      const match = href.match(/^data:([^;,]+);base64,(.*)$/s);
      if (match) blob = new Blob([Uint8Array.from(atob(match[2]), ch => ch.charCodeAt(0))], { type: match[1] });
    }
    if (!blob) {
      const response = await request(href);
      if (!response.ok) throw new Error("Download failed.");
      blob = await response.blob();
    }
    if (app.getHostCapabilities()?.downloadFile) {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.onerror = reject; reader.readAsDataURL(blob);
      });
      const result = await app.downloadFile({ contents: [{ type: "resource", resource: { uri: `file:///${encodeURIComponent(filename)}`, mimeType: blob.type, blob: data } }] });
      if (result.isError) throw new Error("Download failed.");
    } else {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }
};

try {
  await app.connect(undefined, { timeout: 15000 });
  const host = app.getHostContext();
  callerThreadId ||= host?.threadId || host?.["openai/threadId"] || host?._meta?.["openai/threadId"] || "";
  if (host?.displayMode !== "fullscreen" && host?.availableDisplayModes?.includes("fullscreen")) {
    await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {});
  }
  if (!session && !bindingPending) showOpenAction("选择已保存的画布。");
  await sessionReady;
  if (!started) { started = true; await import("../public/app.js"); }
} catch (error) {
  showOpenAction(`Could not open canvas: ${error.message}`);
}
