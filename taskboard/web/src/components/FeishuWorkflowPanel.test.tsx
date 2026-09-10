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

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listFeishuPackages: vi.fn(async () => []),
}));

const fields = [
  {
    fieldId: "fld_status",
    fieldName: "流程状态",
    type: "single_select",
    uiType: "SingleSelect",
    options: [
      { id: "opt_initial", name: "初稿" },
      { id: "opt_review", name: "初审修改" },
      { id: "opt_final", name: "终审修改" },
    ],
  },
  { fieldId: "fld_text", fieldName: "普通文本", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_video", fieldName: "视频附件", type: "attachment", uiType: "Attachment", options: [] },
  { fieldId: "fld_audio", fieldName: "配音附件", type: 17, uiType: null, options: [] },
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

describe("FeishuWorkflowPanel audio drafts", () => {
  afterEach(() => cleanup());

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
