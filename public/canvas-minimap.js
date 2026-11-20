const buttonLabels = {
  en: { map: "Canvas overview", navigate: "Click or drag to move. Scroll to zoom. Double-click for a closer view.", out: "Zoom out", fit: "Fit all content", in: "Zoom in" },
  zh: { map: "画布小地图", navigate: "点击或拖动定位，滚轮缩放，双击放大查看", out: "缩小", fit: "查看全部", in: "放大" }
};

export function installCanvasMinimap({ panel, board, objects, camera, navigate, fit }) {
  const map = panel.querySelector("canvas");
  const context = map.getContext("2d");
  const zoomLabel = panel.querySelector("output");
  let projection;
  let drag;
  let frame;

  function update() {
    if (frame === undefined) frame = requestAnimationFrame(draw);
  }

  function draw() {
    frame = undefined;
    const items = objects();
    panel.hidden = items.length === 0;
    if (panel.hidden) return;
    const { x, y, zoom } = camera();
    const visible = { x: -x / zoom, y: -y / zoom, width: board.clientWidth / zoom, height: board.clientHeight / zoom };
    const width = map.clientWidth;
    const height = map.clientHeight;
    if (!width || !height) return;
    const pixelRatio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * pixelRatio);
    const pixelHeight = Math.round(height * pixelRatio);
    if (map.width !== pixelWidth || map.height !== pixelHeight) {
      map.width = pixelWidth;
      map.height = pixelHeight;
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    projection = drag?.projection || project(items, visible, width, height);
    const { scale, left, top } = projection;
    for (const item of items) {
      context.fillStyle = item.type === "text" || item.type === "annotation" ? "#adb5bb" : "#859cac";
      context.fillRect(left + item.x * scale, top + item.y * scale, Math.max(1, item.width * scale), Math.max(1, item.height * scale));
    }
    const rect = [left + visible.x * scale, top + visible.y * scale, Math.max(3, visible.width * scale), Math.max(3, visible.height * scale)];
    context.fillStyle = "#b9d7fc45";
    context.strokeStyle = "#447db5";
    context.fillRect(...rect);
    context.strokeRect(...rect);
    zoomLabel.value = zoom < 0.1 ? `${+(zoom * 100).toFixed(2)}%` : `${Math.round(zoom * 100)}%`;
  }

  function worldPoint(event, { left, top, scale }) {
    const bounds = map.getBoundingClientRect();
    return { x: (event.clientX - bounds.left - left) / scale, y: (event.clientY - bounds.top - top) / scale };
  }

  function viewCenter() {
    const { x, y, zoom } = camera();
    return { x: (board.clientWidth / 2 - x) / zoom, y: (board.clientHeight / 2 - y) / zoom };
  }

  map.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !projection || drag) return;
    map.focus({ preventScroll: true });
    map.setPointerCapture(event.pointerId);
    const point = worldPoint(event, projection);
    const center = viewCenter();
    const { zoom } = camera();
    const inside = Math.abs(point.x - center.x) <= board.clientWidth / (2 * zoom)
      && Math.abs(point.y - center.y) <= board.clientHeight / (2 * zoom);
    drag = { id: event.pointerId, projection, offset: inside ? { x: center.x - point.x, y: center.y - point.y } : { x: 0, y: 0 }, moved: false };
    if (!inside) navigate(point, zoom);
  });

  map.addEventListener("pointermove", event => {
    if (event.pointerId !== drag?.id) return;
    const point = worldPoint(event, drag.projection);
    drag.moved = true;
    navigate({ x: point.x + drag.offset.x, y: point.y + drag.offset.y }, camera().zoom);
  });

  map.addEventListener("pointerup", event => {
    if (event.pointerId === drag?.id && !drag.moved) navigate(worldPoint(event, drag.projection), camera().zoom);
  });
  map.addEventListener("lostpointercapture", () => { drag = undefined; update(); });
  map.addEventListener("dblclick", event => {
    if (projection) navigate(worldPoint(event, projection), Math.max(0.72, camera().zoom * 1.25));
  });

  map.addEventListener("wheel", event => {
    if (!projection || !event.deltaY) return;
    event.preventDefault();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? map.clientHeight : 1;
    const delta = Math.max(-180, Math.min(180, event.deltaY * units));
    navigate(worldPoint(event, projection), camera().zoom * Math.exp(-delta * 0.0035));
  }, { passive: false });

  function zoomBy(factor) {
    navigate(viewCenter(), camera().zoom * factor);
  }

  map.addEventListener("keydown", event => {
    if (event.key === "+" || event.key === "=") zoomBy(1.25);
    else if (event.key === "-") zoomBy(0.8);
    else if (event.key === "Home") fit();
    else {
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!direction) return;
      const center = viewCenter();
      const { zoom } = camera();
      navigate({ x: center.x + direction[0] * board.clientWidth / (4 * zoom), y: center.y + direction[1] * board.clientHeight / (4 * zoom) }, zoom);
    }
    event.preventDefault();
    event.stopPropagation();
  });

  panel.querySelector("[data-minimap='out']").onclick = () => zoomBy(0.8);
  panel.querySelector("[data-minimap='fit']").onclick = fit;
  panel.querySelector("[data-minimap='in']").onclick = () => zoomBy(1.25);
  new ResizeObserver(update).observe(board);

  return {
    update,
    translate(language) {
      const labels = buttonLabels[language] || buttonLabels.en;
      panel.setAttribute("aria-label", labels.map);
      map.title = labels.navigate;
      map.setAttribute("aria-label", `${labels.map} · ${labels.navigate}`);
      for (const button of panel.querySelectorAll("[data-minimap]")) {
        button.title = labels[button.dataset.minimap];
        button.setAttribute("aria-label", button.title);
      }
    }
  };
}

function project(items, visible, width, height) {
  let left = visible.x;
  let top = visible.y;
  let right = visible.x + visible.width;
  let bottom = visible.y + visible.height;
  for (const item of items) {
    left = Math.min(left, item.x);
    top = Math.min(top, item.y);
    right = Math.max(right, item.x + item.width);
    bottom = Math.max(bottom, item.y + item.height);
  }
  const scale = Math.min(Math.max(1, width - 12) / (right - left), Math.max(1, height - 12) / (bottom - top));
  return {
    scale,
    left: (width - (right - left) * scale) / 2 - left * scale,
    top: (height - (bottom - top) * scale) / 2 - top * scale
  };
}
