// 设置 →「你」：她怎么称呼你。
import { mount } from "../ui.js";
import { settingsForm } from "./form.js";

export function renderYou(container) {
  mount(container, settingsForm([{ key: "userName", label: "她怎么称呼你", kind: "text" }]));
}
