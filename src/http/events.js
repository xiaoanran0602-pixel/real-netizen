// ============================================================
// SSE：GET /api/lin/events 的连接管理与广播。服务端各处只调 broadcast(type, data)。
// 心跳 25 秒一次注释行，防止代理和手机浏览器把空闲连接掐掉。
// ============================================================

const HEARTBEAT_MS = 25_000;
const RETRY_MS = 3_000;

/** @type {Set<import("node:http").ServerResponse>} */
const clients = new Set();
/** @type {Set<(type: string, data: unknown) => void>} */
const listeners = new Set();
let heartbeat;

function ensureHeartbeat() {
  if (heartbeat || clients.size === 0) return;
  heartbeat = setInterval(() => {
    for (const res of clients) res.write(`: ping ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
}

function stopHeartbeatIfIdle() {
  if (clients.size > 0 || !heartbeat) return;
  clearInterval(heartbeat);
  heartbeat = undefined;
}

/**
 * 接管一个响应作为 SSE 连接。
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {Record<string, string>} [extraHeaders]
 */
export function attachClient(req, res, extraHeaders = {}) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...extraHeaders,
  });
  res.write(`retry: ${RETRY_MS}\n`);
  res.write(`event: ready\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  clients.add(res);
  ensureHeartbeat();
  const drop = () => {
    clients.delete(res);
    stopHeartbeatIfIdle();
  };
  req.on("close", drop);
  res.on("error", drop);
}

/** 广播给所有网页连接，同时通知进程内订阅者（例如动态调度器监听 turn_done）。 */
export function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
  for (const listener of listeners) {
    try {
      listener(type, data);
    } catch {
      // 订阅者出错不影响广播。
    }
  }
}

/** 进程内订阅（不经网络）。 */
export function onEvent(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clientCount() {
  return clients.size;
}

export function closeAllClients() {
  for (const res of clients) res.end();
  clients.clear();
  stopHeartbeatIfIdle();
}
