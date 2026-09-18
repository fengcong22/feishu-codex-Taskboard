import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  discoverFeishuPackageModels,
  disableFeishuPackage,
  enableFeishuPackage,
  inspectFeishuPackageWorkspace,
  listFeishuPackages,
  prepareFeishuPackageOutputDirectory,
  validateFeishuPackageOutputDirectory,
  removeFeishuPackage,
  saveFeishuPackageDraft,
} from "../api";
import type {
  AiChatModel,
  AutoCutPackageDraft,
  AutoCutPackageReference,
  FeishuPackage,
  FeishuPackageState,
  FeishuPackageSummary,
  FeishuPackageWorkspaceInspection,
} from "../types";
import { LinearIcon } from "./LinearIcon";

type Props = {
  refreshKey?: number;
  onPackageChange?: (packages: FeishuPackageSummary[]) => void;
  onError?: (message: string) => void;
};

type PackageForm = AutoCutPackageDraft & Pick<FeishuPackage, "state" | "revision" | "updatedAt">;

const EMPTY_FORM: PackageForm = {
  alias: "",
  name: "",
  projectId: "",
  workspacePath: null,
  model: null,
  reasoningEffort: null,
  prompt: null,
  zipSourceDirectory: null,
  maxConcurrent: 1,
  resourceGroups: [],
  state: "draft",
  revision: 1,
  updatedAt: "",
};

const DRAFT_FIELDS: Array<keyof AutoCutPackageDraft> = [
  "alias",
  "name",
  "projectId",
  "workspacePath",
  "model",
  "reasoningEffort",
  "prompt",
  "zipSourceDirectory",
  "zipOutputMode",
  "maxConcurrent",
  "resourceGroups",
];

const STATE_LABELS: Record<FeishuPackageState, string> = {
  draft: "草稿",
  enabled: "已启用",
  disabled: "已停用",
};

function asForm(value: FeishuPackage): PackageForm {
  return {
    alias: value.alias,
    name: value.name,
    projectId: value.projectId,
    workspacePath: value.workspacePath,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    prompt: value.prompt,
    zipSourceDirectory: value.zipSourceDirectory,
    zipOutputMode: value.zipOutputMode,
    maxConcurrent: value.maxConcurrent,
    resourceGroups: value.resourceGroups ?? [],
    state: value.state,
    revision: value.revision,
    updatedAt: value.updatedAt,
  };
}

function asDraft(value: PackageForm): AutoCutPackageDraft {
  return {
    alias: value.alias,
    name: value.name,
    projectId: value.projectId,
    workspacePath: value.workspacePath,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    prompt: value.prompt,
    zipSourceDirectory: value.zipSourceDirectory,
    ...(value.zipOutputMode ? { zipOutputMode: value.zipOutputMode } : {}),
    maxConcurrent: value.maxConcurrent,
    resourceGroups: value.resourceGroups,
  };
}

function resourceGroupsFrom(value: string): string[] {
  return [...new Set(value.split(/[,，\n]/u).map((entry) => entry.trim()).filter(Boolean))];
}

function draftChanged(form: PackageForm, saved: AutoCutPackageDraft): boolean {
  return DRAFT_FIELDS.some((field) => field === "resourceGroups"
    ? JSON.stringify(form.resourceGroups) !== JSON.stringify(saved.resourceGroups ?? [])
    : form[field] !== saved[field]);
}

function packageReferences(error: unknown): AutoCutPackageReference[] {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return [];
  const references = (error.details as { references?: unknown }).references;
  if (!Array.isArray(references)) return [];
  return references.filter((reference): reference is AutoCutPackageReference => (
    Boolean(reference)
    && typeof reference === "object"
    && ((reference as { type?: unknown }).type === "subject" || (reference as { type?: unknown }).type === "task")
  ));
}

function referenceLabel(reference: AutoCutPackageReference): string {
  if (reference.type === "subject") return `${reference.baseName} / ${reference.tableName}`;
  return `${reference.identifier} · ${reference.title}`;
}

