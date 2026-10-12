// 设置 →「在手机上打开」：局域网地址二维码（内置 vendor/qrcode.js 生成，不联网）。
import { api } from "../api.js";
import { qrToSvg } from "../../vendor/qrcode.js";
import { h, mount } from "../ui.js";

const QR_SIZE = 240;

export function renderPhone(container) {
  mount(container, h("div", { class: "lin-form" }, "…"));
  void api
    .getLan()
    .then(({ lanEnabled, urls }) => {
      if (!lanEnabled || !urls?.length) {
        mount(container, h("div", { class: "lin-form" }, h("span", { class: "lin-field-label" }, "手机访问没有开启"), h("span", { class: "lin-field-hint" }, "现在只监听本机。用 lin.ps1 启动（默认局域网监听），手机和电脑连同一个网络，就能在这里扫码。")));
        return;
      }
      const image = h("div", { class: "lin-qr-image" });
      const draw = (url) => {
        image.innerHTML = qrToSvg(url, QR_SIZE);
      };
      const select = urls.length > 1 ? h("select", { class: "lin-text-input" }, urls.map((url, index) => h("option", { value: String(index) }, new URL(url).host))) : null;
      select?.addEventListener("change", () => draw(urls[Number(select.value)]));
      draw(urls[0]);
      mount(
        container,
        h(
          "div",
          { class: "lin-form lin-qr" },
          image,
          h("span", { class: "lin-field-hint" }, "手机和电脑连同一个网络，用相机扫码。扫一次后手机会记住，不用每次都扫。"),
          select,
          h("span", { class: "lin-field-hint" }, "别把这个二维码发给别人，它等于你们聊天的钥匙。"),
        ),
      );
    })
    .catch(() => mount(container, h("div", { class: "lin-form" }, "读取地址失败")));
}
