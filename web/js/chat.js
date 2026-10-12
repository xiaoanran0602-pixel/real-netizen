// 聊天页：顶栏（名字 + 状态）、气泡与时间分隔、拆气泡、正在输入/逐字出现、发送与失败重发、
// 复制 / 删除（本机隐藏）/ 2 分钟内撤回、往前翻历史。数据层见 chat-data.js。
import { copy } from "./copy.js";
import { hiddenIds, loadOlder, recalledIds, hideMessage, recallMessage, send } from "./chat-data.js";
import { companionName, state, subscribe } from "./store.js";
import { avatar, formatChatTime, h, mount, toast, topbar } from "./ui.js";

const TIME_GAP_MS = 5 * 60_000;
const RECALL_WINDOW_MS = 2 * 60_000;
const LONG_PRESS_MS = 500;
const MENU_WIDTH = 140;

/** 她的一次回复按空行拆成多个气泡，更像真人连发几条。 */
export function splitIntoBubbles(text, split) {
  if (!split) return [text];
  const parts = text.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

function headerStatus() {
  if (state.connection === "reconnecting") return copy.disconnected;
  if (state.connection === "failed") return copy.bootFailed;
  if (state.connection !== "ready") return copy.connecting;
  if (state.typing || state.streamingText) return copy.typing;
  return state.status;
}

function herAvatar() {
  return avatar({ name: companionName(), color: state.settings.avatarColor, src: state.profile.avatar });
}

function openMenu(message, x, y) {
  const backdrop = h("div", { class: "lin-menu-backdrop", onClick: () => backdrop.remove() });
  const run = (action) => (event) => {
    event.stopPropagation();
    action();
    backdrop.remove();
  };
  const canRecall = message.role === "user" && Date.now() - message.at < RECALL_WINDOW_MS && message.id;
  const menu = h(
    "div",
    { class: "lin-menu", style: { left: `${Math.min(x, window.innerWidth - MENU_WIDTH)}px`, top: `${Math.min(y, window.innerHeight - MENU_WIDTH)}px` }, onClick: (event) => event.stopPropagation() },
    h("button", { type: "button", onClick: run(() => { void navigator.clipboard?.writeText(message.text); toast(copy.copied); }) }, copy.copyText),
    canRecall ? h("button", { type: "button", onClick: run(() => recallMessage(message.id)) }, copy.recall) : null,
    message.id ? h("button", { type: "button", onClick: run(() => hideMessage(message.id)) }, copy.deleteText) : null,
  );
  backdrop.append(menu);
  document.body.append(backdrop);
}

function bindMenu(el, message) {
  let timer;
  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMenu(message, event.clientX, event.clientY);
  });
  el.addEventListener("touchstart", (event) => {
    const touch = event.touches[0];
    if (!touch) return;
    const { clientX, clientY } = touch;
    timer = setTimeout(() => openMenu(message, clientX, clientY), LONG_PRESS_MS);
  }, { passive: true });
  el.addEventListener("touchend", () => clearTimeout(timer));
  el.addEventListener("touchmove", () => clearTimeout(timer), { passive: true });
}

/**
 * 一条消息（可能拆成几个气泡）。
 * @param {{id?: string, role: string, text: string, at: number}} message
 * @param {{status?: "sending"|"failed", onRetry?: () => void}} extra
 */
function messageRows(message, extra) {
  const mine = message.role === "user";
  const bubbles = mine ? [message.text] : splitIntoBubbles(message.text, state.settings.splitBubbles !== false);
  return bubbles.map((text) => {
    const bubble = h("div", { class: `lin-bubble ${mine ? "lin-bubble-me" : "lin-bubble-her"} ${extra.status === "sending" ? "lin-bubble-sending" : ""}` }, text);
    bindMenu(bubble, message);
    return h(
      "div",
      { class: `lin-row ${mine ? "lin-row-me" : "lin-row-her"}` },
      mine ? null : herAvatar(),
      mine && extra.status === "failed" ? h("button", { type: "button", class: "lin-failed", title: copy.sendFailed, onClick: extra.onRetry }, "!") : null,
      bubble,
    );
  });
}

