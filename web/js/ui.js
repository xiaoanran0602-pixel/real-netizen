// 小型 DOM 帮助函数：h(tag, props, ...children) 直接造节点，不引入框架。
import { copy } from "./copy.js";

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const DAY_MS = 86_400_000;
const TOAST_MS = 1500;

/**
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class" || key === "className") el.className = value;
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "value" || key === "checked" || key === "disabled" || key === "selected") el[key] = value;
    else if (key === "ref" && typeof value === "function") value(el);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** 清空并放入新内容。 */
export function mount(container, ...children) {
  container.replaceChildren();
  append(container, children);
}

export function formatChatTime(at, now = Date.now()) {
  const date = new Date(at);
  const today = new Date(now);
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dayDiff = Math.floor((startOfToday - at) / DAY_MS) + 1;
  if (at >= startOfToday) return hm;
  if (dayDiff === 1) return `昨天 ${hm}`;
  if (dayDiff < 7) return `${WEEKDAYS[date.getDay()]} ${hm}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}

/** 头像：换过头像显示图，否则主色色块 + 名字第一个字。 */
export function avatar({ name, color, src, size = 38 }) {
  if (src) {
    return h("img", { class: "lin-avatar lin-avatar-image", src, alt: "", "aria-hidden": "true", style: { width: `${size}px`, height: `${size}px` } });
  }
  return h(
    "div",
    { class: "lin-avatar", "aria-hidden": "true", style: { background: color || "#7c6fb0", width: `${size}px`, height: `${size}px` } },
    Array.from(name || copy.defaultName)[0] ?? "林",
  );
}

export function toast(text) {
  const el = h("div", { class: "lin-toast" }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), TOAST_MS);
}

export function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = h("a", { href: url, download: filename });
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 顶栏：左边返回（可选），中间标题和副标题。 */
export function topbar({ title, status, onBack, right }) {
  return h(
    "header",
    { class: "lin-topbar" },
    onBack ? h("button", { type: "button", class: "lin-icon-button", onClick: onBack, "aria-label": copy.back }, "‹") : h("span", { class: "lin-topbar-spacer" }),
    h("div", { class: "lin-topbar-title" }, h("div", { class: "lin-topbar-name" }, title), status ? h("div", { class: "lin-topbar-status" }, status) : null),
    right ?? h("span", { class: "lin-topbar-spacer" }),
  );
}

/** 表单项：标签 + 控件 + 提示。 */
export function field(label, control, hint) {
  return h("label", { class: "lin-field" }, h("span", { class: "lin-field-label" }, label), control, hint ? h("span", { class: "lin-field-hint" }, hint) : null);
}

/** 状态提示行，返回 {el, set(text)}。 */
export function statusLine() {
  const el = h("span", { class: "lin-field-hint" });
  return { el, set: (text) => (el.textContent = text ?? "") };
}

export function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
