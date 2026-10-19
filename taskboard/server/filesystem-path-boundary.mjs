import path from "node:path";

export function isStrictDescendantPath(parent, candidate, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalize = (value) => {
    const absolute = pathApi.resolve(value);
    return platform === "win32" ? pathApi.toNamespacedPath(absolute) : absolute;
  };
  const relative = pathApi.relative(normalize(parent), normalize(candidate));
  return relative !== "" && relative !== ".."
    && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
}
