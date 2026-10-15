import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createFeishuVmMp4Adapter } from "../server/vm-mp4-feishu-adapter.mjs";

test("SDK adapter uploads exact MP4 bytes in numbered bitable media parts", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-sdk-adapter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "sample.mp4");
  const media = Buffer.from("abcdefghijkl");
  await writeFile(filePath, media);
  const parts = [];
  const client = { drive: { v1: { media: {
    uploadPrepare: async ({ data }) => {
      assert.deepEqual(data, { file_name: "sample.mp4", parent_type: "bitable_file", parent_node: "base-1", size: 12 });
      return { code: 0, data: { upload_id: "upload-1", block_size: 5, block_num: 3 } };
    },
    uploadPart: async ({ data }) => {
      parts.push({ seq: data.seq, size: data.size, bytes: Buffer.from(data.file).toString("utf8") });
      return {};
    },
    uploadFinish: async ({ data }) => {
      assert.deepEqual(data, { upload_id: "upload-1", block_num: 3 });
      return { code: 0, data: { file_token: "token-1" } };
    },
  } } }, bitable: { v1: { appTableField: { list: async () => ({ code: 0, data: { items: [] } }) },
    appTableRecord: { get: async () => ({ code: 0, data: { record: { fields: {} } } }),
      update: async () => ({ code: 0, data: { record: { fields: {} } } }) } } } };
  const adapter = createFeishuVmMp4Adapter({ client });
  const result = await adapter.uploadMedia({ baseToken: "base-1", filePath, filename: "sample.mp4",
    bytes: media.length, sha256: createHash("sha256").update(media).digest("hex") });
  assert.deepEqual(result, { file_token: "token-1" });
  assert.deepEqual(parts, [
    { seq: 0, size: 5, bytes: "abcde" },
    { seq: 1, size: 5, bytes: "fghij" },
    { seq: 2, size: 2, bytes: "kl" },
  ]);
});

test("SDK adapter uses exact Base record and attachment field without writing other fields", async () => {
  const updates = [];
  const client = { drive: { v1: { media: { uploadPrepare() {}, uploadPart() {}, uploadFinish() {} } } },
    bitable: { v1: { appTableField: { async list({ path: target }) {
      assert.deepEqual(target, { app_token: "base-1", table_id: "table-1" });
      return { code: 0, data: { items: [{ field_id: "field-1", field_name: "成片", type: 17 }], has_more: false } };
    } }, appTableRecord: {
      async get({ path: target }) {
        assert.deepEqual(target, { app_token: "base-1", table_id: "table-1", record_id: "record-1" });
        return { code: 0, data: { record: { fields: { 成片: [{ file_token: "old" }] } } } };
      },
      async update(input) { updates.push(input); return { code: 0, data: { record: { fields: {} } } }; },
    } } } };
  const adapter = createFeishuVmMp4Adapter({ client });
  assert.equal((await adapter.listFields({ baseToken: "base-1", tableId: "table-1" }))[0].field_id, "field-1");
  assert.deepEqual(await adapter.getRecord({ baseToken: "base-1", tableId: "table-1", recordId: "record-1" }),
    { fields: { 成片: [{ file_token: "old" }] } });
  await adapter.updateRecord({ baseToken: "base-1", tableId: "table-1", recordId: "record-1",
    fieldName: "成片", attachments: [{ file_token: "old" }, { file_token: "new" }] });
  assert.deepEqual(updates[0], { path: { app_token: "base-1", table_id: "table-1", record_id: "record-1" },
    data: { fields: { 成片: [{ file_token: "old" }, { file_token: "new" }] } } });
});
