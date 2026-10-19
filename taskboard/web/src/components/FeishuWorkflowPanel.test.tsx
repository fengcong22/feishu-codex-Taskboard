import { useState, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskboardStorage } from "../storage";
import type { FeishuBaseCatalog, FeishuStageConfigMap, FeishuSubjectConfig, FeishuPackageSummary, FeishuPackageWorkflowDraft } from "../types";
import {
  audioDraftFromStage,
  FeishuStageEditor,
  type FeishuStageAudioDraft,
  type FeishuStageValue,
} from "./FeishuStageEditor";
import { FeishuWorkflowPanel } from "./FeishuWorkflowPanel";
import { ApiError, enableFeishuPackageWorkflowDraft, getFeishuPackageWorkflowDraft, importFeishuSubjectWorkflowShare, exportFeishuSubjectWorkflowShare, saveFeishuPackageWorkflowDraft, saveFeishuSubjectDraft, listFeishuPackages, listFeishuWorkflowCatalog, refreshFeishuBaseFields } from "../api";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listFeishuPackages: vi.fn(async () => []),
  refreshFeishuBaseFields: vi.fn(),
  getFeishuPackageWorkflowDraft: vi.fn(),
  saveFeishuPackageWorkflowDraft: vi.fn(),
  enableFeishuPackageWorkflowDraft: vi.fn(),
  saveFeishuSubjectDraft: vi.fn(),
  listFeishuWorkflowCatalog: vi.fn(),
  importFeishuSubjectWorkflowShare: vi.fn(),
  exportFeishuSubjectWorkflowShare: vi.fn(),
}));

describe("separate VM package workflow drafts", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); vi.mocked(listFeishuPackages).mockResolvedValue([]); });
  const template = { id: "vm_pmo_review_video", version: 1 } as const;
  function profile(subjectKey: string, packageAlias = "vm-package"): FeishuPackageWorkflowDraft {
    return { subjectKey, packageAlias, workflowTemplate: template, revision: 0, updatedAt: null,
      config: { fields: { vmidFieldId: null, outputAttachmentFieldId: null },
        approval: { department: "动画组", reason: "切片剪辑" },
        stages: { initial: { enabled: true, statusFieldId: null, triggerOptionId: null, instructionFieldId: null }, review: { enabled: false, statusFieldId: null, triggerOptionId: null, instructionFieldId: null, instructionAttachmentsFieldId: null } } } };
  }
  function packages(): FeishuPackageSummary[] {
    const common = { name: "文档剪辑", projectId: "project", workspacePath: "E:\\workspace", model: "model", reasoningEffort: null, prompt: "prompt", zipSourceDirectory: "E:\\output", maxConcurrent: 1, resourceGroups: [], revision: 1, updatedAt: "now", referenceCount: 0, references: [] };
    return [{ ...common, alias: "old-package", state: "enabled" }, { ...common, name: "VM 剪辑包", alias: "vm-package", state: "draft", workflowTemplate: template }];
  }
  it("activates only the selected saved VM initial profile and displays its active configuration", async () => {
    const configured = { ...subject("vm-enable", "初稿启用"), preferredPackageAlias: "vm-package",
      activePackageAlias: "old-package", activeConfigVersion: 1 };
    const metadata = [
      { fieldId: "vmid", fieldName: "VMID", type: 1, uiType: "Text", options: [] },
      { fieldId: "name", fieldName: "名称", type: 1, uiType: "Text", options: [] },
      { fieldId: "output", fieldName: "成片", type: 17, uiType: "Attachment", options: [] },
      { fieldId: "instruction", fieldName: "初稿意见", type: 1, uiType: "Text", options: [] },
      { fieldId: "status", fieldName: "制作进度", type: 3, uiType: "SingleSelect", options: [{ id: "ready", name: "待剪辑" }] },
    ];
    configured.metadata = { fields: metadata };
    vi.mocked(listFeishuPackages).mockResolvedValue(packages().map((item) => ({ ...item, state: "enabled" })));
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => ({ ...profile(key, alias), revision: 3,
      config: { ...profile(key, alias).config,
        fields: { vmidFieldId: "vmid", namingFieldId: "name", outputAttachmentFieldId: "output" },
        stages: { initial: { enabled: true, statusFieldId: "status", triggerOptionId: "ready", instructionFieldId: "instruction" },
          review: profile(key, alias).config.stages.review } } }));
    const enabled = { ...configured, configVersion: 2, activeConfigVersion: 2, activePackageAlias: "vm-package",
      lifecycle: "enabled" as const, workflowTemplate: template };
    vi.mocked(enableFeishuPackageWorkflowDraft).mockResolvedValue(enabled);
    const onSubjectChange = vi.fn();
    const props = { catalog: catalog(configured), configurationBaseToken: "bas_test", selectedSubjectKey: configured.subjectKey,
      onSelectSubject: vi.fn(), onCatalogChange: vi.fn(), onSubjectChange };
    const view = render(<FeishuWorkflowPanel {...props} vmPmoInitialReady />);
    await screen.findByRole("group", { name: "视频来源" });
    expect(screen.getByText("流程草稿")).toBeTruthy();
    expect((screen.getByRole("button", { name: "启用流程" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "启用流程" }));
    await waitFor(() => expect(onSubjectChange).toHaveBeenCalledWith(enabled));
    expect(enableFeishuPackageWorkflowDraft).toHaveBeenCalledWith(configured.subjectKey, "vm-package", 3, configured.configVersion);
    expect(saveFeishuSubjectDraft).not.toHaveBeenCalled();
    view.rerender(<FeishuWorkflowPanel {...props} catalog={catalog(enabled)} vmPmoInitialReady />);
    expect(screen.queryByText("流程草稿")).toBeNull();
    expect(within(screen.getByRole("region", { name: "学科配置" })).getByText("已启用")).toBeTruthy();
    expect(screen.getByLabelText("当前生效流程").textContent).toContain("vm-package · 配置版本 2");
  });
  it("exports a loaded saved VM profile and reloads it after importing without a subject version change", async () => {
    vi.mocked(listFeishuPackages).mockResolvedValue(packages());
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => ({ ...profile(key, alias), revision: 1 }));
    const configured = subject("vm-import", "VM 目标"); configured.packageRoute!.packageAlias = "vm-package";
    const props = { catalog: catalog(configured), configurationBaseToken: "bas_test", selectedSubjectKey: configured.subjectKey,
      onSelectSubject: vi.fn(), onCatalogChange: vi.fn(), onSubjectChange: vi.fn() };
    const view = render(<FeishuWorkflowPanel {...props} />);
    await screen.findByRole("textbox", { name: "申请原因" });
    await waitFor(() => expect((screen.getByRole("button", { name: "导出学科配置" }) as HTMLButtonElement).disabled).toBe(false));
    const configuration = { kind: "feishu-subject-workflow" as const, schemaVersion: 1 as const,
      source: { subjectKey: "source-vm", baseName: "来源 Base", tableName: "VM 来源", metadata: { fields } },
      packageAlias: "vm-package", workflowTemplate: template, config: profile("source-vm").config };
    vi.mocked(importFeishuSubjectWorkflowShare).mockImplementation(async (input) => ({ configuration,
      source: configuration.source, target: { subjectKey: configured.subjectKey, baseName: configured.baseName, tableName: configured.tableName },
      packageAlias: "vm-package", workflowTemplate: template, expectedVersion: 1, expectedRevision: 1,
      diagnostics: [], diagnosticsOk: true, dryRun: input.dryRun, ...(input.dryRun ? {} : { catalog: props.catalog }) }));
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => {
      const next = profile(key, alias); next.revision = 2; next.config.approval.reason = "导入的申请原因"; return next;
    });
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [{ text: async () => JSON.stringify(configuration) }] } });
    const dialog = await screen.findByRole("dialog", { name: "学科配置导入预览" });
    const confirm = within(dialog).getByRole("button", { name: "确认导入草稿" }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false)); fireEvent.click(confirm);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "申请原因" }) as HTMLInputElement).value).toBe("导入的申请原因"));
  });
  it("keeps VM drafts separate, restores unsaved forms and saves only the selected package draft", async () => {
    vi.mocked(listFeishuPackages).mockResolvedValue(packages());
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => profile(key, alias));
    vi.mocked(saveFeishuPackageWorkflowDraft).mockImplementation(async (key, alias, _revision, config) => ({ ...profile(key, alias), revision: 1, config }));
    const first = subject("vm-first", "化学"); first.packageRoute!.packageAlias = "old-package";
    const second = subject("vm-second", "物理"); second.packageRoute!.packageAlias = "old-package";
    const onSaveDraft = vi.fn(); const onSubjectChange = vi.fn();
    const props = { catalog: catalog(first, second), configurationBaseToken: "bas_test", onSelectSubject: vi.fn(), onCatalogChange: vi.fn(), onSubjectChange, onSaveDraft };
    const view = render(<FeishuWorkflowPanel {...props} selectedSubjectKey={first.subjectKey} />);
    await screen.findByRole("option", { name: "VM 剪辑包" });
    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "4" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "vm-package" } });
    await screen.findByRole("textbox", { name: "申请部门" });
    expect(screen.queryByRole("combobox", { name: "ZIP 获取方式" })).toBeNull();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["基础与执行", "素材与阶段", "存储与目录", "飞书回写"]);
    expect((screen.getByRole("button", { name: "启用流程" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "申请原因" }), { target: { value: "化学片段" } });
    fireEvent.change(screen.getByRole("combobox", { name: "VMID 字段" }), { target: { value: "fld_text" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "old-package" } });
    expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("4");
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "vm-package" } });
    expect((await screen.findByRole("textbox", { name: "申请原因" }) as HTMLInputElement).value).toBe("化学片段");
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    expect(saveFeishuPackageWorkflowDraft).toHaveBeenCalledWith(first.subjectKey, "vm-package", 0, expect.objectContaining({ fields: expect.objectContaining({ vmidFieldId: "fld_text" }), approval: { department: "动画组", reason: "化学片段" } }));
    expect(onSaveDraft).not.toHaveBeenCalled(); expect(onSubjectChange).not.toHaveBeenCalled();
    view.rerender(<FeishuWorkflowPanel {...props} selectedSubjectKey={second.subjectKey} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "vm-package" } });
    expect((await screen.findByRole("textbox", { name: "申请原因" }) as HTMLInputElement).value).toBe("切片剪辑");
    fireEvent.change(screen.getByRole("textbox", { name: "申请原因" }), { target: { value: "物理片段" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    expect(saveFeishuPackageWorkflowDraft).toHaveBeenLastCalledWith(second.subjectKey, "vm-package", 0,
      expect.objectContaining({ fields: expect.objectContaining({ vmidFieldId: null }), approval: { department: "动画组", reason: "物理片段" } }));
  });
  it("reopens a saved VM draft after switching subjects and reopening the panel without changing the active route", async () => {
    vi.mocked(listFeishuPackages).mockResolvedValue(packages());
    const savedProfiles = new Map<string, FeishuPackageWorkflowDraft>();
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => savedProfiles.get(`${key}:${alias}`) ?? profile(key, alias));
    vi.mocked(saveFeishuPackageWorkflowDraft).mockImplementation(async (key, alias, _revision, config) => {
      const saved: FeishuPackageWorkflowDraft = { ...profile(key, alias), revision: 1,
        config: config as FeishuPackageWorkflowDraft["config"] };
      savedProfiles.set(`${key}:${alias}`, saved);
      return saved;
    });
    const first = subject("vm-saved-first", "初中数学"); first.packageRoute!.packageAlias = "old-package";
    const second = subject("vm-saved-second", "初中物理"); second.packageRoute!.packageAlias = "old-package";
    let currentCatalog = catalog(first, second);
    const onCatalogChange = vi.fn((next: FeishuBaseCatalog[]) => { currentCatalog = next; });
    const props = { configurationBaseToken: "bas_test", onSelectSubject: vi.fn(), onCatalogChange, onSubjectChange: vi.fn() };
    const view = render(<FeishuWorkflowPanel {...props} catalog={currentCatalog} selectedSubjectKey={first.subjectKey} />);
    await screen.findByRole("option", { name: "VM 剪辑包" });
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "vm-package" } });
    fireEvent.change(await screen.findByRole("textbox", { name: "申请原因" }), { target: { value: "已保存的数学意见" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    await waitFor(() => expect(onCatalogChange).toHaveBeenCalledTimes(1));
    expect(currentCatalog[0].subjects[0]).toMatchObject({
      preferredPackageAlias: "vm-package", packageRoute: { packageAlias: "old-package" },
    });
    view.rerender(<FeishuWorkflowPanel {...props} catalog={currentCatalog} selectedSubjectKey={second.subjectKey} />);
    view.rerender(<FeishuWorkflowPanel {...props} catalog={currentCatalog} selectedSubjectKey={first.subjectKey} />);
    expect((screen.getByRole("combobox", { name: "Auto-Cut 包" }) as HTMLSelectElement).value).toBe("vm-package");
    view.unmount();
    render(<FeishuWorkflowPanel {...props} catalog={currentCatalog} selectedSubjectKey={first.subjectKey} />);
    expect((screen.getByRole("combobox", { name: "Auto-Cut 包" }) as HTMLSelectElement).value).toBe("vm-package");
    expect((await screen.findByRole("textbox", { name: "申请原因" }) as HTMLInputElement).value).toBe("已保存的数学意见");
  });
  it("shows loading errors and preserves draft edits on a version conflict", async () => {
    vi.mocked(listFeishuPackages).mockResolvedValue(packages());
    vi.mocked(getFeishuPackageWorkflowDraft).mockRejectedValueOnce(new Error("private details"));
    const configured = subject("vm-error", "错误测试"); configured.packageRoute!.packageAlias = "vm-package";
    render(<FeishuWorkflowPanel catalog={catalog(configured)} configurationBaseToken="bas_test" selectedSubjectKey={configured.subjectKey} onSelectSubject={vi.fn()} onCatalogChange={vi.fn()} onSubjectChange={vi.fn()} onSaveDraft={vi.fn()} />);
    await screen.findByText("流程草稿读取或保存失败，请重试。");
    expect(screen.queryByText("private details")).toBeNull();
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(profile(configured.subjectKey));
    fireEvent.click(screen.getByRole("button", { name: "重新加载流程草稿" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "申请原因" }), { target: { value: "保留修改" } });
    vi.mocked(saveFeishuPackageWorkflowDraft).mockRejectedValue(new ApiError(409, { error: { code: "VERSION_CONFLICT" } }));
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("草稿已被其他窗口修改。请重新加载后再保存。");
    expect((screen.getByRole("textbox", { name: "申请原因" }) as HTMLInputElement).value).toBe("保留修改");
  });
  it("keeps the host error on refresh failure and clears it only after a successful refresh", async () => {
    vi.mocked(listFeishuPackages).mockResolvedValue(packages());
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => profile(key, alias));
    vi.mocked(saveFeishuPackageWorkflowDraft).mockRejectedValue(new ApiError(400, { error: { code: "INVALID_FIELD" } }));
    const configured = subject("vm-refresh-error", "刷新测试"); configured.packageRoute!.packageAlias = "vm-package";
    const restored = catalog(configured)[0];
    function Host() {
      const [bases, setBases] = useState(catalog(configured));
      const [error, setError] = useState<string | null>(null);
      const recovery = { onErrorClear: (message?: string) => setError((current) => current === message ? null : current) };
      return <>{error && <p role="alert" aria-label="Host configuration error">{error}</p>}
        <FeishuWorkflowPanel catalog={bases} configurationBaseToken="bas_test" selectedSubjectKey={configured.subjectKey}
          onSelectSubject={vi.fn()} onCatalogChange={setBases} onSubjectChange={vi.fn()} onSaveDraft={vi.fn()}
          onError={setError} {...recovery} /></>;
    }
    render(<Host />);
    await screen.findByRole("textbox", { name: "申请原因" });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByRole("alert", { name: "Host configuration error" });
    vi.mocked(refreshFeishuBaseFields).mockRejectedValueOnce(new Error("Refresh failed"));
    fireEvent.click(screen.getByRole("button", { name: "刷新字段" }));
    await screen.findByRole("alert", { name: "字段刷新状态" });
    expect(screen.getByRole("alert", { name: "Host configuration error" })).toBeTruthy();
    vi.mocked(refreshFeishuBaseFields).mockResolvedValueOnce(restored);
    fireEvent.click(screen.getByRole("button", { name: "刷新字段" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "字段刷新状态" }).textContent).toContain("刷新成功"));
    expect(screen.queryByRole("alert", { name: "Host configuration error" })).toBeNull();
  });
  it("does not clear a later workflow error when an earlier field refresh succeeds", async () => {
    vi.mocked(listFeishuPackages).mockResolvedValue(packages());
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => profile(key, alias));
    vi.mocked(saveFeishuPackageWorkflowDraft)
      .mockRejectedValueOnce(new ApiError(400, { error: { code: "INVALID_FIELD" } }))
      .mockRejectedValueOnce(new ApiError(400, { error: { code: "INVALID_FIELD" } }));
    const reportError = vi.fn();
    const configured = subject("vm-refresh-race", "刷新竞态"); configured.packageRoute!.packageAlias = "vm-package";
    let finish!: (base: FeishuBaseCatalog) => void;
    vi.mocked(refreshFeishuBaseFields).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    function Host() {
      const [bases, setBases] = useState(catalog(configured));
      const [error, setError] = useState<string | null>(null);
      const recovery = { onErrorClear: (message?: string) => setError((current) => current === message ? null : current) };
      return <>{error && <p role="alert" aria-label="Host configuration error">{error}</p>}
        <FeishuWorkflowPanel catalog={bases} configurationBaseToken="bas_test" selectedSubjectKey={configured.subjectKey}
          onSelectSubject={vi.fn()} onCatalogChange={setBases} onSubjectChange={vi.fn()} onSaveDraft={vi.fn()}
          onError={(message) => { reportError(message); setError(message); }} {...recovery} /></>;
    }
    render(<Host />);
    await screen.findByRole("textbox", { name: "申请原因" });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByRole("alert", { name: "Host configuration error" });
    fireEvent.click(screen.getByRole("button", { name: "刷新字段" }));
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await waitFor(() => expect(reportError).toHaveBeenCalledTimes(2));
    finish(catalog(configured)[0]);
    await waitFor(() => expect(screen.getByRole("status", { name: "字段刷新状态" }).textContent).toContain("刷新成功"));
    expect(screen.getByRole("alert", { name: "Host configuration error" }).textContent).toContain("配置不完整或无效");
  });
  it.each([false, true])("clears a recovered VM save error after remounting its package (finish while away: %s)", async (finishWhileAway) => {
    vi.mocked(listFeishuPackages).mockResolvedValue(packages());
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => profile(key, alias));
    let finish!: (value: FeishuPackageWorkflowDraft) => void;
    vi.mocked(saveFeishuPackageWorkflowDraft)
      .mockRejectedValueOnce(new ApiError(400, { error: { code: "INVALID_FIELD" } }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const configured = subject("vm-remount-recovery", "重挂载恢复"); configured.packageRoute!.packageAlias = "vm-package";
    function Host() {
      const [error, setError] = useState<{ message: string; context?: string } | null>(null);
      return <>{error && <p role="alert" aria-label="Host configuration error">{error.message}</p>}
        <FeishuWorkflowPanel catalog={catalog(configured)} configurationBaseToken="bas_test" selectedSubjectKey={configured.subjectKey}
          onSelectSubject={vi.fn()} onCatalogChange={vi.fn()} onSubjectChange={vi.fn()} onSaveDraft={vi.fn()}
          onError={(message, context) => setError({ message, context })}
          onErrorClear={(message, context) => setError((current) => current !== null && current.message === message && current.context === context ? null : current)} /></>;
    }
    render(<Host />);
    await screen.findByRole("textbox", { name: "申请原因" });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByRole("alert", { name: "Host configuration error" });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "old-package" } });
    await screen.findByRole("combobox", { name: "ZIP 获取方式" });
    if (finishWhileAway) await act(async () => { finish({ ...profile(configured.subjectKey), revision: 1 }); });
    expect(screen.getByRole("alert", { name: "Host configuration error" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "vm-package" } });
    if (!finishWhileAway) await act(async () => { finish({ ...profile(configured.subjectKey), revision: 1 }); });
    await screen.findByText("流程草稿已保存。");
    expect(screen.queryByRole("alert", { name: "Host configuration error" })).toBeNull();
  });
  it("ignores stale responses after switching package and keeps obsolete field bindings repairable", async () => {
    vi.mocked(listFeishuPackages).mockResolvedValue(packages());
    let resolveFirst: (value: FeishuPackageWorkflowDraft) => void = () => {};
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    const configured = subject("stale-vm", "化学"); configured.packageRoute!.packageAlias = "old-package";
    render(<FeishuWorkflowPanel catalog={catalog(configured)} configurationBaseToken="bas_test" selectedSubjectKey={configured.subjectKey} onSelectSubject={vi.fn()} onCatalogChange={vi.fn()} onSubjectChange={vi.fn()} onSaveDraft={vi.fn()} />);
    await screen.findByRole("option", { name: "VM 剪辑包" });
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "vm-package" } });
    await waitFor(() => expect(getFeishuPackageWorkflowDraft).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "old-package" } });
    const old = profile(configured.subjectKey); old.config.approval.reason = "过期响应";
    resolveFirst(old);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "ZIP 获取方式" })).toBeTruthy());
    expect(screen.queryByRole("textbox", { name: "申请原因" })).toBeNull();
    const stale = profile(configured.subjectKey); stale.config.fields.vmidFieldId = "deleted-field";
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(stale);
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "vm-package" } });
    expect((await screen.findByRole("combobox", { name: "VMID 字段" }) as HTMLSelectElement).value).toBe("deleted-field");
    expect(screen.getByRole("option", { name: "原字段已不可用，请重新选择" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "VMID 字段" }), { target: { value: "fld_text" } });
    expect((screen.getByRole("combobox", { name: "VMID 字段" }) as HTMLSelectElement).value).toBe("fld_text");
    expect((screen.getByRole("textbox", { name: "申请原因" }) as HTMLInputElement).value).toBe("切片剪辑");
  });
  it("does not render the document workflow for an unsupported explicit template", async () => {
    const unsupported = packages();
    unsupported[0].workflowTemplate = { id: "future_workflow", version: 2 } as unknown as FeishuPackageSummary["workflowTemplate"];
    vi.mocked(listFeishuPackages).mockResolvedValue(unsupported);
    const configured = subject("unknown-template", "未知流程"); configured.packageRoute!.packageAlias = "old-package";
    render(<FeishuWorkflowPanel catalog={catalog(configured)} configurationBaseToken="bas_test" selectedSubjectKey={configured.subjectKey} onSelectSubject={vi.fn()} onCatalogChange={vi.fn()} onSubjectChange={vi.fn()} />);
    await screen.findByText("此包的工作流程版本暂不支持，请重新选择包。");
    expect(screen.queryByRole("combobox", { name: "ZIP 获取方式" })).toBeNull();
    expect(screen.queryByRole("button", { name: "保存草稿" })).toBeNull();
  });
});

