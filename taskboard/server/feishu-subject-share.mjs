import { ApiError } from "./database.mjs";
import { subjectProjectId, validateSubjectConfig } from "./feishu-workflow-store.mjs";
import { normalizeVmPackageWorkflowConfig } from "./feishu-package-workflow-drafts.mjs";
import { normalizePackageWorkflowTemplate } from "../shared/feishu-package-workflow.mjs";

const ZIP = "document_draft_zip";
const VM = "vm_pmo_review_video";
const CONFIG_KEYS = ["trigger", "title", "execution", "packageRoute", "upload", "statusField", "reviewStatusField", "documentField", "namingField", "stages", "delivery"];
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const ROUTE = "/api/local/feishu/workflow/subject-share";
const clone = (value) => structuredClone(value);
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, clone(value[key])]));

function object(value, label, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `${label} must be an object`);
  if (allowed && Object.keys(value).some((key) => !allowed.includes(key))) throw new ApiError(400, "UNKNOWN_FIELD", `${label} contains an unsupported field`);
  return value;
}
function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new ApiError(400, "INVALID_FIELD", `${label} is required`);
  return value.trim();
}
function subjectIdentity(value) {
  const key = requiredText(value, "subjectKey");
  const parts = key.split(":");
  if (parts.length !== 2 || parts.some((part) => !ID.test(part))) throw new ApiError(400, "INVALID_FIELD", "subjectKey is invalid");
  return { subjectKey: key, baseToken: parts[0], tableId: parts[1], projectId: subjectProjectId(key) };
}
function portableMetadata(value) {
  return { fields: (Array.isArray(value?.fields) ? value.fields : []).filter((field) => field && typeof field === "object" && !Array.isArray(field)).map((field) => ({
    fieldId: field.fieldId ?? field.id ?? null,
    fieldName: field.fieldName ?? field.name ?? null,
    type: typeof field.type === "number" || typeof field.type === "string" ? field.type : null,
    uiType: typeof field.uiType === "string" ? field.uiType : null,
    options: (Array.isArray(field.options) ? field.options : []).filter((option) => option && typeof option === "object")
      .map((option) => ({ id: typeof option.id === "string" ? option.id : null, name: typeof option.name === "string" ? option.name : null })),
  })) };
}
function sourceDescription(subject) {
  return { subjectKey: subject.subjectKey, baseName: subject.baseName, tableName: subject.tableName };
}
function stripPaths(config, template) {
  const result = clone(config);
  if (template.id === VM) {
    if (result.finalArchive) {
      if (Object.hasOwn(result.finalArchive, "directoryPath")) result.finalArchive.directoryPath = null;
      if (Object.hasOwn(result.finalArchive, "rootPath")) result.finalArchive.rootPath = null;
    }
  } else {
    if (result.upload) { result.upload.artifactSourcePath = null; result.upload.targetPath = null; }
    if (result.delivery) result.delivery.rootPath = null;
    for (const stage of Object.values(result.stages ?? {})) if (stage && typeof stage === "object") {
      delete stage.artifact_target_path;
      stage.artifactTargetPath = null;
    }
  }
  return result;
}
function normalizeConfig(config, template, source, packageAlias, { portable = false } = {}) {
  object(config, "config", template.id === ZIP ? CONFIG_KEYS : undefined);
  if (template.id === VM) {
    // A portable document deliberately has no machine directory. Validate its
    // shape as an inactive archive, then retain the requested enable intent
    // for mapping against the target's own directory on import.
    const input = clone(config);
    const archiveEnabled = input.finalArchive?.enabled;
    if (portable && archiveEnabled === true) input.finalArchive.enabled = false;
    const normalized = normalizeVmPackageWorkflowConfig(input, undefined, { allowLegacyArchive: true }).config;
    if (portable && archiveEnabled === true) normalized.finalArchive.enabled = true;
    return normalized;
  }
  if (config.packageRoute?.packageAlias !== packageAlias) throw new ApiError(400, "PACKAGE_WORKFLOW_MISMATCH", "Shared package alias does not match its configuration");
  const value = validateSubjectConfig({ ...clone(config), ...subjectIdentity(source.subjectKey),
    baseName: source.baseName, tableName: source.tableName, displayEnabled: true, lifecycle: "draft", configVersion: 1, metadata: null,
  }, { projectLegacyTrigger: true });
  return pick(value, CONFIG_KEYS);
}
function parseShare(value, sourceSubjectKey) {
  object(value, "configuration");
  let envelope = value;
  if (value.kind !== "feishu-subject-workflow") {
    if (value.schemaVersion !== 1 || !Array.isArray(value.bases)) throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", "A subject workflow share is required");
    const sources = value.bases.flatMap((base) => (Array.isArray(base?.subjects) ? base.subjects : []).map((subject) => ({ base,
      subject: { ...subject, subjectKey: subject?.subjectKey ?? `${base.baseToken}:${subject?.tableId}` },
    })));
    const selected = sourceSubjectKey ? sources.filter(({ subject }) => subject?.subjectKey === sourceSubjectKey) : sources.length === 1 ? sources : [];
    if (selected.length !== 1) throw new ApiError(400, "SHARE_SOURCE_REQUIRED", "Select exactly one source subject from this file");
    const { base, subject } = selected[0];
    envelope = { kind: "feishu-subject-workflow", schemaVersion: 1,
      source: { subjectKey: subject.subjectKey, baseName: subject.baseName ?? base.baseName, tableName: subject.tableName, metadata: subject.metadata },
      packageAlias: subject.packageRoute?.packageAlias, workflowTemplate: { id: ZIP, version: 1 }, config: pick(subject, CONFIG_KEYS),
    };
  }
  object(envelope, "configuration", ["kind", "schemaVersion", "source", "packageAlias", "workflowTemplate", "config"]);
  if (envelope.schemaVersion !== 1) throw new ApiError(400, "UNSUPPORTED_SCHEMA_VERSION", "Subject share schemaVersion must be 1");
  object(envelope.source, "source", ["subjectKey", "baseName", "tableName", "metadata"]);
  const source = { ...sourceDescription(envelope.source), metadata: portableMetadata(envelope.source.metadata) };
  subjectIdentity(source.subjectKey);
  source.baseName = requiredText(source.baseName, "source.baseName");
  source.tableName = requiredText(source.tableName, "source.tableName");
  if (sourceSubjectKey && sourceSubjectKey !== source.subjectKey) throw new ApiError(400, "SHARE_SOURCE_REQUIRED", "Selected source is not in this file");
  const packageAlias = requiredText(envelope.packageAlias, "packageAlias");
  const workflowTemplate = normalizePackageWorkflowTemplate(envelope.workflowTemplate);
  const safe = stripPaths(object(envelope.config, "config"), workflowTemplate);
  const config = stripPaths(normalizeConfig(safe, workflowTemplate, source, packageAlias, { portable: true }), workflowTemplate);
  return { kind: "feishu-subject-workflow", schemaVersion: 1, source, packageAlias, workflowTemplate, config };
}

