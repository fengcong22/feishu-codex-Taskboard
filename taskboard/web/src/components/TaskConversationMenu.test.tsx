import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskboardLanguageProvider, type TaskboardLanguage } from "../i18n";
import { taskConversations } from "../taskConversations";
import type { AiChatRunStatus, AiChatThread, Task, TaskConversationRef } from "../types";
import { TaskConversationMenu } from "./TaskConversationMenu";

const UPDATED_AT = "2026-10-14T09:36:18.000Z";
const TASK = {
  id: "task-21", projectId: "example-project", title: "Example edit", identifier: "FEI-21",
  conversationRefs: [],
} as unknown as Task;

function legacyRef(threadId: string): TaskConversationRef {
  return { threadId, legacyLocal: true, source: "task", sourceId: TASK.id, title: TASK.title, updatedAt: UPDATED_AT };
}

function thread(id: string, status: AiChatRunStatus | null = "completed"): AiChatThread {
  const run = status ? { id: `run-${id}`, threadId: id, status, startedAt: UPDATED_AT } : null;
  return {
    id, title: `Edit ${id}`, model: "local-autocut", codexThreadId: null,
    status: status === "running" ? "running" : status === "failed" ? "failed" : "idle",
    origin: { projectId: TASK.projectId, projectName: "Example", workspacePath: "D:/example", issueId: TASK.id },
    reasoningEffort: "none", sandbox: "workspace-write", createdAt: UPDATED_AT, updatedAt: UPDATED_AT,
    currentRun: status === "running" ? run : null,
    latestRun: run,
  };
}

afterEach(cleanup);

describe("task conversation identities", () => {
  it("projects three local edit records without a false native entry for the task's local thread ID", () => {
    const threads = [thread("edit-1"), thread("edit-2", "failed"), thread("edit-3", "failed")];
    const conversations = taskConversations({ ...TASK, conversationRefs: [legacyRef("edit-1")] }, threads);
    expect(conversations).toHaveLength(3);
    expect(conversations.map((item) => item.aiThreadId).sort()).toEqual(threads.map((item) => item.id));
    for (const item of conversations) {
      expect(item.kind).toBe("local-ai");
      expect(item.source).toBe("autocut");
      expect(item.nativeThreadId).toBeNull();
      expect(item.legacyLocalThreadId).toBeNull();
    }
  });

  it.each(["other-project", "other-task"])("does not suppress a legacy Codex reference using a thread from %s", (scope) => {
    const unrelated = thread("legacy-codex");
    if (scope === "other-project") unrelated.origin.projectId = "another-project";
    else unrelated.origin.issueId = "another-task";
    const conversations = taskConversations({ ...TASK, conversationRefs: [legacyRef(unrelated.id)] }, [unrelated]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].kind).toBe("native");
    expect(conversations[0].legacyLocalThreadId).toBe(unrelated.id);
  });

  it("keeps genuine task/comment conversations and merges a built-in AI chat by its actual Codex ID", () => {
    const binding = {
      threadId: "local:native-1", codexProjectId: "codex-project", codexProjectKind: "local" as const,
      codexHostId: "local-host", workspacePath: "D:/example",
    };
    const ai = { ...thread("ai-1"), model: "gpt-test", codexThreadId: "native-1" };
    const conversations = taskConversations({ ...TASK, conversationRefs: [
      { ...binding, source: "comment", sourceId: "comment-1", title: "Native comment", updatedAt: UPDATED_AT },
      legacyRef("legacy-native"),
      legacyRef(ai.id),
    ] }, [ai]);
    expect(conversations).toHaveLength(2);
    expect(conversations.find((item) => item.aiThreadId === ai.id)).toMatchObject({
      kind: "local-ai", source: "local-ai", nativeThreadId: binding.threadId, threadBinding: binding,
    });
    expect(conversations.find((item) => item.kind === "native")?.legacyLocalThreadId).toBe("legacy-native");
  });

  it("does not discard an explicit native binding whose ID happens to equal a local ID", () => {
    const local = thread("coinciding-id");
    const conversations = taskConversations({ ...TASK, conversationRefs: [{
      ...legacyRef(local.id), legacyLocal: false, codexProjectId: "native-project", codexProjectKind: "local",
      codexHostId: "host", workspacePath: "D:/native",
    }] }, [local]);
    expect(conversations.map((item) => item.kind).sort()).toEqual(["local-ai", "native"]);
  });
});

describe("task conversation menu", () => {
  function show(threads: AiChatThread[], language: TaskboardLanguage = "zh") {
    const onOpen = vi.fn();
    const conversations = taskConversations({ ...TASK, conversationRefs: [legacyRef(threads[0].id)] }, threads);
    render(<TaskboardLanguageProvider language={language}>
      <TaskConversationMenu conversations={conversations} onOpenConversation={onOpen} />
    </TaskboardLanguageProvider>);
    fireEvent.click(screen.getByRole("button"));
    return { onOpen, conversations };
  }

  it("labels all three editing records and opens the selected local log", () => {
    const { onOpen } = show([thread("edit-1"), thread("edit-2", "failed"), thread("edit-3", "failed")]);
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    expect(screen.getAllByText("剪辑运行记录")).toHaveLength(3);
    expect(screen.queryByText("任务对话")).toBeNull();
    expect(screen.getAllByText("已失败")).toHaveLength(2);
    expect(screen.getByText("已完成")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /Edit edit-2/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: "local-ai", aiThreadId: "edit-2" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each([
    ["completed", "已完成", "Completed"],
    ["failed", "已失败", "Failed"],
    ["interrupted", "已中断", "Interrupted"],
    ["running", "正在处理", "Processing"],
    [null, "尚未运行", "Not started"],
  ] as const)("shows the recorded %s result in both languages", (status, chinese, english) => {
    for (const [language, expected] of [["zh", chinese], ["en", english]] as const) {
      show([thread("selected", status), thread("other")], language);
      const item = screen.getByRole("menuitem", { name: /Edit selected/ });
      expect(within(item).getByText(expected)).toBeTruthy();
      expect(item.querySelector(".is-running") !== null).toBe(status === "running");
      cleanup();
    }
  });

  it("keeps built-in AI chats distinct and shows active progress before the previous failed run", () => {
    const ai = { ...thread("ai", "running"), model: "gpt-test", latestRun: thread("ai", "failed").latestRun,
      latestTodo: { completed: 2, total: 5, eventId: "todo", updatedAt: UPDATED_AT } };
    show([ai, thread("edit-1")]);
    const item = screen.getByRole("menuitem", { name: /Edit ai/ });
    expect(within(item).getByText("内置 AI")).toBeTruthy();
    expect(within(item).getByText("2/5")).toBeTruthy();
    expect(within(item).queryByText("已失败")).toBeNull();
    expect(screen.getAllByRole("menuitem")[0]).toBe(item);
  });
});
