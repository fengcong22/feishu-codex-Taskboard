import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { createFeishuDeliveryStore } from "../server/feishu-delivery-store.mjs";
import { createArtifactUploadWorker } from "../server/upload-worker.mjs";

const actor = { type: "user", id: "tester", name: "Tester", avatarUrl: null };

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-delivery-publication-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const project = database.createProject({ id: "delivery-project", name: "Delivery", workspacePath: null });
  const timestamp = new Date().toISOString();
  database.database.prepare(`
    INSERT INTO feishu_bases (
      base_token, base_name, source_url_label, metadata_refreshed_at, created_at, updated_at
    ) VALUES (?, ?, NULL, NULL, ?, ?)
  `).run("bas_delivery", "Delivery Base", timestamp, timestamp);
  database.database.prepare(`
    INSERT INTO feishu_subjects (
      subject_key, base_token, table_id, table_name, project_id, display_enabled,
      lifecycle, config_version, config_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'enabled', 1, '{}', '{}', ?, ?)
  `).run("bas_delivery:tbl_courses", "bas_delivery", "tbl_courses", "Courses", project.id, timestamp, timestamp);
  const task = database.createTask({
    id: "task-001",
    projectId: project.id,
    title: "Delivery task",
    description: "",
    status: "done",
    priority: "none",
    labels: ["feishu"],
    actor,
    assignee: actor,
    startDate: null,
    dueDate: null,
    feishuOrigin: {
      source: "feishu-base",
      eventId: "evt-001",
      baseToken: "bas_delivery",
      tableId: "tbl_courses",
      recordId: "rec-001",
      subjectKey: "bas_delivery:tbl_courses",
      configVersion: 1,
      stageId: "initial",
    },
  });
  const run = database.createFeishuAutoCutRun({
    runId: "run-001",
    taskId: task.id,
    subjectKey: "bas_delivery:tbl_courses",
    configVersion: 1,
    stageId: "initial",
    eventId: "evt-001",
    resultPath: path.join(directory, "result.json"),
  });
  const store = createFeishuDeliveryStore({ database });
  const binding = store.ensureCourseBinding({
    identity: { baseToken: "bas_delivery", tableId: "tbl_courses", recordId: "rec-001" },
    subjectVersion: 1,
    namingValue: "Course 001",
    resolvedPaths: {
      actualRoot: "C:\\delivery",
      coursePath: "C:\\delivery\\Course 001",
      displayPath: "delivery\\Course 001",
      pathKind: "local",
      canonicalLocationKey: "C:\\delivery\\Course 001",
    },
    trustedEventId: "evt-001",
  });
  const bytes = Buffer.from("verified zip bytes", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifact = {
    id: "artifact-001",
    storageKey: "artifact-001",
    filename: "Course 001_initial.zip",
    sha256,
  };
  database.database.prepare(`
    INSERT INTO task_artifacts (
      id, task_id, run_id, storage_key, filename, content_type, size, sha256,
      source_mode, validation_status, entry_count, draft_root, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'application/zip', ?, ?, 'driver_report', 'verified', 1, 'draft', ?, ?)
  `).run(
    artifact.id,
    task.id,
    run.runId,
    artifact.storageKey,
    artifact.filename,
    bytes.length,
    artifact.sha256,
    timestamp,
    timestamp,
  );
  const rootPath = path.join(directory, "delivery-root");
  const targetPath = path.join(rootPath, "Course 001", "01初稿");
  const upload = database.createArtifactUpload({
    taskId: task.id,
    artifactId: artifact.id,
    subjectKey: "bas_delivery:tbl_courses",
    storageKey: artifact.storageKey,
    targetId: "delivery-target",
    targetPath,
    publicationRootPath: rootPath,
    courseBindingId: binding.bindingId,
    runId: run.runId,
    filename: artifact.filename,
    sha256,
    uploadConcurrency: 1,
  });
  return {
    directory,
    database,
    store,
    binding,
    run,
    artifact,
    upload,
    targetPath,
    sha256,
    async close() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("a published run records its exact path and one delivery fact per logical outcome", async () => {
  const f = await fixture();
  try {
    const claimed = f.database.claimNextArtifactUpload();
    const destination = path.join(f.targetPath, f.artifact.filename);
    const completed = f.database.markArtifactUploadUploaded(claimed.id, claimed.claimToken, null, {
      publication: { destination, sha256: f.sha256, created: true },
    });

    assert.equal(completed.status, "uploaded");
    assert.equal(
      f.database.database.prepare("SELECT published_path FROM artifact_uploads WHERE id = ?").get(f.upload.id).published_path,
      destination,
    );
    assert.deepEqual(
      f.store.getRunDeliveryProgress(f.run.runId),
      { artifactId: f.artifact.id, registered: true, uploaded: true },
    );
    assert.deepEqual(
      f.store.listDeliveryFacts(f.run.runId).map((fact) => ({ kind: fact.kind, bindingId: fact.bindingId })),
      [
        { kind: "course_path", bindingId: f.binding.bindingId },
        { kind: "stage_uploaded", bindingId: f.binding.bindingId },
      ],
    );
    assert.deepEqual(f.store.listPublishedDeliveryUploads(), [{
      uploadId: f.upload.id,
      taskId: f.upload.taskId,
      runId: f.run.runId,
      courseBindingId: f.binding.bindingId,
    }]);
  } finally {
    await f.close();
  }
});

test("an archived published delivery task deletes its delivery facts and writeback outbox", async () => {
  const f = await fixture();
  try {
    const claimed = f.database.claimNextArtifactUpload();
    const destination = path.join(f.targetPath, f.artifact.filename);
    f.database.markArtifactUploadUploaded(claimed.id, claimed.claimToken, null, {
      publication: { destination, sha256: f.sha256, created: true },
    });
    f.store.enqueueWritebackIntent({
      idempotencyKey: `${f.run.runId}:stage-uploaded:0`,
      taskId: f.run.taskId,
      runId: f.run.runId,
      courseBindingId: f.binding.bindingId,
      operation: { type: "single_select", fieldId: "fld_status", optionId: "opt_uploaded" },
    });

    const current = f.database.getTask(f.run.taskId);
    const archived = f.database.archiveTask(current.id, current.version, null, null, actor);
    f.database.deleteArchivedTask(current.id, archived.version);

    assert.equal(f.database.getTask(current.id), null);
    assert.equal(f.database.database.prepare("SELECT COUNT(*) AS count FROM feishu_delivery_facts WHERE task_id = ?").get(current.id).count, 0);
    assert.equal(f.database.database.prepare("SELECT COUNT(*) AS count FROM feishu_writeback_outbox WHERE task_id = ?").get(current.id).count, 0);
    assert.equal(f.database.database.prepare("SELECT COUNT(*) AS count FROM feishu_course_bindings WHERE id = ?").get(f.binding.bindingId).count, 1);
    assert.equal(f.database.database.prepare("SELECT COUNT(*) AS count FROM feishu_task_deletions WHERE event_id = ?").get("evt-001").count, 1);
  } finally {
    await f.close();
  }
});

test("an archived delivery task cannot be deleted while a Feishu writeback is processing", async () => {
  const f = await fixture();
  try {
    const uploadClaim = f.database.claimNextArtifactUpload();
    const destination = path.join(f.targetPath, f.artifact.filename);
    f.database.markArtifactUploadUploaded(uploadClaim.id, uploadClaim.claimToken, null, {
      publication: { destination, sha256: f.sha256, created: true },
    });
    const intent = f.store.enqueueWritebackIntent({
      idempotencyKey: `${f.run.runId}:processing:0`,
      taskId: f.run.taskId,
      runId: f.run.runId,
      courseBindingId: null,
      operation: { type: "single_select", fieldId: "fld_status", optionId: "opt_processing" },
    });
    const claimed = f.store.claimNextWritebackIntent({ leaseMs: 60_000 });
    assert.equal(claimed.id, intent.id);

    const current = f.database.getTask(f.run.taskId);
    const archived = f.database.archiveTask(current.id, current.version, null, null, actor);
    assert.throws(
      () => f.database.deleteArchivedTask(current.id, archived.version),
      { code: "FEISHU_WRITEBACK_ACTIVE" },
    );

    assert.ok(f.database.getTask(current.id));
    assert.equal(f.store.getWritebackIntent(intent.id).state, "processing");
  } finally {
    await f.close();
  }
});

test("a publication path outside the frozen target is rejected without completing the upload", async () => {
  const f = await fixture();
  try {
    const claimed = f.database.claimNextArtifactUpload();
    assert.throws(
      () => f.database.markArtifactUploadUploaded(claimed.id, claimed.claimToken, null, {
        publication: {
          destination: path.join(f.directory, "outside.zip"),
          sha256: f.sha256,
          created: true,
        },
      }),
      { code: "ARTIFACT_PUBLICATION_INVALID" },
    );
    assert.equal(f.database.getArtifactUpload(f.upload.id).status, "uploading");
    assert.deepEqual(f.store.listDeliveryFacts(f.run.runId), []);
  } finally {
    await f.close();
  }
});

test("a delivery upload never creates a missing configured root", async () => {
  const f = await fixture();
  try {
    let failure = null;
    const worker = createArtifactUploadWorker({
      database: f.database,
      artifactService: { createDownloadStream: () => Readable.from([Buffer.from("verified zip bytes")]) },
      onUpdate(upload) {
        if (upload?.status === "failed") failure = upload;
      },
    });
    await worker.start();

    assert.equal(failure?.errorCode, "DELIVERY_ROOT_UNAVAILABLE");
    assert.equal(f.database.getArtifactUpload(f.upload.id).status, "failed");
    await assert.rejects(access(f.targetPath));
    await worker.close();
  } finally {
    await f.close();
  }
});

test("a delivery worker publishes the registered ZIP and persists publication facts", async () => {
  const f = await fixture();
  try {
    await mkdir(path.dirname(f.targetPath), { recursive: true });
    const bytes = Buffer.from("verified zip bytes");
    let published = null;
    const worker = createArtifactUploadWorker({
      database: f.database,
      artifactService: { createDownloadStream: () => Readable.from([bytes]) },
      onPublished(value) { published = value; },
    });
    await worker.start();

    assert.equal(f.database.getArtifactUpload(f.upload.id).status, "uploaded");
    assert.deepEqual(await readFile(path.join(f.targetPath, f.artifact.filename)), bytes);
    assert.deepEqual(
      {
        uploadId: published?.upload.id,
        completedId: published?.completed.id,
        destination: published?.publication.destination,
      },
      {
        uploadId: f.upload.id,
        completedId: f.upload.id,
        destination: path.join(f.targetPath, f.artifact.filename),
      },
    );
    assert.deepEqual(
      f.store.listDeliveryFacts(f.run.runId).map((fact) => fact.kind),
      ["course_path", "stage_uploaded"],
    );
    await worker.close();
  } finally {
    await f.close();
  }
});
