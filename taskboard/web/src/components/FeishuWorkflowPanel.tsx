import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import type {
  FeishuBaseCatalog,
  FeishuFieldMetadata,
  FeishuDeliveryAssignment,
  FeishuDeliveryConfig,
  FeishuPackageSummary,
  FeishuStageConfig,
  FeishuStageConfigMap,
  FeishuStageId,
  FeishuSubjectConfig,
  FeishuWorkflowShareDiagnostic,
  FeishuWorkflowShareConfiguration,
  FeishuSubjectWorkflowShareConfiguration,
  FeishuSubjectWorkflowShareResult,
  FeishuZipWorkflowConfig,
  FeishuPackageWorkflowDraft,
} from "../types";
import {
  audioDraftFromStage,
  FeishuStageEditor,
  isAttachmentField,
  isSingleSelectField,
  type FeishuStageAudioDraft,
  type FeishuStageValue,
} from "./FeishuStageEditor";
import {
  addFeishuBaseFromUrl,
  saveFeishuWorkflowDraft,
  listFeishuWorkflowCatalog,
  setFeishuSubjectDisabled,
  setFeishuSubjectDisplay,
  setFeishuSubjectEnabled,
} from "../feishuWorkflow";
import { ApiError, exportFeishuSubjectWorkflowShare, importFeishuSubjectWorkflowShare, enableFeishuPackageWorkflowDraft, getFeishuPackageWorkflowDraft, saveFeishuPackageWorkflowDraft, listFeishuPackages, refreshFeishuBaseFields } from "../api";
import { packageDisplayName } from "../feishuPackageDisplay";
import { RefreshIcon } from "./SemanticIcons";
import { useFeishuConfigurationLayout } from "./useFeishuConfigurationLayout";
import { FeishuVmPmoWorkflowEditor, type VmPmoDraftCache } from "./FeishuVmPmoWorkflowEditor";

export interface FeishuWorkflowPanelProps {
  catalog: FeishuBaseCatalog[];
  configurationBaseToken: string | null;
  selectedSubjectKey: string | null;
  allowAutomaticExecution?: boolean;
  vmPmoInitialReady?: boolean;
  onOpenLocalSettings?: () => void;
  /** Select a subject; the second flag controls whether to open its task board. */
  onSelectSubject: (subjectKey: string, openProject?: boolean) => void;
  onCatalogChange: (catalog: FeishuBaseCatalog[]) => void;
  onSubjectChange: (subject: FeishuSubjectConfig) => void;
  /** Optional orchestration hooks used by hosts that own persistence. */
  onAddBase?: (url: string) => Promise<FeishuBaseCatalog | void> | void;
  onSaveDraft?: (subjectKey: string, patch: unknown) => Promise<FeishuSubjectConfig> | void;
  onEnable?: (subject: FeishuSubjectConfig) => Promise<FeishuSubjectConfig> | void;
  onDisable?: (subject: FeishuSubjectConfig) => Promise<FeishuSubjectConfig> | void;
  onToggleDisplay?: (subject: FeishuSubjectConfig, displayEnabled: boolean) => Promise<FeishuSubjectConfig> | void;
  onShareImported?: (catalog: FeishuBaseCatalog[]) => void;
  compact?: boolean;
  onOpenConfiguration?: () => void;
  onError?: (message: string, context?: string) => void;
  /** Clear only the error previously reported by this workflow profile. */
  onErrorClear?: (message?: string, context?: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

function statusLabel(subject: FeishuSubjectConfig): string {
  if (subject.lifecycle === "enabled") return "已启用";
  if (subject.activeConfigVersion != null) return "已启用旧版 · 有草稿";
  return subject.lifecycle === "draft" ? "草稿" : "已停用";
}

const PHASE_IDS: FeishuStageId[] = ["initial", "first_review", "final_review"];
const PHASE_LABELS: Record<FeishuStageId, string> = {
  initial: "初稿",
  first_review: "初审修改",
  final_review: "终审修改",
};

const DELIVERY_STAGE_DIRECTORIES: Array<{ stageId: FeishuStageId; name: string }> = [
  { stageId: "initial", name: "01初稿" },
  { stageId: "first_review", name: "02初审" },
  { stageId: "final_review", name: "03终审" },
];

type SettingsTabId = "basics" | "materials" | "storage" | "writeback";

const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string }> = [
  { id: "basics", label: "基础与执行" },
  { id: "materials", label: "素材与阶段" },
  { id: "storage", label: "存储与目录" },
  { id: "writeback", label: "飞书回写" },
];

function fieldIdOf(field: FeishuFieldMetadata | undefined): string {
  return field?.fieldId ?? "";
}

function fieldNameOf(field: FeishuFieldMetadata | undefined): string {
  return field?.fieldName ?? "";
}

function uniqueMetadataField(fields: FeishuFieldMetadata[], fieldId: string | null | undefined): FeishuFieldMetadata | undefined {
  if (!fieldId) return undefined;
  const matches = fields.filter((field) => field.fieldId === fieldId);
  return matches.length === 1 ? matches[0] : undefined;
}

function metadataFieldMatches(fields: FeishuFieldMetadata[], fieldId: string | null | undefined): FeishuFieldMetadata[] {
  if (!fieldId) return [];
  return fields.filter((field) => field.fieldId === fieldId);
}

function metadataFieldIsMissing(fields: FeishuFieldMetadata[], fieldId: string | null | undefined): boolean {
  return Boolean(fieldId) && metadataFieldMatches(fields, fieldId).length === 0;
}

function uniqueMetadataOption(
  field: FeishuFieldMetadata | undefined,
  optionId: string | null | undefined,
) {
  if (!optionId) return undefined;
  const matches = (field?.options ?? []).filter((option) => option.id === optionId);
  return matches.length === 1 ? matches[0] : undefined;
}

function metadataOptionIsMissing(
  field: FeishuFieldMetadata | undefined,
  optionId: string | null | undefined,
): boolean {
  return Boolean(optionId) && (field?.options ?? []).filter((option) => option.id === optionId).length === 0;
}

function metadataFieldRequiresReselection(
  fields: FeishuFieldMetadata[],
  fieldId: string | null | undefined,
  configuredName: string | null | undefined,
  previousFields: FeishuFieldMetadata[] = [],
): boolean {
  const field = uniqueMetadataField(fields, fieldId);
  const previousField = uniqueMetadataField(previousFields, fieldId);
  return Boolean(field && (
    (configuredName && configuredName !== field.fieldName)
    || (previousField && previousField.fieldName !== field.fieldName)
  ));
}

function metadataOptionRequiresReselection(
  field: FeishuFieldMetadata | undefined,
  optionId: string | null | undefined,
  configuredName: string | null | undefined,
  previousFields: FeishuFieldMetadata[] = [],
): boolean {
  const option = uniqueMetadataOption(field, optionId);
  const previousField = uniqueMetadataField(previousFields, field?.fieldId);
  const previousOption = uniqueMetadataOption(previousField, optionId);
  return Boolean(option && (
    (configuredName && configuredName !== option.name)
    || (previousOption && previousOption.name !== option.name)
  ));
}

function uniqueMetadataOptionByName(
  field: FeishuFieldMetadata | undefined,
  optionName: string | null | undefined,
) {
  if (!optionName) return undefined;
  const matches = (field?.options ?? []).filter((option) => option.name === optionName);
  return matches.length === 1 ? matches[0] : undefined;
}

function stageDefaults(subject: FeishuSubjectConfig, fields: FeishuFieldMetadata[]): FeishuStageConfigMap {
  const status = subject.statusField;
  const legacyTriggerField = status ? undefined : uniqueMetadataField(fields, subject.trigger?.fieldId);
  const statusField = uniqueMetadataField(fields, status?.fieldId)
    ?? (legacyTriggerField && isSingleSelectField(legacyTriggerField) ? legacyTriggerField : undefined)
    ?? fields.find(isSingleSelectField);
  const configuredReviewField = subject.reviewStatusField === undefined || subject.reviewStatusField === null
    ? statusField
    : uniqueMetadataField(fields, subject.reviewStatusField.fieldId);
  const existing = subject.stages;
  return Object.fromEntries(PHASE_IDS.map((stageId, index) => {
    const old = existing?.[stageId];
    const triggerField = stageId === "initial" ? statusField : configuredReviewField;
    const options = triggerField?.options ?? [];
    const projectsLegacyInitial = index === 0 && !old;
    const legacyInitialOption = projectsLegacyInitial
      ? subject.trigger?.optionId
        ? uniqueMetadataOption(statusField, subject.trigger.optionId)
        : uniqueMetadataOptionByName(statusField, subject.trigger?.startValue)
      : undefined;
    const option = projectsLegacyInitial ? legacyInitialOption : options[index] ?? options[0];
    const fallback: FeishuStageConfig = {
      enabled: index === 0,
      trigger: {
        fieldId: triggerField?.fieldId ?? (projectsLegacyInitial ? subject.trigger?.fieldId ?? null : null),
        fieldName: triggerField?.fieldName ?? (projectsLegacyInitial ? subject.trigger?.fieldName ?? null : null),
        optionId: option?.id ?? (projectsLegacyInitial ? subject.trigger?.optionId ?? null : null),
        value: option?.name ?? (projectsLegacyInitial ? subject.trigger?.startValue ?? "" : ""),
      },
      videoSource: { kind: "docx_section", anchorText: "录屏" },
      reviewSource: { kind: "docx_section", anchorText: "修改意见" },
      audio: { mode: "video_original" },
      artifactTargetPath: projectsLegacyInitial ? subject.upload?.targetPath ?? null : null,
      nameSuffix: `_${PHASE_LABELS[stageId]}`,
    };
    if (!old) return [stageId, fallback];
    return [stageId, structuredClone(old)];
  })) as FeishuStageConfigMap;
}

type SubjectForm = {
  triggerFieldId: string;
  triggerFieldName: string;
  startValue: string;
  optionId: string | null;
  titleFieldId: string;
  titleFieldName: string;
  executionMode: "manual" | "automatic";
  packageAlias: string;
  artifactSourceMode: "manual_select" | "watch_directory" | "driver_report";
  artifactSourcePath: string;
  enqueueMode: "manual" | "automatic";
  targetId: string;
  targetPath: string;
  uploadConcurrency: string;
  statusFieldId: string;
  statusFieldName: string;
  reviewStatusFieldId: string;
  reviewStatusFieldName: string;
  documentFieldId: string;
  documentFieldName: string;
  namingFieldId: string;
  namingFieldName: string;
  stages: FeishuStageConfigMap | null;
  delivery: FeishuDeliveryConfig | null;
};

type SubjectAudioDrafts = {
  configVersion: number;
  stages: Partial<Record<FeishuStageId, FeishuStageAudioDraft>>;
};

type ZipProfileCacheEntry = {
  profile: FeishuPackageWorkflowDraft<FeishuZipWorkflowConfig> | null;
  form: SubjectForm | null;
  savedForm: SubjectForm | null;
  fields: FeishuFieldMetadata[];
  audio: SubjectAudioDrafts["stages"];
  savedAudio: SubjectAudioDrafts["stages"];
  loading: boolean;
  error: string | null;
};

function profileErrorMessage(error: unknown, action: "read" | "save" | "enable" | "disable"): string {
  const actionLabel = { read: "读取", save: "保存", enable: "启用", disable: "停用" }[action];
  if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
    return `${actionLabel}流程草稿失败（VERSION_CONFLICT）。输入已保留，请重新加载后再保存或启用。`;
  }
  const safeCode = error instanceof ApiError && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
    ? `（${error.code}）` : "";
  return `${actionLabel}流程草稿失败${safeCode}。输入已保留，请检查配置后重试。`;
}

function audioDraftsForStages(stages: FeishuStageConfigMap | null): SubjectAudioDrafts["stages"] {
  if (!stages) return {};
  return Object.fromEntries(PHASE_IDS.map((stageId) => [
    stageId,
    audioDraftFromStage(stages[stageId].audio),
  ])) as SubjectAudioDrafts["stages"];
}

function reconcileAudioDraftMetadata(audio: SubjectAudioDrafts["stages"], fields: FeishuFieldMetadata[], previous: FeishuFieldMetadata[]) {
  return Object.fromEntries(Object.entries(audio).map(([id, draft]) => [id, {
    ...draft,
    baseAttachmentFieldId: metadataFieldIsMissing(fields, draft.baseAttachmentFieldId)
      || metadataFieldRequiresReselection(fields, draft.baseAttachmentFieldId, null, previous)
      ? "" : draft.baseAttachmentFieldId,
  }])) as SubjectAudioDrafts["stages"];
}

function subjectWithProfile(subject: FeishuSubjectConfig, config: FeishuZipWorkflowConfig): FeishuSubjectConfig {
  return { ...subject, trigger: undefined, title: undefined, execution: undefined, packageRoute: undefined,
    upload: undefined, statusField: undefined, reviewStatusField: undefined, documentField: undefined,
    namingField: undefined, stages: undefined, delivery: null, ...config };
}

/** Retain local changes while adopting untouched values from a refreshed draft. */
function rebaseProfileForm<T>(saved: T, local: T, refreshed: T): T {
  if (JSON.stringify(saved) === JSON.stringify(local)) return refreshed;
  if (saved && local && refreshed && typeof saved === "object" && typeof local === "object"
    && typeof refreshed === "object" && !Array.isArray(saved) && !Array.isArray(local) && !Array.isArray(refreshed)) {
    return Object.fromEntries(Object.keys(local).map((key) => [key, rebaseProfileForm(
      (saved as Record<string, unknown>)[key], (local as Record<string, unknown>)[key], (refreshed as Record<string, unknown>)[key],
    )])) as T;
  }
  return local;
}

function hasProfileMergeConflict(saved: unknown, local: unknown, refreshed: unknown): boolean {
  if (JSON.stringify(saved) === JSON.stringify(local)
    || JSON.stringify(saved) === JSON.stringify(refreshed)
    || JSON.stringify(local) === JSON.stringify(refreshed)) return false;
  if (saved && local && refreshed && typeof saved === "object" && typeof local === "object"
    && typeof refreshed === "object" && !Array.isArray(saved) && !Array.isArray(local) && !Array.isArray(refreshed)) {
    const keys = new Set([...Object.keys(saved), ...Object.keys(local), ...Object.keys(refreshed)]);
    return [...keys].some((key) => hasProfileMergeConflict(
      (saved as Record<string, unknown>)[key],
      (local as Record<string, unknown>)[key],
      (refreshed as Record<string, unknown>)[key],
    ));
  }
  return true;
}

function emptyDeliveryConfig(): FeishuDeliveryConfig {
  return {
    version: 1,
    rootPath: null,
    courseNaming: { mode: "reuse_artifact_naming", fieldId: null },
    coursePathWriteback: { enabled: false, fieldId: null },
    writeback: {
      initial: { onProcessing: [], onUploaded: [] },
      first_review: { onProcessing: [], onUploaded: [] },
      final_review: { onProcessing: [], onUploaded: [] },
    },
    finalDirectoryTrigger: { enabled: false, fieldId: null, optionId: null },
  };
}

