import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function successful(response, code = "VM_DELIVERY_REMOTE_INVALID") {
  if (!response || response.code !== 0 || !response.data || typeof response.data !== "object")
    throw failure(code);
  return response.data;
}

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size
    && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs && second.nlink === 1n;
}

/** Wrap the official SDK without exposing it to the package subprocess. */
export function createFeishuVmMp4Adapter({ client } = {}) {
  const media = client?.drive?.v1?.media;
  const fieldApi = client?.bitable?.v1?.appTableField;
  const recordApi = client?.bitable?.v1?.appTableRecord;
  if ([media?.uploadPrepare, media?.uploadPart, media?.uploadFinish,
    fieldApi?.list, recordApi?.get, recordApi?.update].some((method) => typeof method !== "function"))
    throw failure("VM_DELIVERY_ADAPTER_UNAVAILABLE");

  async function uploadMedia({ baseToken, filePath, filename, bytes, sha256 }) {
    if (typeof baseToken !== "string" || !baseToken || typeof filePath !== "string"
      || typeof filename !== "string" || !filename || !Number.isSafeInteger(bytes) || bytes < 1
      || !/^[a-f0-9]{64}$/u.test(sha256)) throw failure("VM_DELIVERY_UPLOAD_INPUT_INVALID");
    const file = await open(filePath, "r");
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(bytes))
        throw failure("VM_DELIVERY_ARTIFACT_CHANGED");
      const prepared = successful(await media.uploadPrepare({ data: {
        file_name: filename, parent_type: "bitable_file", parent_node: baseToken, size: bytes,
      } }), "VM_DELIVERY_UPLOAD_FAILED");
      const { upload_id: uploadId, block_size: blockSize, block_num: blockNum } = prepared;
      if (typeof uploadId !== "string" || !uploadId
        || !Number.isSafeInteger(blockSize) || blockSize < 1 || blockSize > 8 * 1024 * 1024
        || !Number.isSafeInteger(blockNum) || blockNum !== Math.ceil(bytes / blockSize))
        throw failure("VM_DELIVERY_UPLOAD_INVALID_RESPONSE");
      const hash = createHash("sha256");
      for (let seq = 0, offset = 0; seq < blockNum; seq++) {
        const size = Math.min(blockSize, bytes - offset);
        const chunk = Buffer.allocUnsafe(size);
        let filled = 0;
        while (filled < size) {
          const read = await file.read(chunk, filled, size - filled, offset + filled);
          if (read.bytesRead < 1) throw failure("VM_DELIVERY_ARTIFACT_CHANGED");
          filled += read.bytesRead;
        }
        hash.update(chunk);
        const response = await media.uploadPart({ data: {
          upload_id: uploadId, seq, size, file: chunk,
        } });
        if (typeof response?.code === "number" && response.code !== 0)
          throw failure("VM_DELIVERY_UPLOAD_FAILED");
        offset += size;
      }
      const after = await file.stat({ bigint: true });
      if (!sameFile(before, after) || hash.digest("hex") !== sha256)
        throw failure("VM_DELIVERY_ARTIFACT_CHANGED");
      const finished = successful(await media.uploadFinish({ data: {
        upload_id: uploadId, block_num: blockNum,
      } }), "VM_DELIVERY_UPLOAD_FAILED");
      if (typeof finished.file_token !== "string" || !finished.file_token)
        throw failure("VM_DELIVERY_UPLOAD_INVALID_RESPONSE");
      return { file_token: finished.file_token };
    } finally { await file.close(); }
  }

  async function listFields({ baseToken, tableId }) {
    const items = [];
    const seen = new Set();
    let pageToken = null;
    do {
      const data = successful(await fieldApi.list({
        path: { app_token: baseToken, table_id: tableId },
        ...(pageToken ? { params: { page_token: pageToken } } : {}),
      }));
      if (!Array.isArray(data.items)) throw failure("VM_DELIVERY_REMOTE_INVALID");
      items.push(...data.items);
      if (items.length > 10_000) throw failure("VM_DELIVERY_REMOTE_INVALID");
      if (!data.has_more) return items;
      pageToken = data.page_token;
      if (typeof pageToken !== "string" || !pageToken || seen.has(pageToken))
        throw failure("VM_DELIVERY_REMOTE_INVALID");
      seen.add(pageToken);
    } while (true);
  }

  async function getRecord({ baseToken, tableId, recordId }) {
    const data = successful(await recordApi.get({
      path: { app_token: baseToken, table_id: tableId, record_id: recordId },
    }));
    if (!data.record || typeof data.record.fields !== "object" || Array.isArray(data.record.fields))
      throw failure("VM_DELIVERY_REMOTE_INVALID");
    return { fields: data.record.fields };
  }

  async function updateRecord({ baseToken, tableId, recordId, fieldName, attachments }) {
    if (typeof fieldName !== "string" || !fieldName || !Array.isArray(attachments)
      || attachments.some((entry) => typeof entry?.file_token !== "string" || !entry.file_token))
      throw failure("VM_DELIVERY_UPLOAD_INPUT_INVALID");
    successful(await recordApi.update({
      path: { app_token: baseToken, table_id: tableId, record_id: recordId },
      data: { fields: { [fieldName]: attachments } },
    }), "VM_DELIVERY_BIND_FAILED");
  }

  return Object.freeze({ uploadMedia, listFields, getRecord, updateRecord });
}
