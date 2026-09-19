import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FeishuBaseNavigator } from "./FeishuBaseNavigator";
import {
  getFeishuBaseSubscription,
  subscribeFeishuBase,
  unsubscribeFeishuBase,
} from "../api";
import { TaskboardLanguageProvider } from "../i18n";

vi.mock("../api", () => ({
  getFeishuBaseSubscription: vi.fn(),
  subscribeFeishuBase: vi.fn(),
  unsubscribeFeishuBase: vi.fn(),
}));

const base = {
  baseToken: "bas_subscription",
  baseName: "订阅测试表",
  sourceUrlLabel: null,
  metadataRefreshedAt: null,
  createdAt: "2026-09-19T00:00:00.000Z",
  updatedAt: "2026-09-19T00:00:00.000Z",
  subjects: [
    {
      subjectKey: "bas_subscription:tbl_enabled",
      baseToken: "bas_subscription",
      baseName: "订阅测试表",
      tableId: "tbl_enabled",
      tableName: "已启用学科",
      projectId: "feishu-enabled",
      displayEnabled: true,
      lifecycle: "enabled" as const,
      configVersion: 1,
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    },
  ],
};

function renderNavigator() {
  return render(<TaskboardLanguageProvider language="zh">
    <FeishuBaseNavigator
      catalog={[base]}
      selectedSubjectKey={base.subjects[0].subjectKey}
      onAddBase={vi.fn()}
      onSelectSubject={vi.fn()}
      onOpenConfiguration={vi.fn()}
      onToggleSubjectDisplay={vi.fn()}
      onDisableSubject={vi.fn()}
      onRemoveBase={vi.fn()}
      onRemoveSubject={vi.fn()}
    />
  </TaskboardLanguageProvider>);
}

describe("FeishuBaseNavigator subscriptions", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(getFeishuBaseSubscription).mockReset();
    vi.mocked(subscribeFeishuBase).mockReset();
    vi.mocked(unsubscribeFeishuBase).mockReset();
  });

  it("loads an unsubscribed Base and updates the visible state after subscribing", async () => {
    vi.mocked(getFeishuBaseSubscription).mockResolvedValue({ subscribed: false });
    vi.mocked(subscribeFeishuBase).mockResolvedValue({ subscribed: true });
    renderNavigator();

    await waitFor(() => expect(screen.getByText("事件未订阅")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "管理 订阅测试表" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "订阅事件" }));

    await waitFor(() => expect(subscribeFeishuBase).toHaveBeenCalledWith("bas_subscription"));
    await waitFor(() => expect(screen.getByText("事件已订阅")).toBeTruthy());
  });

  it("requires confirmation before cancellation and identifies enabled subjects", async () => {
    vi.mocked(getFeishuBaseSubscription).mockResolvedValue({ subscribed: true });
    vi.mocked(unsubscribeFeishuBase).mockResolvedValue({ subscribed: false });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderNavigator();

    await waitFor(() => expect(screen.getByText("事件已订阅")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "管理 订阅测试表" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "取消订阅" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("已启用学科"));
    expect(unsubscribeFeishuBase).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "管理 订阅测试表" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "取消订阅" }));
    await waitFor(() => expect(unsubscribeFeishuBase).toHaveBeenCalledWith("bas_subscription"));
    await waitFor(() => expect(screen.getByText("事件未订阅")).toBeTruthy());
  });
});
