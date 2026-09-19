import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import {
  discoverFeishuPackageModels,
  disableFeishuPackage,
  enableFeishuPackage,
  inspectFeishuPackageWorkspace,
  listFeishuPackages,
  prepareFeishuPackageOutputDirectory,
  validateFeishuPackageOutputDirectory,
  saveFeishuPackageDraft,
} from "../api";
import type { FeishuPackageSummary, FeishuPackageWorkspaceInspection, FeishuSubjectConfig } from "../types";
import { FeishuPackageManager } from "./FeishuPackageManager";
import { FeishuWorkflowPanel } from "./FeishuWorkflowPanel";

vi.mock("../api", async (importOriginal) => ({
  ApiError: (await importOriginal<typeof import("../api")>()).ApiError,
  discoverFeishuPackageModels: vi.fn(async () => ({ models: [] })),
  disableFeishuPackage: vi.fn(),
  enableFeishuPackage: vi.fn(),
  inspectFeishuPackageWorkspace: vi.fn(),
  listFeishuPackages: vi.fn(async () => []),
  prepareFeishuPackageOutputDirectory: vi.fn(),
  validateFeishuPackageOutputDirectory: vi.fn(async (directory: string) => directory),
  removeFeishuPackage: vi.fn(),
  saveFeishuPackageDraft: vi.fn(),
  refreshFeishuBaseFields: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.mocked(listFeishuPackages).mockResolvedValue([]);
  vi.mocked(validateFeishuPackageOutputDirectory).mockImplementation(async (directory: string) => directory);
});

const historicalPackage: FeishuPackageSummary = {
  alias: "Auto-cut-lite",
  name: "Auto-Cut Lite",
  projectId: "auto-cut-lite",
  workspacePath: "D:\\codex\\auto-cut-lite",
  model: "gpt-test",
  reasoningEffort: "medium",
  prompt: "historical prompt",
  zipSourceDirectory: "D:\\codex\\auto-cut-lite\\zips",
  maxConcurrent: 2,
  resourceGroups: ["剪映主机"],
  state: "enabled",
  revision: 18,
  updatedAt: "2026-09-17T00:00:00.000Z",
  referenceCount: 0,
  references: [],
};

const inspection: FeishuPackageWorkspaceInspection = {
  displayName: "Auto-cut-lite1.6.9",
  pluginVersion: "1.6.9",
  runtimeVersion: "1.7.0",
  defaultPrompt: "manifest prompt",
  alias: "auto-cut-lite-2",
  projectId: "auto-cut-lite-2",
};

const inspectionWithZipOutput: FeishuPackageWorkspaceInspection = {
  ...inspection,
  zipOutput: {
    relativeDirectory: "output",
    directory: "D:\\codex\\auto-cut-lite\\output",
  },
};

it("uses the current manifest name in subject routing without changing its saved alias", async () => {
  const currentPackage = { ...historicalPackage, name: "Auto-cut-lite1.6.8", identity: inspection };
  vi.mocked(listFeishuPackages).mockResolvedValue([currentPackage]);
  const configured: FeishuSubjectConfig = {
    subjectKey: "history", baseToken: "bas_test", baseName: "Test Base", tableId: "tbl_history",
    tableName: "History", projectId: "subject-history", displayEnabled: true, lifecycle: "enabled",
    configVersion: 1, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
    packageRoute: { routeMode: "fixed", packageAlias: historicalPackage.alias, subjectCodeFieldId: null, branchMap: null },
    metadata: { fields: [] },
  };
  const onSubjectChange = vi.fn();
  render(<FeishuWorkflowPanel
    catalog={[{
      baseToken: configured.baseToken, baseName: configured.baseName, sourceUrlLabel: null,
      metadataRefreshedAt: null, subjects: [configured], createdAt: configured.createdAt, updatedAt: configured.updatedAt,
    }]}
    configurationBaseToken={configured.baseToken}
    selectedSubjectKey={configured.subjectKey}
    onSelectSubject={vi.fn()}
    onCatalogChange={vi.fn()}
    onSubjectChange={onSubjectChange}
  />);

  const option = await screen.findByRole("option", { name: inspection.displayName }) as HTMLOptionElement;
  expect(option.value).toBe(historicalPackage.alias);
  expect(option.selected).toBe(true);
  expect(screen.queryByRole("option", { name: /Auto-cut-lite1\.6\.8/ })).toBeNull();
  expect(onSubjectChange).not.toHaveBeenCalled();
  expect(currentPackage.name).toBe("Auto-cut-lite1.6.8");
  expect(currentPackage.projectId).toBe(historicalPackage.projectId);
});

it("keeps an explicitly custom directory through workspace verification and validates before saving", async () => {
  const custom = { ...historicalPackage, zipOutputMode: "custom" as const, zipSourceDirectory: "E:\\剪辑输出" };
  vi.mocked(listFeishuPackages).mockResolvedValue([custom]);
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValue(inspectionWithZipOutput);
  vi.mocked(saveFeishuPackageDraft).mockResolvedValue({ ...custom, revision: 19 });
  render(<FeishuPackageManager />);
  await screen.findByDisplayValue("historical prompt");
  expect((screen.getByRole("combobox", { name: "ZIP 目录来源" }) as HTMLSelectElement).value).toBe("custom");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText(/验证并读取成功/);
  const directory = screen.getByRole("textbox", { name: "ZIP 生成目录" }) as HTMLInputElement;
  expect(directory.value).toBe(custom.zipSourceDirectory);
  expect(directory.disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(saveFeishuPackageDraft).toHaveBeenCalledWith(custom.alias, expect.objectContaining({ zipOutputMode: "custom", zipSourceDirectory: custom.zipSourceDirectory })));
  expect(validateFeishuPackageOutputDirectory).toHaveBeenCalledWith(custom.zipSourceDirectory);
  expect(prepareFeishuPackageOutputDirectory).not.toHaveBeenCalled();
  expect(vi.mocked(validateFeishuPackageOutputDirectory).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(saveFeishuPackageDraft).mock.invocationCallOrder[0]);
});

it("switches between default and custom directories without losing the custom draft", async () => {
  const custom = { ...historicalPackage, zipOutputMode: "custom" as const, identity: inspectionWithZipOutput, zipSourceDirectory: "E:\\剪辑输出" };
  vi.mocked(listFeishuPackages).mockResolvedValue([custom]);
  render(<FeishuPackageManager />);
  await screen.findByDisplayValue("historical prompt");
  const mode = screen.getByRole("combobox", { name: "ZIP 目录来源" });
  fireEvent.change(mode, { target: { value: "package_default" } });
  let directory = screen.getByRole("textbox", { name: "ZIP 生成目录" }) as HTMLInputElement;
  expect(directory.value).toBe(inspectionWithZipOutput.zipOutput!.directory);
  expect(directory.disabled).toBe(true);
  fireEvent.change(mode, { target: { value: "custom" } });
  directory = screen.getByRole("textbox", { name: "ZIP 生成目录" }) as HTMLInputElement;
  expect(directory.value).toBe(custom.zipSourceDirectory);
  expect(directory.disabled).toBe(false);
});

it("blocks saving a custom directory when validation fails and restores the save button", async () => {
  const custom = { ...historicalPackage, zipOutputMode: "custom" as const };
  vi.mocked(listFeishuPackages).mockResolvedValue([custom]);
  vi.mocked(validateFeishuPackageOutputDirectory).mockRejectedValueOnce(new Error("目录不存在或不可写"));
  render(<FeishuPackageManager />);
  await screen.findByDisplayValue("historical prompt");
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("目录不存在或不可写");
  expect(saveFeishuPackageDraft).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(false);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

it("waits for verified package history before allowing new configuration", async () => {
  const request = deferred<FeishuPackageSummary[]>();
  vi.mocked(listFeishuPackages).mockReturnValueOnce(request.promise);
  render(<FeishuPackageManager />);

  expect(screen.getByRole("status").textContent).toContain("正在加载");
  expect((screen.getByRole("button", { name: "新增 Auto-Cut 包" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText("暂无包配置")).toBeNull();
  expect(screen.queryByRole("button", { name: "保存草稿" })).toBeNull();

  await act(async () => request.resolve([historicalPackage]));

  expect(screen.getByRole("heading", { name: "编辑 Auto-Cut Lite" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "显示名称" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "包别名" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "项目 ID" })).toBeNull();
  expect((screen.getByRole("textbox", { name: "Codex 工作区路径" }) as HTMLInputElement).value).toBe(historicalPackage.workspacePath);
  expect((screen.getByRole("textbox", { name: "启动 Prompt" }) as HTMLTextAreaElement).value).toBe("historical prompt");
  expect((screen.getByRole("textbox", { name: "资源组" }) as HTMLInputElement).value).toBe("剪映主机");
  expect((screen.getByRole("combobox", { name: "GPT 模型" }) as HTMLSelectElement).value).toBe("gpt-test");
  expect((screen.getByRole("button", { name: "新增 Auto-Cut 包" }) as HTMLButtonElement).disabled).toBe(false);
});

it("shows a retryable load error rather than claiming historical packages are empty", async () => {
  vi.mocked(listFeishuPackages).mockRejectedValueOnce(new Error("连接暂时失败"));
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([historicalPackage]);
  render(<FeishuPackageManager />);

  expect((await screen.findByRole("alert")).textContent).toContain("连接暂时失败");
  expect(screen.queryByText("暂无包配置")).toBeNull();
  expect((screen.getByRole("button", { name: "新增 Auto-Cut 包" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "保存草稿" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));

  await screen.findByDisplayValue("historical prompt");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(saveFeishuPackageDraft).not.toHaveBeenCalled();
});

it("only shows an empty catalog after a successful empty response", async () => {
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([]);
  render(<FeishuPackageManager />);
  await screen.findByText("暂无包配置");
  expect((screen.getByRole("button", { name: "新增 Auto-Cut 包" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole("textbox", { name: "Codex 工作区路径" })).toBeTruthy();
});

it("validates a new workspace before pre-filling its stable package identity", async () => {
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValueOnce({
    displayName: "Auto-cut-lite1.6.9",
    pluginVersion: "1.6.9",
    runtimeVersion: "1.7.0",
    defaultPrompt: "Use the Auto-Cut workflow.",
    alias: "auto-cut-lite",
    projectId: "auto-cut-lite",
  });
  render(<FeishuPackageManager />);

  await screen.findByText("暂无包配置");
  const save = screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  expect(screen.queryByRole("textbox", { name: "包别名" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "项目 ID" })).toBeNull();

  fireEvent.change(screen.getByRole("textbox", { name: "Codex 工作区路径" }), {
    target: { value: "D:\\codex\\auto-cut-lite" },
  });
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));

  await waitFor(() => expect(inspectFeishuPackageWorkspace).toHaveBeenCalledWith("D:\\codex\\auto-cut-lite", expect.any(AbortSignal)));
  expect(screen.getByText("Auto-cut-lite1.6.9")).toBeTruthy();
  expect(screen.getByText("运行核心 1.7.0")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "启动 Prompt" }) as HTMLTextAreaElement).value).toBe("Use the Auto-Cut workflow.");
  expect(save.disabled).toBe(false);
});

it("uses and locks the ZIP generation directory declared by a freshly verified package", async () => {
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValueOnce(inspectionWithZipOutput);
  render(<FeishuPackageManager />);

  await screen.findByText("暂无包配置");
  fireEvent.change(screen.getByRole("textbox", { name: "Codex 工作区路径" }), {
    target: { value: "D:\\codex\\auto-cut-lite" },
  });
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));

  const directory = await screen.findByRole("textbox", { name: "ZIP 生成目录" }) as HTMLInputElement;
  expect(directory.value).toBe("D:\\codex\\auto-cut-lite\\output");
  expect(directory.disabled).toBe(true);
  expect(screen.getByText("来自 Auto-Cut-Lite")).toBeTruthy();
  expect(screen.getByText("output → D:\\codex\\auto-cut-lite\\output")).toBeTruthy();
});

it("retains an editable manual ZIP generation directory when the verified package has no declaration", async () => {
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValueOnce(inspection);
  render(<FeishuPackageManager />);

  await screen.findByText("暂无包配置");
  fireEvent.change(screen.getByRole("textbox", { name: "Codex 工作区路径" }), {
    target: { value: "D:\\codex\\auto-cut-lite" },
  });
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));

  const directory = await screen.findByRole("textbox", { name: "ZIP 生成目录" }) as HTMLInputElement;
  expect(directory.disabled).toBe(false);
  expect(screen.queryByText("来自 Auto-Cut-Lite")).toBeNull();
});

it("prepares a freshly declared ZIP generation directory before saving the package", async () => {
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValueOnce(inspectionWithZipOutput);
  vi.mocked(prepareFeishuPackageOutputDirectory).mockResolvedValueOnce(inspectionWithZipOutput.zipOutput!);
  vi.mocked(saveFeishuPackageDraft).mockResolvedValueOnce({
    ...historicalPackage,
    alias: inspection.alias,
    name: inspection.displayName,
    projectId: inspection.projectId,
    workspacePath: "D:\\codex\\auto-cut-lite",
    zipSourceDirectory: inspectionWithZipOutput.zipOutput!.directory,
    state: "draft",
    revision: 1,
  });
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  render(<FeishuPackageManager />);

  await screen.findByText("暂无包配置");
  fireEvent.change(screen.getByRole("textbox", { name: "Codex 工作区路径" }), {
    target: { value: "D:\\codex\\auto-cut-lite" },
  });
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByRole("textbox", { name: "ZIP 生成目录" });
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));

  await waitFor(() => expect(prepareFeishuPackageOutputDirectory).toHaveBeenCalledWith("D:\\codex\\auto-cut-lite"));
  expect(saveFeishuPackageDraft).toHaveBeenCalledWith(null, expect.objectContaining({
    zipSourceDirectory: "D:\\codex\\auto-cut-lite\\output",
  }));
});

