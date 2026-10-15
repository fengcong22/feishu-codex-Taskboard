import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, realpath, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { copyApprovedVideo, downloadApprovedVideo, VmSourceError } from "./vm-source-transfer.mjs";

const execFileAsync = promisify(execFile);
const MAX_BYTES = 20 * 1024 ** 3;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function fail(code) { throw new VmSourceError(code); }

function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) fail("VM_REQUEST_INVALID");
}

export function validateVmSourceRequest(request) {
  object(request, ["schema_version", "vmid", "source"]);
  if (request.schema_version !== 1 || typeof request.vmid !== "string" || !/^[a-f0-9]{24}$/u.test(request.vmid)) {
    fail("VM_REQUEST_INVALID");
  }
  const source = request.source;
  if (source?.kind === "approval_required") {
    object(source, ["kind"]);
    return structuredClone(request);
  }
  const common = ["kind", "approval_ref", "video_variant", "expected_sha256", "expected_bytes", "expected_resolution"];
  if (source?.kind === "approved_url") object(source, [...common, "url", "allowed_origins", "private_endpoints"]);
  else if (source?.kind === "approved_file") object(source, [...common, "file"]);
  else fail("VM_REQUEST_INVALID");
  if (typeof source.approval_ref !== "string" || !ID.test(source.approval_ref)
    || !["original", "approved_rendition"].includes(source.video_variant)) fail("VM_REQUEST_INVALID");
  if (source.expected_sha256 !== undefined && (typeof source.expected_sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(source.expected_sha256))) {
    fail("VM_REQUEST_INVALID");
  }
  if (source.expected_bytes !== undefined && (!Number.isSafeInteger(source.expected_bytes)
    || source.expected_bytes <= 0 || source.expected_bytes > MAX_BYTES)) fail("VM_REQUEST_INVALID");
  if (source.expected_resolution !== undefined) {
    object(source.expected_resolution, ["width", "height"]);
    const { width, height } = source.expected_resolution;
    if (!Number.isSafeInteger(width) || width <= 0 || width > 16_384
      || !Number.isSafeInteger(height) || height <= 0 || height > 16_384) fail("VM_REQUEST_INVALID");
  }
  if (source.kind === "approved_file" && (typeof source.file !== "string"
    || !path.isAbsolute(source.file) || source.file.includes("\0"))) fail("VM_REQUEST_INVALID");
  if (source.kind === "approved_url") {
    if (typeof source.url !== "string" || source.url.length > 16_384
      || !Array.isArray(source.allowed_origins) || source.allowed_origins.length === 0
      || source.allowed_origins.length > 8) fail("VM_REQUEST_INVALID");
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("VM_REQUEST_INVALID");
      for (const origin of source.allowed_origins) {
        if (typeof origin !== "string") fail("VM_REQUEST_INVALID");
        const parsed = new URL(origin);
        if (parsed.protocol !== "https:" || parsed.origin !== origin) fail("VM_REQUEST_INVALID");
      }
      if (!source.allowed_origins.includes(url.origin)) fail("VM_REQUEST_INVALID");
      if (source.private_endpoints !== undefined) {
        if (!Array.isArray(source.private_endpoints) || source.private_endpoints.length > 8) fail("VM_REQUEST_INVALID");
        const seen = new Set();
        for (const endpoint of source.private_endpoints) {
          object(endpoint, ["origin", "addresses"]);
          if (!source.allowed_origins.includes(endpoint.origin) || seen.has(endpoint.origin)
            || !Array.isArray(endpoint.addresses)
            || endpoint.addresses.length === 0 || endpoint.addresses.length > 8
            || endpoint.addresses.some((address) => {
              if (typeof address !== "string" || isIP(address) !== 4) return true;
              const [a, b] = address.split(".").map(Number);
              return !(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
            })) fail("VM_REQUEST_INVALID");
          seen.add(endpoint.origin);
        }
      }
    } catch { fail("VM_REQUEST_INVALID"); }
  }
  return structuredClone(request);
}

function mediaEnvironment() {
  // Media tools receive no platform credentials or inherited process hooks.
  const names = new Set(["path", "systemroot", "windir", "temp", "tmp", "lang", "lc_all"]);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => names.has(key.toLowerCase())));
}

function mediaToolFailure(error) {
  if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) fail("MEDIA_TOOL_UNAVAILABLE");
  if (error?.killed) fail("MEDIA_TOOL_TIMEOUT");
  fail("MEDIA_VALIDATION_FAILED");
}

