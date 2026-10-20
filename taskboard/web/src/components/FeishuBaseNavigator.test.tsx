import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FeishuBaseNavigator } from "./FeishuBaseNavigator";
import {
  getFeishuBaseSubscription,
  subscribeFeishuBase,
  unsubscribeFeishuBase,
} from "../api";
import { TaskboardLanguageProvider } from "../i18n";
import type { FeishuBaseCatalog } from "../types";

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

function navigator(catalog: FeishuBaseCatalog[] = [base]) {
  return <TaskboardLanguageProvider language="zh">
    <FeishuBaseNavigator
      catalog={catalog}
      selectedSubjectKey={base.subjects[0].subjectKey}
      onAddBase={vi.fn()}
      onSelectSubject={vi.fn()}
      onOpenConfiguration={vi.fn()}
      onToggleSubjectDisplay={vi.fn()}
      onDisableSubject={vi.fn()}
      onRemoveBase={vi.fn()}
      onRemoveSubject={vi.fn()}
    />
  </TaskboardLanguageProvider>;
}

function renderNavigator(catalog: FeishuBaseCatalog[] = [base]) {
  return render(navigator(catalog));
}

describe("FeishuBaseNavigator subscriptions", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(getFeishuBaseSubscription).mockReset();
    vi.mocked(subscribeFeishuBase).mockReset();
    vi.mocked(unsubscribeFeishuBase).mockReset();
  });

  it("shows an active older version alongside an imported draft", () => {
    vi.mocked(getFeishuBaseSubscription).mockResolvedValue({ subscribed: true });
    const catalog: FeishuBaseCatalog[] = [{
      ...base,
      subjects: [{ ...base.subjects[0], lifecycle: "draft", activeConfigVersion: 8 }],
    }];
    renderNavigator(catalog);

    const row = screen.getByRole("button", { name: "已启用学科已启用旧版 · 有草稿" });
    expect(row.getAttribute("title")).toBe("已启用学科 · 已启用旧版 · 有草稿");
  });

  it("counts an active older version when confirming event unsubscription", async () => {
    vi.mocked(getFeishuBaseSubscription).mockResolvedValue({ subscribed: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const catalog: FeishuBaseCatalog[] = [{
      ...base,
      subjects: [{ ...base.subjects[0], lifecycle: "draft", activeConfigVersion: 8 }],
    }];
    renderNavigator(catalog);

    await screen.findByText("事件已订阅");
    fireEvent.click(screen.getByRole("button", { name: "管理 订阅测试表" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "取消订阅" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("已启用学科（已启用学科）"));
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

  it("reads subscription status for collapsed Bases when the catalog arrives after refresh", async () => {
    const secondBase: FeishuBaseCatalog = {
      ...base,
      baseToken: "bas_collapsed",
      baseName: "折叠学科表",
      subjects: [{
        ...base.subjects[0],
        subjectKey: "bas_collapsed:tbl_enabled",
        baseToken: "bas_collapsed",
        baseName: "折叠学科表",
        projectId: "feishu-collapsed",
      }],
    };
    vi.mocked(getFeishuBaseSubscription).mockImplementation(async (baseToken) => ({
      subscribed: baseToken === "bas_subscription",
    }));
    const view = renderNavigator([]);
    view.rerender(navigator([base, secondBase]));

    const collapsedRow = screen.getByRole("button", { name: /^折叠学科表/ });
    expect(collapsedRow.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(collapsedRow.textContent).toContain("事件未订阅"));
    expect(screen.getByRole("button", { name: /订阅测试表.*事件已订阅/ })).toBeTruthy();
    expect(subscribeFeishuBase).not.toHaveBeenCalled();
    expect(unsubscribeFeishuBase).not.toHaveBeenCalled();
  });

  it.each(["outdated state", "failed read"])("keeps a successful subscription when the earlier automatic read returns %s", async (outcome) => {
    let resolveEarlierRead!: (subscription: { subscribed: boolean }) => void;
    let rejectEarlierRead!: (error: Error) => void;
    const earlierRead = new Promise<{ subscribed: boolean }>((resolve, reject) => {
      resolveEarlierRead = resolve;
      rejectEarlierRead = reject;
    });
    vi.mocked(getFeishuBaseSubscription).mockReturnValue(earlierRead);
    vi.mocked(subscribeFeishuBase).mockResolvedValue({ subscribed: true });
    renderNavigator();
    await screen.findByText("读取中");

    fireEvent.click(screen.getByRole("button", { name: "管理 订阅测试表" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "订阅事件" }));
    await screen.findByText("事件已订阅");

    await act(async () => {
      if (outcome === "outdated state") resolveEarlierRead({ subscribed: false });
      else rejectEarlierRead(new Error("Earlier request failed"));
    });
    expect(screen.getByText("事件已订阅")).toBeTruthy();
    expect(screen.queryByText("读取失败")).toBeNull();
    expect(subscribeFeishuBase).toHaveBeenCalledTimes(1);
    expect(unsubscribeFeishuBase).not.toHaveBeenCalled();
  });

  it("reads fresh server state after a remount instead of assuming enabled subjects are subscribed", async () => {
    vi.mocked(getFeishuBaseSubscription).mockResolvedValueOnce({ subscribed: true });
    const first = renderNavigator();
    await waitFor(() => expect(screen.getByText("事件已订阅")).toBeTruthy());
    first.unmount();

    vi.mocked(getFeishuBaseSubscription).mockResolvedValueOnce({ subscribed: false });
    renderNavigator();
    await waitFor(() => expect(screen.getByText("事件未订阅")).toBeTruthy());
    expect(subscribeFeishuBase).not.toHaveBeenCalled();
  });

  it("shows a failed read and lets the user retry without subscribing", async () => {
    vi.mocked(getFeishuBaseSubscription).mockRejectedValueOnce(new Error("Bridge unavailable"));
    renderNavigator();
    await waitFor(() => expect(screen.getByText("读取失败")).toBeTruthy());

    vi.mocked(getFeishuBaseSubscription).mockResolvedValueOnce({ subscribed: true });
    fireEvent.click(screen.getByRole("button", { name: "管理 订阅测试表" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "刷新订阅状态" }));
    await waitFor(() => expect(screen.getByText("事件已订阅")).toBeTruthy());
    expect(subscribeFeishuBase).not.toHaveBeenCalled();
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
