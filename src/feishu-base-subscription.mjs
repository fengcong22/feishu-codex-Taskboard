const BASE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;

function failure(message, code, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function baseToken(value) {
  if (typeof value !== "string" || !BASE_TOKEN_PATTERN.test(value.trim())) {
    throw failure("Base token is invalid", "INVALID_BASE_TOKEN", 400);
  }
  return value.trim();
}

function operation(client, name) {
  const method = client?.drive?.v1?.file?.[name];
  if (typeof method !== "function") {
    throw failure("Feishu subscription client is unavailable", "FEISHU_SUBSCRIPTION_UNAVAILABLE", 503);
  }
  return method.bind(client.drive.v1.file);
}

async function call(method, request, code) {
  let response;
  try {
    response = await method(request);
  } catch (cause) {
    const error = failure("Feishu subscription request failed", code);
    Object.defineProperty(error, "cause", { value: cause, enumerable: false });
    throw error;
  }
  if (!response || response.code !== 0) {
    throw failure("Feishu subscription request failed", code);
  }
  return response;
}

function requestFor(token) {
  return {
    path: { file_token: token },
    params: { file_type: "bitable" },
  };
}

/** Access one Base's record-change event subscription through the official SDK. */
export function createFeishuBaseSubscriptionClient({ client } = {}) {
  const getSubscribe = operation(client, "getSubscribe");
  const subscribe = operation(client, "subscribe");
  const deleteSubscribe = operation(client, "deleteSubscribe");

  async function get(value) {
    const token = baseToken(value);
    const response = await call(getSubscribe, requestFor(token), "FEISHU_SUBSCRIPTION_READ_FAILED");
    if (typeof response.data?.is_subscribe !== "boolean") {
      throw failure("Feishu subscription response is invalid", "FEISHU_SUBSCRIPTION_INVALID_RESPONSE");
    }
    return { subscribed: response.data.is_subscribe };
  }

  async function mutate(value, method, expected) {
    const token = baseToken(value);
    await call(method, requestFor(token), "FEISHU_SUBSCRIPTION_MUTATION_FAILED");
    const result = await get(token);
    if (result.subscribed !== expected) {
      throw failure("Feishu subscription verification failed", "FEISHU_SUBSCRIPTION_VERIFY_FAILED");
    }
    return result;
  }

  return Object.freeze({
    get,
    subscribe: (value) => mutate(value, subscribe, true),
    unsubscribe: (value) => mutate(value, deleteSubscribe, false),
  });
}