function isCourseNamingField(field: FeishuFieldMetadata): boolean {
  const type = typeof field.type === "string" ? Number(field.type) : field.type;
  const uiType = field.uiType?.replace(/[\s_-]/gu, "").toLowerCase() ?? null;
  return (type === 1 && (uiType === null || uiType === "text"))
    || (type === 20 && (uiType === null || uiType === "formula"));
}

function isWritableTextField(field: FeishuFieldMetadata): boolean {
  const type = typeof field.type === "string" ? Number(field.type) : field.type;
  const uiType = field.uiType?.replace(/[\s_-]/gu, "").toLowerCase() ?? null;
  return type === 1 && (uiType === null || uiType === "text");
}

function courseDirectoryPreview(
  rootPath: string | null | undefined,
  courseNamingField: FeishuFieldMetadata | undefined,
): { path: string | null; missingMessage: string | null } {
  const normalizedRootPath = rootPath?.trim().replace(/[\\/]+$/u, "") ?? "";
  if (!normalizedRootPath && !courseNamingField) {
    return { path: null, missingMessage: "请先填写课程交付总路径并选择课程名称字段。" };
  }
  if (!normalizedRootPath) return { path: null, missingMessage: "请先填写课程交付总路径。" };
  if (!courseNamingField) return { path: null, missingMessage: "请先选择课程名称字段。" };
  return { path: `${normalizedRootPath}\\{${courseNamingField.fieldName}}`, missingMessage: null };
}

type DeliveryWritebackPreview = {
  timing: string;
  fieldName: string;
  value: string;
  note: string | null;
};

function courseDirectoryWritebackPreview(
  rootPath: string | null | undefined,
  courseNamingField: FeishuFieldMetadata | undefined,
): { path: string | null; note: string | null } {
  if (!courseNamingField) return { path: null, note: null };
  const root = rootPath?.trim().replaceAll("/", "\\").replace(/\\+$/u, "") ?? "";
  if (!root) return { path: null, note: null };

  if (root.startsWith("\\\\")) {
    const [, ...sharePath] = root.slice(2).split("\\").filter(Boolean);
    if (sharePath.length === 0) return { path: null, note: null };
    return {
      path: `${sharePath.join("\\")}\\{${courseNamingField.fieldName}}`,
      note: "UNC 服务器名不会回写到多维表格。",
    };
  }

  if (/^[A-Za-z]:(?:\\|$)/u.test(root)) {
    const relativeRoot = root.slice(2).replace(/^\\+/u, "");
    return {
      path: relativeRoot ? `${relativeRoot}\\{${courseNamingField.fieldName}}` : `{${courseNamingField.fieldName}}`,
      note: "映射盘共享名称在运行时解析；预览仅显示盘符后的目录。",
    };
  }

  return { path: null, note: null };
}

function deliveryWritebackPreview(
  delivery: FeishuDeliveryConfig,
  fields: FeishuFieldMetadata[],
  courseNamingField: FeishuFieldMetadata | undefined,
): DeliveryWritebackPreview[] {
  const preview: DeliveryWritebackPreview[] = [];
  const coursePathTarget = uniqueMetadataField(fields, delivery.coursePathWriteback.fieldId);
  const coursePath = courseDirectoryWritebackPreview(delivery.rootPath, courseNamingField);
  if (delivery.coursePathWriteback.enabled && coursePathTarget && isWritableTextField(coursePathTarget) && coursePath.path) {
    preview.push({
      timing: "首个 ZIP 上传成功",
      fieldName: coursePathTarget.fieldName,
      value: coursePath.path,
      note: coursePath.note,
    });
  }

  for (const stageId of PHASE_IDS) {
    for (const [moment, momentLabel] of [["onProcessing", "处理中"], ["onUploaded", "ZIP 上传成功"]] as const) {
      for (const assignment of delivery.writeback[stageId][moment]) {
        const field = uniqueMetadataField(fields, assignment.fieldId);
        const option = uniqueMetadataOption(field, assignment.optionId);
        if (!field || !isSingleSelectField(field) || !option) continue;
        preview.push({
          timing: `${PHASE_LABELS[stageId]} · ${momentLabel}`,
          fieldName: field.fieldName,
          value: option.name,
          note: null,
        });
      }
    }
  }
  return preview;
}

function formForSubject(subject: FeishuSubjectConfig, reconcile = true): SubjectForm {
  const fields = subject.metadata?.fields ?? [];
  const triggerField = uniqueMetadataField(fields, subject.trigger?.fieldId);
  const triggerOption = uniqueMetadataOption(triggerField, subject.trigger?.optionId);
  const legacyStatusField = !subject.statusField && triggerField && isSingleSelectField(triggerField)
    ? { fieldId: triggerField.fieldId, fieldName: triggerField.fieldName }
    : undefined;
  const statusField = subject.statusField ?? legacyStatusField;
  const reviewStatusField = subject.reviewStatusField ?? statusField;
  const documentField = subject.documentField;
  const namingField = subject.namingField;
  const form: SubjectForm = {
    triggerFieldId: subject.trigger?.fieldId ?? "",
    triggerFieldName: subject.trigger?.fieldName ?? triggerField?.fieldName ?? "",
    startValue: subject.trigger?.startValue ?? triggerOption?.name ?? "",
    optionId: subject.trigger?.optionId ?? null,
    titleFieldId: subject.title?.fieldId ?? "",
    titleFieldName: subject.title?.fieldName ?? "",
    executionMode: subject.execution?.mode ?? "manual",
    packageAlias: subject.packageRoute?.packageAlias ?? "",
    artifactSourceMode: (subject.upload?.artifactSourceMode as SubjectForm["artifactSourceMode"]) ?? "manual_select",
    artifactSourcePath: subject.upload?.artifactSourcePath ?? "",
    enqueueMode: subject.upload?.enqueueMode ?? "manual",
    targetId: subject.upload?.targetId ?? "",
    targetPath: subject.upload?.targetPath ?? "",
    uploadConcurrency: String(subject.upload?.uploadConcurrency ?? 1),
    statusFieldId: statusField?.fieldId ?? "",
    statusFieldName: statusField?.fieldName ?? "",
    reviewStatusFieldId: reviewStatusField?.fieldId ?? "",
    reviewStatusFieldName: reviewStatusField?.fieldName ?? "",
    documentFieldId: documentField?.fieldId ?? "",
    documentFieldName: documentField?.fieldName ?? "",
    namingFieldId: namingField?.fieldId ?? "",
    namingFieldName: namingField?.fieldName ?? "",
    stages: (subject.stages || statusField || documentField || namingField || fields.length > 0)
      ? stageDefaults(subject, fields)
      : null,
    delivery: subject.delivery ? structuredClone(subject.delivery) : null,
  };
  // Pending bindings are saved empty selections, not unsaved metadata repairs.
  const pendingFields = new Set(["pending", "pending_status_field", "pending_review_status_field", "pending_document_field", "pending_naming_field"]);
  const pendingOptions = new Set(PHASE_IDS.map((id) => `pending_${id}_option`));
  for (const prefix of ["trigger", "status", "reviewStatus", "document", "naming"] as const) {
    if (pendingFields.has(form[`${prefix}FieldId`])) {
      form[`${prefix}FieldId`] = "";
      form[`${prefix}FieldName`] = "";
    }
  }
  if (pendingOptions.has(form.optionId ?? "")) {
    form.optionId = null;
    form.startValue = "";
  }
  for (const stage of Object.values(form.stages ?? {})) {
    if (pendingFields.has(stage.trigger.fieldId ?? "")) {
      stage.trigger.fieldId = null;
      stage.trigger.fieldName = "";
    }
    if (pendingOptions.has(stage.trigger.optionId ?? "")) {
      stage.trigger.optionId = null;
      stage.trigger.value = "";
    }
    for (const source of [stage.videoSource, stage.audio.source]) {
      if (source?.kind === "base_attachment" && source.fieldId === "pending_attachment_field") source.fieldId = "";
    }
  }
  return reconcile ? reconcileFormMetadata(form, fields) : form;
}

function reconcileFormMetadata(
  form: SubjectForm,
  fields: FeishuFieldMetadata[],
  previousFields: FeishuFieldMetadata[] = [],
): SubjectForm {
  const triggerField = uniqueMetadataField(fields, form.triggerFieldId);
  const triggerOption = uniqueMetadataOption(triggerField, form.optionId);
  const statusField = uniqueMetadataField(fields, form.statusFieldId);
  const reviewStatusField = uniqueMetadataField(fields, form.reviewStatusFieldId);
  const documentField = uniqueMetadataField(fields, form.documentFieldId);
  const namingField = uniqueMetadataField(fields, form.namingFieldId);
  const stages = form.stages
    ? Object.fromEntries(PHASE_IDS.map((stageId) => {
      const stage = form.stages![stageId];
      const stageField = uniqueMetadataField(fields, stage.trigger.fieldId);
      const stageOption = uniqueMetadataOption(stageField, stage.trigger.optionId);
      const stageFieldMissing = metadataFieldIsMissing(fields, stage.trigger.fieldId)
        || metadataFieldRequiresReselection(fields, stage.trigger.fieldId, stage.trigger.fieldName, previousFields);
      const stageOptionMissing = stageFieldMissing || (Boolean(stageField) && (
        metadataOptionIsMissing(stageField, stage.trigger.optionId)
        || metadataOptionRequiresReselection(stageField, stage.trigger.optionId, stage.trigger.value, previousFields)
      ));
      const videoSource = stage.videoSource.kind === "base_attachment"
        && (metadataFieldIsMissing(fields, stage.videoSource.fieldId)
          || metadataFieldRequiresReselection(fields, stage.videoSource.fieldId, null, previousFields))
        ? { ...stage.videoSource, fieldId: "" }
        : stage.videoSource;
      const audio = stage.audio.mode === "replace_original" && stage.audio.source?.kind === "base_attachment"
        && (metadataFieldIsMissing(fields, stage.audio.source.fieldId)
          || metadataFieldRequiresReselection(fields, stage.audio.source.fieldId, null, previousFields))
        ? { ...stage.audio, source: { ...stage.audio.source, fieldId: "" } }
        : stage.audio;
      return [stageId, {
          ...stage,
          trigger: {
            ...stage.trigger,
            fieldId: stageFieldMissing ? null : stage.trigger.fieldId,
            fieldName: stageFieldMissing ? "" : stageField?.fieldName ?? stage.trigger.fieldName,
            optionId: stageOptionMissing ? null : stage.trigger.optionId,
            value: stageOptionMissing ? "" : stageOption?.name ?? stage.trigger.value,
        },
        videoSource,
        audio,
      }];
    })) as FeishuStageConfigMap
    : null;
  const delivery = form.delivery ? structuredClone(form.delivery) : null;
  if (delivery) {
    if (metadataFieldIsMissing(fields, delivery.courseNaming.fieldId)
      || metadataFieldRequiresReselection(fields, delivery.courseNaming.fieldId, null, previousFields)) {
      delivery.courseNaming.fieldId = null;
    }
    if (metadataFieldIsMissing(fields, delivery.coursePathWriteback.fieldId)
      || metadataFieldRequiresReselection(fields, delivery.coursePathWriteback.fieldId, null, previousFields)) {
      delivery.coursePathWriteback.fieldId = null;
    }
    for (const stageId of PHASE_IDS) {
      for (const moment of ["onProcessing", "onUploaded"] as const) {
        delivery.writeback[stageId][moment] = delivery.writeback[stageId][moment].map((assignment) => {
          const field = uniqueMetadataField(fields, assignment.fieldId);
          return metadataFieldIsMissing(fields, assignment.fieldId)
            || metadataFieldRequiresReselection(fields, assignment.fieldId, null, previousFields)
            ? { fieldId: null, optionId: null }
            : field
              ? {
                fieldId: field.fieldId,
                optionId: metadataOptionIsMissing(field, assignment.optionId)
                  || metadataOptionRequiresReselection(field, assignment.optionId, null, previousFields)
                  ? null
                  : assignment.optionId,
              }
              : { fieldId: null, optionId: null };
        });
      }
    }
    const finalDirectoryField = uniqueMetadataField(fields, delivery.finalDirectoryTrigger.fieldId);
    delivery.finalDirectoryTrigger = metadataFieldIsMissing(fields, delivery.finalDirectoryTrigger.fieldId)
      || metadataFieldRequiresReselection(fields, delivery.finalDirectoryTrigger.fieldId, null, previousFields)
      ? { ...delivery.finalDirectoryTrigger, fieldId: null, optionId: null }
      : finalDirectoryField
        ? {
          ...delivery.finalDirectoryTrigger,
          fieldId: finalDirectoryField.fieldId,
          optionId: metadataOptionIsMissing(finalDirectoryField, delivery.finalDirectoryTrigger.optionId)
            || metadataOptionRequiresReselection(finalDirectoryField, delivery.finalDirectoryTrigger.optionId, null, previousFields)
            ? null
            : delivery.finalDirectoryTrigger.optionId,
        }
        : delivery.finalDirectoryTrigger;
  }
  return {
    ...form,
    triggerFieldId: metadataFieldIsMissing(fields, form.triggerFieldId)
      || metadataFieldRequiresReselection(fields, form.triggerFieldId, form.triggerFieldName, previousFields) ? "" : form.triggerFieldId,
    triggerFieldName: metadataFieldRequiresReselection(fields, form.triggerFieldId, form.triggerFieldName, previousFields) ? "" : triggerField?.fieldName ?? form.triggerFieldName,
    startValue: metadataOptionIsMissing(triggerField, form.optionId)
      || metadataOptionRequiresReselection(triggerField, form.optionId, form.startValue, previousFields) ? "" : triggerOption?.name ?? form.startValue,
    optionId: metadataOptionIsMissing(triggerField, form.optionId)
      || metadataOptionRequiresReselection(triggerField, form.optionId, form.startValue, previousFields) ? null : form.optionId,
    titleFieldId: metadataFieldIsMissing(fields, form.titleFieldId)
      || metadataFieldRequiresReselection(fields, form.titleFieldId, form.titleFieldName, previousFields) ? "" : form.titleFieldId,
    titleFieldName: metadataFieldRequiresReselection(fields, form.titleFieldId, form.titleFieldName, previousFields) ? "" : uniqueMetadataField(fields, form.titleFieldId)?.fieldName ?? form.titleFieldName,
    statusFieldId: metadataFieldIsMissing(fields, form.statusFieldId)
      || metadataFieldRequiresReselection(fields, form.statusFieldId, form.statusFieldName, previousFields) ? "" : form.statusFieldId,
    statusFieldName: metadataFieldRequiresReselection(fields, form.statusFieldId, form.statusFieldName, previousFields) ? "" : statusField?.fieldName ?? form.statusFieldName,
    reviewStatusFieldId: metadataFieldIsMissing(fields, form.reviewStatusFieldId)
      || metadataFieldRequiresReselection(fields, form.reviewStatusFieldId, form.reviewStatusFieldName, previousFields) ? "" : form.reviewStatusFieldId,
    reviewStatusFieldName: metadataFieldRequiresReselection(fields, form.reviewStatusFieldId, form.reviewStatusFieldName, previousFields) ? "" : reviewStatusField?.fieldName ?? form.reviewStatusFieldName,
    documentFieldId: metadataFieldIsMissing(fields, form.documentFieldId)
      || metadataFieldRequiresReselection(fields, form.documentFieldId, form.documentFieldName, previousFields) ? "" : form.documentFieldId,
    documentFieldName: metadataFieldRequiresReselection(fields, form.documentFieldId, form.documentFieldName, previousFields) ? "" : documentField?.fieldName ?? form.documentFieldName,
    namingFieldId: metadataFieldIsMissing(fields, form.namingFieldId)
      || metadataFieldRequiresReselection(fields, form.namingFieldId, form.namingFieldName, previousFields) ? "" : form.namingFieldId,
    namingFieldName: metadataFieldRequiresReselection(fields, form.namingFieldId, form.namingFieldName, previousFields) ? "" : namingField?.fieldName ?? form.namingFieldName,
    stages,
    delivery,
  };
}

