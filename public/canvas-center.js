import { installHomeSettings } from './home-settings.js';
/*! Lucide icons (ISC), including Feather-derived icons (MIT). See assets/lucide-license.txt. */
// Local workspace browser. Icons use Lucide paths (ISC), with no remote fonts,
// scripts or image services. Board names and metadata are always text nodes.
const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const paths = {
  grid: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M14 14h7v7h-7z", "M3 14h7v7H3z"],
  folder: ["M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z"],
  trash: ["M3 6h18", "M19 6l-1 14H6L5 6", "M9 6V3h6v3", "M10 10v7", "M14 10v7"],
  search: ["M21 21l-4.34-4.34", "M11 11m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0"],
  plus: ["M12 5v14", "M5 12h14"],
  refresh: ["M20 7v5h-5", "M4 17v-5h5", "M6.1 7a7 7 0 0 1 11.55-2.61L20 7", "M4 17l2.35 2.61A7 7 0 0 0 17.9 17"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  arrow: ["M7 17 17 7", "M7 7h10v10"],
  restore: ["M3 10h6", "M3 10V4", "M3.8 9a9 9 0 1 1 2.8 10", "M12 7v5l3 2"],
  close: ["M18 6 6 18", "M6 6l12 12"],
  image: ["M3 3h18v18H3z", "M3 15l5-5 4 4 3-3 6 6", "M16 7h.01"]
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  for (const d of paths[name] || paths.grid) { const p = document.createElementNS(svg.namespaceURI, "path"); p.setAttribute("d", d); svg.append(p); }
  return svg;
}
function action(text, symbol, run, cls = "") {
  const b = node("button", `center-button ${cls}`); b.type = "button";
  if (symbol) b.append(icon(symbol)); b.append(node("span", "", text)); b.onclick = run; return b;
}
const nameOf = b => b.title && b.title !== "Untitled" ? b.title : b.threadTitle || "未命名画布";
const projectName = root => root.split(/[\\/]/).filter(Boolean).at(-1) || "未归属项目";
const previewCache = new Map();
const cleanups = new WeakMap();

export async function showProjectCanvasCenter({ container, call, threadId, isBound, onOpen, autoOpen, groupBoards }) {
  cleanups.get(container)?.();
  const lifetime = new AbortController(), signal = lifetime.signal;
  const layoutProperties = ["padding", "place-content", "gap", "background", "color", "font", "text-align", "overflow"];
  const previousLayout = layoutProperties.map(name => [name, container.style.getPropertyValue(name), container.style.getPropertyPriority(name)]);
  for (const name of layoutProperties) container.style.removeProperty(name);
  let observer, toastTimer, thumbnailActive = 0;
  const thumbnailQueue = [];
  const alive = () => !signal.aborted && !isBound();
  const menu = node("div", "center-context-menu"); menu.hidden = true; menu.setAttribute("role", "menu");
  const confirm = node("dialog", "center-confirm-dialog"); confirm.setAttribute("aria-label", "确认永久删除画布");
  const create = node("dialog", "center-create-dialog"); create.setAttribute("aria-label", "新建画布");
  const cleanup = () => {
    if (signal.aborted) return;
    lifetime.abort(); observer?.disconnect(); clearTimeout(toastTimer); menu.remove(); confirm.remove(); create.remove();
    container.classList.remove("canvas-launcher", "canvas-center");
    for (const [name, value, priority] of previousLayout) { if (value) container.style.setProperty(name, value, priority); else container.style.removeProperty(name); }
    if (cleanups.get(container) === cleanup) cleanups.delete(container);
  };
  cleanups.set(container, cleanup);
  container.replaceChildren(); container.classList.add("canvas-launcher", "canvas-center");
  const shell = node("section", "library-launcher-panel center-shell");
  const rail = node("aside", "center-sidebar"); rail.setAttribute("aria-label", "画布项目");
  const brand = node("div", "center-brand"); brand.append(icon("grid"), node("span", "", "画屿"), node("small", "", "工作区"));
  const allButton = action("全部项目", "grid", () => selectView("all"), "center-nav"); allButton.dataset.centerView = "all";
  const projectsLabel = node("div", "center-nav-label", "项目");
  const projectList = node("nav", "center-projects");
  const trashButton = action("回收站", "trash", () => selectView("trash"), "center-nav center-trash-nav"); trashButton.dataset.centerView = "trash";
  const hiddenButton = action("已隐藏", "folder", () => selectView("hidden"), "center-nav");
  rail.append(brand, allButton, projectsLabel, projectList, hiddenButton, trashButton);
  const main = node("main", "center-main");
  const heading = node("header", "center-heading");
  const headingCopy = node("div"); const eyebrow = node("div", "center-eyebrow", "A SPACE FOR IDEAS");
  const title = node("h1", "", "让灵感，自由生长"); const subtitle = node("p", "", "在画屿，收集每一个值得继续的想法");
  headingCopy.append(eyebrow, title, subtitle);
  const newButton = action("新建画布", "plus", showCreate, "center-primary");
  heading.append(headingCopy);
  const tools = node("div", "center-tools"); const searchWrap = node("label", "center-search-wrap");
  const search = node("input", "library-search center-search"); search.type = "search"; search.placeholder = "搜索画布、会话或项目"; search.setAttribute("aria-label", "搜索画布");
  searchWrap.append(icon("search"), search);
  const sort = node("select", "center-sort"); sort.setAttribute("aria-label", "画布排序");
  for (const [value, label] of [["recent", "最近更新"], ["name", "名称顺序"]]) { const o = node("option", "", label); o.value = value; sort.append(o); }
  const refresh = action("刷新", "refresh", () => load(true), "center-refresh"); refresh.title = "刷新并扫描已有画布";
  tools.append(searchWrap, sort, refresh, newButton);
  const upgradeMessage = "画布插件仍在运行旧版本。请保存工作后完整退出并重新打开 Codex，再使用回收站；现有画布仍可浏览。";
  const upgrade = node("p", "center-status center-runtime-notice", upgradeMessage); upgrade.hidden = true; upgrade.setAttribute("role", "status");
  const status = node("div", "library-status center-status", "正在读取画布…"); status.setAttribute("role", "status");
  const list = node("div", "library-launcher-list center-groups");
  const toast = node("div", "center-toast"); toast.hidden = true; toast.setAttribute("role", "status");
  main.append(heading, tools, upgrade, status, list); shell.append(rail, main); container.append(shell, toast, menu, confirm, create);
  let data = { boards: [], trash: [], threads: [] }, view = "all", project = "", busy = false;
  const languageLabels = { '隐藏项目':'Hidden projects', '可恢复的画布':'Recoverable canvases', '项目画布':'Project canvases', '恢复项目':'Restore project', '全部项目':'All projects', '项目':'Projects', '已隐藏':'Hidden', '回收站':'Trash', '工作区':'Workspace', '新建画布':'New canvas', '刷新':'Refresh', '最近更新':'Recently updated', '名称顺序':'Name', '让灵感，自由生长':'Let ideas grow freely', '在画屿，收集每一个值得继续的想法':'Collect every idea worth exploring in Huayu' };
  const originalLabels = new WeakMap();
  let centerLanguage = 'zh';
  function applyCenterLanguage(next) {
    centerLanguage = next;
    const walker = document.createTreeWalker(shell, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      if (text.parentElement.closest('.center-home-settings')) continue;
      const current = text.textContent;
      if (languageLabels[current]) originalLabels.set(text, current);
      const original = originalLabels.get(text);
      if (original) { const value = next === 'en' ? languageLabels[original] : original; if (text.textContent !== value) text.textContent = value; }
    }
    search.placeholder = next === 'en' ? 'Search canvases, chats or projects' : '搜索画布、会话或项目';
  }
  installHomeSettings({ rail, call, signal, onLanguage: applyCenterLanguage });

  const supports = actionName => Array.isArray(data.libraryActions) && data.libraryActions.includes(actionName);
  function notice(message, undo) {
    clearTimeout(toastTimer); toast.replaceChildren(node("span", "", message));
    if (undo) toast.append(action("撤销", null, undo));
    toast.hidden = false; toastTimer = setTimeout(() => { toast.hidden = true; }, 8000);
  }
  function selectView(next, root = "") {
    view = next; project = root; menu.hidden = true; search.value = ""; render(); main.scrollTop = 0;
  }
  function relativeTime(value) {
    const date = new Date(value); if (!Number.isFinite(date.getTime())) return "";
    const now = new Date();
    return date.toDateString() === now.toDateString() ? `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  }
  function updateNav(groups) {
    allButton.classList.toggle("active", view === "all"); allButton.setAttribute("aria-current", view === "all" ? "page" : "false");
    trashButton.classList.toggle("active", view === "trash"); trashButton.setAttribute("aria-current", view === "trash" ? "page" : "false");
    trashButton.querySelector(".center-count")?.remove(); trashButton.append(node("small", "center-count", groupBoards({ ...data, boards: data.trash || [] }).reduce((n, g) => n + g.boards.length, 0)));
    hiddenButton.classList.toggle("active", view === "hidden");
    projectList.replaceChildren();
    for (const group of groups) {
      const b = action(projectName(group.root), "folder", () => selectView("project", group.root), "center-nav");
      b.dataset.centerProject = group.root; b.title = group.root; b.classList.toggle("active", view === "project" && project === group.root);
      b.append(node("small", "center-count", group.boards.length));
      b.oncontextmenu = event => { event.preventDefault(); showProjectMenu(group.root, event); };
      projectList.append(b);
    }
  }
  function render() {
    if (!alive()) return;
    upgrade.hidden = ["trash", "restore", "delete-permanently"].every(supports);
    const allGroups = groupBoards(data), hiddenRoots = new Set(data.hiddenProjects || []), hiddenBoards = new Set(data.hiddenBoards || []);
    const groups = allGroups.filter(g => !hiddenRoots.has(g.root)).map(g => ({ ...g, boards: g.boards.filter(b => !hiddenBoards.has(b.id)) })).filter(g => g.boards.length); updateNav(groups);
    title.textContent = view === "trash" ? "回收站" : view === "hidden" ? "隐藏项目" : view === "project" ? projectName(project) : "让灵感，自由生长";
    eyebrow.textContent = view === "trash" ? "可恢复的画布" : view === "project" ? "项目画布" : "A SPACE FOR IDEAS";
    subtitle.textContent = view === "trash" ? "恢复误删的画布；永久删除需要再次确认。" : "在画屿，收集每一个值得继续的想法";
    newButton.hidden = view === "trash";
    observer?.disconnect(); thumbnailQueue.length = 0; list.replaceChildren();
    const q = search.value.trim().toLocaleLowerCase(); let count = 0;
    main.classList.toggle("center-home", view === "all" && !q);
    if (view === "all" && !q) { status.textContent = ""; applyCenterLanguage(centerLanguage); return; }
    const displayed = view === "trash" ? groupBoards({ ...data, boards: data.trash || [] }) : view === "hidden" ? allGroups.map(g => ({ ...g, boards: hiddenRoots.has(g.root) ? g.boards : g.boards.filter(b => hiddenBoards.has(b.id)) })).filter(g => g.boards.length) : groups;
    for (const group of displayed) {
      if (view === "project" && project !== group.root) continue;
      const boards = group.boards.filter(b => `${nameOf(b)} ${b.threadTitle} ${group.root}`.toLocaleLowerCase().includes(q));
      if (!boards.length) continue;
      boards.sort((a, b) => sort.value === "name" ? nameOf(a).localeCompare(nameOf(b), "zh-CN") : (b.trashedAt || b.updatedAt || "").localeCompare(a.trashedAt || a.updatedAt || ""));
      count += boards.length;
      const section = node("section", "center-project-section"); section.dataset.projectGroup = group.root;
      const label = node("header", "center-project-heading"); const h = node("h2", "", projectName(group.root)); h.title = group.root;
      label.append(h, node("span", "", `${boards.length} 个画布`));
      if (view === "hidden" && hiddenRoots.has(group.root)) label.append(action("恢复项目", "restore", () => setHidden(group.root, false)));
      const grid = node("div", "center-card-grid"); for (const board of boards) grid.append(card(board));
      section.append(label, grid); list.append(section);
    }
    status.textContent = view === "trash" ? `${count} 个画布 · 永久删除需确认` : `${count} 个画布 · ${view === "project" ? 1 : groups.length} 个项目`;
    if (!count) {
      const empty = node("div", "center-empty"); empty.append(icon(view === "trash" ? "trash" : "folder"), node("h2", "", q ? "没有找到匹配的画布" : view === "trash" ? "回收站是空的" : "从第一张画布开始"), node("p", "", q ? "试试其他名称，或清除搜索条件。" : view === "trash" ? "移入这里的画布可以恢复，直到你确认永久删除。" : "新建画布，或刷新查找已有项目。")); list.append(empty);
    }
    observePreviews();
    applyCenterLanguage(centerLanguage);
  }
  async function setHidden(root, hidden) {
    if (!supports("project-visibility")) { notice(upgradeMessage); return; }
    try { await call({ action: "project-visibility", projectRoot: root, hidden }); await load(false, false); notice(hidden ? "项目已隐藏" : "项目已恢复"); } catch (error) { notice(error.message || "操作失败"); }
  }
  function showProjectMenu(root, event) {
    menu.replaceChildren(action("隐藏项目", "folder", () => { menu.hidden = true; setHidden(root, true); }));
    menu.hidden = false; menu.style.left = `${event.clientX}px`; menu.style.top = `${event.clientY}px`;
  }
  async function setBoardVisibility(board, hidden) {
    if (!supports("board-visibility")) { notice(upgradeMessage); return; }
    try { await call({ action: "board-visibility", boardId: board.id, hidden }); await load(false, false); notice(hidden ? "画布已隐藏" : "画布已恢复"); } catch (error) { notice(error.message || "操作失败"); }
  }
  function card(board) {
    const article = node("article", "center-board-card"); article.dataset.canvasId = board.id;
    const open = node("button", "center-board-open"); open.type = "button"; open.dataset.boardId = board.id; open.title = nameOf(board);
    const preview = node("div", "center-card-preview"); preview.append(icon("image"));
    if (view !== "trash" && board.coverId) { preview.dataset.previewBoard = board.id; preview._canvasBoard = board; }
    else preview.append(node("span", "", view === "trash" ? (board.purgeStartedAt ? "删除未完成，请重试" : "画布已移入回收站") : "空白画布"));
    const count = node("span", "center-image-count", `${board.imageCount || 0} 张`); preview.append(count);
    const body = node("div", "center-card-body"); body.append(node("h3", "", nameOf(board)), node("p", "center-card-chat", board.threadTitle || "未绑定会话"));
    const meta = node("div", "center-card-meta"); meta.append(node("span", "", relativeTime(board.trashedAt || board.updatedAt)), icon("arrow")); body.append(meta);
    open.append(preview, body);
    open.onclick = () => view === "trash" ? showMenu(board, open.getBoundingClientRect()) : openBoard("open", board.id);
    const more = action("画布操作", "more", event => { event.stopPropagation(); showMenu(board, more.getBoundingClientRect()); }, "center-card-more"); more.setAttribute("aria-label", `画布操作：${nameOf(board)}`); more.title = "画布操作";
    article.append(open, more); article.oncontextmenu = event => { event.preventDefault(); showMenu(board, { x: event.clientX, y: event.clientY }); };
    return article;
  }
  function showMenu(board, rect) {
    menu.replaceChildren(); const trashed = view === "trash";
    const add = (label, symbol, run, danger, actionName) => {
      const b = action(label, symbol, () => { menu.hidden = true; run(); }, danger ? "center-danger" : ""); b.setAttribute("role", "menuitem");
      if (actionName && !supports(actionName)) { b.disabled = true; b.setAttribute("aria-disabled", "true"); b.title = upgradeMessage; }
      menu.append(b);
    };
    if (view === "hidden" && (data.hiddenBoards || []).includes(board.id)) add("恢复画布", "restore", () => setBoardVisibility(board, false), false, "board-visibility");
    if (trashed) {
      if (board.canRestore !== false && !board.purgeStartedAt) add("恢复画布", "restore", () => changeBoard("restore", board), false, "restore");
      add(board.purgeStartedAt ? "继续永久删除…" : "永久删除…", "trash", () => confirmDelete(board), true, "delete-permanently");
    }
    else { if (view !== "hidden") add("隐藏画布", "folder", () => setBoardVisibility(board, true), false, "board-visibility"); add("打开画布", "arrow", () => openBoard("open", board.id)); add("重命名", null, () => renameBoard(board), false, "rename"); add("复制到项目…", null, () => copyToProject(board), false, "copy-board"); for (let n = 1; n <= 5; n++) add(`${n} 星${board.importance === n ? " ✓" : ""}`, null, () => editMetadata(board, { importance: n }), false, "importance"); add("移到回收站", "trash", () => changeBoard("trash", board), true, "trash"); }
    menu.hidden = false;
    const box = menu.getBoundingClientRect(), x = rect.x ?? rect.left, y = rect.height ? rect.bottom + 4 : rect.y;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`; menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
    menu.querySelector("button")?.focus();
  }
  function copyToProject(board) {
    const groups = groupBoards(data);
    create.setAttribute("aria-label", "复制画布到项目"); create.replaceChildren();
    create.append(node("h2", "", "复制画布到项目"), node("p", "", "创建独立画布副本，原画布和会话保持不变。"));
    const select = node("select", "library-thread-select"); select.setAttribute("aria-label", "目标项目");
    for (const group of groups) { const option = node("option", "", `${projectName(group.root)} — ${group.root}`); option.value = group.boards[0].projectDir; select.append(option); }
    const error = node("p", "center-create-error"); error.setAttribute("role", "alert");
    const controls = node("div", "center-dialog-actions");
    const submit = action("复制", null, async () => { if (busy || !select.value) return; busy = true; submit.disabled = true; try { await call({ action: "copy-board", boardId: board.id, targetProject: select.value }); create.close(); await load(false, false); notice("画布副本已创建"); } catch (e) { error.textContent = e.message || "复制失败，请重试。"; } finally { busy = false; submit.disabled = false; } }, "center-primary");
    controls.append(action("取消", null, () => create.close()), submit); create.append(select, error, controls); create.showModal(); select.focus();
  }
  async function editMetadata(board, fields) {
    if (busy || !alive()) return;
    busy = true;
    try { await call({ action: fields.displayTitle !== undefined ? "rename" : "importance", boardId: board.id, ...fields }); await load(false, false); notice("画布信息已保存"); }
    catch (error) { notice(error.message || "操作没有完成，请重试。"); }
    finally { busy = false; }
  }
  function renameBoard(board) {
    if (busy) return;
    create.replaceChildren(); create.setAttribute("aria-label", "重命名画布");
    const heading = node("h2", "", "重命名画布");
    const input = node("input", "library-search"); input.type = "text"; input.maxLength = 200; input.value = nameOf(board); input.setAttribute("aria-label", "画布名称");
    const error = node("p", "center-create-error"); error.setAttribute("role", "alert");
    const controls = node("div", "center-dialog-actions");
    const save = action("保存", null, async () => {
      if (busy) return;
      const value = input.value.trim();
      if (!value) { error.textContent = "请输入画布名称。"; input.focus(); return; }
      busy = true; save.disabled = true;
      try { await call({ action: "rename", boardId: board.id, displayTitle: value }); create.close(); await load(false, false); notice("画布名称已保存"); }
      catch (e) { error.textContent = e.message || "重命名失败，请重试。"; }
      finally { busy = false; save.disabled = false; }
    }, "center-primary");
    input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); save.click(); } });
    controls.append(action("取消", null, () => create.close()), save); create.append(heading, input, error, controls); create.showModal(); input.focus(); input.select();
  }
  async function changeBoard(actionName, board, confirmed = false) {
    if (busy || !alive()) return false;
    if (!supports(actionName)) { upgrade.hidden = false; notice(upgradeMessage); return false; }
    busy = true;
    try {
      await call({ action: actionName, boardId: board.id, ...(confirmed ? { confirmed: true } : {}) });
      await load(false, false);
      if (actionName === "trash") notice("画布已移入回收站", () => changeBoard("restore", board));
      else notice(actionName === "restore" ? "画布已恢复到原项目" : "画布已永久删除");
      return true;
    } catch (error) { await load(false, false); notice(error.message || "操作没有完成，请重试。"); return false; }
    finally { busy = false; }
  }
  function confirmDelete(board) {
    if (!supports("delete-permanently")) { upgrade.hidden = false; notice(upgradeMessage); return; }
    confirm.replaceChildren(); const badge = node("div", "center-delete-icon"); badge.append(icon("trash"));
    const title = node("h2", "", "永久删除这张画布？");
    const description = node("p", "", board.purgeStartedAt ? "上次永久删除未完成，将继续清理这张画布及其画布素材副本。此操作无法撤销。" : "将删除这张画布及其画布素材副本。此操作无法撤销。");
    const summary = node("div", "center-delete-summary"); summary.append(node("strong", "", nameOf(board)), node("span", "", `${board.imageCount || 0} 张图片 · ${projectName(groupBoards({ ...data, boards: [board] })[0]?.root || "")}`));
    const controls = node("div", "center-dialog-actions");
    const cancel = action("取消", null, () => confirm.close());
    const remove = action("永久删除", null, async () => { remove.disabled = cancel.disabled = true; try { if (await changeBoard("delete-permanently", board, true)) confirm.close(); } finally { remove.disabled = cancel.disabled = false; } }, "center-destructive");
    controls.append(cancel, remove); confirm.append(badge, title, description, summary, controls); confirm.showModal(); cancel.focus();
  }
  function showCreate() {
    if (busy) return;
    create.setAttribute("aria-label", "新建画布"); create.replaceChildren(); const heading = node("div", "center-create-heading"); heading.append(node("h2", "", "新建画布"), action("关闭", "close", () => create.close(), "center-icon-button"));
    const text = node("p", "", "选择所属会话，画布会保存到该会话的项目目录。");
    const select = node("select", "library-thread-select"); select.setAttribute("aria-label", "画布所属会话");
    const placeholder = node("option", "", "选择会话"); placeholder.value = ""; select.append(placeholder);
    for (const thread of data.threads || []) { const option = node("option", "", thread.title || thread.id); option.value = thread.id; select.append(option); }
    if (data.currentThread?.id) select.value = data.currentThread.id;
    const location = node("div", "center-create-location"); select.onchange = () => { location.textContent = data.threads.find(t => t.id === select.value)?.cwd || ""; }; select.onchange();
    const error = node("p", "center-create-error"); error.setAttribute("role", "alert");
    const controls = node("div", "center-dialog-actions"); controls.append(action("取消", null, () => create.close()), action("创建画布", "plus", async () => { if (!select.value) { error.textContent = "请先选择所属会话。"; return; } await openBoard("create", select.value, error); }, "center-primary"));
    create.append(heading, text, select, location, error, controls); create.showModal(); select.focus();
  }
  async function openBoard(actionName, id, errorNode) {
    if (busy || !alive()) return;
    busy = true; status.textContent = "正在打开画布…";
    try {
      const result = await call({ action: actionName, ...(actionName === "create" ? { threadId: id } : { boardId: id, threadId }) });
      if (!alive()) return;
      // Close modal surfaces before the editor becomes visible.
      if (create.open) create.close();
      await onOpen(result); cleanup();
    } catch (error) { (errorNode || status).textContent = error.message || "打开失败，请重试。"; }
    finally { busy = false; }
  }
  async function load(refreshScan, allowAutoOpen = autoOpen) {
    if (!alive()) return;
    status.textContent = refreshScan ? "正在查找已有项目画布…" : "正在读取画布…"; refresh.disabled = true;
    try {
      const result = await call({ action: "bootstrap", threadId, refresh: refreshScan });
      if (!alive()) return;
      data = result.structuredContent || result; data.trash ||= [];
      if (allowAutoOpen && data.suggestedBoardId && data.callerThreadId) { await openBoard("open", data.suggestedBoardId); return; }
      render();
    } catch (error) { status.textContent = error.message || "画布列表未能加载。点击刷新重试。"; }
    finally { refresh.disabled = false; }
  }
  function observePreviews() {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); thumbnailQueue.push(entry.target); }
      pumpPreviews();
    }, { root: main, rootMargin: "180px" });
    list.querySelectorAll("[data-preview-board]").forEach(p => observer.observe(p));
  }
  function pumpPreviews() {
    while (alive() && thumbnailActive < 3 && thumbnailQueue.length) {
      const preview = thumbnailQueue.shift(); if (!preview.isConnected) continue;
      const board = preview._canvasBoard, key = `${board.id}:${board.coverId}:${board.updatedAt}`;
      thumbnailActive++;
      (async () => {
        try {
          let url = previewCache.get(key);
          if (!url) {
            const result = await call({ action: "asset", boardId: board.id, objectId: board.coverId, original: false });
            const asset = result.structuredContent || result;
            if (!asset.base64) return;
            url = `data:${asset.mime || "image/png"};base64,${asset.base64}`; previewCache.set(key, url);
            if (previewCache.size > 80) previewCache.delete(previewCache.keys().next().value);
          }
          if (!alive() || !preview.isConnected) return;
          const img = node("img"); img.alt = ""; img.src = url; img.decoding = "async"; preview.prepend(img); preview.classList.add("has-preview");
        } catch { /* An unavailable cover must not block the workspace browser. */ }
        finally { thumbnailActive--; pumpPreviews(); }
      })();
    }
  }
  document.addEventListener("pointerdown", event => { if (!menu.contains(event.target) && !event.target.closest(".center-card-more")) menu.hidden = true; }, { signal });
  document.addEventListener("keydown", event => { if (event.key === "Escape") menu.hidden = true; }, { signal });
  search.oninput = render; sort.onchange = render;
  await load(true);
  applyCenterLanguage(centerLanguage);
}
