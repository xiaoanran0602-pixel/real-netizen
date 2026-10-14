// 设置 →「高级」：对话 ID、数据目录、念头池开关、她的内心（只读调试面板，见 inner.js）。
import { api } from "../api.js";
import { state } from "../store.js";
import { h, mount } from "../ui.js";
import { settingsForm } from "./form.js";
import { renderInner } from "./inner.js";

export function renderAdvanced(container) {
  const info = h("div", { class: "lin-form" }, h("span", { class: "lin-field-hint" }, `对话 ID：${state.conversationId ?? "-"}`));
  const engine = settingsForm([
    { key: "thoughtsEnabled", label: "念头池", kind: "toggle", hint: "她心里挂着的具体事情：会影响她接什么话、什么时候忍不住找你。" },
  ]);
  const inner = h("div");
  mount(container, info, engine, inner);
  void api
    .getSettings()
    .then((response) => {
      if (response.dataDir) info.append(h("span", { class: "lin-field-hint" }, `数据目录：${response.dataDir}`));
      if (response.dry) info.append(h("span", { class: "lin-field-hint" }, "现在是演练模式（--dry）：不发聊天渠道消息、不跑动态调度。"));
    })
    .catch(() => undefined);
  return renderInner(inner);
}
