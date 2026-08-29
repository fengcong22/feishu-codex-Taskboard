import { createFeishuBaseMetadataReader } from "./feishu-base-metadata.mjs";
import { loadFeishuSdk } from "./feishu-ws.mjs";

function optionalText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sdkValue(sdk) {
  const value = sdk?.default && typeof sdk.default === "object" ? sdk.default : sdk;
  if (!value || typeof value.Client !== "function") {
    throw fail("Feishu SDK client is unavailable", "FEISHU_SDK_CLIENT_INVALID");
  }
  return value;
}

// The SDK logs complete HTTP error objects, which can include credential and
// Wiki-node request data. Bridge errors are emitted through its own safe
// error boundary, so the SDK itself must not write those objects to stdout.
const silentSdkLogger = Object.freeze({
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
});

/**
 * Prepare the official SDK's HTTP client for read-only Base metadata calls.
 *
 * This is deliberately independent from the WebSocket listener.  A local
 * Taskboard can therefore preview a Base while event listening is disabled;
 * no WSClient is constructed by this helper.
 */
export async function createFeishuApiContext({
  appId,
  appSecret,
  listenerEnabled = false,
  loadSdk = loadFeishuSdk,
  createMetadataReader = createFeishuBaseMetadataReader,
} = {}) {
  const normalizedAppId = optionalText(appId);
  const normalizedSecret = optionalText(appSecret);
  if (!normalizedAppId || !normalizedSecret) {
    if (listenerEnabled) {
      throw fail(
        "FEISHU_APP_ID and FEISHU_APP_SECRET must be set",
        "FEISHU_CREDENTIALS_MISSING",
      );
    }
    return Object.freeze({
      sdk: null,
      client: null,
      metadataReader: null,
    });
  }

  const sdk = sdkValue(await loadSdk());
  const client = new sdk.Client({
    appId: normalizedAppId,
    appSecret: normalizedSecret,
    logger: silentSdkLogger,
  });
  const metadataReader = createMetadataReader({ client });
  return Object.freeze({
    sdk,
    client,
    metadataReader,
  });
}
