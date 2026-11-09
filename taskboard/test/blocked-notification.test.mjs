import assert from "node:assert/strict";
import test from "node:test";

import { describeBlockedFeishuTask, describeVmPmoAttention } from "../server/blocked-notification.mjs";

const task = { id: "task_001", identifier: "MATH-12", title: "课程 002 初稿", status: "blocked" };
const transition = { activityId: 42, before: "in_progress", after: "blocked", createdAt: "2026-10-28T02:30:00.000Z" };
const origin = { source: "feishu-base", eventId: "evt_001", subjectKey: "bas_001:tbl_math", stageId: "initial",
  baseToken: "bas_001", tableId: "tbl_math", recordId: "rec_001" };

test("blocked Feishu task notification uses the status edge and safe run failure reason", () => {
  const notification = describeBlockedFeishuTask({ task, transition, origin,
    subject: { baseName: "课程 PMO", tableName: "数学学科" },
    latestRun: { state: "blocked", errorCode: "WORD_ALIGNMENT_UNRESOLVED" } });

  assert.deepEqual(notification, {
    eventKey: "task:task_001:activity:42",
    subject: "数学学科",
    taskId: "MATH-12",
    taskTitle: "课程 002 初稿",
    recordId: "rec_001",
    stage: "initial",
    status: "blocked",
    occurredAt: transition.createdAt,
    reason: "语音识别词条无法与素材准确匹配，需要人工规划处理。",
  });
});

test("blocked Feishu task notification ignores replayed edges and untrusted task origins", () => {
  assert.equal(describeBlockedFeishuTask({ task, transition: { ...transition, before: "blocked" }, origin }), null);
  assert.equal(describeBlockedFeishuTask({ task: { ...task, status: "todo" }, transition, origin }), null);
  assert.equal(describeBlockedFeishuTask({ task, transition, origin: { ...origin, source: "ordinary-task" } }), null);
  assert.equal(describeBlockedFeishuTask({ task, transition, origin: { ...origin, deliverySource: "simulation" } }), null);
  assert.equal(describeBlockedFeishuTask({ task, transition, origin: { ...origin, eventId: undefined } }), null);
});

test("manual Feishu blocker reason stays useful without exposing task description or local data", () => {
  const notification = describeBlockedFeishuTask({ task, transition, origin,
    subject: { tableName: "数学学科" }, latestRun: { state: "completed", errorCode: null } });

  assert.equal(notification.reason, "该任务已标记为遇到阻碍，请查看 Taskboard 中的任务详情和活动记录。");
  assert.doesNotMatch(JSON.stringify(notification), /C:\\|prompt|workspace/iu);
});

test("VM needs-attention notification identifies the frozen stage and safe failure reason", () => {
  const notification = describeVmPmoAttention({ run: { runId: "run_001", state: "needs_attention",
    errorCode: "VM_PMO_RUN_OUTCOME_UNKNOWN", updatedAt: Date.parse(transition.createdAt) }, task,
  origin, subject: { tableName: "数学学科" } });

  assert.equal(notification.eventKey, "vm-pmo:run_001:needs_attention:1793154600000");
  assert.equal(notification.subject, "数学学科");
  assert.equal(notification.taskId, task.identifier);
  assert.equal(notification.stage, "initial");
  assert.equal(notification.status, "needs_attention");
  assert.equal(notification.occurredAt, transition.createdAt);
  assert.match(notification.reason, /结果无法确认/u);
});
