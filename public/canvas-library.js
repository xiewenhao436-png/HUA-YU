import { showProjectCanvasCenter } from "./canvas-center.js";

const titleOf = board => board.threadTitle || board.title || "未命名画布";
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
const button = (text, action) => { const b = el("button", "library-button", text); b.type = "button"; b.onclick = action; return b; };

function boardPath(value) {
  let text = String(value || "").replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-z]:\//i.test(text) || text.startsWith("//")) text = text.toLowerCase();
  return text;
}
const withinPath = (parent, child) => parent && (parent === child || child.startsWith(parent + "/"));
function workspaceFor(board, threads) {
  const dir = boardPath(board.projectDir);
  const organized = dir.indexOf("/_codex/");
  if (organized >= 0) return dir.slice(0, organized);
  const own = threads.find(t => t.id === board.threadId);
  if (own?.cwd && withinPath(boardPath(own.cwd), dir)) return boardPath(own.cwd);
  return threads.map(t => boardPath(t.cwd)).filter(cwd => withinPath(cwd, dir)).sort((a, b) => b.length - a.length)[0] || dir;
}
export function selectProjectCanvases(data, scope) {
  const all = data.boards || [], threads = data.threads || [];
  const identity = board => `${boardPath(board.projectDir)}\n${board.canvasId || ""}`;
  const current = all.find(b => b.id === scope.boardId) || all.find(b => identity(b) === identity(scope)) || scope;
  const root = workspaceFor(current, threads);
  const unique = new Map();
  for (const board of all) {
    if (workspaceFor(board, threads) !== root) continue;
    const key = identity(board);
    if (!unique.has(key) || board.id === current.id) unique.set(key, board);
  }
  const boards = [...unique.values()].map(b => ({ ...b, current: identity(b) === identity(current) }));
  boards.sort((a, b) => Number(b.current) - Number(a.current) || (b.updatedAt || "").localeCompare(a.updatedAt || "") || (a.title || "").localeCompare(b.title || ""));
  return { root, boards };
}