it("does not save when output directory preparation returns a different location", async () => {
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValueOnce(inspectionWithZipOutput);
  vi.mocked(prepareFeishuPackageOutputDirectory).mockResolvedValueOnce({
    relativeDirectory: "output",
    directory: "D:\\codex\\auto-cut-lite\\other-output",
  });
  render(<FeishuPackageManager />);

  await screen.findByText("暂无包配置");
  fireEvent.change(screen.getByRole("textbox", { name: "Codex 工作区路径" }), {
    target: { value: "D:\\codex\\auto-cut-lite" },
  });
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByRole("textbox", { name: "ZIP 生成目录" });
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));

  expect((await screen.findByRole("alert")).textContent).toContain("ZIP 生成目录与 Auto-Cut-Lite 声明不一致");
  expect(saveFeishuPackageDraft).not.toHaveBeenCalled();
});

it("preserves historical ZIP settings when a list refresh includes a newer directory declaration", async () => {
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([{ ...historicalPackage, identity: inspectionWithZipOutput }]);
  render(<FeishuPackageManager />);

  const directory = await screen.findByRole("textbox", { name: "ZIP 生成目录" }) as HTMLInputElement;
  expect(directory.value).toBe(historicalPackage.zipSourceDirectory);
  expect(directory.disabled).toBe(false);
  expect(screen.queryByText("来自 Auto-Cut-Lite")).toBeNull();
  expect(prepareFeishuPackageOutputDirectory).not.toHaveBeenCalled();
  expect(saveFeishuPackageDraft).not.toHaveBeenCalled();
});

