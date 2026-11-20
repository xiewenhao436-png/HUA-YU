import path from "node:path";
import crypto from "node:crypto";

export const standaloneProjectKey = "standalone-images";
export const standaloneProjectName = "零散生图";

export function projectKeyForPath(value) {
  const absolute = path.resolve(value);
  if (process.platform !== "win32") return absolute;
  const physical = absolute.replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "");
  return physical.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

export function meaningfulTitle(value) {
  const title = typeof value === "string" ? value.trim().slice(0, 200) : "";
  return /^(?:untitled(?: canvas)?|new chat(?:[ -]\d+)?|new canvas|default|board|work|canvas|未命名(?:画布|会话)?|新(?:建)?(?:会话|对话|画布)|素材画布)(?:\s*·\s*[a-f0-9]{6})?$/i.test(title) ? "" : title;
}

export function resolveBoardIdentity({ projectDir, canvasId, displayTitle, title, threadTitle, projectOverride, objects = [] }, projectCatalog = []) {
  const fullPath = path.resolve(projectDir);
  const fullKey = projectKeyForPath(fullPath);
  const ancestors = projectCatalog.filter(entry => {
    if (!entry?.root || !path.isAbsolute(entry.root) || !meaningfulTitle(entry.name)) return false;
    const rootKey = projectKeyForPath(entry.root);
    return fullKey === rootKey || fullKey.startsWith(rootKey.endsWith("/") ? rootKey : `${rootKey}/`);
  }).sort((a, b) => b.root.length - a.root.length);
  const registered = ancestors[0];
  const segments = fullPath.split(path.sep);
  const taskFolder = segments.findIndex(segment => segment.toLowerCase() === "_codex");
  const inferredRoot = taskFolder > 0 ? path.resolve(segments.slice(0, taskFolder).join(path.sep) + path.sep) : fullPath;
  const inferredName = path.basename(inferredRoot);
  const unassigned = /(?:^|[\\/])(?:Codex|ChatGPT)[\\/]\d{4}-\d{2}-\d{2}(?:[\\/]|$)/i.test(inferredRoot)
    || /^(?:desktop|downloads|documents|桌面|下载|new-chat(?:-\d+)?)$/i.test(inferredName)
    || /^\d{4}-\d{2}(?:-\d{2})?$/.test(inferredName)
    || !meaningfulTitle(inferredName);
  const root = registered ? path.resolve(registered.root) : inferredRoot;
  const defaultName = registered ? meaningfulTitle(registered.name) : unassigned ? standaloneProjectName : inferredName;
  const projectName = meaningfulTitle(projectOverride) || defaultName;
  const matchingProject = projectCatalog.find(entry => entry?.name === projectName && path.isAbsolute(entry.root || ""));
  const projectKey = projectName === standaloneProjectName ? standaloneProjectKey
    : projectName === defaultName ? projectKeyForPath(root) : matchingProject ? projectKeyForPath(matchingProject.root) : `project-name:${projectName}`;
  const imageTitle = objects.find(object => {
    const name = object?.src && (object.type || "image") === "image" && typeof object.name === "string"
      ? meaningfulTitle(path.parse(object.name).name) : "";
    return name && !/^(?:generated[-_ ]?image|image|img)(?:[-_ ].*)?$|^exec-[a-f0-9-]{12,}$|^[a-f0-9_-]{12,}$/i.test(name);
  })?.name;
  const suffix = crypto.createHash("sha256").update(JSON.stringify([fullPath, canvasId || null])).digest("hex").slice(0, 6);
  return {
    title: meaningfulTitle(displayTitle) || meaningfulTitle(title) || meaningfulTitle(threadTitle)
      || (imageTitle && meaningfulTitle(path.parse(imageTitle).name)) || `素材画布 · ${suffix}`,
    projectName,
    projectKey
  };
}
