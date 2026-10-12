// 朋友圈：她自己发的动态（配文 + 网上找的图）。他可以点赞、评论、删自己的评论，她过一会儿会回。
import { api } from "./api.js";
import { companionName, state, subscribe, userName } from "./store.js";
import { avatar, formatChatTime, h, mount, topbar } from "./ui.js";

const REFRESH_MS = 30_000;

function herAvatar(size) {
  return avatar({ name: companionName(), color: state.settings.avatarColor, src: state.profile.avatar, size });
}

function postItem(post, reload, openImage) {
  const liked = post.likes.includes("me");
  const composer = h("div", { class: "lin-post-composer", style: { display: "none" } });
  const input = h("input", { class: "lin-text-input", placeholder: "评论" });
  const sendButton = h("button", { type: "button", class: "lin-primary", disabled: true }, "发送");
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    composer.style.display = "none";
    await api.addComment(post.id, text).catch(() => undefined);
    await reload();
  };
  input.addEventListener("input", () => (sendButton.disabled = !input.value.trim()));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) void submit();
  });
  sendButton.addEventListener("click", () => void submit());
  composer.append(input, sendButton);

  const comments = post.comments.map((comment) =>
    h(
      "div",
      { class: "lin-post-comment" },
      h("span", { class: "lin-post-comment-name" }, comment.from === "me" ? userName() : companionName()),
      comment.from === "her" && comment.replyTo ? [h("span", null, " 回复 "), h("span", { class: "lin-post-comment-name" }, userName())] : null,
      h("span", null, `：${comment.text}`),
      comment.from === "me"
        ? h("button", { type: "button", class: "lin-post-comment-delete", "aria-label": "删除评论", onClick: () => void api.deleteComment(post.id, comment.id).then(reload) }, "×")
        : null,
    ),
  );

  return h(
    "article",
    { class: "lin-post" },
    herAvatar(42),
    h(
      "div",
      { class: "lin-post-main" },
      h("div", { class: "lin-post-name" }, companionName()),
      post.text ? h("div", { class: "lin-post-text" }, post.text) : null,
      post.images.length > 0
        ? h("div", { class: "lin-post-images" }, post.images.map((src) => h("button", { type: "button", class: "lin-post-image", onClick: () => openImage(src) }, h("img", { src, alt: "", loading: "lazy" }))))
        : null,
      post.location ? h("div", { class: "lin-post-location" }, post.location) : null,
      h(
        "div",
        { class: "lin-post-meta" },
        h("span", null, formatChatTime(post.at)),
        h(
          "span",
          { class: "lin-post-actions" },
          h("button", { type: "button", class: `lin-post-action ${liked ? "lin-post-action-on" : ""}`, onClick: () => void api.toggleLike(post.id).then(reload) }, liked ? "取消" : "赞"),
          h("button", { type: "button", class: "lin-post-action", onClick: () => {
            composer.style.display = composer.style.display === "none" ? "flex" : "none";
            if (composer.style.display === "flex") input.focus();
          } }, "评论"),
        ),
      ),
      liked || post.comments.length > 0 ? h("div", { class: "lin-post-feedback" }, liked ? h("div", { class: "lin-post-likes" }, `♡ ${userName()}`) : null, comments) : null,
      composer,
    ),
  );
}

/**
 * @param {HTMLElement} container
 * @returns {() => void}
 */
export function renderMoments(container) {
  let posts = [];
  let loaded = false;
  const body = h("div", { class: "lin-page-body lin-moments" });
  const openImage = (src) => {
    const viewer = h("div", { class: "lin-image-viewer", role: "presentation", onClick: () => viewer.remove() }, h("img", { src, alt: "" }));
    document.body.append(viewer);
  };
  const draw = () => {
    const signature = state.profile.signature;
    mount(
      body,
      h("div", { class: "lin-moments-cover" }, h("div", { class: "lin-moments-cover-name" }, companionName()), herAvatar(64)),
      signature ? h("div", { class: "lin-moments-signature" }, signature) : null,
      loaded && posts.length === 0 ? h("div", { class: "lin-moments-empty" }, "她还没发过朋友圈") : null,
      posts.map((post) => postItem(post, load, openImage)),
    );
  };
  // 有评论正在输入时不整页重画，避免把输入框冲掉。
  const typingComment = () => body.contains(document.activeElement) && document.activeElement?.tagName === "INPUT";
  async function load() {
    const response = await api.listMoments().catch(() => ({ posts: [] }));
    posts = response.posts ?? [];
    loaded = true;
    if (!typingComment()) draw();
  }
  mount(container, topbar({ title: "朋友圈" }), body);
  draw();
  void load();
  // 她回评论是异步的，停在这页时定期刷新。
  const timer = setInterval(() => void load(), REFRESH_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") void load();
  };
  document.addEventListener("visibilitychange", onVisible);
  let profileKey = `${state.profile.avatar}|${state.profile.signature}`;
  const unsubscribe = subscribe(() => {
    const key = `${state.profile.avatar}|${state.profile.signature}`;
    if (key !== profileKey && !typingComment()) {
      profileKey = key;
      draw();
    }
  });
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    unsubscribe();
  };
}
