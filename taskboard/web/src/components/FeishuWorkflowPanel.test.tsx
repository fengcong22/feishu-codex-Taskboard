import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskboardStorage } from "../storage";
import type { FeishuBaseCatalog, FeishuStageConfigMap, FeishuSubjectConfig } from "../types";
import {
  audioDraftFromStage,
  FeishuStageEditor,
  type FeishuStageAudioDraft,
  type FeishuStageValue,
} from "./FeishuStageEditor";
import { FeishuWorkflowPanel } from "./FeishuWorkflowPanel";
import { listFeishuPackages, refreshFeishuBaseFields } from "../api";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listFeishuPackages: vi.fn(async () => []),
  refreshFeishuBaseFields: vi.fn(),
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

describe("manual field refresh", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(refreshFeishuBaseFields).mockReset();
  });

  function renderRefreshPanel(configured = subject("refresh-button", "刷新测试")) {
    const onSelectSubject = vi.fn();
    function Host() {
      const [bases, setBases] = useState(catalog(configured));
      return <FeishuWorkflowPanel catalog={bases} configurationBaseToken="bas_test"
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
    expect(screen.getByRole("button", { name: "保存草稿" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("FeishuWorkflowPanel stable layout", () => {
  const layoutKey = "taskboard.feishu-configuration-layout.v1";
  let panelWidth = 1000;

  function renderPanel(configured = subject("layout", "布局测试")) {
    return render(<FeishuWorkflowPanel
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

    render(<FeishuWorkflowPanel {...panelProps(withDelivery)} onSaveDraft={onSaveDraft} />);

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

    render(<FeishuWorkflowPanel {...panelProps(configured)} />);
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

    render(<FeishuWorkflowPanel {...panelProps(configured)} />);
    fireEvent.click(screen.getByRole("tab", { name: "飞书回写" }));

    expect(within(screen.getByRole("region", { name: "回写预览" })).getByText("尚未配置有效的回写内容。")).toBeTruthy();
  });

  it("shows phased settings in four pages while retaining unsaved execution changes", () => {
    const configured = subject("history", "高中历史");
    render(<FeishuWorkflowPanel {...panelProps(configured)} />);

    const tabs = within(screen.getByRole("tablist", { name: "学科配置分区" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["基础与执行", "素材与阶段", "存储与目录", "飞书回写"]);
    expect(screen.getByRole("tab", { name: "基础与执行" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "基础与执行" })).toBeTruthy();
    expect(screen.queryByRole("tabpanel", { name: "素材与阶段" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "剪辑模式" })).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "剪辑模式" }), { target: { value: "automatic" } });
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
    expect((screen.getByRole("combobox", { name: "剪辑模式" }) as HTMLSelectElement).value).toBe("automatic");
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
    const { rerender } = render(<FeishuWorkflowPanel {...common} selectedSubjectKey={history.subjectKey} />);

    const basics = screen.getByRole("tab", { name: "基础与执行" });
    fireEvent.keyDown(basics, { key: "End" });
    const writeback = screen.getByRole("tab", { name: "飞书回写" });
    expect(writeback.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(writeback);

    rerender(<FeishuWorkflowPanel {...common} selectedSubjectKey={geography.subjectKey} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "基础与执行" }).getAttribute("aria-selected")).toBe("true"));
    expect((screen.getByRole("combobox", { name: "剪辑模式" }) as HTMLSelectElement).value).toBe("automatic");
  });

  it("renders the approved card hierarchy for subject configuration", () => {
    const configured = subject("history", "高中历史");
    render(<FeishuWorkflowPanel {...panelProps(configured)} />);

    expect(screen.getByRole("region", { name: "学科配置" }).className).toContain("feishu-subject-settings");
    expect(screen.getByRole("group", { name: "通用执行设置" }).className).toContain("feishu-config-card");
    expect(screen.getByRole("group", { name: "Auto-Cut 路由" }).className).toContain("feishu-config-card");
    expect(screen.getByRole("group", { name: "ZIP 与上传" }).className).toContain("feishu-config-card");

    fireEvent.click(screen.getByRole("tab", { name: "素材与阶段" }));
    expect(screen.getByRole("region", { name: "素材与阶段" }).className).toContain("feishu-config-card");
  });

  it.each(["phased", "metadata fallback", "legacy"])("shows one shared mode without editable scheduling groups for %s subjects", (kind) => {
    const configured = kind === "phased" ? subject("history", "高中历史") : legacySubject("history", "高中历史");
    if (kind === "legacy") configured.metadata = { fields: [] };
    render(<FeishuWorkflowPanel {...panelProps(configured)} />);

    const common = screen.getByRole("group", { name: "通用执行设置" });
    expect(screen.getAllByRole("combobox", { name: "剪辑模式" })).toHaveLength(1);
    expect((within(common).getByRole("combobox", { name: "剪辑模式" }) as HTMLSelectElement).value).toBe("manual");
    expect(within(common).queryByRole("textbox", { name: "并发组" })).toBeNull();
    expect(within(common).queryByRole("spinbutton", { name: "并发数" })).toBeNull();
    expect(within(common).queryByRole("textbox", { name: "资源组" })).toBeNull();
    if (kind !== "legacy") {
      fireEvent.click(screen.getByRole("tab", { name: "素材与阶段" }));
      const phases = screen.getByRole("region", { name: "素材与阶段" });
      expect(within(phases).queryByRole("combobox", { name: "剪辑模式" })).toBeNull();
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
    };
  }

  it("enables automatic phased upload with only enabled stage destinations", async () => {
    const configured = configuredSubject();
    const onEnable = vi.fn(async () => configured);
    render(<FeishuWorkflowPanel {...panelProps(configured)} onEnable={onEnable} />);

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
    render(<FeishuWorkflowPanel {...panelProps(configured)} />);

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
    render(<FeishuWorkflowPanel {...panelProps(configured)} />);

    expect(screen.queryByText("初稿需要 ZIP 目标目录")).toBeNull();
    await waitFor(() => expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("keeps the common destination required for legacy automatic upload", async () => {
    const configured = configuredSubject("legacy");
    render(<FeishuWorkflowPanel {...panelProps(configured)} />);

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
    render(<FeishuWorkflowPanel {...panelProps(configured)} onSaveDraft={onSaveDraft} />);

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
    render(<FeishuWorkflowPanel catalog={catalog(configured)} configurationBaseToken="bas_test"
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
    render(<FeishuWorkflowPanel
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
    render(<FeishuWorkflowPanel
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
    render(<FeishuWorkflowPanel
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
    const { rerender } = render(<FeishuWorkflowPanel {...common} catalog={catalog(configured)} />);

    selectSubjectSettingsTab("素材与阶段");
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
    render(<FeishuWorkflowPanel
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
    expect(screen.getByRole("button", { name: "保存草稿" }).hasAttribute("disabled")).toBe(true);
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
    const { rerender } = render(<FeishuWorkflowPanel
      {...common}
      catalog={catalog(configured)}
      selectedSubjectKey="refresh"
    />);

    selectSubjectSettingsTab("素材与阶段");
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
    expect(within(screen.getByRole("combobox", { name: "初稿触发字段" })).getByRole("option", { name: "刷新状态" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "初稿触发字段" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("combobox", { name: "初稿触发选项" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(true);
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
    const { rerender } = render(<FeishuWorkflowPanel
      {...common}
      catalog={catalog(configured)}
      selectedSubjectKey="server-cleared-refresh"
    />);

    selectSubjectSettingsTab("素材与阶段");
    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频来源" }), { target: { value: "docx_section" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿音频目录标题" }), { target: { value: "刷新前的配音" } });
    fireEvent.change(screen.getByRole("textbox", { name: "初稿命名后缀" }), { target: { value: "_刷新前未保存" } });

    rerender(<FeishuWorkflowPanel
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
    const { rerender } = render(<FeishuWorkflowPanel
      {...common}
      catalog={catalog(configured)}
    />);

    selectSubjectSettingsTab("素材与阶段");
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

    selectSubjectSettingsTab("素材与阶段");
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

    selectSubjectSettingsTab("素材与阶段");
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

    selectSubjectSettingsTab("素材与阶段");
    expect(screen.getByText("初稿需要触发选项")).toBeTruthy();
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

    rerender(<FeishuWorkflowPanel {...common} selectedSubjectKey="geography" />);
    selectSubjectSettingsTab("素材与阶段");
    await waitFor(() => expect((screen.getByRole("combobox", { name: "初稿音频来源" }) as HTMLSelectElement).value).toBe("video_original"));
    fireEvent.change(screen.getByRole("combobox", { name: "初稿音频来源" }), { target: { value: "docx_section" } });
    expect((screen.getByRole("textbox", { name: "初稿音频目录标题" }) as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByRole("textbox", { name: "初稿音频目录标题" }), { target: { value: "地理配音" } });

    rerender(<FeishuWorkflowPanel {...common} selectedSubjectKey="history" />);
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
