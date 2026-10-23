export function createImportFrames(host) {
  function groups() {
    const groups = new Map();
    for (const object of host.objects()) if (object.importGroupId && object.importedFrom) {
      if (!groups.has(object.importGroupId)) groups.set(object.importGroupId, []);
      groups.get(object.importGroupId).push(object);
    }
    return groups;
  }
  function position(frame, objects) {
    const left = Math.min(...objects.map(o => o.x)) - 28, top = Math.min(...objects.map(o => o.y)) - 62;
    const right = Math.max(...objects.map(o => o.x + o.width)) + 28, bottom = Math.max(...objects.map(o => o.y + o.height)) + 28;
    Object.assign(frame.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    const from = objects[0].importedFrom;
    frame.querySelector("button").textContent = `来源：${from.threadTitle || from.boardTitle || "其他会话"} · ${objects.length} 张`;
  }
  return {
    render() {
      for (const [id, objects] of groups()) {
        const frame = document.createElement("section"); frame.className = "canvas-import-frame"; frame.dataset.importGroup = id;
        const label = document.createElement("button"); label.type = "button"; label.className = "canvas-import-frame-label";
        label.title = "拖动来源名称可移动整组图片";
        label.addEventListener("pointerdown", event => { if (event.button === 0) host.drag(event, id, objects.map(o => o.id)); });
        frame.append(label); position(frame, objects); host.layer.append(frame);
      }
    },
    update() {
      for (const [id, objects] of groups()) {
        const frame = [...host.layer.querySelectorAll(".canvas-import-frame")].find(f => f.dataset.importGroup === id);
        if (frame) position(frame, objects);
      }
    }
  };
}