const fields = [
  {
    fieldId: "fld_status",
    fieldName: "流程状态",
    type: 3,
    uiType: "SingleSelect",
    options: [
      { id: "opt_initial", name: "初稿" },
      { id: "opt_review", name: "初审修改" },
      { id: "opt_final", name: "终审修改" },
    ],
  },
  { fieldId: "fld_text", fieldName: "普通文本", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_video", fieldName: "视频附件", type: 17, uiType: "Attachment", options: [] },
  { fieldId: "fld_audio", fieldName: "配音附件", type: 17, uiType: null, options: [] },
  { fieldId: "fld_fake_attachment_type", fieldName: "伪附件类型", type: 1, uiType: "Attachment", options: [] },
  { fieldId: "fld_fake_attachment_ui", fieldName: "伪附件界面", type: 17, uiType: "Text", options: [] },
  { fieldId: "fld_fake_status_type", fieldName: "伪状态类型", type: 4, uiType: "SingleSelect", options: [] },
  { fieldId: "fld_fake_status_ui", fieldName: "伪状态界面", type: 3, uiType: "MultiSelect", options: [] },
];

const stage: FeishuStageValue = {
  enabled: true,
  trigger: { fieldId: "fld_status", fieldName: "流程状态", optionId: "opt_initial", value: "初稿" },
  videoSource: { kind: "docx_section", anchorText: "录屏" },
  reviewSource: { kind: "docx_section", anchorText: "修改意见" },
  audio: { mode: "video_original" },
  artifactTargetPath: "C:\\approved\\initial",
  nameSuffix: "_初稿",
};

function stageMap(): FeishuStageConfigMap {
  return {
    initial: structuredClone(stage),
    first_review: {
      ...structuredClone(stage),
      enabled: false,
      trigger: { fieldId: "fld_status", fieldName: "流程状态", optionId: "opt_review", value: "初审修改" },
      nameSuffix: "_初审修改",
    },
    final_review: {
      ...structuredClone(stage),
      enabled: false,
      trigger: { fieldId: "fld_status", fieldName: "流程状态", optionId: "opt_final", value: "终审修改" },
      nameSuffix: "_终审修改",
    },
  };
}

function subject(subjectKey: string, tableName: string): FeishuSubjectConfig {
  return {
    subjectKey,
    baseToken: "bas_test",
    baseName: "测试 Base",
    tableId: `tbl_${subjectKey}`,
    tableName,
    projectId: `project_${subjectKey}`,
    displayEnabled: true,
    lifecycle: "draft",
    configVersion: 1,
    statusField: { fieldId: "fld_status", fieldName: "流程状态" },
    documentField: { fieldId: "fld_text", fieldName: "普通文本" },
    namingField: { fieldId: "fld_text", fieldName: "普通文本" },
    stages: stageMap(),
    trigger: { fieldId: "fld_status", fieldName: "流程状态", startValue: "初稿", optionId: "opt_initial" },
    title: { fieldId: null, fieldName: null },
    execution: { mode: "manual", concurrencyGroup: "default", maxConcurrent: 1, resourceGroups: [] },
    packageRoute: { routeMode: "fixed", packageAlias: "", subjectCodeFieldId: null, branchMap: null },
    upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 },
    metadata: { fields },
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
}

function legacySubject(subjectKey: string, tableName: string): FeishuSubjectConfig {
  const configured = subject(subjectKey, tableName);
  const {
    statusField: _statusField,
    documentField: _documentField,
    namingField: _namingField,
    stages: _stages,
    ...legacy
  } = configured;
  return legacy;
}

function catalog(...subjects: FeishuSubjectConfig[]): FeishuBaseCatalog[] {
  return [{
    baseToken: "bas_test",
    baseName: "测试 Base",
    sourceUrlLabel: null,
    metadataRefreshedAt: null,
    subjects,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
  }];
}

function ControlledEditor({
  initialStage = stage,
  metadataFields = fields,
  onStageChange = vi.fn(),
}: {
  initialStage?: FeishuStageValue;
  metadataFields?: typeof fields;
  onStageChange?: (value: FeishuStageValue, draft: FeishuStageAudioDraft) => void;
}) {
  const [value, setValue] = useState(initialStage);
  const [audioDraft, setAudioDraft] = useState(() => audioDraftFromStage(initialStage.audio));
  return <FeishuStageEditor
    stageId="initial"
    value={value}
    metadataFields={metadataFields}
    statusOptions={fields[0].options}
    disabled={false}
    audioDraft={audioDraft}
    onChange={setValue}
    onAudioChange={(audio, draft) => {
      const next = { ...value, audio };
      setValue(next);
      setAudioDraft(draft);
      onStageChange(next, draft);
    }}
    validationErrors={[]}
  />;
}

function selectSubjectSettingsTab(name: "基础与执行" | "素材与阶段" | "存储与目录" | "飞书回写") {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("independent ZIP package profiles", () => {
  const template = { id: "document_draft_zip", version: 1 } as const;
  const packageList = ["zip-a", "zip-b", "zip-disabled"].map((alias) => ({
    alias, name: alias, projectId: alias, workspacePath: null, model: null, reasoningEffort: null, prompt: null,
    zipSourceDirectory: null, maxConcurrent: 1, resourceGroups: [], state: alias === "zip-disabled" ? "disabled" : "enabled",
    revision: 1, updatedAt: "now", referenceCount: 0, references: [], workflowTemplate: template,
  })) as FeishuPackageSummary[];
  function zipProfile(key: string, alias: string, revision = 2) {
    const source = subject(key, key);
    return { subjectKey: key, packageAlias: alias, workflowTemplate: template, revision, updatedAt: null,
      config: { trigger: source.trigger, title: source.title, execution: source.execution,
        packageRoute: { ...source.packageRoute!, packageAlias: alias },
        upload: { ...source.upload!, uploadConcurrency: alias === "zip-b" ? 2 : 1 },
        statusField: source.statusField, documentField: source.documentField, namingField: source.namingField,
        stages: source.stages, delivery: null } };
  }
  function setup(profileFor = zipProfile, extra: Partial<ComponentProps<typeof FeishuWorkflowPanel>> = {}, packages = packageList) {
    const a = subject("profile-subject", "配置学科");
    a.packageRoute!.packageAlias = "zip-a"; a.lifecycle = "enabled";
    Object.assign(a, { activePackageAlias: "zip-a", activeConfigVersion: 1 });
    const b = subject("other-subject", "另一个学科"); b.packageRoute!.packageAlias = "zip-a";
    vi.mocked(listFeishuPackages).mockResolvedValue(packages);
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => profileFor(key, alias) as never);
    vi.mocked(saveFeishuPackageWorkflowDraft).mockImplementation(async (key, alias, revision, config) => ({ ...zipProfile(key, alias, revision + 1), config }) as never);
    const onSubjectChange = vi.fn(); const onSelectSubject = vi.fn();
    const props = { catalog: catalog(a, b), configurationBaseToken: "bas_test", selectedSubjectKey: a.subjectKey, onSelectSubject, onCatalogChange: vi.fn(), onSubjectChange };
    return { a, b, props, ...render(<FeishuWorkflowPanel {...props} {...extra} />) };
  }
  afterEach(() => { cleanup(); vi.clearAllMocks(); vi.mocked(listFeishuPackages).mockResolvedValue([]); });
  it.each(["document", "naming", "option", "video", "audio"] as const)("saves a repairable ZIP draft with a missing %s binding and retains it after reopening", async (missing) => {
    const makeProfile = (key: string, alias: string) => {
      const profile = zipProfile(key, alias);
      if (missing === "document") profile.config.documentField = { fieldId: "pending_document_field", fieldName: "待配置" };
      if (missing === "naming") profile.config.namingField = { fieldId: "pending_naming_field", fieldName: "待配置" };
      if (missing === "option") profile.config.stages!.initial.trigger = { ...profile.config.stages!.initial.trigger, optionId: null, value: "" };
      if (missing === "video") profile.config.stages!.initial.videoSource = { kind: "base_attachment", fieldId: "" };
      if (missing === "audio") profile.config.stages!.initial.audio = { mode: "replace_original", source: { kind: "base_attachment", fieldId: "" }, durationToleranceSeconds: 3 };
      return profile;
    };
    const { props, unmount } = setup(makeProfile);
    vi.mocked(saveFeishuPackageWorkflowDraft).mockImplementation(async (key, alias, revision, config) => {
      const saved = structuredClone(config) as NonNullable<ReturnType<typeof zipProfile>["config"]>;
      if (missing === "document") saved.documentField = { fieldId: "pending_document_field", fieldName: "待配置" };
      if (missing === "naming") saved.namingField = { fieldId: "pending_naming_field", fieldName: "待配置" };
      if (missing === "option") {
        saved.stages!.initial.trigger = { ...saved.stages!.initial.trigger, optionId: "pending_initial_option", value: "待配置" };
        saved.trigger = { ...saved.trigger!, optionId: "pending_initial_option", startValue: "待配置" };
      }
      if (missing === "video") saved.stages!.initial.videoSource = { kind: "base_attachment", fieldId: "pending_attachment_field" };
      if (missing === "audio") saved.stages!.initial.audio = { mode: "replace_original", source: { kind: "base_attachment", fieldId: "pending_attachment_field" }, durationToleranceSeconds: 3 };
      return { ...zipProfile(key, alias, revision + 1), config: saved } as never;
    });
    await screen.findByText("草稿版本 2");
    selectSubjectSettingsTab("素材与阶段");
    fireEvent.change(screen.getByRole("textbox", { name: "初稿命名后缀" }), { target: { value: "_保留的修改" } });
    expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("status", { name: "配置待修复项" }).textContent).toContain("可先保存草稿");
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("草稿版本 3");
    expect(saveFeishuPackageWorkflowDraft).toHaveBeenCalledTimes(1);
    expect(props.onSubjectChange).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/有尚未保存的修改/)).toBeNull();
    const saved = await vi.mocked(saveFeishuPackageWorkflowDraft).mock.results[0].value;
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(saved);
    unmount();
    render(<FeishuWorkflowPanel {...props} />);
    await screen.findByText("草稿版本 3");
    selectSubjectSettingsTab("素材与阶段");
    expect((screen.getByRole("textbox", { name: "初稿命名后缀" }) as HTMLInputElement).value).toBe("_保留的修改");
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/有尚未保存的修改/)).toBeNull();
  });
  it("recovers a bound ZIP package after the package list times out", async () => {
    const configured = subject("package-retry", "高中历史");
    configured.packageRoute!.packageAlias = "zip-a";
    vi.mocked(listFeishuPackages).mockRejectedValueOnce(new Error("private timeout details"))
      .mockResolvedValue(packageList);
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => zipProfile(key, alias) as never);
    const onError = vi.fn(); const onErrorClear = vi.fn();
    render(<FeishuWorkflowPanel catalog={catalog(configured)} configurationBaseToken="bas_test"
      selectedSubjectKey={configured.subjectKey} onSelectSubject={vi.fn()} onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()} onError={onError} onErrorClear={onErrorClear} />);
    const retry = await screen.findByRole("button", { name: "重试读取包列表" });
    expect(screen.getByText("无法读取 Auto-Cut 包列表，请重试。")).toBeTruthy();
    expect(screen.queryByText("private timeout details")).toBeNull();
    expect(onError).toHaveBeenCalledWith("无法读取 Auto-Cut 包列表，请重试。",
      JSON.stringify([configured.subjectKey, "zip-a", "document_draft_zip", 1]));
    fireEvent.click(retry);
    await screen.findByText("草稿版本 2");
    expect((screen.getByRole("combobox", { name: "Auto-Cut 包" }) as HTMLSelectElement).value).toBe("zip-a");
    expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "重试读取包列表" })).toBeNull();
    expect(onErrorClear).toHaveBeenCalledWith("无法读取 Auto-Cut 包列表，请重试。",
      JSON.stringify([configured.subjectKey, "zip-a", "document_draft_zip", 1]));
  });
  it("removes a deleted package from route choices and asks for a current package without rebinding", async () => {
    const configured = subject("missing-package", "初中数学");
    configured.packageRoute!.packageAlias = "Auto-cut-A";
    vi.mocked(listFeishuPackages).mockResolvedValue(packageList);
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => zipProfile(key, alias) as never);
    render(<FeishuWorkflowPanel catalog={catalog(configured)} configurationBaseToken="bas_test"
      selectedSubjectKey={configured.subjectKey} onSelectSubject={vi.fn()} onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()} />);
    await screen.findByRole("option", { name: "zip-a" });
    const selector = screen.getByRole("combobox", { name: "Auto-Cut 包" }) as HTMLSelectElement;
    expect(selector.value).toBe("");
    expect(within(selector).queryByRole("option", { name: /Auto-cut-A/ })).toBeNull();
    expect(within(selector).getAllByRole("option").map((option) => (option as HTMLOptionElement).value))
      .toEqual(["", "zip-a", "zip-b", "zip-disabled"]);
    expect(screen.getByLabelText("当前编辑流程").textContent).toContain("未选择");
    expect(getFeishuPackageWorkflowDraft).not.toHaveBeenCalled();
    expect(saveFeishuPackageWorkflowDraft).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Auto-cut-A");
    expect(screen.getByRole("status").textContent).toContain("Auto-Cut 包");
    expect(screen.queryByRole("button", { name: "保存草稿" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-a" } });
    await screen.findByText("草稿版本 2");
    expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("waits for the package list before declaring the selected package unavailable", async () => {
    const configured = subject("loading-package", "初中数学");
    configured.packageRoute!.packageAlias = "Auto-cut-A";
    let resolvePackages!: (packages: FeishuPackageSummary[]) => void;
    vi.mocked(listFeishuPackages).mockReturnValue(new Promise((resolve) => { resolvePackages = resolve; }));
    render(<FeishuWorkflowPanel catalog={catalog(configured)} configurationBaseToken="bas_test"
      selectedSubjectKey={configured.subjectKey} onSelectSubject={vi.fn()} onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()} />);
    expect(screen.getByText("正在读取本机 Auto-Cut 包…")).toBeTruthy();
    expect(screen.queryByText(/旧配置引用的包 Auto-cut-A 已不在当前包列表中/)).toBeNull();
    resolvePackages(packageList);
    await screen.findByText(/旧配置引用的包 Auto-cut-A 已不在当前包列表中/);
  });
  it("reopens the last saved package draft after navigating away", async () => {
    const configured = subject("saved-package", "初中数学");
    configured.packageRoute!.packageAlias = "Auto-cut-A";
    Object.assign(configured, { preferredPackageAlias: "zip-a" });
    vi.mocked(listFeishuPackages).mockResolvedValue(packageList);
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => zipProfile(key, alias) as never);
    const props = { catalog: catalog(configured), configurationBaseToken: "bas_test",
      selectedSubjectKey: configured.subjectKey, onSelectSubject: vi.fn(),
      onCatalogChange: vi.fn(), onSubjectChange: vi.fn() };
    const view = render(<FeishuWorkflowPanel {...props} />);
    await screen.findByText("草稿版本 2");
    expect((screen.getByRole("combobox", { name: "Auto-Cut 包" }) as HTMLSelectElement).value).toBe("zip-a");
    view.unmount();
    render(<FeishuWorkflowPanel {...props} />);
    await screen.findByText("草稿版本 2");
    expect((screen.getByRole("combobox", { name: "Auto-Cut 包" }) as HTMLSelectElement).value).toBe("zip-a");
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeTruthy();
  });
  it("keeps draft and active versions distinct after a metadata refresh", async () => {
    const configured = subject("active-draft", "初中化学");
    configured.packageRoute!.packageAlias = "zip-a";
    configured.lifecycle = "draft";
    configured.configVersion = 11;
    Object.assign(configured, { activeConfigVersion: 10, activePackageAlias: "zip-a" });
    vi.mocked(listFeishuPackages).mockResolvedValue(packageList);
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => zipProfile(key, alias) as never);
    render(<FeishuWorkflowPanel catalog={catalog(configured)} configurationBaseToken="bas_test"
      selectedSubjectKey={configured.subjectKey} onSelectSubject={vi.fn()} onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()} />);
    await screen.findByText("草稿版本 2");
    expect(screen.getByRole("button", { name: "初中化学已启用旧版 · 有草稿" })).toBeTruthy();
    expect(screen.getByRole("banner").querySelector("[data-lifecycle]")?.getAttribute("data-lifecycle")).toBe("enabled");
    expect(screen.getByText("当前学科草稿版本 11")).toBeTruthy();
    expect(screen.getByLabelText("当前生效流程").textContent).toContain("配置版本 10");
    expect(screen.getByText("当前生效版本仍在运行；草稿需重新启用后才会替换。")).toBeTruthy();
  });
  it("allows a repairable naming-field draft to save while blocking activation", async () => {
    setup((key, alias) => {
      const profile = zipProfile(key, alias);
      profile.config.namingField = { fieldId: "fld_status", fieldName: "流程状态" };
      return profile;
    });
    await screen.findByText("草稿版本 2");
    expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(false);
    const enable = screen.getByRole("button", { name: "启用" }) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    expect(enable.title).toContain("命名字段");
    const blocker = screen.getByRole("status", { name: "配置待修复项" });
    expect(blocker.closest(".feishu-subject-actions")).toBe(enable.parentElement);
    expect(blocker.textContent)
      .toContain("启用前请修复：命名字段需要文本或公式字段");
    expect(enableFeishuPackageWorkflowDraft).not.toHaveBeenCalled();
  });
  it("shows the activation blocker beside the actions when a draft has unsaved edits", async () => {
    setup();
    await screen.findByText("草稿版本 2");
    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "3" } });
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status", { name: "配置待修复项" }).textContent).toContain("请先保存草稿");
  });
  function portableShare() {
    return { kind: "feishu-subject-workflow" as const, schemaVersion: 1 as const,
      source: { subjectKey: "removed-source", baseName: "旧 Base", tableName: "旧物理", metadata: { fields } },
      packageAlias: "zip-a", workflowTemplate: template, config: zipProfile("removed-source", "zip-a").config };
  }
  function mockSubjectImport(configuration: ReturnType<typeof portableShare>, nextCatalog: FeishuBaseCatalog[], diagnostics: Array<{ severity: "error" | "warning"; code: string; path: string; message: string }> = []) {
    vi.mocked(importFeishuSubjectWorkflowShare).mockImplementation(async (input) => ({
      configuration, diagnostics, diagnosticsOk: !diagnostics.some((diagnostic) => diagnostic.severity === "error"), dryRun: input.dryRun,
      source: configuration.source, target: { subjectKey: input.targetSubjectKey, baseName: "测试 Base", tableName: "配置学科" },
      packageAlias: configuration.packageAlias, workflowTemplate: template, expectedVersion: 1, expectedRevision: 2,
      ...(input.dryRun ? {} : { catalog: nextCatalog }),
    }));
  }
  function uploadShare(view: ReturnType<typeof setup>, configuration: unknown) {
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("subject import file input missing");
    fireEvent.change(input, { target: { files: [{ text: async () => JSON.stringify(configuration) }] } });
  }
  it("exports only the currently selected saved subject and package", async () => {
    setup(); await screen.findByText("草稿版本 2");
    const createUrl = vi.fn(() => "blob:subject-config"); const revokeUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeUrl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.mocked(exportFeishuSubjectWorkflowShare).mockResolvedValue(portableShare());
    try {
      fireEvent.click(screen.getByRole("button", { name: "导出学科配置" }));
      await waitFor(() => expect(exportFeishuSubjectWorkflowShare).toHaveBeenCalledWith("profile-subject", "zip-a"));
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect(revokeUrl).toHaveBeenCalledWith("blob:subject-config");
    } finally { click.mockRestore(); }
  });
  it("keeps the latest source preview when older source matching finishes later", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    const oldConfiguration = { schemaVersion: 1, bases: catalog(subject("source-a", "源化学"), subject("source-b", "源物理")) };
    const pending: Array<(value: Awaited<ReturnType<typeof importFeishuSubjectWorkflowShare>>) => void> = [];
    vi.mocked(importFeishuSubjectWorkflowShare).mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    uploadShare(view, oldConfiguration);
    const dialog = await screen.findByRole("dialog", { name: "学科配置导入预览" });
    const source = within(dialog).getByRole("combobox", { name: "来源学科" });
    fireEvent.change(source, { target: { value: "source-a" } });
    fireEvent.change(source, { target: { value: "source-b" } });
    const result = { configuration: portableShare(), diagnostics: [], diagnosticsOk: true, dryRun: true,
      source: { subjectKey: "source-b", baseName: "源 Base", tableName: "新匹配物理" },
      target: { subjectKey: "profile-subject", baseName: "测试 Base", tableName: "配置学科" },
      packageAlias: "zip-a", workflowTemplate: template, expectedVersion: 1, expectedRevision: 2 };
    await act(async () => pending[1](result));
    await act(async () => pending[0]({ ...result, source: { ...result.source, subjectKey: "source-a", tableName: "过期化学" } }));
    expect(within(dialog).getByText(/新匹配物理/)).toBeTruthy();
    expect(within(dialog).queryByText(/过期化学/)).toBeNull();
  });
  it("imports one portable source into the selected subject and previews unmatched fields", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    const configuration = portableShare();
    mockSubjectImport(configuration, view.props.catalog, [
      { severity: "warning", code: "FIELD_NOT_FOUND", path: "config.stages.initial.videoSource.fieldId", message: "missing" },
    ]);
    expect(screen.getByRole("button", { name: "导入学科配置" }).closest(".feishu-subject-settings-header")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "导入共享配置" })).toBeNull();
    uploadShare(view, configuration);
    const dialog = await screen.findByRole("dialog", { name: "学科配置导入预览" });
    await within(dialog).findByText(/FIELD_NOT_FOUND/);
    expect(within(dialog).getByText(/旧 Base.*旧物理/)).toBeTruthy();
    expect(within(dialog).getByText(/测试 Base.*配置学科/)).toBeTruthy();
    expect(within(dialog).getByText(/当前表中找不到该字段/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "导入为待修复草稿" }));
    await waitFor(() => expect(importFeishuSubjectWorkflowShare).toHaveBeenLastCalledWith(expect.objectContaining({
      configuration, targetSubjectKey: "profile-subject", expectedVersion: 1, expectedRevision: 2, dryRun: false,
    })));
    expect(view.props.onCatalogChange).toHaveBeenCalledWith(view.props.catalog);
  });
  it("requires choosing one source from an old multi-subject file while keeping the target fixed", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    const oldConfiguration = { schemaVersion: 1, bases: catalog(subject("source-a", "源化学"), subject("source-b", "源物理")) };
    mockSubjectImport(portableShare(), view.props.catalog);
    uploadShare(view, oldConfiguration);
    const dialog = await screen.findByRole("dialog", { name: "学科配置导入预览" });
    expect(importFeishuSubjectWorkflowShare).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByRole("combobox", { name: "来源学科" }), { target: { value: "source-b" } });
    await waitFor(() => expect(importFeishuSubjectWorkflowShare).toHaveBeenCalledWith(expect.objectContaining({
      configuration: oldConfiguration, sourceSubjectKey: "source-b", targetSubjectKey: "profile-subject", dryRun: true,
    })));
    expect(within(dialog).queryByRole("combobox", { name: "目标学科" })).toBeNull();
    expect(within(dialog).getByText(/测试 Base.*配置学科/)).toBeTruthy();
  });
  it("does not retarget a file picker opened for a different subject", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    fireEvent.click(screen.getByRole("button", { name: "导入学科配置" }));
    view.rerender(<FeishuWorkflowPanel {...view.props} selectedSubjectKey="other-subject" />);
    await waitFor(() => expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("1"));
    mockSubjectImport(portableShare(), view.props.catalog);
    uploadShare(view, portableShare());
    await act(async () => {});
    expect(importFeishuSubjectWorkflowShare).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "学科配置导入预览" })).toBeNull();
  });
  it("invalidates an in-flight import preview when the target subject changes", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    let resolvePreview!: (value: Awaited<ReturnType<typeof importFeishuSubjectWorkflowShare>>) => void;
    vi.mocked(importFeishuSubjectWorkflowShare).mockReturnValue(new Promise((resolve) => { resolvePreview = resolve; }));
    uploadShare(view, portableShare());
    await waitFor(() => expect(importFeishuSubjectWorkflowShare).toHaveBeenCalledTimes(1));
    view.rerender(<FeishuWorkflowPanel {...view.props} selectedSubjectKey="other-subject" />);
    await act(async () => resolvePreview({ configuration: portableShare(), diagnostics: [], dryRun: true,
      source: portableShare().source, target: { subjectKey: "profile-subject", baseName: "测试 Base", tableName: "配置学科" },
      packageAlias: "zip-a", workflowTemplate: template, expectedVersion: 1, expectedRevision: 2 }));
    expect(screen.queryByRole("dialog", { name: "学科配置导入预览" })).toBeNull();
    expect(importFeishuSubjectWorkflowShare).toHaveBeenCalledTimes(1);
  });
  it("blocks import and export until the selected subject's local edits are saved", async () => {
    setup(); await screen.findByText("草稿版本 2");
    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "4" } });
    for (const name of ["导入学科配置", "导出学科配置"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toContain("保存");
    }
  });
  it("preserves unsaved configuration input while retrying the package list", async () => {
    const configured = subject("package-retry-edit", "高中历史");
    configured.packageRoute!.packageAlias = "zip-a";
    vi.mocked(listFeishuPackages).mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue(packageList);
    render(<FeishuWorkflowPanel catalog={catalog(configured)} configurationBaseToken="bas_test"
      selectedSubjectKey={configured.subjectKey} onSelectSubject={vi.fn()} onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()} onSaveDraft={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: "重试读取包列表" });
    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "4" } });
    fireEvent.click(retry);
    await waitFor(() => expect(listFeishuPackages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "重试读取包列表" })).toBeNull());
    expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("4");
  });
  it("does not clear a newer configuration error after package-list retry succeeds", async () => {
    const configured = subject("package-retry-newer", "高中历史");
    configured.packageRoute!.packageAlias = "zip-a";
    vi.mocked(listFeishuPackages).mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue(packageList);
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => zipProfile(key, alias) as never);
    const onError = vi.fn(); const onErrorClear = vi.fn();
    render(<FeishuWorkflowPanel catalog={catalog(configured)} configurationBaseToken="bas_test"
      selectedSubjectKey={configured.subjectKey} onSelectSubject={vi.fn()} onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()} onError={onError} onErrorClear={onErrorClear}
      onToggleDisplay={async () => { throw new Error("较新的配置错误"); }} />);
    const retry = await screen.findByRole("button", { name: "重试读取包列表" });
    fireEvent.click(screen.getByRole("button", { name: "隐藏" }));
    await waitFor(() => expect(onError).toHaveBeenLastCalledWith("较新的配置错误", expect.any(String)));
    fireEvent.click(retry);
    await screen.findByText("草稿版本 2");
    expect(onErrorClear).not.toHaveBeenCalled();
  });
  it("clears the original subject's package-list error after retrying on another subject", async () => {
    vi.mocked(listFeishuPackages).mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue(packageList);
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => zipProfile(key, alias) as never);
    const onError = vi.fn(); const onErrorClear = vi.fn();
    const view = setup(zipProfile, { onError, onErrorClear });
    const message = "无法读取 Auto-Cut 包列表，请重试。";
    const firstContext = JSON.stringify([view.a.subjectKey, "zip-a", "document_draft_zip", 1]);
    const secondContext = JSON.stringify([view.b.subjectKey, "zip-a", "document_draft_zip", 1]);
    await screen.findByRole("button", { name: "重试读取包列表" });
    expect(onError).toHaveBeenCalledWith(message, firstContext);
    view.rerender(<FeishuWorkflowPanel {...view.props} selectedSubjectKey={view.b.subjectKey}
      onError={onError} onErrorClear={onErrorClear} onToggleDisplay={async () => { throw new Error("较新的配置错误"); }} />);
    fireEvent.click(screen.getAllByRole("button", { name: "隐藏" })[1]);
    await waitFor(() => expect(onError).toHaveBeenLastCalledWith("较新的配置错误", secondContext));
    fireEvent.click(screen.getByRole("button", { name: "重试读取包列表" }));
    await screen.findByText("草稿版本 2");
    expect(onErrorClear).toHaveBeenCalledWith(message, firstContext);
    expect(onErrorClear).not.toHaveBeenCalledWith("较新的配置错误", secondContext);
    expect(listFeishuPackages).toHaveBeenCalledTimes(2);
  });
  it("clears only the old ZIP profile error after its draft reload succeeds", async () => {
    let reads = 0;
    const onError = vi.fn(); const onErrorClear = vi.fn();
    const view = setup((key, alias) => {
      if (++reads === 1) throw new Error("private transport details");
      return zipProfile(key, alias);
    }, { onError, onErrorClear });
    const message = "读取流程草稿失败。输入已保留，请检查配置后重试。";
    await screen.findByText(message);
    expect(onError).toHaveBeenCalledWith(message, JSON.stringify([view.a.subjectKey, "zip-a", "document_draft_zip", 1]));
    vi.mocked(listFeishuWorkflowCatalog).mockResolvedValue(view.props.catalog);
    fireEvent.click(screen.getByRole("button", { name: "重新加载流程草稿" }));
    await screen.findByText("草稿版本 2");
    expect(onErrorClear).toHaveBeenCalledWith(message, JSON.stringify([view.a.subjectKey, "zip-a", "document_draft_zip", 1]));
  });
  it("blocks ZIP activation with an unbound course name and points to storage settings", async () => {
    setup((key, alias) => {
      const profile = zipProfile(key, alias);
      return { ...profile, config: { ...profile.config, delivery: {
        version: 1, rootPath: "C:\\delivery", courseNaming: { mode: "field", fieldId: null },
        coursePathWriteback: { enabled: true, fieldId: "fld_text" },
        writeback: { initial: { onProcessing: [], onUploaded: [] }, first_review: { onProcessing: [], onUploaded: [] }, final_review: { onProcessing: [], onUploaded: [] } },
        finalDirectoryTrigger: { enabled: false, fieldId: null, optionId: null },
      } } } as unknown as ReturnType<typeof zipProfile>;
    });
    await screen.findByText("草稿版本 2");
    const enable = screen.getByRole("button", { name: "启用" }) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    expect(screen.getByText(/存储与目录.*课程名称字段/)).toBeTruthy();
    fireEvent.click(enable);
    expect(enableFeishuPackageWorkflowDraft).not.toHaveBeenCalled();
  });
  it("lets ZIP delivery reuse the valid artifact naming field after saving", async () => {
    setup((key, alias) => {
      const profile = zipProfile(key, alias);
      return { ...profile, config: { ...profile.config, delivery: {
        version: 1, rootPath: "C:\\delivery", courseNaming: { mode: "field", fieldId: null },
        coursePathWriteback: { enabled: true, fieldId: "fld_text" },
        writeback: { initial: { onProcessing: [], onUploaded: [] }, first_review: { onProcessing: [], onUploaded: [] }, final_review: { onProcessing: [], onUploaded: [] } },
        finalDirectoryTrigger: { enabled: false, fieldId: null, optionId: null },
      } } } as unknown as ReturnType<typeof zipProfile>;
    });
    await screen.findByText("草稿版本 2");
    selectSubjectSettingsTab("存储与目录");
    fireEvent.change(screen.getByRole("combobox", { name: "课程名称来源" }), {
      target: { value: "reuse_artifact_naming" },
    });
    expect((screen.getByRole("combobox", { name: "课程名称来源" }) as HTMLSelectElement).value)
      .toBe("reuse_artifact_naming");
    expect(screen.queryByRole("combobox", { name: "课程名称字段" })).toBeNull();
    expect(screen.getByRole("region", { name: "课程目录预览" }).textContent).toContain("{普通文本}");
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(saveFeishuPackageWorkflowDraft).toHaveBeenCalledWith(
      "profile-subject", "zip-a", 2,
      expect.objectContaining({ delivery: expect.objectContaining({
        courseNaming: { mode: "reuse_artifact_naming", fieldId: null },
      }) }),
    ));
    await screen.findByText("草稿版本 3");
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("does not require a course name when ZIP upload and final-directory creation are off", async () => {
    setup((key, alias) => {
      const profile = zipProfile(key, alias);
      return { ...profile, config: { ...profile.config,
        upload: { ...profile.config.upload, enabled: false },
        delivery: {
          version: 1, rootPath: null, courseNaming: { mode: "field", fieldId: null },
          coursePathWriteback: { enabled: false, fieldId: null },
          writeback: { initial: { onProcessing: [], onUploaded: [] }, first_review: { onProcessing: [], onUploaded: [] }, final_review: { onProcessing: [], onUploaded: [] } },
          finalDirectoryTrigger: { enabled: false, fieldId: null, optionId: null },
        },
      } } as unknown as ReturnType<typeof zipProfile>;
    });
    await screen.findByText("草稿版本 2");
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/存储与目录.*课程名称字段/)).toBeNull();
  });
  it("reports a safe action and API code when ZIP save fails", async () => {
    const onError = vi.fn();
    setup(zipProfile, { onError });
    await screen.findByText("草稿版本 2");
    vi.mocked(saveFeishuPackageWorkflowDraft).mockRejectedValueOnce(new ApiError(400, {
      error: { code: "WRITEBACK_FIELD_REQUIRED", message: "private server details" },
    }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(
      expect.stringMatching(/保存流程草稿失败.*WRITEBACK_FIELD_REQUIRED/),
      expect.any(String),
    ));
    const reported = onError.mock.lastCall?.[0] as string;
    expect(reported).not.toContain("private server details");
  });
  it("keeps a newer ZIP error when an earlier draft reload succeeds", async () => {
    let reads = 0;
    let finishRead!: (value: ReturnType<typeof zipProfile>) => void;
    const onError = vi.fn(); const onErrorClear = vi.fn();
    const view = setup((key, alias) => {
      if (++reads === 1) throw new Error("private transport details");
      return new Promise<ReturnType<typeof zipProfile>>((resolve) => { finishRead = resolve; }) as never;
    }, { onError, onErrorClear, onToggleDisplay: async () => { throw new Error("较新的显示错误"); } });
    await screen.findByText("读取流程草稿失败。输入已保留，请检查配置后重试。");
    vi.mocked(listFeishuWorkflowCatalog).mockResolvedValue(view.props.catalog);
    fireEvent.click(screen.getByRole("button", { name: "重新加载流程草稿" }));
    await waitFor(() => expect(getFeishuPackageWorkflowDraft).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getAllByRole("button", { name: "隐藏" })[0]);
    await waitFor(() => expect(onError).toHaveBeenLastCalledWith("较新的显示错误", JSON.stringify([view.a.subjectKey, "zip-a", "document_draft_zip", 1])));
    await act(async () => { finishRead(zipProfile(view.a.subjectKey, "zip-a")); });
    await screen.findByText("草稿版本 2");
    expect(onErrorClear).not.toHaveBeenCalled();
  });
  it("clears a ZIP error when selecting a VM package", async () => {
    const vmTemplate = { id: "vm_pmo_review_video", version: 1 } as const;
    const onErrorClear = vi.fn();
    let reads = 0;
    const view = setup((key, alias) => {
      if (++reads === 1) throw new Error("private transport details");
      return zipProfile(key, alias);
    }, { onError: vi.fn(), onErrorClear }, [...packageList, { ...packageList[0], alias: "vm-package", workflowTemplate: vmTemplate }]);
    const message = "读取流程草稿失败。输入已保留，请检查配置后重试。";
    await screen.findByText(message);
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "vm-package" } });
    expect(onErrorClear).toHaveBeenCalledWith(message, JSON.stringify([view.a.subjectKey, "zip-a", "document_draft_zip", 1]));
  });
  it.each(["save", "enable"])("clears its existing ZIP error after a successful %s", async (action) => {
    const onError = vi.fn(); const onErrorClear = vi.fn();
    const view = setup(zipProfile, { onError, onErrorClear, onToggleDisplay: async () => { throw new Error("显示设置失败"); } });
    await screen.findByText("草稿版本 2");
    if (action === "enable") {
      fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-b" } });
      await waitFor(() => expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("2"));
      vi.mocked(enableFeishuPackageWorkflowDraft).mockResolvedValue({ ...view.a, activePackageAlias: "zip-b" } as never);
    } else {
      fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "3" } });
    }
    fireEvent.click(screen.getAllByRole("button", { name: "隐藏" })[0]);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("显示设置失败", JSON.stringify([view.a.subjectKey, action === "enable" ? "zip-b" : "zip-a", "document_draft_zip", 1])));
    fireEvent.click(screen.getByRole("button", { name: action === "enable" ? "启用" : "保存草稿" }));
    await waitFor(() => expect(onErrorClear).toHaveBeenCalledWith("显示设置失败", JSON.stringify([view.a.subjectKey, action === "enable" ? "zip-b" : "zip-a", "document_draft_zip", 1])));
  });
  it("restores unsaved ZIP settings and audio by package and subject, while browsing disabled packages", async () => {
    const view = setup();
    await screen.findByText("草稿版本 2");
    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "4" } });
    selectSubjectSettingsTab("素材与阶段");
    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频来源" }), { target: { value: "docx_section" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿音频目录标题" }), { target: { value: "包 A 配音" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-b" } });
    await waitFor(() => expect((screen.getByRole("combobox", { name: "初稿音频来源" }) as HTMLSelectElement).value).toBe("video_original"));
    selectSubjectSettingsTab("基础与执行");
    expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("2");
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-a" } });
    expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("4");
    view.rerender(<FeishuWorkflowPanel {...view.props} selectedSubjectKey={view.b.subjectKey} />);
    await waitFor(() => expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("1"));
    view.rerender(<FeishuWorkflowPanel {...view.props} />);
    expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("4");
    selectSubjectSettingsTab("素材与阶段");
    expect((screen.getByRole("textbox", { name: "初稿音频目录标题" }) as HTMLInputElement).value).toBe("包 A 配音");
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-disabled" } });
    await screen.findByText("草稿版本 2");
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.props.onSubjectChange).not.toHaveBeenCalled();
  });
  it("saves only the selected profile and explicitly enables its saved revision", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-b" } });
    await waitFor(() => expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("2"));
    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "5" } });
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("草稿版本 3");
    expect(saveFeishuPackageWorkflowDraft).toHaveBeenCalledWith("profile-subject", "zip-b", 2, expect.objectContaining({ packageRoute: expect.objectContaining({ packageAlias: "zip-b" }), upload: expect.objectContaining({ uploadConcurrency: 5 }) }));
    expect(view.props.onSubjectChange).not.toHaveBeenCalled();
    expect(view.props.onCatalogChange).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ subjects: expect.arrayContaining([
        expect.objectContaining({ subjectKey: "profile-subject", preferredPackageAlias: "zip-b", packageRoute: expect.objectContaining({ packageAlias: "zip-a" }) }),
      ]) }),
    ]));
    expect(screen.getByLabelText("当前生效流程").textContent).toContain("zip-a");
    vi.mocked(enableFeishuPackageWorkflowDraft).mockResolvedValue({ ...view.a, configVersion: 2, activeConfigVersion: 2, activePackageAlias: "zip-b" } as never);
    fireEvent.click(screen.getByRole("button", { name: "启用" }));
    await waitFor(() => expect(enableFeishuPackageWorkflowDraft).toHaveBeenCalledWith("profile-subject", "zip-b", 3, 1));
    expect(view.props.onSubjectChange).toHaveBeenCalledWith(expect.objectContaining({ activePackageAlias: "zip-b" }));
  });
  it("retains edits and blocks activation after a conflict, warning before discarding or refreshing", async () => {
    setup(); await screen.findByText("草稿版本 2"); await screen.findByRole("spinbutton", { name: "上传并发数" });
    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "6" } });
    vi.mocked(saveFeishuPackageWorkflowDraft).mockRejectedValueOnce(new ApiError(409, { error: { code: "VERSION_CONFLICT", message: "changed" } }));
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByRole("alert");
    expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("6");
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "重新加载流程草稿" }));
    expect(confirm).toHaveBeenCalled();
    expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("6");
    confirm.mockRestore();
  });
  it("keeps configuration subject navigation in the configuration panel", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    fireEvent.click(screen.getByRole("button", { name: /另一个学科/ }));
    expect(view.props.onSelectSubject).toHaveBeenCalledWith("other-subject", false);
  });
  it("restores other package edits after a failed read without showing or saving the previous package as the new one", async () => {
    setup(); await screen.findByText("草稿版本 2"); await screen.findByRole("spinbutton", { name: "上传并发数" });
    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "7" } });
    vi.mocked(getFeishuPackageWorkflowDraft).mockRejectedValueOnce(new Error("private transport details"));
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-b" } });
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "保存草稿" })).toBeNull();
    expect(screen.queryByText("private transport details")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-a" } });
    expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("7");
  });
  it("reconciles an inactive package with refreshed fields and retains unrelated edits and audio", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    selectSubjectSettingsTab("素材与阶段");
    fireEvent.change(screen.getByRole("textbox", { name: "初稿命名后缀" }), { target: { value: "_本地后缀" } });
    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频来源" }), { target: { value: "docx_section" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿音频目录标题" }), { target: { value: "本地配音" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-b" } });
    await screen.findByText("草稿版本 2");
    const refreshed = structuredClone(view.props.catalog);
    refreshed[0].subjects[0].metadata!.fields = fields.filter((field) => field.fieldId !== "fld_status");
    refreshed[0].subjects[0].configVersion = 2;
    view.rerender(<FeishuWorkflowPanel {...view.props} catalog={refreshed} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-a" } });
    expect((screen.getByRole("textbox", { name: "初稿命名后缀" }) as HTMLInputElement).value).toBe("_本地后缀");
    expect((screen.getByRole("textbox", { name: "初稿音频目录标题" }) as HTMLInputElement).value).toBe("本地配音");
    expect(screen.getByText("初稿需要触发选项")).toBeTruthy();
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("warns before leaving when only inactive audio helper values would be lost", async () => {
    setup(); await screen.findByText("草稿版本 2");
    selectSubjectSettingsTab("素材与阶段");
    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频来源" }), { target: { value: "docx_section" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿音频目录标题" }), { target: { value: "待用配音" } });
    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频来源" }), { target: { value: "video_original" } });
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  it("does not seed a new package's hidden execution or upload settings from another package", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    const empty = zipProfile(view.a.subjectKey, "zip-b");
    const { execution: _execution, upload: _upload, ...emptyConfig } = empty.config;
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValueOnce({ ...empty, config: emptyConfig } as never);
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-b" } });
    await screen.findByText("草稿版本 2");
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("草稿版本 3");
    expect(saveFeishuPackageWorkflowDraft).toHaveBeenCalledWith(view.a.subjectKey, "zip-b", 2,
      expect.objectContaining({ execution: { mode: "manual", concurrencyGroup: "default", maxConcurrent: 1, resourceGroups: [] },
        packageRoute: { routeMode: "fixed", packageAlias: "zip-b", subjectCodeFieldId: null, branchMap: null } }));
  });
  it("requires an initial save before activating an untouched revision-zero profile", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValueOnce(zipProfile(view.a.subjectKey, "zip-b", 0) as never);
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-b" } });
    await screen.findByText("草稿版本 0");
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "启用" }).title).toBe("请先保存草稿");
  });
  it("requires saving metadata repairs before activating the server profile", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    const stale = zipProfile(view.a.subjectKey, "zip-b");
    const config = { ...stale.config, delivery: {
      version: 1, rootPath: "C:\\delivery", courseNaming: { mode: "field", fieldId: "fld_text" },
      coursePathWriteback: { enabled: true, fieldId: "fld_removed" },
      writeback: { initial: { onProcessing: [], onUploaded: [] }, first_review: { onProcessing: [], onUploaded: [] }, final_review: { onProcessing: [], onUploaded: [] } },
      finalDirectoryTrigger: { enabled: false, fieldId: null, optionId: null },
    } };
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValueOnce({ ...stale, config } as never);
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-b" } });
    await screen.findByText("草稿版本 2");
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "启用" }).title).toBe("请先保存草稿");
  });
  it("ignores a late ZIP response after switching editing identity", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    let resolve!: (value: never) => void;
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-b" } });
    await screen.findAllByText("正在读取流程草稿…");
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-a" } });
    resolve(zipProfile(view.a.subjectKey, "zip-b", 99) as never);
    await waitFor(() => expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("1"));
    expect(screen.getByLabelText("当前编辑流程").textContent).toContain("zip-a");
    expect(screen.queryByText("草稿版本 99")).toBeNull();
  });
  it("rebases unsaved ZIP inputs onto the profile revision created by refreshing fields", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "4" } });
    const refreshed = structuredClone(view.props.catalog[0]);
    refreshed.subjects[0].configVersion = 2;
    refreshed.subjects[0].metadata!.fields!.push({ fieldId: "fld_new", fieldName: "新字段", type: 1, uiType: "Text", options: [] });
    vi.mocked(refreshFeishuBaseFields).mockResolvedValue(refreshed);
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => {
      const next = zipProfile(key, alias, 3);
      next.config.execution!.resourceGroups = ["new-resource-group"];
      return next as never;
    });
    view.props.onCatalogChange.mockImplementation((next) => view.rerender(<FeishuWorkflowPanel {...view.props} catalog={next} />));
    fireEvent.click(screen.getByRole("button", { name: "刷新字段" }));
    await screen.findByText("草稿版本 3");
    expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("4");
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("草稿版本 4");
    expect(saveFeishuPackageWorkflowDraft).toHaveBeenCalledWith(view.a.subjectKey, "zip-a", 3,
      expect.objectContaining({ upload: expect.objectContaining({ uploadConcurrency: 4 }), execution: expect.objectContaining({ resourceGroups: ["new-resource-group"] }) }));
  });
  it("blocks saves and activation when field refresh conflicts with the same locally edited setting", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "4" } });
    const refreshed = structuredClone(view.props.catalog[0]);
    refreshed.subjects[0].configVersion = 2;
    vi.mocked(refreshFeishuBaseFields).mockResolvedValue(refreshed);
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => {
      const next = zipProfile(key, alias, 3);
      next.config.upload!.uploadConcurrency = 9;
      return next as never;
    });
    view.props.onCatalogChange.mockImplementation((next) => view.rerender(<FeishuWorkflowPanel {...view.props} catalog={next} />));
    fireEvent.click(screen.getByRole("button", { name: "刷新字段" }));
    await screen.findByText("读取流程草稿失败（VERSION_CONFLICT）。输入已保留，请重新加载后再保存或启用。");
    expect(screen.getByRole("alert", { name: "字段刷新状态" }).textContent).toContain("冲突");
    expect(screen.getByRole("alert", { name: "字段刷新状态" }).textContent).not.toContain("读取失败");
    expect(screen.getByText("草稿版本 2")).toBeTruthy();
    expect(screen.queryByText("草稿版本 3")).toBeNull();
    expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("4");
    const save = screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement;
    const enable = screen.getByRole("button", { name: "启用" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(enable.disabled).toBe(true);
    fireEvent.click(save); fireEvent.click(enable);
    fireEvent.submit(screen.getByRole("region", { name: "学科配置" }));
    expect(saveFeishuPackageWorkflowDraft).not.toHaveBeenCalled();
    expect(enableFeishuPackageWorkflowDraft).not.toHaveBeenCalled();
  });
  it("identifies a hidden ZIP conflict during VM field refresh and keeps its local edits", async () => {
    const vmTemplate = { id: "vm_pmo_review_video", version: 1 } as const;
    const vmPackage = { ...packageList[0], alias: "vm-package", workflowTemplate: vmTemplate };
    const view = setup(zipProfile, {}, [...packageList, vmPackage]);
    await screen.findByText("草稿版本 2");
    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "4" } });
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => {
      if (alias === "vm-package") return { subjectKey: key, packageAlias: alias, workflowTemplate: vmTemplate,
        revision: 0, updatedAt: null, config: { fields: { vmidFieldId: null, outputAttachmentFieldId: null },
          approval: { department: "动画组", reason: "切片剪辑" },
          stages: { initial: { enabled: true, statusFieldId: null, triggerOptionId: null, instructionFieldId: null },
            review: { enabled: false, statusFieldId: null, triggerOptionId: null, instructionFieldId: null,
              instructionAttachmentsFieldId: null } } } } as never;
      const next = zipProfile(key, alias, 3);
      next.config.upload!.uploadConcurrency = 9;
      return next as never;
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "vm-package" } });
    await screen.findByRole("textbox", { name: "申请部门" });
    vi.mocked(refreshFeishuBaseFields).mockResolvedValue(view.props.catalog[0]);
    view.props.onCatalogChange.mockImplementation((next) => view.rerender(<FeishuWorkflowPanel {...view.props} catalog={next} />));
    fireEvent.click(screen.getByRole("button", { name: "刷新字段" }));
    await waitFor(() => expect(screen.getByRole("alert", { name: "字段刷新状态" }).textContent).toContain("zip-a 包的本地修改与最新草稿冲突"));
    expect(screen.getByRole("alert", { name: "字段刷新状态" }).textContent).toContain("VM 字段已刷新");
    expect(screen.getByRole("alert", { name: "字段刷新状态" }).textContent).not.toContain("读取失败");
    fireEvent.change(screen.getByRole("combobox", { name: "Auto-Cut 包" }), { target: { value: "zip-a" } });
    expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("4");
  });
  it("blocks saves and activation throughout pending field and profile refreshes", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    let finishFields!: (base: FeishuBaseCatalog) => void;
    let finishProfile!: (profile: never) => void;
    vi.mocked(refreshFeishuBaseFields).mockImplementation(() => new Promise((resolve) => { finishFields = resolve; }));
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(() => new Promise((resolve) => { finishProfile = resolve; }));
    const assertPersistenceBlocked = () => {
      const save = screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement;
      const enable = screen.getByRole("button", { name: "启用" }) as HTMLButtonElement;
      expect(save.disabled).toBe(true); expect(enable.disabled).toBe(true);
      fireEvent.click(save); fireEvent.click(enable);
      fireEvent.submit(screen.getByRole("region", { name: "学科配置" }));
      expect(saveFeishuPackageWorkflowDraft).not.toHaveBeenCalled();
      expect(enableFeishuPackageWorkflowDraft).not.toHaveBeenCalled();
    };
    fireEvent.click(screen.getByRole("button", { name: "刷新字段" }));
    expect(screen.getByRole("button", { name: "正在刷新…" })).toBeTruthy();
    assertPersistenceBlocked();
    const refreshed = structuredClone(view.props.catalog[0]);
    refreshed.subjects[0].configVersion = 2;
    view.props.onCatalogChange.mockImplementation((next) => view.rerender(<FeishuWorkflowPanel {...view.props} catalog={next} />));
    finishFields(refreshed);
    await waitFor(() => expect(getFeishuPackageWorkflowDraft).toHaveBeenCalledTimes(2));
    assertPersistenceBlocked();
    finishProfile(zipProfile(view.a.subjectKey, "zip-a", 3) as never);
    await screen.findByText("草稿版本 3");
    await waitFor(() => expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it.each([false, true])("adopts a refreshed audio helper or keeps its local edit consistently through save and enable: %s", async (keepLocalAudio) => {
    const view = setup((key, alias) => {
      const profile = zipProfile(key, alias);
      profile.config.stages!.initial.audio = {
        mode: "replace_original",
        source: { kind: "docx_section", anchorText: "原配音目录" },
        durationToleranceSeconds: 3,
      };
      return profile;
    });
    await screen.findByText("草稿版本 2");
    selectSubjectSettingsTab("素材与阶段");
    if (keepLocalAudio) {
      fireEvent.change(screen.getByRole("textbox", { name: "初稿音频目录标题" }), { target: { value: "本地配音目录" } });
    }
    const refreshed = structuredClone(view.props.catalog[0]);
    refreshed.subjects[0].configVersion = 2;
    vi.mocked(refreshFeishuBaseFields).mockResolvedValue(refreshed);
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => {
      const next = zipProfile(key, alias, 3);
      next.config.stages!.initial.audio = {
        mode: "replace_original",
        source: { kind: "docx_section", anchorText: keepLocalAudio ? "原配音目录" : "远端配音目录" },
        durationToleranceSeconds: 5,
      };
      return next as never;
    });
    view.props.onCatalogChange.mockImplementation((next) => view.rerender(<FeishuWorkflowPanel {...view.props} catalog={next} />));
    fireEvent.click(screen.getByRole("button", { name: "刷新字段" }));
    await screen.findByText("草稿版本 3");
    const expectedAudioDirectory = keepLocalAudio ? "本地配音目录" : "远端配音目录";
    expect((screen.getByRole("textbox", { name: "初稿音频目录标题" }) as HTMLInputElement).value).toBe(expectedAudioDirectory);
    expect((screen.getByRole("spinbutton", { name: "初稿时长误差（秒）" }) as HTMLInputElement).value).toBe("5");
    const saveButton = screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(keepLocalAudio);
    fireEvent.click(saveButton);
    await screen.findByText("草稿版本 4");
    await waitFor(() => expect(saveFeishuPackageWorkflowDraft).toHaveBeenCalledWith(view.a.subjectKey, "zip-a", 3,
      expect.objectContaining({ stages: expect.objectContaining({ initial: expect.objectContaining({
        audio: expect.objectContaining({ source: expect.objectContaining({ anchorText: expectedAudioDirectory }), durationToleranceSeconds: 5 }),
      }) }) })));
    vi.mocked(enableFeishuPackageWorkflowDraft).mockResolvedValue({ ...view.a, configVersion: 3, activeConfigVersion: 3, activePackageAlias: "zip-a" } as never);
    fireEvent.click(screen.getByRole("button", { name: "启用" }));
    await waitFor(() => expect(enableFeishuPackageWorkflowDraft).toHaveBeenCalledWith(view.a.subjectKey, "zip-a", 4, 2));
  });
  it("reloads only the imported profile and retains another subject's unsaved edits", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "4" } });
    view.rerender(<FeishuWorkflowPanel {...view.props} selectedSubjectKey="other-subject" />);
    await waitFor(() => expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("1"));
    const configuration = portableShare();
    mockSubjectImport(configuration, view.props.catalog);
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, alias) => {
      const next = zipProfile(key, alias, 3); next.config.upload!.uploadConcurrency = 9; return next as never;
    });
    uploadShare(view, configuration);
    const dialog = await screen.findByRole("dialog", { name: "学科配置导入预览" });
    const confirm = await within(dialog).findByRole("button", { name: "确认导入草稿" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
    await screen.findByText("草稿版本 3");
    expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("9");
    view.rerender(<FeishuWorkflowPanel {...view.props} />);
    expect((screen.getByRole("spinbutton", { name: "上传并发数" }) as HTMLInputElement).value).toBe("4");
  });
  it("uses the legacy save endpoint when only a host enable callback is supplied", async () => {
    const configured = subject("legacy-callback", "旧宿主"); configured.packageRoute!.packageAlias = "zip-a";
    vi.mocked(listFeishuPackages).mockResolvedValue(packageList);
    vi.mocked(saveFeishuSubjectDraft).mockResolvedValue({ ...configured, configVersion: 2 });
    const onSubjectChange = vi.fn();
    render(<FeishuWorkflowPanel catalog={catalog(configured)} configurationBaseToken="bas_test" selectedSubjectKey={configured.subjectKey}
      onSelectSubject={vi.fn()} onCatalogChange={vi.fn()} onSubjectChange={onSubjectChange} onEnable={vi.fn()} />);
    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(onSubjectChange).toHaveBeenCalledWith(expect.objectContaining({ configVersion: 2 })));
    expect(saveFeishuSubjectDraft).toHaveBeenCalledWith(configured.subjectKey, expect.objectContaining({ expectedVersion: 1, upload: expect.objectContaining({ uploadConcurrency: 3 }) }));
    expect(saveFeishuPackageWorkflowDraft).not.toHaveBeenCalled();
  });
  it("recovers the current subject version as well as the profile after an activation conflict", async () => {
    const view = setup(); await screen.findByText("草稿版本 2");
    vi.mocked(enableFeishuPackageWorkflowDraft).mockRejectedValueOnce(new ApiError(409, { error: { code: "VERSION_CONFLICT" } }));
    fireEvent.click(screen.getByRole("button", { name: "启用" }));
    await screen.findByRole("alert");
    const latest = structuredClone(view.props.catalog); latest[0].subjects[0].configVersion = 9;
    vi.mocked(listFeishuWorkflowCatalog).mockResolvedValue(latest);
    view.props.onCatalogChange.mockImplementation((next) => view.rerender(<FeishuWorkflowPanel {...view.props} catalog={next} />));
    fireEvent.click(screen.getByRole("button", { name: "重新加载流程草稿" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(false));
    view.props.onSubjectChange.mockImplementation((updated) => {
      latest[0].subjects[0] = updated;
      view.rerender(<FeishuWorkflowPanel {...view.props} catalog={structuredClone(latest)} />);
    });
    vi.mocked(enableFeishuPackageWorkflowDraft).mockResolvedValue({ ...view.a, configVersion: 10 });
    fireEvent.click(screen.getByRole("button", { name: "启用" }));
    await waitFor(() => expect(enableFeishuPackageWorkflowDraft).toHaveBeenLastCalledWith(view.a.subjectKey, "zip-a", 2, 9));
    await waitFor(() => expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "启用" }));
    await waitFor(() => expect(enableFeishuPackageWorkflowDraft).toHaveBeenLastCalledWith(view.a.subjectKey, "zip-a", 2, 10));
  });
  it.each(["", "missing-package"])("requires selecting an available package before editing an unconfigured profile %s", async (alias) => {
    const configured = subject("without-profile", "未配置包"); configured.packageRoute!.packageAlias = alias;
    vi.mocked(listFeishuPackages).mockResolvedValue(packageList);
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (key, selectedAlias) => zipProfile(key, selectedAlias) as never);
    render(<FeishuWorkflowPanel catalog={catalog(configured)} configurationBaseToken="bas_test" selectedSubjectKey={configured.subjectKey}
      onSelectSubject={vi.fn()} onCatalogChange={vi.fn()} onSubjectChange={vi.fn()} />);
    await screen.findByRole("option", { name: "zip-a" });
    if (alias) {
      expect(screen.getByRole("status").textContent).toContain("missing-package 已不在当前包列表中");
      expect(screen.getByRole("status").textContent).toContain("重新选择");
    } else {
      expect(screen.getByRole("status").textContent).toContain("请先选择可用的 Auto-Cut 包");
    }
    expect(screen.queryByRole("button", { name: "保存草稿" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "上传并发数" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "素材与阶段" })).toBeNull();
    const selector = screen.getByRole("combobox", { name: "Auto-Cut 包" });
    expect(selector.matches(":disabled")).toBe(false);
    expect(getFeishuPackageWorkflowDraft).not.toHaveBeenCalled();
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    fireEvent.change(selector, { target: { value: "zip-a" } });
    await screen.findByText("草稿版本 2");
    expect(screen.getByRole("spinbutton", { name: "上传并发数" })).toBeTruthy();
    expect(getFeishuPackageWorkflowDraft).toHaveBeenCalledWith(configured.subjectKey, "zip-a", expect.any(AbortSignal));
  });
});

