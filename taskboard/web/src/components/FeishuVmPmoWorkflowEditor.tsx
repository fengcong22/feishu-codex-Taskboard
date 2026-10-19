import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ApiError, enableFeishuPackageWorkflowDraft, getFeishuPackageWorkflowDraft, saveFeishuPackageWorkflowDraft } from "../api";
import type { FeishuFieldMetadata, FeishuPackageWorkflowDraft, FeishuPackageWorkflowTemplate, FeishuSubjectConfig, FeishuVmPmoFinalArchiveConfig, FeishuVmPmoStageId, FeishuVmPmoWorkflowConfig, FeishuVmPmoWritebackTarget } from "../types";
import { isAttachmentField, isSingleSelectField } from "./FeishuStageEditor";

type VmPmoDraftEntry = {
  profile: FeishuPackageWorkflowDraft | null;
  config: FeishuVmPmoWorkflowConfig | null;
  error?: string | null;
  recoveredError?: string | null;
  conflict?: boolean;
  loading?: boolean;
  reloading?: boolean;
  saving?: boolean;
  enabling?: boolean;
  enabled?: boolean;
  saved?: boolean;
};
export type VmPmoDraftCache = Map<string, VmPmoDraftEntry>;
type Props = {
  subjectKey: string;
  packageAlias: string;
  fields: FeishuFieldMetadata[];
  cache: VmPmoDraftCache;
  workflowTemplate?: FeishuPackageWorkflowTemplate;
  vmPmoInitialReady?: boolean;
  packageEnabled?: boolean;
  subjectConfigVersion?: number;
  activationBlocked?: boolean;
  onError?: (message: string) => void;
  onErrorClear?: (message?: string) => void;
  /** Includes unsaved changes in other VM profiles retained by this cache. */
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: (profile: FeishuPackageWorkflowDraft) => void;
  onEnabled?: (subject: FeishuSubjectConfig) => void;
};
const VM_TEMPLATE = { id: "vm_pmo_review_video", version: 1 } as const;
const EMPTY_ENTRY: VmPmoDraftEntry = { profile: null, config: null };
const EMPTY_FINAL_ARCHIVE: FeishuVmPmoFinalArchiveConfig = {
  enabled: false, statusFieldId: null, triggerOptionId: null,
  pathSource: "manual", directoryPath: null, pathFieldId: null,
};
const cacheListeners = new WeakMap<VmPmoDraftCache, Set<() => void>>();
const STAGES: Array<[FeishuVmPmoStageId, string]> = [["initial", "初稿"], ["review", "审核修改"]];
const SETTINGS_TABS = [
  { id: "basics", label: "基础与执行" },
  { id: "materials", label: "素材与阶段" },
  { id: "storage", label: "存储与目录" },
  { id: "writeback", label: "飞书回写" },
] as const;
type SettingsTabId = typeof SETTINGS_TABS[number]["id"];

function isDirty(entry: VmPmoDraftEntry | undefined): boolean {
  return Boolean(entry?.profile && entry.config
    && JSON.stringify(entry.config) !== JSON.stringify(entry.profile.config));
}

function cacheIsDirty(cache: VmPmoDraftCache): boolean {
  return [...cache.values()].some(isDirty);
}

function writeCache(cache: VmPmoDraftCache, key: string, entry: VmPmoDraftEntry) {
  cache.set(key, entry);
  cacheListeners.get(cache)?.forEach((notify) => notify());
}

function message(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "VERSION_CONFLICT") return "草稿已被其他窗口修改。请重新加载后再保存。";
    if (error.code === "INVALID_FIELD") return "配置不完整或无效，请检查字段、选项和归档路径。";
    if (error.code === "UNKNOWN_FIELD") return "流程草稿格式已过期或包含未知配置项，请重新加载最新草稿并核对后保存。";
    if (error.code === "PACKAGE_WORKFLOW_DRAFT_UNSUPPORTED") return "此包暂不支持该流程，请重新选择包。";
    if (error.code === "PACKAGE_WORKFLOW_NOT_READY") return "本机初稿运行能力尚未就绪，请检查运行配置后重试。";
    if (error.code === "PACKAGE_DISABLED") return "请先在剪辑包管理中启用当前包。";
    if (error.code === "VM_WORKFLOW_NOT_READY") return "当前仅支持完整配置的初稿流程，请关闭审核修改和成片归档并检查必填字段。";
  }
  return "流程草稿读取或保存失败，请重试。";
}

