import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as api from "./api";
import type { FeishuWorkflowPanelProps } from "./components/FeishuWorkflowPanel";
import { LocalSettingsDialog } from "./components/LocalSettingsDialog";
import { TaskboardLanguageProvider } from "./i18n";
import { startAutomaticExecutionTestServer } from "../test/automatic-execution-server.mjs";
import type { FeishuBaseCatalog, FeishuSubjectConfig, Project, Task } from "./types";

const realFetch = globalThis.fetch;

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  listProjects: vi.fn(),
  getTaskboardMetadata: vi.fn(),
  getAutomaticExecutionSettings: vi.fn(),
  updateAutomaticExecutionSettings: vi.fn(),
  listDeviceWorkspaces: vi.fn(),
  getBoardStageLabels: vi.fn(),
  getJiraConnection: vi.fn(),
  listTasks: vi.fn(),
  listArchivedTasks: vi.fn(),
  deleteArchivedTask: vi.fn(),
  listArtifactUploads: vi.fn(),
  listTaskArtifactSummaries: vi.fn(),
  getWorkflowWorkspace: vi.fn(),
  listFeishuWorkflowCatalog: vi.fn(),
  getFeishuBaseSubscription: vi.fn(),
  subscribeFeishuBase: vi.fn(),
  unsubscribeFeishuBase: vi.fn(),
  getUnifiedWorkflowViews: vi.fn(),
  getUnifiedWorkflowStageDisplays: vi.fn(),
  listDevelopmentContexts: vi.fn(),
}));

// Keep browser preferences isolated from the server-backed storage adapter.
vi.mock("./storage", () => ({
  PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX: "taskboard.project-board-display-settings.v3.",
  projectBoardDisplaySettingsStorageEntries: () => [],
  refreshProjectBoardDisplaySettingsStorage: async () => {},
  taskboardStorage: {
    getItem: (key: string) => window.localStorage.getItem(key),
    setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
    removeItem: (key: string) => window.localStorage.removeItem(key),
  },
}));

// The destination page is unrelated to project selection; navigation, App state,
// UnifiedWorkflowBoard and TaskCard remain real throughout these regressions.
vi.mock("./components/FeishuPackageManager", () => ({
  FeishuPackageManager: () => <div role="region" aria-label="Package manager" />,
}));

vi.mock("./components/FeishuWorkflowPanel", () => ({
  FeishuWorkflowPanel: ({ selectedSubjectKey, onSelectSubject, onOpenLocalSettings, allowAutomaticExecution }: FeishuWorkflowPanelProps) => (
    <div role="region" aria-label="Subject configuration">
      <button type="button" onClick={() => onSelectSubject(selectedSubjectKey!, true)}>
        Return to subject board
      </button>
      <button type="button" onClick={onOpenLocalSettings}>Manage local automatic editing</button>
      <span>Machine automatic editing: {String(allowAutomaticExecution)}</span>
    </div>
  ),
}));

vi.mock("./components/UnifiedWorkflowStageSettings", () => ({
  UnifiedWorkflowStageSettings: () => <div role="region" aria-label="Stage display settings" />,
}));

const NOW = "2026-09-15T03:00:00.000Z";
let eventSources: EventTarget[] = [];

