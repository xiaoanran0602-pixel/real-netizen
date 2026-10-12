// 设置 →「模型」：协议、地址、Key（只显示是否已填和末 4 位，留空不改）、聊天模型、后台模型、
// 两档推理强度、单条回复上限；【保存】【测试连接】。保存后下一句话生效。
import { api } from "../api.js";
import { reloadSettings } from "../chat-data.js";
import { copy } from "../copy.js";
import { state } from "../store.js";
import { errorText, field, h, mount, statusLine } from "../ui.js";
import { control, LEVEL_OPTIONS, runBusy } from "./form.js";

const PROTOCOL_OPTIONS = [
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "openai", label: "OpenAI 兼容（Chat Completions）" },
];

function describeTest(name, result) {
  if (!result) return `${name}：没测`;
  if (result.ok) return `${name}：通了（${result.ms} ms）`;
  const reason = result.error?.kind === "http" ? `HTTP ${result.error.status}` : result.error?.kind === "timeout" ? "超时" : result.error?.kind === "empty" ? "模型返回为空" : "网络错误";
  return `${name}：没通（${reason}${result.error?.message ? `，${result.error.message}` : ""}）`;
}

export function renderModel(container) {
  const status = statusLine();
  const protocol = control({ kind: "select", options: PROTOCOL_OPTIONS }, "anthropic");
  const baseUrl = h("input", { class: "lin-text-input", autocomplete: "off", placeholder: "https://api.openai.com" });
  const apiKey = h("input", { class: "lin-text-input", type: "password", autocomplete: "off" });
  const chatModel = h("input", { class: "lin-text-input", autocomplete: "off" });
  const backgroundModel = h("input", { class: "lin-text-input", autocomplete: "off", placeholder: "留空则用聊天模型" });
  const imageModel = h("input", { class: "lin-text-input", autocomplete: "off", placeholder: "gpt-image-1" });
  const imagesEnabled = control({ kind: "toggle" }, state.settings.imagesEnabled !== false);
  const chatLevel = control({ kind: "select", options: LEVEL_OPTIONS }, state.settings.reasoningLevel);
  const backgroundLevel = control({ kind: "select", options: LEVEL_OPTIONS }, state.settings.backgroundReasoningLevel);
  const maxTokens = control({ kind: "number", min: 256, max: 8192 }, state.settings.maxOutputTokens);

  const apply = (info) => {
    protocol.el.value = info.protocol ?? "anthropic";
    baseUrl.value = info.baseUrl ?? "";
    chatModel.value = info.chatModel ?? "";
    backgroundModel.value = info.backgroundModel ?? "";
    apiKey.value = "";
    apiKey.placeholder = info.hasApiKey ? `已填写 ···· ${info.apiKeyTail}（留空不改）` : "还没填";
  };
  imageModel.value = state.settings.imageModel ?? "";
  imagesEnabled.el.checked = state.settings.imagesEnabled !== false;
  void api.getModel().then(apply).catch((error) => status.set(errorText(error)));

  const saveButton = h("button", { type: "button", class: "lin-primary" }, copy.save);
  const testButton = h("button", { type: "button", class: "lin-secondary" }, "测试连接");
  const buttons = [saveButton, testButton];
  saveButton.addEventListener("click", () =>
    void runBusy(buttons, status, "正在保存", async () => {
      apply(await api.saveModel({ protocol: protocol.read(), baseUrl: baseUrl.value, apiKey: apiKey.value, chatModel: chatModel.value, backgroundModel: backgroundModel.value }));
      await api.saveSettings({ reasoningLevel: chatLevel.read(), backgroundReasoningLevel: backgroundLevel.read(), maxOutputTokens: maxTokens.read(), imageModel: imageModel.value.trim(), imagesEnabled: imagesEnabled.read() });
      await reloadSettings();
      imageModel.value = state.settings.imageModel ?? "";
      imagesEnabled.el.checked = state.settings.imagesEnabled !== false;
      return `${copy.saved}，下一句话起生效`;
    }),
  );
  testButton.addEventListener("click", () =>
    void runBusy(buttons, status, "正在测试", async () => {
      const result = await api.testModel();
      return `${describeTest("聊天模型", result.chat)}；${describeTest("后台模型", result.background)}`;
    }),
  );

  mount(
    container,
    h(
      "div",
      { class: "lin-form" },
      field("接口协议", protocol.el),
      field("接口地址", baseUrl, "带不带 /v1 都可以；OpenAI / Anthropic / DeepSeek / OpenRouter / Ollama 等 OpenAI 兼容地址都能填。"),
      field("API Key", apiKey, "只保存在这台电脑的 data/secrets 里，页面上永远不显示完整 Key。"),
      field("聊天模型", chatModel),
      field("后台模型", backgroundModel, "记忆整理、日程、朋友圈等后台任务用；失败时会退回聊天模型重试一次。"),
      field("生图模型", imageModel, "OpenAI Images 兼容的模型名；留空默认 gpt-image-1。"),
      field("允许她生成图片", imagesEnabled.el, "关掉后换头像、朋友圈配图、主动发图都会跳过，朋友圈改发纯文字。"),
      field("聊天推理强度", chatLevel.el, "越高越深思熟虑，回复越慢越长；low 更像随口聊天。"),
      field("后台推理强度", backgroundLevel.el),
      field("单条回复上限（tokens）", maxTokens.el, "256–8192，默认 2048。"),
      h("div", { class: "lin-form-actions" }, ...buttons),
      status.el,
    ),
  );
}
