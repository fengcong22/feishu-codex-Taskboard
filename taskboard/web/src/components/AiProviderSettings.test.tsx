import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { TaskboardLanguageProvider } from "../i18n";
import type { AiProviderSettings as Settings } from "../types";
import { AiProviderSettings } from "./AiProviderSettings";

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  getAiProviders: vi.fn(), createAiProvider: vi.fn(), updateAiProvider: vi.fn(), deleteAiProvider: vi.fn(),
  activateAiProvider: vi.fn(), importCurrentAiProvider: vi.fn(), testAiProvider: vi.fn(),
}));

const codex = { providerId: "custom", name: "OldRelay", baseUrl: "https://old.example", wireApi: "responses",
  model: "gpt-old", managedByTaskboard: false };
const profile = { id: "11111111-1111-1111-1111-111111111111", name: "主用", baseUrl: "https://new.example/v1",
  wireApi: "responses" as const, model: "gpt-new", vmModel: "gpt-edit", keyHint: "…1234", updatedAt: "2026-11-18T00:00:00.000Z" };
const empty: Settings = { available: true, version: 0, activeId: null, profiles: [], codex };
const withProfile: Settings = { available: true, version: 1, activeId: null, profiles: [profile], codex };

function renderPanel() {
  return render(<TaskboardLanguageProvider language="zh"><AiProviderSettings /></TaskboardLanguageProvider>);
}

describe("AiProviderSettings", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected backend request"); }));
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it("imports the current Codex provider when nothing is saved yet", async () => {
    vi.mocked(api.getAiProviders).mockResolvedValue(empty);
    vi.mocked(api.importCurrentAiProvider).mockResolvedValue(withProfile);
    renderPanel();
    expect(await screen.findByText("OldRelay")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "导入当前 Codex 配置" }));
    await waitFor(() => expect(api.importCurrentAiProvider).toHaveBeenCalledWith(0));
    expect(await screen.findByText("主用")).toBeTruthy();
  });

  it("adds a provider after listing models, and only sends the key it was given", async () => {
    vi.mocked(api.getAiProviders).mockResolvedValue(empty);
    vi.mocked(api.testAiProvider).mockResolvedValue({ ok: true, models: ["gpt-a", "gpt-b"] });
    vi.mocked(api.createAiProvider).mockResolvedValue(withProfile);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "新增接口" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "主用" } });
    fireEvent.change(screen.getByLabelText("接口地址"), { target: { value: "https://new.example/v1" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "测试连接并获取模型" }));
    expect(await screen.findByText("连接成功，可选模型 2 个。")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/日常模型/u), { target: { value: "gpt-a" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.createAiProvider).toHaveBeenCalledWith({ name: "主用", baseUrl: "https://new.example/v1",
      wireApi: "responses", apiKey: "sk-new-secret", model: "gpt-a", vmModel: null, expectedVersion: 0 }));
  });

  it("edits with a blank key to keep the saved one and switches the active provider", async () => {
    vi.mocked(api.getAiProviders).mockResolvedValue(withProfile);
    vi.mocked(api.updateAiProvider).mockResolvedValue(withProfile);
    vi.mocked(api.activateAiProvider).mockResolvedValue({ ...withProfile, version: 2, activeId: profile.id });
    vi.mocked(api.testAiProvider).mockResolvedValue({ ok: false, errorCode: "AI_PROVIDER_FORBIDDEN", status: 403,
      detail: "{\"code\":\"INSUFFICIENT_BALANCE\"}" });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect((screen.getByLabelText("API key") as HTMLInputElement).placeholder).toContain("…1234");
    fireEvent.click(screen.getByRole("button", { name: "测试连接并获取模型" }));
    await waitFor(() => expect(api.testAiProvider).toHaveBeenCalledWith({ id: profile.id, baseUrl: profile.baseUrl, apiKey: "" }));
    expect(await screen.findByText(/余额不足/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.updateAiProvider).toHaveBeenCalledWith(profile.id, expect.objectContaining({ apiKey: "",
      vmModel: "gpt-edit", expectedVersion: 1 })));
    fireEvent.click(await screen.findByRole("button", { name: "设为当前" }));
    await waitFor(() => expect(api.activateAiProvider).toHaveBeenCalledWith(profile.id, 1));
    expect(await screen.findByText("正在使用")).toBeTruthy();
  });
});