function renderList(container) {
  const hidden = hiddenIds();
  const recalled = recalledIds();
  const nodes = [];
  if (state.hasMore) nodes.push(h("button", { type: "button", class: "lin-load-more", onClick: () => void loadOlder() }, copy.loadMore));
  const visible = state.messages.filter((message) => !hidden.has(message.id));
  if (visible.length === 0 && state.pending.length === 0 && state.connection === "ready") nodes.push(h("div", { class: "lin-time-divider" }, copy.firstHello));
  let lastAt = 0;
  const divider = (at) => {
    const show = at - lastAt > TIME_GAP_MS;
    lastAt = at;
    return show ? h("div", { class: "lin-time-divider" }, formatChatTime(at)) : null;
  };
  for (const message of visible) {
    nodes.push(divider(message.at));
    if (recalled.has(message.id)) {
      nodes.push(h("div", { class: "lin-time-divider" }, copy.recalled));
      continue;
    }
    const failed = state.failed.has(message.id);
    const sending = state.resending.has(message.id);
    nodes.push(...messageRows(message, {
      status: failed ? "failed" : sending ? "sending" : undefined,
      onRetry: () => void send(message.text, { messageId: message.id }),
    }));
    if (failed) nodes.push(h("div", { class: "lin-time-divider" }, copy.notDelivered));
  }
  for (const item of state.pending) {
    nodes.push(divider(item.at));
    nodes.push(...messageRows({ role: "user", text: item.text, at: item.at }, { status: item.status, onRetry: () => void send(item.text, { clientId: item.clientId }) }));
  }
  mount(container, ...nodes);
}

function renderTail(container) {
  if (state.streamingText && state.settings.replyMode === "stream") {
    mount(container, h("div", { class: "lin-row lin-row-her" }, herAvatar(), h("div", { class: "lin-bubble lin-bubble-her" }, state.streamingText)));
  } else if (state.typing || state.streamingText) {
    mount(container, h("div", { class: "lin-row lin-row-her" }, herAvatar(), h("div", { class: "lin-bubble lin-bubble-her lin-typing-dots", "aria-label": copy.typing }, h("span"), h("span"), h("span"))));
  } else {
    container.replaceChildren();
  }
}

/**
 * @param {HTMLElement} container
 * @param {{onBack?: () => void}} options
 * @returns {() => void} 清理函数
 */
export function renderChat(container, { onBack }) {
  let header = h("div");
  const list = h("div");
  const tail = h("div");
  const scroller = h("div", { class: "lin-messages" }, list, tail);
  const input = h("textarea", { class: "lin-input", rows: "1", placeholder: copy.inputPlaceholder });
  const sendButton = h("button", { type: "button", class: "lin-send", disabled: true }, copy.send);

  const submit = () => {
    const text = input.value.trim();
    if (!text || state.connection !== "ready" || state.archive?.status === "running") return;
    input.value = "";
    sendButton.disabled = true;
    void send(text);
  };
  input.addEventListener("input", () => (sendButton.disabled = !input.value.trim()));
  input.addEventListener("keydown", (event) => {
    // 电脑上回车发送、Shift+回车换行；输入法组字时不发送。
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  sendButton.addEventListener("click", submit);

  mount(container, header, scroller, h("footer", { class: "lin-composer" }, input, sendButton));

  let listKey = "";
  let tailKey = "";
  let headerKey = "";
  const draw = () => {
    const nextHeader = `${companionName()}|${headerStatus()}`;
    if (nextHeader !== headerKey) {
      headerKey = nextHeader;
      const next = topbar({ title: companionName(), status: headerStatus(), onBack });
      header.replaceWith(next);
      header = next;
    }
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    const nextList = [state.messages.length, state.messages.at(-1)?.id, state.messages[0]?.id, state.pending.map((p) => `${p.clientId}:${p.status}`).join(","), [...state.failed].join(","), [...state.resending].join(","), state.hasMore, state.settings.splitBubbles, state.profile.avatar, localStorage.getItem("lin-hidden-messages"), localStorage.getItem("lin-recalled-messages")].join("|");
    let changed = false;
    if (nextList !== listKey) {
      listKey = nextList;
      renderList(list);
      changed = true;
    }
    const nextTail = `${state.typing}|${state.streamingText.length}|${state.settings.replyMode}`;
    if (nextTail !== tailKey) {
      tailKey = nextTail;
      renderTail(tail);
      changed = true;
    }
    const restoring = state.archive?.status === "running";
    input.disabled = restoring;
    input.placeholder = restoring ? "正在回档…" : copy.inputPlaceholder;
    if (changed && atBottom) scroller.scrollTop = scroller.scrollHeight;
  };
  draw();
  scroller.scrollTop = scroller.scrollHeight;
  return subscribe(draw);
}