function textField(field: FeishuFieldMetadata) {
  const hasType = field.type !== null && field.type !== undefined && field.type !== "";
  const hasUiType = field.uiType !== null && field.uiType !== undefined && field.uiType !== "";
  if (!hasType && !hasUiType) return false;
  return (!hasType || field.type === 1 || field.type === "1")
    && (!hasUiType || typeof field.uiType === "string" && field.uiType.trim().toLowerCase() === "text");
}

function namingField(field: FeishuFieldMetadata) {
  if (textField(field)) return true;
  const hasType = field.type !== null && field.type !== undefined && field.type !== "";
  const hasUiType = field.uiType !== null && field.uiType !== undefined && field.uiType !== "";
  if (!hasType && !hasUiType) return false;
  return (!hasType || field.type === 20 || field.type === "20")
    && (!hasUiType || typeof field.uiType === "string" && field.uiType.trim().toLowerCase() === "formula");
}

function multiSelectField(field: FeishuFieldMetadata) {
  const hasType = field.type !== null && field.type !== undefined && field.type !== "";
  const hasUiType = field.uiType !== null && field.uiType !== undefined && field.uiType !== "";
  if (!hasType && !hasUiType) return false;
  return (!hasType || field.type === 4 || field.type === "4")
    && (!hasUiType || typeof field.uiType === "string" && field.uiType.trim().toLowerCase().replace(/[\s_-]/gu, "") === "multiselect");
}

function progressField(field: FeishuFieldMetadata) {
  return isSingleSelectField(field) || multiSelectField(field);
}

