import { afterEach, expect, it, vi } from "vitest";

import {
  inspectFeishuPackageWorkspace,
  listFeishuPackages,
  prepareFeishuPackageOutputDirectory,
  validateFeishuPackageOutputDirectory,
} from "./api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

it("stops a hanging package list request after fifteen seconds", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(() => never<Response>());
  vi.stubGlobal("fetch", fetchMock);

  const result = listFeishuPackages();
  const expected = expect(result).rejects.toMatchObject({
    code: "PACKAGE_REQUEST_TIMEOUT",
    message: expect.stringContaining("try again"),
  });
  await vi.advanceTimersByTimeAsync(15_000);

  await expected;
  expect((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].signal?.aborted).toBe(true);
});

it("stops a package workspace inspection when its response body never finishes", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: () => never(),
  }) as Response);
  vi.stubGlobal("fetch", fetchMock);

  const result = inspectFeishuPackageWorkspace("D:\\codex\\auto-cut-lite");
  const expected = expect(result).rejects.toMatchObject({ code: "PACKAGE_REQUEST_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(15_000);

  await expected;
  expect((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].signal?.aborted).toBe(true);
});

it("returns package data when the bounded read completes normally", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    packages: [{ alias: "auto-cut-lite" }],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(listFeishuPackages()).resolves.toEqual([{ alias: "auto-cut-lite" }]);
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/api/local/autocut/packages"),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it("honors external cancellation of workspace inspection without waiting for the deadline", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(() => never<Response>());
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();

  const result = inspectFeishuPackageWorkspace("D:\\codex\\auto-cut-lite", controller.signal);
  const expected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();

  await expected;
  expect((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].signal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(15_000);
});

it("prepares the declared ZIP output directory through the local package API", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    zipOutput: {
      relativeDirectory: "output",
      directory: "D:\\codex\\auto-cut-lite\\output",
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(prepareFeishuPackageOutputDirectory("D:\\codex\\auto-cut-lite")).resolves.toEqual({
    relativeDirectory: "output",
    directory: "D:\\codex\\auto-cut-lite\\output",
  });
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/api/local/autocut/packages/prepare-output-directory"),
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ workspacePath: "D:\\codex\\auto-cut-lite" }),
    }),
  );
});

it("stops hanging directory preparation without leaving the editor busy indefinitely", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(() => never<Response>());
  vi.stubGlobal("fetch", fetchMock);

  const result = prepareFeishuPackageOutputDirectory("D:\\codex\\auto-cut-lite");
  const expected = expect(result).rejects.toMatchObject({ code: "PACKAGE_OUTPUT_PREPARATION_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(15_000);

  await expected;
  expect((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].signal?.aborted).toBe(true);
});

it("validates a custom ZIP output directory through the bounded local API", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ directory: "E:\\剪辑输出" }), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(validateFeishuPackageOutputDirectory("E:\\剪辑输出")).resolves.toBe("E:\\剪辑输出");
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/api/local/autocut/packages/validate-output-directory"),
    expect.objectContaining({ method: "POST", body: JSON.stringify({ directory: "E:\\剪辑输出" }) }),
  );
});