it("only switches a historical ZIP directory after fresh verification and retains its routing identity", async () => {
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([historicalPackage]);
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValueOnce(inspectionWithZipOutput);
  vi.mocked(prepareFeishuPackageOutputDirectory).mockResolvedValueOnce(inspectionWithZipOutput.zipOutput!);
  vi.mocked(saveFeishuPackageDraft).mockResolvedValueOnce(historicalPackage);
  render(<FeishuPackageManager />);

  await screen.findByDisplayValue("historical prompt");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText("来自 Auto-Cut-Lite");
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));

  await waitFor(() => expect(saveFeishuPackageDraft).toHaveBeenCalledWith(historicalPackage.alias, expect.objectContaining({
    alias: historicalPackage.alias,
    name: historicalPackage.name,
    projectId: historicalPackage.projectId,
    prompt: historicalPackage.prompt,
    zipSourceDirectory: inspectionWithZipOutput.zipOutput!.directory,
  })));
});

it("saves a manually entered directory without preparing it for an older package", async () => {
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([historicalPackage]);
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValueOnce({ ...inspection, zipOutput: null });
  vi.mocked(saveFeishuPackageDraft).mockResolvedValueOnce(historicalPackage);
  render(<FeishuPackageManager />);

  await screen.findByDisplayValue("historical prompt");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText(/验证并读取成功/);
  fireEvent.change(screen.getByRole("textbox", { name: "ZIP 生成目录" }), { target: { value: "D:\\manual-zips" } });
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));

  await waitFor(() => expect(saveFeishuPackageDraft).toHaveBeenCalledWith(historicalPackage.alias, expect.objectContaining({
    zipSourceDirectory: "D:\\manual-zips",
  })));
  expect(prepareFeishuPackageOutputDirectory).not.toHaveBeenCalled();
});

