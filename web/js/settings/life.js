// 设置 →「她的日子」：今年、这个月、这一周、今天的日程，以及她对以后的想法。
// 过去的和今天已经定下的只能看；未来的安排和「以后的想法」可以改。另有「她会生病」与依赖强度。
import { api } from "../api.js";
import { copy } from "../copy.js";
import { errorText, h, mount, statusLine } from "../ui.js";
import { settingsForm } from "./form.js";

const LIFE_LABELS = [
  [/^future\.md$/u, () => "她对以后的想法"],
  [/^year-(\d{4})\.md$/u, (m) => `${m[1]} 年`],
  [/^month-(\d{4})-(\d{2})\.md$/u, (m) => `${m[1]} 年 ${Number(m[2])} 月`],
  [/^week-(\d{4})-W(\d{2})\.md$/u, (m) => `${m[1]} 年第 ${Number(m[2])} 周`],
  [/^day-(\d{4})-(\d{2})-(\d{2})\.md$/u, (m) => `${Number(m[2])} 月 ${Number(m[3])} 日`],
];

function labelOf(file) {
  for (const [pattern, label] of LIFE_LABELS) {
    const match = pattern.exec(file);
    if (match) return label(match);
  }
  return file;
}

function orderOf(file) {
  if (file === "future.md") return 0;
  if (file.startsWith("day-")) return 1;
  if (file.startsWith("week-")) return 2;
  if (file.startsWith("month-")) return 3;
  return 4;
}

export function renderLife(container) {
  const list = h("div", { class: "lin-form" }, "…");
  const options = settingsForm([
    { key: "canGetSick", label: "她会生病", kind: "toggle", hint: "关掉后不再掷骰（感冒、加班周、假期）。" },
    { key: "sickMissCap", label: "生病时有多依赖你", kind: "range", min: 70, max: 95, hint: "生病期间想念的上限，平时是 70。" },
    { key: "dayBoundaryHour", label: "一天从几点算起（0–6）", kind: "number", min: 0, max: 6, hint: "凌晨这个点之前的聊天算前一天；每天的整理和存档也在这个点。" },
  ]);

  const open = (file, reload) => {
    const status = statusLine();
    if (!file.editable) {
      mount(list, h("span", { class: "lin-field-label" }, labelOf(file.file)), h("div", { class: "lin-readonly" }, file.content), h("span", { class: "lin-field-hint" }, "已经过去或已经定下的日子，只能看，不能改。"), h("div", { class: "lin-form-actions" }, h("button", { type: "button", class: "lin-secondary", onClick: reload }, copy.back)));
      return;
    }
    const area = h("textarea", { class: "lin-text-area", value: file.content });
    const save = () =>
      void api
        .saveLife(file.file, area.value)
        .then(() => status.set(copy.saved))
        .catch((error) => status.set(errorText(error)));
    mount(list, h("span", { class: "lin-field-label" }, labelOf(file.file)), area, h("div", { class: "lin-form-actions" }, h("button", { type: "button", class: "lin-primary", onClick: save }, copy.save), h("button", { type: "button", class: "lin-secondary", onClick: reload }, copy.back), status.el));
  };

  const load = async () => {
    const response = await api.listLife().catch(() => ({ files: [] }));
    const files = [...(response.files ?? [])].sort((a, b) => orderOf(a.file) - orderOf(b.file) || b.file.localeCompare(a.file));
    if (files.length === 0) {
      mount(list, h("span", { class: "lin-field-hint" }, "每天第一次聊天时，她会把当天的日子安排好。"));
      return;
    }
    mount(
      list,
      files.map((file) =>
        h(
          "button",
          { type: "button", class: "lin-memory-item", onClick: () => open(file, () => void load()) },
          h("span", { class: "lin-memory-meta" }, `${labelOf(file.file)}${file.editable ? "" : " · 只读"}`),
          h("span", { class: "lin-memory-text" }, file.content),
        ),
      ),
    );
  };
  mount(container, list, options);
  void load();
}
