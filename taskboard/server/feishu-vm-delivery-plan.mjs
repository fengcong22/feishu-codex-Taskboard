import { win32 as path } from "node:path";
import {
  canonicalCoursePathKey,
  normalizeCourseRootPath,
} from "./feishu-course-path.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FORMULA_ERROR = /^#(?:ERROR|REF|DIV\/0|VALUE|NAME\?|N\/A|NUM|NULL)!?$/iu;
const RESERVED_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\..*)?$/iu;
const MAX_FILENAME_UTF16_UNITS = 180;
// Reserve the longest accepted review suffix for every output so a long
// common name stays identical across initial, review, and final filenames.
const MAX_NAME_UTF16_UNITS = MAX_FILENAME_UTF16_UNITS - `_第${Number.MAX_SAFE_INTEGER}稿.mp4`.length;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function namingField(metadata, fieldId, errorCode = "VM_NAMING_FIELD_INVALID") {
  if (typeof fieldId !== "string" || !IDENTIFIER.test(fieldId)) throw fail(errorCode);
  const fields = (Array.isArray(metadata?.fields) ? metadata.fields : []).filter((field) => field?.fieldId === fieldId);
  if (fields.length !== 1) throw fail(errorCode);
  const field = fields[0];
  const hasType = field.type !== undefined && field.type !== null && field.type !== "";
  const hasUiType = field.uiType !== undefined && field.uiType !== null && field.uiType !== "";
  if (!hasType && !hasUiType) throw fail(errorCode);
  const type = hasType && [1, "1", 20, "20"].includes(field.type) ? Number(field.type) : null;
  const uiType = typeof field.uiType === "string" ? field.uiType.trim().toLowerCase() : null;
  const kind = hasType ? type === 1 ? "text" : type === 20 ? "formula" : null
    : ["text", "formula"].includes(uiType) ? uiType : null;
  if (!kind || (hasUiType && uiType !== kind)) throw fail(errorCode);
  return { ...field, type: kind === "text" ? 1 : 20, uiType: kind === "text" ? "Text" : "Formula" };
}

function exactValue(fields, fieldId, errorCode = "VM_NAMING_VALUE_INVALID") {
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.hasOwn(fields, fieldId)) {
    throw fail(errorCode);
  }
  return fields[fieldId];
}

function namingText(value, field, errorCode = "VM_NAMING_VALUE_INVALID", trim = true) {
  let text = typeof value === "string" ? value : null;
  if (text === null && Array.isArray(value) && value.length === 1) {
    const [entry] = value;
    if (entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry.type === undefined || entry.type === "text") && typeof entry.text === "string") text = entry.text;
  }
  if (text === null || text.trim() === "" || text.includes("\0")
    || (field.type === 20 && FORMULA_ERROR.test(text.trim()))) throw fail(errorCode);
  return trim ? text.trim() : text;
}

function mp4Filename(value, suffix) {
  let stem = value.replace(/\.mp4$/iu, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/^[ .]+|[ .]+$/gu, "");
  while (stem.includes("..")) stem = stem.replaceAll("..", "_");
  if (!stem) throw fail("VM_NAMING_VALUE_INVALID");
  if (RESERVED_NAME.test(stem)) stem = `_${stem}`;
  // Windows counts UTF-16 units; keep surrogate pairs and the complete suffix.
  let truncated = "";
  for (const character of stem) {
    if (truncated.length + character.length > MAX_NAME_UTF16_UNITS) break;
    truncated += character;
  }
  stem = truncated.replace(/[ .]+$/gu, "");
  if (!stem) throw fail("VM_NAMING_VALUE_INVALID");
  return `${stem}${suffix}.mp4`;
}

/** Pure naming rules. The trusted coordinator supplies a persisted round; this
 * module never counts attachments or allocates another round during a retry. */
export function resolveVmStageFilename({ config, stageId, metadata, fields, reviewRound } = {}) {
  if (stageId !== "initial" && stageId !== "review") throw fail("VM_STAGE_INVALID");
  if (stageId === "review" && (!Number.isSafeInteger(reviewRound) || reviewRound < 1)) throw fail("VM_REVIEW_ROUND_INVALID");
  const namingFieldId = config?.fields?.namingFieldId;
  const field = namingField(metadata, namingFieldId);
  const suffix = stageId === "initial" ? "_初稿" : `_第${reviewRound}稿`;
  return mp4Filename(namingText(exactValue(fields, namingFieldId), field), suffix);
}

function frozenRecord(record) {
  const keys = ["baseToken", "tableId", "recordId"];
  if (!record || keys.some((key) => typeof record[key] !== "string" || !IDENTIFIER.test(record[key]))) {
    throw fail("VM_ARCHIVE_SOURCE_INVALID");
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, record[key]])));
}

