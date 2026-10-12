// 网页与服务端的唯一通道：fetch 封装 + SSE（EventSource）。
// 令牌：第一次带 ?token= 打开时服务端写 HttpOnly cookie，之后请求自动带上，这里不碰令牌本身。
// 断线：EventSource 自己会重连；重连成功后回调 onReconnect，由调用方按最后一条消息 id 补齐。

const RECONNECT_DELAY_MS = 3_000;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) throw new ApiError(response.status, data.error || `HTTP ${response.status}`);
  return data;
}

const enc = encodeURIComponent;

export const api = {
  get: (path) => request("GET", path),
  put: (path, body) => request("PUT", path, body ?? {}),
  post: (path, body) => request("POST", path, body ?? {}),
  del: (path) => request("DELETE", path),

  getSettings: () => request("GET", "/api/lin/settings"),
  saveSettings: (patch) => request("PUT", "/api/lin/settings", patch),
  getModel: () => request("GET", "/api/lin/model"),
  saveModel: (patch) => request("PUT", "/api/lin/model", patch),
  testModel: () => request("POST", "/api/lin/model/test", {}),
  getPersona: () => request("GET", "/api/lin/persona"),
  savePersona: (persona) => request("PUT", "/api/lin/persona", { persona }),
  getCore: () => request("GET", "/api/lin/core"),

  history: ({ limit, after, before } = {}) => {
    const query = new URLSearchParams();
    if (limit) query.set("limit", String(limit));
    if (after) query.set("after", after);
    if (before) query.set("before", before);
    const qs = query.toString();
    return request("GET", `/api/lin/chat/history${qs ? `?${qs}` : ""}`);
  },
  send: (text, clientId) => request("POST", "/api/lin/chat/send", { text, clientId }),
  newConversation: () => request("POST", "/api/lin/chat/new", {}),

  listMemories: () => request("GET", "/api/lin/memories"),
  saveMemory: (file, content) => request("PUT", `/api/lin/memories/${enc(file)}`, { content }),
  deleteMemory: (file) => request("DELETE", `/api/lin/memories/${enc(file)}`),
  pinMemory: (file, pinned) => request("PUT", `/api/lin/memories/${enc(file)}/pin`, { pinned }),
  listLife: () => request("GET", "/api/lin/life"),
  saveLife: (file, content) => request("PUT", `/api/lin/life/${enc(file)}`, { content }),

  getProfile: () => request("GET", "/api/lin/profile"),
  listMoments: () => request("GET", "/api/lin/moments"),
  toggleLike: (id) => request("POST", `/api/lin/moments/${enc(id)}/like`, {}),
  addComment: (id, text) => request("POST", `/api/lin/moments/${enc(id)}/comments`, { text }),
  deleteComment: (id, commentId) => request("DELETE", `/api/lin/moments/${enc(id)}/comments/${enc(commentId)}`),
  tickMoments: (force) => request("POST", `/api/lin/moments/tick${force ? `?force=${enc(force)}` : ""}`, {}),

  getChannels: () => request("GET", "/api/lin/channels"),
  saveChannels: (patch) => request("PUT", "/api/lin/channels", patch),
  testChannel: (id) => request("POST", `/api/lin/channels/${enc(id)}/test`, {}),
  getLan: () => request("GET", "/api/lin/lan"),

  getArchive: () => request("GET", "/api/lin/archive"),
  restoreArchive: (day, confirm) => request("POST", "/api/lin/archive/restore", { day, confirm }),
  deleteArchiveBefore: (day) => request("DELETE", `/api/lin/archive/before/${enc(day)}`),

  getInner: () => request("GET", "/api/lin/inner"),
  getBody: () => request("GET", "/api/lin/body"),
  getThoughts: () => request("GET", "/api/lin/thoughts"),
  getStatus: () => request("GET", "/api/lin/status"),
};

/**
 * 订阅服务端事件。返回关闭函数。
 * @param {{ onEvent: (type: string, data: any) => void, onOpen?: (reconnected: boolean) => void, onDown?: () => void }} handlers
 */
export function connectEvents(handlers) {
  const types = ["message", "typing", "delta", "turn_done", "turn_error", "profile", "archive", "settings", "ready"];
  let source = null;
  let closed = false;
  let hadError = false;
  let everOpened = false;
  let retryTimer;

  const open = () => {
    if (closed) return;
    source = new EventSource("/api/lin/events", { withCredentials: true });
    source.addEventListener("open", () => {
      handlers.onOpen?.(everOpened && hadError);
      everOpened = true;
      hadError = false;
    });
    source.addEventListener("error", () => {
      hadError = true;
      handlers.onDown?.();
      // 浏览器放弃重连（例如 401）时，自己隔一会儿重开。
      if (source && source.readyState === EventSource.CLOSED) {
        source = null;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(open, RECONNECT_DELAY_MS);
      }
    });
    for (const type of types) {
      source.addEventListener(type, (event) => {
        let data = null;
        try {
          data = JSON.parse(event.data);
        } catch {
          data = event.data;
        }
        handlers.onEvent(type, data);
      });
    }
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retryTimer);
    source?.close();
  };
}
