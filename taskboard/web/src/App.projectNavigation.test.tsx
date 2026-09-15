import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as api from "./api";
import type { FeishuWorkflowPanelProps } from "./components/FeishuWorkflowPanel";
import type { FeishuBaseCatalog, FeishuSubjectConfig, Project, Task } from "./types";

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  listProjects: vi.fn(),
  getTaskboardMetadata: vi.fn(),
  listDeviceWorkspaces: vi.fn(),
  getBoardStageLabels: vi.fn(),
  getJiraConnection: vi.fn(),
  listTasks: vi.fn(),
  listArchivedTasks: vi.fn(),
  listArtifactUploads: vi.fn(),
  listTaskArtifactSummaries: vi.fn(),
  getWorkflowWorkspace: vi.fn(),
  listFeishuWorkflowCatalog: vi.fn(),
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
  FeishuWorkflowPanel: ({ selectedSubjectKey, onSelectSubject }: FeishuWorkflowPanelProps) => (
    <div role="region" aria-label="Subject configuration">
      <button type="button" onClick={() => onSelectSubject(selectedSubjectKey!, true)}>
        Return to subject board
      </button>
    </div>
  ),
}));

const NOW = "2026-09-15T03:00:00.000Z";

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
    vi.stubGlobal("EventSource", class {
      addEventListener() {}
      removeEventListener() {}
      close() {}
    });
    // No test is allowed to reach the running Bridge or Taskboard services.
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected backend request"); }));

    vi.mocked(api.listProjects).mockResolvedValue(PROJECTS);
    vi.mocked(api.getTaskboardMetadata).mockResolvedValue({ mode: "local", capabilities: { localAiChat: false } });
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
    expect(screen.queryByText(FIRST_TASK.title)).toBeNull();

    fireEvent.click(subjectButton(FIRST_SUBJECT));
    expect(await screen.findByText(FIRST_TASK.title)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Package manager" })).toBeNull();
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
});
