import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, enableFeishuPackageWorkflowDraft, getFeishuPackageWorkflowDraft, saveFeishuPackageWorkflowDraft } from "../api";
import type { FeishuFieldMetadata, FeishuPackageWorkflowDraft, FeishuPackageWorkflowTemplate } from "../types";
import { FeishuVmPmoWorkflowEditor, type VmPmoDraftCache } from "./FeishuVmPmoWorkflowEditor";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getFeishuPackageWorkflowDraft: vi.fn(),
  saveFeishuPackageWorkflowDraft: vi.fn(),
  enableFeishuPackageWorkflowDraft: vi.fn(),
}));

const template = { id: "vm_pmo_review_video", version: 1 } as const;
function profile(alias = "vm-a", reason = "切片剪辑"): FeishuPackageWorkflowDraft {
  return {
    subjectKey: "subject-a", packageAlias: alias, workflowTemplate: template, revision: 1, updatedAt: "now",
    config: {
      fields: { vmidFieldId: null, outputAttachmentFieldId: null },
      approval: { department: "动画组", reason },
      stages: { initial: { enabled: true, statusFieldId: null, triggerOptionId: null, instructionFieldId: null }, review: { enabled: false, statusFieldId: null, triggerOptionId: null, instructionFieldId: null, instructionAttachmentsFieldId: null } },
    },
  };
}
function editor(cache: VmPmoDraftCache, alias = "vm-a", props: Partial<ComponentProps<typeof FeishuVmPmoWorkflowEditor>> = {}) {
  return <FeishuVmPmoWorkflowEditor subjectKey="subject-a" packageAlias={alias} fields={[]} cache={cache} {...props} />;
}
function reason() { return screen.getByRole("textbox", { name: "申请原因" }) as HTMLInputElement; }
function selectTab(name: string) { fireEvent.click(screen.getByRole("tab", { name })); }
const conflictMessage = "草稿已被其他窗口修改。请重新加载后再保存。";
const invalidConfigMessage = "配置不完整或无效，请检查字段、选项和归档路径。";
const unknownConfigMessage = "流程草稿格式已过期或包含未知配置项，请重新加载最新草稿并核对后保存。";

