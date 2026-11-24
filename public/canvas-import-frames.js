export function importFrameId(object) {
  return object.autoImageGroup?.panelId || (object.importedFrom && object.importGroupId);
}

export function createImportFrames(host) {
  function groups() {
    const groups = new Map();
    for (const object of host.objects()) {
      const id = importFrameId(object);
      if (!id) continue;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(object);
    }
    return groups;
  }

  function position(frame, objects) {
    const auto = objects[0].autoImageGroup;
    const padding = auto ? 24 : 28;
    const left = Math.min(...objects.map(object => object.x)) - padding;
    const top = Math.min(...objects.map(object => object.y)) - (auto ? 48 : 62);
    const right = Math.max(...objects.map(object => object.x + (auto ? Math.max(320, object.width) : object.width))) + padding;
    const bottom = Math.max(...objects.map(object => object.y + object.height)) + (auto ? 34 : 28);
    Object.assign(frame.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    const from = objects[0].importedFrom;
    const label = frame.querySelector("button");
    const titles = auto ? [...new Set(objects.map(object => object.autoImageGroup.title))] : [];
    const title = auto ? (titles.length === 1 ? titles[0] : "图片素材") : `来源：${from.threadTitle || from.boardTitle || "其他会话"}`;
    label.textContent = `${title} · ${objects.length} 张`;
    label.title = `${titles.length > 1 ? titles.join("、") : title} · 拖动标题可移动整组图片`;

    if (!auto) return;
    const captions = frame.querySelectorAll(".canvas-import-caption");
    for (const [index, object] of objects.entries()) {
      const caption = captions[index];
      const name = (object.name || "图片").replace(/\.(?:png|jpe?g|webp|gif|avif)$/i, "");
      const description = (object.prompt || object.imagegenPrompt || "").trim().split(/[\r\n。！？]/, 1)[0].trim();
      const shortDescription = [...description].slice(0, 44).join("");
      const sourceTitle = titles.length > 1 ? object.autoImageGroup.title : "";
      const text = sourceTitle || shortDescription;
      const detail = text && text !== name ? ` · ${text}` : "";
      caption.textContent = `${name}${detail}${detail && !sourceTitle && shortDescription !== description ? "…" : ""}`;
      caption.title = caption.textContent;
      Object.assign(caption.style, {
        left: `${object.x - left}px`,
        top: `${object.y + object.height + 4 - top}px`,
        width: "320px"
      });
    }
  }

  return {
    render() {
      for (const [id, objects] of groups()) {
        const frame = document.createElement("section");
        frame.className = "canvas-import-frame";
        frame.dataset.importGroup = id;
        const label = document.createElement("button");
        label.type = "button";
        label.className = "canvas-import-frame-label";
        label.addEventListener("pointerdown", event => {
          if (event.button === 0) host.drag(event, id, objects.map(object => object.id));
        });
        frame.append(label);
        if (objects[0].autoImageGroup) {
          frame.classList.add("canvas-auto-image-frame");
          for (const object of objects) {
            const caption = document.createElement("div");
            caption.className = "canvas-import-caption";
            caption.dataset.objectId = object.id;
            frame.append(caption);
          }
        }
        position(frame, objects);
        host.layer.append(frame);
      }
    },
    update() {
      const frames = new Map([...host.layer.querySelectorAll(".canvas-import-frame")].map(frame => [frame.dataset.importGroup, frame]));
      for (const [id, objects] of groups()) {
        const frame = frames.get(id);
        if (frame) position(frame, objects);
      }
    }
  };
}
