// 设置 →「数据」：导出聊天记录、导出她记得的事；带走提示。
import { api } from "../api.js";
import { companionName, userName } from "../store.js";
import { download, errorText, h, mount, statusLine } from "../ui.js";

const EXPORT_PAGE = 1000;

export function renderData(container) {
  const status = statusLine();
  const exportChat = async () => {
    try {
      // 从最新往前翻完整段对话。
      let all = [];
      let before;
      for (;;) {
        const page = await api.history({ limit: EXPORT_PAGE, before });
        all = [...(page.messages ?? []), ...all];
        if (!page.hasMore || !page.messages?.length) break;
        before = page.messages[0].id;
      }
      const text = all.map((m) => `[${new Date(m.at).toLocaleString()}] ${m.role === "user" ? userName() : companionName()}：${m.text}`).join("\n\n");
      download(`lin-chat-${Date.now()}.txt`, text);
    } catch (error) {
      status.set(errorText(error));
    }
  };
  const exportMemories = async () => {
    try {
      const { memories } = await api.listMemories();
      download(`lin-memories-${Date.now()}.md`, memories.map((memory) => `<!-- ${memory.file} -->\n${memory.content}`).join("\n\n"));
    } catch (error) {
      status.set(errorText(error));
    }
  };
  mount(
    container,
    h(
      "div",
      { class: "lin-form" },
      h("button", { type: "button", class: "lin-secondary", onClick: () => void exportChat() }, "导出聊天记录"),
      h("button", { type: "button", class: "lin-secondary", onClick: () => void exportMemories() }, "导出她记得的事"),
      status.el,
      h("span", { class: "lin-field-hint" }, "数据都在 Lin 文件夹的 data 目录里，拷走这个文件夹就等于带走她；secrets 里是密钥，别发给别人。"),
    ),
  );
}
