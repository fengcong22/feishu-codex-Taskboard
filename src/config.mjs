import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateDeliveryPolicy } from "./retry-policy.mjs";

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === "") return null;
  return nonEmptyString(value, name);
}

function absolutePath(value, name) {
  const result = nonEmptyString(value, name);
  if (!path.isAbsolute(result)) throw new Error(`${name} must be absolute`);
  return path.normalize(result);
}

export function validateConfig(input) {
  plainObject(input, "config");
  const host = nonEmptyString(input.host, "host");
  if (host !== "127.0.0.1") throw new Error("host must be 127.0.0.1");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  const taskboard = new URL(nonEmptyString(input.taskboardUrl, "taskboardUrl"));
  if (taskboard.protocol !== "http:" || taskboard.hostname !== "127.0.0.1") {
    throw new Error("taskboardUrl must use loopback HTTP");
  }

  if (!Array.isArray(input.tables) || input.tables.length === 0) {
    throw new Error("tables must be a non-empty array");
  }
  const tableIds = new Set();
  const tables = input.tables.map((entry, index) => {
    plainObject(entry, `tables[${index}]`);
    const tableId = nonEmptyString(entry.tableId, `tables[${index}].tableId`);
    if (tableIds.has(tableId)) throw new Error(`duplicate tableId: ${tableId}`);
    tableIds.add(tableId);
    if (entry.mode !== "manual" && entry.mode !== "automatic") {
      throw new Error(`tables[${index}].mode must be manual or automatic`);
    }
    const packageField = optionalString(entry.packageField, `tables[${index}].packageField`);
    const defaultPackageAlias = optionalString(
      entry.defaultPackageAlias,
      `tables[${index}].defaultPackageAlias`,
    );
    if (!packageField && !defaultPackageAlias) {
      throw new Error(
        `tables[${index}] must configure packageField or defaultPackageAlias`,
      );
    }
    return {
      baseToken: optionalString(entry.baseToken, `tables[${index}].baseToken`),
      tableId,
      name: nonEmptyString(entry.name, `tables[${index}].name`),
      mode: entry.mode,
      triggerField: nonEmptyString(entry.triggerField, `tables[${index}].triggerField`),
      triggerFieldId: optionalString(entry.triggerFieldId, `tables[${index}].triggerFieldId`),
      triggerValue: nonEmptyString(entry.triggerValue, `tables[${index}].triggerValue`),
      triggerOptionId: optionalString(entry.triggerOptionId, `tables[${index}].triggerOptionId`),
      titleField: optionalString(entry.titleField, `tables[${index}].titleField`),
      titleFieldId: optionalString(entry.titleFieldId, `tables[${index}].titleFieldId`),
      fallbackTitleField: optionalString(entry.fallbackTitleField, `tables[${index}].fallbackTitleField`),
      fallbackTitleFieldId: optionalString(
        entry.fallbackTitleFieldId,
        `tables[${index}].fallbackTitleFieldId`,
      ),
      packageField,
      packageFieldId: optionalString(entry.packageFieldId, `tables[${index}].packageFieldId`),
      defaultPackageAlias,
    };
  });

  let packages;
  if (input.packages !== undefined) {
    const packageInput = plainObject(input.packages, "packages");
    const packageProjectIds = new Set();
    packages = Object.fromEntries(Object.entries(packageInput).map(([alias, entry]) => {
      nonEmptyString(alias, "package alias");
      plainObject(entry, `packages.${alias}`);
      const projectId = nonEmptyString(entry.projectId, `packages.${alias}.projectId`);
      if (packageProjectIds.has(projectId)) throw new Error(`duplicate package projectId: ${projectId}`);
      packageProjectIds.add(projectId);
      return [alias, {
        projectId,
        projectName: nonEmptyString(entry.projectName, `packages.${alias}.projectName`),
        workspacePath: absolutePath(entry.workspacePath, `packages.${alias}.workspacePath`),
        prompt: nonEmptyString(entry.prompt, `packages.${alias}.prompt`),
      }];
    }));
    if (Object.keys(packages).length === 0) throw new Error("packages must not be empty");
  }

  return {
    host,
    port: input.port,
    taskboardUrl: taskboard.origin,
    stateFile: absolutePath(input.stateFile, "stateFile"),
    delivery: validateDeliveryPolicy(input.delivery),
    tables,
    ...(packages ? { packages } : {}),
  };
}

export async function loadConfig(filename) {
  const contents = await readFile(filename, "utf8");
  return validateConfig(JSON.parse(contents));
}
