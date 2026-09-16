import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeishuBaseCatalog, FeishuStageConfigMap, FeishuSubjectConfig } from "../types";
import {
  audioDraftFromStage,
  FeishuStageEditor,
  type FeishuStageAudioDraft,
  type FeishuStageValue,
} from "./FeishuStageEditor";
import { FeishuWorkflowPanel } from "./FeishuWorkflowPanel";
import { listFeishuPackages } from "../api";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listFeishuPackages: vi.fn(async () => []),
}));

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
    documentField: { fieldId: "fld_text", fieldName: "素材文档" },
    namingField: { fieldId: "fld_text", fieldName: "名称" },
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

  it("shows an unavailable saved attachment without silently selecting another field", () => {
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
    expect(attachment.value).toBe("fld_deleted");
    const unavailable = within(attachment).getByRole("option", { name: "已配置字段（当前不可用）" }) as HTMLOptionElement;
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.selected).toBe(true);
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

  it.each(["phased", "metadata fallback", "legacy"])("shows one shared mode above stage settings for %s subjects", (kind) => {
    const configured = kind === "phased" ? subject("history", "高中历史") : legacySubject("history", "高中历史");
    if (kind === "legacy") configured.metadata = { fields: [] };
    render(<FeishuWorkflowPanel {...panelProps(configured)} />);

    const common = screen.getByRole("group", { name: "通用执行设置" });
    expect(screen.getAllByRole("combobox", { name: "剪辑模式" })).toHaveLength(1);
    expect((within(common).getByRole("combobox", { name: "剪辑模式" }) as HTMLSelectElement).value).toBe("manual");
    expect(within(common).getByRole("textbox", { name: "并发组" })).toBeTruthy();
    expect(within(common).getByRole("spinbutton", { name: "并发数" })).toBeTruthy();
    expect(within(common).getByRole("textbox", { name: "资源组" })).toBeTruthy();
    if (kind !== "legacy") {
      const phases = screen.getByRole("region", { name: "分阶段素材配置" });
      expect(within(phases).queryByRole("combobox", { name: "剪辑模式" })).toBeNull();
      expect(common.compareDocumentPosition(phases) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it.each(["manual", "automatic"] as const)("saves a change from %s without publishing until explicit enable", async (originalMode) => {
    vi.mocked(listFeishuPackages).mockResolvedValueOnce([{
      alias: "Auto-cut-A", name: "Auto-Cut A", projectId: "auto-cut-a", workspacePath: null,
      model: null, reasoningEffort: null, prompt: null, zipSourceDirectory: null,
      maxConcurrent: 1, state: "enabled", revision: 1, updatedAt: "2026-09-15T00:00:00.000Z",
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
      return <FeishuWorkflowPanel {...panelProps(current)} onSubjectChange={setCurrent} onSaveDraft={onSaveDraft} onEnable={onEnable} />;
    }
    render(<SavedPanel />);

    const control = screen.getByRole("combobox", { name: "剪辑模式" }) as HTMLSelectElement;
    expect(control.value).toBe(originalMode);
    fireEvent.change(control, { target: { value: nextMode } });
    expect(control.value).toBe(nextMode);
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
    const { rerender } = render(<FeishuWorkflowPanel {...props} />);
    expect((screen.getByRole("combobox", { name: "剪辑模式" }) as HTMLSelectElement).value).toBe("manual");
    rerender(<FeishuWorkflowPanel {...props} selectedSubjectKey={automatic.subjectKey} />);
    expect((screen.getByRole("combobox", { name: "剪辑模式" }) as HTMLSelectElement).value).toBe("automatic");
    rerender(<FeishuWorkflowPanel {...props} />);
    expect((screen.getByRole("combobox", { name: "剪辑模式" }) as HTMLSelectElement).value).toBe("manual");
  });

  it("reports unknown, off and on machine policy without changing the subject mode", () => {
    const configured = subject("history", "高中历史");
    configured.execution!.mode = "automatic";
    const props = panelProps(configured);
    const { rerender } = render(<FeishuWorkflowPanel {...props} />);
    const status = () => screen.getByRole("status", { name: "本机自动执行总开关" });
    expect(status().textContent).toContain("状态未知");
    rerender(<FeishuWorkflowPanel {...props} allowAutomaticExecution={false} />);
    expect(status().textContent).toContain("已关闭");
    expect(status().textContent).toContain("不会自动启动任务");
    rerender(<FeishuWorkflowPanel {...props} allowAutomaticExecution />);
    expect(status().textContent).toContain("已开启");
    expect((screen.getByRole("combobox", { name: "剪辑模式" }) as HTMLSelectElement).value).toBe("automatic");
    expect(props.onSubjectChange).not.toHaveBeenCalled();
  });

  it("opens machine settings from the global switch status without modifying the subject", () => {
    const props = panelProps(subject("history", "高中历史"));
    const onOpenLocalSettings = vi.fn();
    render(<FeishuWorkflowPanel {...props} allowAutomaticExecution={false} onOpenLocalSettings={onOpenLocalSettings} />);
    fireEvent.click(screen.getByRole("button", { name: "修改本机总开关" }));
    expect(onOpenLocalSettings).toHaveBeenCalledOnce();
    expect(props.onSubjectChange).not.toHaveBeenCalled();
  });
});

describe("FeishuWorkflowPanel audio drafts", () => {
  afterEach(() => cleanup());

  it("shows the phased editor for a legacy subject with table metadata", () => {
    const configured = legacySubject("legacy-history", "旧高中历史");
    render(<FeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="legacy-history"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

    expect(screen.getByRole("combobox", { name: "状态字段" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "素材文档字段" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "命名字段" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "启用初稿" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "启用初审修改" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "启用终审修改" })).toBeTruthy();
    expect(within(screen.getByRole("combobox", { name: "状态字段" }))
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
    render(<FeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="legacy-trigger"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
      onSaveDraft={onSaveDraft}
    />);

    expect((screen.getByRole("combobox", { name: "状态字段" }) as HTMLSelectElement).value)
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

  it("keeps a supplied stale legacy option id blocked instead of rebinding it by name", () => {
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
    render(<FeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="legacy-stale-option"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

    expect((screen.getByRole("combobox", { name: "状态字段" }) as HTMLSelectElement).value)
      .toBe("fld_status");
    expect((screen.getByRole("combobox", { name: "初稿触发选项" }) as HTMLSelectElement).value)
      .toBe("");
    expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("projects a legacy subject upload path into the initial phase fallback", () => {
    const configured = legacySubject("legacy-upload-path", "旧上传路径");
    if (!configured.upload) throw new Error("legacy subject fixture requires upload settings");
    configured.upload.targetPath = "D:\\legacy-upload-path";
    render(<FeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="legacy-upload-path"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

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
    const { rerender } = render(<FeishuWorkflowPanel {...common} catalog={catalog(configured)} />);

    fireEvent.change(screen.getByRole("textbox", { name: "初稿 ZIP 目标目录" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));

    const [, rawPatch] = onSaveDraft.mock.calls[0];
    const patch = rawPatch as { stages: FeishuStageConfigMap };
    expect(patch.stages.initial.artifactTargetPath).toBe("");

    rerender(<FeishuWorkflowPanel {...common} catalog={catalog(savedSubject)} />);
    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "初稿 ZIP 目标目录" }) as HTMLInputElement).value)
        .toBe("");
    });
  });

  it("keeps an empty-metadata legacy subject on the legacy save path", async () => {
    const configured = legacySubject("legacy-empty", "空 metadata 学科");
    configured.metadata = { fields: [] };
    const onSaveDraft = vi.fn(async (_subjectKey: string, _patch: unknown) => configured);
    render(<FeishuWorkflowPanel
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
    render(<FeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="history"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

    const status = screen.getByRole("combobox", { name: "状态字段" });
    expect(within(status).getByRole("option", { name: "流程状态" })).toBeTruthy();
    expect(within(status).queryByRole("option", { name: "伪状态类型" })).toBeNull();
    expect(within(status).queryByRole("option", { name: "伪状态界面" })).toBeNull();
  });

  it("saves current metadata names for phased field IDs after fields are renamed", async () => {
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
    render(<FeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="renamed"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
      onSaveDraft={onSaveDraft}
    />);

    expect((screen.getByRole("combobox", { name: "状态字段" }) as HTMLSelectElement).value).toBe("fld_status");
    expect(within(screen.getByRole("combobox", { name: "状态字段" })).getByRole("option", { name: "新状态" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "启用" }).getAttribute("title")).toBe("请先保存草稿");
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));

    const [, rawPatch] = onSaveDraft.mock.calls[0];
    const patch = rawPatch as {
      statusField: { fieldName: string };
      documentField: { fieldName: string };
      namingField: { fieldName: string };
      stages: FeishuStageConfigMap;
      trigger: { fieldName: string; optionId: string | null; startValue: string };
    };
    expect(patch.statusField.fieldName).toBe("新状态");
    expect(patch.documentField.fieldName).toBe("新素材文档");
    expect(patch.namingField.fieldName).toBe("新命名");
    expect(Object.values(patch.stages).map((value) => value.trigger.fieldName)).toEqual([
      "新状态", "新状态", "新状态",
    ]);
    expect(Object.values(patch.stages).map((value) => value.trigger.value)).toEqual([
      "新初稿", "新初审修改", "新终审修改",
    ]);
    expect(patch.trigger.fieldName).toBe("新状态");
    expect(patch.trigger.optionId).toBe("opt_initial");
    expect(patch.trigger.startValue).toBe("新初稿");
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
    const { rerender } = render(<FeishuWorkflowPanel
      {...common}
      catalog={catalog(configured)}
      selectedSubjectKey="refresh"
    />);

    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频来源" }), { target: { value: "docx_section" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿音频目录标题" }), { target: { value: "用户未保存音频" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿命名后缀" }), { target: { value: "_用户未保存" } });

    rerender(<FeishuWorkflowPanel
      {...common}
      catalog={catalog(refreshed)}
      selectedSubjectKey="refresh"
    />);

    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "初稿音频目录标题" }) as HTMLInputElement).value)
        .toBe("用户未保存音频");
    });
    expect((screen.getByRole("textbox", { name: "初稿命名后缀" }) as HTMLInputElement).value).toBe("_用户未保存");
    expect(within(screen.getByRole("combobox", { name: "状态字段" })).getByRole("option", { name: "刷新状态" })).toBeTruthy();
    expect(within(screen.getByRole("combobox", { name: "初稿触发选项" })).getByRole("option", { name: "刷新初稿" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "启用" }).getAttribute("title")).toBe("请先保存草稿");

    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    const [, rawPatch] = onSaveDraft.mock.calls[0];
    const patch = rawPatch as { stages: FeishuStageConfigMap; statusField: { fieldName: string } };
    expect(patch.statusField.fieldName).toBe("刷新状态");
    expect(patch.stages.initial.trigger.value).toBe("刷新初稿");
    expect(patch.stages.initial.audio).toEqual({
      mode: "replace_original",
      source: { kind: "docx_section", anchorText: "用户未保存音频" },
      durationToleranceSeconds: 3,
    });
    expect(patch.stages.initial.nameSuffix).toBe("_用户未保存");
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
    const { rerender } = render(<FeishuWorkflowPanel
      {...common}
      catalog={catalog(configured)}
    />);

    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频来源" }), { target: { value: "docx_section" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿音频目录标题" }), { target: { value: "等价刷新未保存音频" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿命名后缀" }), { target: { value: "_等价刷新未保存" } });

    rerender(<FeishuWorkflowPanel
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
    const { rerender } = render(<FeishuWorkflowPanel
      {...common}
      catalog={catalog(configured)}
    />);

    fireEvent.change(screen.getByRole("textbox", { name: "初稿命名后缀" }), { target: { value: "_名称刷新未保存" } });
    rerender(<FeishuWorkflowPanel
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
    const { rerender } = render(<FeishuWorkflowPanel
      {...common}
      catalog={catalog(configured)}
      selectedSubjectKey="server-update"
    />);

    fireEvent.change(screen.getByRole("textbox", { name: "初稿命名后缀" }), { target: { value: "_过期本地编辑" } });
    rerender(<FeishuWorkflowPanel
      {...common}
      catalog={catalog(updated)}
      selectedSubjectKey="server-update"
    />);

    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "初稿命名后缀" }) as HTMLInputElement).value)
        .toBe("_服务器版本");
    });
  });

  it("blocks save and enable when an enabled stage option id is missing from metadata", () => {
    const configured = subject("missing-option", "缺失选项");
    configured.stages!.initial.trigger = { ...configured.stages!.initial.trigger, optionId: "opt_deleted", value: "已删除" };
    render(<FeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="missing-option"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

    expect(screen.getByText("初稿的触发选项当前不可用")).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("blocks save and enable when an enabled stage option id is ambiguous", () => {
    const configured = subject("ambiguous-option", "歧义选项");
    configured.metadata = {
      fields: fields.map((field) => field.fieldId === "fld_status"
        ? { ...field, options: [...field.options, { id: "opt_initial", name: "重复初稿" }] }
        : field),
    };
    render(<FeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="ambiguous-option"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

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
    render(<FeishuWorkflowPanel
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
    render(<FeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="ambiguous-attachments"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

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

    render(<FeishuWorkflowPanel
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

  it("blocks enable when automatic upload has no subject-level upload path", async () => {
    vi.mocked(listFeishuPackages).mockResolvedValueOnce([{
      alias: "Auto-cut-A",
      name: "Auto-Cut A",
      projectId: "auto-cut-a",
      workspacePath: null,
      model: null,
      reasoningEffort: null,
      prompt: null,
      zipSourceDirectory: null,
      maxConcurrent: 1,
      state: "enabled",
      revision: 1,
      updatedAt: "2026-09-13T00:00:00.000Z",
      referenceCount: 0,
      references: [],
    }]);
    const configured = subject("automatic-missing-upload", "缺少上传路径");
    configured.packageRoute = {
      routeMode: configured.packageRoute?.routeMode ?? "fixed",
      packageAlias: "Auto-cut-A",
      subjectCodeFieldId: configured.packageRoute?.subjectCodeFieldId ?? null,
      branchMap: configured.packageRoute?.branchMap ?? null,
    };
    configured.documentField = { fieldId: "fld_text", fieldName: "普通文本" };
    configured.namingField = { fieldId: "fld_text", fieldName: "普通文本" };
    configured.upload = {
      enqueueMode: "automatic",
      artifactSourceMode: configured.upload?.artifactSourceMode ?? "manual_select",
      artifactSourcePath: configured.upload?.artifactSourcePath ?? null,
      targetId: "local-upload",
      targetPath: null,
      uploadConcurrency: configured.upload?.uploadConcurrency ?? 1,
    };
    configured.stages!.first_review.artifactTargetPath = null;
    configured.stages!.final_review.artifactTargetPath = null;

    render(<FeishuWorkflowPanel
      catalog={catalog(configured)}
      configurationBaseToken="bas_test"
      selectedSubjectKey="automatic-missing-upload"
      onSelectSubject={vi.fn()}
      onCatalogChange={vi.fn()}
      onSubjectChange={vi.fn()}
    />);

    await waitFor(() => {
      const enable = screen.getByRole("button", { name: "启用" }) as HTMLButtonElement;
      expect(enable.disabled).toBe(true);
      expect(enable.getAttribute("title")).toBe("请填写上传路径");
    });
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
    const { rerender } = render(<FeishuWorkflowPanel {...common} selectedSubjectKey="history" />);

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

    rerender(<FeishuWorkflowPanel {...common} selectedSubjectKey="geography" />);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "初稿音频来源" }) as HTMLSelectElement).value).toBe("video_original"));
    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频来源" }), { target: { value: "docx_section" } });
    expect((screen.getByRole("textbox", { name: "初稿音频目录标题" }) as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByRole("textbox", { name: "初稿音频目录标题" }), { target: { value: "地理配音" } });

    rerender(<FeishuWorkflowPanel {...common} selectedSubjectKey="history" />);
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
