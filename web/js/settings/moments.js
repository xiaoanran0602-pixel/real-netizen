// 设置 →「她的动态」：她住哪、要不要自己发朋友圈换头像，以及手动让她现在就做一次（调试用）。
import { api } from "../api.js";
import { reloadProfile } from "../chat-data.js";
import { companionName, state } from "../store.js";
import { avatar, h, mount, statusLine } from "../ui.js";
import { runBusy, settingsForm } from "./form.js";

const ACTION_LABELS = { post: "发了一条朋友圈", avatar: "换了头像", signature: "换了签名", none: "这次没想做什么" };

export function renderMomentsSettings(container) {
  const status = statusLine();
  const buttons = [];
  const trigger = (force, label) => {
    const button = h("button", { type: "button", class: "lin-secondary" }, label);
    button.addEventListener("click", () =>
      void runBusy(buttons, status, "她在找", async () => {
        const result = await api.tickMoments(force);
        await reloadProfile();
        return ACTION_LABELS[result.action] ?? `${result.action}（${result.detail ?? ""}）`;
      }),
    );
    buttons.push(button);
    return button;
  };
  mount(
    container,
    h(
      "div",
      { class: "lin-form" },
      h(
        "div",
        { class: "lin-moments-preview" },
        avatar({ name: companionName(), color: state.settings.avatarColor, src: state.profile.avatar, size: 56 }),
        h(
          "div",
          null,
          h("div", { class: "lin-field-label" }, companionName()),
          h("div", { class: "lin-field-hint" }, state.profile.signature ?? state.settings.signature ?? ""),
          state.profile.currentCity ? h("div", { class: "lin-field-hint" }, `这几天在${state.profile.currentCity}`) : null,
        ),
      ),
    ),
    settingsForm([
      { key: "city", label: "她住在哪个城市", kind: "text", hint: "天气按这个城市取。她出差或旅行时会自己换到所在城市。" },
      { key: "momentsEnabled", label: "让她自己发朋友圈、换头像和签名", kind: "toggle", hint: "她会在随机的时候，看心情、天气、新闻和你们聊的天，自己决定要不要发。大多数时候她什么都不发。" },
    ]),
    h(
      "div",
      { class: "lin-form" },
      h("span", { class: "lin-field-label" }, "现在就让她…"),
      h("div", { class: "lin-form-actions" }, trigger("post", "发条朋友圈"), trigger("avatar", "换个头像"), trigger("signature", "换个签名")),
      status.el,
    ),
  );
}