function editableSubjectSignature(subject: FeishuSubjectConfig): string {
  return JSON.stringify({
    trigger: subject.trigger ?? null,
    title: subject.title ?? null,
    execution: subject.execution ?? null,
    packageRoute: subject.packageRoute ?? null,
    upload: subject.upload ?? null,
    statusField: subject.statusField ?? null,
    reviewStatusField: subject.reviewStatusField ?? null,
    documentField: subject.documentField ?? null,
    namingField: subject.namingField ?? null,
    stages: subject.stages ?? null,
    delivery: subject.delivery ?? null,
  });
}

function metadataOwnedSignature(subject: FeishuSubjectConfig): string {
  return JSON.stringify({
    baseName: subject.baseName,
    tableName: subject.tableName,
    metadata: subject.metadata ?? null,
  });
}

function phasedFieldNamesNeedRefresh(subject: FeishuSubjectConfig): boolean {
  const fields = subject.metadata?.fields ?? [];
  const descriptorIsStale = (
    descriptor: { fieldId?: string | null; fieldName?: string | null } | null | undefined,
  ) => {
    const current = uniqueMetadataField(fields, descriptor?.fieldId);
    return Boolean(current && descriptor?.fieldName !== current.fieldName);
  };
  return [subject.statusField, subject.reviewStatusField, subject.documentField, subject.namingField].some(descriptorIsStale)
    || Object.values(subject.stages ?? {}).some((stage) => {
      if (descriptorIsStale(stage.trigger)) return true;
      const field = uniqueMetadataField(fields, stage.trigger.fieldId);
      const option = uniqueMetadataOption(field, stage.trigger.optionId);
      return Boolean(option && stage.trigger.value !== option.name);
    });
}

type ShareImportSession = {
  configuration: FeishuSubjectWorkflowShareConfiguration | FeishuWorkflowShareConfiguration;
  target: { subjectKey: string; baseName: string; tableName: string; configVersion: number };
  sources: Array<{ subjectKey: string; baseName: string; tableName: string }>;
  sourceSubjectKey?: string;
  preview: FeishuSubjectWorkflowShareResult | null;
  loading: boolean;
  error: string | null;
};

function shareDiagnosticMessage(diagnostic: FeishuWorkflowShareDiagnostic): string {
  if (/[\u3400-\u9fff]/u.test(diagnostic.message)) return diagnostic.message;
  const guidance: Record<string, string> = {
    FIELD_TYPE_INVALID: "字段类型与当前表不兼容。导入后请重新选择该字段。",
    FIELD_NOT_FOUND: "当前表中找不到该字段。导入后请重新选择对应字段。",
    PACKAGE_ALIAS_UNAVAILABLE: "剪辑包未在本机配置。导入后请重新选择可用的 Auto-Cut 包。",
    MISSING_LOCAL_BINDING: "本机路径尚未绑定。导入后请补齐本机路径。",
    ARTIFACT_SOURCE_PATH_UNBOUND: "本机 ZIP 来源路径尚未绑定。导入后请补齐路径。",
    UPLOAD_TARGET_PATH_UNBOUND: "本机上传目标路径尚未绑定。导入后请补齐路径。",
    FIELD_AMBIGUOUS: "目标学科有多个同名字段，导入后请重新选择。",
    OPTION_NOT_FOUND: "目标字段中找不到对应选项，导入后请重新选择。",
    OPTION_AMBIGUOUS: "目标字段有多个同名选项，导入后请重新选择。",
  };
  return guidance[diagnostic.code] ?? diagnostic.message;
}

