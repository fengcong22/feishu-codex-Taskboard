import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import path from "node:path";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MESSAGES = Object.freeze({
  VM_SOURCE_INPUT_INVALID: "VM source transfer input is invalid",
  VM_SOURCE_URL_NOT_ALLOWED: "VM source download origin is not allowed",
  VM_SOURCE_ADDRESS_NOT_ALLOWED: "VM source download address is not allowed",
  VM_SOURCE_DNS_FAILED: "VM source download address could not be resolved",
  VM_SOURCE_REDIRECT_LIMIT: "VM source download exceeded its redirect limit",
  VM_SOURCE_HTTP_FAILED: "VM source download did not return a complete file response",
  VM_SOURCE_CONTENT_TYPE_INVALID: "VM source response is not a video file",
  VM_SOURCE_LENGTH_MISMATCH: "VM source response length is invalid",
  VM_SOURCE_TOO_LARGE: "VM source file exceeds the configured size limit",
  VM_SOURCE_EMPTY: "VM source file is empty",
  VM_SOURCE_TIMEOUT: "VM source download exceeded its time limit",
  VM_SOURCE_TRANSFER_FAILED: "VM source transfer did not complete",
  VM_SOURCE_DESTINATION_EXISTS: "VM source temporary destination already exists",
  VM_SOURCE_FILE_INVALID: "VM source must be a regular file without a symbolic link",
  VM_SOURCE_FILE_CHANGED: "VM source file changed during transfer",
});

/** Errors intentionally contain neither transport causes nor signed URLs. */
export class VmSourceError extends Error {
  constructor(code) {
    const safeCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/u.test(code)
      ? code : "VM_SOURCE_TRANSFER_FAILED";
    super(MESSAGES[safeCode] ?? "VM source operation failed");
    this.name = "VmSourceError";
    this.code = safeCode;
  }
}

function fail(code) { return new VmSourceError(code); }
function safeError(error) { return error instanceof VmSourceError ? error : fail("VM_SOURCE_TRANSFER_FAILED"); }

function positiveInteger(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw fail("VM_SOURCE_INPUT_INVALID");
  return result;
}

function localPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw fail("VM_SOURCE_INPUT_INVALID");
  }
  return path.resolve(value);
}

function parseHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail("VM_SOURCE_URL_NOT_ALLOWED"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw fail("VM_SOURCE_URL_NOT_ALLOWED");
  }
  return url;
}

function originsFrom(values) {
  if (!Array.isArray(values) || values.length === 0) throw fail("VM_SOURCE_INPUT_INVALID");
  const result = new Set();
  for (const value of values) {
    const url = parseHttpsUrl(value);
    if (url.pathname !== "/" || url.search) throw fail("VM_SOURCE_INPUT_INVALID");
    result.add(url.origin);
  }
  return result;
}