it("reports directory preparation failures and releases the save action without persisting", async () => {
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([historicalPackage]);
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValueOnce(inspectionWithZipOutput);
  vi.mocked(prepareFeishuPackageOutputDirectory).mockRejectedValueOnce(new Error("没有目录写入权限"));
  render(<FeishuPackageManager />);

  await screen.findByDisplayValue("historical prompt");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText("来自 Auto-Cut-Lite");
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));

  expect((await screen.findByRole("alert")).textContent).toContain("没有目录写入权限");
  expect(saveFeishuPackageDraft).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(false);
});

it("prepares and saves the new declared directory before enabling a dirty draft", async () => {
  const pending = deferred<{ relativeDirectory: string; directory: string }>();
  const draft = { ...historicalPackage, state: "draft" as const };
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([draft]);
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValueOnce(inspectionWithZipOutput);
  vi.mocked(prepareFeishuPackageOutputDirectory).mockReturnValueOnce(pending.promise);
  vi.mocked(saveFeishuPackageDraft).mockResolvedValueOnce({ ...draft, revision: 19 });
  vi.mocked(enableFeishuPackage).mockResolvedValueOnce({ ...draft, state: "enabled", revision: 20 });
  render(<FeishuPackageManager />);

  await screen.findByDisplayValue("historical prompt");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText("来自 Auto-Cut-Lite");
  fireEvent.click(screen.getByRole("button", { name: "启用" }));

  expect(prepareFeishuPackageOutputDirectory).toHaveBeenCalledWith(historicalPackage.workspacePath);
  expect(saveFeishuPackageDraft).not.toHaveBeenCalled();
  expect(enableFeishuPackage).not.toHaveBeenCalled();
  await act(async () => pending.resolve(inspectionWithZipOutput.zipOutput!));
  expect(saveFeishuPackageDraft).toHaveBeenCalledTimes(1);
  expect(enableFeishuPackage).toHaveBeenCalledWith(historicalPackage.alias, 19);
});

