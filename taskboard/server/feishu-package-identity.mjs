import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { PackageConfigError } from "./feishu-package-config.mjs";

const RESERVED_ALIASES = new Set(["__proto__", "constructor", "prototype"]);

function invalidManifest() {
  return new PackageConfigError(
    "PACKAGE_MANIFEST_INVALID",
    "Auto-Cut package manifests are invalid",
    undefined,
    409,
  );
}

function normalizeVersion(value) {
  if (typeof value !== "string") throw invalidManifest();
  const match = value.trim().match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
  if (!match) throw invalidManifest();
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function requireManifestName(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw invalidManifest();
  return value.trim();
}

function defaultPrompt(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw invalidManifest();
  }
  return value.map((entry) => entry.trim()).join("\n") || null;
}

async function readManifest(filename) {
  let source;
  try {
    const entry = await lstat(filename);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("unavailable");
    source = await readFile(filename, "utf8");
  } catch (error) {
    if (error instanceof PackageConfigError) throw error;
    throw new PackageConfigError(
      "PACKAGE_MANIFEST_UNAVAILABLE",
      "Auto-Cut package manifests are unavailable",
      undefined,
      409,
    );
  }
  try {
    const manifest = JSON.parse(source);
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("invalid");
    return manifest;
  } catch {
    throw invalidManifest();
  }
}

function packageIdBase(pluginName) {
  const normalized = pluginName
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const base = normalized || "auto-cut";
  return RESERVED_ALIASES.has(base) ? `${base}-package` : base;
}

function existingIdentitySets(existingPackages) {
  const records = Array.isArray(existingPackages)
    ? existingPackages
    : existingPackages && typeof existingPackages === "object" ? Object.values(existingPackages) : [];
  const aliases = new Set();
  const projectIds = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    if (typeof record.alias === "string") aliases.add(record.alias);
    if (typeof record.projectId === "string") projectIds.add(record.projectId);
  }
  return { aliases, projectIds };
}

function collisionSafeIdentity(pluginName, existingPackages) {
  const base = packageIdBase(pluginName);
  const { aliases, projectIds } = existingIdentitySets(existingPackages);
  for (let sequence = 1; sequence <= 10_000; sequence += 1) {
    const value = sequence === 1 ? base : `${base}-${sequence}`;
    if (!aliases.has(value) && !projectIds.has(value)) {
      return { alias: value, projectId: value };
    }
  }
  throw new PackageConfigError("PACKAGE_IDENTITY_UNAVAILABLE", "No available Auto-Cut package identity could be derived", undefined, 409);
}

function displayName(pluginName, pluginVersion) {
  return `${pluginName.slice(0, 1).toUpperCase()}${pluginName.slice(1)}${pluginVersion}`;
}

