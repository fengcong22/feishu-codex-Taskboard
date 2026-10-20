import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBridgeServer } from "../src/server.mjs";
import { powershell } from "./helpers/codex-cli-fixture.mjs";

const script = fileURLToPath(new URL("../scripts/retry-vm-final-archive.ps1", import.meta.url));
const source = { runId: "run_1", deliveryId: "delivery_1", artifactId: "artifact_1",
  sha256: "a".repeat(64), bytes: 20368266 };

function runScript(configFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script, "-EventId", "evt_archive", "-RunId", source.runId, "-DeliveryId", source.deliveryId,
      "-ArtifactId", source.artifactId, "-Sha256", source.sha256, "-Bytes", String(source.bytes)], {
      env: { ...process.env, BRIDGE_CONFIG: configFile }, windowsHide: true, timeout: 15000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
  });
}

test("archive recovery script reaches the local guarded route with only the original event and MP4 identity", {
  skip: process.platform !== "win32",
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "archive-script-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const app = createBridgeServer({ host: "127.0.0.1", port: 0, handleEvent: assert.fail,
    retryFinalArchiveDeadLetter: async (eventId, expectedSource) => {
      requests.push({ eventId, expectedSource });
      return { eventId, deliveryState: "retry_wait", attempts: 0 };
    } });
  t.after(() => app.close());
  const { port } = await app.listen();
  const configFile = path.join(directory, "bridge.json");
  await writeFile(configFile, JSON.stringify({ host: "127.0.0.1", port }));

  const result = await runScript(configFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /event=evt_archive state=retry_wait attempts=0/);
  assert.deepEqual(requests, [{ eventId: "evt_archive", expectedSource: source }]);

  await writeFile(configFile, JSON.stringify({ host: "192.168.1.1", port }));
  const rejected = await runScript(configFile);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /valid loopback host and port/);
  assert.equal(requests.length, 1);
});