it("prepares a verified declared directory before enabling an unchanged draft", async () => {
  const pending = deferred<{ relativeDirectory: string; directory: string }>();
  const draft = {
    ...historicalPackage,
    state: "draft" as const,
    zipSourceDirectory: inspectionWithZipOutput.zipOutput!.directory,
  };
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([draft]);
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValueOnce(inspectionWithZipOutput);
  vi.mocked(prepareFeishuPackageOutputDirectory).mockReturnValueOnce(pending.promise);
  vi.mocked(enableFeishuPackage).mockResolvedValueOnce({ ...draft, state: "enabled", revision: 19 });
  render(<FeishuPackageManager />);

  await screen.findByDisplayValue("historical prompt");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText("来自 Auto-Cut-Lite");
  fireEvent.click(screen.getByRole("button", { name: "启用" }));

  expect(prepareFeishuPackageOutputDirectory).toHaveBeenCalledWith(historicalPackage.workspacePath);
  expect(enableFeishuPackage).not.toHaveBeenCalled();
  await act(async () => pending.resolve(inspectionWithZipOutput.zipOutput!));
  expect(enableFeishuPackage).toHaveBeenCalledWith(historicalPackage.alias, 18);
  expect(saveFeishuPackageDraft).not.toHaveBeenCalled();
});

it("does not persist a stale draft if the workspace changes during directory preparation", async () => {
  const pending = deferred<{ relativeDirectory: string; directory: string }>();
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([historicalPackage]);
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValueOnce(inspectionWithZipOutput);
  vi.mocked(prepareFeishuPackageOutputDirectory).mockReturnValueOnce(pending.promise);
  render(<FeishuPackageManager />);

  await screen.findByDisplayValue("historical prompt");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText("来自 Auto-Cut-Lite");
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Codex 工作区路径" }), { target: { value: "D:\\other-lite" } });
  await act(async () => pending.resolve(inspectionWithZipOutput.zipOutput!));

  expect(saveFeishuPackageDraft).not.toHaveBeenCalled();
  expect((await screen.findByRole("alert")).textContent).toContain("配置已变更");
});

it("does not create directories while disabling a package with unsaved verified changes", async () => {
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([historicalPackage]);
  vi.mocked(listFeishuPackages).mockResolvedValue([{ ...historicalPackage, state: "disabled", revision: 19 }]);
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValueOnce(inspectionWithZipOutput);
  vi.mocked(disableFeishuPackage).mockResolvedValueOnce({ ...historicalPackage, state: "disabled", revision: 19 });
  render(<FeishuPackageManager />);

  await screen.findByDisplayValue("historical prompt");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText("来自 Auto-Cut-Lite");
  fireEvent.click(screen.getByRole("button", { name: /^停用$/u }));

  await waitFor(() => expect(disableFeishuPackage).toHaveBeenCalledWith(historicalPackage.alias, 18));
  await screen.findByRole("button", { name: "启用" });
  expect(saveFeishuPackageDraft).not.toHaveBeenCalled();
  expect(prepareFeishuPackageOutputDirectory).not.toHaveBeenCalled();
  expect(screen.getByDisplayValue(inspectionWithZipOutput.zipOutput!.directory)).toBeTruthy();
});

