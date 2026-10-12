// 设置页：分组列表 + 进入各组。每组一个模块，导出 render(container) → 清理函数（可选）。
import { copy } from "../copy.js";
import { h, mount, topbar } from "../ui.js";
import { renderAdvanced } from "./advanced.js";
import { renderArchive } from "./archive.js";
import { renderChannels } from "./channels.js";
import { renderChatSettings } from "./chat.js";
import { renderData } from "./data.js";
import { renderHer } from "./her.js";
import { renderLife } from "./life.js";
import { renderLook } from "./look.js";
import { renderMemories } from "./memories.js";
import { renderModel } from "./model.js";
import { renderMomentsSettings } from "./moments.js";
import { renderPhone } from "./phone.js";
import { renderYou } from "./you.js";

const GROUPS = {
  her: renderHer,
  moments: renderMomentsSettings,
  channels: renderChannels,
  life: renderLife,
  memories: renderMemories,
  archive: renderArchive,
  you: renderYou,
  chat: renderChatSettings,
  model: renderModel,
  look: renderLook,
  phone: renderPhone,
  data: renderData,
  advanced: renderAdvanced,
};

/**
 * @param {HTMLElement} container
 * @param {{onBack: () => void, initialGroup?: string | null}} options
 */
export function renderSettings(container, { onBack, initialGroup }) {
  let cleanup;
  const body = h("div", { class: "lin-page-body" });
  const show = (group) => {
    cleanup?.();
    cleanup = undefined;
    const title = group ? copy.settingsGroups[group] : copy.settings;
    const back = () => (group && !initialGroup ? show(null) : onBack());
    if (!group) {
      mount(
        body,
        h(
          "div",
          { class: "lin-list" },
          Object.entries(copy.settingsGroups).map(([key, label]) =>
            h("button", { type: "button", class: "lin-list-item", onClick: () => show(key) }, h("span", null, label), h("span", { class: "lin-list-chevron" }, "›")),
          ),
        ),
      );
    } else {
      const panel = h("div");
      mount(body, panel);
      cleanup = GROUPS[group]?.(panel);
    }
    mount(container, topbar({ title, onBack: back }), body);
  };
  show(initialGroup ?? null);
  return () => cleanup?.();
}
