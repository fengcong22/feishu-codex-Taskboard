import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function startAutomaticExecutionTestServer() {
  const packageRoot = existsSync(join(process.cwd(), "server/index.mjs"))
    ? process.cwd() : join(process.cwd(), "taskboard");
  // Load backend ESM natively: jsdom's transformed import.meta.url is an HTTP URL.
  const { createTaskboardServer } = createRequire(pathToFileURL(join(packageRoot, "server/index.mjs")))("./index.mjs");
  const directory = await mkdtemp(join(tmpdir(), "automatic-setting-web-"));
  const server = createTaskboardServer({
    dataDirectory: directory,
    allowAutomaticExecution: false,
    codexExecutable: process.execPath,
  });
  const close = async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    return { baseUrl: `http://127.0.0.1:${address.port}/`, close };
  } catch (error) {
    await close();
    throw error;
  }
}
