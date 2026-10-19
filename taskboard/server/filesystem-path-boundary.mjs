import path from "node:path";

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