export async function validateVmVideo(file, {
  ffprobePath = "ffprobe", ffmpegPath = "ffmpeg", timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const options = { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: mediaEnvironment() };
  let probe;
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      "-v", "error", "-protocol_whitelist", "file", "-f", "mov", "-show_format", "-show_streams",
      "-of", "json", file,
    ], options);
    probe = JSON.parse(stdout);
  } catch (error) {
    mediaToolFailure(error);
  }
  if (!probe || typeof probe !== "object" || Array.isArray(probe)
    || !Array.isArray(probe.streams) || probe.streams.some((stream) => !stream || typeof stream !== "object")) {
    fail("MEDIA_VALIDATION_FAILED");
  }
  const streams = probe.streams;
  const video = streams.filter((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
  const duration = Number(probe.format?.duration);
  if (!video.length || !Number.isFinite(duration) || duration <= 0
    || video.some((stream) => !Number.isSafeInteger(stream.width) || stream.width <= 0
      || !Number.isSafeInteger(stream.height) || stream.height <= 0 || typeof stream.codec_name !== "string"
      || stream.codec_name.length === 0)) {
    fail("MEDIA_VALIDATION_FAILED");
  }
  try {
    await execFileAsync(ffmpegPath, [
      "-nostdin", "-v", "error", "-xerror", "-max_error_rate", "0", "-protocol_whitelist", "file",
      "-f", "mov", "-i", file, "-map", "0:v", "-map", "0:a?", "-f", "null", "-",
    ], options);
  } catch (error) {
    mediaToolFailure(error);
  }
  return {
    container: probe.format?.format_name,
    duration_ms: Math.round(duration * 1000),
    video: video.map((stream) => ({
      index: stream.index, codec: stream.codec_name, width: stream.width, height: stream.height,
      average_frame_rate: stream.avg_frame_rate, time_base: stream.time_base,
    })),
    audio: streams.filter((stream) => stream.codec_type === "audio").map((stream) => ({
      index: stream.index, codec: stream.codec_name, channels: stream.channels,
      sample_rate: Number(stream.sample_rate),
    })),
    validation: { metadata: true, full_decode: true },
  };
}

async function writeReceipt(destination, result, verifySource) {
  const temporary = `${destination}.part`;
  const handle = await open(temporary, "wx", 0o600);
  let ownedTemporary;
  let ownedReceipt;
  try {
    ownedTemporary = { file: temporary, info: await handle.stat({ bigint: true }) };
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8");
    await handle.sync();
    ownedTemporary.info = await handle.stat({ bigint: true });
    await handle.close();
    await verifyOwnedFile(ownedTemporary);
    await verifySource();
    await link(temporary, destination); // Atomic publication without overwriting another receipt.
    ownedReceipt = { file: destination, info: ownedTemporary.info };
    await verifyOwnedFile(ownedReceipt, { afterLink: true });
    await cleanupOwnedFile(ownedTemporary);
    await verifySource();
  } catch (error) {
    await handle.close().catch(() => {});
    await Promise.allSettled([cleanupOwnedFile(ownedTemporary), cleanupOwnedFile(ownedReceipt)]);
    throw error;
  }
}

function sameFileIdentity(current, original) {
  return current.isFile() && !current.isSymbolicLink()
    && current.dev === original.dev && current.ino === original.ino;
}

async function snapshotTransferredFile(file, bytes) {
  let info;
  try { info = await lstat(file, { bigint: true }); }
  catch { fail("VM_SOURCE_FILE_CHANGED"); }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== BigInt(bytes)) fail("VM_SOURCE_FILE_CHANGED");
  return { file, info };
}

async function verifyOwnedFile(owned, { afterLink = false } = {}) {
  let current;
  try { current = await lstat(owned.file, { bigint: true }); }
  catch { fail("VM_SOURCE_FILE_CHANGED"); }
  if (!sameFileIdentity(current, owned.info) || current.size !== owned.info.size
    || current.mtimeNs !== owned.info.mtimeNs
    || (!afterLink && (current.ctimeNs !== owned.info.ctimeNs || current.nlink !== owned.info.nlink))) {
    fail("VM_SOURCE_FILE_CHANGED");
  }
  return current;
}

async function cleanupOwnedFile(owned) {
  if (!owned) return;
  try {
    const current = await lstat(owned.file, { bigint: true });
    if (sameFileIdentity(current, owned.info)) await unlink(owned.file);
  } catch { /* Preserve replaced files and keep cleanup failures out of public errors. */ }
}

