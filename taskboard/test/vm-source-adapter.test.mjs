import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import { lstat, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  prepareVmSource,
  validateVmSourceRequest,
} from "../server/vm-source-adapter.mjs";
import { VmSourceError } from "../server/vm-source-transfer.mjs";

const VMID = "5dd7753a4723ba416403cbad";
const ORIGIN = "https://vm-resource.example.test";
const SIGNED_URL = `${ORIGIN}/approved.mp4?signature=never-log-this`;
const PAYLOAD = Buffer.from("approved VM source bytes");
const SHA256 = createHash("sha256").update(PAYLOAD).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vm-source-adapter-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, outputRoot: path.join(root, "materials") };
}

function urlRequest(overrides = {}) {
  return {
    schema_version: 1,
    vmid: VMID,
    source: {
      kind: "approved_url",
      approval_ref: "apply-6ac899a7",
      video_variant: "original",
      url: SIGNED_URL,
      allowed_origins: [ORIGIN],
      private_endpoints: [{ origin: ORIGIN, addresses: ["10.8.8.11"] }],
      expected_sha256: SHA256,
      expected_bytes: PAYLOAD.length,
      ...overrides,
    },
  };
}

function successfulTransfer(calls) {
  return async (input) => {
    calls.push(input);
    await writeFile(input.destination, PAYLOAD);
    return { sha256: SHA256, bytes: PAYLOAD.length };
  };
}

const validMedia = async () => ({
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  duration_ms: 255000,
  video: [{ index: 0, codec: "h264", width: 1920, height: 1080 }],
  audio: [{ index: 1, codec: "aac", channels: 2, sample_rate: 48000 }],
  validation: { metadata: true, full_decode: true },
});

test("approval_required returns a blocked result without creating output or invoking a transfer", async (t) => {
  const { outputRoot } = await fixture(t);
  let invoked = false;
  const result = await prepareVmSource({
    schema_version: 1,
    vmid: VMID,
    source: { kind: "approval_required" },
  }, { outputRoot }, {
    download: async () => { invoked = true; },
    copy: async () => { invoked = true; },
    validateMedia: async () => { invoked = true; },
  });

  assert.deepEqual(result, {
    protocol: "vm_source_acquisition",
    schema_version: 1,
    vmid: VMID,
    status: "blocked",
    error: { code: "SOURCE_APPROVAL_REQUIRED", retryable: false },
  });
  assert.equal(invoked, false);
  await assert.rejects(lstat(outputRoot), { code: "ENOENT" });
});

test("request validation rejects unknown keys and malformed approved sources", () => {
  const cases = [
    { ...urlRequest(), unexpected: true },
    { ...urlRequest(), vmid: "not-a-vmid" },
    { ...urlRequest(), vmid: [VMID] },
    { ...urlRequest(), schema_version: "1" },
    urlRequest({ approval_ref: 123 }),
    urlRequest({ approval_ref: ["apply-1"] }),
    urlRequest({ allowed_origins: [] }),
    urlRequest({ allowed_origins: [[ORIGIN]] }),
    urlRequest({ url: "http://vm-resource.example.test/approved.mp4" }),
    urlRequest({ private_endpoints: [{ origin: "https://untrusted.example.test", addresses: ["10.8.8.11"] }] }),
    urlRequest({ private_endpoints: [{ origin: ORIGIN, addresses: [] }] }),
    urlRequest({ private_endpoints: [{ origin: ORIGIN, addresses: ["127.0.0.1"] }] }),
    urlRequest({ private_endpoints: [{ origin: ORIGIN, addresses: ["10.8.8.11"] }, { origin: ORIGIN, addresses: ["10.8.8.12"] }] }),
    urlRequest({ expected_sha256: "A".repeat(64) }),
    urlRequest({ expected_sha256: [SHA256] }),
    urlRequest({ expected_resolution: { width: "1280", height: 720 } }),
    urlRequest({ expected_resolution: { width: 1280, height: 0 } }),
    urlRequest({ expected_resolution: { width: 1280, height: 720, ignored: true } }),
    urlRequest({ expected_resolution: [1280, 720] }),
    {
      schema_version: 1,
      vmid: VMID,
      source: { kind: "approved_file", approval_ref: "apply-1", video_variant: "original", file: "relative.mp4" },
    },
    {
      schema_version: 1,
      vmid: VMID,
      source: { kind: "approval_required", ignored: true },
    },
  ];

  for (const input of cases) {
    assert.throws(() => validateVmSourceRequest(input), { code: "VM_REQUEST_INVALID" });
  }
});