function fieldType(field) {
  if (!field) return null;
  const ui = typeof field.uiType === "string" ? field.uiType.toLowerCase().replace(/[\s_-]/gu, "") : "";
  const uiNumber = { text: 1, singleselect: 3, select: 3, multiselect: 4, attachment: 17, attachments: 17, formula: 20, url: 15 }[ui];
  const numeric = field.type === null || field.type === undefined || field.type === "" ? null : Number(field.type);
  if (numeric !== null && (!Number.isFinite(numeric) || (uiNumber && numeric !== uiNumber))) return null;
  return numeric ?? uiNumber ?? null;
}

function remapConfig(configuration, target, localConfig) {
  const { config, workflowTemplate: template } = configuration;
  const sourceFields = configuration.source.metadata.fields;
  const targetFields = portableMetadata(target.metadata).fields;
  const diagnostics = [];
  const seen = new Set();
  function warning(code, path, message) {
    const key = `${code}:${path}`;
    if (!seen.has(key)) diagnostics.push({ code, severity: "warning", path, message });
    seen.add(key);
  }
  function mapField(id, name, path) {
    if (id === null || id === undefined || id === "") return null;
    const from = sourceFields.filter((field) => field.fieldId === id);
    const source = from.length === 1 ? from[0] : null;
    const fieldName = source?.fieldName ?? name;
    if (!fieldName || from.length > 1 || fieldType(source) === null) {
      warning("SOURCE_FIELD_UNVERIFIED", path, "来源字段缺少唯一名称和类型，请在目标学科重新选择。");
      return null;
    }
    const named = targetFields.filter((field) => field.fieldName === fieldName);
    const matches = named.filter((field) => fieldType(field) === fieldType(source));
    if (matches.length !== 1) {
      warning(matches.length > 1 ? "FIELD_NOT_UNIQUE" : named.length ? "FIELD_TYPE_INVALID" : "FIELD_NOT_FOUND", path,
        `目标学科的“${fieldName}”未找到唯一的同名同类型字段，请重新选择。`);
      return null;
    }
    if (!ID.test(matches[0].fieldId ?? "") || targetFields.filter((field) => field.fieldId === matches[0].fieldId).length !== 1) {
      warning("FIELD_NOT_UNIQUE", path, "目标字段标识不唯一，请刷新字段后重试。");
      return null;
    }
    return matches[0];
  }
  function mapOption(optionId, sourceFieldId, targetField, fallbackName, path) {
    if (optionId === null || optionId === undefined || optionId === "") return null;
    const fromFields = sourceFields.filter((field) => field.fieldId === sourceFieldId);
    const fromOptions = fromFields.length === 1 ? fromFields[0].options.filter((option) => option.id === optionId) : [];
    const name = fromOptions.length === 1 ? fromOptions[0].name : fallbackName;
    const matches = targetField && name && fromOptions.length <= 1 ? targetField.options.filter((option) => option.name === name) : [];
    if (matches.length !== 1 || !ID.test(matches[0]?.id ?? "") || targetField.options.filter((option) => option.id === matches[0]?.id).length !== 1) {
      warning(matches.length > 1 ? "OPTION_NOT_UNIQUE" : "OPTION_NOT_FOUND", path, `目标学科的“${name || "触发/回写选项"}”未找到唯一选项，请重新选择。`);
      return null;
    }
    return matches[0];
  }
  function walk(input, path) {
    if (Array.isArray(input)) return input.map((entry, index) => walk(entry, `${path}[${index}]`));
    if (!input || typeof input !== "object") return input;
    const result = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, walk(value, `${path}.${key}`)]));
    const mappedFields = new Map();
    for (const key of Object.keys(input).filter((key) => key === "fieldId" || key.endsWith("FieldId"))) {
      const field = mapField(input[key], input.fieldName, `${path}.${key}`);
      mappedFields.set(key, field);
      result[key] = field?.fieldId ?? null;
      if (key === "fieldId" && Object.hasOwn(input, "fieldName")) result.fieldName = field?.fieldName ?? "待配置";
    }
    for (const key of ["optionId", "triggerOptionId"]) if (Object.hasOwn(input, key)) {
      const fieldKey = key === "triggerOptionId" ? "statusFieldId" : "fieldId";
      const option = mapOption(input[key], input[fieldKey], mappedFields.get(fieldKey), input.value ?? input.startValue, `${path}.${key}`);
      result[key] = option?.id ?? null;
      if (Object.hasOwn(input, "value")) result.value = option?.name ?? "待配置";
      if (Object.hasOwn(input, "startValue")) result.startValue = option?.name ?? "待配置";
    }
    return result;
  }
  const result = walk(config, "config");
  if (template.id === ZIP) {
    const pendingFieldIds = { statusField: "pending_status_field", reviewStatusField: "pending_review_status_field", documentField: "pending_document_field", namingField: "pending_naming_field", trigger: "pending_status_field" };
    for (const key of ["statusField", "reviewStatusField", "documentField", "namingField", "trigger"]) {
      if (result[key] && !result[key].fieldId) result[key] = { ...result[key], fieldId: pendingFieldIds[key], fieldName: "待配置" };
    }
    if (result.title && !result.title.fieldId) result.title.fieldName = null;
    if (result.trigger && !result.trigger.optionId) result.trigger.optionId = "pending_initial_option";
    for (const [stageId, stage] of Object.entries(result.stages ?? {})) {
      if (!stage.trigger.fieldId) { stage.trigger.fieldId = stageId === "initial" ? result.statusField.fieldId : result.reviewStatusField?.fieldId ?? result.statusField.fieldId; stage.trigger.fieldName = "待配置"; }
      if (!stage.trigger.optionId && stage.enabled) stage.trigger.optionId = `pending_${stageId}_option`;
      for (const source of [stage.videoSource, stage.reviewSource, stage.audio?.source]) if (source?.kind === "base_attachment" && !source.fieldId) source.fieldId = "pending_attachment_field";
      stage.artifactTargetPath = localConfig?.stages?.[stageId]?.artifactTargetPath ?? localConfig?.stages?.[stageId]?.artifact_target_path ?? null;
      if (stage.enabled && result.upload.enabled !== false && result.delivery?.version !== 1
        && !stage.artifactTargetPath && !localConfig?.upload?.targetPath) {
        warning("UPLOAD_TARGET_PATH_UNBOUND", `config.stages.${stageId}.artifactTargetPath`, "请设置此阶段在本机的 ZIP 发布目录。");
      }
    }
    result.upload.artifactSourcePath = localConfig?.upload?.artifactSourcePath ?? null;
    result.upload.targetPath = localConfig?.upload?.targetPath ?? null;
    if (result.delivery) result.delivery.rootPath = localConfig?.delivery?.rootPath ?? null;
    if (["watch_directory", "driver_report"].includes(result.upload.artifactSourceMode) && !result.upload.artifactSourcePath) warning("ARTIFACT_SOURCE_PATH_UNBOUND", "config.upload.artifactSourcePath", "请设置此学科在本机的成品读取目录。");
    if (result.delivery && !result.delivery.rootPath) warning("DELIVERY_ROOT_PATH_UNBOUND", "config.delivery.rootPath", "请设置此学科在本机的交付目录。");
  } else if (result.finalArchive) {
    result.finalArchive.directoryPath = localConfig?.finalArchive?.directoryPath ?? null;
    if (result.finalArchive.enabled && result.finalArchive.pathSource === "manual" && !result.finalArchive.directoryPath) warning("ARCHIVE_PATH_UNBOUND", "config.finalArchive.directoryPath", "请设置此学科在本机的成片归档目录。");
    const archive = result.finalArchive;
    const selectedPath = archive.pathSource === "manual" ? archive.directoryPath : archive.pathFieldId;
    if (archive.enabled && (!archive.statusFieldId || !archive.triggerOptionId || !selectedPath || !result.fields.namingFieldId)) {
      archive.enabled = false;
      warning("ARCHIVE_REQUIRES_CONFIGURATION", "config.finalArchive.enabled", "成片归档需要补齐目标学科的字段或本机目录，已暂时关闭归档开关；补齐后可重新开启。");
    }
  }
  return { config: normalizeConfig(result, template, target, configuration.packageAlias), diagnostics };
}

