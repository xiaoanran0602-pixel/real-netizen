// 设置页公用：按字段描述生成表单，保存只提交改过的字段。
import { api } from "../api.js";
import { reloadSettings } from "../chat-data.js";
import { copy } from "../copy.js";
import { state } from "../store.js";
import { errorText, field, h, statusLine } from "../ui.js";

export const LEVEL_OPTIONS = [
  { value: "off", label: "关闭（不带推理参数）" },
  { value: "low", label: "low（像随口聊天）" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high（更深思熟虑，回得慢、长）" },
];

/** 一个控件 + 读值函数。 */
export function control(spec, value) {
  if (spec.kind === "toggle") {
    const el = h("input", { type: "checkbox", checked: value !== false });
    return { el, read: () => el.checked };
  }
  if (spec.kind === "color") {
    const el = h("input", { type: "color", value: String(value ?? "#7c6fb0") });
    return { el, read: () => el.value };
  }
  if (spec.kind === "number") {
    const el = h("input", { class: "lin-text-input", type: "number", value: String(value ?? ""), min: spec.min, max: spec.max });
    return { el, read: () => Number(el.value) };
  }
  if (spec.kind === "range") {
    const label = h("span", { class: "lin-field-hint" }, String(value ?? spec.min));
    const input = h("input", { class: "lin-range", type: "range", min: spec.min, max: spec.max, step: spec.step ?? 1, value: String(value ?? spec.min) });
    input.addEventListener("input", () => (label.textContent = input.value));
    return { el: h("div", null, input, label), read: () => Number(input.value) };
  }
  if (spec.kind === "select") {
    const el = h("select", { class: "lin-text-input" }, spec.options.map((option) => h("option", { value: option.value, selected: String(value) === option.value }, option.label)));
    return { el, read: () => el.value };
  }
  const el = h("input", { class: "lin-text-input", type: spec.kind === "password" ? "password" : "text", value: String(value ?? ""), autocomplete: "off", placeholder: spec.placeholder });
  return { el, read: () => el.value };
}

/**
 * settings.json 字段表单。
 * @param {{key: string, label: string, kind: string, options?: any[], hint?: string, min?: number, max?: number}[]} fields
 */
export function settingsForm(fields) {
  const controls = fields.map((spec) => ({ spec, ...control(spec, state.settings[spec.key]) }));
  const status = statusLine();
  const save = async () => {
    const patch = {};
    for (const { spec, read } of controls) {
      const value = read();
      if (value !== state.settings[spec.key]) patch[spec.key] = value;
    }
    if (Object.keys(patch).length === 0) return status.set(copy.saved);
    try {
      await api.saveSettings(patch);
      await reloadSettings();
      status.set(copy.saved);
    } catch (error) {
      status.set(errorText(error));
    }
  };
  return h(
    "div",
    { class: "lin-form" },
    controls.map(({ spec, el }) => field(spec.label, el, spec.hint)),
    h("div", { class: "lin-form-actions" }, h("button", { type: "button", class: "lin-primary", onClick: () => void save() }, copy.save), status.el),
  );
}

/** 跑一个异步操作，期间禁用按钮并显示进度。 */
export async function runBusy(buttons, status, label, work) {
  for (const button of buttons) button.disabled = true;
  status.set(`${label}…`);
  try {
    status.set(await work());
  } catch (error) {
    status.set(errorText(error));
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}