export function FeishuVmPmoWorkflowEditor({ subjectKey, packageAlias, fields, cache, workflowTemplate = VM_TEMPLATE,
  vmPmoInitialReady = false, packageEnabled = false, subjectConfigVersion, activationBlocked = false,
  onError, onErrorClear, onDirtyChange, onSaved, onEnabled }: Props) {
  const key = JSON.stringify([subjectKey, packageAlias, workflowTemplate.id, workflowTemplate.version]);
  const [cacheRevision, setCacheRevision] = useState(0);
  const [reload, setReload] = useState(0);
  const [activeTab, setActiveTab] = useState<SettingsTabId>("basics");
  const tabIdPrefix = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const callbacks = useRef({ onError, onErrorClear, onDirtyChange, onSaved, onEnabled });
  callbacks.current = { onError, onErrorClear, onDirtyChange, onSaved, onEnabled };
  const mounted = useRef(false);
  const activeKey = useRef(key);
  activeKey.current = key;
  const entry = cache.get(key) ?? EMPTY_ENTRY;
  const { profile, config, saving, enabling, error, saved } = entry;
  const loading = !cache.has(key) || entry.loading;

  useEffect(() => {
    mounted.current = true;
    let listeners = cacheListeners.get(cache);
    if (!listeners) { listeners = new Set(); cacheListeners.set(cache, listeners); }
    const notify = () => setCacheRevision((value) => value + 1);
    listeners.add(notify);
    return () => { mounted.current = false; listeners.delete(notify); };
  }, [cache]);

  useEffect(() => { onDirtyChange?.(cacheIsDirty(cache)); }, [cache, cacheRevision, onDirtyChange]);

  useEffect(() => {
    const current = cache.get(key);
    if (!mounted.current || activeKey.current !== key || !current?.recoveredError) return;
    // A pending save can complete after this profile remounts or while it is away.
    // Consume its recovery before notifying the host so a later identical error survives.
    cache.set(key, { ...current, recoveredError: null });
    callbacks.current.onErrorClear?.(current.recoveredError);
  }, [cache, key, cacheRevision]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!cacheIsDirty(cache)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [cache]);

  function validProfile(next: FeishuPackageWorkflowDraft): boolean {
    return next.subjectKey === subjectKey && next.packageAlias === packageAlias
      && next.workflowTemplate?.id === workflowTemplate.id
      && next.workflowTemplate?.version === workflowTemplate.version
      && next.workflowTemplate.id === VM_TEMPLATE.id && next.workflowTemplate.version === VM_TEMPLATE.version;
  }

  useEffect(() => {
    const previous = cache.get(key);
    if (previous && !previous.reloading) return;
    const previousError = previous?.error;
    const controller = new AbortController();
    writeCache(cache, key, { ...EMPTY_ENTRY, loading: true, error: previousError });
    void getFeishuPackageWorkflowDraft(subjectKey, packageAlias, controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      if (!validProfile(next)) throw new Error("invalid profile");
      writeCache(cache, key, { profile: next, config: structuredClone(next.config), recoveredError: previousError });
    }).catch((failure) => {
      if (!controller.signal.aborted) {
        const safeMessage = message(failure);
        writeCache(cache, key, { ...EMPTY_ENTRY, error: safeMessage });
        callbacks.current.onError?.(safeMessage);
      }
    });
    return () => {
      controller.abort();
      if (cache.get(key)?.loading) {
        if (previous) writeCache(cache, key, { ...previous, loading: false, reloading: false });
        else cache.delete(key);
      }
    };
  }, [cache, key, reload]);

  function update(next: FeishuVmPmoWorkflowConfig) {
    const latest = cache.get(key);
    if (!latest?.profile) return;
    writeCache(cache, key, { ...latest, config: next, saved: false, enabled: false });
  }
  async function save() {
    const current = cache.get(key);
    if (!current?.profile || !current.config || current.saving || current.enabling || current.loading || current.conflict) return;
    const submittedConfig = current.config;
    writeCache(cache, key, { ...current, config: submittedConfig, saving: true, error: null, recoveredError: null, saved: false });
    try {
      const next = await saveFeishuPackageWorkflowDraft(subjectKey, packageAlias, current.profile.revision, submittedConfig);
      if (!validProfile(next)) throw new Error("invalid profile");
      const latest = cache.get(key);
      const nextConfig = latest?.config && latest.config !== submittedConfig ? latest.config : structuredClone(next.config);
      writeCache(cache, key, { profile: next, config: nextConfig, recoveredError: current.error,
        saved: JSON.stringify(nextConfig) === JSON.stringify(next.config) });
      callbacks.current.onSaved?.(next);
    } catch (failure) {
      const safeMessage = message(failure);
      writeCache(cache, key, { ...(cache.get(key) ?? current), saving: false, error: safeMessage, recoveredError: null,
        conflict: failure instanceof ApiError && failure.code === "VERSION_CONFLICT" });
      if (mounted.current && activeKey.current === key) callbacks.current.onError?.(safeMessage);
    } finally {
      callbacks.current.onDirtyChange?.(cacheIsDirty(cache));
    }
  }
  function reloadDraft() {
    if (saving || enabling || loading) return;
    if (isDirty(cache.get(key)) && !window.confirm("重新加载会放弃此流程草稿的未保存修改，并读取已保存的版本。继续吗？")) return;
    const current = cache.get(key);
    if (current) writeCache(cache, key, { ...current, reloading: true, saved: false });
    setReload((value) => value + 1);
  }
  const uniqueFields = fields.filter((field) => fields.filter((candidate) => candidate.fieldId === field.fieldId).length === 1);
  const namingFields = uniqueFields.filter(namingField);
  function activationReason(current: VmPmoDraftEntry): string {
    if (!vmPmoInitialReady) return "本机初稿运行能力尚未就绪。";
    if (!packageEnabled) return "请先在剪辑包管理中启用当前包。";
    if (activationBlocked || !Number.isSafeInteger(subjectConfigVersion) || (subjectConfigVersion ?? 0) < 1) return "请等待学科配置读取或字段刷新完成。";
    if (!current.profile || !current.config || current.profile.revision < 1 || current.loading || current.saving
      || current.enabling || current.conflict || isDirty(current)) return "请先保存当前流程草稿并处理配置冲突。";
    const draft = current.config;
    const stage = draft.stages.initial;
    if (!stage.enabled || draft.stages.review.enabled || draft.finalArchive?.enabled) return "当前仅支持初稿，请关闭审核修改和成片归档。";
    const status = uniqueFields.find((field) => field.fieldId === stage.statusFieldId && isSingleSelectField(field));
    if (!status || status.options.filter((option) => option.id === stage.triggerOptionId).length !== 1
      || !uniqueFields.some((field) => field.fieldId === draft.fields.vmidFieldId && textField(field))
      || !namingFields.some((field) => field.fieldId === draft.fields.namingFieldId)
      || !uniqueFields.some((field) => field.fieldId === draft.fields.outputAttachmentFieldId && isAttachmentField(field))
      || !uniqueFields.some((field) => field.fieldId === stage.instructionFieldId && textField(field))
      || !draft.approval.department.trim() || !draft.approval.reason.trim()) return "请补齐来源、命名、附件、初稿意见和单选触发配置。";
    for (const target of Object.values(stage.writeback ?? {})) {
      if (!target.fieldId && !target.optionId) continue;
      const field = uniqueFields.find((candidate) => candidate.fieldId === target.fieldId && isSingleSelectField(candidate));
      if (!field || field.options.filter((option) => option.id === target.optionId).length !== 1) return "请检查阶段状态回写字段和选项。";
    }
    return "";
  }
  const enableBlockedReason = activationReason(entry);
  async function enable() {
    const current = cache.get(key);
    if (!current || activationReason(current)) return;
    writeCache(cache, key, { ...current, enabling: true, error: null, recoveredError: null, enabled: false });
    try {
      const subject = await enableFeishuPackageWorkflowDraft(subjectKey, packageAlias, current.profile!.revision, subjectConfigVersion!);
      if (subject.subjectKey !== subjectKey || subject.activePackageAlias !== packageAlias
        || subject.workflowTemplate?.id !== VM_TEMPLATE.id || subject.workflowTemplate.version !== VM_TEMPLATE.version) throw new Error("invalid activation");
      const latest = cache.get(key) ?? current;
      writeCache(cache, key, { ...latest, enabling: false, enabled: !isDirty(latest), recoveredError: current.error });
      callbacks.current.onEnabled?.(subject);
    } catch (failure) {
      const safeMessage = message(failure);
      writeCache(cache, key, { ...(cache.get(key) ?? current), enabling: false, enabled: false, error: safeMessage,
        recoveredError: null, conflict: failure instanceof ApiError && failure.code === "VERSION_CONFLICT" });
      if (mounted.current && activeKey.current === key) callbacks.current.onError?.(safeMessage);
    }
  }
  const finalArchive = config?.finalArchive ?? EMPTY_FINAL_ARCHIVE;
  const archiveStatusField = uniqueFields.find((field) => field.fieldId === finalArchive.statusFieldId && progressField(field));
  const archivePathField = namingFields.find((field) => field.fieldId === finalArchive.pathFieldId);
  const archiveNamingField = namingFields.find((field) => field.fieldId === config?.fields.namingFieldId);
  const archiveDirectoryPreview = finalArchive.pathSource === "pmo_field"
    ? `{${archivePathField?.fieldName ?? "成片归档路径字段值"}}`
    : finalArchive.directoryPath?.trim().replace(/[\\/]+$/u, "") || "{成片归档目录}";
  const archivePathPreview = `${archiveDirectoryPreview}\\{${archiveNamingField?.fieldName ?? "成片名"}}.mp4`;
  function setFinalArchive(patch: Partial<FeishuVmPmoFinalArchiveConfig>) {
    if (config) update({ ...config, finalArchive: { ...finalArchive, ...patch } });
  }
  function fieldSelect(label: string, value: string | null, candidates: FeishuFieldMetadata[], change: (value: string | null) => void, emptyLabel = "稍后选择") {
    return <label><span>{label}</span><select aria-label={label} value={value ?? ""} onChange={(event) => change(event.target.value || null)}>
      <option value="">{emptyLabel}</option>
      {value && !candidates.some((field) => field.fieldId === value) && <option value={value}>原字段已不可用，请重新选择</option>}
      {candidates.map((field) => <option key={field.fieldId} value={field.fieldId}>{field.fieldName}</option>)}
    </select></label>;
  }

  function optionSelect(label: string, value: string | null, field: FeishuFieldMetadata | undefined, change: (value: string | null) => void) {
    const options = (field?.options ?? []).filter((option, _, all) => all.filter((other) => other.id === option.id).length === 1);
    return <label><span>{label}</span><select aria-label={label} value={value ?? ""} disabled={!field} onChange={(event) => change(event.target.value || null)}>
      <option value="">稍后选择</option>
      {value && !options.some((option) => option.id === value) && <option value={value}>原选项已不可用，请重新选择</option>}
      {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select></label>;
  }

  function tabDomId(id: SettingsTabId) { return `${tabIdPrefix}-tab-${id}`; }
  function panelDomId(id: SettingsTabId) { return `${tabIdPrefix}-panel-${id}`; }
  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: SettingsTabId) {
    const current = SETTINGS_TABS.findIndex((tab) => tab.id === id);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (current + 1) % SETTINGS_TABS.length;
    if (event.key === "ArrowLeft") next = (current - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = SETTINGS_TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    setActiveTab(SETTINGS_TABS[next].id);
    tabRefs.current[next]?.focus();
  }

  return <section aria-label="VM 视频剪辑与 PMO 审核配置" className="feishu-vm-pmo-editor">
    <div className="feishu-vm-pmo-summary">
      {profile && <small>流程草稿版本 {profile.revision}</small>}
      <span role="status">{vmPmoInitialReady ? "初稿通过审批下载后剪辑并回写 MP4；审核修改复用上一轮成片，成片归档由审核通过状态触发。" : "当前仅保存配置草稿，本机初稿运行能力尚未就绪。"}</span>
    </div>
    <div className="feishu-settings-tabs" role="tablist" aria-label="VM 学科配置分区">
      {SETTINGS_TABS.map((tab, index) => <button key={tab.id} ref={(element) => { tabRefs.current[index] = element; }}
        id={tabDomId(tab.id)} className={activeTab === tab.id ? "is-active" : ""} type="button" role="tab"
        aria-selected={activeTab === tab.id} aria-controls={panelDomId(tab.id)} tabIndex={activeTab === tab.id ? 0 : -1}
        onClick={() => setActiveTab(tab.id)} onKeyDown={(event) => handleTabKeyDown(event, tab.id)}>{tab.label}</button>)}
    </div>
    <section key={activeTab} className="feishu-settings-tabpanel" role="tabpanel" id={panelDomId(activeTab)} aria-labelledby={tabDomId(activeTab)} tabIndex={0}>
      {loading && <p role="status">正在读取流程草稿…</p>}
      {error && <div role="alert"><p>{error}</p><button type="button" disabled={saving || enabling || loading} onClick={reloadDraft}>重新加载流程草稿</button></div>}
      {config && profile && !loading && <>
      {profile.legacyReviewStage && <p role="status" className="feishu-execution-help">旧初审和终审已合并，当前沿用旧{profile.legacyReviewStage === "first_review" ? "初审" : "终审"}配置。请核对审核修改设置；保存后统一为一个审核阶段，另一轮设置不再保留。</p>}
      {profile.legacyNamingConflict && <p role="status" className="feishu-execution-help">旧命名字段不一致，请在“基础与执行”重新选择视频主体命名字段并保存。初稿、审核修改和最终成片将共用该名称主体。</p>}
      {profile.legacyArchivePathNeedsReview && <p role="status" className="feishu-execution-help">旧归档目录规则已停止沿用，请在“存储与目录”重新确认成片归档目录或 PMO 路径字段并保存。成片将直接保存到所选目录。</p>}
      {activeTab === "basics" && <><fieldset className="feishu-config-card">
        <legend>视频来源</legend>
        <div className="feishu-settings-grid">
          <label><span>视频来源类型</span><select aria-label="视频来源类型" value="pmo_vmid_field" disabled><option value="pmo_vmid_field">PMO VMID 字段</option></select></label>
          {fieldSelect("VMID 字段", config.fields.vmidFieldId, uniqueFields.filter(textField), (value) => update({ ...config, fields: { ...config.fields, vmidFieldId: value } }))}
          <label>申请部门<input value={config.approval.department} onChange={(event) => update({ ...config, approval: { ...config.approval, department: event.target.value } })} /></label>
          <label>申请原因<input value={config.approval.reason} onChange={(event) => update({ ...config, approval: { ...config.approval, reason: event.target.value } })} /></label>
        </div>
        <p className="feishu-execution-help">初稿从 PMO 字段读取 VMID，获批后下载并剪辑；审核修改使用上一轮成片。来源与申请信息随当前学科、剪辑包保存。</p>
      </fieldset>
      <fieldset className="feishu-config-card">
        <legend>视频命名</legend>
        <div className="feishu-settings-grid">
          {fieldSelect("视频主体命名字段", config.fields.namingFieldId ?? null, namingFields, (value) => update({ ...config, fields: { ...config.fields, namingFieldId: value } }), "待选择")}
        </div>
        <p className="feishu-execution-help">读取同一 PMO 记录的文本或公式结果，作为初稿、审核修改和最终成片共用的名称主体。</p>
        <p className="feishu-execution-help">初稿：&lt;字段值&gt;_初稿.mp4；审核修改：&lt;字段值&gt;_第N稿.mp4；最终成片：&lt;字段值&gt;.mp4。</p>
      </fieldset></>}
      {activeTab === "materials" && <>
      <fieldset className="feishu-config-card">
        <legend>剪辑阶段</legend>
        <p>触发设计：单选从其他值进入命中选项时触发；多选从不包含到包含命中选项时触发，其他选项变化不重复触发。</p>
        {STAGES.map(([id, label]) => {
          const stage = config.stages[id];
          const statusField = uniqueFields.find((field) => field.fieldId === stage.statusFieldId && progressField(field));
          const setStage = (patch: Partial<typeof stage>) => update({ ...config, stages: { ...config.stages, [id]: { ...stage, ...patch } } });
          return <section key={id} aria-label={`VM ${label}配置`}>
            <h4><label className="feishu-vm-stage-toggle"><input type="checkbox" aria-label={`启用 VM ${label}`} checked={stage.enabled} onChange={(event) => setStage({ enabled: event.target.checked })} />{label}</label></h4>
            <p>{id === "initial" ? "读取初稿意见，首次编辑当前记录的原始 VM 视频。" : "读取审核意见，修改上一轮成片。完成后再次进入触发状态，开始下一轮审核修改。"}</p>
            <div className="feishu-settings-grid">
              {fieldSelect(`VM ${label}进度触发字段`, stage.statusFieldId, uniqueFields.filter(progressField), (value) => setStage({ statusFieldId: value, triggerOptionId: null }))}
              {optionSelect(`VM ${label}触发状态`, stage.triggerOptionId, statusField, (value) => setStage({ triggerOptionId: value }))}
              {fieldSelect(id === "initial" ? "初稿意见字段" : "审核意见字段", stage.instructionFieldId, uniqueFields.filter(textField), (value) => setStage({ instructionFieldId: value }))}
              {id === "review" && fieldSelect("审核意见附件字段", config.stages.review.instructionAttachmentsFieldId, uniqueFields.filter(isAttachmentField), (value) => update({ ...config, stages: { ...config.stages, review: { ...config.stages.review, instructionAttachmentsFieldId: value } } }))}
            </div>
            <p className="feishu-execution-help">{id === "initial" ? "视频名称：<字段值>_初稿.mp4。" : "视频名称：<字段值>_第1稿.mp4、<字段值>_第2稿.mp4，按审核剪辑轮次递增；同一轮失败重试复用编号。"}</p>
          </section>;
        })}
      </fieldset>
      </>}
      {activeTab === "storage" && <><fieldset className="feishu-config-card">
        <legend>成片交付</legend>
        <div className="feishu-settings-grid">{fieldSelect("成品视频附件字段", config.fields.outputAttachmentFieldId, uniqueFields.filter(isAttachmentField), (value) => update({ ...config, fields: { ...config.fields, outputAttachmentFieldId: value } }))}</div>
        <p className="feishu-execution-help">各阶段生成的 MP4 上传到当前 PMO 记录的指定附件字段，上传、绑定并读回确认后才视为交付完成。</p>
      </fieldset>
      <fieldset className="feishu-config-card">
        <legend>成片归档</legend>
        <label><input type="checkbox" aria-label="启用 VM 成片归档" checked={finalArchive.enabled} onChange={(event) => setFinalArchive({ enabled: event.target.checked })} />纳入成片归档流程</label>
        <p className="feishu-execution-help">进度进入所选成片状态后，归档同一 PMO 记录最近一次已确认交付的 MP4；持续命中状态不会重复归档。</p>
        <div className="feishu-settings-grid">
          {fieldSelect("成片归档进度字段", finalArchive.statusFieldId, uniqueFields.filter(progressField), (value) => setFinalArchive({ statusFieldId: value, triggerOptionId: null }))}
          {optionSelect("成片归档触发状态", finalArchive.triggerOptionId, archiveStatusField, (value) => setFinalArchive({ triggerOptionId: value }))}
          <label><span>成片归档路径来源</span><select aria-label="成片归档路径来源" value={finalArchive.pathSource} onChange={(event) => setFinalArchive({ pathSource: event.target.value as FeishuVmPmoFinalArchiveConfig["pathSource"] })}>
            <option value="manual">手动填写目录</option><option value="pmo_field">PMO 字段</option>
          </select></label>
          {finalArchive.pathSource === "manual"
            ? <label><span>成片归档目录</span><input aria-label="成片归档目录" value={finalArchive.directoryPath ?? ""} placeholder={"\\\\NAS\\共享目录\\成片 或 W:\\交付目录"} onChange={(event) => setFinalArchive({ directoryPath: event.target.value || null })} /></label>
            : fieldSelect("成片归档路径字段", finalArchive.pathFieldId, namingFields, (value) => setFinalArchive({ pathFieldId: value }), "选择文本或公式字段")}
        </div>
        <p className="feishu-execution-help">{finalArchive.pathSource === "pmo_field" ? "读取指定 PMO 字段的文本或公式结果，作为该记录的具体目录。" : "填写成片保存的具体目录，可使用 NAS 共享路径或本机映射盘路径。"}</p>
        <p className="feishu-execution-help">目标路径：<code>{archivePathPreview}</code></p>
        <p className="feishu-execution-help">最终成片使用“基础与执行”设置的共用名称主体。进度进入归档触发状态后，自动将最近一轮已确认交付的 MP4 保存到指定目录。</p>
      </fieldset></>}
      {activeTab === "writeback" && <fieldset className="feishu-config-card">
        <legend>阶段状态回写</legend>
        <p className="feishu-execution-help">开始剪辑回写仅在实际启动后执行；成片交付完成回写仅在 MP4 附件上传、绑定并读回确认后执行。</p>
        {STAGES.map(([id, label]) => {
          const stage = config.stages[id];
          const writeback = stage.writeback ?? { processing: { fieldId: null, optionId: null }, completed: { fieldId: null, optionId: null } };
          const setWriteback = (targetId: "processing" | "completed", patch: Partial<FeishuVmPmoWritebackTarget>) => update({ ...config, stages: { ...config.stages, [id]: { ...stage, writeback: { ...writeback, [targetId]: { ...writeback[targetId], ...patch } } } } });
          return <section key={id} aria-label={`VM ${label}回写配置`}><h4>{label}</h4>
            {([["processing", "开始剪辑回写"], ["completed", "成片交付完成回写"]] as const).map(([targetId, targetLabel]) => {
              const target = writeback[targetId];
              const targetField = uniqueFields.find((field) => field.fieldId === target.fieldId && isSingleSelectField(field));
              return <section key={targetId} aria-label={`VM ${label}${targetLabel}`}>
                <h5>{targetLabel}</h5>
                <div className="feishu-settings-grid">
                  {fieldSelect(`VM ${label}${targetLabel}字段`, target.fieldId, uniqueFields.filter(isSingleSelectField), (value) => setWriteback(targetId, { fieldId: value, optionId: null }))}
                  {optionSelect(`VM ${label}${targetLabel}选项`, target.optionId, targetField, (value) => setWriteback(targetId, { optionId: value }))}
                </div>
              </section>;
            })}
          </section>;
        })}
      </fieldset>}
      </>}
    </section>
    <div className="feishu-subject-actions feishu-vm-pmo-actions">
      {saved && <span role="status">流程草稿已保存。</span>}
      {entry.enabled && <span role="status">初稿流程已启用。</span>}
      <button type="button" className="button secondary" disabled={!config || !profile || saving || enabling || loading || entry.conflict} onClick={() => void save()}>{saving ? "正在保存…" : "保存流程草稿"}</button>
      <button type="button" className="button primary" disabled={Boolean(enableBlockedReason)} title={enableBlockedReason || "启用已保存的初稿流程"} onClick={() => void enable()}>{enabling ? "正在启用…" : "启用流程"}</button>
    </div>
  </section>;
}