it("does not save an unprepared auto-filled ZIP directory after a later verification fails", async () => {
  vi.mocked(listFeishuPackages).mockResolvedValue([historicalPackage]);
  vi.mocked(inspectFeishuPackageWorkspace)
    .mockResolvedValueOnce(inspectionWithZipOutput)
    .mockRejectedValueOnce(new Error("读取失败"));
  vi.mocked(prepareFeishuPackageOutputDirectory).mockRejectedValueOnce(new Error("请重新验证工作区"));
  render(<FeishuPackageManager />);

  await screen.findByDisplayValue("historical prompt");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText("来自 Auto-Cut-Lite");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText(/验证未完成/);
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));

  await waitFor(() => expect(prepareFeishuPackageOutputDirectory).toHaveBeenCalledWith(historicalPackage.workspacePath));
  expect(saveFeishuPackageDraft).not.toHaveBeenCalled();
});

it("restores the previous directory if a new inspection no longer declares ZIP output", async () => {
  vi.mocked(listFeishuPackages).mockResolvedValue([historicalPackage]);
  vi.mocked(inspectFeishuPackageWorkspace)
    .mockResolvedValueOnce(inspectionWithZipOutput)
    .mockResolvedValueOnce({ ...inspection, zipOutput: null });
  render(<FeishuPackageManager />);

  await screen.findByDisplayValue("historical prompt");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText("来自 Auto-Cut-Lite");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText("该包未声明默认目录，可手动填写 ZIP 生成目录。");
  expect((screen.getByRole("textbox", { name: "ZIP 生成目录" }) as HTMLInputElement).value).toBe(historicalPackage.zipSourceDirectory);
});

