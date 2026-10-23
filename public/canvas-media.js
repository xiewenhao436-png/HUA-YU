// Local media interactions shared by the browser and the native MCP panel.
// No model calls, remote clipboard relay, or automatic clipboard reads.
export function installCanvasMedia(host) {
  const zh = (cn, en) => host.language() === "zh" ? cn : en;
  const dialog = document.createElement("dialog");
  dialog.id = "imagePreview";
  dialog.className = "image-preview";
  dialog.setAttribute("aria-label", "Image preview / 图片预览");
  dialog.innerHTML = `<header class="image-preview-header">
    <div class="image-preview-heading"><strong id="previewTitle"></strong><span id="previewInfo" aria-live="polite"></span></div>
    <div class="image-preview-controls">
      <button type="button" data-preview="fit"></button><button type="button" data-preview="actual">1:1</button>
      <span id="previewZoom"></span><button type="button" data-preview="copy"></button>
      <button type="button" data-preview="save"></button><button type="button" data-preview="close" class="preview-close"></button>
    </div></header>
    <div id="previewStage" class="image-preview-stage"><img id="previewImage" alt="" draggable="false" hidden><div id="previewStatus" role="status"></div></div>
    <footer class="image-preview-footer"><button type="button" data-preview="previous"></button><span id="previewHint"></span><button type="button" data-preview="next"></button></footer>`;
  document.body.append(dialog);
  const image = dialog.querySelector("#previewImage");
  const stage = dialog.querySelector("#previewStage");
  const status = dialog.querySelector("#previewStatus");
  const menu = document.createElement("div");
  menu.id = "imageContextMenu";
  menu.className = "image-context-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.append(menu);
  let preview = null;
  let loadToken = 0;
  let pan = null;
  let menuObject = null;
  let menuFocus = null;
  let menuInvoker = null;

  function labelControls() {
    const labels = {
      fit: zh("适应窗口", "Fit window"), actual: zh("原始尺寸 1:1", "Original 1:1"),
      copy: zh("复制图片", "Copy image"), save: zh("另存原图", "Save original"),
      close: zh("关闭预览 · Esc", "Close · Esc"), previous: zh("上一张 ←", "← Previous"), next: zh("下一张 →", "Next →")
    };
    for (const button of dialog.querySelectorAll("[data-preview]")) {
      button.textContent = labels[button.dataset.preview];
      button.setAttribute("aria-label", labels[button.dataset.preview]);
    }
    dialog.querySelector("#previewHint").textContent = zh("滚轮缩放 · 拖动查看 · ← → 切换", "Scroll to zoom · Drag to pan · ← → to browse");
  }

  function sequenceFor(object) {
    const objects = host.objects().filter(item => (item.type || "image") === "image" && item.src);
    const chosen = host.selection().map(id => objects.find(item => item.id === id)).filter(Boolean);
    if (chosen.length > 1 && chosen.some(item => item.id === object.id)) return { objects: chosen, label: zh("当前选中", "Selection") };
    if (object.importGroupId) return { objects: objects.filter(item => item.importGroupId === object.importGroupId), label: `${zh("来源", "Source")}: ${object.importedFrom?.threadTitle || object.importedFrom?.boardTitle || ""}` };
    const shotKey = item => String(item.shotId || item.shot || "")
      || String(item.name || "").match(/(?:^|[\s_\-])((?:SC|SHOT)\d+|镜头\s*\d+|镜号\s*\d+)/i)?.[1]?.replace(/\s/g, "").toUpperCase();
    const shot = shotKey(object);
    let group = shot ? objects.filter(item => shotKey(item) === shot) : [];
    let label = shot ? `${zh("镜头", "Shot")} ${shot}` : "";
    if (group.length < 2 && object.batchId) {
      group = objects.filter(item => item.batchId === object.batchId);
      label = zh("当前批次", "Current batch");
    }
    if (group.length < 2) { group = objects; label = zh("当前画布", "Canvas"); }
    // Keep the board's stored order; selection order above is the user's order.
    return { objects: group, label };
  }

  function open(object) {
    if (!object?.src) return;
    closeMenu();
    host.resetGestures();
    const { objects, label } = sequenceFor(object);
    preview = { objects, label, index: Math.max(0, objects.findIndex(item => item.id === object.id)), focus: document.activeElement, scale: 1, x: 0, y: 0, mode: "fit" };
    labelControls();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('[data-preview="close"]').focus({ preventScroll: true });
    showCurrent();
  }

  async function showCurrent() {
    stopPan();
    const token = ++loadToken;
    const object = preview.objects[preview.index];
    preview.mode = "fit";
    image.hidden = true;
    image.removeAttribute("src");
    image.alt = object.name || "Image";
    image.dataset.objectId = object.id;
    dialog.querySelector("#previewTitle").textContent = object.name || object.id;
    dialog.querySelector("#previewInfo").textContent = `${preview.label} · ${preview.index + 1} / ${preview.objects.length}`;
    dialog.querySelector('[data-preview="previous"]').disabled = preview.index === 0;
    dialog.querySelector('[data-preview="next"]').disabled = preview.index === preview.objects.length - 1;
    dialog.querySelector("#previewZoom").textContent = "—";
    status.textContent = zh("正在载入原图…", "Loading original…");
    try {
      const url = await blobDataUrl(await host.blob(object));
      if (!preview || token !== loadToken) return;
      image.src = url;
      await image.decode();
      if (!preview || token !== loadToken) return;
      image.hidden = false;
      status.textContent = "";
      dialog.querySelector("#previewInfo").textContent += ` · ${image.naturalWidth} × ${image.naturalHeight}`;
      fit();
    } catch {
      if (!preview || token !== loadToken) return;
      status.replaceChildren();
      const message = document.createElement("span");
      message.textContent = zh("原图暂时无法加载。", "Original image unavailable.");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = zh("重试", "Retry");
      retry.onclick = showCurrent;
      status.append(message, retry);
    }
  }

  function transform() {
    if (!preview) return;
    image.style.width = `${image.naturalWidth}px`;
    image.style.height = `${image.naturalHeight}px`;
    image.style.transform = `translate(${preview.x}px, ${preview.y}px) scale(${preview.scale})`;
    dialog.querySelector("#previewZoom").textContent = `${Math.round(preview.scale * 100)}%`;
  }
  function fit() {
    if (!preview || image.hidden) return;
    preview.mode = "fit";
    preview.scale = Math.min((stage.clientWidth - 40) / image.naturalWidth, (stage.clientHeight - 40) / image.naturalHeight, 1);
    preview.scale = Math.max(0.001, preview.scale);
    preview.x = preview.y = 0;
    transform();
  }
  function actual() {
    if (!preview || image.hidden) return;
    preview.mode = "manual";
    preview.scale = 1;
    preview.x = preview.y = 0;
    transform();
  }
  function navigate(direction) {
    if (!preview) return;
    const index = Math.max(0, Math.min(preview.objects.length - 1, preview.index + direction));
    if (index === preview.index) return;
    preview.index = index;
    closeMenu();
    showCurrent();
  }
  function stopPan() {
    if (!pan) return;
    const pointerId = pan.id;
    pan = null;
    stage.classList.remove("is-panning");
    if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
  }
  function close() {
    closeMenu();
    if (!preview) return;
    const previousFocus = preview.focus;
    preview = null;
    ++loadToken;
    stopPan();
    image.removeAttribute("src");
    image.hidden = true;
    dialog.close();
    (previousFocus?.isConnected ? previousFocus : host.board).focus({ preventScroll: true });
    host.closed?.();
  }
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("pointerdown", event => event.stopPropagation());
  dialog.addEventListener("click", event => {
    const action = event.target.closest("[data-preview]")?.dataset.preview;
    if (!action) return;
    const object = preview?.objects[preview.index];
    if (action === "close") close();
    if (action === "fit") fit();
    if (action === "actual") actual();
    if (action === "previous") navigate(-1);
    if (action === "next") navigate(1);
    if (action === "copy") copy(object);
    if (action === "save") save(object);
  });
  stage.addEventListener("wheel", event => {
    event.preventDefault();
    if (!preview || image.hidden) return;
    const rect = stage.getBoundingClientRect();
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    const scale = Math.max(0.001, Math.min(16, preview.scale * Math.exp(-Math.max(-240, Math.min(240, delta)) * 0.0024)));
    const ratio = scale / preview.scale;
    preview.x = x - (x - preview.x) * ratio;
    preview.y = y - (y - preview.y) * ratio;
    preview.scale = scale;
    preview.mode = "manual";
    transform();
  }, { passive: false });
  stage.addEventListener("pointerdown", event => {
    if (!preview || image.hidden || event.button !== 0 || event.target.closest("button")) return;
    event.preventDefault();
    pan = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: preview.x, y: preview.y };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("is-panning");
  });
  stage.addEventListener("pointermove", event => {
    if (!pan || !preview || pan.id !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) { stopPan(); return; }
    preview.x = pan.x + event.clientX - pan.clientX;
    preview.y = pan.y + event.clientY - pan.clientY;
    preview.mode = "manual";
    transform();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) stage.addEventListener(type, stopPan);
  window.addEventListener("blur", stopPan);
  new ResizeObserver(() => { if (preview?.mode === "fit") fit(); }).observe(stage);

  async function copy(object) {
    if (!object) return;
    try {
      if (!navigator.clipboard?.write || !window.ClipboardItem) throw new DOMException("Clipboard unavailable", "NotAllowedError");
      // Start write during the user gesture, before any asset fetch/conversion.
      const png = host.blob(object).then(asPng);
      png.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      host.toast(zh("图片已复制，可粘贴到其他应用。", "Image copied. Paste it into another app."));
    } catch (error) {
      host.toast(error?.name === "NotAllowedError"
        ? zh("当前宿主未允许复制图片，请用“另存原图”。", "Image clipboard access unavailable. Use Save original.")
        : zh("图片复制失败，请重试或使用“另存原图”。", "Could not copy the image. Retry or use Save original."));
    }
  }
  async function save(object) {
    if (!object) return;
    try { await host.save(object); }
    catch (error) { if (error?.name !== "AbortError") host.toast(zh("保存原图失败，请重试。", "Could not save the original. Try again.")); }
  }
  async function copyPrompt(object) {
    const prompt = String(object?.imagegenPrompt || object?.prompt || "");
    if (!prompt.trim()) { host.toast(zh("这张图片没有记录生成提示词。", "No generation prompt is recorded for this image.")); return; }
    try { await host.copyText(prompt); host.toast(zh("生成提示词已复制。", "Generation prompt copied.")); }
    catch { host.toast(zh("无法写入剪贴板。", "Clipboard access unavailable.")); }
  }
  function closeMenu(restore = false) {
    menu.hidden = true;
    menuObject = null;
    if (restore && menuFocus?.isConnected) menuFocus.focus({ preventScroll: true });
    menuInvoker?.removeAttribute("aria-expanded");
  }
  function openMenu(object, x, y, invoker) {
    closeMenu();
    menuObject = object;
    menuFocus = document.activeElement;
    menuInvoker = invoker;
    menu.replaceChildren();
    const entries = [
      ["preview", zh("放大预览", "Open preview")], ["copy", zh("复制图片", "Copy image")],
      ["save", zh("另存原图", "Save original")], ["prompt", zh("复制画面的生成提示词", "Copy generation prompt")]
    ];
    for (const [action, label] of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.dataset.mediaAction = action;
      button.textContent = label;
      menu.append(button);
    }
    // A native dialog is in the top layer; its menu must live there too.
    (preview ? dialog : document.body).append(menu);
    menu.hidden = false;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.firstElementChild.focus({ preventScroll: true });
  }
  menu.addEventListener("pointerdown", event => event.stopPropagation());
  menu.addEventListener("click", event => {
    const action = event.target.closest("[data-media-action]")?.dataset.mediaAction;
    if (!action) return;
    const object = menuObject;
    closeMenu(true);
    if (action === "preview") open(object);
    if (action === "copy") copy(object);
    if (action === "save") save(object);
    if (action === "prompt") copyPrompt(object);
  });
  document.addEventListener("contextmenu", event => {
    if (host.editable(event.target)) return;
    const id = event.target.closest(".canvas-object")?.dataset.id;
    const object = preview && stage.contains(event.target) ? preview.objects[preview.index] : host.objects().find(item => item.id === id && (item.type || "image") === "image");
    if (!object) return;
    event.preventDefault();
    event.stopPropagation();
    openMenu(object, event.clientX, event.clientY, event.target);
  });
  document.addEventListener("pointerdown", event => { if (!menu.contains(event.target)) closeMenu(); }, { capture: true });
  document.addEventListener("keydown", event => {
    if (!menu.hidden) {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeMenu(true); return; }
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        const buttons = [...menu.children];
        buttons[(buttons.indexOf(document.activeElement) + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
        return;
      }
    }
    if (!preview) return;
    if (event.key === "Escape") close();
    else if (event.key === "ArrowLeft") navigate(-1);
    else if (event.key === "ArrowRight") navigate(1);
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") copy(preview.objects[preview.index]);
    else if (event.key === "0") fit();
    else if (event.key === "1") actual();
    else if (["Tab", "Enter", " "].includes(event.key) && event.target.closest("button")) { event.stopImmediatePropagation(); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
  document.addEventListener("paste", event => {
    if (preview || !menu.hidden) return;
    if (host.editable(event.target) || !host.ready()) return;
    const data = event.clipboardData;
    if (!data) return;
    const files = [...data.files].filter(host.imageCandidate);
    if (files.length) {
      event.preventDefault();
      host.upload(files, { source: "paste" }).catch(error => host.toast(error.message));
      return;
    }
    if (data.files.length) return;
    const text = data.getData("text/plain").replace(/\r\n?/g, "\n");
    if (!text.trim()) return;
    event.preventDefault();
    host.pasteText(text).catch(error => host.toast(error.message));
  });
  const hasFiles = event => [...(event.dataTransfer?.types || [])].includes("Files");
  host.board.addEventListener("dragover", event => {
    if (preview || !host.ready() || !hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    host.board.classList.add("media-drop-target");
  });
  host.board.addEventListener("dragleave", event => { if (!host.board.contains(event.relatedTarget)) host.board.classList.remove("media-drop-target"); });
  host.board.addEventListener("drop", event => {
    host.board.classList.remove("media-drop-target");
    if (preview || !host.ready() || !hasFiles(event)) return;
    event.preventDefault();
    const files = [...event.dataTransfer.files].filter(host.imageCandidate);
    if (!files.length) { host.toast(zh("请拖入 PNG、JPG、WebP 等图片文件。", "Drop image files such as PNG, JPG or WebP.")); return; }
    host.upload(files, { point: host.point(event), source: "drop" }).catch(error => host.toast(error.message));
  });
  // Prevent dropped files from navigating away from the board, including drops on UI chrome.
  for (const type of ["dragover", "drop"]) document.addEventListener(type, event => { if (hasFiles(event)) event.preventDefault(); });
  return { open, close, get active() { return Boolean(preview); } };
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function asPng(blob) {
  if (blob.type === "image/png") return blob;
  const image = new Image();
  image.src = await blobDataUrl(blob);
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d").drawImage(image, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error("PNG conversion failed")), "image/png"));
}
