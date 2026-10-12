// ============================================================
// GET /api/lin/lan：手机扫码用的局域网地址（带令牌）。只监听本机时 lanEnabled=false。
// ============================================================

import { networkInterfaces } from "node:os";
import { runtimeOptions } from "../../config/runtime.js";

const VIRTUAL_NIC = /(vEthernet|VirtualBox|VMware|WSL|Hyper-V|docker|vpn|tap|tun|utun|Loopback)/iu;

/** 本机局域网 IPv4，排除回环、虚拟网卡和 VPN 常见网段；家用网段排前面（扫码时第一个最可能是对的）。 */
export function listLanAddresses() {
  const rank = (address) => (address.startsWith("192.168.") ? 0 : address.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./u.test(address) ? 2 : 3);
  const result = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_NIC.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
      result.push(entry.address);
    }
  }
  return result.sort((a, b) => rank(a) - rank(b));
}

export function isLanHost(host) {
  return host === "0.0.0.0" || host === "::";
}

/** @param {string} token */
export function lanUrls(token) {
  const { host, port } = runtimeOptions();
  if (!isLanHost(host)) return [];
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return listLanAddresses().map((address) => `http://${address}:${port}/${query}`);
}

/**
 * @param {ReturnType<import("../router.js").createRouter>} router
 * @param {{token: string}} deps
 */
export function registerLanRoutes(router, deps) {
  router.get("/api/lin/lan", () => ({ lanEnabled: isLanHost(runtimeOptions().host), urls: lanUrls(deps.token) }));
}
