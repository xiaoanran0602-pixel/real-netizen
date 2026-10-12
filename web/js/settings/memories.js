// 设置 →「她记得的事」：按分类查看、修改、删除、新增；显示清晰度（清晰/模糊/沉底）和上次想起，
// 可按清晰度筛选，「让她记牢」开关；模糊的显示概括与原文两栏。
import { api } from "../api.js";
import { CLARITY_LABELS, copy, MEMORY_TYPE_LABELS, MEMORY_TYPE_ORDER } from "../copy.js";
import { errorText, field, h, mount, statusLine } from "../ui.js";
import { parseMemory, serializeMemory, todayText } from "./memory-format.js";

const FILTERS = [["all", "全部"], ["clear", "清晰"], ["blurry", "模糊"], ["sunk", "沉底"], ["pinned", "记牢的"]];

function clarityTag(memory) {
  if (!memory.clarity) return null;
  return h("span", { class: `lin-tag lin-tag-${memory.clarity}` }, CLARITY_LABELS[memory.clarity] ?? memory.clarity);
}

function editor(memory, done) {
  const draft = { ...memory };
  const status = statusLine();
  const typeSelect = h("select", { class: "lin-text-input" }, MEMORY_TYPE_ORDER.map((type) => h("option", { value: type, selected: type === draft.type }, MEMORY_TYPE_LABELS[type])));
  const body = h("textarea", { class: "lin-text-area lin-text-area-short", value: draft.body });
  const description = h("input", { class: "lin-text-input", value: draft.description });
  const expires = h("input", { class: "lin-text-input", type: "date", value: draft.expires ?? "" });
  const closed = h("input", { type: "checkbox", checked: draft.closed });
  const pinned = h("input", { type: "checkbox", checked: Boolean(memory.pinned) });
  const extra = h("div");
  const drawExtra = () => {
    const type = typeSelect.value;
    mount(extra, type === "recent" || type === "self_daily" ? field("有效到", expires) : null, type === "thread" ? field("已经聊完了", closed) : null);
  };
  typeSelect.addEventListener("change", drawExtra);
  drawExtra();
  const save = async () => {
    try {
      const next = { ...draft, type: typeSelect.value, body: body.value, description: description.value || body.value.slice(0, 40), updated: todayText(), expires: expires.value || undefined, closed: closed.checked };
      await api.saveMemory(draft.file, serializeMemory(next));
      if (pinned.checked !== Boolean(memory.pinned)) await api.pinMemory(draft.file, pinned.checked);
      done();
    } catch (error) {
      status.set(errorText(error));
    }
  };
  const remove = async () => {
    if (!window.confirm(copy.confirmDelete)) return;
    try {
      await api.deleteMemory(draft.file);
      done();
    } catch (error) {
      status.set(errorText(error));
    }
  };
  const gistView = memory.clarity === "blurry" && memory.gist
    ? h("div", { class: "lin-two-col" }, field("她现在记得的样子", h("div", { class: "lin-readonly" }, memory.gist)), field("原文", h("div", { class: "lin-readonly" }, memory.body || memory.description)))
    : null;
  return h(
    "div",
    { class: "lin-form" },
    h("span", { class: "lin-memory-meta" }, clarityTag(memory), memory.lastRecalled ? `上次想起 ${memory.lastRecalled}` : ""),
    gistView,
    field("分类", typeSelect),
    field("内容", body),
    field("一句话概括", description),
    extra,
    field("让她记牢", pinned, "记牢的事永远不会低于「模糊」，也更容易被想起。"),
    h(
      "div",
      { class: "lin-form-actions" },
      h("button", { type: "button", class: "lin-primary", onClick: () => void save() }, copy.save),
      h("button", { type: "button", class: "lin-secondary", onClick: done }, copy.cancel),
      h("button", { type: "button", class: "lin-danger", onClick: () => void remove() }, copy.delete),
    ),
    status.el,
  );
}

export function renderMemories(container) {
  let memories = [];
  let filter = "all";
  const status = statusLine();

  const list = () => {
    const today = todayText();
    const shown = memories.filter((memory) => filter === "all" || (filter === "pinned" ? memory.pinned : memory.clarity === filter));
    const groups = new Map();
    for (const memory of shown) {
      if (!groups.has(memory.type)) groups.set(memory.type, []);
      groups.get(memory.type).push(memory);
    }
    for (const items of groups.values()) items.sort((a, b) => (b.updated ?? b.created ?? "").localeCompare(a.updated ?? a.created ?? ""));
    const order = [...MEMORY_TYPE_ORDER, ...[...groups.keys()].filter((key) => !MEMORY_TYPE_ORDER.includes(key))];
    const counts = Object.fromEntries(FILTERS.map(([key]) => [key, key === "all" ? memories.length : memories.filter((m) => (key === "pinned" ? m.pinned : m.clarity === key)).length]));
    const fresh = () => ({ file: `note-${Date.now()}.md`, name: `note-${Date.now()}`, description: "", type: "profile", created: today, updated: today, closed: false, body: "", extraTop: [], extraMeta: [] });
    mount(
      container,
      h(
        "div",
        { class: "lin-form" },
        h("div", { class: "lin-form-actions" }, h("button", { type: "button", class: "lin-primary", onClick: () => mount(container, editor(fresh(), () => void load())) }, copy.add), status.el),
        h("div", { class: "lin-filter" }, FILTERS.map(([key, label]) => h("button", { type: "button", class: filter === key ? "lin-filter-on" : "", onClick: () => { filter = key; list(); } }, `${label} ${counts[key]}`))),
        order.filter((key) => groups.has(key)).map((type) =>
          h(
            "section",
            { class: "lin-memory-group" },
            h("h3", { class: "lin-memory-group-title" }, `${MEMORY_TYPE_LABELS[type] ?? type}（${groups.get(type).length}）`),
            groups.get(type).map((memory) => {
              const expired = memory.expires !== undefined && memory.expires < today;
              const text = memory.clarity === "blurry" && memory.gist ? memory.gist : memory.body || memory.description;
              return h(
                "button",
                { type: "button", class: `lin-memory-item ${expired || memory.clarity === "sunk" ? "lin-memory-expired" : ""}`, onClick: () => mount(container, editor(memory, () => void load())) },
                h("span", { class: "lin-memory-text" }, text),
                h(
                  "span",
                  { class: "lin-memory-meta" },
                  clarityTag(memory),
                  memory.pinned ? h("span", { class: "lin-tag" }, "记牢") : null,
                  memory.updated ?? memory.created ?? "",
                  memory.lastRecalled ? ` · 上次想起 ${memory.lastRecalled}` : "",
                  memory.expires ? (expired ? " · 已过去" : ` · 到 ${memory.expires}`) : "",
                  memory.closed ? " · 已聊完" : "",
                ),
              );
            }),
          ),
        ),
      ),
    );
  };

  async function load() {
    try {
      const response = await api.listMemories();
      memories = (response.memories ?? []).map((item) => ({ ...parseMemory(item.file, item.content), clarity: item.clarity, lastRecalled: item.lastRecalled, importance: item.importance, pinned: item.pinned, gist: item.gist }));
      list();
    } catch (error) {
      status.set(errorText(error));
      list();
    }
  }
  mount(container, h("div", { class: "lin-form" }, "…"));
  void load();
}
