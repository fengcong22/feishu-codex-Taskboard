import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 60_000;

export class JsonStateStore {
  #filename;
  #writeQueue = Promise.resolve();

  constructor(filename) {
    this.#filename = filename;
  }

  async #read() {
    try {
      const data = JSON.parse(await readFile(this.#filename, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) return Object.create(null);
      const state = Object.create(null);
      for (const [key, value] of Object.entries(data)) state[key] = value;
      return state;
    } catch (error) {
      if (error.code === "ENOENT") return Object.create(null);
      throw error;
    }
  }

  async get(eventId) {
    const state = await this.#read();
    return Object.hasOwn(state, eventId) ? state[eventId] : null;
  }

  async #withFileLock(operation) {
    const lockPath = `${this.#filename}.lock`;
    await mkdir(path.dirname(this.#filename), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
          if (lockAge > LOCK_STALE_MS) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (statError.code !== "ENOENT") throw statError;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring state lock: ${lockPath}`);
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  async #write(eventId, outcome, overwrite) {
    const state = await this.#read();
    if (!overwrite && Object.hasOwn(state, eventId)) return;
    state[eventId] = outcome;
    const temporary = `${this.#filename}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#filename);
    await chmod(this.#filename, 0o600);
  }

  async put(eventId, outcome) {
    this.#writeQueue = this.#writeQueue.catch(() => {}).then(async () => {
      await this.#withFileLock(() => this.#write(eventId, outcome, false));
    });
    await this.#writeQueue;
  }

  async replace(eventId, outcome) {
    this.#writeQueue = this.#writeQueue.catch(() => {}).then(async () => {
      await this.#withFileLock(() => this.#write(eventId, outcome, true));
    });
    await this.#writeQueue;
  }
}
