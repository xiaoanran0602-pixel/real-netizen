// 设置 →「回档」：按日期倒序的存档列表；选中后「回到这一天」需要输入 MM-DD 确认；
// 回档中显示进度（SSE archive 事件）；失败显示原因和「重试」；底部显示占用空间与「删除更早的存档」。
import { api } from "../api.js";
import { state, subscribe } from "../store.js";
import { errorText, field, h, mount, statusLine } from "../ui.js";

const KB = 1024;
const MB = KB * 1024;

function formatSize(bytes) {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return `${bytes} B`;
}

export function renderArchive(container) {
  let data = null;
  let selected = null;
  const status = statusLine();

  const restore = async (day) => {
    const mmdd = day.slice(5);
    const typed = window.prompt(`回到 ${day} 结束时的她。\n\n这一天之后的聊天、她记住的事、日程、朋友圈都会被丢掉，不能撤销；已经发到聊天渠道上的消息不会撤回，只是她不再记得。\n\n确认请输入 ${mmdd}：`);
    if (typed === null) return;
    if (typed.trim() !== mmdd) return status.set("日期没对上，没有回档。");
    try {
      status.set("正在回档…");
      const result = await api.restoreArchive(day, typed.trim());
      // 修复：原来回档完成后状态行一直停在「正在回档…」；按接口返回的最终状态改写。
      const final = result.status ?? {};
      status.set(final.status === "done" ? `已经回到 ${day}。` : final.status === "failed" ? `回档失败：${final.error ?? ""}` : "");
      selected = null;
    } catch (error) {
      status.set(errorText(error));
    }
    await load();
  };

  const draw = () => {
    if (!data) return mount(container, h("div", { class: "lin-form" }, "…"));
    const restoring = state.archive ?? data.restore;
    const running = restoring?.status === "running";
    const failed = restoring?.status === "failed";
    const days = data.days ?? [];
    mount(
      container,
      h(
        "div",
        { class: "lin-form" },
        h("span", { class: "lin-field-hint" }, "每天凌晨分界时，她会自动存一份「这一天结束时的她」。回档会让之后的日子对她来说从没发生过。"),
        running ? h("span", { class: "lin-field-label" }, `正在回到 ${restoring.day}… ${restoring.step ?? ""}`) : null,
        failed
          ? h("div", { class: "lin-form-actions" }, h("span", { class: "lin-field-hint" }, `回档失败：${restoring.error ?? ""}`), h("button", { type: "button", class: "lin-primary", onClick: () => void api.restoreArchive(restoring.day, restoring.day.slice(5)).then(load, (e) => status.set(errorText(e))) }, "重试"))
          : null,
        days.length === 0 ? h("span", { class: "lin-field-hint" }, "还没有存档。") : null,
        days.map((day) =>
          h(
            "button",
            { type: "button", class: `lin-archive-item ${selected === day.day ? "lin-archive-item-on" : ""}`, disabled: running, onClick: () => { selected = day.day; draw(); } },
            h("span", { class: "lin-field-label" }, day.day),
            h("span", { class: "lin-memory-meta" }, `聊了 ${day.summary?.messages ?? 0} 条 · 新记住 ${day.summary?.newMemories ?? 0} 件`),
            day.summary?.lastLine ? h("span", { class: "lin-memory-text" }, day.summary.lastLine) : null,
          ),
        ),
        selected
          ? h(
              "div",
              { class: "lin-form-actions" },
              h("button", { type: "button", class: "lin-danger", disabled: running, onClick: () => void restore(selected) }, `回到 ${selected}`),
              h("button", { type: "button", class: "lin-secondary", disabled: running || selected === days.at(-1)?.day, onClick: () => void deleteBefore(selected) }, `删除 ${selected} 之前的存档`),
            )
          : null,
        status.el,
        field("存档占用", h("div", { class: "lin-readonly" }, formatSize(data.bytes ?? 0)), "删除只能从最早的开始往后删，剩下的每份都完整可用。"),
      ),
    );
  };

  const deleteBefore = async (day) => {
    if (!window.confirm(`删除 ${day} 之前的所有存档？删了就不能回到那些日子了。`)) return;
    try {
      const result = await api.deleteArchiveBefore(day);
      status.set(`删除了 ${result.removedDays ?? 0} 份存档，释放 ${formatSize(result.freedBytes ?? 0)}`);
    } catch (error) {
      status.set(errorText(error));
    }
    await load();
  };

  async function load() {
    try {
      data = await api.getArchive();
    } catch (error) {
      data = { days: [], bytes: 0 };
      status.set(errorText(error));
    }
    draw();
  }
  void load();
  let lastArchive = state.archive;
  return subscribe(() => {
    if (state.archive !== lastArchive) {
      lastArchive = state.archive;
      if (state.archive?.status === "done") void load();
      else draw();
    }
  });
}
