// 设置 →「聊天」：回复出现方式、停顿、拆气泡、开始新对话。
import { startNewConversation } from "../chat-data.js";
import { errorText, h, mount, statusLine } from "../ui.js";
import { settingsForm } from "./form.js";

export function renderChatSettings(container) {
  const status = statusLine();
  const startNew = () => {
    if (!window.confirm("开始一段新对话？旧对话保留，她记得的事不受影响。")) return;
    void startNewConversation()
      .then(() => status.set("已经开始新对话"))
      .catch((error) => status.set(errorText(error)));
  };
  mount(
    container,
    settingsForm([
      { key: "replyMode", label: "回复出现方式", kind: "select", options: [{ value: "whole", label: "整段出现" }, { value: "stream", label: "逐字出现" }] },
      { key: "typingDelay", label: "「对方正在输入…」前停顿一下", kind: "toggle" },
      { key: "splitBubbles", label: "一次回复拆成多个气泡", kind: "toggle" },
    ]),
    h(
      "div",
      { class: "lin-form" },
      h("span", { class: "lin-field-label" }, "开始新对话"),
      h("span", { class: "lin-field-hint" }, "旧对话保留；她记得的事不受影响。"),
      h("div", { class: "lin-form-actions" }, h("button", { type: "button", class: "lin-secondary", onClick: startNew }, "开始新对话"), status.el),
    ),
  );
}
