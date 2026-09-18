import { stat } from "node:fs/promises";
import path from "node:path";

import { ApiError } from "./database.mjs";
import { PackageConfigError, validateCustomZipOutputDirectory } from "./feishu-package-config.mjs";
import { inspectAutoCutPackageWorkspace, prepareAutoCutPackageOutputDirectory } from "./feishu-package-identity.mjs";

const PACKAGE_ROOT = "/api/local/autocut/packages";
const PACKAGE_FIELDS = new Set([
  "alias", "name", "projectName", "projectId", "workspacePath", "model", "reasoningEffort",
  "prompt", "zipSourceDirectory", "zipOutputMode", "maxConcurrent", "resourceGroups",
]);
const PACKAGE_MUTATION_FIELDS = new Set([
  ...PACKAGE_FIELDS, "revision", "expectedRevision",
]);

function plainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", `${name} must be an object`);
  }
  return value;
}

function assertAllowed(body, allowed, name) {
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) throw new ApiError(400, "UNKNOWN_FIELD", `${name}.${unknown} is not supported`);
}

function revision(body, { required = true } = {}) {
  const value = body?.expectedRevision ?? body?.revision;
  if (value === undefined && !required) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, "INVALID_FIELD", "revision must be a positive integer");
  }
  return value;
}

function decodeAlias(value) {
  try {
    const alias = decodeURIComponent(value);
    if (!alias || alias.length > 256 || alias.includes("\0")) throw new Error("invalid");
    return alias;
  } catch {
    throw new ApiError(400, "INVALID_PATH", "Package alias contains invalid encoding");
  }
}

function toApiError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof PackageConfigError) {
    return new ApiError(error.status ?? 409, error.code, error.message, error.details);
  }
  return new ApiError(500, "PACKAGE_REGISTRY_FAILED", "Unable to update the Auto-Cut package registry");
}

async function discoverCatalog(getModelCatalog, workspacePath) {
  if (typeof getModelCatalog !== "function") {
    throw new PackageConfigError("PACKAGE_MODEL_CATALOG_UNAVAILABLE", "Codex model catalog is unavailable", undefined, 503);
  }
  try {
    return await getModelCatalog(workspacePath);
  } catch {
    throw new PackageConfigError("PACKAGE_MODEL_UNAVAILABLE", "Codex model catalog could not be loaded", undefined, 503);
  }
}

async function manifestIdentity(record) {
  if (!record || typeof record.workspacePath !== "string" || !record.workspacePath.trim()) return null;
  try {
    const inspection = await inspectAutoCutPackageWorkspace({
      workspacePath: record.workspacePath,
      existingPackages: [],
    });
    return { ...inspection, alias: record.alias, projectId: record.projectId };
  } catch {
    return null;
  }
}

function packagePatch(body, { allowRevision = false } = {}) {
  plainObject(body, "package");
  assertAllowed(body, allowRevision ? PACKAGE_MUTATION_FIELDS : PACKAGE_FIELDS, "package");
  const patch = { ...body };
  if (patch.name === undefined && patch.projectName !== undefined) patch.name = patch.projectName;
  delete patch.projectName;
  delete patch.state;
  delete patch.updatedAt;
  delete patch.expectedRevision;
  delete patch.revision;
  return patch;
}