test("passes the URL allowlist and private endpoint exception to the downloader", async (t) => {
  const { outputRoot } = await fixture(t);
  const downloads = [];
  const result = await prepareVmSource(urlRequest(), {
    outputRoot,
    maxBytes: 1024,
    timeoutMs: 5_000,
  }, { download: successfulTransfer(downloads), validateMedia: validMedia });

  assert.equal(downloads.length, 1);
  assert.deepEqual(downloads[0].allowedOrigins, [ORIGIN]);
  assert.deepEqual(downloads[0].privateEndpoints, [{ origin: ORIGIN, addresses: ["10.8.8.11"] }]);
  assert.equal(downloads[0].url, SIGNED_URL);
  assert.match(downloads[0].destination, /source\.mp4\.part$/u);
  assert.equal(downloads[0].maxBytes, 1024);
  assert.equal(downloads[0].timeoutMs, 5_000);
  assert.equal(result.status, "ready");
  assert.equal(result.provenance.method, "approved_url");
});

test("a hash mismatch stops before validation and removes transferred partial data", async (t) => {
  const { outputRoot } = await fixture(t);
  let validationCalled = false;
  const transfer = async ({ destination }) => {
    await writeFile(destination, PAYLOAD);
    return { sha256: "0".repeat(64), bytes: PAYLOAD.length };
  };

  await assert.rejects(prepareVmSource(urlRequest(), { outputRoot }, {
    download: transfer,
    validateMedia: async () => { validationCalled = true; },
  }), { code: "SOURCE_IDENTITY_MISMATCH" });
  assert.equal(validationCalled, false);
  const [job] = await readdir(outputRoot);
  assert.deepEqual(await readdir(path.join(outputRoot, job)), []);
});

