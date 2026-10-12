// 聊天数据层：加载历史、处理 SSE 事件、发送与重发、断线补齐、本地删除与撤回标记。
// 删除/撤回只记在本机浏览器（每台设备各自记），她仍然记得。
import { api, ApiError, connectEvents } from "./api.js";
import { setState, state } from "./store.js";

const HISTORY_PAGE = 200;
const HIDDEN_KEY = "lin-hidden-messages";
const RECALL_KEY = "lin-recalled-messages";
const TYPING_DELAY_MIN_MS = 500;
const TYPING_DELAY_MAX_MS = 1_500;
const PROFILE_REFRESH_MS = 5 * 60_000;
const STATUS_REFRESH_MS = 60_000;

let typingTimer;

export function readIdSet(key) {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]"));
  } catch {
    return new Set();
  }
}

function writeIdSet(key, ids) {
  localStorage.setItem(key, JSON.stringify([...ids]));
}

export function hiddenIds() {
  return readIdSet(HIDDEN_KEY);
}

export function recalledIds() {
  return readIdSet(RECALL_KEY);
}

export function hideMessage(id) {
  const ids = readIdSet(HIDDEN_KEY);
  ids.add(id);
  writeIdSet(HIDDEN_KEY, ids);
  setState({ messages: state.messages.slice() });
}

export function recallMessage(id) {
  const ids = readIdSet(RECALL_KEY);
  ids.add(id);
  writeIdSet(RECALL_KEY, ids);
  setState({ messages: state.messages.slice() });
}

function upsert(list, message) {
  const index = list.findIndex((item) => item.id === message.id);
  if (index >= 0) {
    const next = list.slice();
    next[index] = message;
    return next;
  }
  const next = [...list, message];
  next.sort((a, b) => a.at - b.at);
  return next;
}

export async function reloadSettings() {
  const response = await api.getSettings();
  setState({ settings: response.settings ?? {} });
}

export async function reloadProfile() {
  const profile = await api.getProfile().catch(() => null);
  if (profile) setState({ profile });
}

export async function reloadStatus() {
  const status = await api.getStatus().catch(() => null);
  setState({ status: status?.text ?? null });
}

export async function loadHistory() {
  const response = await api.history({ limit: HISTORY_PAGE });
  setState({
    conversationId: response.conversationId ?? null,
    messages: response.messages ?? [],
    hasMore: Boolean(response.hasMore),
    failed: new Set(response.failed ?? []),
    resending: new Set(),
  });
}

export async function loadOlder() {
  const first = state.messages[0];
  if (!first) return;
  const response = await api.history({ limit: HISTORY_PAGE, before: first.id });
  setState({ messages: [...(response.messages ?? []), ...state.messages], hasMore: Boolean(response.hasMore) });
}

/** 断线重连或切回前台：按最后一条消息 id 补齐；对不上（回档、新对话）就整页重载。 */
export async function syncMissed() {
  const last = state.messages.at(-1);
  if (!last) return loadHistory();
  const response = await api.history({ after: last.id, limit: HISTORY_PAGE });
  if (response.reset || response.conversationId !== state.conversationId) return loadHistory();
  let messages = state.messages;
  for (const message of response.messages ?? []) messages = upsert(messages, message);
  setState({ messages, failed: new Set(response.failed ?? [...state.failed]) });
}

function setTyping(on) {
  clearTimeout(typingTimer);
  if (!on) {
    setState({ typing: false });
    return;
  }
  // 「对方正在输入…」先停一下，像她看到消息再开始打字。
  const delay = state.settings.typingDelay === false ? 0 : TYPING_DELAY_MIN_MS + Math.random() * (TYPING_DELAY_MAX_MS - TYPING_DELAY_MIN_MS);
  typingTimer = setTimeout(() => setState({ typing: true }), delay);
}

function onEvent(type, data) {
  switch (type) {
    case "message": {
      if (data.conversationId && state.conversationId && data.conversationId !== state.conversationId) return;
      const { clientId, conversationId: _ignored, ...message } = data;
      const pending = clientId ? state.pending.filter((item) => item.clientId !== clientId) : state.pending;
      const resending = new Set(state.resending);
      resending.delete(message.id);
      const patch = { messages: upsert(state.messages, message), pending, resending };
      if (message.role === "assistant") {
        clearTimeout(typingTimer);
        Object.assign(patch, { typing: false, streamingText: "" });
      }
      setState(patch);
      break;
    }
    case "typing":
      setTyping(Boolean(data?.on));
      break;
    case "delta":
      setState({ streamingText: state.streamingText + (data?.text ?? "") });
      break;
    case "turn_done":
      setTyping(false);
      setState({ streamingText: "" });
      break;
    case "turn_error": {
      setTyping(false);
      const failed = new Set(state.failed);
      if (data?.replyTo) failed.add(data.replyTo);
      const resending = new Set(state.resending);
      if (data?.replyTo) resending.delete(data.replyTo);
      setState({ failed, resending, streamingText: "" });
      break;
    }
    case "profile":
      if (data) setState({ profile: data });
      break;
    case "settings":
      void reloadSettings();
      break;
    case "archive":
      setState({ archive: data });
      if (data?.status === "done") {
        void loadHistory();
        void reloadProfile();
      }
      break;
    default:
      break;
  }
}

/** 启动：先拉设置和历史，再连 SSE。 */
export async function startChat() {
  try {
    await Promise.all([reloadSettings(), reloadProfile(), loadHistory()]);
  } catch (error) {
    setState({ connection: error instanceof ApiError && error.status === 401 ? "unauthorized" : "failed" });
    throw error;
  }
  connectEvents({
    onEvent,
    onOpen: (reconnected) => {
      setState({ connection: "ready" });
      if (reconnected) void syncMissed().catch(() => undefined);
    },
    onDown: () => {
      if (state.connection === "ready") setState({ connection: "reconnecting" });
    },
  });
  void reloadStatus();
  setInterval(() => void reloadProfile(), PROFILE_REFRESH_MS);
  setInterval(() => void reloadStatus(), STATUS_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void syncMissed().catch(() => undefined);
    void reloadProfile();
    void reloadStatus();
  });
}

function newClientId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 发一句话。retry 可以是本地失败的 pending（没到服务端），也可以是服务端已存但她没回成的消息 id。
 * @param {string} text
 * @param {{clientId?: string, messageId?: string}} [retry]
 */
export async function send(text, retry) {
  const content = text.trim();
  if (!content) return;
  if (retry?.messageId) {
    const failed = new Set(state.failed);
    failed.delete(retry.messageId);
    const resending = new Set(state.resending);
    resending.add(retry.messageId);
    setState({ failed, resending });
  }
  const clientId = retry?.clientId ?? newClientId();
  if (!retry?.messageId) {
    const pending = state.pending.filter((item) => item.clientId !== clientId);
    pending.push({ clientId, role: "user", text: content, at: Date.now(), status: "sending" });
    setState({ pending });
  }
  try {
    await api.send(content, clientId);
  } catch {
    if (retry?.messageId) {
      const failed = new Set(state.failed);
      failed.add(retry.messageId);
      const resending = new Set(state.resending);
      resending.delete(retry.messageId);
      setState({ failed, resending });
    } else {
      setState({ pending: state.pending.map((item) => (item.clientId === clientId ? { ...item, status: "failed" } : item)) });
    }
  }
}

export async function startNewConversation() {
  await api.newConversation();
  setState({ pending: [], streamingText: "", typing: false });
  await loadHistory();
}