export function createFeishuPackageApi({ store, getModelCatalog = null } = {}) {
  if (!store) throw new TypeError("createFeishuPackageApi requires a package store");
  return {
    async handle({ method, pathname, body }) {
      try {
        if (pathname === PACKAGE_ROOT) {
          if (method === "GET") {
            const packages = await store.list();
            const enriched = await Promise.all(packages.map(async (record) => {
              const [references, identity] = await Promise.all([
                store.references(record.alias),
                manifestIdentity(record),
              ]);
              return { ...record, identity, references, referenceCount: references.length };
            }));
            return { status: 200, body: { packages: enriched } };
          }
          if (method === "POST") {
            const input = packagePatch(body);
            const record = await store.saveDraft(input);
            return { status: 201, body: { package: record } };
          }
          throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        }

        if (pathname === `${PACKAGE_ROOT}/catalog`) {
          if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
          const input = plainObject(body, "catalog");
          assertAllowed(input, new Set(["workspacePath"]), "catalog");
          if (typeof input.workspacePath !== "string" || !path.isAbsolute(input.workspacePath.trim())) {
            throw new ApiError(400, "INVALID_FIELD", "workspacePath must be absolute");
          }
          const workspacePath = path.normalize(input.workspacePath.trim());
          try {
            if (!(await stat(workspacePath)).isDirectory()) throw new Error("not a directory");
          } catch {
            throw new ApiError(409, "PACKAGE_WORKSPACE_UNAVAILABLE", "workspacePath is unavailable");
          }
          if (typeof getModelCatalog !== "function") {
            throw new ApiError(503, "PACKAGE_MODEL_CATALOG_UNAVAILABLE", "Codex model catalog is unavailable");
          }
          let catalog;
          try { catalog = await getModelCatalog(workspacePath); } catch {
            throw new ApiError(503, "PACKAGE_MODEL_CATALOG_UNAVAILABLE", "Codex model catalog is unavailable");
          }
          return { status: 200, body: catalog && typeof catalog === "object" ? catalog : { catalog } };
        }

        if (pathname === `${PACKAGE_ROOT}/inspect-workspace`) {
          if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
          const input = plainObject(body, "package workspace");
          assertAllowed(input, new Set(["workspacePath"]), "package workspace");
          if (typeof input.workspacePath !== "string" || !path.isAbsolute(input.workspacePath.trim())) {
            throw new ApiError(400, "INVALID_FIELD", "workspacePath must be absolute");
          }
          const existingPackages = await store.list();
          const inspection = await inspectAutoCutPackageWorkspace({
            workspacePath: input.workspacePath,
            existingPackages,
          });
          return { status: 200, body: { inspection } };
        }

        if (pathname === `${PACKAGE_ROOT}/prepare-output-directory`) {
          if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
          const input = plainObject(body, "package workspace");
          assertAllowed(input, new Set(["workspacePath"]), "package workspace");
          if (typeof input.workspacePath !== "string" || !path.isAbsolute(input.workspacePath.trim())) {
            throw new ApiError(400, "INVALID_FIELD", "workspacePath must be absolute");
          }
          const { zipOutput } = await prepareAutoCutPackageOutputDirectory({ workspacePath: input.workspacePath });
          return { status: 200, body: { zipOutput } };
        }

        if (pathname === `${PACKAGE_ROOT}/validate-output-directory`) {
          if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
          const input = plainObject(body, "output directory");
          assertAllowed(input, new Set(["directory"]), "output directory");
          const directory = await validateCustomZipOutputDirectory(input.directory);
          return { status: 200, body: { directory } };
        }
        const match = pathname.match(/^\/api\/local\/autocut\/packages\/([^/]+)(?:\/(enable|disable))?$/);
        if (!match) return null;

        const alias = decodeAlias(match[1]);
        const action = match[2];
        if (action) {
          if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
          const input = plainObject(body, "package action");
          assertAllowed(input, new Set(["revision", "expectedRevision"]), "package action");
          const expectedRevision = revision(input);
          const record = action === "enable"
            ? await store.enable(alias, expectedRevision, {
              getModelCatalog: (workspacePath) => discoverCatalog(getModelCatalog, workspacePath),
            })
            : await store.disable(alias, expectedRevision);
          return { status: 200, body: { package: record } };
        }
        if (method === "GET") {
          const record = await store.get(alias);
          if (!record) throw new ApiError(404, "PACKAGE_NOT_FOUND", `Package '${alias}' does not exist`);
          return { status: 200, body: { package: record } };
        }
        if (method === "PATCH") {
          const input = plainObject(body, "package");
          const expectedRevision = revision(input);
          const record = await store.saveDraft(alias, packagePatch(input, { allowRevision: true }), expectedRevision);
          return { status: 200, body: { package: record } };
        }
        if (method === "DELETE") {
          const input = body === null || body === undefined ? {} : plainObject(body, "package delete");
          assertAllowed(input, new Set(["revision", "expectedRevision"]), "package delete");
          const record = await store.remove(alias, revision(input));
          return { status: 200, body: { package: record } };
        }
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      } catch (error) {
        throw toApiError(error);
      }
    },
  };
}