export function createFeishuSubjectShareApi({ database, workflowStore, packageStore }) {
  const db = database.database;
  const selectProfile = db.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key=? AND package_alias=? AND template_id=? AND template_version=?");
  async function getSubject(subjectKey) {
    const subject = await workflowStore.getSubject(subjectKey);
    if (!db.prepare("SELECT 1 FROM feishu_bases WHERE base_token=? AND removed_at IS NULL").get(subject.baseToken)) throw new ApiError(404, "SUBJECT_NOT_FOUND", "学科所在 PMO 已移除。");
    return subject;
  }
  function readProfile(subject, alias, template) {
    const row = selectProfile.get(subject.subjectKey, alias, template.id, template.version);
    if (row) {
      let config;
      try { config = JSON.parse(row.config_json); } catch { throw new ApiError(500, "PACKAGE_WORKFLOW_DRAFT_INVALID", "Saved workflow draft is invalid"); }
      return { revision: row.revision, config: normalizeConfig(config, template, subject, alias) };
    }
    return { revision: 0, config: template.id === ZIP && subject.packageRoute?.packageAlias === alias ? pick(subject, CONFIG_KEYS) : null };
  }
  async function templateForAlias(alias) {
    const record = typeof packageStore.get === "function" ? await packageStore.get(alias) : (await packageStore.read())?.[alias];
    if (!record) throw new ApiError(409, "PACKAGE_ALIAS_UNAVAILABLE", "此电脑尚未配置共享文件指定的剪辑包。");
    return normalizePackageWorkflowTemplate(record.workflowTemplate);
  }
  function assertVersion(subject, expectedVersion) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new ApiError(400, "INVALID_FIELD", "expectedVersion must be a positive integer");
    if (subject.configVersion !== expectedVersion) throw new ApiError(409, "VERSION_CONFLICT", "目标学科已变化，请重新预览。");
  }
  return {
    async handle({ method, pathname, query = new URLSearchParams(), body }) {
      if (pathname !== `${ROUTE}/export` && pathname !== `${ROUTE}/import`) return null;
      if (pathname.endsWith("/export")) {
        if (method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        if ([...query.keys()].some((key) => !["subjectKey", "packageAlias"].includes(key)) || query.getAll("subjectKey").length !== 1 || query.getAll("packageAlias").length !== 1) throw new ApiError(400, "INVALID_QUERY_PARAMETER", "subjectKey and packageAlias are required exactly once");
        const subject = await getSubject(subjectIdentity(query.get("subjectKey")).subjectKey);
        const packageAlias = requiredText(query.get("packageAlias"), "packageAlias");
        const workflowTemplate = await templateForAlias(packageAlias);
        const profile = readProfile(subject, packageAlias, workflowTemplate);
        if (!profile.config) throw new ApiError(409, "PACKAGE_WORKFLOW_DRAFT_UNSAVED", "请先保存当前剪辑包的学科配置再导出。");
        const configuration = parseShare({ kind: "feishu-subject-workflow", schemaVersion: 1,
          source: { ...sourceDescription(subject), metadata: portableMetadata(subject.metadata) }, packageAlias, workflowTemplate, config: profile.config,
        });
        return { status: 200, body: { configuration } };
      }
      if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      if ([...query.keys()].length) throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Import does not accept query parameters");
      object(body, "body", ["configuration", "sourceSubjectKey", "targetSubjectKey", "expectedVersion", "expectedRevision", "dryRun"]);
      if (typeof body.dryRun !== "boolean") throw new ApiError(400, "INVALID_FIELD", "dryRun must be boolean");
      const configuration = parseShare(body.configuration, body.sourceSubjectKey);
      const target = await getSubject(subjectIdentity(body.targetSubjectKey).subjectKey);
      assertVersion(target, body.expectedVersion);
      const template = await templateForAlias(configuration.packageAlias);
      if (template.id !== configuration.workflowTemplate.id || template.version !== configuration.workflowTemplate.version) throw new ApiError(409, "PACKAGE_WORKFLOW_MISMATCH", "本机剪辑包流程类型与共享配置不一致。");
      const profile = readProfile(target, configuration.packageAlias, template);
      if ((!body.dryRun || body.expectedRevision !== undefined) && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== profile.revision)) throw new ApiError(409, "VERSION_CONFLICT", "目标剪辑包草稿已变化，请重新预览。");
      const mapped = remapConfig(configuration, target, profile.config);
      const result = { configuration, diagnostics: mapped.diagnostics, diagnosticsOk: true, dryRun: body.dryRun,
        source: sourceDescription(configuration.source), target: sourceDescription(target), packageAlias: configuration.packageAlias,
        workflowTemplate: template, expectedVersion: target.configVersion, expectedRevision: profile.revision,
      };
      if (body.dryRun) return { status: 200, body: result };
      db.exec("BEGIN IMMEDIATE");
      try {
        const live = db.prepare("SELECT config_version, metadata_json FROM feishu_subjects WHERE subject_key=? AND removed_at IS NULL AND base_token IN (SELECT base_token FROM feishu_bases WHERE removed_at IS NULL)").get(target.subjectKey);
        if (!live) throw new ApiError(404, "SUBJECT_NOT_FOUND", "目标学科已移除。");
        if (live.config_version !== body.expectedVersion || JSON.stringify(portableMetadata(JSON.parse(live.metadata_json))) !== JSON.stringify(portableMetadata(target.metadata))) throw new ApiError(409, "VERSION_CONFLICT", "目标学科已变化，请重新预览。");
        const current = selectProfile.get(target.subjectKey, configuration.packageAlias, template.id, template.version);
        if ((current?.revision ?? 0) !== body.expectedRevision) throw new ApiError(409, "VERSION_CONFLICT", "目标剪辑包草稿已变化，请重新预览。");
        const timestamp = new Date().toISOString();
        db.prepare(`INSERT INTO feishu_package_workflow_drafts (subject_key,package_alias,template_id,template_version,revision,config_json,updated_at)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(subject_key,package_alias,template_id,template_version) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,updated_at=excluded.updated_at`)
          .run(target.subjectKey, configuration.packageAlias, template.id, template.version, profile.revision + 1, JSON.stringify(mapped.config), timestamp);
        db.prepare(`INSERT INTO feishu_subject_editing_preferences (subject_key,package_alias,updated_at) VALUES (?,?,?)
          ON CONFLICT(subject_key) DO UPDATE SET package_alias=excluded.package_alias,updated_at=excluded.updated_at`).run(target.subjectKey, configuration.packageAlias, timestamp);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { status: 200, body: { ...result, expectedRevision: profile.revision + 1, catalog: await workflowStore.listCatalog() } };
    },
  };
}