function confirmedSource(value, record) {
  if (!value || value.status !== "confirmed" || value.artifactKind !== "review_mp4"
    || ["baseToken", "tableId", "recordId"].some((key) => value.record?.[key] !== record[key])
    || ["artifactId", "runId", "deliveryId"].some((key) => typeof value[key] !== "string" || !IDENTIFIER.test(value[key]))
    || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1
    || typeof value.localPath !== "string" || !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/u.test(value.localPath)
    || value.localPath.includes("\0") || path.extname(value.localPath).toLowerCase() !== ".mp4") {
    throw fail("VM_ARCHIVE_SOURCE_INVALID");
  }
  return Object.freeze(Object.fromEntries(["artifactId", "runId", "deliveryId", "localPath", "sha256", "bytes"].map((key) => [key, value[key]])));
}

function archiveDirectory(archive, metadata, fields) {
  if (archive.pathSource === "manual") return normalizeCourseRootPath(archive.directoryPath);
  if (archive.pathSource !== "pmo_field") throw fail("VM_ARCHIVE_PATH_SOURCE_INVALID");
  const field = namingField(metadata, archive.pathFieldId, "VM_ARCHIVE_PATH_FIELD_INVALID");
  const value = exactValue(fields, archive.pathFieldId, "VM_ARCHIVE_PATH_VALUE_INVALID");
  return normalizeCourseRootPath(namingText(value, field, "VM_ARCHIVE_PATH_VALUE_INVALID", false));
}

async function canonicalArchiveDirectory(directory, { classifyDrive, resolveMappedDrive } = {}) {
  if (directory.startsWith("\\\\")) return canonicalCoursePathKey(directory);
  if (typeof classifyDrive !== "function") throw fail("COURSE_PATH_DEPENDENCY_INVALID");
  const kind = await classifyDrive(directory);
  if (kind === "local") return canonicalCoursePathKey(directory);
  if (kind !== "network") throw fail("ROOT_PATH_KIND_UNKNOWN");
  if (typeof resolveMappedDrive !== "function") throw fail("COURSE_PATH_DEPENDENCY_INVALID");
  let mappedRoot;
  try {
    mappedRoot = normalizeCourseRootPath(await resolveMappedDrive(directory));
    if (!mappedRoot.startsWith("\\\\")) throw new Error("not UNC");
  } catch {
    throw fail("NETWORK_ROOT_UNRESOLVED");
  }
  const mappedDirectory = path.join(mappedRoot, path.relative(path.parse(directory).root, directory));
  return canonicalCoursePathKey(mappedDirectory);
}

/** Build a frozen archive plan without reading/copying media or creating a
 * directory. latestDeliveredVideo must come from the coordinator's confirmed
 * delivery pointer, never from a PMO attachment listing or filesystem scan. */
export async function planVmFinalArchive({ config, metadata, record, fields, latestDeliveredVideo } = {}, resolver = {}) {
  const archive = config?.finalArchive;
  const namingFieldId = config?.fields?.namingFieldId;
  if (archive?.enabled !== true) throw fail("VM_ARCHIVE_DISABLED");
  const frozen = frozenRecord(record);
  const source = confirmedSource(latestDeliveredVideo, frozen);
  const destinationDirectory = archiveDirectory(archive, metadata, fields);
  const nameField = namingField(metadata, namingFieldId);
  const filename = mp4Filename(namingText(exactValue(fields, namingFieldId), nameField), "");
  const canonicalDirectory = await canonicalArchiveDirectory(destinationDirectory, resolver);
  const destinationPath = path.join(destinationDirectory, filename);
  const canonicalLocationKey = path.join(canonicalDirectory, filename);
  if (destinationPath.length > 259 || canonicalLocationKey.length > 259) throw fail("COURSE_PATH_TOO_LONG");
  return Object.freeze({
    record: frozen, source, filename, destinationDirectory, destinationPath,
    canonicalLocationKey: canonicalCoursePathKey(canonicalLocationKey),
  });
}

/** Input option IDs are already normalized by the trusted event adapter.
 * Both single-select and multi-select use the same absent → present rule. */
export function isVmFinalArchiveTransition(archive, { fieldId, beforeOptionIds, afterOptionIds } = {}) {
  return archive?.enabled === true && typeof archive.statusFieldId === "string" && fieldId === archive.statusFieldId
    && typeof archive.triggerOptionId === "string" && IDENTIFIER.test(archive.triggerOptionId)
    && Array.isArray(beforeOptionIds) && Array.isArray(afterOptionIds)
    && beforeOptionIds.every((id) => typeof id === "string" && IDENTIFIER.test(id))
    && afterOptionIds.every((id) => typeof id === "string" && IDENTIFIER.test(id))
    && !beforeOptionIds.includes(archive.triggerOptionId) && afterOptionIds.includes(archive.triggerOptionId);
}
