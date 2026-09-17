import { win32 as path } from "node:path";

const MAX_WINDOWS_PATH_LENGTH = 259;
const INVALID_WINDOWS_NAME = /[<>:"/\\|?*\u0000-\u001f\u007f]/u;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export const DELIVERY_STAGE_DIRECTORIES = Object.freeze({
  initial: "01初稿",
  first_review: "02初审",
  final_review: "03终审",
});

export const FINAL_DIRECTORY_NAME = "00成片";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function text(value, code, name) {
  if (typeof value !== "string" || value === "" || value.includes("\0")) {
    throw fail(code, `${name} is invalid`);
  }
  return value;
}

function hasUnsafePathSegment(value) {
  return value === "" || value === "." || value === ".." || value.endsWith(".") || value.endsWith(" ");
}

function splitUncRoot(value) {
  const parts = value.slice(2).split("\\");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { server: parts[0], share: parts[1], rest: parts.slice(2) };
}

function normalizeAbsoluteRoot(rootPath) {
  const raw = text(rootPath, "ROOT_PATH_INVALID", "rootPath");
  if (raw !== raw.trim()) throw fail("ROOT_PATH_INVALID", "rootPath must not have leading or trailing whitespace");

  const normalized = raw.replaceAll("/", "\\");
  if (normalized.startsWith("\\\\?\\")) {
    throw fail("ROOT_PATH_INVALID", "rootPath cannot use an extended Windows path prefix");
  }

  let root;
  let segments;
  if (normalized.startsWith("\\\\")) {
    const unc = splitUncRoot(normalized);
    if (!unc || unc.server.includes(":") || unc.server.includes("/") || unc.share.includes(":")) {
      throw fail("ROOT_PATH_INVALID", "rootPath must be a complete UNC share path");
    }
    root = `\\\\${unc.server}\\${unc.share}`;
    segments = unc.rest;
  } else {
    if (!/^[A-Za-z]:\\/u.test(normalized)) {
      throw fail("ROOT_PATH_INVALID", "rootPath must be an absolute Windows path");
    }
    root = normalized.slice(0, 3);
    const tail = normalized.slice(3);
    segments = tail === "" ? [] : tail.split("\\");
  }

  if (segments.at(-1) === "") segments.pop();

  if (segments.some((segment) => hasUnsafePathSegment(segment) || INVALID_WINDOWS_NAME.test(segment))) {
    throw fail("ROOT_PATH_INVALID", "rootPath contains an unsafe path segment");
  }

  const result = segments.length === 0 ? root : path.join(root, ...segments);
  if (!path.isAbsolute(result) || path.relative(result, result) !== "") {
    throw fail("ROOT_PATH_INVALID", "rootPath is invalid");
  }
  return result;
}

function normalizeUncRoot(value, code = "NETWORK_ROOT_UNRESOLVED") {
  try {
    const root = normalizeAbsoluteRoot(value);
    if (!root.startsWith("\\\\")) throw new Error("not UNC");
    return root;
  } catch {
    throw fail(code, "network drive mapping is not a complete UNC path");
  }
}

function displayFromUncPath(uncPath) {
  const unc = splitUncRoot(uncPath);
  if (!unc) throw fail("ROOT_PATH_INVALID", "UNC path is invalid");
  return [unc.share, ...unc.rest].join("\\");
}

function ensureInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw fail("COURSE_PATH_INVALID", "course path must be a child of rootPath");
  }
}

function withCoursePath(root, courseName) {
  const coursePath = path.join(root, courseName);
  ensureInsideRoot(root, coursePath);
  if (coursePath.length > MAX_WINDOWS_PATH_LENGTH) {
    throw fail("COURSE_PATH_TOO_LONG", "course path exceeds the supported Windows path length");
  }
  return coursePath;
}

function dependency(value, name) {
  if (typeof value !== "function") {
    throw fail("COURSE_PATH_DEPENDENCY_INVALID", `${name} must be a function`);
  }
  return value;
}

/**
 * Validate one course folder segment before it is combined with a trusted
 * configured root. It deliberately rejects Windows aliases and separators.
 */
