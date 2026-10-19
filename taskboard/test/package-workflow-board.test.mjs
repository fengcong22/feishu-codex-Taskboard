import assert from "node:assert/strict";
import { test } from "node:test";
import {
  packageBoardChoices,
  projectVmPackageBoard,
  scopedPackageTasks,
} from "../web/src/packageWorkflowBoard.mjs";

const scope = { subjectKey: "base:table", packageAlias: "slicing" };
function task(id, overrides = {}) {
  return {
    id,
    title: id,
    status: "in_review",
    archivedAt: null,
    createdAt: `2026-10-19T00:00:0${id.slice(-1)}Z`,
    feishuOrigin: {
      source: "feishu-base",
      subjectKey: scope.subjectKey,
      packageAlias: "slicing",
      recordId: "record",
    },
    feishuPackageSnapshot: {
      workflowTemplate: { id: "vm_pmo_review_video", version: 1 },
    },
    ...overrides,
  };
}
function status(taskId, state, extra = {}) {
  return {
    taskId,
    runId: `run-${taskId}`,
    state,
    approvalStatus: "ready",
    writeback: {
      processing: { state: "succeeded" },
      completed: { state: "succeeded" },
    },
    ...extra,
  };
}
function project(tasks, evidence) {
  return projectVmPackageBoard(tasks, { ...scope, tasks: evidence }, scope);
}

test("package task scope uses saved origin, subject and workflow, never labels", () => {
  const valid = task("task-1");
  assert.deepEqual(
    scopedPackageTasks(
      [
        valid,
        task("task-2", {
          feishuOrigin: { ...valid.feishuOrigin, packageAlias: "lite" },
        }),
        task("task-3", {
          feishuOrigin: { ...valid.feishuOrigin, subjectKey: "other:table" },
        }),
        task("task-4", { feishuOrigin: null, labels: ["slicing"] }),
        task("task-5", { archivedAt: "2026-10-19" }),
      ],
      scope,
    ).map((t) => t.id),
    [valid.id],
  );
});

test("package choices retain saved historical identity rather than relabeling a task", () => {
  const choices = packageBoardChoices(
    [
      {
        alias: "lite",
        name: "Lite",
        workflowTemplate: { id: "document_draft_zip", version: 1 },
      },
    ],
    [task("task-1")],
    "lite",
  );
  assert.deepEqual(
    choices.map((item) => [item.alias, item.workflowTemplate.id]),
    [
      ["lite", "document_draft_zip"],
      ["slicing", "vm_pmo_review_video"],
    ],
  );
  assert.equal(choices[1].historical, true);
});

test("VM lifecycle uses run evidence and never requires a local acceptance click", () => {
  const cases = [
    ["waiting_materials", "materials"],
    ["planning", "editing"],
    ["rendering", "editing"],
    ["rendered", "feishu_delivery"],
    ["delivery_pending", "feishu_delivery"],
    ["completed", "awaiting_feishu_review"],
    ["blocked", "needs_attention"],
    ["needs_attention", "needs_attention"],
  ];
  for (const [state, stage] of cases) {
    const result = project([task("task-1")], [status("task-1", state)]);
    assert.deepEqual(
      result.groups[stage].map((item) => item.task.id),
      ["task-1"],
      state,
    );
    assert.equal(
      result.groups.completed.length,
      0,
      "only NAS publication completes business workflow",
    );
  }
});

test("slot waiting stays queued even if preparation has not started", () => {
  const result = project(
    [task("task-1", { status: "queued" })],
    [status("task-1", "ready")],
  );
  assert.equal(result.groups.queued.length, 1);
});

test("trusted slot-wait evidence stays queued without changing generic task status", () => {
  const result = project(
    [task("task-1", { status: "todo" })],
    [status("task-1", "prepared", { waitingForSlot: true })],
  );
  assert.equal(result.groups.queued.length, 1);
});

test("approval failures need attention while ordinary approval waits remain materials", () => {
  for (const approvalStatus of ["auth_required", "needs_attention", "dead_letter", "rejected", "canceled"]) {
    const result = project([task("task-1")], [status("task-1", "waiting_materials", { approvalStatus })]);
    assert.equal(result.groups.needs_attention.length, 1, approvalStatus);
  }
});

test("backlog and canceled cards belong only to the secondary task panel", () => {
  const result = project(
    [task("task-1", { status: "canceled" }), task("task-2", { status: "backlog" })],
    [status("task-1", "completed"), status("task-2", "ready")],
  );
  assert.equal(Object.values(result.groups).flat().length, 0);
  assert.equal(result.history.length, 0);
});

test("unconfirmed progress writeback stays visible and failed writeback needs attention", () => {
  for (const [state, stage] of [
    ["pending", "feishu_delivery"],
    ["retry_wait", "feishu_delivery"],
    ["dead_letter", "needs_attention"],
  ]) {
    const result = project(
      [task("task-1")],
      [status("task-1", "completed", { writeback: { completed: { state } } })],
    );
    assert.equal(result.groups[stage].length, 1);
  }
});

test("NAS published evidence completes its exact source round; pending and conflict are distinct", () => {
  for (const [state, stage] of [
    ["pending", "nas_upload"],
    ["copying", "nas_upload"],
    ["retry_wait", "nas_upload"],
    ["published", "completed"],
    ["conflict", "needs_attention"],
    ["dead_letter", "needs_attention"],
  ]) {
    const result = project(
      [task("task-1")],
      [
        status("task-1", "completed", {
          archive: { state, sourceRunId: "run-task-1" },
        }),
      ],
    );
    assert.equal(result.groups[stage].length, 1, state);
  }
  const stale = project(
    [task("task-1")],
    [
      status("task-1", "completed", {
        archive: { state: "published", sourceRunId: "run-other" },
      }),
    ],
  );
  assert.equal(stale.groups.completed.length, 0);
});

test("two review rounds advance one record card and preserve clickable history", () => {
  const tasks = [task("task-1"), task("task-2"), task("task-3")];
  const evidence = tasks.map((t, index) =>
    status(t.id, "completed", {
      parentTaskId: index ? tasks[index - 1].id : null,
    }),
  );
  const result = project(tasks, evidence);
  assert.deepEqual(
    result.groups.awaiting_feishu_review.map((item) => item.task.id),
    ["task-3"],
  );
  assert.deepEqual(result.history.map((item) => item.task.id).sort(), [
    "task-1",
    "task-2",
  ]);
  assert.equal(result.groups.awaiting_feishu_review[0].roundCount, 3);
});

test("stale package response cannot populate the current board", () => {
  const result = projectVmPackageBoard(
    [task("task-1")],
    { ...scope, packageAlias: "other", tasks: [status("task-1", "completed")] },
    scope,
  );
  assert.equal(Object.values(result.groups).flat().length, 0);
});