function packageDisplayName(value: Pick<FeishuPackage, "name"> & { identity?: FeishuPackageWorkspaceInspection | null }): string {
  return value.identity?.displayName || value.name;
}

function inspectionFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      PACKAGE_WORKSPACE_UNAVAILABLE: "工作区不存在或不可访问，请检查路径后重试。",
      PACKAGE_MANIFEST_UNAVAILABLE: "无法读取包清单，请确认所选目录是完整的 Auto-Cut 包。",
      PACKAGE_MANIFEST_INVALID: "包清单格式或版本信息无效，请检查 Auto-Cut 包。",
      INVALID_FIELD: "请填写完整的工作区绝对路径。",
    };
    if (messages[error.code]) return messages[error.code];
  }
  return error instanceof Error ? error.message : "工作区验证失败，请重试。";
}

export function FeishuPackageManager({ refreshKey = 0, onPackageChange, onError }: Props) {
  const [packages, setPackages] = useState<FeishuPackageSummary[]>([]);
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [form, setForm] = useState<PackageForm>({ ...EMPTY_FORM });
  const [models, setModels] = useState<AiChatModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const inspectionRequest = useRef<AbortController | null>(null);
  const catalogRequest = useRef<AbortController | null>(null);
  const zipDirectoryBeforeAutofill = useRef<string | null>(null);
  const [workspaceValidation, setWorkspaceValidation] = useState<{
    workspacePath: string;
    inspection: FeishuPackageWorkspaceInspection;
  } | null>(null);
  const mounted = useRef(false);
  const loadSequence = useRef(0);
  const editorVersion = useRef(0);
  const [referenceDrawer, setReferenceDrawer] = useState<AutoCutPackageReference[]>([]);
  const selected = useMemo(
    () => packages.find((item) => item.alias === selectedAlias) ?? null,
    [packages, selectedAlias],
  );
  const dirty = Boolean(selected) && draftChanged(form, selected!);
  const editor = useRef({ selectedAlias, form, selected });
  editor.current = { selectedAlias, form, selected };
  const callbacks = useRef({ onError, onPackageChange });
  callbacks.current = { onError, onPackageChange };
  const selectedModel = models.find((model) => model.slug === form.model) ?? null;
  const modelOptions = useMemo(() => {
    if (!form.model || models.some((model) => model.slug === form.model)) return models;
    return [{
      slug: form.model,
      displayName: `${form.model}（当前配置）`,
      description: "",
      defaultReasoningEffort: form.reasoningEffort ?? "",
      supportedReasoningEfforts: form.reasoningEffort ? [form.reasoningEffort] : [],
      serviceTiers: [],
    }, ...models];
  }, [form.model, form.reasoningEffort, models]);
  const reasoningOptions = selectedModel?.supportedReasoningEfforts
    ?? (form.reasoningEffort ? [form.reasoningEffort] : []);
  const normalizedWorkspacePath = form.workspacePath?.trim() ?? "";
  const validationMatchesWorkspace = Boolean(
    normalizedWorkspacePath
    && workspaceValidation?.workspacePath === normalizedWorkspacePath,
  );
  const availableZipOutput = validationMatchesWorkspace
    ? workspaceValidation?.inspection.zipOutput ?? null
    : normalizedWorkspacePath === selected?.workspacePath ? selected?.identity?.zipOutput ?? null : null;
  const zipMode = form.zipOutputMode
    ?? (availableZipOutput && form.zipSourceDirectory === availableZipOutput.directory ? "package_default" : "custom");
  const declaredZipOutput = zipMode === "package_default" ? availableZipOutput : null;
  const usePackageDefault = zipMode === "package_default";
  const requiresWorkspaceValidation = !selected || form.workspacePath !== selected.workspacePath;
  const canSave = Boolean(
    form.alias
    && form.name
    && form.projectId
    && (form.zipOutputMode !== "custom" || Boolean(form.zipSourceDirectory?.trim()))
    && (!usePackageDefault || Boolean(declaredZipOutput))
    && (!requiresWorkspaceValidation || validationMatchesWorkspace),
  );
  const identityPreview = validationMatchesWorkspace ? workspaceValidation!.inspection
    : form.workspacePath === selected?.workspacePath ? selected?.identity ?? null : null;
  const operationBusy = busy || inspecting;

  async function refresh(preferredAlias?: string | null, resetEditor = false) {
    const request = ++loadSequence.current;
    catalogRequest.current?.abort();
    const controller = new AbortController();
    catalogRequest.current = controller;
    const version = editorVersion.current;
    const previous = editor.current;
    const targetAlias = preferredAlias === undefined ? previous.selectedAlias : preferredAlias;
    const preserveDraft = !resetEditor && draftChanged(previous.form, previous.selected ?? EMPTY_FORM);
    setLoading(true);
    setLoadError(null);
    try {
      const next = await listFeishuPackages(controller.signal);
      if (!mounted.current || request !== loadSequence.current) return null;
      setPackages(next);
      setCatalogLoaded(true);
      callbacks.current.onPackageChange?.(next);
      if (!preserveDraft && version === editorVersion.current) {
        const nextSelected = next.find((item) => item.alias === targetAlias) ?? next[0] ?? null;
        setSelectedAlias(nextSelected?.alias ?? null);
        setForm(nextSelected ? asForm(nextSelected) : { ...EMPTY_FORM });
        setReferenceDrawer([]);
      }
      return next;
    } catch (error) {
      if (!mounted.current || request !== loadSequence.current) return null;
      const message = error instanceof Error ? error.message : "加载 Auto-Cut 包失败";
      setLoadError(message);
      callbacks.current.onError?.(message);
      return null;
    } finally {
      if (mounted.current && request === loadSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadSequence.current += 1;
      catalogRequest.current?.abort();
      inspectionRequest.current?.abort();
      inspectionRequest.current = null;
    };
  }, []);

  useEffect(() => {
    void refresh();
    // refreshKey is incremented by local realtime package events.
  }, [refreshKey]);

  useEffect(() => {
    if (!loadError || loading || busy) return;
    const retry = () => { void refresh(); };
    window.addEventListener("focus", retry);
    return () => window.removeEventListener("focus", retry);
  }, [loadError, loading, busy]);

  function resetInspection() {
    inspectionRequest.current?.abort();
    inspectionRequest.current = null;
    setInspecting(false);
    setInspectionError(null);
    setActionError(null);
    setWorkspaceValidation(null);
  }

  function selectPackage(item: FeishuPackageSummary) {
    resetInspection();
    editorVersion.current += 1;
    setSelectedAlias(item.alias);
    setForm(asForm(item));
    zipDirectoryBeforeAutofill.current = item.zipSourceDirectory;
    setModels([]);
    setWorkspaceValidation(null);
    setReferenceDrawer([]);
  }

  function update<K extends keyof PackageForm>(key: K, value: PackageForm[K]) {
    editorVersion.current += 1;
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function prepareDeclaredZipOutput() {
    const custom = zipMode === "custom";
    if (!custom && (!declaredZipOutput || !normalizedWorkspacePath)) return;
    const version = editorVersion.current;
    let directory: string;
    if (custom) {
      directory = await validateFeishuPackageOutputDirectory(form.zipSourceDirectory?.trim() ?? "");
    } else {
      directory = (await prepareFeishuPackageOutputDirectory(normalizedWorkspacePath)).directory;
    }
    if (!mounted.current || version !== editorVersion.current || editor.current.selectedAlias !== selectedAlias) {
      throw new Error("配置已变更，请重新验证并保存当前工作区。");
    }
    if (!custom && (directory !== form.zipSourceDirectory || directory !== declaredZipOutput!.directory)) {
      throw new Error("ZIP 生成目录与 Auto-Cut-Lite 声明不一致，请重新验证后再保存。");
    }
    return directory;
  }

  async function writeDraft() {
    const directory = await prepareDeclaredZipOutput();
    return saveFeishuPackageDraft(selectedAlias, {
      ...asDraft(form),
      ...(directory ? { zipSourceDirectory: directory } : {}),
      ...(selectedAlias ? { expectedRevision: form.revision } : {}),
    });
  }

  function reportMutationError(error: unknown, fallback: string) {
    const references = packageReferences(error);
    if (references.length > 0) setReferenceDrawer(references);
    const messages: Record<string, string> = {
      PACKAGE_CUSTOM_ZIP_OUTPUT_INVALID: "请填写存在且可写的 ZIP 生成目录绝对路径。",
      PACKAGE_ZIP_OUTPUT_INVALID: "请填写 ZIP 生成目录的完整绝对路径。",
      PACKAGE_ZIP_OUTPUT_UNAVAILABLE: "ZIP 生成目录不存在或不可写，请检查目录和访问权限。",
    };
    const message = error instanceof ApiError && messages[error.code]
      ? messages[error.code] : error instanceof Error ? error.message : fallback;
    setActionError(message);
    onError?.(message);
  }

  async function save() {
    setActionError(null);
    setBusy(true);
    try {
      const saved = await writeDraft();
      await refresh(saved.alias, true);
    } catch (error) {
      reportMutationError(error, "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function runEditorAction(kind: "enable" | "disable" | "delete") {
    if (!selectedAlias || !selected) return;
    if (kind === "delete" && selected.referenceCount > 0) {
      setReferenceDrawer(selected.references);
      return;
    }
    if (kind === "delete" && !window.confirm(`确认删除 Auto-Cut 包“${selected.name}”吗？`)) return;
    setActionError(null);
    setBusy(true);
    try {
      let target: FeishuPackage = selected;
      if (kind === "enable" && dirty) target = await writeDraft();
      else if (kind === "enable") await prepareDeclaredZipOutput();
      const result = kind === "enable"
        ? await enableFeishuPackage(target.alias, target.revision)
        : kind === "disable"
          ? await disableFeishuPackage(target.alias, target.revision)
          : await removeFeishuPackage(target.alias, target.revision);
      if (kind === "disable" && editor.current.selectedAlias === target.alias) {
        setForm((current) => current.alias === target.alias ? {
          ...current, state: result.state, revision: result.revision, updatedAt: result.updatedAt,
        } : current);
      }
      await refresh(kind === "delete" ? null : result.alias, kind !== "disable");
    } catch (error) {
      const references = packageReferences(error);
      reportMutationError(error, "操作失败");
      await refresh(selectedAlias);
      if (references.length > 0) setReferenceDrawer(references);
    } finally {
      setBusy(false);
    }
  }

  async function runRowAction(kind: "disable" | "delete", item: FeishuPackageSummary) {
    selectPackage(item);
    if (kind === "delete" && item.referenceCount > 0) {
      setReferenceDrawer(item.references);
      return;
    }
    if (kind === "delete" && !window.confirm(`确认删除 Auto-Cut 包“${item.name}”吗？`)) return;
    setActionError(null);
    setBusy(true);
    try {
      const result = kind === "disable"
        ? await disableFeishuPackage(item.alias, item.revision)
        : await removeFeishuPackage(item.alias, item.revision);
      await refresh(kind === "delete" ? null : result.alias, true);
    } catch (error) {
      const references = packageReferences(error);
      reportMutationError(error, "操作失败");
      await refresh(item.alias);
      if (references.length > 0) setReferenceDrawer(references);
    } finally {
      setBusy(false);
    }
  }

  async function discover() {
    if (!form.workspacePath) return;
    setBusy(true);
    try {
      const result = await discoverFeishuPackageModels(form.workspacePath);
      setModels(result.models);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "模型发现失败");
    } finally {
      setBusy(false);
    }
  }

  async function inspectWorkspace() {
    const workspacePath = normalizedWorkspacePath;
    if (!workspacePath) return;
    inspectionRequest.current?.abort();
    const controller = new AbortController();
    inspectionRequest.current = controller;
    const alias = selectedAlias;
    const wasNewPackage = !selectedAlias;
    editorVersion.current += 1;
    setInspecting(true);
    setInspectionError(null);
    // Retain the origin of a previously auto-filled path during a retry so a
    // failed read cannot turn it into an unchecked manual directory on save.
    const isCurrent = () => mounted.current && inspectionRequest.current === controller
      && !controller.signal.aborted && editor.current.selectedAlias === alias
      && editor.current.form.workspacePath?.trim() === workspacePath;
    try {
      const inspection = await inspectFeishuPackageWorkspace(workspacePath, controller.signal);
      if (!isCurrent()) return;
      editorVersion.current += 1;
      setWorkspaceValidation({ workspacePath, inspection });
      if (inspection.zipOutput && editor.current.form.zipOutputMode !== "custom") {
        if (!declaredZipOutput) zipDirectoryBeforeAutofill.current = editor.current.form.zipSourceDirectory;
        setForm((current) => ({
          ...current,
          ...(wasNewPackage ? { zipOutputMode: "package_default" } : {}),
          zipSourceDirectory: inspection.zipOutput!.directory,
        }));
      } else if (declaredZipOutput) {
        const fallback = selected?.zipSourceDirectory === declaredZipOutput.directory
          ? selected.zipSourceDirectory : zipDirectoryBeforeAutofill.current;
        setForm((current) => ({ ...current, zipSourceDirectory: fallback, zipOutputMode: undefined }));
      }
      if (wasNewPackage) {
        setForm((current) => ({
          ...current,
          alias: inspection.alias,
          name: inspection.displayName,
          projectId: inspection.projectId,
          prompt: current.prompt || inspection.defaultPrompt,
        }));
      }
    } catch (error) {
      if (isCurrent()) setInspectionError(inspectionFailure(error));
    } finally {
      if (mounted.current && inspectionRequest.current === controller) {
        inspectionRequest.current = null;
        setInspecting(false);
      }
    }
  }

  function changeWorkspace(workspacePath: string) {
    resetInspection();
    editorVersion.current += 1;
    setModels([]);
    setWorkspaceValidation(null);
    setForm((current) => ({ ...current, workspacePath: workspacePath || null, model: null, reasoningEffort: null }));
  }

  function changeZipOutputMode(mode: "package_default" | "custom") {
    editorVersion.current += 1;
    setActionError(null);
    if (mode === "package_default") {
      if (!availableZipOutput) return;
      zipDirectoryBeforeAutofill.current = form.zipSourceDirectory;
      setForm((current) => ({ ...current, zipOutputMode: mode, zipSourceDirectory: availableZipOutput.directory }));
    } else {
      const directory = zipDirectoryBeforeAutofill.current ?? form.zipSourceDirectory;
      setForm((current) => ({ ...current, zipOutputMode: mode, zipSourceDirectory: directory }));
    }
  }

  function changeModel(slug: string) {
    editorVersion.current += 1;
    const model = models.find((item) => item.slug === slug) ?? null;
    setForm((current) => ({
      ...current,
      model: slug || null,
      reasoningEffort: model?.defaultReasoningEffort || model?.supportedReasoningEfforts[0] || null,
    }));
  }

  return <section className="feishu-package-manager" aria-label="Auto-Cut 包管理">
    <div className="feishu-package-list package-list">
      <div className="feishu-package-list-header">
        <h2>Auto-Cut 包</h2>
        <button type="button" disabled={!catalogLoaded || busy} onClick={() => {
          resetInspection();
          editorVersion.current += 1;
          setSelectedAlias(null);
          setForm({ ...EMPTY_FORM });
          setModels([]);
          setWorkspaceValidation(null);
          setReferenceDrawer([]);
        }}>新增 Auto-Cut 包</button>
      </div>
      <div className="feishu-package-table-header" aria-hidden="true">
        <span>包</span><span>状态</span><span>模型 / 推理</span><span>并发</span><span>引用</span><span>操作</span>
      </div>
      {loading && <p className="feishu-package-empty" role="status">{catalogLoaded ? "正在刷新 Auto-Cut 包…" : "正在加载 Auto-Cut 包…"}</p>}
      {loadError && <div className="feishu-package-load-error" role="alert">
        <p>{catalogLoaded ? "刷新失败，当前仍显示上次成功加载的配置。" : "Auto-Cut 包加载失败，暂时无法确认已有配置。"} {loadError}</p>
        <button type="button" disabled={loading || busy} onClick={() => void refresh()}>重新加载</button>
      </div>}
      {catalogLoaded && !loading && !loadError && packages.length === 0 && <p className="feishu-package-empty">暂无包配置</p>}
      {packages.map((item) => <div key={item.alias} className={`feishu-package-row${item.alias === selectedAlias ? " active" : ""}`}>
        <button type="button" className="feishu-package-select" onClick={() => selectPackage(item)} aria-label={`编辑 ${packageDisplayName(item)}`}>
          <strong>{packageDisplayName(item)}</strong><small>{item.alias}</small>
        </button>
        <span className={`feishu-package-state state-${item.state}`}>{STATE_LABELS[item.state]}</span>
        <span className="feishu-package-model">{item.model ?? "未配置"}<small>{item.reasoningEffort ?? "-"}</small></span>
        <span className="feishu-package-concurrency">{item.maxConcurrent}</span>
        <button type="button" className="feishu-package-refs" disabled={item.referenceCount === 0} onClick={() => { selectPackage(item); setReferenceDrawer(item.references); }} aria-label={`查看 ${packageDisplayName(item)} 的 ${item.referenceCount} 个引用`}>{item.referenceCount}</button>
        <span className="feishu-package-row-actions">
          <button type="button" title="编辑" aria-label={`编辑 ${packageDisplayName(item)}`} onClick={() => selectPackage(item)}><LinearIcon name="write" /></button>
          {item.state === "enabled" && <button type="button" title="停用" aria-label={`停用 ${packageDisplayName(item)}`} disabled={busy} onClick={() => void runRowAction("disable", item)}><LinearIcon name="pause" /></button>}
          <button type="button" title={item.referenceCount > 0 ? "存在引用，不能删除" : "删除"} aria-label={`删除 ${packageDisplayName(item)}`} disabled={busy || item.referenceCount > 0} onClick={() => void runRowAction("delete", item)}><LinearIcon name="trash" /></button>
        </span>
      </div>)}
    </div>

    <div className="feishu-package-editor package-editor">
      {!catalogLoaded ? <p className="feishu-package-empty">加载成功后可查看和编辑已有配置。</p> : <>
      <div className="feishu-package-editor-header">
        <div>
          <h2>{selected ? `编辑 ${packageDisplayName(selected)}` : "新增 Auto-Cut 包"}</h2>
          {selected && <small>状态：{STATE_LABELS[selected.state]} · 引用：{selected.referenceCount}</small>}
        </div>
        <div className="feishu-package-actions">
          <button type="button" disabled={operationBusy || !canSave} onClick={() => void save()}>保存草稿</button>
          {selected && selected.state !== "enabled" && <button type="button" disabled={operationBusy || !canSave} onClick={() => void runEditorAction("enable")}>启用</button>}
          {selected && selected.state === "enabled" && <button type="button" disabled={operationBusy || !canSave} onClick={() => void runEditorAction("disable")}>停用</button>}
          {selected && <button type="button" className="danger" disabled={operationBusy || selected.referenceCount > 0} title={selected.referenceCount > 0 ? "存在引用，不能删除" : "删除"} onClick={() => void runEditorAction("delete")}>删除</button>}
        </div>
      </div>

      {referenceDrawer.length > 0 && <aside className="feishu-package-reference-warning" aria-label="包引用详情">
        <div><strong>引用详情</strong><button type="button" title="关闭" aria-label="关闭引用详情" onClick={() => setReferenceDrawer([])}><LinearIcon name="close" /></button></div>
        <ul>{referenceDrawer.map((reference) => <li key={reference.type === "subject" ? reference.subjectKey : reference.taskId}>
          <span>{reference.type === "subject" ? "学科" : "未完成任务"}</span>{referenceLabel(reference)}
        </li>)}</ul>
      </aside>}
      {actionError && <p className="feishu-package-load-error" role="alert">{actionError}</p>}

      <div className="feishu-package-form">
        <label className="wide">Codex 工作区路径<input value={form.workspacePath ?? ""} onChange={(event) => changeWorkspace(event.target.value)} placeholder="绝对路径" /></label>
        <div className="feishu-package-workspace-actions wide">
          <button type="button" className="secondary" disabled={operationBusy || !normalizedWorkspacePath} onClick={() => void inspectWorkspace()}>{inspecting ? "正在验证…" : "验证并读取"}</button>
          {!inspecting && !inspectionError && !validationMatchesWorkspace && !selected && <small>验证工作区后会生成稳定的包标识，才可保存草稿。</small>}
          {inspecting && <span className="feishu-package-inspection-feedback is-pending" role="status">正在验证工作区并读取包信息，最多等待 15 秒…</span>}
          {inspectionError && <span className="feishu-package-inspection-feedback is-error" role="alert">验证未完成：{inspectionError}</span>}
          {!inspecting && !inspectionError && identityPreview && <span className={`feishu-package-identity${validationMatchesWorkspace ? " is-success" : ""}`} aria-label="已读取的包版本" role={validationMatchesWorkspace ? "status" : undefined}>
            {validationMatchesWorkspace && <span>验证并读取成功</span>}
            <strong>{identityPreview.displayName}</strong>
            {identityPreview.runtimeVersion && <small>运行核心 {identityPreview.runtimeVersion}</small>}
            {validationMatchesWorkspace && <small>{selected
              ? declaredZipOutput && form.zipSourceDirectory !== selected.zipSourceDirectory ? "ZIP 生成目录已带入，保存后生效" : "现有配置已保留"
              : "已自动带入，尚未保存"}</small>}
          </span>}
        </div>
        <label>ZIP 目录来源<select aria-label="ZIP 目录来源" value={zipMode} onChange={(event) => changeZipOutputMode(event.target.value as "package_default" | "custom")}>
          <option value="package_default" disabled={!availableZipOutput}>Auto-Cut-Lite 默认目录</option>
          <option value="custom">自定义目录</option>
        </select></label>
        <label>ZIP 生成目录<input aria-label="ZIP 生成目录" value={form.zipSourceDirectory ?? ""} disabled={Boolean(declaredZipOutput)} onChange={(event) => {
          update("zipOutputMode", "custom");
          update("zipSourceDirectory", event.target.value || null);
        }} placeholder="绝对路径（可选）" />
          {declaredZipOutput && <small className="feishu-package-zip-output"><strong>来自 Auto-Cut-Lite</strong><span>{declaredZipOutput.relativeDirectory} → {declaredZipOutput.directory}</span><span>保存或启用时自动创建缺失目录。</span></small>}
          {validationMatchesWorkspace && !declaredZipOutput && <small>该包未声明默认目录，可手动填写 ZIP 生成目录。</small>}
        </label>
        <label>GPT 模型<select value={form.model ?? ""} onChange={(event) => changeModel(event.target.value)}>
          <option value="">请选择模型</option>
          {modelOptions.map((model) => <option key={model.slug} value={model.slug}>{model.displayName || model.slug}</option>)}
        </select></label>
        <button type="button" className="secondary" disabled={operationBusy || !form.workspacePath} onClick={() => void discover()}>发现模型</button>
        <label>推理强度<select value={form.reasoningEffort ?? ""} disabled={!form.model} onChange={(event) => update("reasoningEffort", event.target.value || null)}>
          <option value="">请选择强度</option>
          {reasoningOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select></label>
        <label>最大并发<input type="number" min={1} step={1} value={form.maxConcurrent} onChange={(event) => update("maxConcurrent", Number(event.target.value))} /></label>
        <label>资源组<input value={form.resourceGroups.join(", ")} onChange={(event) => update("resourceGroups", resourceGroupsFrom(event.target.value))} /></label>
        <label className="wide">启动 Prompt<textarea value={form.prompt ?? ""} onChange={(event) => update("prompt", event.target.value || null)} rows={6} /></label>
      </div>
      </>}
    </div>
  </section>;
}

export default FeishuPackageManager;
