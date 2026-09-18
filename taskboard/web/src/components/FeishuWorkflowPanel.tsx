import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
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
  exportFeishuWorkflowShare,
  importFeishuWorkflowShare,
  saveFeishuWorkflowDraft,
  setFeishuSubjectDisabled,
  setFeishuSubjectDisplay,
  setFeishuSubjectEnabled,
} from "../feishuWorkflow";
import { listFeishuPackages, refreshFeishuBaseFields } from "../api";
import { RefreshIcon } from "./SemanticIcons";
import { useFeishuConfigurationLayout } from "./useFeishuConfigurationLayout";

export interface FeishuWorkflowPanelProps {
  catalog: FeishuBaseCatalog[];
  configurationBaseToken: string | null;
  selectedSubjectKey: string | null;
  allowAutomaticExecution?: boolean;
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
  onError?: (message: string) => void;
}

function statusLabel(subject: FeishuSubjectConfig): string {
  return subject.lifecycle === "enabled" ? "已启用" : subject.lifecycle === "draft" ? "草稿" : "已停用";
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
  const options = statusField?.options ?? [];
  const existing = subject.stages;
  return Object.fromEntries(PHASE_IDS.map((stageId, index) => {
    const old = existing?.[stageId];
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
        fieldId: statusField?.fieldId ?? subject.trigger?.fieldId ?? null,
        fieldName: statusField?.fieldName ?? subject.trigger?.fieldName ?? null,
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

function audioDraftsForStages(stages: FeishuStageConfigMap | null): SubjectAudioDrafts["stages"] {
  if (!stages) return {};
  return Object.fromEntries(PHASE_IDS.map((stageId) => [
    stageId,
    audioDraftFromStage(stages[stageId].audio),
  ])) as SubjectAudioDrafts["stages"];
}

function emptyDeliveryConfig(namingFieldId: string | null = null): FeishuDeliveryConfig {
  return {
    version: 1,
    rootPath: null,
    courseNaming: { mode: "field", fieldId: namingFieldId },
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

function formForSubject(subject: FeishuSubjectConfig): SubjectForm {
  const fields = subject.metadata?.fields ?? [];
  const triggerField = uniqueMetadataField(fields, subject.trigger?.fieldId);
  const triggerOption = uniqueMetadataOption(triggerField, subject.trigger?.optionId);
  const legacyStatusField = !subject.statusField && triggerField && isSingleSelectField(triggerField)
    ? { fieldId: triggerField.fieldId, fieldName: triggerField.fieldName }
    : undefined;
  const statusField = subject.statusField ?? legacyStatusField;
  const documentField = subject.documentField;
  const namingField = subject.namingField;
  return reconcileFormMetadata({
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
    documentFieldId: documentField?.fieldId ?? "",
    documentFieldName: documentField?.fieldName ?? "",
    namingFieldId: namingField?.fieldId ?? "",
    namingFieldName: namingField?.fieldName ?? "",
    stages: (subject.stages || statusField || documentField || namingField || fields.length > 0)
      ? stageDefaults(subject, fields)
      : null,
    delivery: subject.delivery ? structuredClone(subject.delivery) : null,
  }, fields);
}

function reconcileFormMetadata(
  form: SubjectForm,
  fields: FeishuFieldMetadata[],
  previousFields: FeishuFieldMetadata[] = [],
): SubjectForm {
  const triggerField = uniqueMetadataField(fields, form.triggerFieldId);
  const triggerOption = uniqueMetadataOption(triggerField, form.optionId);
  const statusField = uniqueMetadataField(fields, form.statusFieldId);
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
  return [subject.statusField, subject.documentField, subject.namingField].some(descriptorIsStale)
    || Object.values(subject.stages ?? {}).some((stage) => {
      if (descriptorIsStale(stage.trigger)) return true;
      const field = uniqueMetadataField(fields, stage.trigger.fieldId);
      const option = uniqueMetadataOption(field, stage.trigger.optionId);
      return Boolean(option && stage.trigger.value !== option.name);
    });
}

function shareImportConfirmation(diagnostics: FeishuWorkflowShareDiagnostic[]): string {
  const warnings = diagnostics.filter((entry) => entry.severity !== "info");
  if (warnings.length === 0) {
    return "共享配置校验通过，导入后所有子表仍保持草稿状态。继续吗？";
  }
  const details = warnings.slice(0, 8).map((entry) => {
    const severity = entry.severity === "error" ? "错误" : "警告";
    return `- ${severity} [${entry.code}] ${entry.message}`;
  });
  if (warnings.length > details.length) {
    details.push(`- 还有 ${warnings.length - details.length} 项未显示`);
  }
  return `共享配置校验发现 ${warnings.length} 个需要确认的问题：\n\n${details.join("\n")}\n\n仍要导入为草稿吗？`;
}

export function FeishuWorkflowPanel({
  catalog,
  configurationBaseToken,
  selectedSubjectKey,
  allowAutomaticExecution,
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
}: FeishuWorkflowPanelProps) {
  const layout = useFeishuConfigurationLayout(!compact);
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldRefreshState, setFieldRefreshState] = useState<"idle" | "refreshing" | "succeeded" | "failed">("idle");
  const [fieldRefreshMessage, setFieldRefreshMessage] = useState("");
  const [packageOptions, setPackageOptions] = useState<FeishuPackageSummary[] | null>(null);
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
  const selectedEditableSignature = selected ? editableSubjectSignature(selected) : null;
  const selectedMetadataOwnedSignature = selected ? metadataOwnedSignature(selected) : null;
  const [subjectForm, setSubjectForm] = useState<SubjectForm | null>(() => selected ? formForSubject(selected) : null);
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
    && (JSON.stringify(subjectForm) !== JSON.stringify(formForSubject(selected))
      || phasedFieldNamesNeedRefresh(selected)
      || metadataRefreshNeedsSaveRef.current.get(selected.subjectKey) === selected.configVersion));
  const selectedPackage = packageOptions?.find((item) => item.alias === subjectForm?.packageAlias);
  const visibleSubjects = (base: FeishuBaseCatalog) => base.subjects.filter((subject) => subject.displayEnabled);
  const hiddenSubjects = (base: FeishuBaseCatalog) => base.subjects.filter((subject) => !subject.displayEnabled);
  const triggerFields = selected ? selected.metadata?.fields ?? [] : [];
  const phased = Boolean(subjectForm?.stages);
  const selectedStatusField = subjectForm
    ? uniqueMetadataField(triggerFields, subjectForm.statusFieldId)
    : undefined;
  const statusOptions = selectedStatusField?.options ?? [];
  const metadataFieldOptions = triggerFields;
  const courseNamingFields = metadataFieldOptions.filter(isCourseNamingField);
  const writableTextFields = metadataFieldOptions.filter(isWritableTextField);
  const writebackSingleSelectFields = metadataFieldOptions.filter(isSingleSelectField);
  const configuredCourseNamingField = subjectForm?.delivery
    ? uniqueMetadataField(triggerFields, subjectForm.delivery.courseNaming.fieldId)
    : undefined;
  const configuredCourseDirectoryPreview = courseDirectoryPreview(
    subjectForm?.delivery?.rootPath,
    configuredCourseNamingField,
  );
  const configuredWritebackPreview = subjectForm?.delivery
    ? deliveryWritebackPreview(subjectForm.delivery, triggerFields, configuredCourseNamingField)
    : [];
  const phasedValidationErrors = useMemo(() => {
    if (!subjectForm?.stages) return [];
    const errors: string[] = [];
    const enabledStages = PHASE_IDS.filter((stageId) => subjectForm.stages?.[stageId]?.enabled);
    if (enabledStages.length === 0) errors.push("至少启用一个阶段");
    const optionIds = enabledStages
      .map((stageId) => subjectForm.stages?.[stageId]?.trigger.optionId)
      .filter((value): value is string => Boolean(value));
    if (new Set(optionIds).size !== optionIds.length) errors.push("已启用阶段的触发选项不能重复");
    for (const stageId of PHASE_IDS) {
      const stage = subjectForm.stages[stageId];
      if (!stage) continue;
      const phaseLabel = PHASE_LABELS[stageId];
      if (stage.enabled && (!stage.trigger.optionId || !stage.trigger.value)) errors.push(`${phaseLabel}需要触发选项`);
      if (stage.enabled && stage.trigger.optionId) {
        const matches = statusOptions.filter((option) => option.id === stage.trigger.optionId);
        if (matches.length === 0) errors.push(`${phaseLabel}的触发选项当前不可用`);
        else if (matches.length > 1) errors.push(`${phaseLabel}的触发选项不唯一`);
      }
      if (stage.videoSource.kind === "docx_section" && !stage.videoSource.anchorText?.trim()) errors.push(`${phaseLabel}需要视频目录标题`);
      if (stage.enabled && stage.trigger.fieldId !== subjectForm.statusFieldId) errors.push(`${phaseLabel}的触发字段与状态字段不一致`);
      if (stage.videoSource.kind === "base_attachment") {
        if (!stage.videoSource.fieldId) errors.push(`${phaseLabel}需要视频附件字段`);
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
          if (!stage.audio.source.fieldId) errors.push(`${phaseLabel}需要音频附件字段`);
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
    if (!subjectForm.statusFieldId) errors.push("请选择状态字段");
    else if (metadataFieldMatches(triggerFields, subjectForm.statusFieldId).length !== 1) errors.push("状态字段当前不可用或不唯一");
    if (!subjectForm.documentFieldId) errors.push("请选择素材文档字段");
    else if (metadataFieldMatches(triggerFields, subjectForm.documentFieldId).length === 0) errors.push("素材文档字段当前不可用");
    else if (metadataFieldMatches(triggerFields, subjectForm.documentFieldId).length > 1) errors.push("素材文档字段不唯一");
    if (!subjectForm.namingFieldId) errors.push("请选择命名字段");
    else if (metadataFieldMatches(triggerFields, subjectForm.namingFieldId).length === 0) errors.push("命名字段当前不可用");
    else if (metadataFieldMatches(triggerFields, subjectForm.namingFieldId).length > 1) errors.push("命名字段不唯一");
    return [...new Set(errors)];
  }, [subjectForm, triggerFields]);
  const enableBlockedReason = subjectFormDirty
    ? "请先保存草稿"
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
    const preserveDirtyForm = Boolean(selected && preserveDirtyFormForSubjectRef.current === selected.subjectKey);
    preserveDirtyFormForSubjectRef.current = null;
    if (!selected) {
      previousSelectedRef.current = null;
      setSubjectForm(null);
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
    setSubjectForm((current) => {
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
  ]);

  useEffect(() => {
    let active = true;
    void listFeishuPackages()
      .then((packages) => { if (active) setPackageOptions(packages); })
      .catch((error) => {
        if (active) {
          setPackageOptions([]);
          onError?.(error instanceof Error ? error.message : "无法加载 Auto-Cut 包");
        }
      });
    return () => { active = false; };
  }, []);

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

  function selectPhasedField(kind: "status" | "document" | "naming", fieldId: string) {
    if (!subjectForm) return;
    const field = triggerFields.find((candidate) => candidate.fieldId === fieldId);
    if (!field) return;
    if (kind === "status") {
      const option = field.options?.[0] ?? null;
      const stages = subjectForm.stages
        ? Object.fromEntries(PHASE_IDS.map((stageId, index) => {
          const current = subjectForm.stages?.[stageId];
          return [stageId, current ? {
            ...current,
            trigger: {
              ...current.trigger,
              fieldId: field.fieldId,
              fieldName: field.fieldName,
              ...(current.trigger.optionId && field.options?.some((candidate) => candidate.id === current.trigger.optionId)
                ? {}
                : { optionId: field.options?.[index]?.id ?? option?.id ?? null, value: field.options?.[index]?.name ?? option?.name ?? "" }),
            },
          } : current];
        })) as FeishuStageConfigMap
        : null;
      setSubjectForm({ ...subjectForm, statusFieldId: field.fieldId, statusFieldName: field.fieldName, stages });
      return;
    }
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
      delivery: enabled ? (subjectForm.delivery ?? emptyDeliveryConfig(subjectForm.namingFieldId || null)) : null,
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
    const cached = audioDraftsBySubjectRef.current.get(selected.subjectKey) ?? {
      configVersion: selected.configVersion,
      stages: {},
    };
    audioDraftsBySubjectRef.current.set(selected.subjectKey, {
      ...cached,
      stages: { ...cached.stages, [stageId]: draft },
    });
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
      onError?.(error instanceof Error ? error.message : "无法读取多维表格");
    } finally { setBusy(false); }
  }

  async function saveDraft() {
    if (!selected || !subjectForm) return;
    setBusy(true);
    try {
      const firstEnabledStage = subjectForm.stages
        ? PHASE_IDS.map((stageId) => subjectForm.stages?.[stageId]).find((stage) => stage?.enabled)
        : undefined;
      const patch = {
        expectedVersion: selected.configVersion,
        trigger: {
          ...selected.trigger,
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
          ...selected.execution,
          mode: subjectForm.executionMode,
        },
        packageRoute: {
          ...selected.packageRoute,
          packageAlias: subjectForm.packageAlias,
        },
        upload: {
          ...selected.upload,
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
          documentField: { fieldId: subjectForm.documentFieldId || null, fieldName: subjectForm.documentFieldName || null },
          namingField: { fieldId: subjectForm.namingFieldId || null, fieldName: subjectForm.namingFieldName || null },
          stages: subjectForm.stages,
        } : {}),
        ...(subjectForm.stages ? { delivery: subjectForm.delivery } : {}),
      };
      const subject = await (onSaveDraft ? onSaveDraft(selected.subjectKey, patch) : saveFeishuWorkflowDraft(selected.subjectKey, patch));
      if (subject) {
        metadataRefreshNeedsSaveRef.current.delete(selected.subjectKey);
        setMetadataRefreshRevision((value) => value + 1);
        onSubjectChange(subject);
      }
    }
    catch (error) { onError?.(error instanceof Error ? error.message : "无法保存草稿"); }
    finally { setBusy(false); }
  }

  async function transition(action: "enable" | "disable") {
    if (!selected) return;
    const preserveDirtyForm = action === "disable" && subjectFormDirty;
    setBusy(true);
    try {
      const subject = await (action === "enable"
        ? (onEnable ? onEnable(selected) : setFeishuSubjectEnabled(selected))
        : (onDisable ? onDisable(selected) : setFeishuSubjectDisabled(selected)));
      if (subject) {
        if (preserveDirtyForm) preserveDirtyFormForSubjectRef.current = subject.subjectKey;
        onSubjectChange(subject);
      }
    }
    catch (error) { onError?.(error instanceof Error ? error.message : "无法更新状态"); }
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
      onError?.(error instanceof Error ? error.message : "无法更新显示设置");
    } finally { setBusy(false); }
  }

  async function exportShare() {
    setBusy(true);
    try {
      const configuration = await exportFeishuWorkflowShare();
      const blob = new Blob([`${JSON.stringify(configuration, null, 2)}\n`], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = "feishu-workflow-share.json";
      link.click();
      URL.revokeObjectURL(href);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "无法导出共享配置");
    } finally { setBusy(false); }
  }

  async function importShare(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const configuration = JSON.parse(await file.text());
      const preview = await importFeishuWorkflowShare(configuration, true);
      const summary = shareImportConfirmation(preview.diagnostics);
      if (typeof window !== "undefined" && !window.confirm(summary)) return;
      const imported = await importFeishuWorkflowShare(configuration, false);
      if (imported.catalog) {
        onCatalogChange(imported.catalog);
        onShareImported?.(imported.catalog);
      }
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "无法导入共享配置");
    } finally { setBusy(false); }
  }

  async function refreshFields() {
    if (!selected || fieldRefreshState === "refreshing") return;
    const baseToken = selected.baseToken;
    setFieldRefreshState("refreshing");
    setFieldRefreshMessage("");
    try {
      const refreshed = await refreshFeishuBaseFields(baseToken);
      const current = catalogRef.current;
      if (current.some((base) => base.baseToken === baseToken)) {
        onCatalogChange(current.map((base) => base.baseToken === baseToken ? refreshed : base));
      }
      setFieldRefreshState("succeeded");
      setFieldRefreshMessage("字段刷新成功，可直接选择新增字段或单选项。");
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
    <div className="feishu-workflow-add">
      {!compact && <>
        <input aria-label="多维表格链接" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="粘贴多维表格链接" />
        <button type="button" onClick={() => void addBase()} disabled={busy || !baseUrl.trim()}>新增多维表格</button>
        <button type="button" onClick={() => void exportShare()} disabled={busy}>导出共享配置</button>
        <button type="button" onClick={() => shareFileRef.current?.click()} disabled={busy}>导入共享配置</button>
        <input ref={shareFileRef} type="file" accept="application/json,.json" onChange={(event) => void importShare(event)} hidden />
      </>}
      {compact && <>
        <strong className="feishu-workflow-current-label">{selected ? `${selected.baseName} / ${selected.tableName}` : "选择学科"}</strong>
        <button type="button" onClick={onOpenConfiguration}>配置多维表格</button>
      </>}
    </div>
    <div className="feishu-workflow-catalog" id="feishu-subject-catalog">
      {scopedCatalog.map((base) => <div className="feishu-base" key={base.baseToken}>
        <h3>{base.baseName}</h3>
        <h4>已显示子表</h4>
        {visibleSubjects(base).map((subject) => <div className="feishu-subject-row" key={subject.subjectKey}>
          <button
            type="button"
            className={subject.subjectKey === selectedSubjectKey ? "active" : ""}
            onClick={() => onSelectSubject(subject.subjectKey, true)}
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
    {!compact && selected && subjectForm && <form className="feishu-subject-settings" role="region" aria-label="学科配置" onSubmit={(event) => { event.preventDefault(); void saveDraft(); }}>
      <header className="feishu-subject-settings-header">
        <div>
          <div>
            <h3>{selected.tableName}学科配置</h3>
            <p>{selected.baseName} · {phased ? "三个剪辑阶段" : "单阶段剪辑流程"}</p>
          </div>
          <span data-lifecycle={selected.lifecycle}>{statusLabel(selected)}</span>
        </div>
        <div className="feishu-subject-settings-header-actions">
          <small>配置版本 {selected.configVersion}</small>
          <button
            type="button"
            className="button secondary feishu-refresh-fields"
            disabled={busy || fieldRefreshState === "refreshing"}
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
        <fieldset className="feishu-config-card" disabled={busy}>
          <legend>通用执行设置</legend>
          <div className="feishu-settings-grid">
            <label>剪辑模式<select value={subjectForm.executionMode} onChange={(event) => setSubjectForm({ ...subjectForm, executionMode: event.target.value as SubjectForm["executionMode"] })}><option value="manual">手动</option><option value="automatic">自动</option></select></label>
          </div>
          <p className="feishu-execution-help">剪辑模式适用于当前学科{phased ? "的初稿、初审修改和终审修改三个阶段" : ""}。修改后先保存草稿，再点击启用生效；上传入队单独设置。</p>
          <p className="feishu-execution-help" role="status" aria-label="本机自动执行总开关">
            {allowAutomaticExecution === true
              ? "本机自动执行总开关：已开启。学科启用后，新触发的合格任务可按自动模式执行。"
              : allowAutomaticExecution === false
                ? "本机自动执行总开关：已关闭。即使选择自动，也不会自动启动任务，需手动开始。"
                : "本机自动执行总开关：状态未知。暂时无法确认是否允许自动启动任务。"}
          </p>
          {onOpenLocalSettings && <button className="button secondary" type="button" onClick={onOpenLocalSettings}>修改本机总开关</button>}
        </fieldset>
        {!phased && <fieldset className="feishu-config-card" disabled={busy}>
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
          <fieldset className="feishu-config-card" disabled={busy}>
            <legend>Auto-Cut 路由</legend>
            <div className="feishu-settings-grid">
              <label className="feishu-settings-wide">Auto-Cut 包<select value={subjectForm.packageAlias} onChange={(event) => setSubjectForm({ ...subjectForm, packageAlias: event.target.value })}>
                {!selectedPackage && subjectForm.packageAlias && <option value={subjectForm.packageAlias}>{subjectForm.packageAlias}（不可用）</option>}
                <option value="">未选择包</option>
                {(packageOptions ?? []).filter((item) => item.state === "enabled").map((item) => <option key={item.alias} value={item.alias}>{item.name}（{item.alias}）</option>)}
              </select></label>
            </div>
          </fieldset>
          <fieldset className="feishu-config-card" disabled={busy}>
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
          <fieldset className="feishu-config-subsection" disabled={busy}>
            <legend>字段来源</legend>
            <div className="feishu-settings-grid">
              <label><span>状态字段</span><select aria-label="状态字段" value={subjectForm.statusFieldId} onChange={(event) => selectPhasedField("status", event.target.value)}><option value="">选择单选状态字段</option>{triggerFields.filter(isSingleSelectField).map((field, index) => <option key={`${field.fieldId}:${index}`} value={field.fieldId}>{field.fieldName}</option>)}</select></label>
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
              statusOptions={statusOptions}
              disabled={busy}
              audioDraft={audioDraftsBySubjectRef.current.get(selected.subjectKey)?.stages[stageId] ?? audioDraftFromStage(subjectForm.stages![stageId].audio)}
              onChange={(value) => updateStage(stageId, value)}
              onAudioChange={(audio, draft) => updateStageAudio(stageId, audio, draft)}
              validationErrors={phasedValidationErrors.filter((error) => error.startsWith(PHASE_LABELS[stageId]))}
              showArtifactTargetPath={!subjectForm.delivery}
            />)}
          </div>
        </section> : <section className="feishu-config-card feishu-tab-empty" aria-label="素材与阶段"><p>当前单阶段流程没有独立素材与阶段设置。</p></section>}
      </section>}
      {activeSettingsTab === "storage" && <section className="feishu-settings-tabpanel" id={settingsPanelDomId("storage")} role="tabpanel" aria-labelledby={settingsTabDomId("storage")} tabIndex={0}>
        {phased ? <fieldset className="feishu-delivery-settings feishu-config-card" disabled={busy}>
          <legend>课程目录</legend>
          <label className="feishu-delivery-toggle"><input aria-label="启用固定课程目录交付" type="checkbox" checked={Boolean(subjectForm.delivery)} onChange={(event) => setCourseDeliveryEnabled(event.target.checked)} /><span>使用固定课程目录交付 ZIP</span></label>
          {subjectForm.delivery && <>
            <div className="feishu-settings-grid">
              <label className="feishu-settings-wide"><span>课程交付总路径</span><input aria-label="课程交付总路径" value={subjectForm.delivery.rootPath ?? ""} onChange={(event) => updateDelivery((delivery) => ({ ...delivery, rootPath: event.target.value || null }))} placeholder="例如：W:\\交付根目录" /></label>
              <label><span>课程名称字段</span><select aria-label="课程名称字段" value={subjectForm.delivery.courseNaming.fieldId ?? ""} onChange={(event) => updateDelivery((delivery) => ({ ...delivery, courseNaming: { mode: "field", fieldId: event.target.value || null } }))}><option value="">选择文本或公式字段</option>{courseNamingFields.map((field) => <option key={field.fieldId} value={field.fieldId}>{field.fieldName}</option>)}</select></label>
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
        {phased && subjectForm.delivery ? <fieldset className="feishu-delivery-settings feishu-config-card" disabled={busy}>
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
        <button type="submit" className="button secondary" disabled={busy || (phased && phasedValidationErrors.length > 0)}>保存草稿</button>
        {selected.lifecycle !== "enabled" && <button type="button" className="button primary" disabled={busy || Boolean(enableBlockedReason)} title={enableBlockedReason} onClick={() => void transition("enable")}>启用</button>}
        {(selected.activeConfigVersion != null || selected.lifecycle === "enabled") && <button type="button" className="button secondary" disabled={busy} onClick={() => void transition("disable")}>停用</button>}
      </div>
    </form>}
  </section>;
}

export default FeishuWorkflowPanel;