// Version one intentionally supports public IPv4 only. Reject mixed IPv4/IPv6
// DNS results as well: every returned address must pass the same public check.
function publicIPv4(address) {
  if (typeof address !== "string" || isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

function rfc1918IPv4(address) {
  if (typeof address !== "string" || isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function privateEndpointsFrom(values, allowedOrigins) {
  if (values === undefined) return new Map();
  if (!Array.isArray(values)) throw fail("VM_SOURCE_INPUT_INVALID");
  const result = new Map();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !["origin", "addresses"].includes(key))) {
      throw fail("VM_SOURCE_INPUT_INVALID");
    }
    const url = parseHttpsUrl(value.origin);
    if (url.pathname !== "/" || url.search || !allowedOrigins.has(url.origin)
      || result.has(url.origin) || !Array.isArray(value.addresses) || value.addresses.length === 0
      || value.addresses.some((address) => !rfc1918IPv4(address))) {
      throw fail("VM_SOURCE_INPUT_INVALID");
    }
    result.set(url.origin, new Set(value.addresses));
  }
  return result;
}

function permittedAddress(address, origin, privateEndpoints) {
  return publicIPv4(address) || (rfc1918IPv4(address) && privateEndpoints.get(origin)?.has(address) === true);
}

function checkTimeout(signal) {
  if (signal.aborted) throw fail("VM_SOURCE_TIMEOUT");
}

async function withAbort(promise, signal) {
  checkTimeout(signal);
  let abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(fail("VM_SOURCE_TIMEOUT"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

async function pinnedAddress(url, lookup, signal, privateEndpoints) {
  const host = url.hostname;
  if (isIP(host) === 4) {
    if (!permittedAddress(host, url.origin, privateEndpoints)) throw fail("VM_SOURCE_ADDRESS_NOT_ALLOWED");
    return host;
  }
  if (host.startsWith("[") || host.endsWith(".") || host === "localhost" || host.endsWith(".localhost")) {
    throw fail("VM_SOURCE_ADDRESS_NOT_ALLOWED");
  }
  let addresses;
  try { addresses = await withAbort(Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })), signal); }
  catch (error) {
    if (error instanceof VmSourceError) throw error;
    throw fail("VM_SOURCE_DNS_FAILED");
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw fail("VM_SOURCE_DNS_FAILED");
  if (addresses.some((item) => item?.family !== 4 || !permittedAddress(item.address, url.origin, privateEndpoints))) {
    throw fail("VM_SOURCE_ADDRESS_NOT_ALLOWED");
  }
  return addresses[0].address;
}

function startRequest(url, address, request, signal) {
  checkTimeout(signal);
  return new Promise((resolve, reject) => {
    let req;
    let response;
    const abort = () => {
      const error = fail("VM_SOURCE_TIMEOUT");
      req?.destroy(error);
      response?.destroy(error);
      reject(error);
    };
    const removeAbort = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    try {
      req = request(url, {
        method: "GET",
        agent: false,
        family: 4,
        headers: { accept: "video/*, application/octet-stream" },
        lookup(hostname, options, callback) {
          if (hostname !== url.hostname) return callback(fail("VM_SOURCE_ADDRESS_NOT_ALLOWED"));
          if (options?.all) callback(null, [{ address, family: 4 }]);
          else callback(null, address, 4);
        },
      }, (incoming) => {
        response = incoming;
        incoming.once("close", removeAbort);
        // Always install an error listener, including rejected redirect/error
        // responses which are destroyed before an async iterator consumes them.
        incoming.on("error", () => {});
        if (signal.aborted) abort();
        else resolve(incoming);
      });
      req.on("error", () => {
        removeAbort();
        const error = fail(signal.aborted ? "VM_SOURCE_TIMEOUT" : "VM_SOURCE_TRANSFER_FAILED");
        response?.destroy(error);
        reject(error);
      });
      req.end();
    } catch {
      removeAbort();
      req?.destroy();
      reject(fail("VM_SOURCE_TRANSFER_FAILED"));
    }
  });
}

function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function sameSource(a, b) {
  return b.isFile() && sameIdentity(a, b) && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}

async function createDestination(destination) {
  let handle;
  try { handle = await open(destination, "wx", 0o600); }
  catch (error) {
    throw fail(error?.code === "EEXIST" ? "VM_SOURCE_DESTINATION_EXISTS" : "VM_SOURCE_TRANSFER_FAILED");
  }
  return { handle, identity: await handle.stat({ bigint: true }), destination };
}

async function verifyDestination(owned, bytes) {
  const current = await lstat(owned.destination, { bigint: true });
  if (!current.isFile() || !sameIdentity(current, owned.identity) || current.size !== BigInt(bytes)) {
    throw fail("VM_SOURCE_FILE_CHANGED");
  }
}

async function cleanupOwned(owned) {
  if (!owned) return;
  await owned.handle.close().catch(() => {});
  try {
    const current = await lstat(owned.destination, { bigint: true });
    if (current.isFile() && sameIdentity(current, owned.identity)) await unlink(owned.destination);
  } catch { /* Never turn cleanup into a disclosure of a path or transport error. */ }
}

async function writeBytes(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) throw fail("VM_SOURCE_TRANSFER_FAILED");
    offset += bytesWritten;
  }
}

async function transfer(stream, owned, maxBytes, signal, expectedBytes = null) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const raw of stream) {
    if (signal) checkTimeout(signal);
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > maxBytes) throw fail("VM_SOURCE_TOO_LARGE");
    if (expectedBytes !== null && bytes > expectedBytes) throw fail("VM_SOURCE_LENGTH_MISMATCH");
    hash.update(chunk);
    await writeBytes(owned.handle, chunk);
  }
  if (signal) checkTimeout(signal);
  if (bytes === 0) throw fail("VM_SOURCE_EMPTY");
  if (expectedBytes !== null && bytes !== expectedBytes) throw fail("VM_SOURCE_LENGTH_MISMATCH");
  await owned.handle.sync();
  if (signal) checkTimeout(signal);
  return { sha256: hash.digest("hex"), bytes };
}