test("a media validation failure removes the partial source and does not publish a receipt", async (t) => {
  const { outputRoot } = await fixture(t);
  const mediaFailure = new VmSourceError("MEDIA_VALIDATION_FAILED");

  await assert.rejects(prepareVmSource(urlRequest(), { outputRoot }, {
    download: successfulTransfer([]),
    validateMedia: async () => { throw mediaFailure; },
  }), (error) => {
    assert.equal(error, mediaFailure);
    assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}`, /signature|never-log-this|https:/u);
    return true;
  });
  const [job] = await readdir(outputRoot);
  assert.deepEqual(await readdir(path.join(outputRoot, job)), []);
});

test("a failed transfer preserves a replacement file left by the transfer owner's identity protection", async (t) => {
  const { outputRoot } = await fixture(t);
  let replacedPath;
  await assert.rejects(prepareVmSource(urlRequest(), { outputRoot }, {
    download: async ({ destination }) => {
      replacedPath = destination;
      await writeFile(destination, "different owner's file");
      throw new VmSourceError("VM_SOURCE_FILE_CHANGED");
    },
    validateMedia: async () => { assert.fail("media validation must not run after transfer failure"); },
  }), { code: "VM_SOURCE_FILE_CHANGED" });

  assert.equal(await readFile(replacedPath, "utf8"), "different owner's file");
  assert.deepEqual(await readdir(path.dirname(replacedPath)), ["source.mp4.part"]);
});

test("media validation cannot publish or delete a replacement at the partial source path", async (t) => {
  const { outputRoot } = await fixture(t);
  let replacedPath;
  await assert.rejects(prepareVmSource(urlRequest(), { outputRoot }, {
    download: successfulTransfer([]),
    validateMedia: async (file) => {
      replacedPath = file;
      await rename(file, path.join(path.dirname(file), "original.part"));
      await writeFile(file, "different owner's file");
      return validMedia();
    },
  }), { code: "VM_SOURCE_FILE_CHANGED" });

  assert.equal(await readFile(replacedPath, "utf8"), "different owner's file");
  await assert.rejects(lstat(path.join(path.dirname(replacedPath), "source.mp4")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(path.dirname(replacedPath), "acquisition.json")), { code: "ENOENT" });
});

test("changing content in the same partial inode during validation blocks publication", async (t) => {
  const { outputRoot } = await fixture(t);
  let partialPath;
  await assert.rejects(prepareVmSource(urlRequest(), { outputRoot }, {
    download: successfulTransfer([]),
    validateMedia: async (file) => {
      partialPath = file;
      const before = await lstat(file, { bigint: true });
      await writeFile(file, Buffer.alloc(PAYLOAD.length, 7));
      await utimes(file, new Date("2030-01-01"), new Date("2030-01-01"));
      const after = await lstat(file, { bigint: true });
      assert.equal(after.ino, before.ino);
      assert.equal(after.size, before.size);
      return validMedia();
    },
  }), { code: "VM_SOURCE_FILE_CHANGED" });

  assert.deepEqual(await readdir(path.dirname(partialPath)), []);
});

test("a matching declared resolution publishes a ready acquisition", async (t) => {
  const { outputRoot } = await fixture(t);
  const result = await prepareVmSource(urlRequest({ expected_resolution: { width: 1280, height: 720 } }), {
    outputRoot,
  }, {
    download: successfulTransfer([]),
    validateMedia: async () => ({ ...(await validMedia()), video: [{ index: 0, codec: "h264", width: 1280, height: 720 }] }),
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(result.provenance.expected_resolution, { width: 1280, height: 720 });
});

test("a declared resolution mismatch cleans up its own material without publishing", async (t) => {
  const { outputRoot } = await fixture(t);
  await assert.rejects(prepareVmSource(urlRequest({ expected_resolution: { width: 1280, height: 720 } }), {
    outputRoot,
  }, { download: successfulTransfer([]), validateMedia: validMedia }), { code: "SOURCE_RESOLUTION_MISMATCH" });

  const [job] = await readdir(outputRoot);
  assert.deepEqual(await readdir(path.join(outputRoot, job)), []);
});

test("a successful acquisition publishes source and receipt without retaining its signed URL", async (t) => {
  const { outputRoot } = await fixture(t);
  const result = await prepareVmSource(urlRequest(), { outputRoot }, {
    download: successfulTransfer([]),
    validateMedia: validMedia,
  });

  const receipt = JSON.parse(await readFile(result.receipt_path, "utf8"));
  assert.equal(result.status, "ready");
  assert.equal(result.artifact.sha256, SHA256);
  assert.equal(result.artifact.bytes, PAYLOAD.length);
  assert.equal(result.artifact.path.endsWith("source.mp4"), true);
  assert.deepEqual(await readFile(result.artifact.path), PAYLOAD);
  assert.equal(receipt.receipt_path, undefined);
  assert.equal(receipt.acquisition_id, result.acquisition_id);
  assert.equal(receipt.source_id, result.source_id);
  assert.equal(receipt.provenance.approval_ref, "apply-6ac899a7");
  assert.doesNotMatch(JSON.stringify(receipt), /signature|never-log-this|https:/u);
  await assert.rejects(lstat(`${result.artifact.path}.part`), { code: "ENOENT" });
  await assert.rejects(lstat(`${result.receipt_path}.part`), { code: "ENOENT" });
});

test("publication remains successful if deleting the temporary hardlinks fails", async (t) => {
  const { outputRoot } = await fixture(t);
  const originalUnlink = fsPromises.unlink;
  const failedCleanup = [];
  const unlinkMock = t.mock.method(fsPromises, "unlink", async (file) => {
    if (["source.mp4.part", "acquisition.json.part"].includes(path.basename(file))) {
      failedCleanup.push(path.basename(file));
      throw Object.assign(new Error("temporary hardlink is busy"), { code: "EPERM" });
    }
    return originalUnlink(file);
  });
  syncBuiltinESMExports();
  try {
    const result = await prepareVmSource(urlRequest(), { outputRoot }, {
      download: successfulTransfer([]),
      validateMedia: validMedia,
    });

    assert.equal(result.status, "ready");
    assert.deepEqual(failedCleanup, ["source.mp4.part", "acquisition.json.part"]);
    assert.deepEqual(await readFile(result.artifact.path), PAYLOAD);
    const receipt = JSON.parse(await readFile(result.receipt_path, "utf8"));
    assert.equal(receipt.status, "ready");
    assert.equal(receipt.artifact.path, result.artifact.path);
    assert.equal(receipt.artifact.sha256, SHA256);
  } finally {
    unlinkMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("receipt publication failure preserves a replacement temporary receipt", async (t) => {
  const { outputRoot } = await fixture(t);
  const originalOpen = fsPromises.open;
  let replacementPath;
  const openMock = t.mock.method(fsPromises, "open", async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (path.basename(file) === "acquisition.json.part") {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs) => {
        await write(...writeArgs);
        replacementPath = file;
        await rename(file, path.join(path.dirname(file), "original-receipt.part"));
        await writeFile(file, "different owner's receipt");
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareVmSource(urlRequest(), { outputRoot }, {
      download: successfulTransfer([]), validateMedia: validMedia,
    }), { code: "VM_SOURCE_FILE_CHANGED" });

    assert.equal(await readFile(replacementPath, "utf8"), "different owner's receipt");
    await assert.rejects(lstat(path.join(path.dirname(replacementPath), "source.mp4")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(path.dirname(replacementPath), "acquisition.json")), { code: "ENOENT" });
  } finally {
    openMock.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const change of ["replacement", "same inode content change"]) {
  test(`receipt publication blocks a source ${change} and removes its own ready receipt`, async (t) => {
    const { outputRoot } = await fixture(t);
    const originalLink = fsPromises.link;
    let sourcePath;
    let receiptPath;
    const linkMock = t.mock.method(fsPromises, "link", async (from, to) => {
      await originalLink(from, to);
      if (path.basename(to) === "acquisition.json") {
        receiptPath = to;
        sourcePath = path.join(path.dirname(to), "source.mp4");
        if (change === "replacement") {
          await rename(sourcePath, path.join(path.dirname(to), "original-source.mp4"));
          await writeFile(sourcePath, "different owner's video");
        } else {
          const before = await lstat(sourcePath, { bigint: true });
          await writeFile(sourcePath, Buffer.alloc(PAYLOAD.length, 9));
          await utimes(sourcePath, new Date("2030-01-01"), new Date("2030-01-01"));
          const after = await lstat(sourcePath, { bigint: true });
          assert.equal(after.ino, before.ino);
          assert.equal(after.size, before.size);
        }
      }
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(prepareVmSource(urlRequest(), { outputRoot }, {
        download: successfulTransfer([]), validateMedia: validMedia,
      }), { code: "VM_SOURCE_FILE_CHANGED" });

      await assert.rejects(lstat(receiptPath), { code: "ENOENT" });
      await assert.rejects(lstat(`${receiptPath}.part`), { code: "ENOENT" });
      if (change === "replacement") {
        assert.equal(await readFile(sourcePath, "utf8"), "different owner's video");
      } else {
        await assert.rejects(lstat(sourcePath), { code: "ENOENT" });
      }
    } finally {
      linkMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
}
