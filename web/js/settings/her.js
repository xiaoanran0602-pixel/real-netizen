// 设置 →「她」：名字、默认签名、默认头像颜色、人设；基石记忆只读展示。
import { api } from "../api.js";
import { copy } from "../copy.js";
import { errorText, field, h, mount, statusLine } from "../ui.js";
import { settingsForm } from "./form.js";

export function renderHer(container) {
  const persona = h("textarea", { class: "lin-text-area" });
  const core = h("div", { class: "lin-readonly" }, "…");
  const status = statusLine();
  void api.getPersona().then((response) => (persona.value = response.persona ?? ""));
  void api.getCore().then((response) => (core.textContent = response.core || "（还没有）")).catch(() => (core.textContent = "（读取失败）"));
  const save = () =>
    void api
      .savePersona(persona.value)
      .then(() => status.set(copy.saved))
      .catch((error) => status.set(errorText(error)));
  mount(
    container,
    settingsForm([
      { key: "companionName", label: "名字", kind: "text" },
      { key: "signature", label: "默认签名", kind: "text", hint: "她自己换过签名后，以她换的为准。" },
      { key: "avatarColor", label: "默认头像颜色", kind: "color", hint: "她还没换过头像时用这个颜色。" },
    ]),
    h(
      "div",
      { class: "lin-form" },
      field("人设", persona, "保存后从下一句话开始生效"),
      h("div", { class: "lin-form-actions" }, h("button", { type: "button", class: "lin-primary", onClick: save }, copy.save), status.el),
    ),
    h("div", { class: "lin-form" }, field("她心里最底下的东西（只读）", core, "data/core.md，只能手改文件。")),
  );
}
