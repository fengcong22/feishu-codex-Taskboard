const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);
const FIRST_FETCH_SAFE_RANDOM_PORT = 10_081;
const LAST_TCP_PORT = 65_535;

function listen(server, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, host, () => {
      server.off("error", onError);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export function isFetchSafePort(port) {
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 && !FETCH_BLOCKED_PORTS.has(port);
}

function randomFetchSafePort(random) {
  if (typeof random !== "function") throw new TypeError("random must be a function");
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new TypeError("random must return a number in [0, 1)");
  }
  return FIRST_FETCH_SAFE_RANDOM_PORT + Math.floor(value * (LAST_TCP_PORT - FIRST_FETCH_SAFE_RANDOM_PORT + 1));
}

/** Keep HTTP test fixtures reachable through Node's Fetch implementation. */
export async function listenOnFetchSafePort(server, { host = "127.0.0.1", maxAttempts = 32 } = {}) {
  if (!server || typeof server.listen !== "function" || typeof server.close !== "function") {
    throw new TypeError("server must be a Node HTTP server");
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("maxAttempts must be a positive integer");
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const address = await listen(server, host);
    if (address && typeof address === "object" && isFetchSafePort(address.port)) return address;
    await close(server);
  }
  throw new Error("Could not reserve a Fetch-safe loopback port");
}

/** Preserve the Taskboard application's own listener lifecycle in tests. */
export async function listenTaskboardOnFetchSafePort(app, {
  host = "127.0.0.1",
  maxAttempts = 32,
  random = Math.random,
} = {}) {
  if (!app || typeof app.listen !== "function") throw new TypeError("app must expose listen");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("maxAttempts must be a positive integer");
  }

  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const port = randomFetchSafePort(random);
    try {
      return await app.listen({ host, port });
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error("Could not reserve a Fetch-safe loopback port");
}