/** Download only an already-approved URL into an exclusive caller-owned .part path.
 * No cookies, authorization headers, URL logging, automatic retries, or publication.
 * Network version one permits IPv4 only, with all DNS answers validated.
 * RFC1918 exceptions require exact origin/address pairs supplied by trusted local
 * configuration; loopback, link-local, multicast and other reserved IPs stay denied.
 */
export async function downloadApprovedVideo({ url, allowedOrigins, privateEndpoints, destination, maxBytes, timeoutMs } = {}, {
  lookup = dnsLookup, request = httpsRequest,
} = {}) {
  let owned;
  let response;
  let timer;
  try {
    const target = localPath(destination);
    const limit = positiveInteger(maxBytes, DEFAULT_MAX_BYTES);
    const timeout = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
    if (timeout > 2_147_483_647) throw fail("VM_SOURCE_INPUT_INVALID");
    const origins = originsFrom(allowedOrigins);
    const approvedPrivateEndpoints = privateEndpointsFrom(privateEndpoints, origins);
    let current = parseHttpsUrl(url);
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeout);
    for (let redirects = 0; ; redirects += 1) {
      checkTimeout(controller.signal);
      if (!origins.has(current.origin)) throw fail("VM_SOURCE_URL_NOT_ALLOWED");
      const address = await pinnedAddress(current, lookup, controller.signal, approvedPrivateEndpoints);
      response = await startRequest(current, address, request, controller.signal);
      if (REDIRECT_STATUSES.has(response.statusCode)) {
        const location = response.headers?.location;
        response.destroy();
        if (redirects >= 3) throw fail("VM_SOURCE_REDIRECT_LIMIT");
        if (typeof location !== "string") throw fail("VM_SOURCE_URL_NOT_ALLOWED");
        try { current = parseHttpsUrl(new URL(location, current).href); }
        catch { throw fail("VM_SOURCE_URL_NOT_ALLOWED"); }
        continue;
      }
      if (response.statusCode !== 200) throw fail("VM_SOURCE_HTTP_FAILED");
      const contentType = String(response.headers?.["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (contentType && !/^video\/[\w.+-]+$/u.test(contentType)
        && !["application/octet-stream", "binary/octet-stream", "application/mp4"].includes(contentType)) {
        throw fail("VM_SOURCE_CONTENT_TYPE_INVALID");
      }
      const length = response.headers?.["content-length"];
      let expectedBytes = null;
      if (length !== undefined) {
        if (typeof length !== "string" || !/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length))) {
          throw fail("VM_SOURCE_LENGTH_MISMATCH");
        }
        expectedBytes = Number(length);
        if (expectedBytes > limit) throw fail("VM_SOURCE_TOO_LARGE");
      }
      owned = await createDestination(target);
      const result = await transfer(response, owned, limit, controller.signal, expectedBytes);
      if (response.complete === false) throw fail("VM_SOURCE_TRANSFER_FAILED");
      await verifyDestination(owned, result.bytes);
      checkTimeout(controller.signal);
      await owned.handle.close();
      return result;
    }
  } catch (error) {
    response?.destroy();
    await cleanupOwned(owned);
    throw safeError(error);
  } finally { clearTimeout(timer); }
}

/** Copy a previously approved local video without modifying it or following links. */
export async function copyApprovedVideo({ file, destination, maxBytes } = {}) {
  let source;
  let owned;
  try {
    const sourcePath = localPath(file);
    const target = localPath(destination);
    const limit = positiveInteger(maxBytes, DEFAULT_MAX_BYTES);
    if (sourcePath === target) throw fail("VM_SOURCE_INPUT_INVALID");
    const before = await lstat(sourcePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw fail("VM_SOURCE_FILE_INVALID");
    if (before.size > BigInt(limit)) throw fail("VM_SOURCE_TOO_LARGE");
    source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!sameSource(before, await source.stat({ bigint: true }))) throw fail("VM_SOURCE_FILE_CHANGED");
    owned = await createDestination(target);
    const result = await transfer(source.createReadStream({ autoClose: false }), owned, limit, null, Number(before.size));
    const after = await source.stat({ bigint: true });
    const pathAfter = await lstat(sourcePath, { bigint: true });
    if (!sameSource(before, after) || !sameSource(before, pathAfter)) throw fail("VM_SOURCE_FILE_CHANGED");
    await verifyDestination(owned, result.bytes);
    await owned.handle.close();
    return result;
  } catch (error) {
    await cleanupOwned(owned);
    throw safeError(error);
  } finally { await source?.close().catch(() => {}); }
}