export function groupCanvasProjects(data) {
  const groups = new Map(), seen = new Set();
  for (const board of data.boards || []) {
    const identity = `${boardPath(board.projectDir)}\n${board.canvasId || ""}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const root = workspaceFor(board, data.threads || []);
    if (!groups.has(root)) groups.set(root, { root, boards: [] });
    groups.get(root).boards.push(board);
  }
  return [...groups.values()].sort((a, b) => a.root.localeCompare(b.root, "zh-CN"));
}

export async function showCanvasLauncher({ container, call, threadId, isBound, onOpen, autoOpen = true }) {
  return showProjectCanvasCenter({ container, call, threadId, isBound, onOpen, autoOpen, groupBoards: groupCanvasProjects });
}

export function installCanvasLibrary(host) {
  const dialog = el("dialog", "canvas-library-dialog"); dialog.id = "canvasLibrary";
  dialog.setAttribute("aria-label", "从其他会话导入图片");
  const header = el("header", "library-header");
  const heading = el("div", ""); heading.append(el("h2", "", "从其他会话导入"));
  const destination = el("p", "library-destination"); heading.append(destination);
  const close = button("关闭 · Esc", () => closeDialog()); close.dataset.library = "close";
  header.append(heading, close);
  const body = el("div", "library-body");
  const aside = el("aside", "library-sidebar");
  const search = el("input", "library-search"); search.placeholder = "搜索来源会话或画布";
  const refresh = button("刷新旧画布", () => load(true));
  const boards = el("div", "library-board-list"); aside.append(search, refresh, boards);
  const content = el("section", "library-content");
  const sourceLabel = el("h3", "library-source-label", "选择左侧的来源画布");
  const tools = el("div", "library-grid-tools");
  const selectAll = button("全选", () => { const q = photoSearch.value.toLocaleLowerCase(); for (const o of images.filter(o => String(o.name).toLocaleLowerCase().includes(q))) selected.add(o.id); renderGrid(); }); selectAll.dataset.library = "select-all";
  const clear = button("清空选择", () => { selected.clear(); renderGrid(); });
  const photoSearch = el("input", "library-search"); photoSearch.placeholder = "按图片名称筛选";
  tools.append(selectAll, clear, photoSearch);
  const status = el("div", "library-status", "正在读取本机画布…"); status.setAttribute("role", "status");
  const grid = el("div", "library-image-grid");
  const pages = el("div", "library-pagination");
  content.append(sourceLabel, tools, status, grid, pages);
  body.append(aside, content);
  const footer = el("footer", "library-footer");
  const selectionLabel = el("span", "library-selection-label", "未选择图片");
  const cancel = button("取消剩余导入", () => { cancelled = true; }); cancel.hidden = true;
  const importSelected = button("导入所选", () => runImport(false)); importSelected.dataset.library = "import-selected";
  const importAll = button("导入全部图片", () => runImport(true)); importAll.dataset.library = "import-all";
  footer.append(selectionLabel, cancel, importSelected, importAll);
  dialog.append(header, body, footer); document.body.append(dialog);
  let data = [], source = null, images = [], selected = new Set(), page = 0, epoch = 0, busy = false, cancelled = false;
  const pageSize = 36;
  const thumbnails = new Map();
  let previousFocus;
  function closeDialog() {
    if (busy) { cancelled = true; status.textContent = "正在保存已完成的导入，随后停止剩余部分…"; return; }
    epoch++; dialog.close(); (previousFocus?.isConnected ? previousFocus : host.board).focus({ preventScroll: true });
  }
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
  dialog.addEventListener("pointerdown", event => event.stopPropagation());
  dialog.addEventListener("keydown", event => event.stopPropagation());
  function selectionState() {
    selectionLabel.textContent = source ? `已选 ${selected.size} / ${images.length} 张 · 导入后标记来源：${titleOf(source)}` : "未选择图片";
    importSelected.disabled = busy || !selected.size;
    importAll.disabled = busy || !images.length;
    search.disabled = refresh.disabled = photoSearch.disabled = selectAll.disabled = clear.disabled = busy;
    cancel.hidden = !busy;
  }
  function renderBoards() {
    boards.replaceChildren();
    const query = search.value.toLocaleLowerCase();
    for (const board of data.filter(b => `${titleOf(b)} ${b.title}`.toLocaleLowerCase().includes(query))) {
      const b = button("", () => choose(board)); b.dataset.sourceBoard = board.id;
      b.classList.toggle("active", board.id === source?.id);
      b.disabled = busy;
      b.append(el("strong", "", titleOf(board)), el("span", "", `${board.imageCount} 张图片 · ${board.title || "画布"}`));
      boards.append(b);
    }
  }
  async function load(refreshScan = false) {
    status.textContent = refreshScan ? "正在扫描已知项目的历史画布…" : "正在读取画布列表…";
    try {
      const result = await host.call({ action: "list", refresh: refreshScan });
      const target = host.scope();
      data = result.boards.filter(b => b.id !== target.boardId && !(target.projectDir && b.projectDir === target.projectDir && (b.canvasId || null) === (target.canvasId || null)));
      renderBoards();
      status.textContent = data.length ? "选择来源画布；浏览和选择不会修改原画布。" : "暂无其他画布，可点“刷新旧画布”扫描已有项目。";
      selectionState();
    } catch (error) { status.textContent = error.message; }
  }
  async function choose(board) {
    if (busy) return;
    source = board; images = []; selected.clear(); page = 0; photoSearch.value = ""; renderBoards(); renderGrid();
    const token = ++epoch;
    status.textContent = "正在读取来源画布…";
    try {
      const result = await host.call({ action: "browse", boardId: board.id });
      if (token !== epoch || !dialog.open) return;
      images = result.images; sourceLabel.textContent = `${titleOf(board)} · ${images.length} 张图片`;
      renderGrid();
    } catch (error) { if (token === epoch) status.textContent = error.message; }
  }
  function renderGrid() {
    const token = ++epoch;
    grid.replaceChildren(); pages.replaceChildren();
    const query = photoSearch.value.toLocaleLowerCase();
    const filtered = images.filter(o => String(o.name).toLocaleLowerCase().includes(query));
    page = Math.max(0, Math.min(Math.ceil(filtered.length / pageSize) - 1, page));
    const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
    const pending = [];
    for (const object of visible) {
      const card = el("label", "library-image-card"); card.dataset.sourceImage = object.id;
      const check = el("input"); check.type = "checkbox"; check.checked = selected.has(object.id); check.disabled = busy;
      check.setAttribute("aria-label", `选择 ${object.name}`);
      check.onchange = () => { if (check.checked) selected.add(object.id); else selected.delete(object.id); card.classList.toggle("selected", check.checked); selectionState(); };
      card.classList.toggle("selected", check.checked);
      const thumbnail = el("img"); thumbnail.alt = object.name || "Image"; thumbnail.draggable = false;
      const key = `${source.id}/${object.id}`;
      if (thumbnails.has(key)) thumbnail.src = thumbnails.get(key);
      else pending.push({ thumbnail, object, key });
      thumbnail.ondblclick = event => { event.preventDefault(); preview(object); };
      card.append(check, thumbnail, el("span", "", object.name || object.id)); grid.append(card);
    }
    if (filtered.length > pageSize) {
      const prev = button("上一页", () => { page--; renderGrid(); }); prev.disabled = busy || page === 0;
      const next = button("下一页", () => { page++; renderGrid(); }); next.disabled = busy || (page + 1) * pageSize >= filtered.length;
      pages.append(prev, el("span", "", `${page + 1} / ${Math.ceil(filtered.length / pageSize)}`), next);
    }
    status.textContent = source ? `显示 ${visible.length} 张 / 共 ${filtered.length} 张，双击缩略图可看原图。` : "选择来源画布";
    selectionState();
    let cursor = 0;
    Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (cursor < pending.length && token === epoch && dialog.open) {
        const { thumbnail, object, key } = pending[cursor++];
        try {
          const asset = await host.call({ action: "asset", boardId: source.id, objectId: object.id });
          const url = `data:${asset.mime};base64,${asset.base64}`;
          thumbnails.set(key, url);
          if (token === epoch) thumbnail.src = url;
        } catch { if (token === epoch) thumbnail.alt = `${object.name}（缩略图未加载，仍可尝试导入）`; }
      }
    })).catch(() => {});
  }
  async function preview(object) {
    if (busy) return;
    const viewer = el("dialog", "library-original-preview");
    const close = button("关闭原图 · Esc", () => { viewer.close(); viewer.remove(); });
    const message = el("div", "library-status", "正在读取原图…"); const img = el("img"); img.alt = object.name;
    viewer.append(close, message, img); document.body.append(viewer);
    viewer.addEventListener("pointerdown", event => event.stopPropagation());
    viewer.addEventListener("keydown", event => event.stopPropagation());
    viewer.addEventListener("cancel", event => { event.preventDefault(); viewer.close(); viewer.remove(); });
    viewer.showModal();
    try { const asset = await host.call({ action: "asset", boardId: source.id, objectId: object.id, original: true }); if (viewer.open) { img.src = `data:${asset.mime};base64,${asset.base64}`; message.textContent = object.name; } }
    catch (error) { message.textContent = error.message; }
  }
  async function runImport(all) {
    if (busy || !source) return;
    const ids = all ? images.map(o => o.id) : images.filter(o => selected.has(o.id)).map(o => o.id);
    if (!ids.length) return;
    busy = true; cancelled = false; selectionState(); renderBoards();
    try {
      const result = await host.import({ source, ids, cancelled: () => cancelled, progress: text => { status.textContent = text; } });
      status.textContent = `已导入 ${result.count} 张${result.errors ? `，${result.errors} 张未完成` : ""}${cancelled ? "（已停止剩余部分）" : ""}。来源框已加入当前画布，可整批撤销。`;
      host.toast(status.textContent);
    } catch (error) { status.textContent = error.message; host.toast(error.message); }
    finally { busy = false; selectionState(); renderBoards(); }
  }
  search.oninput = renderBoards;
  photoSearch.oninput = () => { page = 0; renderGrid(); };
  return {
    async open() {
      previousFocus = document.activeElement;
      destination.textContent = `导入到：${host.title()}。图片保存为本项目的独立副本。`;
      if (!dialog.open) dialog.showModal();
      await load(!data.length);
    },
    close() { cancelled = true; epoch++; dialog.close(); },
    get active() { return dialog.open; }
  };
}