export function FeishuWorkflowPanel({
  catalog,
  configurationBaseToken,
  selectedSubjectKey,
  allowAutomaticExecution,
  vmPmoInitialReady = false,
  onOpenLocalSettings,
  onSelectSubject,
  onCatalogChange,
  onSubjectChange,
  onAddBase,
  onSaveDraft,
  onEnable,
  onDisable,
  onToggleDisplay,
  onShareImported,
  compact = false,
  onOpenConfiguration,
  onError,
  onErrorClear,
  onDirtyChange,
}: FeishuWorkflowPanelProps) {
  const layout = useFeishuConfigurationLayout(!compact);
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldRefreshState, setFieldRefreshState] = useState<"idle" | "refreshing" | "succeeded" | "failed">("idle");
  const [fieldRefreshMessage, setFieldRefreshMessage] = useState("");
  const [packageOptions, setPackageOptions] = useState<FeishuPackageSummary[] | null>(null);
  const [packageListLoadState, setPackageListLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [packageListRetryRevision, setPackageListRetryRevision] = useState(0);
  const [shareSession, setShareSession] = useState<ShareImportSession | null>(null);
  const shareRequest = useRef(0);
  const shareTargetRef = useRef<ShareImportSession["target"] | null>(null);
  const [vmImportRevision, setVmImportRevision] = useState(0);
  const vmDraftCache = useRef<VmPmoDraftCache>(new Map());
  const zipDraftCache = useRef(new Map<string, ZipProfileCacheEntry>());
  const selectedAliases = useRef(new Map<string, string>());
  const [profileRevision, setProfileRevision] = useState(0);
  const [profileReload, setProfileReload] = useState(0);
  const refreshedSubjectVersions = useRef(new Map<string, number>());
  const [vmDirty, setVmDirty] = useState(false);
  const recordVmCacheChange = useCallback((dirty: boolean) => {
    setVmDirty(dirty);
    setProfileRevision((value) => value + 1);
  }, []);
  const shareFileRef = useRef<HTMLInputElement | null>(null);
  const catalogRef = useRef(catalog);
  const preserveDirtyFormForSubjectRef = useRef<string | null>(null);
  const metadataRefreshNeedsSaveRef = useRef(new Map<string, number>());
  const [, setMetadataRefreshRevision] = useState(0);
  const scopedCatalog = useMemo(() => (
    configurationBaseToken
      ? catalog.filter((base) => base.baseToken === configurationBaseToken)
      : catalog.slice(0, 1)
  ), [catalog, configurationBaseToken]);
  const selected = useMemo(() => scopedCatalog
    .flatMap((base) => base.subjects)
    .find((subject) => subject.subjectKey === selectedSubjectKey)
    ?? scopedCatalog.flatMap((base) => base.subjects)[0]
    ?? null, [scopedCatalog, selectedSubjectKey]);
  const selectedSubjectRef = useRef(selected?.subjectKey);
  selectedSubjectRef.current = selected?.subjectKey;
  useEffect(() => {
    shareRequest.current += 1;
    setShareSession(null);
  }, [selected?.subjectKey]);
  const selectedEditableSignature = selected ? editableSubjectSignature(selected) : null;
  const selectedMetadataOwnedSignature = selected ? metadataOwnedSignature(selected) : null;
  const [subjectForm, setSubjectFormState] = useState<SubjectForm | null>(() => selected ? formForSubject(selected) : null);
  // Hosts that do not provide the legacy subject-level persistence callbacks use
  // the independent package-profile APIs. Keep this mode active while the
  // package list is loading and when a subject has no/unknown alias, so the UI
  // can gate editing behind selecting a supported package instead of rendering
  // an inert legacy form that silently drops input.
  const profileMode = !onSaveDraft && !onEnable;
  const editingAlias = selected && profileMode
    ? selectedAliases.current.get(selected.subjectKey) ?? selected.preferredPackageAlias ?? selected.packageRoute?.packageAlias ?? ""
    : subjectForm?.packageAlias ?? "";
  const selectedPackage = packageOptions?.find((item) => item.alias === editingAlias);
  const missingSelectedPackage = packageListLoadState === "ready" && Boolean(editingAlias) && !selectedPackage;
  const workflowTemplate = selectedPackage?.workflowTemplate ?? selectedPackage?.identity?.workflowTemplate;
  const profileKey = JSON.stringify([selected?.subjectKey, editingAlias, workflowTemplate?.id ?? "document_draft_zip", workflowTemplate?.version ?? 1]);
  const selectedProfileKeyRef = useRef(profileKey);
  selectedProfileKeyRef.current = profileKey;
  const reportedProfileErrors = useRef(new Map<string, { message: string; source: "profile-read" | "package-list" | "other" }>());
  const reportedPackageListError = useRef<{ context: string; reported: { message: string; source: "profile-read" | "package-list" | "other" } } | null>(null);
  function reportError(message: string, source: "profile-read" | "package-list" | "other" = "other") {
    if (selectedProfileKeyRef.current !== profileKey) return null;
    const reported = { message, source };
    reportedProfileErrors.current.set(profileKey, reported);
    onError?.(message, profileKey);
    return reported;
  }
  function clearReportedError(message?: string, expected?: { message: string }) {
    const reported = reportedProfileErrors.current.get(profileKey);
    if (selectedProfileKeyRef.current !== profileKey || !reported || reported.message !== message
      || (expected && reported !== expected)) return;
    reportedProfileErrors.current.delete(profileKey);
    onErrorClear?.(message, profileKey);
  }
  function recordSavedVmDraft(profile: FeishuPackageWorkflowDraft) {
    const current = catalogRef.current;
    if (!current.some((base) => base.subjects.some((subject) => subject.subjectKey === profile.subjectKey))) return;
    const nextCatalog = current.map((base) => ({
      ...base,
      subjects: base.subjects.map((subject) => subject.subjectKey === profile.subjectKey
        ? { ...subject, preferredPackageAlias: profile.packageAlias }
        : subject),
    }));
    catalogRef.current = nextCatalog;
    onCatalogChange(nextCatalog);
  }
  const profileEntry = zipDraftCache.current.get(profileKey);
  const profileEditorReady = !profileMode || Boolean(selectedPackage && profileEntry?.form);
  const audioCacheKey = profileMode ? profileKey : selected?.subjectKey ?? "";
  function setSubjectForm(value: SubjectForm | null | ((current: SubjectForm | null) => SubjectForm | null)) {
    setSubjectFormState((current) => {
      const next = typeof value === "function" ? value(current) : value;
      const entry = zipDraftCache.current.get(profileKey);
      if (profileMode && entry && next) entry.form = next;
      return next;
    });
  }
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTabId>("basics");
  const settingsTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const audioDraftsBySubjectRef = useRef(new Map<string, SubjectAudioDrafts>(selected ? [[
    selected.subjectKey,
    {
      configVersion: selected.configVersion,
      stages: audioDraftsForStages(formForSubject(selected).stages),
    },
  ]] : []));
  const previousSelectedRef = useRef(selected ? {
    subjectKey: selected.subjectKey,
    editableSignature: selectedEditableSignature,
    metadataOwnedSignature: selectedMetadataOwnedSignature,
    metadataFields: selected.metadata?.fields ?? [],
  } : null);
  const subjectFormDirty = Boolean(selected && subjectForm
    && (JSON.stringify(subjectForm) !== JSON.stringify(profileMode && profileEntry?.savedForm ? profileEntry.savedForm : formForSubject(selected))
      || (!profileMode && phasedFieldNamesNeedRefresh(selected))
      || (!profileMode && metadataRefreshNeedsSaveRef.current.get(selected.subjectKey) === selected.configVersion)));
  const isVmWorkflow = workflowTemplate?.id === "vm_pmo_review_video" && workflowTemplate.version === 1;
  const workflowUnknown = Boolean(workflowTemplate && !isVmWorkflow
    && (workflowTemplate.id !== "document_draft_zip" || workflowTemplate.version !== 1));
  const visibleSubjects = (base: FeishuBaseCatalog) => base.subjects.filter((subject) => subject.displayEnabled);
  const hiddenSubjects = (base: FeishuBaseCatalog) => base.subjects.filter((subject) => !subject.displayEnabled);
  const triggerFields = selected ? selected.metadata?.fields ?? [] : [];
  const phased = Boolean(subjectForm?.stages);
  const metadataFieldOptions = triggerFields;
  const courseNamingFields = metadataFieldOptions.filter(isCourseNamingField);
  const writableTextFields = metadataFieldOptions.filter(isWritableTextField);
  const writebackSingleSelectFields = metadataFieldOptions.filter(isSingleSelectField);
  const configuredCourseNamingField = subjectForm?.delivery
    ? uniqueMetadataField(triggerFields, subjectForm.delivery.courseNaming.mode === "field"
      ? subjectForm.delivery.courseNaming.fieldId : subjectForm.namingFieldId)
    : undefined;
  const configuredUpload = profileMode ? profileEntry?.profile?.config.upload : selected?.upload;
  const needsCourseDirectory = Boolean(subjectForm?.delivery && (
    !configuredUpload || !("enabled" in configuredUpload) || configuredUpload.enabled !== false
    || subjectForm.delivery.finalDirectoryTrigger.enabled
  ));
  const courseNamingBindingWarning = needsCourseDirectory && subjectForm?.delivery
    && (!configuredCourseNamingField || !isCourseNamingField(configuredCourseNamingField))
    ? subjectForm.delivery.courseNaming.mode === "field"
      ? "请在「存储与目录」选择有效的课程名称字段（文本或公式）"
      : "请在「素材与阶段」选择有效的命名字段（文本或公式）"
    : null;
  const configuredCourseDirectoryPreview = courseDirectoryPreview(
    subjectForm?.delivery?.rootPath,
    configuredCourseNamingField,
  );
  const configuredWritebackPreview = subjectForm?.delivery
    ? deliveryWritebackPreview(subjectForm.delivery, triggerFields, configuredCourseNamingField)
    : [];
  const phasedValidation = useMemo(() => {
    if (!subjectForm?.stages) return { errors: [], saveErrors: [] };
    const errors: string[] = [];
    const incompleteBindings = new Set<string>();
    const missingBinding = (message: string) => {
      errors.push(message);
      incompleteBindings.add(message);
    };
    const enabledStages = PHASE_IDS.filter((stageId) => subjectForm.stages?.[stageId]?.enabled);
    if (enabledStages.length === 0) errors.push("至少启用一个阶段");
    const optionIds = enabledStages
      .filter((stageId) => subjectForm.stages?.[stageId]?.trigger.optionId)
      .map((stageId) => JSON.stringify([
        subjectForm.stages?.[stageId]?.trigger.fieldId, subjectForm.stages?.[stageId]?.trigger.optionId,
      ]));
    if (new Set(optionIds).size !== optionIds.length) errors.push("已启用阶段的触发选项不能重复");
    for (const stageId of PHASE_IDS) {
      const stage = subjectForm.stages[stageId];
      if (!stage) continue;
      const phaseLabel = PHASE_LABELS[stageId];
      const expectedFieldId = stageId === "initial" ? subjectForm.statusFieldId : subjectForm.reviewStatusFieldId;
      const statusOptions = uniqueMetadataField(triggerFields, expectedFieldId)?.options ?? [];
      if (stage.enabled && (!stage.trigger.optionId || !stage.trigger.value)) missingBinding(`${phaseLabel}需要触发选项`);
      if (stage.enabled && stage.trigger.optionId) {
        const matches = statusOptions.filter((option) => option.id === stage.trigger.optionId);
        if (matches.length === 0) errors.push(`${phaseLabel}的触发选项当前不可用`);
        else if (matches.length > 1) errors.push(`${phaseLabel}的触发选项不唯一`);
      }
      if (stage.videoSource.kind === "docx_section" && !stage.videoSource.anchorText?.trim()) errors.push(`${phaseLabel}需要视频目录标题`);
      if (stage.enabled && stage.trigger.fieldId && expectedFieldId && stage.trigger.fieldId !== expectedFieldId) errors.push(`${phaseLabel}的触发字段与所选字段不一致`);
      if (stage.videoSource.kind === "base_attachment") {
        if (!stage.videoSource.fieldId) missingBinding(`${phaseLabel}需要视频附件字段`);
        else {
          const matches = metadataFieldMatches(triggerFields, stage.videoSource.fieldId);
          if (matches.length === 0 || (matches.length === 1 && !isAttachmentField(matches[0]))) {
            errors.push(`${phaseLabel}的视频附件字段当前不可用`);
          } else if (matches.length > 1) errors.push(`${phaseLabel}的视频附件字段不唯一`);
        }
      }
      if (!stage.reviewSource.anchorText?.trim()) errors.push(`${phaseLabel}需要剪辑意见目录标题`);
      if (stage.audio.mode === "replace_original") {
        if (stage.audio.source?.kind === "docx_section") {
          if (!stage.audio.source.anchorText?.trim()) errors.push(`${phaseLabel}需要音频目录标题`);
        } else if (stage.audio.source?.kind === "base_attachment") {
          if (!stage.audio.source.fieldId) missingBinding(`${phaseLabel}需要音频附件字段`);
          else {
            const matches = metadataFieldMatches(triggerFields, stage.audio.source.fieldId);
            if (matches.length === 0 || (matches.length === 1 && !isAttachmentField(matches[0]))) {
              errors.push(`${phaseLabel}的音频附件字段当前不可用`);
            } else if (matches.length > 1) errors.push(`${phaseLabel}的音频附件字段不唯一`);
          }
        } else {
          errors.push(`${phaseLabel}需要有效的音频来源`);
        }
        const tolerance = stage.audio.durationToleranceSeconds;
        if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance <= 0) {
          errors.push(`${phaseLabel}的时长误差必须为正数`);
        }
      }
      if (!stage.nameSuffix.trim()) errors.push(`${phaseLabel}需要命名后缀`);
      if (stage.enabled && !subjectForm.delivery && subjectForm.enqueueMode === "automatic" && !stage.artifactTargetPath?.trim()) {
        errors.push(`${phaseLabel}需要 ZIP 目标目录`);
      }
    }
    for (const [fieldId, label] of [
      [subjectForm.statusFieldId, "初稿触发字段"],
      [subjectForm.reviewStatusFieldId, "审核修改触发字段"],
    ]) {
      if (!fieldId) missingBinding(`请选择${label}`);
      else if (metadataFieldMatches(triggerFields, fieldId).length !== 1
        || !isSingleSelectField(uniqueMetadataField(triggerFields, fieldId)!)) errors.push(`${label}当前不可用或不唯一`);
    }
    if (!subjectForm.documentFieldId) missingBinding("请选择素材文档字段");
    else if (metadataFieldMatches(triggerFields, subjectForm.documentFieldId).length === 0) errors.push("素材文档字段当前不可用");
    else if (metadataFieldMatches(triggerFields, subjectForm.documentFieldId).length > 1) errors.push("素材文档字段不唯一");
    if (!subjectForm.namingFieldId) missingBinding("请选择命名字段");
    else if (metadataFieldMatches(triggerFields, subjectForm.namingFieldId).length === 0) errors.push("命名字段当前不可用");
    else if (metadataFieldMatches(triggerFields, subjectForm.namingFieldId).length > 1) errors.push("命名字段不唯一");
    const uniqueErrors = [...new Set(errors)];
    return { errors: uniqueErrors, saveErrors: uniqueErrors.filter((error) => !incompleteBindings.has(error)) };
  }, [subjectForm, triggerFields]);
  const phasedValidationErrors = phasedValidation.errors;
  const draftValidationErrors = phasedValidation.saveErrors;
  const namingFieldTypeWarning = subjectForm?.stages && subjectForm.namingFieldId
    && metadataFieldMatches(triggerFields, subjectForm.namingFieldId).length === 1
    && !isCourseNamingField(uniqueMetadataField(triggerFields, subjectForm.namingFieldId)!)
    ? "命名字段需要文本或公式字段" : null;
  const profileBlocked = profileMode && (!profileEntry?.profile || profileEntry.loading || Boolean(profileEntry.error));
  const enableBlockedReason = subjectFormDirty || (profileMode && profileEntry?.profile?.revision === 0)
    ? "请先保存草稿"
    : profileBlocked
      ? profileEntry?.error ?? "请先读取并保存流程草稿"
    : packageOptions === null
      ? "正在加载 Auto-Cut 包"
      : !subjectForm?.packageAlias
        ? "请选择 Auto-Cut 包"
        : !selectedPackage
          ? "当前包不存在，请重新选择"
          : selectedPackage.state !== "enabled"
            ? "只能启用已启用状态的 Auto-Cut 包"
            : subjectForm.artifactSourceMode === "watch_directory"
              ? "该 ZIP 获取方式将在后续开放"
              : subjectForm.artifactSourceMode === "driver_report" && !subjectForm.artifactSourcePath.trim()
                ? "请填写 ZIP 来源根目录"
                : !phased && subjectForm.enqueueMode === "automatic" && !subjectForm.targetPath.trim()
                  ? "请填写上传路径"
                  : phased && phasedValidationErrors.length > 0
                    ? phasedValidationErrors[0]
                    : namingFieldTypeWarning
                      ? namingFieldTypeWarning
                    : courseNamingBindingWarning
                      ? courseNamingBindingWarning
                    : undefined;
  const selectedTriggerField = subjectForm
    ? triggerFields.find((field) => field.fieldId === subjectForm.triggerFieldId)
    : undefined;
  const startValueOptions = selectedTriggerField?.options ?? [];
  const hasConfiguredTriggerField = subjectForm
    ? triggerFields.some((field) => field.fieldId === subjectForm.triggerFieldId)
    : false;
  const hasConfiguredTitleField = subjectForm
    ? triggerFields.some((field) => field.fieldId === subjectForm.titleFieldId)
    : false;
  const configuredStartValueOption = subjectForm
    ? startValueOptions.find((option) => (
      option.id === subjectForm.optionId && option.name === subjectForm.startValue
    ))
    : undefined;
  const startValueSelectValue = configuredStartValueOption
    ? `option:${configuredStartValueOption.id}`
    : `existing:${subjectForm?.optionId ?? ""}:${subjectForm?.startValue ?? ""}`;

  useEffect(() => {
    catalogRef.current = catalog;
  }, [catalog]);

  useEffect(() => {
    if (profileMode && selectedPackage) return;
    const preserveDirtyForm = Boolean(selected && preserveDirtyFormForSubjectRef.current === selected.subjectKey);
    preserveDirtyFormForSubjectRef.current = null;
    if (!selected) {
      previousSelectedRef.current = null;
      setSubjectFormState(null);
      setActiveSettingsTab("basics");
      return;
    }
    const persistedForm = formForSubject(selected);
    const previousSelected = previousSelectedRef.current;
    const sameSubject = previousSelected?.subjectKey === selected.subjectKey;
    const previousFields = previousSelected?.metadataFields ?? [];
    if (!sameSubject) setActiveSettingsTab("basics");
    const metadataRefresh = sameSubject
      && previousSelected.metadataOwnedSignature !== selectedMetadataOwnedSignature;
    if (metadataRefresh) {
      metadataRefreshNeedsSaveRef.current.set(selected.subjectKey, selected.configVersion);
      setMetadataRefreshRevision((value) => value + 1);
    }
    const preserveCurrentForm = preserveDirtyForm || metadataRefresh;
    previousSelectedRef.current = {
      subjectKey: selected.subjectKey,
      editableSignature: selectedEditableSignature,
      metadataOwnedSignature: selectedMetadataOwnedSignature,
      metadataFields: selected.metadata?.fields ?? [],
    };
    const cached = audioDraftsBySubjectRef.current.get(selected.subjectKey);
    if (!cached || (!preserveCurrentForm && cached.configVersion !== selected.configVersion)) {
      audioDraftsBySubjectRef.current.set(selected.subjectKey, {
        configVersion: selected.configVersion,
        stages: audioDraftsForStages(persistedForm.stages),
      });
    } else if (cached.configVersion !== selected.configVersion) {
      audioDraftsBySubjectRef.current.set(selected.subjectKey, {
        ...cached,
        configVersion: selected.configVersion,
      });
    }
    setSubjectFormState((current) => {
      const nextForm = preserveCurrentForm && current
        ? reconcileFormMetadata(current, selected.metadata?.fields ?? [], previousFields)
        : persistedForm;
      if (preserveCurrentForm || !cached || cached.configVersion !== selected.configVersion) {
        audioDraftsBySubjectRef.current.set(selected.subjectKey, {
          configVersion: selected.configVersion,
          stages: audioDraftsForStages(nextForm.stages),
        });
      }
      return nextForm;
    });
  }, [
    selected?.subjectKey,
    selected?.configVersion,
    selectedEditableSignature,
    selectedMetadataOwnedSignature,
    profileMode,
  ]);

  useEffect(() => {
    if (!profileMode || !selected || !selectedPackage || isVmWorkflow || workflowUnknown) return;
    const controller = new AbortController();
    const fields = selected.metadata?.fields ?? [];
    const cached = zipDraftCache.current.get(profileKey);
    const reportedBeforeRead = reportedProfileErrors.current.get(profileKey);
    const errorBeforeRead = reportedBeforeRead?.source === "profile-read" ? reportedBeforeRead : null;
    if (previousSelectedRef.current?.subjectKey !== selected.subjectKey) setActiveSettingsTab("basics");
    previousSelectedRef.current = { subjectKey: selected.subjectKey, editableSignature: selectedEditableSignature,
      metadataOwnedSignature: selectedMetadataOwnedSignature, metadataFields: fields };
    if (cached?.form) {
      cached.form = reconcileFormMetadata(cached.form, fields, cached.fields);
      cached.audio = reconcileAudioDraftMetadata(cached.audio, fields, cached.fields);
      cached.fields = fields;
      audioDraftsBySubjectRef.current.set(profileKey, { configVersion: selected.configVersion, stages: cached.audio });
      setSubjectFormState(cached.form);
      return;
    }
    const entry: ZipProfileCacheEntry = cached ?? { profile: null, form: null, savedForm: null, fields, audio: {}, savedAudio: {}, loading: false, error: null };
    entry.loading = true; entry.error = null;
    zipDraftCache.current.set(profileKey, entry);
    setProfileRevision((value) => value + 1);
    void getFeishuPackageWorkflowDraft<FeishuZipWorkflowConfig>(selected.subjectKey, editingAlias, controller.signal).then((profile) => {
      if (controller.signal.aborted || zipDraftCache.current.get(profileKey) !== entry) return;
      if (profile.subjectKey !== selected.subjectKey || profile.packageAlias !== editingAlias
        || profile.workflowTemplate.id !== "document_draft_zip" || profile.workflowTemplate.version !== 1) throw new Error("invalid profile");
      const currentSubject = catalogRef.current.flatMap((base) => base.subjects).find((item) => item.subjectKey === selected.subjectKey) ?? selected;
      const profileSubject = subjectWithProfile(currentSubject, profile.config);
      const form = formForSubject(profileSubject);
      const next = { profile, form, savedForm: formForSubject(profileSubject, false), fields: currentSubject.metadata?.fields ?? [],
        audio: audioDraftsForStages(form.stages), savedAudio: audioDraftsForStages(form.stages), loading: false, error: null };
      zipDraftCache.current.set(profileKey, next);
      audioDraftsBySubjectRef.current.set(profileKey, { configVersion: currentSubject.configVersion, stages: next.audio });
      setSubjectFormState(form); setProfileRevision((value) => value + 1);
      if (errorBeforeRead) clearReportedError(errorBeforeRead.message, errorBeforeRead);
    }).catch((error) => {
      if (controller.signal.aborted) return;
      entry.loading = false; entry.error = profileErrorMessage(error, "read");
      setProfileRevision((value) => value + 1); reportError(entry.error, "profile-read");
    });
    return () => controller.abort();
  }, [profileMode, profileKey, selectedPackage, selectedMetadataOwnedSignature, profileReload]);

  const anyDirty = vmDirty || [...zipDraftCache.current.values()].some((entry) => entry.form
    && (JSON.stringify(entry.form) !== JSON.stringify(entry.savedForm)
      || JSON.stringify(entry.audio) !== JSON.stringify(entry.savedAudio))) || (!profileMode && subjectFormDirty);
  useEffect(() => { onDirtyChange?.(anyDirty); }, [anyDirty, onDirtyChange, profileRevision]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!anyDirty) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  useEffect(() => {
    let active = true;
    void listFeishuPackages()
      .then((packages) => {
        if (active) {
          setPackageOptions(packages);
          setPackageListLoadState("ready");
          const previous = reportedPackageListError.current;
          if (previous && reportedProfileErrors.current.get(previous.context) === previous.reported) {
            reportedProfileErrors.current.delete(previous.context);
            onErrorClear?.(previous.reported.message, previous.context);
          }
          reportedPackageListError.current = null;
        }
      })
      .catch(() => {
        if (!active) return;
        setPackageOptions([]);
        setPackageListLoadState("failed");
        const message = "无法读取 Auto-Cut 包列表，请重试。";
        const reported = reportError(message, "package-list");
        reportedPackageListError.current = reported ? { context: profileKey, reported } : null;
      });
    return () => { active = false; };
  }, [packageListRetryRevision]);

  function selectTriggerField(fieldId: string) {
    if (!subjectForm) return;
    const field = triggerFields.find((candidate) => candidate.fieldId === fieldId);
    if (!field) return;
    const options = field.options ?? [];
    const option = options.find((candidate) => candidate.id === subjectForm.optionId)
      ?? options.find((candidate) => candidate.name === subjectForm.startValue)
      ?? options[0]
      ?? null;
    setSubjectForm({
      ...subjectForm,
      triggerFieldId: field.fieldId,
      triggerFieldName: field.fieldName,
      startValue: option?.name ?? subjectForm.startValue,
      optionId: option?.id ?? null,
    });
  }

  function selectStartValue(value: string) {
    if (!subjectForm || !value.startsWith("option:")) return;
    const option = startValueOptions.find((candidate) => candidate.id === value.slice("option:".length));
    if (!option) return;
    setSubjectForm({ ...subjectForm, startValue: option.name, optionId: option.id });
  }

  function selectTitleField(fieldId: string) {
    if (!subjectForm) return;
    const field = triggerFields.find((candidate) => candidate.fieldId === fieldId);
    setSubjectForm({
      ...subjectForm,
      titleFieldId: field?.fieldId ?? "",
      titleFieldName: field?.fieldName ?? "",
    });
  }

  function selectPhasedField(kind: "status" | "reviewStatus" | "document" | "naming", fieldId: string) {
    if (!subjectForm) return;
    const field = triggerFields.find((candidate) => candidate.fieldId === fieldId);
    if (kind === "status" || kind === "reviewStatus") {
      if (fieldId && (!field || !isSingleSelectField(field))) return;
      const currentFieldId = kind === "status" ? subjectForm.statusFieldId : subjectForm.reviewStatusFieldId;
      if (fieldId === currentFieldId) return;
      const stages = subjectForm.stages
        ? Object.fromEntries(PHASE_IDS.map((stageId) => {
          const current = subjectForm.stages?.[stageId];
          if ((stageId === "initial") !== (kind === "status")) return [stageId, current];
          return [stageId, current ? {
            ...current,
            trigger: {
              ...current.trigger,
              fieldId: field?.fieldId ?? null,
              fieldName: field?.fieldName ?? null,
              optionId: null,
              value: "",
            },
          } : current];
        })) as FeishuStageConfigMap
        : null;
      setSubjectForm({ ...subjectForm, stages, ...(kind === "status"
        ? { statusFieldId: field?.fieldId ?? "", statusFieldName: field?.fieldName ?? "" }
        : { reviewStatusFieldId: field?.fieldId ?? "", reviewStatusFieldName: field?.fieldName ?? "" }) });
      return;
    }
    if (!field) return;
    setSubjectForm({
      ...subjectForm,
      ...(kind === "document"
        ? { documentFieldId: field.fieldId, documentFieldName: field.fieldName }
        : { namingFieldId: field.fieldId, namingFieldName: field.fieldName }),
    });
  }

  function updateStage(stageId: FeishuStageId, value: FeishuStageValue) {
    if (!subjectForm?.stages) return;
    setSubjectForm({
      ...subjectForm,
      stages: { ...subjectForm.stages, [stageId]: value as FeishuStageConfig },
    });
  }

  function updateDelivery(update: (delivery: FeishuDeliveryConfig) => FeishuDeliveryConfig) {
    if (!subjectForm?.delivery) return;
    setSubjectForm({ ...subjectForm, delivery: update(subjectForm.delivery) });
  }

  function setCourseDeliveryEnabled(enabled: boolean) {
    if (!subjectForm) return;
    setSubjectForm({
      ...subjectForm,
      delivery: enabled ? (subjectForm.delivery ?? emptyDeliveryConfig()) : null,
    });
  }

  function updateDeliveryAssignment(
    stageId: FeishuStageId,
    moment: "onProcessing" | "onUploaded",
    index: number,
    update: (assignment: FeishuDeliveryAssignment) => FeishuDeliveryAssignment,
  ) {
    updateDelivery((delivery) => {
      const assignments = delivery.writeback[stageId][moment];
      return {
        ...delivery,
        writeback: {
          ...delivery.writeback,
          [stageId]: {
            ...delivery.writeback[stageId],
            [moment]: assignments.map((assignment, assignmentIndex) => (
              assignmentIndex === index ? update(assignment) : assignment
            )),
          },
        },
      };
    });
  }

  function addDeliveryAssignment(stageId: FeishuStageId, moment: "onProcessing" | "onUploaded") {
    updateDelivery((delivery) => ({
      ...delivery,
      writeback: {
        ...delivery.writeback,
        [stageId]: {
          ...delivery.writeback[stageId],
          [moment]: [...delivery.writeback[stageId][moment], { fieldId: null, optionId: null }],
        },
      },
    }));
  }

  function removeDeliveryAssignment(stageId: FeishuStageId, moment: "onProcessing" | "onUploaded", index: number) {
    updateDelivery((delivery) => ({
      ...delivery,
      writeback: {
        ...delivery.writeback,
        [stageId]: {
          ...delivery.writeback[stageId],
          [moment]: delivery.writeback[stageId][moment].filter((_, assignmentIndex) => assignmentIndex !== index),
        },
      },
    }));
  }

  function renderDeliveryAssignments(
    stageId: FeishuStageId,
    moment: "onProcessing" | "onUploaded",
    momentLabel: string,
  ) {
    const assignments = subjectForm?.delivery?.writeback[stageId][moment] ?? [];
    const label = `${PHASE_LABELS[stageId]}${momentLabel}`;
    return <div className="feishu-delivery-moment">
      <strong>{momentLabel}</strong>
      {assignments.map((assignment, index) => {
        const field = uniqueMetadataField(triggerFields, assignment.fieldId);
        const options = field?.options ?? [];
        const suffix = index === 0 ? "" : ` ${index + 1}`;
        return <div className="feishu-delivery-assignment" key={`${stageId}:${moment}:${index}`}>
          <label>
            <span>单选字段</span>
            <select
              aria-label={`${label}字段${suffix}`}
              value={assignment.fieldId ?? ""}
              onChange={(event) => {
                const nextField = uniqueMetadataField(triggerFields, event.target.value);
                const nextOption = nextField?.options?.some((option) => option.id === assignment.optionId)
                  ? assignment.optionId : null;
                updateDeliveryAssignment(stageId, moment, index, () => ({
                  fieldId: event.target.value || null,
                  optionId: nextOption,
                }));
              }}
            >
              <option value="">选择已有单选字段</option>
              {writebackSingleSelectFields.map((candidate) => <option key={candidate.fieldId} value={candidate.fieldId}>{candidate.fieldName}</option>)}
            </select>
          </label>
          <label>
            <span>单选选项</span>
            <select
              aria-label={`${label}选项${suffix}`}
              value={assignment.optionId ?? ""}
              disabled={!field}
              onChange={(event) => updateDeliveryAssignment(stageId, moment, index, (current) => ({
                ...current,
                optionId: event.target.value || null,
              }))}
            >
              <option value="">选择已有单选选项</option>
              {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
          </label>
          <button type="button" className="button secondary" onClick={() => removeDeliveryAssignment(stageId, moment, index)}>移除</button>
        </div>;
      })}
      <button type="button" className="button secondary" onClick={() => addDeliveryAssignment(stageId, moment)}>添加单选字段</button>
    </div>;
  }

  function updateStageAudio(
    stageId: FeishuStageId,
    audio: FeishuStageValue["audio"],
    draft: FeishuStageAudioDraft,
  ) {
    if (!selected || !subjectForm?.stages) return;
    const cached = audioDraftsBySubjectRef.current.get(audioCacheKey) ?? {
      configVersion: selected.configVersion,
      stages: {},
    };
    audioDraftsBySubjectRef.current.set(audioCacheKey, {
      ...cached,
      stages: { ...cached.stages, [stageId]: draft },
    });
    if (profileMode && profileEntry) profileEntry.audio = { ...cached.stages, [stageId]: draft };
    updateStage(stageId, { ...subjectForm.stages[stageId], audio });
  }

  async function addBase() {
    if (!baseUrl.trim()) return;
    setBusy(true);
    try {
      const next = await (onAddBase ? onAddBase(baseUrl.trim()) : addFeishuBaseFromUrl(baseUrl.trim()));
      if (!next) return;
      onCatalogChange([...catalog.filter((base) => base.baseToken !== next.baseToken), next]);
      setBaseUrl("");
    } catch (error) {
      reportError(error instanceof Error ? error.message : "无法读取多维表格");
    } finally { setBusy(false); }
  }

  async function saveDraft() {
    if (!selected || !subjectForm || fieldRefreshState === "refreshing" || (profileMode && profileBlocked)
      || draftValidationErrors.length > 0) return;
    const errorBeforeSave = reportedProfileErrors.current.get(profileKey);
    setBusy(true);
    try {
      const source = profileMode ? profileEntry!.profile!.config : selected;
      const firstEnabledStage = subjectForm.stages
        ? PHASE_IDS.map((stageId) => subjectForm.stages?.[stageId]).find((stage) => stage?.enabled)
        : undefined;
      const patch = {
        expectedVersion: selected.configVersion,
        trigger: {
          ...source.trigger,
          fieldId: firstEnabledStage?.trigger.fieldId ?? subjectForm.triggerFieldId,
          fieldName: firstEnabledStage?.trigger.fieldName ?? subjectForm.triggerFieldName,
          startValue: firstEnabledStage?.trigger.value ?? subjectForm.startValue,
          optionId: firstEnabledStage?.trigger.optionId ?? subjectForm.optionId,
        },
        title: {
          fieldId: subjectForm.titleFieldId || null,
          fieldName: subjectForm.titleFieldName || null,
        },
        execution: {
          concurrencyGroup: "default", maxConcurrent: 1, resourceGroups: [],
          ...source.execution,
          mode: subjectForm.executionMode,
        },
        packageRoute: {
          routeMode: "fixed", subjectCodeFieldId: null, branchMap: null,
          ...source.packageRoute,
          packageAlias: subjectForm.packageAlias,
        },
        upload: {
          ...source.upload,
          artifactSourceMode: subjectForm.artifactSourceMode,
          artifactSourcePath: subjectForm.artifactSourceMode === "manual_select"
            ? null
            : subjectForm.artifactSourcePath || null,
          enqueueMode: subjectForm.enqueueMode,
          targetId: subjectForm.targetId || null,
          targetPath: subjectForm.targetPath || null,
          uploadConcurrency: Number(subjectForm.uploadConcurrency),
        },
        ...(subjectForm.stages ? {
          statusField: { fieldId: subjectForm.statusFieldId || null, fieldName: subjectForm.statusFieldName || null },
          reviewStatusField: { fieldId: subjectForm.reviewStatusFieldId || null, fieldName: subjectForm.reviewStatusFieldName || null },
          documentField: { fieldId: subjectForm.documentFieldId || null, fieldName: subjectForm.documentFieldName || null },
          namingField: { fieldId: subjectForm.namingFieldId || null, fieldName: subjectForm.namingFieldName || null },
          stages: subjectForm.stages,
        } : {}),
        ...(subjectForm.stages ? { delivery: subjectForm.delivery } : {}),
      };
      if (!profileMode) {
        const subject = await (onSaveDraft ? onSaveDraft(selected.subjectKey, patch) : saveFeishuWorkflowDraft(selected.subjectKey, patch));
        if (subject) {
          metadataRefreshNeedsSaveRef.current.delete(selected.subjectKey);
          setMetadataRefreshRevision((value) => value + 1);
          onSubjectChange(subject);
        }
      } else {
        const { expectedVersion: _expectedVersion, ...config } = patch;
        const next = await saveFeishuPackageWorkflowDraft(selected.subjectKey, editingAlias, profileEntry!.profile!.revision, config as FeishuZipWorkflowConfig);
        if (next.subjectKey !== selected.subjectKey || next.packageAlias !== editingAlias
          || next.workflowTemplate.id !== "document_draft_zip" || next.workflowTemplate.version !== 1) throw new Error("invalid profile");
        const currentSubject = catalogRef.current.flatMap((base) => base.subjects).find((item) => item.subjectKey === selected.subjectKey) ?? selected;
        const savedSubject = subjectWithProfile(currentSubject, next.config);
        const savedForm = formForSubject(savedSubject);
        const entry = zipDraftCache.current.get(profileKey)!;
        if (entry.profile && next.revision < entry.profile.revision) return;
        entry.profile = next; entry.savedForm = savedForm; entry.error = null;
        entry.savedAudio = audioDraftsForStages(savedForm.stages);
        const nextCatalog = catalogRef.current.map((base) => ({
          ...base,
          subjects: base.subjects.map((subject) => subject.subjectKey === selected.subjectKey
            ? { ...subject, preferredPackageAlias: editingAlias }
            : subject),
        }));
        catalogRef.current = nextCatalog;
        onCatalogChange(nextCatalog);
        // A save may finish after navigation or a metadata refresh. Keep newer edits.
        if (entry.form === subjectForm) entry.form = formForSubject(savedSubject);
        if (selectedProfileKeyRef.current === profileKey) setSubjectFormState(entry.form);
        setProfileRevision((value) => value + 1);
        if (errorBeforeSave) clearReportedError(errorBeforeSave.message, errorBeforeSave);
      }
    }
    catch (error) {
      if (profileMode && profileEntry && error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        profileEntry.error = profileErrorMessage(error, "save");
        setProfileRevision((value) => value + 1);
      }
      reportError(profileMode ? profileErrorMessage(error, "save") : error instanceof Error ? error.message : "无法保存草稿");
    }
    finally { setBusy(false); }
  }

  async function transition(action: "enable" | "disable") {
    if (!selected || (action === "enable" && (enableBlockedReason || fieldRefreshState === "refreshing"))) return;
    const errorBeforeTransition = reportedProfileErrors.current.get(profileKey);
    const preserveDirtyForm = action === "disable" && subjectFormDirty;
    setBusy(true);
    try {
      const subject = await (action === "enable"
        ? (onEnable ? onEnable(selected) : profileMode
          ? enableFeishuPackageWorkflowDraft(selected.subjectKey, editingAlias, profileEntry!.profile!.revision,
            Math.max(selected.configVersion, refreshedSubjectVersions.current.get(selected.subjectKey) ?? selected.configVersion))
          : setFeishuSubjectEnabled(selected))
        : (onDisable ? onDisable(selected) : setFeishuSubjectDisabled(selected)));
      if (subject) {
        if (preserveDirtyForm) preserveDirtyFormForSubjectRef.current = subject.subjectKey;
        onSubjectChange(subject);
        if (action === "enable" && profileMode && errorBeforeTransition) {
          clearReportedError(errorBeforeTransition.message, errorBeforeTransition);
        }
      }
    }
    catch (error) {
      if (action === "enable" && profileMode && profileEntry) {
        profileEntry.error = profileErrorMessage(error, "enable");
        setProfileRevision((value) => value + 1);
      }
      reportError(profileMode ? profileErrorMessage(error, action) : error instanceof Error ? error.message : "无法更新状态");
    }
    finally { setBusy(false); }
  }

  async function toggleDisplay(subject: FeishuSubjectConfig, displayEnabled: boolean) {
    setBusy(true);
    try {
      const next = await (onToggleDisplay
        ? onToggleDisplay(subject, displayEnabled)
        : setFeishuSubjectDisplay(subject, displayEnabled));
      if (next) onSubjectChange(next);
    } catch (error) {
      reportError(error instanceof Error ? error.message : "无法更新显示设置");
    } finally { setBusy(false); }
  }

  const currentSubjectHasEdits = Boolean(selected && (
    (!profileMode && subjectFormDirty)
    || [...zipDraftCache.current.entries()].some(([key, entry]) => JSON.parse(key)[0] === selected.subjectKey
      && ((entry.form && JSON.stringify(entry.form) !== JSON.stringify(entry.savedForm))
        || JSON.stringify(entry.audio) !== JSON.stringify(entry.savedAudio)))
    || [...vmDraftCache.current.entries()].some(([key, entry]) => JSON.parse(key)[0] === selected.subjectKey
      && (entry.saving || (entry.profile && entry.config && JSON.stringify(entry.config) !== JSON.stringify(entry.profile.config))))
  ));
  const shareBlockedReason = currentSubjectHasEdits ? "请先保存当前学科尚未保存的修改，再导入或导出配置。" : "";
  const currentVmProfile = vmDraftCache.current.get(profileKey)?.profile;
  const canExportShare = Boolean(selected && selectedPackage && editingAlias && !currentSubjectHasEdits
    && (!profileMode || (isVmWorkflow ? currentVmProfile?.revision : profileEntry?.profile?.revision)));

  async function exportShare() {
    if (!selected || !canExportShare || busy) return;
    setBusy(true);
    try {
      const configuration = await exportFeishuSubjectWorkflowShare(selected.subjectKey, editingAlias);
      const blob = new Blob([`${JSON.stringify(configuration, null, 2)}\n`], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `${selected.tableName.replace(/[\\/:*?"<>|]/gu, "_")}-学科配置.json`;
      link.click();
      URL.revokeObjectURL(href);
    } catch (error) {
      reportError(error instanceof Error ? error.message : "无法导出学科配置");
    } finally { setBusy(false); }
  }

  function openShareFile() {
    if (!selected || currentSubjectHasEdits || busy) return;
    shareTargetRef.current = { subjectKey: selected.subjectKey, baseName: selected.baseName,
      tableName: selected.tableName, configVersion: selected.configVersion };
    shareFileRef.current?.click();
  }

  function closeShareImport() {
    shareRequest.current += 1;
    shareTargetRef.current = null;
    setShareSession(null);
  }

  async function previewShare(session: ShareImportSession) {
    const requestId = ++shareRequest.current;
    setShareSession({ ...session, preview: null, loading: true, error: null });
    try {
      const preview = await importFeishuSubjectWorkflowShare({ configuration: session.configuration,
        sourceSubjectKey: session.sourceSubjectKey, targetSubjectKey: session.target.subjectKey,
        expectedVersion: session.target.configVersion, dryRun: true });
      if (requestId !== shareRequest.current || selectedSubjectRef.current !== session.target.subjectKey) return;
      setShareSession({ ...session, preview, loading: false, error: null });
    } catch (error) {
      if (requestId !== shareRequest.current || selectedSubjectRef.current !== session.target.subjectKey) return;
      setShareSession({ ...session, preview: null, loading: false,
        error: error instanceof Error ? error.message : "无法预览学科配置" });
    }
  }

  async function importShare(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selected || busy || currentSubjectHasEdits) return;
    const target = shareTargetRef.current ?? { subjectKey: selected.subjectKey, baseName: selected.baseName,
      tableName: selected.tableName, configVersion: selected.configVersion };
    const requestId = ++shareRequest.current;
    try {
      const configuration = JSON.parse(await file.text()) as ShareImportSession["configuration"];
      if (requestId !== shareRequest.current || selectedSubjectRef.current !== target.subjectKey) return;
      const portable = "kind" in configuration && configuration.kind === "feishu-subject-workflow";
      const sources = portable ? [] : "bases" in configuration && Array.isArray(configuration.bases)
        ? configuration.bases.flatMap((base) => base.subjects.map((subject) => ({
          subjectKey: subject.subjectKey || `${base.baseToken}:${subject.tableId}`,
          baseName: base.baseName, tableName: subject.tableName,
        }))) : [];
      if (!portable && sources.length === 0) throw new Error("文件中没有可复用的学科配置。");
      const session: ShareImportSession = { configuration, target, sources,
        sourceSubjectKey: sources.length === 1 ? sources[0].subjectKey : undefined,
        preview: null, loading: false, error: null };
      if (portable || sources.length === 1) await previewShare(session);
      else setShareSession(session);
    } catch (error) {
      if (requestId === shareRequest.current) reportError(error instanceof Error ? error.message : "无法读取学科配置");
    }
  }

  async function confirmShareImport() {
    const session = shareSession;
    if (!session?.preview || session.loading || session.preview.diagnosticsOk === false || busy
      || currentSubjectHasEdits || selectedSubjectRef.current !== session.target.subjectKey) return;
    setBusy(true);
    try {
      const imported = await importFeishuSubjectWorkflowShare({ configuration: session.configuration,
        sourceSubjectKey: session.sourceSubjectKey, targetSubjectKey: session.target.subjectKey,
        expectedVersion: session.preview.expectedVersion, expectedRevision: session.preview.expectedRevision, dryRun: false });
      const key = JSON.stringify([session.target.subjectKey, imported.packageAlias, imported.workflowTemplate.id, imported.workflowTemplate.version]);
      zipDraftCache.current.delete(key);
      vmDraftCache.current.delete(key);
      audioDraftsBySubjectRef.current.delete(key);
      reportedProfileErrors.current.delete(key);
      selectedAliases.current.set(session.target.subjectKey, imported.packageAlias);
      if (imported.catalog) {
        const importedSubject = imported.catalog.flatMap((base) => base.subjects)
          .find((subject) => subject.subjectKey === session.target.subjectKey);
        const nextCatalog = catalogRef.current.map((base) => ({ ...base,
          subjects: base.subjects.map((subject) => subject.subjectKey === importedSubject?.subjectKey ? importedSubject : subject),
        }));
        catalogRef.current = nextCatalog;
        onCatalogChange(nextCatalog);
        onShareImported?.(nextCatalog);
      }
      setProfileReload((value) => value + 1);
      setVmImportRevision((value) => value + 1);
      closeShareImport();
    } catch (error) {
      if (selectedSubjectRef.current === session.target.subjectKey) setShareSession({ ...session,
        error: error instanceof Error ? error.message : "无法导入学科配置", preview: null });
    } finally { setBusy(false); }
  }

  async function refreshFields() {
    if (!selected || fieldRefreshState === "refreshing") return;
    const baseToken = selected.baseToken;
    const errorBeforeRefresh = reportedProfileErrors.current.get(profileKey);
    setFieldRefreshState("refreshing");
    setFieldRefreshMessage("");
    try {
      const refreshed = await refreshFeishuBaseFields(baseToken);
      const current = catalogRef.current;
      const refreshEntries = profileMode ? [...zipDraftCache.current.entries()].flatMap(([key, entry]) => {
        const [subjectKey, alias, templateId, templateVersion] = JSON.parse(key) as [string, string, string, number];
        const subject = refreshed.subjects.find((item) => item.subjectKey === subjectKey);
        if (!subject || !entry.form || !entry.savedForm || templateId !== "document_draft_zip" || templateVersion !== 1) return [];
        entry.loading = true;
        return [{ key, entry, subject, alias, savedForm: entry.savedForm }];
      }) : [];
      if (current.some((base) => base.baseToken === baseToken)) {
        const nextCatalog = current.map((base) => base.baseToken === baseToken ? refreshed : base);
        catalogRef.current = nextCatalog;
        onCatalogChange(nextCatalog);
      }
      setProfileRevision((value) => value + 1);
      const results = await Promise.allSettled(refreshEntries.map(async ({ key, entry, subject, alias, savedForm }) => {
        try {
          const profile = await getFeishuPackageWorkflowDraft<FeishuZipWorkflowConfig>(subject.subjectKey, alias);
          if (profile.subjectKey !== subject.subjectKey || profile.packageAlias !== alias
            || profile.workflowTemplate.id !== "document_draft_zip" || profile.workflowTemplate.version !== 1) throw new Error("invalid profile");
          if (zipDraftCache.current.get(key) !== entry) return;
          const fields = subject.metadata?.fields ?? [];
          const nextSavedForm = formForSubject(subjectWithProfile(subject, profile.config), false);
          const nextSavedAudio = audioDraftsForStages(nextSavedForm.stages);
          if (hasProfileMergeConflict(savedForm, entry.form, nextSavedForm)
            || hasProfileMergeConflict(entry.savedAudio, entry.audio, nextSavedAudio)) {
            throw new ApiError(409, { error: { code: "VERSION_CONFLICT" } });
          }
          entry.form = reconcileFormMetadata(rebaseProfileForm(savedForm, entry.form!, nextSavedForm), fields, entry.fields);
          entry.audio = reconcileAudioDraftMetadata(
            rebaseProfileForm(entry.savedAudio, entry.audio, nextSavedAudio),
            fields,
            entry.fields,
          );
          entry.savedForm = nextSavedForm;
          entry.savedAudio = nextSavedAudio;
          entry.fields = fields;
          entry.profile = profile;
          entry.error = null;
          audioDraftsBySubjectRef.current.set(key, { configVersion: subject.configVersion, stages: entry.audio });
          if (selectedProfileKeyRef.current === key) setSubjectFormState(entry.form);
        } catch (error) {
          entry.error = profileErrorMessage(error, "read");
          throw error;
        } finally {
          entry.loading = false;
          setProfileRevision((value) => value + 1);
        }
      }));
      const failures = results.flatMap((result, index) => result.status === "rejected" ? [{
        alias: refreshEntries[index].alias,
        conflict: result.reason instanceof ApiError && result.reason.code === "VERSION_CONFLICT",
      }] : []);
      if (failures.length > 0) {
        setFieldRefreshState("failed");
        const details = failures.map(({ alias, conflict }) => `${alias} 包${conflict
          ? "的本地修改与最新草稿冲突" : "的流程草稿读取失败"}`).join("；");
        setFieldRefreshMessage(`${isVmWorkflow ? "VM 字段已刷新" : "字段已刷新"}，但${details}。输入已保留，请切回对应包处理。`);
        return;
      }
      setFieldRefreshState("succeeded");
      setFieldRefreshMessage("字段刷新成功，可直接选择新增字段或单选项。");
      if (errorBeforeRefresh && reportedProfileErrors.current.get(profileKey) === errorBeforeRefresh) {
        clearReportedError(errorBeforeRefresh.message);
      }
    } catch (error) {
      setFieldRefreshState("failed");
      setFieldRefreshMessage(error instanceof Error ? error.message : "字段刷新失败，请重试。");
    }
  }

  function settingsTabDomId(tabId: SettingsTabId) {
    return `feishu-subject-tab-${tabId}`;
  }

  function settingsPanelDomId(tabId: SettingsTabId) {
    return `feishu-subject-panel-${tabId}`;
  }

  function selectSettingsTab(tabId: SettingsTabId) {
    setActiveSettingsTab(tabId);
  }

  function selectPackage(alias: string) {
    if (!selected || !subjectForm) return;
    if (profileMode) {
      if (alias !== editingAlias) {
        const reported = reportedProfileErrors.current.get(profileKey);
        if (reported) clearReportedError(reported.message, reported);
      }
      selectedAliases.current.set(selected.subjectKey, alias);
      setProfileRevision((value) => value + 1);
    } else setSubjectForm({ ...subjectForm, packageAlias: alias });
  }

  async function reloadProfile() {
    const dirty = subjectFormDirty || (profileEntry && JSON.stringify(profileEntry.audio) !== JSON.stringify(profileEntry.savedAudio));
    if (dirty && !window.confirm("重新加载会放弃此包尚未保存的修改，是否继续？")) return;
    zipDraftCache.current.delete(profileKey);
    try {
      const latestCatalog = await listFeishuWorkflowCatalog();
      catalogRef.current = latestCatalog;
      onCatalogChange(latestCatalog);
      const latestSubject = latestCatalog.flatMap((base) => base.subjects).find((item) => item.subjectKey === selected?.subjectKey);
      if (latestSubject) refreshedSubjectVersions.current.set(latestSubject.subjectKey, latestSubject.configVersion);
    } catch {
      // The profile reload below still gives the operator a safe retry path.
    }
    setProfileReload((value) => value + 1);
  }

  function handleSettingsTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, tabId: SettingsTabId) {
    const currentIndex = SETTINGS_TABS.findIndex((tab) => tab.id === tabId);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % SETTINGS_TABS.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = SETTINGS_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = SETTINGS_TABS[nextIndex];
    setActiveSettingsTab(nextTab.id);
    settingsTabRefs.current[nextIndex]?.focus();
  }

  return <section
    ref={layout.panelRef}
    className={`feishu-workflow-panel${compact ? " is-compact" : ""}${!compact && layout.stacked ? " is-stacked" : ""}${layout.dragging ? " is-resizing" : ""}`}
    style={compact ? undefined : layout.style}
    aria-label="飞书多维表格工作流"
  >
    <div className="feishu-workflow-add" inert={Boolean(shareSession)}>
      {!compact && <>
        <input aria-label="多维表格链接" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="粘贴多维表格链接" />
        <button type="button" onClick={() => void addBase()} disabled={busy || !baseUrl.trim()}>新增多维表格</button>
      </>}
      {compact && <>
        <strong className="feishu-workflow-current-label">{selected ? `${selected.baseName} / ${selected.tableName}` : "选择学科"}</strong>
        <button type="button" onClick={onOpenConfiguration}>配置多维表格</button>
      </>}
    </div>
    {shareSession && <div role="dialog" aria-modal="true" aria-label="学科配置导入预览" style={{
      position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center",
      padding: 16, background: "rgba(0, 0, 0, 0.45)",
    }}>
      <section style={{ width: "min(760px, 100%)", maxHeight: "min(80vh, 760px)", overflowY: "auto",
        padding: 20, borderRadius: 8, background: "#fff", color: "#202a32" }}>
        <h3>学科配置导入预览</h3>
        <p>仅复用一个来源学科的配置到当前学科，保存为草稿。核对后需手动启用；当前生效版本继续运行。</p>
        {shareSession.sources.length > 1 && <label>来源学科<select value={shareSession.sourceSubjectKey ?? ""} disabled={busy}
          onChange={(event) => {
            const sourceSubjectKey = event.target.value;
            if (sourceSubjectKey) void previewShare({ ...shareSession, sourceSubjectKey });
            else { shareRequest.current += 1; setShareSession({ ...shareSession, sourceSubjectKey: undefined, preview: null, loading: false }); }
          }}>
          <option value="">请选择一个来源学科</option>
          {shareSession.sources.map((source) => <option key={source.subjectKey} value={source.subjectKey}>{source.baseName} / {source.tableName}</option>)}
        </select></label>}
        {shareSession.preview && <p>来源：{shareSession.preview.source.baseName} / {shareSession.preview.source.tableName}</p>}
        <p>目标：{shareSession.target.baseName} / {shareSession.target.tableName}</p>
        {shareSession.loading && <p role="status">正在匹配目标学科的字段和选项…</p>}
        {shareSession.error && <p role="alert">{shareSession.error}</p>}
        {shareSession.preview && (shareSession.preview.diagnostics.length === 0 ? <p>字段与选项已匹配，可导入草稿。</p> : <ul>
          {shareSession.preview.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.path ?? ""}:${diagnostic.code}:${index}`}>
            <strong>[{diagnostic.code}]</strong>
            <span> {diagnostic.severity === "error" ? "错误" : diagnostic.severity === "warning" ? "待核对" : "提示"}：{shareDiagnosticMessage(diagnostic)}</span>
            {diagnostic.path && <div><small>{diagnostic.path}</small></div>}
          </li>)}
        </ul>)}
        {shareSession.preview?.diagnosticsOk === false && <p role="alert">请先处理以上错误，再重新导入。</p>}
        <div className="feishu-subject-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={closeShareImport}>取消导入</button>
          <button type="button" className="button primary" disabled={busy || shareSession.loading || !shareSession.preview
            || shareSession.preview.diagnosticsOk === false || currentSubjectHasEdits} onClick={() => void confirmShareImport()}>
            {shareSession.preview?.diagnostics.some((diagnostic) => diagnostic.severity !== "info") ? "导入为待修复草稿" : "确认导入草稿"}
          </button>
        </div>
      </section>
    </div>}
    <div className="feishu-workflow-catalog" id="feishu-subject-catalog" inert={Boolean(shareSession)}>
      {scopedCatalog.map((base) => <div className="feishu-base" key={base.baseToken}>
        <h3>{base.baseName}</h3>
        <h4>已显示子表</h4>
        {visibleSubjects(base).map((subject) => <div className="feishu-subject-row" key={subject.subjectKey}>
          <button
            type="button"
            className={subject.subjectKey === selectedSubjectKey ? "active" : ""}
            onClick={() => onSelectSubject(subject.subjectKey, compact)}
          >{subject.tableName}<span>{statusLabel(subject)}</span></button>
          <button type="button" disabled={busy} onClick={() => void toggleDisplay(subject, false)}>隐藏</button>
        </div>)}
        {!compact && <>
          <h4>未显示子表</h4>
          {hiddenSubjects(base).map((subject) => <div className="feishu-subject-row" key={subject.subjectKey}>
            <button
              type="button"
              className={subject.subjectKey === selectedSubjectKey ? "active" : ""}
              onClick={() => onSelectSubject(subject.subjectKey, false)}
            >{subject.tableName}<span>{statusLabel(subject)}</span></button>
            <button type="button" disabled={busy} onClick={() => void toggleDisplay(subject, true)}>显示</button>
          </div>)}
        </>}
      </div>)}
    </div>
    {!compact && !layout.stacked && <div className="feishu-workflow-splitter" aria-controls="feishu-subject-catalog" {...layout.splitterProps} />}
    {!compact && selected && subjectForm && <form className={`feishu-subject-settings has-package-route${isVmWorkflow ? " is-vm-workflow" : ""}`} role="region" aria-label="学科配置" inert={Boolean(shareSession)} onSubmit={(event) => { event.preventDefault(); if (!isVmWorkflow && !workflowUnknown) void saveDraft(); }}>
      <header className="feishu-subject-settings-header">
        <div>
          <div>
            <h3>{selected.tableName}学科配置</h3>
            <p>{selected.baseName} · {isVmWorkflow ? "VM 视频剪辑与 PMO 审核" : phased ? "三个剪辑阶段" : "单阶段剪辑流程"}</p>
          </div>
          <span data-lifecycle={isVmWorkflow && selected.activePackageAlias !== editingAlias ? "draft" : selected.activeConfigVersion != null ? "enabled" : selected.lifecycle}>{isVmWorkflow && selected.activePackageAlias !== editingAlias ? "流程草稿" : statusLabel(selected)}</span>
        </div>
        <div className="feishu-subject-settings-header-actions">
          <button type="button" className="button secondary" onClick={() => void exportShare()} disabled={busy || !canExportShare}
            title={shareBlockedReason || (!canExportShare ? "请先选择剪辑包并保存学科配置。" : "导出当前学科已保存的包配置")}>导出学科配置</button>
          <button type="button" className="button secondary" onClick={openShareFile} disabled={busy || currentSubjectHasEdits}
            title={shareBlockedReason || "将一个学科的配置复用到当前学科"}>导入学科配置</button>
          <input ref={shareFileRef} type="file" accept="application/json,.json" onChange={(event) => void importShare(event)} hidden />
          <small>{selected.lifecycle === "draft" && selected.activeConfigVersion != null ? "当前学科草稿版本" : isVmWorkflow ? "当前学科配置版本" : "配置版本"} {selected.configVersion}</small>
          {profileMode && profileEntry?.profile && !isVmWorkflow && <small>草稿版本 {profileEntry.profile.revision}</small>}
          <button
            type="button"
            className="button secondary feishu-refresh-fields"
            disabled={busy || (profileMode && !selectedPackage) || fieldRefreshState === "refreshing"}
            onClick={() => void refreshFields()}
            title="读取当前多维表格的字段和单选项"
          >
            <RefreshIcon color="currentColor" />
            {fieldRefreshState === "refreshing" ? "正在刷新…" : "刷新字段"}
          </button>
        </div>
      </header>
      {fieldRefreshState !== "idle" && <p
        className={`feishu-field-refresh-feedback is-${fieldRefreshState}`}
        role={fieldRefreshState === "failed" ? "alert" : "status"}
        aria-label="字段刷新状态"
      >{fieldRefreshMessage}</p>}
      {courseNamingBindingWarning && courseNamingBindingWarning !== enableBlockedReason
        && <p className="feishu-execution-help" role="status">{courseNamingBindingWarning}</p>}
      {packageListLoadState === "failed" && <div role="alert" aria-label="包列表读取状态">
        <span>无法读取 Auto-Cut 包列表，请重试。</span>
        <button type="button" className="button secondary" disabled={busy} onClick={() => {
          setPackageListLoadState("loading");
          setPackageListRetryRevision((revision) => revision + 1);
        }}>重试读取包列表</button>
      </div>}
      <fieldset className="feishu-config-card feishu-package-route feishu-package-context" disabled={busy}>
        <legend>Auto-Cut 路由</legend>
        <div className="feishu-package-context-grid"><label>Auto-Cut 包<select value={missingSelectedPackage ? "" : editingAlias} onChange={(event) => selectPackage(event.target.value)}>
          {!selectedPackage && editingAlias && packageListLoadState !== "ready" && <option disabled value={editingAlias}>{editingAlias}（{packageListLoadState === "loading" ? "读取中" : "待重试"}）</option>}
          <option value="">未选择包</option>
          {(packageOptions ?? [])
            .map((item) => <option key={item.alias} value={item.alias}>{packageDisplayName(item)}</option>)}
        </select></label>
        {profileMode && <div className="feishu-package-status">
          <p aria-label="当前编辑流程">当前编辑包：{missingSelectedPackage ? "未选择" : editingAlias || "未选择"}（草稿）</p>
          <p aria-label="当前生效流程">当前生效包：{selected.activePackageAlias ?? (selected.lifecycle === "enabled" ? selected.packageRoute?.packageAlias : null) ?? "无"}
            {selected.activeConfigVersion != null ? ` · 配置版本 ${selected.activeConfigVersion}` : ""}</p>
          {selected.lifecycle === "draft" && selected.activeConfigVersion != null
            && <p>当前生效版本仍在运行；草稿需重新启用后才会替换。</p>}
        </div>}
        </div>
        {profileMode && anyDirty && <small className="feishu-package-dirty-hint">有尚未保存的修改。切换包或学科可恢复，离开此页前请保存。</small>}
      </fieldset>
      {workflowUnknown ? <p role="alert">此包的工作流程版本暂不支持，请重新选择包。</p> : isVmWorkflow ? <FeishuVmPmoWorkflowEditor key={`${profileKey}:${vmImportRevision}`}
        subjectKey={selected.subjectKey} packageAlias={editingAlias} fields={triggerFields} workflowTemplate={workflowTemplate}
        vmPmoInitialReady={vmPmoInitialReady} packageEnabled={selectedPackage?.state === "enabled"}
        subjectConfigVersion={Math.max(selected.configVersion, refreshedSubjectVersions.current.get(selected.subjectKey) ?? selected.configVersion)}
        activationBlocked={busy || fieldRefreshState === "refreshing"} onEnabled={(subject) => {
          refreshedSubjectVersions.current.set(subject.subjectKey, subject.configVersion);
          onSubjectChange(subject);
        }}
        cache={vmDraftCache.current} onError={reportError} onErrorClear={clearReportedError} onDirtyChange={recordVmCacheChange} onSaved={recordSavedVmDraft} /> : <>
      {profileMode && selectedPackage && !profileEntry?.form && !profileEntry?.error && <p role="status">正在读取流程草稿…</p>}
      {profileMode && profileEntry?.error && <div role="alert"><p>{profileEntry.error}</p><button type="button" disabled={busy} onClick={reloadProfile}>重新加载流程草稿</button></div>}
      {profileMode && packageListLoadState === "loading" && <p role="status">正在读取本机 Auto-Cut 包…</p>}
      {profileMode && packageListLoadState === "ready" && !selectedPackage && <p role="status">{editingAlias
        ? `此学科旧配置引用的包 ${editingAlias} 已不在当前包列表中。请在「Auto-Cut 包」中重新选择，再编辑和保存流程草稿。`
        : "请先选择可用的 Auto-Cut 包，再编辑和保存流程草稿。"}</p>}
      {profileEditorReady && <>
      <div className="feishu-settings-tabs" role="tablist" aria-label="学科配置分区">
        {SETTINGS_TABS.map((tab, index) => <button
          key={tab.id}
          ref={(element) => { settingsTabRefs.current[index] = element; }}
          id={settingsTabDomId(tab.id)}
          className={activeSettingsTab === tab.id ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={activeSettingsTab === tab.id}
          aria-controls={settingsPanelDomId(tab.id)}
          tabIndex={activeSettingsTab === tab.id ? 0 : -1}
          onClick={() => selectSettingsTab(tab.id)}
          onKeyDown={(event) => handleSettingsTabKeyDown(event, tab.id)}
        >{tab.label}</button>)}
      </div>
      {activeSettingsTab === "basics" && <section className="feishu-settings-tabpanel" id={settingsPanelDomId("basics")} role="tabpanel" aria-labelledby={settingsTabDomId("basics")} tabIndex={0}>
        <section className="feishu-execution-settings" aria-label="通用执行设置">
          <div className="feishu-execution-mode-row">
            <span>剪辑模式</span>
            <div className="feishu-execution-mode-control" role="group" aria-label="剪辑模式">
              {(["manual", "automatic"] as const).map((mode) => <button
                key={mode}
                type="button"
                className={subjectForm.executionMode === mode ? "is-active" : ""}
                aria-pressed={subjectForm.executionMode === mode}
                disabled={busy || (!selectedPackage && !onSaveDraft && !onEnable)}
                onClick={() => setSubjectForm({ ...subjectForm, executionMode: mode })}
              >{mode === "manual" ? "手动" : "自动"}</button>)}
            </div>
          </div>
          <div className="feishu-execution-policy-row">
            <span role="status" aria-label="本机自动执行状态">
              {allowAutomaticExecution === true ? "本机自动执行：已开启"
                : allowAutomaticExecution === false ? "本机自动执行：已关闭" : "本机自动执行：状态未知"}
            </span>
            {onOpenLocalSettings && <button className="button secondary" type="button" onClick={onOpenLocalSettings}>本机设置</button>}
          </div>
        </section>
        {!phased && <fieldset className="feishu-config-card" disabled={busy || (!selectedPackage && !onSaveDraft && !onEnable)}>
          <legend>触发配置</legend>
          <div className="feishu-settings-grid">
            <label>触发字段<select value={subjectForm.triggerFieldId} onChange={(event) => selectTriggerField(event.target.value)}>
              {!hasConfiguredTriggerField && <option value={subjectForm.triggerFieldId}>{subjectForm.triggerFieldName}（已有配置）</option>}
              {triggerFields.map((field, index) => <option key={`${field.fieldId}:${index}`} value={field.fieldId}>{field.fieldName}</option>)}
            </select></label>
            <label>可开始值（如待剪辑/待制作）{startValueOptions.length > 0
              ? <select value={startValueSelectValue} onChange={(event) => selectStartValue(event.target.value)}>
                {!configuredStartValueOption && <option value={startValueSelectValue}>{subjectForm.startValue}（已有配置）</option>}
                {startValueOptions.map((option, index) => <option key={`${option.id}:${index}`} value={`option:${option.id}`}>{option.name}</option>)}
              </select>
              : <input value={subjectForm.startValue} onChange={(event) => setSubjectForm({ ...subjectForm, startValue: event.target.value, optionId: null })} />}
            </label>
            <label>卡片标题字段<select value={subjectForm.titleFieldId} onChange={(event) => selectTitleField(event.target.value)}>
              <option value="">使用记录 ID</option>
              {!hasConfiguredTitleField && subjectForm.titleFieldId
                && <option value={subjectForm.titleFieldId}>{subjectForm.titleFieldName}（已有配置）</option>}
              {triggerFields.map((field, index) => <option key={`${field.fieldId}:${index}`} value={field.fieldId}>{field.fieldName}</option>)}
            </select></label>
          </div>
        </fieldset>}
        <div className="feishu-config-card-grid">
          <fieldset className="feishu-config-card" disabled={busy || (!selectedPackage && !onSaveDraft && !onEnable)}>
            <legend>ZIP 与上传</legend>
            <div className="feishu-settings-grid">
              <label>ZIP 获取方式<select value={subjectForm.artifactSourceMode} onChange={(event) => setSubjectForm({ ...subjectForm, artifactSourceMode: event.target.value as SubjectForm["artifactSourceMode"] })}><option value="manual_select">手动选择</option><option value="watch_directory" disabled>监控目录（后续）</option><option value="driver_report">Auto-Cut 上报</option></select></label>
              <label>上传入队<select value={subjectForm.enqueueMode} onChange={(event) => setSubjectForm({ ...subjectForm, enqueueMode: event.target.value as SubjectForm["enqueueMode"] })}><option value="manual">手动</option><option value="automatic">自动</option></select></label>
              <label className="feishu-settings-wide">ZIP 来源根目录<input value={subjectForm.artifactSourcePath} disabled={subjectForm.artifactSourceMode === "manual_select"} onChange={(event) => setSubjectForm({ ...subjectForm, artifactSourcePath: event.target.value })} /></label>
              <label>上传并发数<input type="number" min={1} step={1} value={subjectForm.uploadConcurrency} onChange={(event) => setSubjectForm({ ...subjectForm, uploadConcurrency: event.target.value })} /></label>
              {!phased && <label className="feishu-settings-wide">上传路径<input value={subjectForm.targetPath} onChange={(event) => setSubjectForm({ ...subjectForm, targetPath: event.target.value })} /></label>}
            </div>
          </fieldset>
        </div>
      </section>}
      {activeSettingsTab === "materials" && <section className="feishu-settings-tabpanel" id={settingsPanelDomId("materials")} role="tabpanel" aria-labelledby={settingsTabDomId("materials")} tabIndex={0}>
        {phased && subjectForm.stages ? <section className="feishu-phased-settings feishu-config-card" aria-label="素材与阶段">
          <fieldset className="feishu-config-subsection" disabled={busy || (!selectedPackage && !onSaveDraft && !onEnable)}>
            <legend>字段来源</legend>
            <div className="feishu-settings-grid">
              <label><span>初稿触发字段</span><select aria-label="初稿触发字段" value={subjectForm.statusFieldId} onChange={(event) => selectPhasedField("status", event.target.value)}><option value="">选择单选字段</option>{triggerFields.filter(isSingleSelectField).map((field, index) => <option key={`${field.fieldId}:${index}`} value={field.fieldId}>{field.fieldName}</option>)}</select></label>
              <label><span>审核修改触发字段</span><select aria-label="审核修改触发字段" value={subjectForm.reviewStatusFieldId} onChange={(event) => selectPhasedField("reviewStatus", event.target.value)}><option value="">选择单选字段</option>{triggerFields.filter(isSingleSelectField).map((field, index) => <option key={`${field.fieldId}:${index}`} value={field.fieldId}>{field.fieldName}</option>)}</select></label>
              <label><span>素材文档字段</span><select aria-label="素材文档字段" value={subjectForm.documentFieldId} onChange={(event) => selectPhasedField("document", event.target.value)}><option value="">选择文档字段</option>{metadataFieldOptions.map((field, index) => <option key={`${field.fieldId}:${index}`} value={field.fieldId}>{field.fieldName}</option>)}</select></label>
              <label><span>命名字段</span><select aria-label="命名字段" value={subjectForm.namingFieldId} onChange={(event) => selectPhasedField("naming", event.target.value)}><option value="">选择命名字段</option>{metadataFieldOptions.map((field, index) => <option key={`${field.fieldId}:${index}`} value={field.fieldId}>{field.fieldName}</option>)}</select></label>
            </div>
          </fieldset>
          <div className="feishu-stage-editors">
            {PHASE_IDS.map((stageId) => <FeishuStageEditor
              key={stageId}
              stageId={stageId}
              value={subjectForm.stages![stageId]}
              metadataFields={triggerFields}
              statusOptions={uniqueMetadataField(triggerFields, stageId === "initial" ? subjectForm.statusFieldId : subjectForm.reviewStatusFieldId)?.options ?? []}
              disabled={busy}
              audioDraft={audioDraftsBySubjectRef.current.get(audioCacheKey)?.stages[stageId] ?? audioDraftFromStage(subjectForm.stages![stageId].audio)}
              onChange={(value) => updateStage(stageId, value)}
              onAudioChange={(audio, draft) => updateStageAudio(stageId, audio, draft)}
              validationErrors={phasedValidationErrors.filter((error) => error.startsWith(PHASE_LABELS[stageId]))}
              showArtifactTargetPath={!subjectForm.delivery}
            />)}
          </div>
        </section> : <section className="feishu-config-card feishu-tab-empty" aria-label="素材与阶段"><p>当前单阶段流程没有独立素材与阶段设置。</p></section>}
      </section>}
      {activeSettingsTab === "storage" && <section className="feishu-settings-tabpanel" id={settingsPanelDomId("storage")} role="tabpanel" aria-labelledby={settingsTabDomId("storage")} tabIndex={0}>
        {phased ? <fieldset className="feishu-delivery-settings feishu-config-card" disabled={busy || (!selectedPackage && !onSaveDraft && !onEnable)}>
          <legend>课程目录</legend>
          <label className="feishu-delivery-toggle"><input aria-label="启用固定课程目录交付" type="checkbox" checked={Boolean(subjectForm.delivery)} onChange={(event) => setCourseDeliveryEnabled(event.target.checked)} /><span>使用固定课程目录交付 ZIP</span></label>
          {subjectForm.delivery && <>
            <div className="feishu-settings-grid">
              <label className="feishu-settings-wide"><span>课程交付总路径</span><input aria-label="课程交付总路径" value={subjectForm.delivery.rootPath ?? ""} onChange={(event) => updateDelivery((delivery) => ({ ...delivery, rootPath: event.target.value || null }))} placeholder="例如：W:\\交付根目录" /></label>
               <label><span>课程名称来源</span><select aria-label="课程名称来源" value={subjectForm.delivery.courseNaming.mode} onChange={(event) => updateDelivery((delivery) => ({ ...delivery, courseNaming: { mode: event.target.value as FeishuDeliveryConfig["courseNaming"]["mode"], fieldId: event.target.value === "field" ? delivery.courseNaming.fieldId : null } }))}><option value="reuse_artifact_naming">复用命名字段</option><option value="field">单独指定字段</option></select></label>
               {subjectForm.delivery.courseNaming.mode === "field"
                 ? <label><span>课程名称字段</span><select aria-label="课程名称字段" value={subjectForm.delivery.courseNaming.fieldId ?? ""} onChange={(event) => updateDelivery((delivery) => ({ ...delivery, courseNaming: { mode: "field", fieldId: event.target.value || null } }))}><option value="">选择文本或公式字段</option>{courseNamingFields.map((field) => <option key={field.fieldId} value={field.fieldId}>{field.fieldName}</option>)}</select></label>
                 : <p className="feishu-execution-help">当前复用命名字段：{configuredCourseNamingField?.fieldName ?? "尚未选择"}</p>}
            </div>
            <section className="feishu-delivery-directories" aria-label="自动阶段目录">
              <h4>自动阶段目录</h4>
              <ul>
                {DELIVERY_STAGE_DIRECTORIES.map(({ stageId, name }) => <li key={stageId}>
                  <span>{PHASE_LABELS[stageId]}</span>
                  <code>{name}</code>
                  <small>该阶段 ZIP 上传时创建</small>
                </li>)}
              </ul>
            </section>
            <section className="feishu-delivery-directories" aria-label="课程目录预览">
              <h4>课程目录预览</h4>
              {configuredCourseDirectoryPreview.path
                ? <ul>
                  <li><span>课程目录</span><code>{configuredCourseDirectoryPreview.path}</code></li>
                  {DELIVERY_STAGE_DIRECTORIES.map(({ stageId, name }) => <li key={stageId}>
                    <span>{PHASE_LABELS[stageId]}</span>
                    <code>{`${configuredCourseDirectoryPreview.path}\\${name}`}</code>
                  </li>)}
                  {subjectForm.delivery.finalDirectoryTrigger.enabled && <li>
                    <span>成片</span>
                    <code>{`${configuredCourseDirectoryPreview.path}\\00成片`}</code>
                  </li>}
                </ul>
                : <p>{configuredCourseDirectoryPreview.missingMessage}</p>}
            </section>
            <div className="feishu-delivery-inline-control" role="group" aria-label="成片目录触发">
              <label className="feishu-delivery-toggle"><input aria-label="指定状态进入时创建00成片" type="checkbox" checked={subjectForm.delivery.finalDirectoryTrigger.enabled} onChange={(event) => updateDelivery((delivery) => ({ ...delivery, finalDirectoryTrigger: { ...delivery.finalDirectoryTrigger, enabled: event.target.checked } }))} /><span>指定状态进入时创建 00成片</span></label>
              {subjectForm.delivery.finalDirectoryTrigger.enabled && <>
                <div className="feishu-delivery-inline-fields feishu-settings-grid">
                  <label><span>成片触发字段</span><select aria-label="成片触发字段" value={subjectForm.delivery.finalDirectoryTrigger.fieldId ?? ""} onChange={(event) => { const field = uniqueMetadataField(triggerFields, event.target.value); updateDelivery((delivery) => ({ ...delivery, finalDirectoryTrigger: { ...delivery.finalDirectoryTrigger, fieldId: event.target.value || null, optionId: field?.options?.some((option) => option.id === delivery.finalDirectoryTrigger.optionId) ? delivery.finalDirectoryTrigger.optionId : null } })); }}><option value="">选择已有单选字段</option>{writebackSingleSelectFields.map((field) => <option key={field.fieldId} value={field.fieldId}>{field.fieldName}</option>)}</select></label>
                  <label><span>成片触发选项</span><select aria-label="成片触发选项" value={subjectForm.delivery.finalDirectoryTrigger.optionId ?? ""} disabled={!uniqueMetadataField(triggerFields, subjectForm.delivery.finalDirectoryTrigger.fieldId)} onChange={(event) => updateDelivery((delivery) => ({ ...delivery, finalDirectoryTrigger: { ...delivery.finalDirectoryTrigger, optionId: event.target.value || null } }))}><option value="">选择已有单选选项</option>{(uniqueMetadataField(triggerFields, subjectForm.delivery.finalDirectoryTrigger.fieldId)?.options ?? []).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
                </div>
              </>}
            </div>
          </>}
        </fieldset> : <section className="feishu-config-card feishu-tab-empty" aria-label="存储与目录"><p>固定课程目录仅适用于三个剪辑阶段。</p></section>}
      </section>}
      {activeSettingsTab === "writeback" && <section className="feishu-settings-tabpanel" id={settingsPanelDomId("writeback")} role="tabpanel" aria-labelledby={settingsTabDomId("writeback")} tabIndex={0}>
        {phased && subjectForm.delivery ? <fieldset className="feishu-delivery-settings feishu-config-card" disabled={busy || (!selectedPackage && !onSaveDraft && !onEnable)}>
          <legend>课程目录与阶段回写</legend>
          <div className="feishu-delivery-inline-control" role="group" aria-label="课程目录回写">
            <label className="feishu-delivery-toggle"><input aria-label="回写课程目录" type="checkbox" checked={subjectForm.delivery.coursePathWriteback.enabled} onChange={(event) => updateDelivery((delivery) => ({ ...delivery, coursePathWriteback: { ...delivery.coursePathWriteback, enabled: event.target.checked } }))} /><span>首个 ZIP 成功后回写课程目录</span></label>
            {subjectForm.delivery.coursePathWriteback.enabled && <div className="feishu-delivery-inline-fields feishu-settings-grid"><label><span>课程目录文本字段</span><select aria-label="课程目录文本字段" value={subjectForm.delivery.coursePathWriteback.fieldId ?? ""} onChange={(event) => updateDelivery((delivery) => ({ ...delivery, coursePathWriteback: { ...delivery.coursePathWriteback, fieldId: event.target.value || null } }))}><option value="">选择已有文本字段</option>{writableTextFields.map((field) => <option key={field.fieldId} value={field.fieldId}>{field.fieldName}</option>)}</select></label></div>}
          </div>
          <div className="feishu-delivery-writeback" aria-label="阶段状态回写">
            {PHASE_IDS.map((stageId) => <section className="feishu-delivery-stage" key={stageId} aria-label={`${PHASE_LABELS[stageId]}状态回写`}><h4>{PHASE_LABELS[stageId]}</h4>{renderDeliveryAssignments(stageId, "onProcessing", "处理中")}{renderDeliveryAssignments(stageId, "onUploaded", "ZIP 上传成功")}</section>)}
          </div>
          <section className="feishu-delivery-writeback-preview" aria-label="回写预览">
            <h4>回写预览</h4>
            {configuredWritebackPreview.length > 0
              ? <ul>{configuredWritebackPreview.map((item, index) => <li key={`${item.timing}:${item.fieldName}:${item.value}:${index}`}>
                <span>{item.timing}</span>
                <strong>{item.fieldName}</strong>
                <div><code>{item.value}</code>{item.note && <small>{item.note}</small>}</div>
              </li>)}</ul>
              : <p>尚未配置有效的回写内容。</p>}
          </section>
        </fieldset> : <section className="feishu-config-card feishu-tab-empty" aria-label="飞书回写"><p>请先在存储与目录中启用固定课程目录交付。</p></section>}
      </section>}
      <div className="feishu-subject-actions">
        {(phased && phasedValidationErrors.length > 0 || enableBlockedReason) && <p
          className="feishu-execution-help feishu-subject-action-note" role="status" aria-label="配置待修复项">
          {phased && draftValidationErrors.length > 0
            ? `保存前请修复：${draftValidationErrors[0]}`
            : phased && phasedValidationErrors.length > 0
              ? `可先保存草稿；启用前请补齐：${phasedValidationErrors[0]}`
            : namingFieldTypeWarning
              ? `启用前请修复：${namingFieldTypeWarning}`
              : `启用前请处理：${enableBlockedReason}`}
        </p>}
        <button
          type="submit"
          className="button secondary"
          disabled={busy || fieldRefreshState === "refreshing"
            || (profileMode && (profileBlocked || !profileEditorReady || !subjectForm.packageAlias || !selectedPackage))
            || (phased && draftValidationErrors.length > 0)}
        >保存草稿</button>
        {(profileMode || selected.lifecycle !== "enabled") && <button type="button" className="button primary" disabled={busy || fieldRefreshState === "refreshing" || Boolean(enableBlockedReason)} title={enableBlockedReason} onClick={() => void transition("enable")}>启用</button>}
        {(selected.activeConfigVersion != null || selected.lifecycle === "enabled") && <button type="button" className="button secondary" disabled={busy} onClick={() => void transition("disable")}>停用</button>}
      </div>
      </>}
      </>}
    </form>}
  </section>;
}

export default FeishuWorkflowPanel;