// These historical editor regressions exercise the supported subject-level host.
// Production profile behavior is covered above with no persistence callbacks.
function LegacyFeishuWorkflowPanel(props: ComponentProps<typeof FeishuWorkflowPanel>) {
  return <FeishuWorkflowPanel onEnable={vi.fn()} {...props} />;
}
describe("manual field refresh", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(refreshFeishuBaseFields).mockReset();
  });

  function renderRefreshPanel(configured = subject("refresh-button", "刷新测试")) {
    const onSelectSubject = vi.fn();
    function Host() {
      const [bases, setBases] = useState(catalog(configured));
      return <LegacyFeishuWorkflowPanel catalog={bases} configurationBaseToken="bas_test"
        selectedSubjectKey={configured.subjectKey} onSelectSubject={onSelectSubject}
        onCatalogChange={setBases} onSubjectChange={vi.fn()} />;
    }
    return { ...render(<Host />), configured, onSelectSubject };
  }

  it("refreshes from the persistent header and preserves edits while exposing new fields and options", async () => {
    const configured = subject("refresh-button", "刷新测试");
    const refreshed = structuredClone(catalog(configured)[0]);
    const refreshedSubject = refreshed.subjects[0];
    if (!refreshedSubject?.metadata) throw new Error("refresh fixture requires subject metadata");
    const refreshedFields = refreshedSubject.metadata.fields;
    if (!refreshedFields) throw new Error("refresh fixture requires fields");
    const refreshedStatusField = refreshedFields.find((field) => field.fieldId === "fld_status");
    if (!refreshedStatusField?.options) throw new Error("refresh fixture requires status options");
    refreshed.metadataRefreshedAt = Date.now();
    refreshedSubject.configVersion += 1;
    refreshedFields.push({ fieldId: "fld_new", fieldName: "新增文本", type: 1, uiType: "Text", options: [] });
    refreshedStatusField.options.push({ id: "opt_new", name: "新状态选项" });
    let finish!: (base: FeishuBaseCatalog) => void;
    vi.mocked(refreshFeishuBaseFields).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { onSelectSubject } = renderRefreshPanel(configured);
    const button = screen.getByRole("button", { name: "刷新字段" });
    expect(button.closest("header")).toBeTruthy();
    selectSubjectSettingsTab("素材与阶段");
    fireEvent.change(screen.getByRole("textbox", { name: "初稿命名后缀" }), { target: { value: "_未保存" } });
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "正在刷新…" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "正在刷新…" }));
    expect(refreshFeishuBaseFields).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refreshFeishuBaseFields).mock.calls[0][0]).toBe("bas_test");
    finish(refreshed);
    await waitFor(() => expect(screen.getByRole("status", { name: "字段刷新状态" }).textContent).toContain("刷新成功"));
    expect((screen.getByRole("textbox", { name: "初稿命名后缀" }) as HTMLInputElement).value).toBe("_未保存");
    expect(within(screen.getByRole("combobox", { name: "命名字段" })).getByRole("option", { name: "新增文本" })).toBeTruthy();
    expect(within(screen.getByRole("combobox", { name: "初稿触发选项" })).getByRole("option", { name: "新状态选项" })).toBeTruthy();
    expect(onSelectSubject).not.toHaveBeenCalled();
    for (const tab of ["基础与执行", "存储与目录", "飞书回写"] as const) {
      selectSubjectSettingsTab(tab);
      expect(screen.getByRole("button", { name: "刷新字段" })).toBe(button);
    }
  });

  it("retains the old catalog and unsaved values on failure and allows retry", async () => {
    vi.mocked(refreshFeishuBaseFields).mockRejectedValueOnce(new Error("读取字段超时，请重试"));
    const { configured } = renderRefreshPanel();
    selectSubjectSettingsTab("素材与阶段");
    fireEvent.change(screen.getByRole("textbox", { name: "初稿命名后缀" }), { target: { value: "_保留" } });
    fireEvent.click(screen.getByRole("button", { name: "刷新字段" }));
    await waitFor(() => expect(screen.getByRole("alert", { name: "字段刷新状态" }).textContent).toContain("读取字段超时"));
    expect((screen.getByRole("textbox", { name: "初稿命名后缀" }) as HTMLInputElement).value).toBe("_保留");
    expect(screen.getByRole("button", { name: "刷新字段" }).hasAttribute("disabled")).toBe(false);
    vi.mocked(refreshFeishuBaseFields).mockResolvedValueOnce(catalog(configured)[0]);
    fireEvent.click(screen.getByRole("button", { name: "刷新字段" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "字段刷新状态" }).textContent).toContain("刷新成功"));
    expect(screen.queryByRole("alert", { name: "字段刷新状态" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "初稿命名后缀" }) as HTMLInputElement).value).toBe("_保留");
  });

  it("clears removed selected fields and options for repair", async () => {
    const configured = subject("refresh-button", "刷新测试");
    const refreshed = structuredClone(catalog(configured)[0]);
    const refreshedSubject = refreshed.subjects[0];
    if (!refreshedSubject?.metadata) throw new Error("refresh fixture requires subject metadata");
    const refreshedFields = refreshedSubject.metadata.fields;
    if (!refreshedFields) throw new Error("refresh fixture requires fields");
    refreshedSubject.metadata.fields = refreshedFields.filter((field) => field.fieldId !== "fld_text");
    const refreshedStatusField = refreshedSubject.metadata.fields.find((field) => field.fieldId === "fld_status");
    if (!refreshedStatusField) throw new Error("refresh fixture requires status field");
    refreshedStatusField.options = [];
    vi.mocked(refreshFeishuBaseFields).mockResolvedValueOnce(refreshed);
    renderRefreshPanel(configured);
    fireEvent.click(screen.getByRole("button", { name: "刷新字段" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "字段刷新状态" }).textContent).toContain("刷新成功"));
    selectSubjectSettingsTab("素材与阶段");
    for (const label of ["命名字段", "素材文档字段", "初稿触发选项"]) {
      const select = screen.getByRole("combobox", { name: label }) as HTMLSelectElement;
      expect(select.value).toBe("");
      expect(select.selectedOptions[0]?.textContent).not.toContain("当前不可用");
    }
    expect(screen.getByRole("button", { name: "保存草稿" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("FeishuWorkflowPanel stable layout", () => {
  const layoutKey = "taskboard.feishu-configuration-layout.v1";
  let panelWidth = 1000;

  function renderPanel(configured = subject("layout", "布局测试")) {
    return render(<LegacyFeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey={configured.subjectKey}
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);
  }

  function pointer(target: Element | Window, type: string, clientX: number, pointerId = 1) {
    const event = new MouseEvent(type, { bubbles: true, clientX, button: 0 });
    Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true } });
    fireEvent(target, event);
  }

  beforeEach(() => {
    panelWidth = 1000;
    taskboardStorage.removeItem(layoutKey);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x: 0, y: 0, top: 0, left: 0, right: panelWidth, bottom: 700,
      width: panelWidth, height: 700, toJSON: () => ({}),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    taskboardStorage.removeItem(layoutKey);
  });

  it("keeps the chosen catalog width across tabs and reloads with keyboard support", () => {
    const first = renderPanel();
    const splitter = screen.getByRole("separator", { name: "调整学科目录宽度" });
    expect(splitter.getAttribute("aria-valuenow")).toBe("320");
    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    expect(splitter.getAttribute("aria-valuenow")).toBe("336");
    fireEvent.keyDown(splitter, { key: "ArrowRight", shiftKey: true });
    expect(splitter.getAttribute("aria-valuenow")).toBe("400");
    const save = screen.getByRole("button", { name: "保存草稿" });
    selectSubjectSettingsTab("飞书回写");
    expect(screen.getByRole("button", { name: "保存草稿" })).toBe(save);
    expect(splitter.getAttribute("aria-valuenow")).toBe("400");
    first.unmount();
    renderPanel();
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("400");
  });

  it("bounds resizing to preserve a usable settings pane and hides the splitter when stacked", () => {
    renderPanel();
    const splitter = screen.getByRole("separator");
    fireEvent.keyDown(splitter, { key: "End" });
    expect(splitter.getAttribute("aria-valuenow")).toBe("520");
    panelWidth = 800;
    fireEvent(window, new Event("resize"));
    expect(splitter.getAttribute("aria-valuenow")).toBe("372");
    fireEvent.keyDown(splitter, { key: "Home" });
    expect(splitter.getAttribute("aria-valuenow")).toBe("240");
    panelWidth = 700;
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("persists a completed pointer drag and restores the start width when cancelled", () => {
    renderPanel();
    const splitter = screen.getByRole("separator");
    const setCapture = vi.fn();
    const releaseCapture = vi.fn();
    Object.assign(splitter, {
      setPointerCapture: setCapture,
      hasPointerCapture: () => true,
      releasePointerCapture: releaseCapture,
    });
    pointer(splitter, "pointerdown", 320);
    pointer(window, "pointermove", 430);
    expect(splitter.getAttribute("aria-valuenow")).toBe("430");
    pointer(window, "pointerup", 430);
    expect(setCapture).toHaveBeenCalledWith(1);
    expect(releaseCapture).toHaveBeenCalledWith(1);
    expect(JSON.parse(taskboardStorage.getItem(layoutKey) ?? "{}")).toEqual({ catalogWidth: 430 });
    pointer(splitter, "pointerdown", 430);
    pointer(window, "pointermove", 500);
    pointer(window, "pointercancel", 500);
    expect(splitter.getAttribute("aria-valuenow")).toBe("430");
    expect(JSON.parse(taskboardStorage.getItem(layoutKey) ?? "{}")).toEqual({ catalogWidth: 430 });
  });

  it("uses the same lifecycle actions for every subject and stops only an active configuration", () => {
    const configured = subject("lifecycle", "生命周期");
    const view = renderPanel(configured);
    expect(screen.queryByRole("button", { name: /旧 Bridge/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^停用$/ })).toBeNull();
    view.unmount();
    renderPanel({ ...configured, activeConfigVersion: 1 } as FeishuSubjectConfig);
    expect(screen.getByRole("button", { name: /^启用$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^停用$/ })).toBeTruthy();
  });
});

describe("FeishuStageEditor", () => {
  afterEach(() => cleanup());

  it("renders one fixed stage and only the selected status options", () => {
    const onChange = vi.fn();
    render(
      <FeishuStageEditor
        stageId="initial"
        value={stage}
        metadataFields={fields}
        statusOptions={fields[0].options}
        disabled={false}
        audioDraft={audioDraftFromStage(stage.audio)}
        onChange={onChange}
        onAudioChange={vi.fn()}
        validationErrors={[]}
      />,
    );

    expect((screen.getByRole("checkbox", { name: "启用初稿" }) as HTMLInputElement).checked).toBe(true);
    const trigger = screen.getByRole("combobox", { name: "初稿触发选项" });
    expect(trigger).toBeInstanceOf(HTMLSelectElement);
    expect(screen.getByRole("option", { name: "初稿" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "初审修改" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "终审修改" })).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "启用初稿" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("renders the fixed audio choices and disabled shared controls for video original", () => {
    render(<ControlledEditor />);

    const source = screen.getByRole("combobox", { name: "初稿音频来源" });
    expect(within(source).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "视频原音",
      "文档目录",
      "Base 字段附件",
    ]);
    expect(screen.queryByText("声音方式")).toBeNull();
    expect(screen.queryByRole("button", { name: "使用视频原音" })).toBeNull();
    expect(screen.queryByRole("button", { name: "外部音频替换原音" })).toBeNull();

    const details = screen.getByRole("textbox", { name: "初稿音频来源详情" }) as HTMLInputElement;
    const tolerance = screen.getByRole("spinbutton", { name: "初稿时长误差（秒）" }) as HTMLInputElement;
    expect(details.disabled).toBe(true);
    expect(details.placeholder).toBe("视频原音无需设置");
    expect(tolerance.disabled).toBe(true);
    expect(tolerance.value).toBe("3");
  });

  it("switches one detail control and retains document attachment and tolerance drafts", () => {
    const onStageChange = vi.fn();
    render(<ControlledEditor onStageChange={onStageChange} />);

    const source = screen.getByRole("combobox", { name: "初稿音频来源" });
    fireEvent.change(source, { target: { value: "docx_section" } });
    const docx = screen.getByRole("textbox", { name: "初稿音频目录标题" }) as HTMLInputElement;
    fireEvent.change(docx, { target: { value: "二、PPT草稿+翻录" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "初稿时长误差（秒）" }), { target: { value: "1.5" } });

    fireEvent.change(source, { target: { value: "base_attachment" } });
    const attachment = screen.getByRole("combobox", { name: "初稿音频附件字段" }) as HTMLSelectElement;
    expect(within(attachment).queryByRole("option", { name: "普通文本" })).toBeNull();
    expect(within(attachment).queryByRole("option", { name: "伪附件类型" })).toBeNull();
    expect(within(attachment).queryByRole("option", { name: "伪附件界面" })).toBeNull();
    expect(within(attachment).getByRole("option", { name: "视频附件" })).toBeTruthy();
    expect(within(attachment).getByRole("option", { name: "配音附件" })).toBeTruthy();
    fireEvent.change(attachment, { target: { value: "fld_audio" } });

    fireEvent.change(source, { target: { value: "video_original" } });
    expect((screen.getByRole("spinbutton", { name: "初稿时长误差（秒）" }) as HTMLInputElement).value).toBe("1.5");

    fireEvent.change(source, { target: { value: "docx_section" } });
    expect((screen.getByRole("textbox", { name: "初稿音频目录标题" }) as HTMLInputElement).value).toBe("二、PPT草稿+翻录");
    fireEvent.change(source, { target: { value: "base_attachment" } });
    expect((screen.getByRole("combobox", { name: "初稿音频附件字段" }) as HTMLSelectElement).value).toBe("fld_audio");

    expect(onStageChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        audio: {
          mode: "replace_original",
          source: { kind: "base_attachment", fieldId: "fld_audio" },
          durationToleranceSeconds: 1.5,
        },
      }),
      {
        docxAnchorText: "二、PPT草稿+翻录",
        baseAttachmentFieldId: "fld_audio",
        durationToleranceSeconds: 1.5,
      },
    );
  });

  it("disables a new Base attachment selection when no attachment field exists", () => {
    render(<ControlledEditor metadataFields={fields.slice(0, 2)} />);

    const source = screen.getByRole("combobox", { name: "初稿音频来源" });
    const option = within(source).getByRole("option", { name: "Base 字段附件（无可用字段）" }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it("shows a deleted saved attachment as an empty selection", () => {
    render(<ControlledEditor
      initialStage={{
        ...stage,
        audio: {
          mode: "replace_original",
          source: { kind: "base_attachment", fieldId: "fld_deleted" },
          durationToleranceSeconds: 2,
        },
      }}
    />);

    const attachment = screen.getByRole("combobox", { name: "初稿音频附件字段" }) as HTMLSelectElement;
    expect(attachment.value).toBe("");
    expect(within(attachment).queryByText("当前不可用")).toBeNull();
  });
});

describe("FeishuWorkflowPanel shared execution mode", () => {
  afterEach(() => cleanup());

  function panelProps(configured: FeishuSubjectConfig) {
    return {
      catalog: catalog(configured),
      configurationBaseToken: "bas_test",
      selectedSubjectKey: configured.subjectKey,
      onSelectSubject: vi.fn(),
      onCatalogChange: vi.fn(),
      onSubjectChange: vi.fn(),
    };
  }

  it("edits one course delivery root and preserves selected existing writeback fields", async () => {
    const configured = subject("course-delivery", "课程交付");
    const withDelivery = configured as FeishuSubjectConfig & {
      delivery: {
        version: 1;
        rootPath: string;
        courseNaming: { mode: "field"; fieldId: string };
        coursePathWriteback: { enabled: boolean; fieldId: string | null };
        writeback: Record<"initial" | "first_review" | "final_review", {
          onProcessing: Array<{ fieldId: string; optionId: string }>;
          onUploaded: Array<{ fieldId: string; optionId: string }>;
        }>;
        finalDirectoryTrigger: { enabled: boolean; fieldId: string | null; optionId: string | null };
      };
    };
    withDelivery.delivery = {
      version: 1,
      rootPath: "W:\\交付根目录",
      courseNaming: { mode: "field", fieldId: "fld_text" },
      coursePathWriteback: { enabled: true, fieldId: "fld_text" },
      writeback: {
        initial: { onProcessing: [{ fieldId: "fld_status", optionId: "opt_initial" }], onUploaded: [{ fieldId: "fld_status", optionId: "opt_review" }] },
        first_review: { onProcessing: [{ fieldId: "fld_removed", optionId: "opt_initial" }], onUploaded: [] },
        final_review: { onProcessing: [], onUploaded: [{ fieldId: "fld_status", optionId: "opt_removed" }] },
      },
      finalDirectoryTrigger: { enabled: true, fieldId: "fld_status", optionId: "opt_final" },
    };
    const onSaveDraft = vi.fn(async (_subjectKey: string, patch: unknown) => ({
      ...withDelivery,
      ...(patch as Partial<FeishuSubjectConfig>),
      configVersion: 2,
    }));

    render(<LegacyFeishuWorkflowPanel {...panelProps(withDelivery)} onSaveDraft={onSaveDraft} />);

    fireEvent.click(screen.getByRole("tab", { name: "存储与目录" }));
    const storage = screen.getByRole("tabpanel", { name: "存储与目录" });
    expect((within(storage).getByRole("textbox", { name: "课程交付总路径" }) as HTMLInputElement).value)
      .toBe("W:\\交付根目录");
    expect((within(storage).getByRole("combobox", { name: "课程名称字段" }) as HTMLSelectElement).value)
      .toBe("fld_text");
    expect((within(storage).getByRole("combobox", { name: "成片触发选项" }) as HTMLSelectElement).value)
      .toBe("opt_final");
    const directories = within(storage).getByRole("region", { name: "自动阶段目录" });
    expect(directories.textContent).toContain("初稿");
    expect(directories.textContent).toContain("01初稿");
    expect(directories.textContent).toContain("初审修改");
    expect(directories.textContent).toContain("02初审");
    expect(directories.textContent).toContain("终审修改");
    expect(directories.textContent).toContain("03终审");
    expect(directories.textContent).toContain("该阶段 ZIP 上传时创建");
    expect(directories.textContent).not.toContain("00成片");
    const coursePreview = within(storage).getByRole("region", { name: "课程目录预览" });
    expect(coursePreview.textContent).toContain("W:\\交付根目录\\{普通文本}");
    expect(coursePreview.textContent).toContain("W:\\交付根目录\\{普通文本}\\01初稿");
    expect(coursePreview.textContent).toContain("W:\\交付根目录\\{普通文本}\\02初审");
    expect(coursePreview.textContent).toContain("W:\\交付根目录\\{普通文本}\\03终审");
    expect(coursePreview.textContent).toContain("W:\\交付根目录\\{普通文本}\\00成片");
    const finalTrigger = within(storage).getByRole("group", { name: "成片目录触发" });
    expect(within(finalTrigger).getByLabelText("指定状态进入时创建00成片")).toBeTruthy();
    expect(within(finalTrigger).getByRole("combobox", { name: "成片触发字段" })).toBeTruthy();
    expect(within(finalTrigger).getByRole("combobox", { name: "成片触发选项" })).toBeTruthy();
    expect(within(storage).queryByRole("region", { name: "成片目录预览" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "飞书回写" }));
    const writeback = screen.getByRole("tabpanel", { name: "飞书回写" });
    expect((within(writeback).getByRole("combobox", { name: "初稿处理中字段" }) as HTMLSelectElement).value)
      .toBe("fld_status");
    expect((within(writeback).getByRole("combobox", { name: "初稿处理中选项" }) as HTMLSelectElement).value)
      .toBe("opt_initial");
    const coursePathWriteback = within(writeback).getByRole("group", { name: "课程目录回写" });
    expect(within(coursePathWriteback).getByLabelText("回写课程目录")).toBeTruthy();
    expect(within(coursePathWriteback).getByRole("combobox", { name: "课程目录文本字段" })).toBeTruthy();
    const writebackPreview = within(writeback).getByRole("region", { name: "回写预览" });
    expect(writebackPreview.textContent).toContain("初稿 · 处理中");
    expect(writebackPreview.textContent).toContain("流程状态");
    expect(writebackPreview.textContent).toContain("初稿");
    expect(writebackPreview.textContent).toContain("初稿 · ZIP 上传成功");
    expect(writebackPreview.textContent).toContain("初审修改");
    expect(writebackPreview.textContent).toContain("首个 ZIP 上传成功");
    expect(writebackPreview.textContent).toContain("普通文本");
    expect(writebackPreview.textContent).toContain("交付根目录\\{普通文本}");
    expect(writebackPreview.textContent).toContain("映射盘共享名称在运行时解析");
    expect(writebackPreview.textContent).not.toContain("初审修改 · 处理中");
    expect(writebackPreview.textContent).not.toContain("终审修改 · ZIP 上传成功");

    fireEvent.click(screen.getByRole("tab", { name: "存储与目录" }));
    fireEvent.change(screen.getByRole("textbox", { name: "课程交付总路径" }), { target: { value: "W:\\新交付根目录" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    expect(onSaveDraft.mock.calls[0][1]).toMatchObject({
      delivery: expect.objectContaining({ rootPath: "W:\\新交付根目录" }),
    });
  });

  it("explains which course directory preview configuration is missing", () => {
    const configured = subject("course-preview-missing", "课程目录预览缺失配置");
    configured.delivery = {
      version: 1,
      rootPath: null,
      courseNaming: { mode: "field", fieldId: null },
      coursePathWriteback: { enabled: false, fieldId: null },
      writeback: {
        initial: { onProcessing: [], onUploaded: [] },
        first_review: { onProcessing: [], onUploaded: [] },
        final_review: { onProcessing: [], onUploaded: [] },
      },
      finalDirectoryTrigger: { enabled: false, fieldId: null, optionId: null },
    };

    render(<LegacyFeishuWorkflowPanel {...panelProps(configured)} />);
    fireEvent.click(screen.getByRole("tab", { name: "存储与目录" }));

    expect(within(screen.getByRole("region", { name: "课程目录预览" })).getByText("请先填写课程交付总路径并选择课程名称字段。")).toBeTruthy();
  });

  it("shows a compact empty state when no valid writeback is configured", () => {
    const configured = subject("writeback-preview-empty", "回写预览空状态");
    configured.delivery = {
      version: 1,
      rootPath: "W:\\交付根目录",
      courseNaming: { mode: "field", fieldId: "fld_text" },
      coursePathWriteback: { enabled: false, fieldId: null },
      writeback: {
        initial: { onProcessing: [{ fieldId: "fld_removed", optionId: "opt_initial" }], onUploaded: [] },
        first_review: { onProcessing: [], onUploaded: [{ fieldId: "fld_status", optionId: "opt_removed" }] },
        final_review: { onProcessing: [], onUploaded: [] },
      },
      finalDirectoryTrigger: { enabled: false, fieldId: null, optionId: null },
    };

    render(<LegacyFeishuWorkflowPanel {...panelProps(configured)} />);
    fireEvent.click(screen.getByRole("tab", { name: "飞书回写" }));

    expect(within(screen.getByRole("region", { name: "回写预览" })).getByText("尚未配置有效的回写内容。")).toBeTruthy();
  });

  it("shows phased settings in four pages while retaining unsaved execution changes", () => {
    const configured = subject("history", "高中历史");
    render(<LegacyFeishuWorkflowPanel {...panelProps(configured)} />);

    const tabs = within(screen.getByRole("tablist", { name: "学科配置分区" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["基础与执行", "素材与阶段", "存储与目录", "飞书回写"]);
    expect(screen.getByRole("tab", { name: "基础与执行" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "基础与执行" })).toBeTruthy();
    expect(screen.queryByRole("tabpanel", { name: "素材与阶段" })).toBeNull();
    const modeGroup = screen.getByRole("group", { name: "剪辑模式" });
    expect(within(modeGroup).getByRole("button", { name: "手动" })).toBeTruthy();
    expect(within(modeGroup).getByRole("button", { name: "自动" })).toBeTruthy();

    fireEvent.click(within(modeGroup).getByRole("button", { name: "自动" }));
    fireEvent.click(screen.getByRole("tab", { name: "素材与阶段" }));
    const stages = screen.getByRole("tabpanel", { name: "素材与阶段" });
    for (const stageName of ["初稿", "初审修改", "终审修改"]) {
      expect(within(stages).getByRole("combobox", { name: `${stageName}视频来源类型` })).toBeTruthy();
      expect(within(stages).getByRole("combobox", { name: `${stageName}剪辑意见来源类型` })).toBeTruthy();
      expect(within(stages).getByRole("combobox", { name: `${stageName}音频来源` })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("tab", { name: "飞书回写" }));
    expect(screen.getByText("请先在存储与目录中启用固定课程目录交付。")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "存储与目录" }));
    expect(screen.getByRole("tabpanel", { name: "存储与目录" })).toBeTruthy();
    expect(screen.getByLabelText("启用固定课程目录交付")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("启用固定课程目录交付"));
    expect(screen.getByLabelText("指定状态进入时创建00成片")).toBeTruthy();
    expect(screen.queryByLabelText("初稿处理中字段")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "飞书回写" }));
    expect(screen.getByRole("tabpanel", { name: "飞书回写" })).toBeTruthy();
    expect(screen.getByLabelText("阶段状态回写")).toBeTruthy();
    expect(screen.queryByLabelText("指定状态进入时创建00成片")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "基础与执行" }));
    expect(within(screen.getByRole("group", { name: "剪辑模式" })).getByRole("button", { name: "自动" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("supports keyboard page navigation and resets to basics for another subject", async () => {
    const history = subject("history-tabs", "高中历史");
    const geography = subject("geography-tabs", "高中地理");
    if (!geography.execution) throw new Error("fixture requires execution settings");
    geography.execution.mode = "automatic";
    const common = {
      catalog: catalog(history, geography),
      configurationBaseToken: "bas_test",
      onSelectSubject: vi.fn(),
      onCatalogChange: vi.fn(),
      onSubjectChange: vi.fn(),
    };
    const { rerender } = render(<LegacyFeishuWorkflowPanel {...common} selectedSubjectKey={history.subjectKey} />);

    const basics = screen.getByRole("tab", { name: "基础与执行" });
    fireEvent.keyDown(basics, { key: "End" });
    const writeback = screen.getByRole("tab", { name: "飞书回写" });
    expect(writeback.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(writeback);

    rerender(<LegacyFeishuWorkflowPanel {...common} selectedSubjectKey={geography.subjectKey} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "基础与执行" }).getAttribute("aria-selected")).toBe("true"));
    expect(within(screen.getByRole("group", { name: "剪辑模式" })).getByRole("button", { name: "自动" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("renders the approved card hierarchy for subject configuration", () => {
    const configured = subject("history", "高中历史");
    render(<LegacyFeishuWorkflowPanel {...panelProps(configured)} />);

    expect(screen.getByRole("region", { name: "学科配置" }).className).toContain("feishu-subject-settings");
    expect(screen.getByRole("region", { name: "通用执行设置" }).className).toContain("feishu-execution-settings");
    expect(screen.getByRole("group", { name: "Auto-Cut 路由" }).className).toContain("feishu-config-card");
    expect(screen.getByRole("group", { name: "ZIP 与上传" }).className).toContain("feishu-config-card");

    fireEvent.click(screen.getByRole("tab", { name: "素材与阶段" }));
    expect(screen.getByRole("region", { name: "素材与阶段" }).className).toContain("feishu-config-card");
  });

  it.each(["phased", "metadata fallback", "legacy"])("shows one shared mode without editable scheduling groups for %s subjects", (kind) => {
    const configured = kind === "phased" ? subject("history", "高中历史") : legacySubject("history", "高中历史");
    if (kind === "legacy") configured.metadata = { fields: [] };
    render(<LegacyFeishuWorkflowPanel {...panelProps(configured)} />);

    const common = screen.getByRole("region", { name: "通用执行设置" });
    expect(screen.getAllByRole("group", { name: "剪辑模式" })).toHaveLength(1);
    expect(within(common).getByRole("button", { name: "手动" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(common).queryByRole("textbox", { name: "并发组" })).toBeNull();
    expect(within(common).queryByRole("spinbutton", { name: "并发数" })).toBeNull();
    expect(within(common).queryByRole("textbox", { name: "资源组" })).toBeNull();
    if (kind !== "legacy") {
      fireEvent.click(screen.getByRole("tab", { name: "素材与阶段" }));
      const phases = screen.getByRole("region", { name: "素材与阶段" });
      expect(within(phases).queryByRole("group", { name: "剪辑模式" })).toBeNull();
    }
  });

  it.each(["manual", "automatic"] as const)("saves a change from %s without publishing until explicit enable", async (originalMode) => {
    vi.mocked(listFeishuPackages).mockResolvedValueOnce([{
      alias: "Auto-cut-A", name: "Auto-Cut A", projectId: "auto-cut-a", workspacePath: null,
      model: null, reasoningEffort: null, prompt: null, zipSourceDirectory: null,
      maxConcurrent: 1, resourceGroups: [], state: "enabled", revision: 1, updatedAt: "2026-09-15T00:00:00.000Z",
      referenceCount: 0, references: [],
    }]);
    const configured = subject("history", "高中历史");
    configured.lifecycle = "enabled";
    configured.execution = { mode: originalMode, concurrencyGroup: "history", maxConcurrent: 2, resourceGroups: ["editor", "gpu"] };
    configured.packageRoute!.packageAlias = "Auto-cut-A";
    configured.documentField!.fieldName = "普通文本";
    configured.namingField!.fieldName = "普通文本";
    const nextMode = originalMode === "manual" ? "automatic" : "manual";
    const onEnable = vi.fn(async (saved: FeishuSubjectConfig) => ({ ...saved, lifecycle: "enabled" as const }));
    const onSaveDraft = vi.fn(async (_subjectKey: string, rawPatch: unknown) => ({
      ...configured, ...(rawPatch as Partial<FeishuSubjectConfig>),
      configVersion: 2, lifecycle: "draft" as const,
    }));
    function SavedPanel() {
      const [current, setCurrent] = useState(configured);
      return <LegacyFeishuWorkflowPanel {...panelProps(current)} onSubjectChange={setCurrent} onSaveDraft={onSaveDraft} onEnable={onEnable} />;
    }
    render(<SavedPanel />);

    const modeButton = (mode: "manual" | "automatic") => within(screen.getByRole("group", { name: "剪辑模式" }))
      .getByRole("button", { name: mode === "manual" ? "手动" : "自动" });
    expect(modeButton(originalMode).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(modeButton(nextMode));
    expect(modeButton(nextMode).getAttribute("aria-pressed")).toBe("true");
    expect(onSaveDraft).not.toHaveBeenCalled();
    expect(onEnable).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    const [subjectKey, patch] = onSaveDraft.mock.calls[0];
    expect(subjectKey).toBe(configured.subjectKey);
    expect(patch).toMatchObject({
      expectedVersion: 1,
      execution: { ...configured.execution, mode: nextMode },
      stages: configured.stages,
      upload: configured.upload,
      packageRoute: configured.packageRoute,
    });
    expect(onEnable).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "启用" }));
    await waitFor(() => expect(onEnable).toHaveBeenCalledTimes(1));
    expect(onEnable).toHaveBeenCalledWith(expect.objectContaining({
      subjectKey: configured.subjectKey, configVersion: 2, lifecycle: "draft",
      execution: { ...configured.execution, mode: nextMode },
    }));
  });

  it("loads each subject's saved mode when switching subjects", () => {
    const manual = subject("history", "高中历史");
    const automatic = subject("history-copy", "高中历史副本");
    automatic.execution!.mode = "automatic";
    const props = { ...panelProps(manual), catalog: catalog(manual, automatic) };
    const { rerender } = render(<LegacyFeishuWorkflowPanel {...props} />);
    expect(within(screen.getByRole("group", { name: "剪辑模式" })).getByRole("button", { name: "手动" }).getAttribute("aria-pressed")).toBe("true");
    rerender(<LegacyFeishuWorkflowPanel {...props} selectedSubjectKey={automatic.subjectKey} />);
    expect(within(screen.getByRole("group", { name: "剪辑模式" })).getByRole("button", { name: "自动" }).getAttribute("aria-pressed")).toBe("true");
    rerender(<LegacyFeishuWorkflowPanel {...props} />);
    expect(within(screen.getByRole("group", { name: "剪辑模式" })).getByRole("button", { name: "手动" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("reports unknown, off and on machine policy without changing the subject mode", () => {
    const configured = subject("history", "高中历史");
    configured.execution!.mode = "automatic";
    const props = panelProps(configured);
    const { rerender } = render(<LegacyFeishuWorkflowPanel {...props} />);
    const status = () => screen.getByRole("status", { name: "本机自动执行状态" });
    expect(status().textContent).toContain("状态未知");
    rerender(<LegacyFeishuWorkflowPanel {...props} allowAutomaticExecution={false} />);
    expect(status().textContent).toContain("关闭");
    rerender(<LegacyFeishuWorkflowPanel {...props} allowAutomaticExecution />);
    expect(status().textContent).toContain("开启");
    expect(within(screen.getByRole("group", { name: "剪辑模式" })).getByRole("button", { name: "自动" }).getAttribute("aria-pressed")).toBe("true");
    expect(props.onSubjectChange).not.toHaveBeenCalled();
  });

  it("opens machine settings from the global switch status without modifying the subject", () => {
    const configured = subject("history", "高中历史");
    configured.execution!.mode = "automatic";
    const props = panelProps(configured);
    const onOpenLocalSettings = vi.fn();
    render(<LegacyFeishuWorkflowPanel {...props} allowAutomaticExecution={false} onOpenLocalSettings={onOpenLocalSettings} />);
    fireEvent.click(screen.getByRole("button", { name: "本机设置" }));
    expect(onOpenLocalSettings).toHaveBeenCalledOnce();
    expect(props.onSubjectChange).not.toHaveBeenCalled();
  });
});

describe("FeishuWorkflowPanel upload destinations", () => {
  afterEach(() => cleanup());

  function configuredSubject(kind: "phased" | "legacy" = "phased") {
    const configured = kind === "phased" ? subject("history", "高中历史") : legacySubject("history", "高中历史");
    if (kind === "legacy") configured.metadata = { fields: [] };
    else {
      configured.documentField = { fieldId: "fld_text", fieldName: "普通文本" };
      configured.namingField = { fieldId: "fld_text", fieldName: "普通文本" };
      configured.stages!.first_review.artifactTargetPath = null;
      configured.stages!.final_review.artifactTargetPath = null;
    }
    configured.packageRoute!.packageAlias = "Auto-cut-A";
    configured.upload!.enqueueMode = "automatic";
    return configured;
  }

  function panelProps(configured: FeishuSubjectConfig) {
    vi.mocked(listFeishuPackages).mockResolvedValueOnce([{
      alias: "Auto-cut-A", name: "Auto-Cut A", projectId: "auto-cut-a", workspacePath: null,
      model: null, reasoningEffort: null, prompt: null, zipSourceDirectory: null,
      maxConcurrent: 1, resourceGroups: [], state: "enabled", revision: 1, updatedAt: "2026-09-16T00:00:00.000Z",
      referenceCount: 0, references: [],
    }]);
    return {
      catalog: catalog(configured),
      configurationBaseToken: "bas_test",
      selectedSubjectKey: configured.subjectKey,
      onSelectSubject: vi.fn(),
      onCatalogChange: vi.fn(),
      onSubjectChange: vi.fn(),
      onSaveDraft: vi.fn(),
    };
  }

  it("enables automatic phased upload with only enabled stage destinations", async () => {
    const configured = configuredSubject();
    const onEnable = vi.fn(async () => configured);
    render(<LegacyFeishuWorkflowPanel {...panelProps(configured)} onEnable={onEnable} />);

    const enable = screen.getByRole("button", { name: "启用" }) as HTMLButtonElement;
    await waitFor(() => expect(enable.disabled).toBe(false));
    fireEvent.click(enable);
    await waitFor(() => expect(onEnable).toHaveBeenCalledWith(configured));
    expect(configured.upload).toMatchObject({ targetId: null, targetPath: null });
  });

  it.each(["initial", "first_review", "final_review"] as const)("requires the enabled %s destination for automatic upload", async (stageId) => {
    const configured = configuredSubject();
    configured.stages![stageId].enabled = true;
    configured.stages![stageId].artifactTargetPath = null;
    render(<LegacyFeishuWorkflowPanel {...panelProps(configured)} />);

    const labels = { initial: "初稿", first_review: "初审修改", final_review: "终审修改" };
    const reason = `${labels[stageId]}需要 ZIP 目标目录`;
    selectSubjectSettingsTab("素材与阶段");
    expect(screen.getByText(reason)).toBeTruthy();
    const enable = screen.getByRole("button", { name: "启用" }) as HTMLButtonElement;
    await waitFor(() => expect(enable.getAttribute("title")).toBe(reason));
    expect(enable.disabled).toBe(true);
  });

  it("does not require stage destinations for manual upload", async () => {
    const configured = configuredSubject();
    configured.upload!.enqueueMode = "manual";
    configured.stages!.initial.artifactTargetPath = null;
    render(<LegacyFeishuWorkflowPanel {...panelProps(configured)} />);

    expect(screen.queryByText("初稿需要 ZIP 目标目录")).toBeNull();
    await waitFor(() => expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("keeps the common destination required for legacy automatic upload", async () => {
    const configured = configuredSubject("legacy");
    render(<LegacyFeishuWorkflowPanel {...panelProps(configured)} />);

    expect(screen.getByRole("textbox", { name: "上传路径" })).toBeTruthy();
    const enable = screen.getByRole("button", { name: "启用" }) as HTMLButtonElement;
    await waitFor(() => expect(enable.getAttribute("title")).toBe("请填写上传路径"));
    expect(enable.disabled).toBe(true);
  });

  it.each(["phased", "legacy"] as const)("preserves historical upload settings without an alias input for %s subjects", async (kind) => {
    const configured = configuredSubject(kind);
    configured.upload = {
      ...configured.upload!,
      artifactSourceMode: "driver_report",
      artifactSourcePath: "C:\\approved\\output",
      targetId: "historical-upload",
      targetPath: "C:\\approved\\historical-target",
    };
    const onSaveDraft = vi.fn(async (_subjectKey: string, _patch: unknown) => configured);
    render(<LegacyFeishuWorkflowPanel {...panelProps(configured)} onSaveDraft={onSaveDraft} />);

    expect(screen.queryByRole("textbox", { name: "上传目标别名" })).toBeNull();
    const commonPath = screen.queryByRole("textbox", { name: "上传路径" });
    if (kind === "phased") {
      expect(commonPath).toBeNull();
      selectSubjectSettingsTab("素材与阶段");
      expect((screen.getByRole("textbox", { name: "初稿 ZIP 目标目录" }) as HTMLInputElement).value).toBe(stage.artifactTargetPath);
      selectSubjectSettingsTab("基础与执行");
    } else expect((commonPath as HTMLInputElement).value).toBe(configured.upload.targetPath);
    expect((screen.getByRole("textbox", { name: "ZIP 来源根目录" }) as HTMLInputElement).value).toBe(configured.upload.artifactSourcePath);
    expect(screen.getByRole("combobox", { name: "上传入队" })).toBeTruthy();

    fireEvent.change(screen.getByRole("spinbutton", { name: "上传并发数" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    expect(onSaveDraft.mock.calls[0][1]).toMatchObject({ upload: { ...configured.upload, uploadConcurrency: 2 } });
  });
});

describe("separate stage trigger fields", () => {
  afterEach(() => cleanup());

  const reviewField = {
    fieldId: "fld_review_status", fieldName: "审核状态", type: 3, uiType: "SingleSelect",
    options: [{ id: "opt_initial", name: "待初审修改" }, { id: "opt_review_final", name: "待终审修改" }],
  };

  function renderTriggers(configured = subject("split", "分字段学科")) {
    configured.metadata = { fields: [...fields, reviewField] };
    const onSaveDraft = vi.fn(async (_key: string, _patch: unknown) => configured);
    render(<LegacyFeishuWorkflowPanel catalog={catalog(configured)} configurationBaseToken="bas_test"
      selectedSubjectKey={configured.subjectKey} onSelectSubject={vi.fn()} onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()} onSaveDraft={onSaveDraft} />);
    selectSubjectSettingsTab("素材与阶段");
    return { configured, onSaveDraft };
  }

  it("keeps both selectors on the legacy field and changes only review triggers", async () => {
    const { configured, onSaveDraft } = renderTriggers();
    expect((screen.getByRole("combobox", { name: "初稿触发字段" }) as HTMLSelectElement).value).toBe("fld_status");
    const review = screen.getByRole("combobox", { name: "审核修改触发字段" });
    expect((review as HTMLSelectElement).value).toBe("fld_status");
    fireEvent.change(review, { target: { value: reviewField.fieldId } });
    expect((screen.getByRole("combobox", { name: "初稿触发选项" }) as HTMLSelectElement).value).toBe("opt_initial");
    for (const label of ["初审修改", "终审修改"]) {
      const option = screen.getByRole("combobox", { name: `${label}触发选项` });
      expect((option as HTMLSelectElement).value).toBe("");
      expect(within(option).queryByRole("option", { name: "初稿" })).toBeNull();
    }
    fireEvent.click(screen.getByRole("checkbox", { name: "启用初审修改" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "启用终审修改" }));
    fireEvent.change(screen.getByRole("combobox", { name: "初审修改触发选项" }), { target: { value: "opt_initial" } });
    fireEvent.change(screen.getByRole("combobox", { name: "终审修改触发选项" }), { target: { value: "opt_review_final" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    expect(onSaveDraft.mock.calls[0][1]).toMatchObject({
      statusField: configured.statusField,
      reviewStatusField: { fieldId: reviewField.fieldId, fieldName: reviewField.fieldName },
      stages: {
        initial: configured.stages!.initial,
        first_review: { ...configured.stages!.first_review, enabled: true, trigger: {
          fieldId: reviewField.fieldId, fieldName: reviewField.fieldName, optionId: "opt_initial", value: "待初审修改",
        } },
        final_review: { ...configured.stages!.final_review, enabled: true, trigger: {
          fieldId: reviewField.fieldId, fieldName: reviewField.fieldName, optionId: "opt_review_final", value: "待终审修改",
        } },
      },
    });
  });

  it("changing or clearing the initial field preserves review options and material sources", () => {
    renderTriggers();
    fireEvent.change(screen.getByRole("combobox", { name: "初稿触发字段" }), { target: { value: reviewField.fieldId } });
    expect((screen.getByRole("combobox", { name: "初稿触发选项" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("combobox", { name: "初审修改触发选项" }) as HTMLSelectElement).value).toBe("opt_review");
    expect((screen.getByRole("combobox", { name: "终审修改触发选项" }) as HTMLSelectElement).value).toBe("opt_final");
    expect((screen.getByRole("textbox", { name: "初稿视频目录标题" }) as HTMLInputElement).value).toBe("录屏");
    fireEvent.change(screen.getByRole("combobox", { name: "初稿触发字段" }), { target: { value: "" } });
    expect((screen.getByRole("combobox", { name: "初稿触发字段" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("combobox", { name: "审核修改触发字段" }) as HTMLSelectElement).value).toBe("fld_status");
  });
});

describe("FeishuWorkflowPanel audio drafts", () => {
  afterEach(() => cleanup());

  it("shows the phased editor for a legacy subject with table metadata", () => {
    const configured = legacySubject("legacy-history", "旧高中历史");
    render(<LegacyFeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="legacy-history"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

    selectSubjectSettingsTab("素材与阶段");
    expect(screen.getByRole("combobox", { name: "初稿触发字段" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "素材文档字段" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "命名字段" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "启用初稿" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "启用初审修改" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "启用终审修改" })).toBeTruthy();
    expect(within(screen.getByRole("combobox", { name: "初稿触发字段" }))
      .getByRole("option", { name: "流程状态" })).toBeTruthy();
  });

  it("preserves a legacy trigger field and non-first option in the phased fallback", async () => {
    const configured = legacySubject("legacy-trigger", "旧触发配置");
    configured.metadata = {
      fields: [
        {
          fieldId: "fld_decoy_status",
          fieldName: "无关状态",
          type: 3,
          uiType: "SingleSelect",
          options: [{ id: "opt_decoy", name: "无关选项" }],
        },
        {
          fieldId: "fld_real_status",
          fieldName: "实际流程状态",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_other", name: "其他" },
            { id: "opt_ready", name: "待剪辑" },
          ],
        },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      ],
    };
    configured.trigger = {
      fieldId: "fld_real_status",
      fieldName: "实际流程状态",
      startValue: "待剪辑",
      optionId: "opt_ready",
    };
    const onSaveDraft = vi.fn(async (_subjectKey: string, _patch: unknown) => configured);
    render(<LegacyFeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="legacy-trigger"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
      onSaveDraft={onSaveDraft}
    />);

    selectSubjectSettingsTab("素材与阶段");
    expect((screen.getByRole("combobox", { name: "初稿触发字段" }) as HTMLSelectElement).value)
      .toBe("fld_real_status");
    expect((screen.getByRole("combobox", { name: "初稿触发选项" }) as HTMLSelectElement).value)
      .toBe("opt_ready");

    fireEvent.change(screen.getByRole("combobox", { name: "素材文档字段" }), {
      target: { value: "fld_document" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "命名字段" }), {
      target: { value: "fld_name" },
    });
    const save = screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    const [, patch] = onSaveDraft.mock.calls[0];
    expect(patch).toMatchObject({
      trigger: {
        fieldId: "fld_real_status",
        fieldName: "实际流程状态",
        startValue: "待剪辑",
        optionId: "opt_ready",
      },
      statusField: { fieldId: "fld_real_status", fieldName: "实际流程状态" },
      documentField: { fieldId: "fld_document", fieldName: "素材文档" },
      namingField: { fieldId: "fld_name", fieldName: "命名" },
      stages: {
        initial: {
          trigger: {
            fieldId: "fld_real_status",
            fieldName: "实际流程状态",
            optionId: "opt_ready",
            value: "待剪辑",
          },
        },
      },
    });
  });

  it("clears a supplied stale legacy option id instead of rebinding it by name", () => {
    const configured = legacySubject("legacy-stale-option", "旧失效选项");
    configured.metadata = {
      fields: [
        {
          fieldId: "fld_status",
          fieldName: "流程状态",
          type: 3,
          uiType: "SingleSelect",
          options: [{ id: "opt_recreated", name: "待剪辑" }],
        },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      ],
    };
    configured.trigger = {
      fieldId: "fld_status",
      fieldName: "流程状态",
      startValue: "待剪辑",
      optionId: "opt_deleted",
    };
    render(<LegacyFeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="legacy-stale-option"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

    selectSubjectSettingsTab("素材与阶段");
    expect((screen.getByRole("combobox", { name: "初稿触发字段" }) as HTMLSelectElement).value)
      .toBe("fld_status");
    expect((screen.getByRole("combobox", { name: "初稿触发选项" }) as HTMLSelectElement).value)
      .toBe("");
    expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("projects a legacy subject upload path into the initial phase fallback", () => {
    const configured = legacySubject("legacy-upload-path", "旧上传路径");
    if (!configured.upload) throw new Error("legacy subject fixture requires upload settings");
    configured.upload.targetPath = "D:\\legacy-upload-path";
    render(<LegacyFeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="legacy-upload-path"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

    selectSubjectSettingsTab("素材与阶段");
    expect((screen.getByRole("textbox", { name: "初稿 ZIP 目标目录" }) as HTMLInputElement).value)
      .toBe("D:\\legacy-upload-path");
  });

  it("keeps an explicitly cleared phased stage destination empty after save and rerender", async () => {
    const configured = subject("cleared-stage-path", "清空阶段路径");
    if (!configured.upload || !configured.stages) throw new Error("fixture requires phased upload settings");
    configured.upload.enqueueMode = "manual";
    configured.upload.targetPath = "D:\\legacy-subject-path";
    let savedSubject = structuredClone(configured);
    const onSaveDraft = vi.fn(async (_subjectKey: string, rawPatch: unknown) => {
      const patch = rawPatch as Partial<FeishuSubjectConfig> & { stages: FeishuStageConfigMap };
      const persistedStages = structuredClone(patch.stages);
      persistedStages.initial.artifactTargetPath = patch.stages.initial.artifactTargetPath?.trim() || null;
      savedSubject = {
        ...savedSubject,
        ...patch,
        stages: persistedStages,
        configVersion: savedSubject.configVersion + 1,
      };
      return savedSubject;
    });
    const common = {
      configurationBaseToken: "bas_test",
      selectedSubjectKey: "cleared-stage-path",
      onSelectSubject: vi.fn(),
      onCatalogChange: vi.fn(),
      onSubjectChange: vi.fn(),
      onSaveDraft,
    };
    const { rerender } = render(<LegacyFeishuWorkflowPanel {...common} catalog={catalog(configured)} />);

    selectSubjectSettingsTab("素材与阶段");
    fireEvent.change(screen.getByRole("textbox", { name: "初稿 ZIP 目标目录" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));

    const [, rawPatch] = onSaveDraft.mock.calls[0];
    const patch = rawPatch as { stages: FeishuStageConfigMap };
    expect(patch.stages.initial.artifactTargetPath).toBe("");

    rerender(<LegacyFeishuWorkflowPanel {...common} catalog={catalog(savedSubject)} />);
    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "初稿 ZIP 目标目录" }) as HTMLInputElement).value)
        .toBe("");
    });
  });

  it("keeps an empty-metadata legacy subject on the legacy save path", async () => {
    const configured = legacySubject("legacy-empty", "空 metadata 学科");
    configured.metadata = { fields: [] };
    const onSaveDraft = vi.fn(async (_subjectKey: string, _patch: unknown) => configured);
    render(<LegacyFeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="legacy-empty"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
      onSaveDraft={onSaveDraft}
    />);

    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    const [, patch] = onSaveDraft.mock.calls[0];
    expect(patch).not.toHaveProperty("statusField");
    expect(patch).not.toHaveProperty("documentField");
    expect(patch).not.toHaveProperty("namingField");
    expect(patch).not.toHaveProperty("stages");
  });

  it("shows only metadata fields whose type and uiType both identify a single select", () => {
    const configured = subject("history", "高中历史");
    render(<LegacyFeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="history"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

    selectSubjectSettingsTab("素材与阶段");
    const status = screen.getByRole("combobox", { name: "初稿触发字段" });
    expect(within(status).getByRole("option", { name: "流程状态" })).toBeTruthy();
    expect(within(status).queryByRole("option", { name: "伪状态类型" })).toBeNull();
    expect(within(status).queryByRole("option", { name: "伪状态界面" })).toBeNull();
  });

  it("clears renamed phased fields and options until the operator selects them again", async () => {
    const configured = subject("renamed", "重命名学科");
    configured.statusField = { fieldId: "fld_status", fieldName: "旧状态" };
    configured.documentField = { fieldId: "fld_document", fieldName: "旧素材文档" };
    configured.namingField = { fieldId: "fld_name", fieldName: "旧命名" };
    configured.stages = Object.fromEntries(Object.entries(stageMap()).map(([stageId, value]) => [
      stageId,
      { ...value, trigger: { ...value.trigger, fieldName: "旧状态" } },
    ])) as FeishuStageConfigMap;
    configured.metadata = {
      fields: [
        ...fields.map((field) => field.fieldId === "fld_status"
          ? {
            ...field,
            fieldName: "新状态",
            options: field.options.map((option) => ({ ...option, name: `新${option.name}` })),
          }
          : field),
        { fieldId: "fld_document", fieldName: "新素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "fld_name", fieldName: "新命名", type: 1, uiType: "Text", options: [] },
      ],
    };
    const onSaveDraft = vi.fn(async (_subjectKey: string, _patch: unknown) => configured);
    render(<LegacyFeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="renamed"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
      onSaveDraft={onSaveDraft}
    />);

    selectSubjectSettingsTab("素材与阶段");
    expect((screen.getByRole("combobox", { name: "初稿触发字段" }) as HTMLSelectElement).value).toBe("");
    expect(within(screen.getByRole("combobox", { name: "初稿触发字段" })).getByRole("option", { name: "新状态" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "素材文档字段" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("combobox", { name: "命名字段" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("combobox", { name: "初稿触发选项" }) as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("button", { name: "保存草稿" }).hasAttribute("disabled")).toBe(false);
    expect(onSaveDraft).not.toHaveBeenCalled();
  });

  it("preserves unsaved operator edits while reconciling a same-subject metadata refresh", async () => {
    const configured = subject("refresh", "刷新学科");
    const refreshed = structuredClone(configured);
    // A metadata-only refresh can arrive with the same config version.
    refreshed.configVersion = configured.configVersion;
    refreshed.metadata = {
      fields: fields.map((field) => field.fieldId === "fld_status"
        ? {
          ...field,
          fieldName: "刷新状态",
          options: field.options.map((option) => ({ ...option, name: `刷新${option.name}` })),
        }
        : field),
    };
    const onSaveDraft = vi.fn(async (_subjectKey: string, _patch: unknown) => refreshed);
    const common = {
      configurationBaseToken: "bas_test",
      onSelectSubject: vi.fn(),
      onCatalogChange: vi.fn(),
      onSubjectChange: vi.fn(),
      onSaveDraft,
    };
    const { rerender } = render(<LegacyFeishuWorkflowPanel
      {...common}
      catalog={catalog(configured)}
      selectedSubjectKey="refresh"
    />);

    selectSubjectSettingsTab("素材与阶段");
    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频来源" }), { target: { value: "docx_section" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿音频目录标题" }), { target: { value: "用户未保存音频" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿命名后缀" }), { target: { value: "_用户未保存" } });

    rerender(<LegacyFeishuWorkflowPanel
      {...common}
      catalog={catalog(refreshed)}
      selectedSubjectKey="refresh"
    />);

    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "初稿音频目录标题" }) as HTMLInputElement).value)
        .toBe("用户未保存音频");
    });
    expect((screen.getByRole("textbox", { name: "初稿命名后缀" }) as HTMLInputElement).value).toBe("_用户未保存");
    expect(within(screen.getByRole("combobox", { name: "初稿触发字段" })).getByRole("option", { name: "刷新状态" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "初稿触发字段" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("combobox", { name: "初稿触发选项" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(false);
    expect(onSaveDraft).not.toHaveBeenCalled();
  });

  it("preserves unrelated unsaved edits when a refreshed server draft clears a renamed trigger", async () => {
    const configured = subject("server-cleared-refresh", "服务端待修复刷新");
    const refreshed = structuredClone(configured);
    refreshed.configVersion += 1;
    refreshed.metadata = {
      fields: fields.map((field) => field.fieldId === "fld_status"
        ? {
          ...field,
          options: field.options.map((option) => option.id === "opt_initial"
            ? { ...option, name: "新初稿" }
            : option),
        }
        : field),
    };
    refreshed.trigger = {
      fieldId: configured.trigger?.fieldId ?? "fld_status",
      fieldName: configured.trigger?.fieldName ?? "流程状态",
      optionId: "pending_initial_option",
      startValue: "待配置",
    };
    refreshed.stages!.initial = {
      ...refreshed.stages!.initial,
      trigger: {
        ...refreshed.stages!.initial.trigger,
        optionId: "pending_initial_option",
        value: "待配置",
      },
    };
    const common = {
      configurationBaseToken: "bas_test",
      onSelectSubject: vi.fn(),
      onCatalogChange: vi.fn(),
      onSubjectChange: vi.fn(),
    };
    const { rerender } = render(<LegacyFeishuWorkflowPanel
      {...common}
      catalog={catalog(configured)}
      selectedSubjectKey="server-cleared-refresh"
    />);

    selectSubjectSettingsTab("素材与阶段");
    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频来源" }), { target: { value: "docx_section" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿音频目录标题" }), { target: { value: "刷新前的配音" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿命名后缀" }), { target: { value: "_刷新前未保存" } });

    rerender(<LegacyFeishuWorkflowPanel
      {...common}
      catalog={catalog(refreshed)}
      selectedSubjectKey="server-cleared-refresh"
    />);

    await waitFor(() => {
      expect((screen.getByRole("combobox", { name: "初稿触发选项" }) as HTMLSelectElement).value).toBe("");
    });
    expect((screen.getByRole("combobox", { name: "初稿音频来源" }) as HTMLSelectElement).value).toBe("docx_section");
    expect((screen.getByRole("textbox", { name: "初稿音频目录标题" }) as HTMLInputElement).value).toBe("刷新前的配音");
    expect((screen.getByRole("textbox", { name: "初稿命名后缀" }) as HTMLInputElement).value).toBe("_刷新前未保存");
  });

  it("preserves unsaved edits when equivalent same-version catalog objects are reallocated", async () => {
    const configured = subject("equivalent-refresh", "等价刷新");
    const common = {
      configurationBaseToken: "bas_test",
      selectedSubjectKey: "equivalent-refresh",
      onSelectSubject: vi.fn(),
      onCatalogChange: vi.fn(),
      onSubjectChange: vi.fn(),
    };
    const { rerender } = render(<LegacyFeishuWorkflowPanel
      {...common}
      catalog={catalog(configured)}
    />);

    selectSubjectSettingsTab("素材与阶段");
    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频来源" }), { target: { value: "docx_section" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿音频目录标题" }), { target: { value: "等价刷新未保存音频" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿命名后缀" }), { target: { value: "_等价刷新未保存" } });

    rerender(<LegacyFeishuWorkflowPanel
      {...common}
      catalog={structuredClone(catalog(configured))}
    />);

    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "初稿音频目录标题" }) as HTMLInputElement).value)
        .toBe("等价刷新未保存音频");
    });
    expect((screen.getByRole("textbox", { name: "初稿命名后缀" }) as HTMLInputElement).value)
      .toBe("_等价刷新未保存");
  });

  it("preserves unsaved edits and marks Base or table name-only refreshes for save", async () => {
    const configured = subject("name-refresh", "原表名");
    const renamed = structuredClone(configured);
    renamed.baseName = "刷新 Base";
    renamed.tableName = "刷新表名";
    renamed.configVersion += 1;
    const common = {
      configurationBaseToken: "bas_test",
      selectedSubjectKey: "name-refresh",
      onSelectSubject: vi.fn(),
      onCatalogChange: vi.fn(),
      onSubjectChange: vi.fn(),
    };
    const { rerender } = render(<LegacyFeishuWorkflowPanel
      {...common}
      catalog={catalog(configured)}
    />);

    selectSubjectSettingsTab("素材与阶段");
    fireEvent.change(screen.getByRole("textbox", { name: "初稿命名后缀" }), { target: { value: "_名称刷新未保存" } });
    rerender(<LegacyFeishuWorkflowPanel
      {...common}
      catalog={catalog(renamed)}
    />);

    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "初稿命名后缀" }) as HTMLInputElement).value)
        .toBe("_名称刷新未保存");
    });
    expect(screen.getByRole("button", { name: "启用" }).getAttribute("title")).toBe("请先保存草稿");
  });

  it("reloads a same-subject persisted edit instead of keeping an obsolete local draft", async () => {
    const configured = subject("server-update", "服务器更新");
    const updated = structuredClone(configured);
    updated.configVersion = configured.configVersion + 1;
    updated.stages!.initial.nameSuffix = "_服务器版本";
    const common = {
      configurationBaseToken: "bas_test",
      onSelectSubject: vi.fn(),
      onCatalogChange: vi.fn(),
      onSubjectChange: vi.fn(),
    };
    const { rerender } = render(<LegacyFeishuWorkflowPanel
      {...common}
      catalog={catalog(configured)}
      selectedSubjectKey="server-update"
    />);

    selectSubjectSettingsTab("素材与阶段");
    fireEvent.change(screen.getByRole("textbox", { name: "初稿命名后缀" }), { target: { value: "_过期本地编辑" } });
    rerender(<LegacyFeishuWorkflowPanel
      {...common}
      catalog={catalog(updated)}
      selectedSubjectKey="server-update"
    />);

    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "初稿命名后缀" }) as HTMLInputElement).value)
        .toBe("_服务器版本");
    });
  });

  it("allows saving but blocks enabling when an enabled stage option was removed from metadata", () => {
    const configured = subject("missing-option", "缺失选项");
    configured.stages!.initial.trigger = { ...configured.stages!.initial.trigger, optionId: "opt_deleted", value: "已删除" };
    render(<LegacyFeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="missing-option"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

    selectSubjectSettingsTab("素材与阶段");
    expect(screen.getByText("初稿需要触发选项")).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("blocks save and enable when an enabled stage option id is ambiguous", () => {
    const configured = subject("ambiguous-option", "歧义选项");
    configured.metadata = {
      fields: fields.map((field) => field.fieldId === "fld_status"
        ? { ...field, options: [...field.options, { id: "opt_initial", name: "重复初稿" }] }
        : field),
    };
    render(<LegacyFeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="ambiguous-option"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

    selectSubjectSettingsTab("素材与阶段");
    expect(screen.getByText("初稿的触发选项不唯一")).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("blocks save when phased field bindings are missing, ambiguous, or inconsistent", () => {
    const configured = subject("invalid-fields", "无效字段");
    configured.documentField = { fieldId: "fld_deleted", fieldName: "已删除文档" };
    configured.namingField = { fieldId: "fld_text", fieldName: "名称" };
    configured.metadata = {
      fields: [...fields, { ...fields[1], fieldName: "重复普通文本" }],
    };
    configured.stages!.initial.trigger.fieldId = "fld_other_status";
    configured.stages!.initial.videoSource = { kind: "base_attachment", fieldId: "fld_deleted_video" };
    render(<LegacyFeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="invalid-fields"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

    expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("blocks save and enable when configured attachment field ids are ambiguous", () => {
    const configured = subject("ambiguous-attachments", "歧义附件");
    configured.stages!.initial.videoSource = { kind: "base_attachment", fieldId: "fld_video" };
    configured.stages!.initial.audio = {
      mode: "replace_original",
      source: { kind: "base_attachment", fieldId: "fld_video" },
      durationToleranceSeconds: 3,
    };
    configured.metadata = {
      fields: [...fields, { ...fields[2], fieldName: "重复视频附件" }],
    };
    render(<LegacyFeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="ambiguous-attachments"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

    selectSubjectSettingsTab("素材与阶段");
    expect(screen.getByText("初稿的视频附件字段不唯一")).toBeTruthy();
    expect(screen.getByText("初稿的音频附件字段不唯一")).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not require ZIP target paths for disabled review stages in automatic upload mode", () => {
    const configured = subject("automatic-disabled-reviews", "自动上传迁移学科");
    configured.upload = {
      enqueueMode: "automatic",
      artifactSourceMode: configured.upload?.artifactSourceMode ?? "manual_select",
      artifactSourcePath: configured.upload?.artifactSourcePath ?? null,
      targetId: configured.upload?.targetId ?? null,
      targetPath: "C:\\approved\\upload",
      uploadConcurrency: configured.upload?.uploadConcurrency ?? 1,
    };
    configured.stages!.first_review.artifactTargetPath = null;
    configured.stages!.final_review.artifactTargetPath = null;

    render(<LegacyFeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="automatic-disabled-reviews"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

    expect(screen.queryByText("初审修改需要 ZIP 目标目录")).toBeNull();
    expect(screen.queryByText("终审修改需要 ZIP 目标目录")).toBeNull();
    expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps audio drafts isolated by subject and stage and saves only the active source", async () => {
    const subjectA = subject("history", "高中历史");
    const subjectB = subject("geography", "高中地理");
    const subjects = catalog(subjectA, subjectB);
    const onSaveDraft = vi.fn(async (_subjectKey: string, _patch: unknown) => subjectA);
    const common = {
      catalog: subjects,
      configurationBaseToken: "bas_test",
      onSelectSubject: vi.fn(),
      onCatalogChange: vi.fn(),
      onSubjectChange: vi.fn(),
      onSaveDraft,
    };
    const { rerender } = render(<LegacyFeishuWorkflowPanel {...common} selectedSubjectKey="history" />);

    selectSubjectSettingsTab("素材与阶段");
    const initialSource = screen.getByRole("combobox", { name: "初稿音频来源" });
    fireEvent.change(initialSource, { target: { value: "docx_section" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿音频目录标题" }), { target: { value: "历史配音" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "初稿时长误差（秒）" }), { target: { value: "1.5" } });

    const finalSource = screen.getByRole("combobox", { name: "终审修改音频来源" });
    fireEvent.change(finalSource, { target: { value: "docx_section" } });
    fireEvent.change(screen.getByRole("textbox", { name: "终审修改音频目录标题" }), { target: { value: "终审配音" } });

    fireEvent.change(initialSource, { target: { value: "base_attachment" } });
    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频附件字段" }), { target: { value: "fld_audio" } });
    fireEvent.change(initialSource, { target: { value: "docx_section" } });
    expect((screen.getByRole("textbox", { name: "初稿音频目录标题" }) as HTMLInputElement).value).toBe("历史配音");
    expect((screen.getByRole("textbox", { name: "终审修改音频目录标题" }) as HTMLInputElement).value).toBe("终审配音");

    rerender(<LegacyFeishuWorkflowPanel {...common} selectedSubjectKey="geography" />);
    selectSubjectSettingsTab("素材与阶段");
    await waitFor(() => expect((screen.getByRole("combobox", { name: "初稿音频来源" }) as HTMLSelectElement).value).toBe("video_original"));
    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频来源" }), { target: { value: "docx_section" } });
    expect((screen.getByRole("textbox", { name: "初稿音频目录标题" }) as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByRole("textbox", { name: "初稿音频目录标题" }), { target: { value: "地理配音" } });

    rerender(<LegacyFeishuWorkflowPanel {...common} selectedSubjectKey="history" />);
    selectSubjectSettingsTab("素材与阶段");
    await waitFor(() => expect((screen.getByRole("combobox", { name: "初稿音频来源" }) as HTMLSelectElement).value).toBe("video_original"));
    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频来源" }), { target: { value: "docx_section" } });
    expect((screen.getByRole("textbox", { name: "初稿音频目录标题" }) as HTMLInputElement).value).toBe("历史配音");
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));

    const [, savedPatch] = onSaveDraft.mock.calls[0];
    const patch = savedPatch as { stages: FeishuStageConfigMap };
    expect(patch.stages.initial.audio).toEqual({
      mode: "replace_original",
      source: { kind: "docx_section", anchorText: "历史配音" },
      durationToleranceSeconds: 1.5,
    });
    expect(JSON.stringify(patch)).not.toMatch(/audioDraft|temporary|cache/i);
  });
});
