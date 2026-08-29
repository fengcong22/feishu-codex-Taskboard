import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_VERSION = 1;
const PACKAGE_STATES = new Set(["draft", "enabled", "disabled"]);
const RESERVED_PACKAGE_ALIASES = new Set(["__proto__", "constructor", "prototype"]);

function packageError(code, message, status = 503) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw packageError("PACKAGE_REGISTRY_INVALID", `${name} must be an object`, 503);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw packageError("PACKAGE_REGISTRY_INVALID", `${name} must be a non-empty string`, 503);
  }
  return value.trim();
}

function packageAlias(value, name) {
  const alias = requiredString(value, name);
  if (RESERVED_PACKAGE_ALIASES.has(alias)
    || /^[./\\]/u.test(alias) || /[\s\u0000-\u001f\u007f"'`:$<>|]/u.test(alias)) {
    throw packageError("PACKAGE_REGISTRY_INVALID", `${name} is invalid`, 503);
  }
  return alias;
}

function absolutePath(value, name) {
  const result = requiredString(value, name);
  const windowsAbsolute = /^[A-Za-z]:[\\/]/u.test(result) || /^\\\\/u.test(result);
  if (!path.isAbsolute(result) && !windowsAbsolute) {
    throw packageError("PACKAGE_REGISTRY_INVALID", `${name} must be absolute`, 503);
  }
  return windowsAbsolute && path.sep !== "\\" ? result.replaceAll("/", "\\") : path.normalize(result);
}

function registrySource(value) {
  const root = plainObject(value, "package registry");
  const versioned = root.version !== undefined;
  if (versioned
    && (!Number.isSafeInteger(root.version) || root.version !== REGISTRY_VERSION)) {
    throw packageError("PACKAGE_REGISTRY_UNSUPPORTED", "Package registry version is unsupported", 503);
  }
  return {
    source: root.packages !== undefined ? plainObject(root.packages, "packages") : root,
    versioned,
  };
}

/**
 * Return only enabled, server-trusted package bindings. Draft and disabled
 * records remain owned by Taskboard and cannot make Bridge accept events.
 */
export function normalizePackageRegistry(value) {
  const { source, versioned } = registrySource(value);
  const packages = {};
  const projectIds = new Set();
  const aliases = new Set();
  for (const [key, raw] of Object.entries(source)) {
    const entry = plainObject(raw, `packages.${key}`);
    if (versioned && entry.state === undefined) {
      throw packageError("PACKAGE_REGISTRY_INVALID", `packages.${key}.state is required`, 503);
    }
    const state = entry.state ?? "enabled";
    if (!PACKAGE_STATES.has(state)) {
      throw packageError("PACKAGE_REGISTRY_INVALID", `packages.${key}.state is invalid`, 503);
    }
    if (state !== "enabled") continue;
    const alias = packageAlias(entry.alias ?? key, `packages.${key}.alias`);
    if (aliases.has(alias)) {
      throw packageError("PACKAGE_REGISTRY_INVALID", `duplicate package alias: ${alias}`, 503);
    }
    aliases.add(alias);
    const projectId = requiredString(entry.projectId, `packages.${alias}.projectId`);
    if (projectIds.has(projectId)) {
      throw packageError("PACKAGE_REGISTRY_INVALID", `duplicate package projectId: ${projectId}`, 503);
    }
    projectIds.add(projectId);
    packages[alias] = {
      projectId,
      projectName: requiredString(entry.projectName ?? entry.name ?? alias, `packages.${alias}.projectName`),
      workspacePath: absolutePath(entry.workspacePath, `packages.${alias}.workspacePath`),
      prompt: requiredString(entry.prompt, `packages.${alias}.prompt`),
    };
  }
  return packages;
}

export async function loadPackageRegistry(filename) {
  if (typeof filename !== "string" || filename.trim() === "" || !path.isAbsolute(filename)) {
    throw packageError("PACKAGE_REGISTRY_PATH_INVALID", "Package registry path must be absolute", 503);
  }
  const target = path.normalize(filename);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw packageError("PACKAGE_REGISTRY_NOT_FOUND", "Package registry was not found", 503);
    }
    throw packageError("PACKAGE_REGISTRY_UNAVAILABLE", "Package registry is unavailable", 503);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw packageError("PACKAGE_REGISTRY_UNSAFE", "Package registry must be a single-link regular file", 503);
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw packageError("PACKAGE_REGISTRY_INVALID", "Package registry is malformed", 503);
    }
    throw packageError("PACKAGE_REGISTRY_UNAVAILABLE", "Package registry is unavailable", 503);
  }
  return normalizePackageRegistry(parsed);
}

export const PACKAGE_REGISTRY_VERSION = REGISTRY_VERSION;