/** Standalone, operator-run acquisition. This is not a VM API approval resolver or an execution grant. */
export async function prepareVmSource(rawRequest, {
  outputRoot, maxBytes = MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS,
  ffprobePath = "ffprobe", ffmpegPath = "ffmpeg",
} = {}, dependencies = {}) {
  const request = validateVmSourceRequest(rawRequest);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES
    || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    fail("VM_REQUEST_INVALID");
  }
  if (request.source.kind === "approval_required") {
    return { protocol: "vm_source_acquisition", schema_version: 1, vmid: request.vmid,
      status: "blocked", error: { code: "SOURCE_APPROVAL_REQUIRED", retryable: false } };
  }
  if (typeof outputRoot !== "string" || !path.isAbsolute(outputRoot)) fail("VM_OUTPUT_INVALID");
  const download = dependencies.download ?? downloadApprovedVideo;
  const copy = dependencies.copy ?? copyApprovedVideo;
  const validate = dependencies.validateMedia ?? validateVmVideo;
  let jobRoot;
  let ownedPartial;
  let ownedSource;
  try {
    await mkdir(outputRoot, { recursive: true });
    const rootInfo = await lstat(outputRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail("VM_OUTPUT_INVALID");
    const root = await realpath(outputRoot);
    jobRoot = await mkdtemp(path.join(root, `vm-${request.vmid}-`));
    const partial = path.join(jobRoot, "source.mp4.part");
    const sourcePath = path.join(jobRoot, "source.mp4");
    const receiptPath = path.join(jobRoot, "acquisition.json");
    const { source } = request;
    const evidence = dependencies.approvalEvidence;
    if (evidence && (evidence.application_id !== source.approval_ref || evidence.resource_id !== request.vmid
      || evidence.status !== "APPROVED" || evidence.quality !== "HIGH"
      || typeof evidence.instance_code !== "string" || !ID.test(evidence.instance_code))) {
      fail("VM_APPROVAL_EVIDENCE_INVALID");
    }
    // A durable worker records this exact receipt location before a single-use transfer begins.
    await dependencies.beforeTransfer?.({ receiptPath, sourcePath });
    const transfer = source.kind === "approved_url"
      ? await download({ url: source.url, allowedOrigins: source.allowed_origins,
        privateEndpoints: source.private_endpoints, destination: partial, maxBytes, timeoutMs })
      : await copy({ file: source.file, destination: partial, maxBytes });
    ownedPartial = await snapshotTransferredFile(partial, transfer.bytes);
    if ((source.expected_sha256 && source.expected_sha256 !== transfer.sha256)
      || (source.expected_bytes && source.expected_bytes !== transfer.bytes)) fail("SOURCE_IDENTITY_MISMATCH");
    const media = await validate(partial, { ffprobePath, ffmpegPath, timeoutMs });
    if (source.expected_resolution && media.video.some((stream) =>
      stream.width !== source.expected_resolution.width || stream.height !== source.expected_resolution.height)) {
      fail("SOURCE_RESOLUTION_MISMATCH");
    }
    await verifyOwnedFile(ownedPartial);
    await link(partial, sourcePath);
    ownedSource = { file: sourcePath, info: ownedPartial.info };
    await verifyOwnedFile(ownedSource, { afterLink: true });
    await cleanupOwnedFile(ownedPartial);
    // Linking and removing our partial changes ctime/nlink. Set the strict
    // publication baseline only after identity, size and mtime still match.
    ownedSource.info = await verifyOwnedFile(ownedSource, { afterLink: true });
    const acquisitionId = randomUUID();
    const result = {
      protocol: "vm_source_acquisition", schema_version: 1, status: "ready", vmid: request.vmid,
      acquisition_id: acquisitionId, source_id: `vm_${acquisitionId}`,
      acquired_at: new Date().toISOString(),
      provenance: { kind: evidence ? "vm_api_approval" : "operator_provided_approval", method: source.kind,
        approval_ref: source.approval_ref, video_variant: source.video_variant,
        ...(source.expected_resolution ? { expected_resolution: source.expected_resolution } : {}),
        vmid_binding: evidence ? "vm_api_verified" : "operator_asserted",
        ...(evidence ? { instance_code: evidence.instance_code, resource_id: evidence.resource_id,
          approval_status: evidence.status, video_quality: evidence.quality } : {}) },
      artifact: { path: sourcePath, sha256: transfer.sha256, bytes: transfer.bytes, media },
    };
    await writeReceipt(receiptPath, result, () => verifyOwnedFile(ownedSource));
    return { ...result, receipt_path: receiptPath };
  } catch (error) {
    // A failed transfer owns its cleanup. Once transferred, remove only files
    // whose identity still belongs to this acquisition, preserving replacements.
    await Promise.allSettled([cleanupOwnedFile(ownedPartial), cleanupOwnedFile(ownedSource)]);
    if (error instanceof VmSourceError) throw error;
    fail("VM_ACQUISITION_FAILED");
  }
}
