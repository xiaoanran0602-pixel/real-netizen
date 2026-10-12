// 设置 →「外观」：主题与字号。
import { mount } from "../ui.js";
import { settingsForm } from "./form.js";

export function renderLook(container) {
  mount(
    container,
    settingsForm([
      { key: "theme", label: "主题", kind: "select", options: [{ value: "system", label: "跟随系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" }] },
      { key: "fontSize", label: "字号（12–22）", kind: "number", min: 12, max: 22 },
    ]),
  );
}
