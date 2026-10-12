// 网页状态：一个对象 + 订阅。视图模块订阅后自己更新局部 DOM，外壳只在切页时重画。

const listeners = new Set();

export const state = {
  /** connecting | ready | reconnecting | failed | unauthorized */
  connection: "connecting",
  settings: {},
  profile: { avatar: null, signature: null, currentCity: null },
  conversationId: null,
  /** 服务端消息：{id, role:'user'|'assistant', text, at, source} */
  messages: [],
  /** 还没被服务端确认的本地消息：{clientId, role:'user', text, at, status:'sending'|'failed'} */
  pending: [],
  /** 发出去但她没回成的消息 id（服务端也会在 history 里给出）。 */
  failed: new Set(),
  /** 正在重发的消息 id。 */
  resending: new Set(),
  hasMore: false,
  typing: false,
  streamingText: "",
  /** 她现在的状态文字（在开会 / 睡了 / 在路上 / 在线）。 */
  status: null,
  /** 回档进度（SSE archive 事件）。 */
  archive: null,
};

export function setState(patch) {
  Object.assign(state, patch);
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (error) {
      console.error(error);
    }
  }
}

/** @param {(s: typeof state) => void} listener */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function companionName() {
  return state.settings.companionName || "林澈";
}

export function userName() {
  return state.settings.userName || "我";
}
