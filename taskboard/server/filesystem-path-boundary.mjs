import path from "node:path";
import { statSync } from "node:fs";

function normalizedPath(value, pathApi, platform) {
  const absolute = pathApi.resolve(value);
  return platform === "win32" ? pathApi.toNamespacedPath(absolute) : absolute;
}

export function isSameFilesystemPath(left, right, platform = process.platform) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalizedLeft = normalizedPath(left, pathApi, platform);
  const normalizedRight = normalizedPath(right, pathApi, platform);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function isStrictDescendantPath(parent, candidate, platform = process.platform) {
  if (typeof parent !== "string" || typeof candidate !== "string") return false;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const relative = pathApi.relative(normalizedPath(parent, pathApi, platform), normalizedPath(candidate, pathApi, platform));
  return relative !== "" && relative !== ".."
    && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
}

export function isStrictFilesystemDescendantPath(parent, candidate, {
  platform = process.platform,
  stat = statSync,
} = {}) {
  if (isStrictDescendantPath(parent, candidate, platform)) return true;
  if (platform !== "win32") return false;

  const pathApi = path.win32;
  try {
    const parentInfo = stat(parent);
    if (parentInfo.ino === 0 || parentInfo.ino === 0n) return false;

    let current = pathApi.resolve(candidate);
    for (let depth = 0; depth < 256; depth += 1) {
      const currentInfo = stat(current);
      if (currentInfo.dev === parentInfo.dev && currentInfo.ino === parentInfo.ino) return depth > 0;
      const next = pathApi.dirname(current);
      if (next === current) break;
      current = next;
    }
  } catch {
    return false;
  }
  return false;
}
