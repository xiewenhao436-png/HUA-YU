import { randomUUID } from "node:crypto";

const columnsPerRow = 5;
const rowsPerBlock = 20;
const blockCapacity = columnsPerRow * rowsPerBlock;
const imageWidth = 320;
const imageHeight = 240;
const rowGap = 50;
const headingSpace = 48;
const cellWidth = 356;
const blockGap = 72;
const blockPadding = 24;
const blockWidth = (columnsPerRow - 1) * cellWidth + imageWidth;

export function normalizeAutoCoordinate(value, fallback = 0) {
  const limit = Math.floor(Number.MAX_SAFE_INTEGER / 2);
  return Math.round(Number.isFinite(value) ? Math.max(-limit, Math.min(limit, value)) : fallback);
}

function blockAnchor(object) {
  const { slot, rowOffsetY } = object.autoImageGroup;
  return { x: object.x - (slot % columnsPerRow) * cellWidth, y: object.y - rowOffsetY };
}

function blockBounds({ x, y }) {
  return {
    x: x - blockPadding, y: y - headingSpace,
    width: blockWidth + blockPadding * 2,
    height: headingSpace + rowsPerBlock * (imageHeight + rowGap)
  };
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
}

function includeInGroupBounds(groups, key, object, topPadding) {
  const bounds = groups.get(key);
  const left = Math.min(bounds?.x ?? Infinity, object.x - 28);
  const top = Math.min(bounds?.y ?? Infinity, object.y - topPadding);
  const right = Math.max(bounds ? bounds.x + bounds.width : -Infinity, object.x + Math.max(320, object.width) + 28);
  const bottom = Math.max(bounds ? bounds.y + bounds.height : -Infinity, object.y + object.height + 34);
  groups.set(key, { x: left, y: top, width: right - left, height: bottom - top });
}

function occupiedAreas(objects, currentBlock) {
  const areas = [];
  const legacyGroups = new Map();
  for (const object of objects) {
    const group = object.autoImageGroup;
    if (group?.blockId) {
      if (group.blockId !== currentBlock) areas.push(blockBounds(blockAnchor(object)), object);
    } else {
      areas.push(object);
      if (group) includeInGroupBounds(legacyGroups, group.panelId, object, 48);
      else if (object.importGroupId && object.importedFrom) {
        includeInGroupBounds(legacyGroups, object.importGroupId, object, 62);
      }
    }
  }
  return [...areas, ...legacyGroups.values()];
}

export function automaticImagePlacement(object, input, objects) {
  const source = object.importedFrom;
  const batch = object.importGroupId || object.batchId;
  const defaultTitle = input.layoutMode === "draft-grid"
    ? (object.batchId && object.batchId !== "drafts" ? object.batchId : "生成草稿")
    : object.imagegenPrompt || object.prompt ? "生成图片" : "导入图片";
  const title = (source?.threadTitle || source?.boardTitle ||
    (typeof input.autoGroupTitle === "string" && input.autoGroupTitle.trim()) || defaultTitle).slice(0, 500);
  const key = batch ? `batch:${batch}` : `automatic:${title}`;
  const last = objects.findLast(item => item.autoImageGroup?.blockId);
  const previous = last?.autoImageGroup;
  const priorAnchor = last && blockAnchor(last);
  const scale = Math.min(1, imageWidth / object.width, imageHeight / object.height);
  const width = Math.max(1, Math.round(object.width * scale));
  const height = Math.max(1, Math.round(object.height * scale));

  let anchor;
  let blockId;
  let slot = 0;
  let rowOffsetY = 0;
  if (previous && previous.slot + 1 < blockCapacity) {
    const members = objects.filter(item => item.autoImageGroup?.blockId === previous.blockId);
    const aligned = members.every(item => {
      const origin = blockAnchor(item);
      return item.autoImageGroup.slot <= previous.slot &&
        origin.x === priorAnchor.x && origin.y === priorAnchor.y &&
        item.width <= imageWidth && item.height <= imageHeight;
    });
    if (aligned && !occupiedAreas(objects, previous.blockId).some(bounds => overlaps(bounds, blockBounds(priorAnchor)))) {
      anchor = priorAnchor;
      blockId = previous.blockId;
      slot = previous.slot + 1;
      rowOffsetY = previous.rowOffsetY;
      if (slot % columnsPerRow === 0) {
        const row = members.filter(item => item.autoImageGroup.slot >= slot - columnsPerRow);
        rowOffsetY += Math.max(...row.map(item => item.height)) + rowGap;
      }
    }
  }
  if (!anchor) {
    anchor = priorAnchor
      ? { x: priorAnchor.x + blockWidth + blockPadding * 2 + blockGap, y: priorAnchor.y }
      : { x: normalizeAutoCoordinate(input.autoPosition?.x, 120), y: normalizeAutoCoordinate(input.autoPosition?.y, 120) };
    const occupied = occupiedAreas(objects);
    let blockers = occupied.filter(bounds => overlaps(bounds, blockBounds(anchor)));
    while (blockers.length) {
      anchor.x = blockers.reduce((next, bounds) => Math.max(next, bounds.x + bounds.width + blockGap), anchor.x);
      blockers = occupied.filter(bounds => overlaps(bounds, blockBounds(anchor)));
    }
    blockId = randomUUID();
  }

  return {
    ...object, layoutMode: "auto-image-grid",
    x: anchor.x + (slot % columnsPerRow) * cellWidth, y: anchor.y + rowOffsetY, width, height,
    autoImageGroup: { key, panelId: blockId, blockId, rowOffsetY, slot, title }
  };
}