it("keeps a saved ZIP directory if the package later removes its declaration", async () => {
  const saved = { ...historicalPackage, zipSourceDirectory: inspectionWithZipOutput.zipOutput!.directory, revision: 19 };
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([historicalPackage]).mockResolvedValue([saved]);
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValueOnce(inspectionWithZipOutput).mockResolvedValueOnce({ ...inspection, zipOutput: null });
  vi.mocked(prepareFeishuPackageOutputDirectory).mockResolvedValue(inspectionWithZipOutput.zipOutput!);
  vi.mocked(saveFeishuPackageDraft).mockResolvedValue(saved);
  render(<FeishuPackageManager />);
  await screen.findByDisplayValue("historical prompt");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText("来自 Auto-Cut-Lite");
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(listFeishuPackages).toHaveBeenCalledTimes(2));
  await waitFor(() => expect((screen.getByRole("button", { name: "验证并读取" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText("该包未声明默认目录，可手动填写 ZIP 生成目录。");
  expect((screen.getByRole("textbox", { name: "ZIP 生成目录" }) as HTMLInputElement).value).toBe(saved.zipSourceDirectory);
});

it("enables a loaded historical draft using its saved directory rather than a list declaration", async () => {
  const draft = { ...historicalPackage, state: "draft" as const, identity: inspectionWithZipOutput };
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([draft]);
  vi.mocked(enableFeishuPackage).mockResolvedValueOnce({ ...draft, state: "enabled", revision: 19 });
  render(<FeishuPackageManager />);

  await screen.findByDisplayValue("historical prompt");
  fireEvent.click(screen.getByRole("button", { name: "启用" }));

  await waitFor(() => expect(enableFeishuPackage).toHaveBeenCalledWith(historicalPackage.alias, 18));
  expect(saveFeishuPackageDraft).not.toHaveBeenCalled();
  expect(prepareFeishuPackageOutputDirectory).not.toHaveBeenCalled();
});

it("shows inspection progress and success with the newly read version without saving historical settings", async () => {
  const pending = deferred<FeishuPackageWorkspaceInspection>();
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([{ ...historicalPackage, identity: { ...inspection, displayName: "Auto-cut-lite1.6.8", pluginVersion: "1.6.8" } }]);
  vi.mocked(inspectFeishuPackageWorkspace).mockReturnValueOnce(pending.promise);
  render(<FeishuPackageManager />);
  await screen.findByDisplayValue("historical prompt");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  expect(screen.getByRole("button", { name: "正在验证…" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("正在验证工作区");
  await act(async () => pending.resolve(inspection));
  expect(screen.getByRole("status").textContent).toContain("验证并读取成功");
  expect(screen.getByRole("status").textContent).toContain("Auto-cut-lite1.6.9");
  expect(screen.getByRole("status").textContent).toContain("1.7.0");
  expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("button", { name: /^停用$/u }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("button", { name: /^删除$/u }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByDisplayValue("historical prompt")).toBeTruthy();
  expect(saveFeishuPackageDraft).not.toHaveBeenCalled();
});

it("clears previous success and shows a retryable inspection failure then releases the buttons", async () => {
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([historicalPackage]);
  vi.mocked(inspectFeishuPackageWorkspace).mockResolvedValueOnce(inspection).mockRejectedValueOnce(new Error("读取超时，请重试"));
  render(<FeishuPackageManager />);
  await screen.findByDisplayValue("historical prompt");
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  await screen.findByText(/验证并读取成功/);
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  expect((await screen.findByRole("alert")).textContent).toContain("读取超时，请重试");
  expect(screen.queryByText(/验证并读取成功/)).toBeNull();
  expect((screen.getByRole("button", { name: "验证并读取" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(false);
});

it("cancels stale inspection when the workspace changes and ignores its late result", async () => {
  const pending = deferred<FeishuPackageWorkspaceInspection>();
  vi.mocked(inspectFeishuPackageWorkspace).mockReturnValueOnce(pending.promise);
  render(<FeishuPackageManager />);
  await screen.findByText("暂无包配置");
  fireEvent.change(screen.getByRole("textbox", { name: "Codex 工作区路径" }), { target: { value: "D:\\first" } });
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  const signal = vi.mocked(inspectFeishuPackageWorkspace).mock.calls[0][1];
  fireEvent.change(screen.getByRole("textbox", { name: "Codex 工作区路径" }), { target: { value: "D:\\second" } });
  expect(signal?.aborted).toBe(true);
  expect((screen.getByRole("button", { name: "验证并读取" }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => pending.resolve(inspection));
  expect(screen.queryByText(/验证并读取成功/)).toBeNull();
  expect(screen.queryByText("Auto-cut-lite1.6.9")).toBeNull();
  expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(true);
});

it("keeps user prompt edits made during inspection while applying workspace metadata", async () => {
  const pending = deferred<FeishuPackageWorkspaceInspection>();
  vi.mocked(inspectFeishuPackageWorkspace).mockReturnValueOnce(pending.promise);
  render(<FeishuPackageManager />);
  await screen.findByText("暂无包配置");
  fireEvent.change(screen.getByRole("textbox", { name: "Codex 工作区路径" }), { target: { value: "D:\\first" } });
  fireEvent.click(screen.getByRole("button", { name: "验证并读取" }));
  fireEvent.change(screen.getByRole("textbox", { name: "启动 Prompt" }), { target: { value: "my custom prompt" } });
  await act(async () => pending.resolve(inspection));
  expect(screen.getByRole("status").textContent).toContain("验证并读取成功");
  expect(screen.getByDisplayValue("my custom prompt")).toBeTruthy();
  expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(false);
});

it("keeps loaded history and unsaved edits through refresh failure and focus recovery", async () => {
  const onPackageChange = vi.fn();
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([historicalPackage]);
  vi.mocked(listFeishuPackages).mockRejectedValueOnce(new Error("刷新失败"));
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([{ ...historicalPackage, revision: 19 }]);
  const view = render(<FeishuPackageManager refreshKey={0} onPackageChange={onPackageChange} />);
  await screen.findByDisplayValue("historical prompt");
  fireEvent.change(screen.getByRole("textbox", { name: "启动 Prompt" }), { target: { value: "unsaved prompt" } });
  view.rerender(<FeishuPackageManager refreshKey={1} onPackageChange={onPackageChange} />);

  expect((await screen.findByRole("alert")).textContent).toContain("刷新失败");
  expect(screen.getByDisplayValue("unsaved prompt")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "编辑 Auto-Cut Lite" })).toHaveLength(2);
  expect(onPackageChange).toHaveBeenCalledTimes(1);
  fireEvent.focus(window);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByDisplayValue("unsaved prompt")).toBeTruthy();
  expect(onPackageChange).toHaveBeenCalledTimes(2);
  fireEvent.focus(window);
  expect(listFeishuPackages).toHaveBeenCalledTimes(3);
});

it("ignores an older successful load that finishes after a newer refresh", async () => {
  const oldRequest = deferred<FeishuPackageSummary[]>();
  const newRequest = deferred<FeishuPackageSummary[]>();
  const onPackageChange = vi.fn();
  vi.mocked(listFeishuPackages).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
  const view = render(<FeishuPackageManager refreshKey={0} onPackageChange={onPackageChange} />);
  view.rerender(<FeishuPackageManager refreshKey={1} onPackageChange={onPackageChange} />);
  await act(async () => newRequest.resolve([{ ...historicalPackage, prompt: "latest prompt", revision: 19 }]));
  await act(async () => oldRequest.resolve([historicalPackage]));

  expect(screen.getByDisplayValue("latest prompt")).toBeTruthy();
  expect(screen.queryByDisplayValue("historical prompt")).toBeNull();
  expect(onPackageChange).toHaveBeenCalledTimes(1);
});

it("does not report errors from superseded or unmounted requests", async () => {
  const oldRequest = deferred<FeishuPackageSummary[]>();
  const newRequest = deferred<FeishuPackageSummary[]>();
  const onError = vi.fn();
  const onPackageChange = vi.fn();
  vi.mocked(listFeishuPackages).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
  const view = render(<FeishuPackageManager refreshKey={0} onError={onError} onPackageChange={onPackageChange} />);
  view.rerender(<FeishuPackageManager refreshKey={1} onError={onError} onPackageChange={onPackageChange} />);
  await act(async () => oldRequest.reject(new Error("stale failure")));
  expect(onError).not.toHaveBeenCalled();
  view.unmount();
  await act(async () => newRequest.resolve([historicalPackage]));
  expect(onPackageChange).not.toHaveBeenCalled();
});

it("preserves edits made while a package refresh is pending", async () => {
  const request = deferred<FeishuPackageSummary[]>();
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([historicalPackage]).mockReturnValueOnce(request.promise);
  const view = render(<FeishuPackageManager refreshKey={0} />);
  await screen.findByDisplayValue("historical prompt");
  view.rerender(<FeishuPackageManager refreshKey={1} />);
  fireEvent.change(screen.getByRole("textbox", { name: "启动 Prompt" }), { target: { value: "typed while refreshing" } });
  await act(async () => request.resolve([{ ...historicalPackage, revision: 19 }]));
  expect(screen.getByDisplayValue("typed while refreshing")).toBeTruthy();
});

it("edits resource groups on the Auto-Cut package", async () => {
  const packageSummary = {
    alias: "Auto-cut-lite",
    name: "Auto-Cut Lite",
    projectId: "auto-cut-lite",
    workspacePath: "D:\\codex\\auto-cut-lite",
    model: "gpt-test",
    reasoningEffort: "medium",
    prompt: "fixture prompt",
    zipSourceDirectory: "D:\\codex\\auto-cut-lite\\zips",
    maxConcurrent: 2,
    resourceGroups: ["剪映主机"],
    state: "draft",
    revision: 3,
    updatedAt: "2026-09-17T00:00:00.000Z",
    identity: {
      displayName: "Auto-cut-lite1.6.9",
      pluginVersion: "1.6.9",
      runtimeVersion: "1.7.0",
      defaultPrompt: "Use the Auto-Cut workflow.",
      alias: "auto-cut-lite-2",
      projectId: "auto-cut-lite-2",
    },
    referenceCount: 0,
    references: [],
  } as unknown as FeishuPackageSummary;
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([packageSummary]);
  vi.mocked(saveFeishuPackageDraft).mockResolvedValueOnce(packageSummary);
  vi.mocked(listFeishuPackages).mockResolvedValueOnce([packageSummary]);

  render(<FeishuPackageManager />);

  const input = await screen.findByRole("textbox", { name: "资源组" }) as HTMLInputElement;
  expect(screen.getAllByText("Auto-cut-lite1.6.9")).toHaveLength(2);
  expect(input.value).toBe("剪映主机");
  fireEvent.change(input, { target: { value: "剪映主机, 音频工作站, 剪映主机" } });
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));

  await waitFor(() => expect(saveFeishuPackageDraft).toHaveBeenCalledWith("Auto-cut-lite", {
    alias: "Auto-cut-lite",
    name: "Auto-Cut Lite",
    projectId: "auto-cut-lite",
    workspacePath: "D:\\codex\\auto-cut-lite",
    model: "gpt-test",
    reasoningEffort: "medium",
    prompt: "fixture prompt",
    zipSourceDirectory: "D:\\codex\\auto-cut-lite\\zips",
    maxConcurrent: 2,
    resourceGroups: ["剪映主机", "音频工作站"],
    expectedRevision: 3,
  }));
});