export function normalizeCourseName(value) {
  const name = text(value, "COURSE_NAME_INVALID", "courseName");
  if (
    name.trim() !== name
    || name.length > 255
    || name === "."
    || name === ".."
    || name.endsWith(".")
    || name.endsWith(" ")
    || INVALID_WINDOWS_NAME.test(name)
    || RESERVED_WINDOWS_NAME.test(name)
  ) {
    throw fail("COURSE_NAME_INVALID", "courseName is not a safe Windows directory name");
  }
  return name;
}

/**
 * A case-insensitive Windows identity key suitable for collision checks after
 * a root has already been resolved to a stable local or UNC location.
 */
export function canonicalCoursePathKey(absolutePath) {
  const normalized = normalizeAbsoluteRoot(absolutePath);
  return normalized.toLocaleLowerCase("en-US");
}

/**
 * Resolve a configured Windows root without touching the filesystem. Network
 * mappings keep their drive-letter path for local operations and use the UNC
 * target only for display and canonical identity.
 */
export async function previewCoursePath({ rootPath, courseName }, {
  classifyDrive,
  resolveMappedDrive,
} = {}) {
  const actualRoot = normalizeAbsoluteRoot(rootPath);
  const safeCourseName = normalizeCourseName(courseName);
  const coursePath = withCoursePath(actualRoot, safeCourseName);

  if (actualRoot.startsWith("\\\\")) {
    return {
      actualRoot,
      coursePath,
      displayPath: displayFromUncPath(coursePath),
      pathKind: "unc",
      canonicalLocationKey: canonicalCoursePathKey(coursePath),
    };
  }

  const kind = await dependency(classifyDrive, "classifyDrive")(actualRoot);
  if (kind === "local") {
    return {
      actualRoot,
      coursePath,
      displayPath: coursePath.slice(3),
      pathKind: "local",
      canonicalLocationKey: canonicalCoursePathKey(coursePath),
    };
  }
  if (kind !== "network") {
    throw fail("ROOT_PATH_KIND_UNKNOWN", "rootPath drive type is not known");
  }

  const mappedRoot = normalizeUncRoot(await dependency(resolveMappedDrive, "resolveMappedDrive")(actualRoot));
  const mappedCoursePath = path.join(mappedRoot, path.relative(path.parse(actualRoot).root, coursePath));
  ensureInsideRoot(mappedRoot, mappedCoursePath);
  if (mappedCoursePath.length > MAX_WINDOWS_PATH_LENGTH) {
    throw fail("COURSE_PATH_TOO_LONG", "course path exceeds the supported Windows path length");
  }
  return {
    actualRoot,
    coursePath,
    displayPath: displayFromUncPath(mappedCoursePath),
    pathKind: "network",
    canonicalLocationKey: canonicalCoursePathKey(mappedCoursePath),
  };
}

function coursePathFromBinding(binding) {
  if (!binding || typeof binding !== "object") {
    throw fail("COURSE_PATH_INVALID", "binding must contain coursePath");
  }
  try {
    return normalizeAbsoluteRoot(binding.coursePath);
  } catch {
    throw fail("COURSE_PATH_INVALID", "binding.coursePath is invalid");
  }
}

function fixedChildPath(binding, directoryName) {
  const coursePath = coursePathFromBinding(binding);
  const destination = path.join(coursePath, directoryName);
  ensureInsideRoot(coursePath, destination);
  if (destination.length > MAX_WINDOWS_PATH_LENGTH) {
    throw fail("COURSE_PATH_TOO_LONG", "delivery directory exceeds the supported Windows path length");
  }
  return destination;
}

export function deriveStageDestination(binding, stageId) {
  const directoryName = DELIVERY_STAGE_DIRECTORIES[stageId];
  if (!directoryName) throw fail("STAGE_ID_INVALID", "stageId is not a delivery stage");
  return fixedChildPath(binding, directoryName);
}

export function deriveFinalDirectoryDestination(binding) {
  return fixedChildPath(binding, FINAL_DIRECTORY_NAME);
}

export function deriveCourseDestinations(binding) {
  return {
    final: deriveFinalDirectoryDestination(binding),
    ...Object.fromEntries(Object.keys(DELIVERY_STAGE_DIRECTORIES).map((stageId) => [
      stageId,
      deriveStageDestination(binding, stageId),
    ])),
  };
}
