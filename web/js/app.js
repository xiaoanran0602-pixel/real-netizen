// Lin 网页外壳：底部三个页签「消息 / 朋友圈 / 我」；宽屏左右两栏（左边页签，右边聊天）。
// 主题与字号跟设置走；菜单链接带 #moments 时直接打开朋友圈。
import { renderChat } from "./chat.js";
import { copy } from "./copy.js";
import { startChat } from "./chat-data.js";
import { renderMoments } from "./moments.js";
import { renderSettings } from "./settings/index.js";
import { companionName, setState, state, subscribe, userName } from "./store.js";
import { avatar, formatChatTime, h, mount, topbar } from "./ui.js";

const WIDE_QUERY = "(min-width: 820px)";
const root = document.getElementById("root");
const wideMedia = window.matchMedia(WIDE_QUERY);
const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

/** 外壳状态：当前页签与覆盖层（窄屏时聊天页、设置页盖在页签上）。 */
const shell = {
  tab: window.location.hash === "#moments" ? "moments" : "chats",
  /** null | "chat" | "settings" */
  overlay: null,
  settingsGroup: null,
};

/** 每次重画前清理上一个页面的订阅。 */
let cleanups = [];

function applyTheme() {
  const theme = state.settings.theme ?? "system";
  const dark = theme === "dark" || (theme === "system" && darkMedia.matches);
  document.documentElement.dataset.linTheme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111111" : "#ededed");
  const size = Number(state.settings.fontSize);
  if (size >= 12 && size <= 22) document.documentElement.style.setProperty("--ui-font-size", `${size}px`);
}

function track(cleanup) {
  if (typeof cleanup === "function") cleanups.push(cleanup);
}

function navigate(patch) {
  Object.assign(shell, patch);
  render();
}

function tabBar() {
  return h(
    "nav",
    { class: "lin-tabbar" },
    Object.entries(copy.tabs).map(([key, label]) =>
      h("button", { type: "button", class: `lin-tab ${shell.tab === key ? "lin-tab-active" : ""}`, onClick: () => navigate({ tab: key, overlay: null }) }, label),
    ),
  );
}

function chatList(onOpen) {
  const page = h("div", { class: "lin-page" });
  const draw = () => {
    const last = [...state.messages].reverse().find((message) => message.text);
    mount(
      page,
      topbar({ title: copy.appName }),
      h(
        "button",
        { type: "button", class: "lin-chat-item", onClick: onOpen },
        avatar({ name: companionName(), color: state.settings.avatarColor, src: state.profile.avatar, size: 46 }),
        h(
          "div",
          { class: "lin-chat-item-main" },
          h("div", { class: "lin-chat-item-top" }, h("span", { class: "lin-chat-item-name" }, companionName()), h("span", { class: "lin-chat-item-time" }, last ? formatChatTime(last.at) : "")),
          h("div", { class: "lin-chat-item-preview" }, state.typing ? copy.typing : last?.text.split("\n")[0] ?? copy.firstHello),
        ),
      ),
    );
  };
  draw();
  track(subscribe(draw));
  return page;
}

function mePage() {
  return h(
    "div",
    { class: "lin-page" },
    topbar({ title: copy.tabs.me }),
    h("div", { class: "lin-profile" }, avatar({ name: userName(), color: "#3a7f6f", size: 72 }), h("div", { class: "lin-profile-name" }, userName())),
    h(
      "div",
      { class: "lin-list" },
      h("button", { type: "button", class: "lin-list-item", onClick: () => navigate({ overlay: "settings", settingsGroup: null }) }, h("span", null, copy.settings), h("span", { class: "lin-list-chevron" }, "›")),
    ),
  );
}

function tabPanel(wide) {
  if (shell.overlay === "settings") {
    const container = h("div", { class: "lin-page" });
    track(renderSettings(container, { onBack: () => navigate({ overlay: null }), initialGroup: shell.settingsGroup }));
    return container;
  }
  if (shell.tab === "moments") {
    const container = h("div", { class: "lin-page" });
    track(renderMoments(container));
    return container;
  }
  if (shell.tab === "me") return mePage();
  return chatList(() => navigate({ overlay: wide ? null : "chat" }));
}

function chatPanel(onBack) {
  const container = h("div", { class: "lin-chat" });
  track(renderChat(container, { onBack }));
  return container;
}

function render() {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  const wide = wideMedia.matches;
  if (wide) {
    mount(
      root,
      h(
        "div",
        { class: "lin-app lin-app-wide" },
        h("aside", { class: "lin-sidebar" }, h("div", { class: "lin-sidebar-body" }, tabPanel(true)), shell.overlay === "settings" ? null : tabBar()),
        h("main", { class: "lin-main" }, chatPanel(undefined)),
      ),
    );
    return;
  }
  if (shell.overlay === "chat") {
    mount(root, h("div", { class: "lin-app" }, chatPanel(() => navigate({ overlay: null }))));
    return;
  }
  mount(root, h("div", { class: "lin-app" }, h("div", { class: "lin-tab-body" }, tabPanel(false)), shell.overlay === "settings" ? null : tabBar()));
}

function renderBootError() {
  const text = state.connection === "unauthorized" ? copy.unauthorized : copy.bootFailed;
  mount(root, h("div", { class: "lin-boot" }, h("div", null, text), h("button", { type: "button", class: "lin-secondary", onClick: () => window.location.reload() }, copy.retry)));
}

async function boot() {
  document.title = copy.appName;
  applyTheme();
  // 窄屏（手机）首次打开直接进聊天页，像打开微信直接点进置顶的人。
  if (!wideMedia.matches && shell.tab !== "moments") shell.overlay = "chat";
  try {
    await startChat();
  } catch {
    renderBootError();
    return;
  }
  // 去掉地址栏里的 ?token=，避免截图或分享时泄露（cookie 已经写好）。
  if (window.location.search.includes("token=")) history.replaceState(null, "", `/${window.location.hash}`);
  let lastTheme = "";
  subscribe(() => {
    const key = `${state.settings.theme}|${state.settings.fontSize}`;
    if (key !== lastTheme) {
      lastTheme = key;
      applyTheme();
    }
  });
  darkMedia.addEventListener("change", applyTheme);
  wideMedia.addEventListener("change", render);
  window.addEventListener("hashchange", () => {
    if (window.location.hash === "#moments") navigate({ tab: "moments", overlay: null });
  });
  setState({ connection: "ready" });
  render();
}

void boot();