describe("VM package draft editing boundaries", () => {
  beforeEach(() => {
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (_subject, alias) => profile(alias));
    vi.mocked(saveFeishuPackageWorkflowDraft).mockImplementation(async (_subject, alias, _revision, config) => ({ ...profile(alias), revision: 2, config }));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });

  const readyFields: FeishuFieldMetadata[] = [
    { fieldId: "vmid", fieldName: "VMID", type: 1, uiType: "Text", options: [] },
    { fieldId: "name", fieldName: "名称", type: 20, uiType: "Formula", options: [] },
    { fieldId: "output", fieldName: "成片", type: 17, uiType: "Attachment", options: [] },
    { fieldId: "instruction", fieldName: "初稿意见", type: 1, uiType: "Text", options: [] },
    { fieldId: "status", fieldName: "状态", type: 3, uiType: "SingleSelect", options: [{ id: "ready", name: "待剪辑" }] },
  ];
  function readyProfile() {
    const next = profile();
    next.config.fields = { vmidFieldId: "vmid", namingFieldId: "name", outputAttachmentFieldId: "output" };
    next.config.stages.initial = { enabled: true, statusFieldId: "status", triggerOptionId: "ready", instructionFieldId: "instruction" };
    return next;
  }
  const readyProps = { fields: readyFields, vmPmoInitialReady: true, packageEnabled: true, subjectConfigVersion: 4 };

  it("enables a saved initial-only workflow with both profile and subject versions", async () => {
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(readyProfile());
    const enabled = { subjectKey: "subject-a", configVersion: 5, activeConfigVersion: 5,
      activePackageAlias: "vm-a", workflowTemplate: template };
    vi.mocked(enableFeishuPackageWorkflowDraft).mockResolvedValue(enabled as never);
    const onEnabled = vi.fn();
    render(editor(new Map(), "vm-a", { ...readyProps, onEnabled }));
    await screen.findByRole("group", { name: "视频来源" });
    expect((screen.getByRole("button", { name: "启用流程" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "启用流程" }));
    await screen.findByText("VM 流程已启用。");
    expect(enableFeishuPackageWorkflowDraft).toHaveBeenCalledWith("subject-a", "vm-a", 1, 4);
    expect(onEnabled).toHaveBeenCalledWith(enabled);
    expect(saveFeishuPackageWorkflowDraft).not.toHaveBeenCalled();
  });

  it("enables a complete initial, review and archive workflow", async () => {
    const next = readyProfile();
    const statusOptions = [
      { id: "ready", name: "待剪辑" }, { id: "review", name: "审核修改" }, { id: "archive", name: "出片" },
    ];
    const fields: FeishuFieldMetadata[] = [
      ...readyFields.filter((field) => field.fieldId !== "status"),
      { fieldId: "status", fieldName: "状态", type: 3, uiType: "SingleSelect", options: statusOptions },
      { fieldId: "review-instruction", fieldName: "审核意见", type: 1, uiType: "Text", options: [] },
      { fieldId: "review-images", fieldName: "审核截图", type: 17, uiType: "Attachment", options: [] },
    ];
    next.config.stages.review = {
      enabled: true, statusFieldId: "status", triggerOptionId: "review", instructionFieldId: "review-instruction",
      instructionAttachmentsFieldId: "review-images",
    };
    next.config.finalArchive = {
      enabled: true, statusFieldId: "status", triggerOptionId: "archive",
      pathSource: "manual", directoryPath: "\\\\nas\\deliveries", pathFieldId: null,
    };
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(next);
    const enabled = { subjectKey: "subject-a", configVersion: 5, activeConfigVersion: 5,
      activePackageAlias: "vm-a", workflowTemplate: template };
    vi.mocked(enableFeishuPackageWorkflowDraft).mockResolvedValue(enabled as never);
    const onEnabled = vi.fn();
    render(editor(new Map(), "vm-a", { ...readyProps, fields, onEnabled }));
    await screen.findByRole("group", { name: "视频来源" });
    const button = screen.getByRole("button", { name: "启用流程" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await screen.findByText("VM 流程已启用。");
    expect(enableFeishuPackageWorkflowDraft).toHaveBeenCalledWith("subject-a", "vm-a", 1, 4);
    expect(onEnabled).toHaveBeenCalledWith(enabled);
  });

  it.each([
    { vmPmoInitialReady: false }, { packageEnabled: false }, { subjectConfigVersion: undefined },
  ])("keeps initial activation blocked until local prerequisites are available: %j", async (missing) => {
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(readyProfile());
    render(editor(new Map(), "vm-a", { ...readyProps, ...missing }));
    await screen.findByRole("group", { name: "视频来源" });
    expect((screen.getByRole("button", { name: "启用流程" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "启用流程" }));
    expect(enableFeishuPackageWorkflowDraft).not.toHaveBeenCalled();
  });

  it.each(["review", "archive", "multiselect", "missing-name", "unsaved-profile"])("keeps incomplete %s workflows blocked", async (kind) => {
    const next = readyProfile();
    let fields = readyFields;
    if (kind === "review") next.config.stages.review.enabled = true;
    if (kind === "archive") next.config.finalArchive = { enabled: true, statusFieldId: null, triggerOptionId: null,
      pathSource: "manual", directoryPath: null, pathFieldId: null };
    if (kind === "multiselect") fields = readyFields.map((field) => field.fieldId === "status" ? { ...field, type: 4, uiType: "MultiSelect" } : field);
    if (kind === "missing-name") next.config.fields.namingFieldId = null;
    if (kind === "unsaved-profile") next.revision = 0;
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(next);
    render(editor(new Map(), "vm-a", { ...readyProps, fields }));
    await screen.findByRole("group", { name: "视频来源" });
    expect((screen.getByRole("button", { name: "启用流程" }) as HTMLButtonElement).disabled).toBe(true);
    expect(enableFeishuPackageWorkflowDraft).not.toHaveBeenCalled();
  });

  it("requires saving new edits before enabling and uses the returned revision", async () => {
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(readyProfile());
    vi.mocked(enableFeishuPackageWorkflowDraft).mockResolvedValue({ subjectKey: "subject-a", activePackageAlias: "vm-a", workflowTemplate: template } as never);
    render(editor(new Map(), "vm-a", readyProps));
    await screen.findByRole("group", { name: "视频来源" });
    fireEvent.change(reason(), { target: { value: "仅初稿测试" } });
    expect((screen.getByRole("button", { name: "启用流程" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    expect((screen.getByRole("button", { name: "启用流程" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "启用流程" }));
    await screen.findByText("VM 流程已启用。");
    expect(enableFeishuPackageWorkflowDraft).toHaveBeenCalledWith("subject-a", "vm-a", 2, 4);
  });

  it("preserves saved input and blocks repeated activation after a version conflict", async () => {
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(readyProfile());
    vi.mocked(enableFeishuPackageWorkflowDraft).mockRejectedValue(new ApiError(409, { error: { code: "VERSION_CONFLICT" } }));
    render(editor(new Map(), "vm-a", readyProps));
    await screen.findByRole("group", { name: "视频来源" });
    fireEvent.click(screen.getByRole("button", { name: "启用流程" }));
    await screen.findByText(conflictMessage);
    expect(reason().value).toBe("切片剪辑");
    expect((screen.getByRole("button", { name: "启用流程" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("places opinions inside the two editing stages and removes the duplicate PMO group", async () => {
    render(editor(new Map()));
    await screen.findByRole("group", { name: "视频来源" });
    selectTab("素材与阶段");
    expect(screen.queryByRole("group", { name: "PMO 剪辑意见" })).toBeNull();
    expect(screen.getByRole("region", { name: "VM 初稿配置" })).toBeTruthy();
    const review = screen.getByRole("region", { name: "VM 审核修改配置" });
    expect(within(review).getByRole("combobox", { name: "审核意见字段" })).toBeTruthy();
    expect(within(review).getByRole("combobox", { name: "审核意见附件字段" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "初稿意见字段" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "VM 初审修改配置" })).toBeNull();
    expect(screen.queryByRole("region", { name: "VM 终审修改配置" })).toBeNull();
  });

  it("saves one video name field for initial, review and final outputs across configuration pages", async () => {
    const fields: FeishuFieldMetadata[] = [
      { fieldId: "name", fieldName: "视频名称", type: 20, uiType: "Formula", options: [] },
      { fieldId: "output", fieldName: "成片附件", type: 17, uiType: "Attachment", options: [] },
    ];
    render(<FeishuVmPmoWorkflowEditor subjectKey="subject-a" packageAlias="vm-a" fields={fields} cache={new Map()} />);
    await screen.findByRole("group", { name: "视频来源" });
    const naming = screen.getByRole("group", { name: "视频命名" });
    fireEvent.change(within(naming).getByRole("combobox", { name: "视频主体命名字段" }), { target: { value: "name" } });
    expect(within(naming).queryByRole("checkbox")).toBeNull();
    expect(within(naming).getByText(/最终成片.*<字段值>\.mp4/)).toBeTruthy();
    selectTab("素材与阶段");
    expect(screen.queryByRole("combobox", { name: "初稿视频命名字段" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "审核修改视频命名字段" })).toBeNull();
    expect(screen.getByText(/_初稿\.mp4/)).toBeTruthy();
    expect(screen.getByText(/_第1稿\.mp4.*_第2稿\.mp4/)).toBeTruthy();
    selectTab("存储与目录");
    expect(screen.queryByRole("combobox", { name: "成片视频命名字段" })).toBeNull();
    expect(screen.getByText(/目标路径：/).textContent).toBe("目标路径：{成片归档目录}\\{视频名称}.mp4");
    fireEvent.change(screen.getByRole("combobox", { name: "成品视频附件字段" }), { target: { value: "output" } });
    selectTab("飞书回写");
    selectTab("基础与执行");
    expect((screen.getByRole("combobox", { name: "视频主体命名字段" }) as HTMLSelectElement).value).toBe("name");
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    const submitted = vi.mocked(saveFeishuPackageWorkflowDraft).mock.calls[0][3];
    if (!("fields" in submitted)) throw new Error("Expected a VM workflow draft");
    expect(submitted.fields.namingFieldId).toBe("name");
    expect(submitted.stages).toEqual(profile().config.stages);
    expect(submitted.fields.outputAttachmentFieldId).toBe("output");
  });

  it("offers only unambiguous text and formula metadata for video names and archive paths", async () => {
    const fields: FeishuFieldMetadata[] = [
      { fieldId: "text", fieldName: "合法文本", type: 1, uiType: "Text", options: [] },
      { fieldId: "formula", fieldName: "合法公式", type: "20", uiType: "Formula", options: [] },
      { fieldId: "type-formula", fieldName: "仅类型公式", type: 20, uiType: null, options: [] },
      { fieldId: "ui-formula", fieldName: "仅 UI 公式", type: null, uiType: "Formula", options: [] },
      { fieldId: "number", fieldName: "数字", type: 2, uiType: "Number", options: [] },
      { fieldId: "wrong-formula", fieldName: "矛盾公式", type: 20, uiType: "Text", options: [] },
      { fieldId: "wrong-text", fieldName: "矛盾文本", type: 1, uiType: "Formula", options: [] },
      { fieldId: "coerced-formula", fieldName: "非法公式数字", type: "20.0", uiType: "Formula", options: [] },
      { fieldId: "odd-formula", fieldName: "非法公式 UI", type: 20, uiType: "f_o_r_m_u_l_a", options: [] },
      { fieldId: "duplicate", fieldName: "重复字段 A", type: 1, uiType: "Text", options: [] },
      { fieldId: "duplicate", fieldName: "重复字段 B", type: 20, uiType: "Formula", options: [] },
    ];
    render(<FeishuVmPmoWorkflowEditor subjectKey="subject-a" packageAlias="vm-a" fields={fields} cache={new Map()} />);
    await screen.findByRole("group", { name: "视频来源" });
    for (const [tab, labels] of [
      ["基础与执行", ["视频主体命名字段"]],
      ["存储与目录", ["成片归档路径字段"]],
    ] as const) {
      selectTab(tab);
      if (tab === "存储与目录") fireEvent.change(screen.getByRole("combobox", { name: "成片归档路径来源" }), { target: { value: "pmo_field" } });
      for (const label of labels) {
        const select = screen.getByRole("combobox", { name: label });
        expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
          label === "视频主体命名字段" ? "待选择" : "选择文本或公式字段", "合法文本", "合法公式", "仅类型公式", "仅 UI 公式",
        ]);
      }
    }
  });

  it("preserves archive naming and path when changing its trigger field and saves only the new option", async () => {
    const fields: FeishuFieldMetadata[] = [
      { fieldId: "name", fieldName: "课程名称", type: 20, uiType: "Formula", options: [] },
      { fieldId: "single", fieldName: "交付进度", type: 3, uiType: "SingleSelect", options: [{ id: "done", name: "成片" }] },
      { fieldId: "multi", fieldName: "交付标签", type: 4, uiType: "MultiSelect", options: [{ id: "final", name: "可归档" }] },
    ];
    render(<FeishuVmPmoWorkflowEditor subjectKey="subject-a" packageAlias="vm-a" fields={fields} cache={new Map()} />);
    await screen.findByRole("group", { name: "视频来源" });
    fireEvent.change(screen.getByRole("combobox", { name: "视频主体命名字段" }), { target: { value: "name" } });
    selectTab("存储与目录");
    fireEvent.click(screen.getByRole("checkbox", { name: "启用 VM 成片归档" }));
    fireEvent.change(screen.getByRole("textbox", { name: "成片归档目录" }), { target: { value: "\\\\nas\\video" } });
    fireEvent.change(screen.getByRole("combobox", { name: "成片归档进度字段" }), { target: { value: "single" } });
    fireEvent.change(screen.getByRole("combobox", { name: "成片归档触发状态" }), { target: { value: "done" } });
    fireEvent.change(screen.getByRole("combobox", { name: "成片归档进度字段" }), { target: { value: "multi" } });
    expect((screen.getByRole("combobox", { name: "成片归档触发状态" }) as HTMLSelectElement).value).toBe("");
    fireEvent.change(screen.getByRole("combobox", { name: "成片归档触发状态" }), { target: { value: "final" } });
    selectTab("素材与阶段");
    selectTab("存储与目录");
    expect((screen.getByRole("textbox", { name: "成片归档目录" }) as HTMLInputElement).value).toBe("\\\\nas\\video");
    expect(screen.getByText(/目标路径：/).textContent).toBe("目标路径：\\\\nas\\video\\{课程名称}.mp4");
    expect(screen.queryByRole("combobox", { name: "课程目录命名字段" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    const submitted = vi.mocked(saveFeishuPackageWorkflowDraft).mock.calls[0][3];
    if (!("fields" in submitted)) throw new Error("Expected a VM workflow draft");
    expect(submitted.finalArchive).toEqual({ enabled: true, statusFieldId: "multi", triggerOptionId: "final", pathSource: "manual", directoryPath: "\\\\nas\\video", pathFieldId: null });
    expect(submitted.fields.namingFieldId).toBe("name");
    expect(submitted.stages).toEqual(profile().config.stages);
    expect((screen.getByRole("button", { name: "启用流程" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders absent naming and archive defaults without dirtying an old draft", async () => {
    const onDirtyChange = vi.fn();
    render(editor(new Map(), "vm-a", { onDirtyChange }));
    await screen.findByRole("group", { name: "视频来源" });
    expect((screen.getByRole("combobox", { name: "视频主体命名字段" }) as HTMLSelectElement).value).toBe("");
    selectTab("存储与目录");
    expect((screen.getByRole("checkbox", { name: "启用 VM 成片归档" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("textbox", { name: "成片归档目录" }) as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("combobox", { name: "成片归档路径来源" }) as HTMLSelectElement).value).toBe("manual");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
  });

  it("preserves both directory sources across mode switches and saves the selected source", async () => {
    const original = profile();
    original.config.fields.namingFieldId = "name";
    const fields: FeishuFieldMetadata[] = [
      { fieldId: "name", fieldName: "视频名称", type: 1, uiType: "Text", options: [] },
      { fieldId: "archive-path", fieldName: "归档目录公式", type: 20, uiType: "Formula", options: [] },
    ];
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(original);
    render(<FeishuVmPmoWorkflowEditor subjectKey="subject-a" packageAlias="vm-a" fields={fields} cache={new Map()} />);
    await screen.findByRole("group", { name: "视频来源" });
    selectTab("存储与目录");
    const source = screen.getByRole("combobox", { name: "成片归档路径来源" });
    expect((source as HTMLSelectElement).value).toBe("manual");
    const directory = screen.getByRole("textbox", { name: "成片归档目录" }) as HTMLInputElement;
    expect(directory.placeholder).toContain("\\\\NAS\\");
    expect(directory.placeholder).toContain("W:\\");
    fireEvent.change(directory, { target: { value: "W:\\交付\\本轮" } });
    expect(screen.getByText(/目标路径：/).textContent).toBe("目标路径：W:\\交付\\本轮\\{视频名称}.mp4");
    fireEvent.change(source, { target: { value: "pmo_field" } });
    expect(screen.queryByRole("textbox", { name: "成片归档目录" })).toBeNull();
    expect(screen.getByText(/读取指定 PMO 字段.*具体目录/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "成片归档路径字段" }), { target: { value: "archive-path" } });
    expect(screen.getByText(/目标路径：/).textContent).toBe("目标路径：{归档目录公式}\\{视频名称}.mp4");
    fireEvent.change(source, { target: { value: "manual" } });
    expect((screen.getByRole("textbox", { name: "成片归档目录" }) as HTMLInputElement).value).toBe("W:\\交付\\本轮");
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    const manualSubmitted = vi.mocked(saveFeishuPackageWorkflowDraft).mock.calls[0][3];
    if (!("fields" in manualSubmitted)) throw new Error("Expected a VM workflow draft");
    expect(manualSubmitted.finalArchive).toEqual({
      enabled: false, statusFieldId: null, triggerOptionId: null,
      pathSource: "manual", directoryPath: "W:\\交付\\本轮", pathFieldId: "archive-path",
    });
    fireEvent.change(source, { target: { value: "pmo_field" } });
    expect((screen.getByRole("combobox", { name: "成片归档路径字段" }) as HTMLSelectElement).value).toBe("archive-path");
    selectTab("素材与阶段");
    selectTab("存储与目录");
    expect((screen.getByRole("combobox", { name: "成片归档路径来源" }) as HTMLSelectElement).value).toBe("pmo_field");
    expect((screen.getByRole("combobox", { name: "成片归档路径字段" }) as HTMLSelectElement).value).toBe("archive-path");
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await waitFor(() => expect(vi.mocked(saveFeishuPackageWorkflowDraft).mock.calls).toHaveLength(2));
    const fieldSubmitted = vi.mocked(saveFeishuPackageWorkflowDraft).mock.calls[1][3];
    if (!("fields" in fieldSubmitted)) throw new Error("Expected a VM workflow draft");
    expect(fieldSubmitted.finalArchive).toEqual({
      enabled: false, statusFieldId: null, triggerOptionId: null,
      pathSource: "pmo_field", directoryPath: "W:\\交付\\本轮", pathFieldId: "archive-path",
    });
  });

  it("asks for the explicit archive directory after legacy migration and clears the notice only after saving", async () => {
    const original = { ...profile(), legacyArchivePathNeedsReview: true };
    original.config.finalArchive = {
      enabled: false, statusFieldId: null, triggerOptionId: null,
      pathSource: "manual", directoryPath: null, pathFieldId: null,
    };
    const onDirtyChange = vi.fn();
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(original);
    render(editor(new Map(), "vm-a", { onDirtyChange }));
    await screen.findByRole("group", { name: "视频来源" });
    expect(screen.getByText(/旧归档目录规则.*重新确认/)).toBeTruthy();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(saveFeishuPackageWorkflowDraft).not.toHaveBeenCalled();
    selectTab("存储与目录");
    expect((screen.getByRole("textbox", { name: "成片归档目录" }) as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByRole("textbox", { name: "成片归档目录" }), { target: { value: "\\\\nas\\课程\\成片" } });
    expect(screen.getByText(/旧归档目录规则.*重新确认/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    expect(screen.queryByText(/旧归档目录规则/)).toBeNull();
    const submitted = vi.mocked(saveFeishuPackageWorkflowDraft).mock.calls[0][3];
    if (!("fields" in submitted)) throw new Error("Expected a VM workflow draft");
    expect(submitted.finalArchive?.directoryPath).toBe("\\\\nas\\课程\\成片");
  });

  it("keeps unavailable naming and archive bindings until they are explicitly replaced", async () => {
    const original = profile();
    original.config.fields.namingFieldId = "changed-name";
    original.config.finalArchive = { enabled: true, statusFieldId: "removed-progress", triggerOptionId: "removed-option", pathSource: "pmo_field", directoryPath: "W:\\交付", pathFieldId: "ambiguous-path" };
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(original);
    vi.mocked(saveFeishuPackageWorkflowDraft).mockRejectedValue(new ApiError(400, { error: { code: "INVALID_FIELD" } }));
    const fields: FeishuFieldMetadata[] = [
      { fieldId: "changed-name", fieldName: "已变成数字", type: 2, uiType: "Number", options: [] },
      { fieldId: "ambiguous-path", fieldName: "重复路径 A", type: 1, uiType: "Text", options: [] },
      { fieldId: "ambiguous-path", fieldName: "重复路径 B", type: 1, uiType: "Text", options: [] },
    ];
    render(<FeishuVmPmoWorkflowEditor subjectKey="subject-a" packageAlias="vm-a" fields={fields} cache={new Map()} />);
    await screen.findByRole("group", { name: "视频来源" });
    expect((screen.getByRole("combobox", { name: "视频主体命名字段" }) as HTMLSelectElement).value).toBe("changed-name");
    fireEvent.change(screen.getByRole("combobox", { name: "视频主体命名字段" }), { target: { value: "" } });
    selectTab("存储与目录");
    expect((screen.getByRole("combobox", { name: "成片归档路径字段" }) as HTMLSelectElement).value).toBe("ambiguous-path");
    const archiveOption = screen.getByRole("combobox", { name: "成片归档触发状态" }) as HTMLSelectElement;
    expect(archiveOption.value).toBe("removed-option");
    expect(archiveOption.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "启用 VM 成片归档" }));
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByRole("alert");
    expect(screen.getByText(invalidConfigMessage)).toBeTruthy();
    expect(screen.queryByText("流程草稿已保存。")).toBeNull();
    const submitted = vi.mocked(saveFeishuPackageWorkflowDraft).mock.calls[0][3];
    if (!("fields" in submitted)) throw new Error("Expected a VM workflow draft");
    expect(submitted.fields.namingFieldId).toBeNull();
    expect(submitted.finalArchive).toEqual({ ...original.config.finalArchive, enabled: false });
  });

  it("prompts for one shared naming field when migrated names conflict and clears the notice after saving", async () => {
    const original = { ...profile(), legacyNamingConflict: true };
    const fields: FeishuFieldMetadata[] = [{ fieldId: "common-name", fieldName: "统一名称", type: 1, uiType: "Text", options: [] }];
    const onDirtyChange = vi.fn();
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(original);
    render(<FeishuVmPmoWorkflowEditor subjectKey="subject-a" packageAlias="vm-a" fields={fields} cache={new Map()} onDirtyChange={onDirtyChange} />);
    await screen.findByRole("group", { name: "视频命名" });
    expect(screen.getByText(/旧命名字段不一致.*重新选择/)).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "视频主体命名字段" }) as HTMLSelectElement).value).toBe("");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByRole("combobox", { name: "视频主体命名字段" }), { target: { value: "common-name" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    expect(screen.queryByText(/旧命名字段不一致/)).toBeNull();
    const submitted = vi.mocked(saveFeishuPackageWorkflowDraft).mock.calls[0][3];
    if (!("fields" in submitted)) throw new Error("Expected a VM workflow draft");
    expect(submitted.fields.namingFieldId).toBe("common-name");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("shows one configuration page at a time and keeps unsaved edits across tabs", async () => {
    const fields: FeishuFieldMetadata[] = [
      { fieldId: "vmid", fieldName: "原片 VMID", type: 1, uiType: "Text", options: [] },
      { fieldId: "notes", fieldName: "保留片段", type: 1, uiType: "Text", options: [] },
      { fieldId: "output", fieldName: "成片附件", type: 17, uiType: "Attachment", options: [] },
    ];
    render(<FeishuVmPmoWorkflowEditor subjectKey="subject-a" packageAlias="vm-a" fields={fields} cache={new Map()} />);
    await screen.findByRole("group", { name: "视频来源" });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["基础与执行", "素材与阶段", "存储与目录", "飞书回写"]);
    expect(screen.queryByRole("combobox", { name: "初稿意见字段" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "VM 初稿进度触发字段" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "VMID 字段" }), { target: { value: "vmid" } });
    fireEvent.change(reason(), { target: { value: "本轮制作" } });
    fireEvent.click(screen.getByRole("tab", { name: "素材与阶段" }));
    expect(screen.queryByRole("combobox", { name: "VMID 字段" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "初稿意见字段" }), { target: { value: "notes" } });
    fireEvent.click(screen.getByRole("tab", { name: "存储与目录" }));
    fireEvent.change(screen.getByRole("combobox", { name: "成品视频附件字段" }), { target: { value: "output" } });
    fireEvent.click(screen.getByRole("tab", { name: "基础与执行" }));
    expect((screen.getByRole("combobox", { name: "VMID 字段" }) as HTMLSelectElement).value).toBe("vmid");
    expect(reason().value).toBe("本轮制作");
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    expect(saveFeishuPackageWorkflowDraft).toHaveBeenCalledWith("subject-a", "vm-a", 1, expect.objectContaining({
      fields: { vmidFieldId: "vmid", outputAttachmentFieldId: "output" },
      approval: { department: "动画组", reason: "本轮制作" },
    }));
  });

  it("keeps save and enable actions outside the scrolling tab panel", async () => {
    render(editor(new Map()));
    await screen.findByRole("group", { name: "视频来源" });
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).queryByRole("button", { name: "保存流程草稿" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "启用流程" })).toBeNull();
    const footer = screen.getByRole("button", { name: "保存流程草稿" }).closest(".feishu-vm-pmo-actions");
    expect(footer?.parentElement).toBe(panel.parentElement);
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    expect(footer?.contains(screen.getByText("流程草稿已保存。"))).toBe(true);
  });

  it("supports keyboard navigation between configuration pages", async () => {
    render(editor(new Map()));
    await screen.findByRole("group", { name: "视频来源" });
    const source = screen.getByRole("tab", { name: "基础与执行" });
    source.focus();
    fireEvent.keyDown(source, { key: "ArrowRight" });
    const delivery = screen.getByRole("tab", { name: "素材与阶段" });
    expect(document.activeElement).toBe(delivery);
    expect(delivery.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(delivery.id);
    fireEvent.keyDown(delivery, { key: "End" });
    const final = screen.getByRole("tab", { name: "飞书回写" });
    expect(document.activeElement).toBe(final);
    expect(screen.getByRole("combobox", { name: "VM 审核修改开始剪辑回写字段" })).toBeTruthy();
    fireEvent.keyDown(final, { key: "ArrowRight" });
    expect(document.activeElement).toBe(source);
    fireEvent.keyDown(source, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(final);
    fireEvent.keyDown(final, { key: "Home" });
    expect(document.activeElement).toBe(source);
  });

  it("preserves each stage's trigger, instructions and writebacks when edited on separate pages", async () => {
    const original = profile();
    const fields: FeishuFieldMetadata[] = [
      { fieldId: "notes", fieldName: "独立剪辑意见", type: 1, uiType: "Text", options: [] },
      { fieldId: "progress", fieldName: "剪辑进度", type: 3, uiType: "SingleSelect", options: [{ id: "ready", name: "待剪辑" }, { id: "editing", name: "剪辑中" }, { id: "done", name: "已交付" }] },
    ];
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(original);
    render(<FeishuVmPmoWorkflowEditor subjectKey="subject-a" packageAlias="vm-a" fields={fields} cache={new Map()} />);
    await screen.findByRole("group", { name: "视频来源" });
    selectTab("素材与阶段");
    for (const label of ["初稿", "审核修改"]) {
      const enabled = screen.getByRole("checkbox", { name: `启用 VM ${label}` }) as HTMLInputElement;
      if (!enabled.checked) fireEvent.click(enabled);
      fireEvent.change(screen.getByRole("combobox", { name: `VM ${label}进度触发字段` }), { target: { value: "progress" } });
      fireEvent.change(screen.getByRole("combobox", { name: `VM ${label}触发状态` }), { target: { value: "ready" } });
      fireEvent.change(screen.getByRole("combobox", { name: label === "初稿" ? "初稿意见字段" : "审核意见字段" }), { target: { value: "notes" } });
    }
    expect(screen.queryByRole("combobox", { name: "VM 初稿开始剪辑回写字段" })).toBeNull();
    selectTab("飞书回写");
    for (const label of ["初稿", "审核修改"]) {
      fireEvent.change(screen.getByRole("combobox", { name: `VM ${label}开始剪辑回写字段` }), { target: { value: "progress" } });
      fireEvent.change(screen.getByRole("combobox", { name: `VM ${label}开始剪辑回写选项` }), { target: { value: "editing" } });
      fireEvent.change(screen.getByRole("combobox", { name: `VM ${label}成片交付完成回写字段` }), { target: { value: "progress" } });
      fireEvent.change(screen.getByRole("combobox", { name: `VM ${label}成片交付完成回写选项` }), { target: { value: "done" } });
    }
    expect(screen.queryByRole("combobox", { name: "VM 初稿进度触发字段" })).toBeNull();
    selectTab("素材与阶段");
    expect((screen.getByRole("combobox", { name: "审核意见字段" }) as HTMLSelectElement).value).toBe("notes");
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    const submitted = vi.mocked(saveFeishuPackageWorkflowDraft).mock.calls[0][3];
    if (!("fields" in submitted)) throw new Error("Expected a VM workflow draft");
    expect(submitted.stages.initial.instructionFieldId).toBe("notes");
    for (const [id, stage] of Object.entries(submitted.stages)) expect(stage).toEqual({
      enabled: true, statusFieldId: "progress", triggerOptionId: "ready", instructionFieldId: "notes",
      ...(id === "review" ? { instructionAttachmentsFieldId: null } : {}),
      writeback: { processing: { fieldId: "progress", optionId: "editing" }, completed: { fieldId: "progress", optionId: "done" } },
    });
  });

  it("saves the selected PMO VMID source and approval settings without changing the draft contract", async () => {
    const fields: FeishuFieldMetadata[] = [
      { fieldId: "vmid-source", fieldName: "原始视频 VMID", type: 1, uiType: "Text", options: [] },
      { fieldId: "keep-instructions", fieldName: "保留片段", type: 1, uiType: "Text", options: [] },
      { fieldId: "output-video", fieldName: "成品 MP4", type: 17, uiType: "Attachment", options: [] },
      { fieldId: "numeric-field", fieldName: "编号", type: 2, uiType: "Number", options: [] },
    ];
    render(<FeishuVmPmoWorkflowEditor subjectKey="subject-a" packageAlias="vm-a" fields={fields} cache={new Map()} />);
    const source = await screen.findByRole("group", { name: "视频来源" });
    const sourceType = within(source).getByRole("combobox", { name: "视频来源类型" }) as HTMLSelectElement;
    expect(sourceType.value).toBe("pmo_vmid_field");
    expect(sourceType.disabled).toBe(true);
    expect(screen.queryByRole("textbox", { name: "VMID" })).toBeNull();
    const vmidField = within(source).getByRole("combobox", { name: "VMID 字段" });
    expect(within(vmidField).queryByRole("option", { name: "成品 MP4" })).toBeNull();
    expect(within(vmidField).queryByRole("option", { name: "编号" })).toBeNull();
    fireEvent.change(vmidField, { target: { value: "vmid-source" } });
    fireEvent.change(within(source).getByRole("textbox", { name: "申请部门" }), { target: { value: "课程组" } });
    fireEvent.change(within(source).getByRole("textbox", { name: "申请原因" }), { target: { value: "PMO 初稿制作" } });
    selectTab("素材与阶段");
    fireEvent.change(screen.getByRole("combobox", { name: "初稿意见字段" }), { target: { value: "keep-instructions" } });
    selectTab("存储与目录");
    fireEvent.change(screen.getByRole("combobox", { name: "成品视频附件字段" }), { target: { value: "output-video" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    expect(saveFeishuPackageWorkflowDraft).toHaveBeenCalledWith("subject-a", "vm-a", 1, {
      fields: { vmidFieldId: "vmid-source", outputAttachmentFieldId: "output-video" },
      approval: { department: "课程组", reason: "PMO 初稿制作" },
      stages: { initial: { enabled: true, statusFieldId: null, triggerOptionId: null, instructionFieldId: "keep-instructions" }, review: { enabled: false, statusFieldId: null, triggerOptionId: null, instructionFieldId: null, instructionAttachmentsFieldId: null } },
    });
    expect((screen.getByRole("button", { name: "启用流程" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps PMO VMID source selections isolated by subject and package", async () => {
    vi.mocked(getFeishuPackageWorkflowDraft).mockImplementation(async (subjectKey, alias) => ({ ...profile(alias), subjectKey }));
    const cache: VmPmoDraftCache = new Map();
    const fields: FeishuFieldMetadata[] = [{ fieldId: "vmid-a", fieldName: "VMID A", type: 1, uiType: "Text", options: [] }];
    const content = (subjectKey: string, packageAlias: string) => <FeishuVmPmoWorkflowEditor subjectKey={subjectKey} packageAlias={packageAlias} fields={fields} cache={cache} />;
    const view = render(content("subject-a", "vm-a"));
    const source = await screen.findByRole("group", { name: "视频来源" });
    fireEvent.change(within(source).getByRole("combobox", { name: "VMID 字段" }), { target: { value: "vmid-a" } });
    selectTab("素材与阶段");
    fireEvent.change(screen.getByRole("combobox", { name: "初稿意见字段" }), { target: { value: "vmid-a" } });
    view.rerender(content("subject-b", "vm-a"));
    selectTab("基础与执行");
    await waitFor(() => expect((screen.getByRole("combobox", { name: "VMID 字段" }) as HTMLSelectElement).value).toBe(""));
    selectTab("素材与阶段");
    expect((screen.getByRole("combobox", { name: "初稿意见字段" }) as HTMLSelectElement).value).toBe("");
    view.rerender(content("subject-a", "vm-b"));
    selectTab("基础与执行");
    await waitFor(() => expect((screen.getByRole("combobox", { name: "VMID 字段" }) as HTMLSelectElement).value).toBe(""));
    view.rerender(content("subject-a", "vm-a"));
    await waitFor(() => expect((screen.getByRole("combobox", { name: "VMID 字段" }) as HTMLSelectElement).value).toBe("vmid-a"));
    selectTab("素材与阶段");
    expect((screen.getByRole("combobox", { name: "初稿意见字段" }) as HTMLSelectElement).value).toBe("vmid-a");
  });

  it.each(["first_review", "final_review"] as const)("shows the legacy %s migration notice without marking an unchanged draft dirty", async (legacyReviewStage) => {
    const original = profile();
    original.legacyReviewStage = legacyReviewStage;
    original.config.stages.initial.instructionFieldId = "initial-notes";
    original.config.stages.review.instructionFieldId = "review-notes";
    original.config.stages.review.instructionAttachmentsFieldId = "review-shots";
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(original);
    const fields: FeishuFieldMetadata[] = [
      { fieldId: "initial-notes", fieldName: "初稿意见", type: 1, uiType: "Text", options: [] },
      { fieldId: "review-notes", fieldName: "审核意见", type: 1, uiType: "Text", options: [] },
      { fieldId: "review-shots", fieldName: "审核截图", type: 17, uiType: "Attachment", options: [] },
    ];
    const onDirtyChange = vi.fn();
    render(<FeishuVmPmoWorkflowEditor subjectKey="subject-a" packageAlias="vm-a" fields={fields} cache={new Map()} onDirtyChange={onDirtyChange} />);
    await screen.findByRole("group", { name: "视频来源" });
    selectTab("素材与阶段");
    expect(screen.getByText(new RegExp(`当前沿用旧${legacyReviewStage === "first_review" ? "初审" : "终审"}配置`))).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "初稿意见字段" }) as HTMLSelectElement).value).toBe("initial-notes");
    expect((screen.getByRole("combobox", { name: "审核意见字段" }) as HTMLSelectElement).value).toBe("review-notes");
    expect((screen.getByRole("combobox", { name: "审核意见附件字段" }) as HTMLSelectElement).value).toBe("review-shots");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    expect(saveFeishuPackageWorkflowDraft).toHaveBeenCalledWith("subject-a", "vm-a", 1, original.config);
    expect(screen.queryByText(/当前沿用旧/)).toBeNull();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("clears a migrated opinion without restoring legacy defaults and preserves the other stage", async () => {
    const original = profile();
    original.legacyReviewStage = "first_review";
    original.config.stages.initial.instructionFieldId = "initial-notes";
    original.config.stages.review.instructionFieldId = "review-notes";
    const onDirtyChange = vi.fn();
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(original);
    const fields: FeishuFieldMetadata[] = ["initial-notes", "review-notes"].map((fieldId) => ({
      fieldId, fieldName: fieldId, type: 1, uiType: "Text", options: [],
    }));
    render(<FeishuVmPmoWorkflowEditor subjectKey="subject-a" packageAlias="vm-a" fields={fields} cache={new Map()} onDirtyChange={onDirtyChange} />);
    await screen.findByRole("group", { name: "视频来源" });
    selectTab("素材与阶段");
    fireEvent.change(screen.getByRole("combobox", { name: "初稿意见字段" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    const submitted = vi.mocked(saveFeishuPackageWorkflowDraft).mock.calls[0][3];
    if (!("fields" in submitted)) throw new Error("Expected a VM workflow draft");
    expect(submitted.fields).toEqual(original.config.fields);
    expect(submitted.stages).toEqual({ ...original.config.stages, initial: { ...original.config.stages.initial, instructionFieldId: null } });
    expect((screen.getByRole("combobox", { name: "初稿意见字段" }) as HTMLSelectElement).value).toBe("");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("saves independent stage instructions, a multi-select trigger and writeback targets", async () => {
    const fields: FeishuFieldMetadata[] = [
      { fieldId: "initial-notes", fieldName: "初稿剪辑说明", type: 1, uiType: "Text", options: [] },
      { fieldId: "review-notes", fieldName: "初审修改意见", type: 1, uiType: "Text", options: [] },
      { fieldId: "multi-progress", fieldName: "视频阶段标签", type: 4, uiType: "MultiSelect", options: [{ id: "start-initial", name: "修音完成" }, { id: "other-label", name: "其他标签" }] },
      { fieldId: "single-progress", fieldName: "视频整体进度", type: 3, uiType: "SingleSelect", options: [{ id: "editing", name: "处理中" }, { id: "delivered", name: "已完成" }] },
      { fieldId: "alternate-progress", fieldName: "交付进度", type: 3, uiType: "SingleSelect", options: [{ id: "alternate-editing", name: "正在剪辑" }] },
      { fieldId: "output", fieldName: "统一成片附件", type: 17, uiType: "Attachment", options: [] },
    ];
    render(<FeishuVmPmoWorkflowEditor subjectKey="subject-a" packageAlias="vm-a" fields={fields} cache={new Map()} />);
    await screen.findByRole("group", { name: "视频来源" });
    selectTab("素材与阶段");
    fireEvent.change(screen.getByRole("combobox", { name: "VM 初稿进度触发字段" }), { target: { value: "multi-progress" } });
    fireEvent.change(screen.getByRole("combobox", { name: "VM 初稿触发状态" }), { target: { value: "start-initial" } });
    fireEvent.change(screen.getByRole("combobox", { name: "初稿意见字段" }), { target: { value: "initial-notes" } });
    fireEvent.change(screen.getByRole("combobox", { name: "审核意见字段" }), { target: { value: "review-notes" } });
    selectTab("飞书回写");
    fireEvent.change(screen.getByRole("combobox", { name: "VM 初稿开始剪辑回写字段" }), { target: { value: "single-progress" } });
    fireEvent.change(screen.getByRole("combobox", { name: "VM 初稿开始剪辑回写选项" }), { target: { value: "editing" } });
    fireEvent.change(screen.getByRole("combobox", { name: "VM 初稿开始剪辑回写字段" }), { target: { value: "alternate-progress" } });
    expect((screen.getByRole("combobox", { name: "VM 初稿开始剪辑回写选项" }) as HTMLSelectElement).value).toBe("");
    fireEvent.change(screen.getByRole("combobox", { name: "VM 初稿成片交付完成回写字段" }), { target: { value: "single-progress" } });
    fireEvent.change(screen.getByRole("combobox", { name: "VM 初稿成片交付完成回写选项" }), { target: { value: "delivered" } });
    selectTab("素材与阶段");
    expect((screen.getByRole("combobox", { name: "VM 初稿触发状态" }) as HTMLSelectElement).value).toBe("start-initial");
    selectTab("存储与目录");
    fireEvent.change(screen.getByRole("combobox", { name: "成品视频附件字段" }), { target: { value: "output" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    const submitted = vi.mocked(saveFeishuPackageWorkflowDraft).mock.calls[0][3];
    if (!("fields" in submitted)) throw new Error("Expected a VM workflow draft");
    expect(submitted.stages.initial).toEqual({
      enabled: true, statusFieldId: "multi-progress", triggerOptionId: "start-initial", instructionFieldId: "initial-notes",
      writeback: { processing: { fieldId: "alternate-progress", optionId: null }, completed: { fieldId: "single-progress", optionId: "delivered" } },
    });
    expect(submitted.stages.review).toEqual({ enabled: false, statusFieldId: null, triggerOptionId: null, instructionFieldId: "review-notes", instructionAttachmentsFieldId: null });
    expect(submitted.fields.outputAttachmentFieldId).toBe("output");
    expect(Object.keys(submitted.stages)).toEqual(["initial", "review"]);
  });

  it("filters contradictory metadata and reserves writeback targets for single-select fields", async () => {
    const fields: FeishuFieldMetadata[] = [
      { fieldId: "multi", fieldName: "多选进度", type: 4, uiType: "MultiSelect", options: [] },
      { fieldId: "ui-only-multi", fieldName: "仅 UI 多选进度", type: null, uiType: "MultiSelect", options: [] },
      { fieldId: "coerced-multi", fieldName: "非法数字多选", type: "4.0", uiType: "MultiSelect", options: [] },
      { fieldId: "wrong-multi", fieldName: "矛盾多选", type: 4, uiType: "SingleSelect", options: [] },
      { fieldId: "wrong-single", fieldName: "矛盾单选", type: 3, uiType: "MultiSelect", options: [] },
      { fieldId: "wrong-text", fieldName: "矛盾文本", type: 1, uiType: "Number", options: [] },
      { fieldId: "odd-text", fieldName: "非文本类型", type: 1, uiType: "t_e_x_t", options: [] },
      { fieldId: "text", fieldName: "剪辑文本", type: 1, uiType: "Text", options: [] },
      { fieldId: "ui-only-text", fieldName: "仅 UI 剪辑文本", type: null, uiType: "Text", options: [] },
      { fieldId: "coerced-text", fieldName: "非法数字文本", type: "1.0", uiType: "Text", options: [] },
    ];
    render(<FeishuVmPmoWorkflowEditor subjectKey="subject-a" packageAlias="vm-a" fields={fields} cache={new Map()} />);
    await screen.findByRole("group", { name: "视频来源" });
    selectTab("素材与阶段");
    const trigger = await screen.findByRole("combobox", { name: "VM 初稿进度触发字段" });
    expect(within(trigger).getByRole("option", { name: "多选进度" })).toBeTruthy();
    expect(within(trigger).getByRole("option", { name: "仅 UI 多选进度" })).toBeTruthy();
    expect(within(trigger).queryByRole("option", { name: "非法数字多选" })).toBeNull();
    expect(within(trigger).queryByRole("option", { name: "矛盾多选" })).toBeNull();
    expect(within(trigger).queryByRole("option", { name: "矛盾单选" })).toBeNull();
    const instruction = screen.getByRole("combobox", { name: "初稿意见字段" });
    expect(within(instruction).getByRole("option", { name: "剪辑文本" })).toBeTruthy();
    expect(within(instruction).getByRole("option", { name: "仅 UI 剪辑文本" })).toBeTruthy();
    expect(within(instruction).queryByRole("option", { name: "非法数字文本" })).toBeNull();
    expect(within(instruction).queryByRole("option", { name: "矛盾文本" })).toBeNull();
    expect(within(instruction).queryByRole("option", { name: "非文本类型" })).toBeNull();
    selectTab("飞书回写");
    const writeback = screen.getByRole("combobox", { name: "VM 初稿开始剪辑回写字段" });
    expect(within(writeback).queryByRole("option", { name: "多选进度" })).toBeNull();
    expect(within(writeback).queryByRole("option", { name: "矛盾单选" })).toBeNull();
  });

  it("does not reuse another template's cached draft", async () => {
    const cache: VmPmoDraftCache = new Map();
    const view = render(editor(cache));
    await screen.findByRole("textbox", { name: "申请原因" });
    fireEvent.change(reason(), { target: { value: "VM 本地修改" } });
    view.unmount();
    render(editor(cache, "vm-a", { workflowTemplate: { id: "document_draft_zip", version: 1 } }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("textbox", { name: "申请原因" })).toBeNull();
  });

  it("retains conflicts and unsaved edits across package switches", async () => {
    const cache: VmPmoDraftCache = new Map();
    vi.mocked(saveFeishuPackageWorkflowDraft).mockRejectedValue(new ApiError(409, { error: { code: "VERSION_CONFLICT" } }));
    const view = render(editor(cache));
    await screen.findByRole("textbox", { name: "申请原因" });
    fireEvent.change(reason(), { target: { value: "保留我的修改" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText(conflictMessage);
    view.unmount();
    render(editor(cache));
    expect(screen.getByText(conflictMessage)).toBeTruthy();
    expect(reason().value).toBe("保留我的修改");
  });

  it("identifies unknown draft properties as configuration errors instead of changed PMO fields", async () => {
    const onError = vi.fn();
    vi.mocked(saveFeishuPackageWorkflowDraft).mockRejectedValue(new ApiError(400, { error: { code: "UNKNOWN_FIELD" } }));
    render(editor(new Map(), "vm-a", { onError }));
    await screen.findByRole("textbox", { name: "申请原因" });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByRole("alert");
    expect(screen.getByText(unknownConfigMessage)).toBeTruthy();
    expect(screen.queryByText(invalidConfigMessage)).toBeNull();
    expect(onError).toHaveBeenLastCalledWith(unknownConfigMessage);
  });

  it("clears the original read error only after a valid reload succeeds", async () => {
    const onError = vi.fn();
    const onErrorClear = vi.fn();
    vi.mocked(getFeishuPackageWorkflowDraft)
      .mockRejectedValueOnce(new ApiError(400, { error: { code: "UNKNOWN_FIELD" } }))
      .mockResolvedValueOnce({ ...profile(), workflowTemplate: { id: "document_draft_zip", version: 1 } })
      .mockResolvedValueOnce(profile());
    render(editor(new Map(), "vm-a", { onError, onErrorClear }));
    await screen.findByRole("alert");
    const originalError = onError.mock.calls[0][0];
    expect(onErrorClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重新加载流程草稿" }));
    await screen.findByText("流程草稿读取或保存失败，请重试。");
    expect(onErrorClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重新加载流程草稿" }));
    await screen.findByRole("textbox", { name: "申请原因" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onErrorClear).toHaveBeenCalledTimes(1);
    expect(onErrorClear).toHaveBeenCalledWith(onError.mock.calls[1][0]);
    expect(onError.mock.calls[1][0]).not.toBe(originalError);
  });

  it("clears the original save error only after a valid subsequent save succeeds", async () => {
    const onErrorClear = vi.fn();
    vi.mocked(saveFeishuPackageWorkflowDraft)
      .mockRejectedValueOnce(new ApiError(400, { error: { code: "UNKNOWN_FIELD" } }))
      .mockResolvedValueOnce({ ...profile(), workflowTemplate: { id: "document_draft_zip", version: 1 } })
      .mockResolvedValueOnce({ ...profile(), revision: 2 });
    render(editor(new Map(), "vm-a", { onErrorClear }));
    await screen.findByRole("textbox", { name: "申请原因" });
    expect(onErrorClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByRole("alert");
    expect(onErrorClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿读取或保存失败，请重试。");
    expect(onErrorClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    expect(onErrorClear).toHaveBeenCalledTimes(1);
    expect(onErrorClear).toHaveBeenCalledWith("流程草稿读取或保存失败，请重试。");
  });

  it("does not clear the newly selected package's errors when an old package save finishes", async () => {
    let finish: (value: FeishuPackageWorkflowDraft) => void = () => {};
    const onErrorClear = vi.fn();
    vi.mocked(saveFeishuPackageWorkflowDraft)
      .mockRejectedValueOnce(new ApiError(400, { error: { code: "UNKNOWN_FIELD" } }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const cache: VmPmoDraftCache = new Map();
    const view = render(editor(cache, "vm-a", { onErrorClear }));
    await screen.findByRole("textbox", { name: "申请原因" });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    view.rerender(editor(cache, "vm-b", { onErrorClear }));
    await waitFor(() => expect(reason().value).toBe("切片剪辑"));
    await act(async () => { finish({ ...profile("vm-a"), revision: 2 }); });
    expect(onErrorClear).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before reloading over unsaved edits", async () => {
    const cache: VmPmoDraftCache = new Map();
    vi.mocked(saveFeishuPackageWorkflowDraft).mockRejectedValue(new ApiError(409, { error: { code: "VERSION_CONFLICT" } }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(editor(cache));
    await screen.findByRole("textbox", { name: "申请原因" });
    fireEvent.change(reason(), { target: { value: "不能丢失" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText(conflictMessage);
    vi.mocked(getFeishuPackageWorkflowDraft).mockResolvedValue(profile("vm-a", "远端版本"));
    fireEvent.click(screen.getByRole("button", { name: "重新加载流程草稿" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("放弃"));
    expect(reason().value).toBe("不能丢失");
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "重新加载流程草稿" }));
    await waitFor(() => expect(reason().value).toBe("远端版本"));
  });

  it("rejects a save response for a different template without replacing the draft", async () => {
    const cache: VmPmoDraftCache = new Map();
    vi.mocked(saveFeishuPackageWorkflowDraft).mockResolvedValue({ ...profile("vm-a", "错误模板内容"), workflowTemplate: { id: "document_draft_zip", version: 1 } });
    render(editor(cache));
    await screen.findByRole("textbox", { name: "申请原因" });
    fireEvent.change(reason(), { target: { value: "我的 VM 草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByRole("alert");
    expect(reason().value).toBe("我的 VM 草稿");
    expect(screen.queryByText("流程草稿已保存。")).toBeNull();
  });

  it("warns before unloading only while the cached draft has unsaved changes", async () => {
    const cache: VmPmoDraftCache = new Map();
    const onDirtyChange = vi.fn();
    render(editor(cache, "vm-a", { onDirtyChange }));
    await screen.findByRole("textbox", { name: "申请原因" });
    fireEvent.change(reason(), { target: { value: "未保存" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    await screen.findByText("流程草稿已保存。");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
  });

  it("preserves edits made after a save starts", async () => {
    let finish: (value: FeishuPackageWorkflowDraft) => void = () => {};
    vi.mocked(saveFeishuPackageWorkflowDraft).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const onDirtyChange = vi.fn();
    render(editor(new Map(), "vm-a", { onDirtyChange }));
    await screen.findByRole("textbox", { name: "申请原因" });
    fireEvent.change(reason(), { target: { value: "第一次修改" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    fireEvent.change(reason(), { target: { value: "保存过程中继续修改" } });
    await act(async () => { finish({ ...profile("vm-a", "第一次修改"), revision: 2 }); });
    expect(reason().value).toBe("保存过程中继续修改");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByText("流程草稿已保存。")).toBeNull();
  });

  it("does not apply a pending save response to a newly selected package", async () => {
    let finish: (value: FeishuPackageWorkflowDraft) => void = () => {};
    vi.mocked(saveFeishuPackageWorkflowDraft).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const cache: VmPmoDraftCache = new Map();
    const view = render(editor(cache));
    await screen.findByRole("textbox", { name: "申请原因" });
    fireEvent.change(reason(), { target: { value: "A 修改" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    view.rerender(editor(cache, "vm-b"));
    await waitFor(() => expect(reason().value).toBe("切片剪辑"));
    await act(async () => { finish({ ...profile("vm-a", "A 修改"), revision: 2 }); });
    expect(reason().value).toBe("切片剪辑");
    view.rerender(editor(cache));
    await waitFor(() => expect(reason().value).toBe("A 修改"));
  });

  it("retains safe errors when a save fails after leaving its package", async () => {
    let fail: (error: unknown) => void = () => {};
    vi.mocked(saveFeishuPackageWorkflowDraft).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const cache: VmPmoDraftCache = new Map();
    const view = render(editor(cache));
    await screen.findByRole("textbox", { name: "申请原因" });
    fireEvent.change(reason(), { target: { value: "稍后继续" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    view.unmount();
    await act(async () => { fail(new Error("private server details")); });
    render(editor(cache));
    await screen.findByRole("alert");
    expect(screen.queryByText("private server details")).toBeNull();
    expect(reason().value).toBe("稍后继续");
  });

  it("updates a remounted editor when its pending save finishes", async () => {
    let finish: (value: FeishuPackageWorkflowDraft) => void = () => {};
    vi.mocked(saveFeishuPackageWorkflowDraft).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const cache: VmPmoDraftCache = new Map();
    const view = render(editor(cache));
    await screen.findByRole("textbox", { name: "申请原因" });
    fireEvent.change(reason(), { target: { value: "已提交的内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存流程草稿" }));
    view.unmount();
    render(editor(cache));
    expect((screen.getByRole("button", { name: "正在保存…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(reason(), { target: { value: "返回后继续编辑" } });
    await act(async () => { finish({ ...profile("vm-a", "已提交的内容"), revision: 2 }); });
    expect(reason().value).toBe("返回后继续编辑");
    expect((screen.getByRole("button", { name: "保存流程草稿" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("流程草稿版本 2")).toBeTruthy();
  });
});
