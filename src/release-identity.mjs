// Release identity is separate from the compatible on-disk canvas schema.
export const RELEASE_PACKAGE = "huayu";
export const RELEASE_REPOSITORY_SLUG = "xiewenhao436-png/HUA-YU";
export const RELEASE_REPOSITORY = `https://github.com/${RELEASE_REPOSITORY_SLUG}`;

export function isReleaseRepository(value) {
  const text = String(value || "").trim().replace(/^git\+/, "");
  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(text);
  let slug = ssh?.[1];
  if (!slug) {
    try {
      const url = new URL(text);
      if (url.hostname.toLowerCase() !== "github.com") return false;
      slug = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    } catch {
      return false;
    }
  }
  return slug.toLowerCase() === RELEASE_REPOSITORY_SLUG.toLowerCase();
}