function zipOutputDeclaration(packageInterface, workspacePath) {
  const declaration = packageInterface?.zipOutput;
  if (declaration === undefined) return null;
  if (declaration === null || typeof declaration !== "object" || Array.isArray(declaration)) {
    throw invalidManifest();
  }
  if (typeof declaration.relativeDirectory !== "string") throw invalidManifest();
  const relativeDirectory = declaration.relativeDirectory;
  if (!relativeDirectory || relativeDirectory.includes("\0")
    || path.posix.isAbsolute(relativeDirectory) || path.win32.isAbsolute(relativeDirectory)
    || /^[A-Za-z]:/u.test(relativeDirectory)) {
    throw invalidManifest();
  }
  const segments = relativeDirectory.split(/[\\/]/u);
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || /[<>:"|?*\u0000-\u001f]/u.test(segment) || /[. ]$/u.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment))) {
    throw invalidManifest();
  }
  return {
    relativeDirectory,
    directory: path.resolve(workspacePath, ...segments),
  };
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function unsafeZipOutput() {
  return new PackageConfigError(
    "PACKAGE_ZIP_OUTPUT_UNSAFE",
    "Declared ZIP output directory escapes the package workspace",
    undefined,
    409,
  );
}

async function prepareDirectory({ workspacePath, zipOutput }) {
  let workspaceRoot;
  try {
    workspaceRoot = await realpath(workspacePath);
    if (!(await stat(workspaceRoot)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new PackageConfigError("PACKAGE_WORKSPACE_UNAVAILABLE", "workspacePath is unavailable", undefined, 409);
  }

  const segments = zipOutput.relativeDirectory.split(/[\\/]/u);
  let current = workspaceRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const existing = await lstat(current);
      if (!existing.isDirectory()) throw unsafeZipOutput();
      const resolved = await realpath(current);
      if (!pathInside(workspaceRoot, resolved)) throw unsafeZipOutput();
    } catch (error) {
      if (error instanceof PackageConfigError) throw error;
      if (error?.code !== "ENOENT") {
        throw new PackageConfigError("PACKAGE_ZIP_OUTPUT_UNAVAILABLE", "ZIP output directory is unavailable", undefined, 409);
      }
      try {
        await mkdir(current);
        const resolved = await realpath(current);
        if (!pathInside(workspaceRoot, resolved)) throw unsafeZipOutput();
      } catch (mkdirError) {
        if (mkdirError instanceof PackageConfigError) throw mkdirError;
        throw new PackageConfigError("PACKAGE_ZIP_OUTPUT_UNAVAILABLE", "ZIP output directory could not be created", undefined, 409);
      }
    }
  }
  return zipOutput;
}

/**
 * Reads the two fixed package manifests without executing workspace code.
 * The resulting fields are unsaved defaults for a new registry record.
 */
export async function inspectAutoCutPackageWorkspace({ workspacePath, existingPackages = [] } = {}) {
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath.trim())) {
    throw new PackageConfigError("PACKAGE_WORKSPACE_UNAVAILABLE", "workspacePath is unavailable", undefined, 409);
  }
  const normalizedWorkspace = path.normalize(workspacePath.trim());
  try {
    if (!(await stat(normalizedWorkspace)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new PackageConfigError("PACKAGE_WORKSPACE_UNAVAILABLE", "workspacePath is unavailable", undefined, 409);
  }

  const [plugin, packageManifest] = await Promise.all([
    readManifest(path.join(normalizedWorkspace, ".codex-plugin", "plugin.json")),
    readManifest(path.join(normalizedWorkspace, "PACKAGE-MANIFEST.json")),
  ]);
  const pluginName = requireManifestName(plugin.name);
  const pluginVersion = normalizeVersion(plugin.version);
  const runtimeVersion = normalizeVersion(packageManifest.embedded_runtime?.version);
  const identity = collisionSafeIdentity(pluginName, existingPackages);
  const zipOutput = zipOutputDeclaration(packageManifest.interface, normalizedWorkspace);

  return {
    displayName: displayName(pluginName, pluginVersion),
    pluginVersion,
    runtimeVersion,
    defaultPrompt: defaultPrompt(plugin.interface?.defaultPrompt),
    zipOutput,
    ...identity,
  };
}

export async function prepareAutoCutPackageOutputDirectory({ workspacePath } = {}) {
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath.trim())) {
    throw new PackageConfigError("PACKAGE_WORKSPACE_UNAVAILABLE", "workspacePath is unavailable", undefined, 409);
  }
  const normalizedWorkspace = path.normalize(workspacePath.trim());
  const inspection = await inspectAutoCutPackageWorkspace({ workspacePath: normalizedWorkspace, existingPackages: [] });
  if (!inspection.zipOutput) {
    throw new PackageConfigError(
      "PACKAGE_ZIP_OUTPUT_UNDECLARED",
      "Auto-Cut package does not declare a ZIP output directory",
      undefined,
      409,
    );
  }
  return { zipOutput: await prepareDirectory({ workspacePath: normalizedWorkspace, zipOutput: inspection.zipOutput }) };
}