function subject(key: string, tableName: string): FeishuSubjectConfig {
  return {
    subjectKey: key,
    baseToken: "base-navigation-test",
    baseName: "Navigation test Base",
    tableId: `table-${key}`,
    tableName,
    projectId: `project-${key}`,
    displayEnabled: true,
    lifecycle: "enabled",
    configVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const FIRST_SUBJECT = subject("first", "First subject");
const SECOND_SUBJECT = subject("second", "Second subject");
const SUBJECTS = [FIRST_SUBJECT, SECOND_SUBJECT];
const CATALOG: FeishuBaseCatalog[] = [{
  baseToken: FIRST_SUBJECT.baseToken,
  baseName: FIRST_SUBJECT.baseName,
  sourceUrlLabel: null,
  metadataRefreshedAt: null,
  subjects: SUBJECTS,
  createdAt: NOW,
  updatedAt: NOW,
}];
const PROJECTS: Project[] = SUBJECTS.map((entry) => ({
  id: entry.projectId,
  name: entry.tableName,
  workspacePath: null,
  source: "feishu",
  subjectKey: entry.subjectKey,
  labels: [],
  issueCount: 1,
  archivedIssueCount: 0,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
}));

function task(entry: FeishuSubjectConfig): Task {
  return {
    id: `task-${entry.subjectKey}`,
    identifier: `NAV-${entry.subjectKey}`,
    projectId: entry.projectId,
    title: `${entry.tableName} task card`,
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    sortOrder: 0,
    threadId: null,
    threadBinding: null,
    legacyLocalThreadId: null,
    conversationRefs: [],
    participants: [],
    previewImage: null,
    activityKey: `activity-${entry.subjectKey}`,
    activityUpdatedAt: NOW,
    creatorType: "user",
    creatorId: "test-user",
    creatorName: "Test user",
    creatorAvatarUrl: null,
    assignee: { type: "user", id: "test-user", name: "Test user", avatarUrl: null },
    workflowId: null,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    source: "local",
    externalUrl: null,
    archivedAt: null,
    relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    feishuOrigin: {
      version: 1,
      source: "feishu-base",
      eventId: `event-${entry.subjectKey}`,
      baseToken: entry.baseToken,
      tableId: entry.tableId,
      recordId: `record-${entry.subjectKey}`,
      subjectKey: entry.subjectKey,
      stageId: "initial",
      executionMode: "manual",
    },
  };
}

const FIRST_TASK = task(FIRST_SUBJECT);
const SECOND_TASK = task(SECOND_SUBJECT);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function subjectButton(entry: FeishuSubjectConfig) {
  return screen.getByTitle(`${entry.tableName} · Enabled`);
}

function openFirstSubjectConfiguration() {
  fireEvent.click(screen.getByRole("button", { name: "Manage First subject" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Configure" }));
  expect(screen.getByRole("region", { name: "Subject configuration" })).toBeTruthy();
}

async function renderFirstSubject() {
  render(<App />);
  await waitFor(() => expect(subjectButton(FIRST_SUBJECT).getAttribute("aria-current")).toBe("page"));
  // Let catalog initialization settle before exercising an already-selected scope.
  await act(async () => {});
}

describe("App project navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", `/?project=${FIRST_SUBJECT.projectId}&lang=en`);
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    eventSources = [];
    vi.stubGlobal("EventSource", class extends EventTarget {
      constructor() { super(); eventSources.push(this); }
      close() {}
    });
    // No test is allowed to reach the running Bridge or Taskboard services.
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected backend request"); }));

    vi.mocked(api.listProjects).mockResolvedValue(PROJECTS);
    vi.mocked(api.getTaskboardMetadata).mockResolvedValue({ capabilities: { localAiChat: false, automaticExecution: false } });
    vi.mocked(api.getAutomaticExecutionSettings).mockResolvedValue({ enabled: false, version: 1 });
    vi.mocked(api.updateAutomaticExecutionSettings).mockResolvedValue({ enabled: true, version: 2 });
    vi.mocked(api.listDeviceWorkspaces).mockResolvedValue({});
    const labels = {
      backlog: "Backlog", todo: "Ready", queued: "Queued", in_progress: "Processing",
      in_review: "Review", blocked: "Blocked", done: "Done", canceled: "Canceled",
    };
    vi.mocked(api.getBoardStageLabels).mockResolvedValue({ version: 1, labels: { zh: labels, en: labels } });
    vi.mocked(api.getJiraConnection).mockResolvedValue({
      configured: false, baseUrl: null, username: null, displayName: null,
      projects: [], projectId: "jira", lastSyncedAt: null, insecureHttp: false,
    });
    vi.mocked(api.listTasks).mockImplementation(async (projectId) => (
      [FIRST_TASK, SECOND_TASK].filter((entry) => entry.projectId === projectId)
    ));
    vi.mocked(api.listArchivedTasks).mockResolvedValue([]);
    vi.mocked(api.listArtifactUploads).mockResolvedValue([]);
    vi.mocked(api.listTaskArtifactSummaries).mockResolvedValue([]);
    vi.mocked(api.getWorkflowWorkspace).mockImplementation(async (projectId) => ({
      projectId, workspace: null, version: 1, updatedAt: NOW,
    }));
    vi.mocked(api.listFeishuWorkflowCatalog).mockResolvedValue(CATALOG);
    vi.mocked(api.getFeishuBaseSubscription).mockResolvedValue({ subscribed: false });
    vi.mocked(api.subscribeFeishuBase).mockResolvedValue({ subscribed: true });
    vi.mocked(api.unsubscribeFeishuBase).mockResolvedValue({ subscribed: false });
    vi.mocked(api.getUnifiedWorkflowViews).mockImplementation(async (subjectKey) => ({
      schemaVersion: 1, subjectKey, revision: 1, defaultViewId: "all", activeViewId: "all",
      views: [{
        id: "all", subjectKey, name: "All stages", stageIds: ["todo", "in_progress"],
        isSystem: true, revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
      readOnly: false,
    }));
    vi.mocked(api.getUnifiedWorkflowStageDisplays).mockResolvedValue([]);
    vi.mocked(api.listDevelopmentContexts).mockResolvedValue({ workspacePath: null, contexts: [] });
  });

  afterEach(() => {
    cleanup();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("keeps task cards when returning from Auto-Cut packages to the same sidebar subject", async () => {
    await renderFirstSubject();
    expect(await screen.findByText(FIRST_TASK.title)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Auto-Cut packages" }));
    expect(screen.getByRole("region", { name: "Package manager" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Board stage labels" })).toBeNull();
    expect(screen.queryByText(FIRST_TASK.title)).toBeNull();

    fireEvent.click(subjectButton(FIRST_SUBJECT));
    expect(await screen.findByText(FIRST_TASK.title)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Package manager" })).toBeNull();
  });

  it("saves the machine switch only after the server confirms and refreshes it when reopened", async () => {
    const saved = deferred<{ enabled: boolean; version: number }>();
    vi.mocked(api.updateAutomaticExecutionSettings).mockReturnValueOnce(saved.promise);
    await renderFirstSubject();
    fireEvent.click(screen.getByRole("button", { name: "Local settings" }));
    const dialog = screen.getByRole("dialog", { name: "Local settings" });
    const toggle = await within(dialog).findByRole("switch", { name: "Allow automatic editing on this device" });
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getByText(/all subjects on this device/)).toBeTruthy();
    expect(within(dialog).getByText(/Running tasks will continue/)).toBeTruthy();
    expect(within(dialog).getByText(/historical tasks/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(api.updateAutomaticExecutionSettings).toHaveBeenCalledWith({ enabled: true, expectedVersion: 1 });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    await act(async () => saved.resolve({ enabled: true, version: 2 }));
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    openFirstSubjectConfiguration();
    expect(screen.getByText("Machine automatic editing: true")).toBeTruthy();
    vi.mocked(api.getAutomaticExecutionSettings).mockResolvedValue({ enabled: false, version: 3 });
    fireEvent.click(screen.getByRole("button", { name: "Manage local automatic editing" }));
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(false));
    expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(false);
  });

  it("opens machine settings from the workspace header with real local server metadata", async () => {
    const server = await startAutomaticExecutionTestServer();
    try {
      const metadata = await realFetch(new URL("api/meta", server.baseUrl)).then(response => response.json());
      // Use the actual HTTP metadata contract; keep unrelated AI network work disabled.
      vi.mocked(api.getTaskboardMetadata).mockResolvedValue({ ...metadata, capabilities: { ...metadata.capabilities, localAiChat: false } });
    } finally {
      await server.close();
    }
    await renderFirstSubject();
    const header = document.querySelector(".workspace-header") as HTMLElement;
    fireEvent.click(within(header).getByRole("button", { name: "Local settings" }));
    expect(await screen.findByRole("dialog", { name: "Local settings" })).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    openFirstSubjectConfiguration();
    fireEvent.click(screen.getByRole("button", { name: "Manage local automatic editing" }));
    expect(await screen.findByRole("dialog", { name: "Local settings" })).toBeTruthy();
    await act(async () => {});
  });

  it("refreshes after a conflicting update without reporting the attempted change as saved", async () => {
    vi.mocked(api.getAutomaticExecutionSettings)
      .mockResolvedValueOnce({ enabled: false, version: 1 })
      .mockResolvedValue({ enabled: false, version: 3 });
    vi.mocked(api.updateAutomaticExecutionSettings).mockRejectedValueOnce(new api.ApiError(409, {
      error: { code: "VERSION_CONFLICT", message: "Conflict" },
    }));
    await renderFirstSubject();
    fireEvent.click(screen.getByRole("button", { name: "Local settings" }));
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This setting changed elsewhere. The current value has been loaded; review it before trying again.");
    expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("switch"));
    expect(api.updateAutomaticExecutionSettings).toHaveBeenLastCalledWith({ enabled: true, expectedVersion: 3 });
    await act(async () => {});
  });

  it("shows a failed save and keeps the confirmed value", async () => {
    vi.mocked(api.updateAutomaticExecutionSettings).mockRejectedValueOnce(new Error("Service unavailable"));
    await renderFirstSubject();
    fireEvent.click(screen.getByRole("button", { name: "Local settings" }));
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not save the setting. Service unavailable");
    expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(false);
  });

  it("turns the machine switch off and preserves subject navigation", async () => {
    vi.mocked(api.getAutomaticExecutionSettings).mockResolvedValue({ enabled: true, version: 6 });
    vi.mocked(api.updateAutomaticExecutionSettings).mockResolvedValue({ enabled: false, version: 7 });
    await renderFirstSubject();
    screen.getByRole("button", { name: "Local settings" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Local settings" }));
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(false));
    expect(api.updateAutomaticExecutionSettings).toHaveBeenCalledWith({ enabled: false, expectedVersion: 6 });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(subjectButton(FIRST_SUBJECT).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Local settings" })).toBe(document.activeElement);
  });

  it("keeps the switch disabled after a read error until retry succeeds", async () => {
    vi.mocked(api.getAutomaticExecutionSettings).mockRejectedValueOnce(new Error("Offline"));
    await renderFirstSubject();
    fireEvent.click(screen.getByRole("button", { name: "Local settings" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not read the setting. Offline");
    expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(false));
    expect(api.updateAutomaticExecutionSettings).not.toHaveBeenCalled();
  });

  it("refreshes an open settings dialog after another tab changes the switch", async () => {
    await renderFirstSubject();
    fireEvent.click(screen.getByRole("button", { name: "Local settings" }));
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(false));
    vi.mocked(api.getAutomaticExecutionSettings).mockResolvedValue({ enabled: true, version: 2 });
    await act(async () => {
      eventSources.at(-1)!.dispatchEvent(new MessageEvent("automatic-execution.updated", { data: "{}" }));
    });
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(true));
    expect(api.updateAutomaticExecutionSettings).not.toHaveBeenCalled();
  });

  it("keeps a conflict explanation when a simultaneous server event triggers a refresh", async () => {
    let rejectSave!: (error: Error) => void;
    vi.mocked(api.updateAutomaticExecutionSettings).mockReturnValueOnce(new Promise((_, reject) => { rejectSave = reject; }));
    await renderFirstSubject();
    fireEvent.click(screen.getByRole("button", { name: "Local settings" }));
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("switch"));
    await act(async () => {
      eventSources.at(-1)!.dispatchEvent(new MessageEvent("automatic-execution.updated", { data: "{}" }));
    });
    await act(async () => rejectSave(new api.ApiError(409, { error: { code: "VERSION_CONFLICT" } })));
    expect(screen.getByRole("alert").textContent).toContain("changed elsewhere");
    expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(false);
  });

  it("does not expose machine settings in cloud mode", async () => {
    vi.mocked(api.getTaskboardMetadata).mockResolvedValue({ mode: "cloud", capabilities: { localAiChat: false } });
    await renderFirstSubject();
    expect(screen.queryByRole("button", { name: "Local settings" })).toBeNull();
  });

  it("finishes saving when the host changes the interface language", async () => {
    const pending = deferred<{ enabled: boolean; version: number }>();
    vi.mocked(api.updateAutomaticExecutionSettings).mockReturnValueOnce(pending.promise);
    const onSettingsChange = vi.fn();
    const view = (language: "zh" | "en") => <TaskboardLanguageProvider language={language}>
      <LocalSettingsDialog revision={0} onSettingsChange={onSettingsChange} onClose={vi.fn()} />
    </TaskboardLanguageProvider>;
    const { rerender } = render(view("en"));
    await waitFor(() => expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("switch"));
    rerender(view("zh"));
    vi.mocked(api.getAutomaticExecutionSettings).mockResolvedValue({ enabled: true, version: 2 });
    await act(async () => pending.resolve({ enabled: true, version: 2 }));
    expect((screen.getByRole("switch", { name: "允许本机自动剪辑" }) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(true);
  });

  it("keeps task cards when the current sidebar subject is clicked repeatedly", async () => {
    await renderFirstSubject();
    expect(await screen.findByText(FIRST_TASK.title)).toBeTruthy();

    fireEvent.click(subjectButton(FIRST_SUBJECT));
    fireEvent.click(subjectButton(FIRST_SUBJECT));

    expect(await screen.findByText(FIRST_TASK.title)).toBeTruthy();
  });

  it("loads the correct cards when switching to another project and back", async () => {
    await renderFirstSubject();
    expect(await screen.findByText(FIRST_TASK.title)).toBeTruthy();

    fireEvent.click(subjectButton(SECOND_SUBJECT));
    expect(await screen.findByText(SECOND_TASK.title)).toBeTruthy();
    expect(screen.queryByText(FIRST_TASK.title)).toBeNull();

    fireEvent.click(subjectButton(FIRST_SUBJECT));
    expect(await screen.findByText(FIRST_TASK.title)).toBeTruthy();
    expect(screen.queryByText(SECOND_TASK.title)).toBeNull();
  });

  it("keeps task cards when returning from the same subject configuration", async () => {
    await renderFirstSubject();
    expect(await screen.findByText(FIRST_TASK.title)).toBeTruthy();

    openFirstSubjectConfiguration();
    fireEvent.click(screen.getByRole("button", { name: "Return to subject board" }));

    expect(await screen.findByText(FIRST_TASK.title)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Subject configuration" })).toBeNull();
  });

  it("does not mount stage name and description editing in subject configuration", async () => {
    await renderFirstSubject();

    openFirstSubjectConfiguration();

    await waitFor(() => expect(api.getUnifiedWorkflowStageDisplays).toHaveBeenCalled());
    await act(async () => {});
    await waitFor(() => expect(screen.queryByRole("region", { name: "Stage display settings" })).toBeNull());
  });

  it.each(["packages", "configuration", "current subject"])(
    "accepts the pending task response after same-scope navigation through %s",
    async (destination) => {
      const pending = deferred<Task[]>();
      vi.mocked(api.listTasks).mockImplementation((projectId) => (
        projectId === FIRST_SUBJECT.projectId ? pending.promise : Promise.resolve([])
      ));
      await renderFirstSubject();

      if (destination === "configuration") {
        openFirstSubjectConfiguration();
        fireEvent.click(screen.getByRole("button", { name: "Return to subject board" }));
      } else {
        if (destination === "packages") {
          fireEvent.click(screen.getByRole("button", { name: "Auto-Cut packages" }));
        }
        fireEvent.click(subjectButton(FIRST_SUBJECT));
      }
      await act(async () => { pending.resolve([FIRST_TASK]); });

      expect(await screen.findByText(FIRST_TASK.title)).toBeTruthy();
    },
  );

  it("ignores an old project response after another subject has loaded", async () => {
    const pending = deferred<Task[]>();
    vi.mocked(api.listTasks).mockImplementation((projectId) => (
      projectId === FIRST_SUBJECT.projectId
        ? pending.promise
        : Promise.resolve(projectId === SECOND_SUBJECT.projectId ? [SECOND_TASK] : [])
    ));
    await renderFirstSubject();
    fireEvent.click(subjectButton(SECOND_SUBJECT));
    expect(await screen.findByText(SECOND_TASK.title)).toBeTruthy();

    await act(async () => { pending.resolve([FIRST_TASK]); });

    expect(screen.getByText(SECOND_TASK.title)).toBeTruthy();
    expect(screen.queryByText(FIRST_TASK.title)).toBeNull();
  });

  it.each([
    ["TASK_EXECUTION_ACTIVE", "This issue still has a pending or running execution. Wait for it to finish or stop it before deleting."],
    ["ARTIFACT_UPLOAD_ACTIVE", "This issue has a queued or running ZIP upload. Wait for the upload to finish before deleting."],
    ["FEISHU_DELETE_ORIGIN_INVALID", "The stored Feishu source identity is invalid. Ask a maintainer to repair it before deleting."],
  ])("explains %s in the archived task deletion dialog", async (code, message) => {
    const archived = { ...FIRST_TASK, archivedAt: NOW };
    vi.mocked(api.listTasks).mockResolvedValue([]);
    vi.mocked(api.listArchivedTasks).mockResolvedValue([archived]);
    vi.mocked(api.deleteArchivedTask).mockRejectedValue(new api.ApiError(409, {
      error: { code, message: "Internal technical rejection" },
    }));
    await renderFirstSubject();
    fireEvent.click(screen.getByRole("button", { name: "Open other issues" }));
    fireEvent.click(await screen.findByRole("tab", { name: /Archived/ }));
    fireEvent.click(await screen.findByRole("button", { name: `Permanently delete ${archived.identifier}` }));
    const dialog = screen.getByRole("alertdialog");
    expect(api.deleteArchivedTask).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    expect(await within(dialog).findByText(message)).toBeTruthy();
    expect(screen.getByText(archived.title)).toBeTruthy();
    expect(api.deleteArchivedTask).toHaveBeenCalledWith(archived);
  });

  it("deletes an archived Feishu card only after confirmation", async () => {
    const archived = { ...FIRST_TASK, archivedAt: NOW };
    vi.mocked(api.listTasks).mockResolvedValue([]);
    vi.mocked(api.listArchivedTasks).mockResolvedValue([archived]);
    vi.mocked(api.deleteArchivedTask).mockResolvedValue(undefined);
    await renderFirstSubject();
    fireEvent.click(screen.getByRole("button", { name: "Open other issues" }));
    fireEvent.click(await screen.findByRole("tab", { name: /Archived/ }));
    fireEvent.click(await screen.findByRole("button", { name: `Permanently delete ${archived.identifier}` }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/Workspace source files and files already uploaded will be kept/)).toBeTruthy();
    expect(api.deleteArchivedTask).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByText(archived.title)).toBeNull();
    expect(api.deleteArchivedTask).toHaveBeenCalledOnce();
  });
});

describe("Automatic execution settings API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the setting and writes a versioned update with the local web client header", async () => {
    const actualApi = await vi.importActual<typeof import("./api")>("./api");
    const setting = { enabled: true, version: 8 };
    const fetchRequest = vi.fn(async () => new Response(JSON.stringify({ setting }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchRequest);
    expect(await actualApi.getAutomaticExecutionSettings()).toEqual(setting);
    expect(await actualApi.updateAutomaticExecutionSettings({ enabled: true, expectedVersion: 7 })).toEqual(setting);
    const calls = fetchRequest.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(new URL(calls[0][0]).pathname).toBe("/api/local/settings/automatic-execution");
    expect(new URL(calls[1][0]).pathname).toBe("/api/local/settings/automatic-execution");
    expect(calls[1][1].method).toBe("PUT");
    expect(new Headers(calls[1][1].headers).get("X-Taskboard-Client")).toBe("web");
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ enabled: true, expectedVersion: 7 });
  });

  it("round trips the web API through an isolated Taskboard server", async () => {
    const actualApi = await vi.importActual<typeof import("./api")>("./api");
    const server = await startAutomaticExecutionTestServer();
    const base = document.createElement("base");
    try {
      base.href = server.baseUrl;
      document.head.prepend(base);
      expect(await actualApi.getAutomaticExecutionSettings()).toEqual({ enabled: false, version: 1 });
      expect(await actualApi.updateAutomaticExecutionSettings({ enabled: true, expectedVersion: 1 })).toEqual({ enabled: true, version: 2 });
      expect((await actualApi.getTaskboardMetadata()).capabilities?.automaticExecution).toBe(true);
      await expect(actualApi.updateAutomaticExecutionSettings({ enabled: false, expectedVersion: 1 })).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
      expect(await actualApi.getAutomaticExecutionSettings()).toEqual({ enabled: true, version: 2 });
      expect(await actualApi.updateAutomaticExecutionSettings({ enabled: false, expectedVersion: 2 })).toEqual({ enabled: false, version: 3 });
    } finally {
      base.remove();
      await server.close();
    }
  });

});
