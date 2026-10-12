// 隐私与命名检查：
//   1. Lin/ 下（docs/archive 与 data 除外）不出现原仓库的名字、包作用域、旧环境变量；
//   2. src/ 与 web/js/ 单文件不超过 400 行；
//   3. APP_ROOT 全部文本文件与文件名不出现作者的隐私词（人名、公司、内部服务、账号词）。
// 被禁的词全部用拼接写出，避免本文件自己命中。
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { APP_ROOT } from "../src/config/paths.js";

const OLD_NAME = ["z", "code"].join("");
const FORBIDDEN = [
  { label: "旧仓库名字", pattern: new RegExp(OLD_NAME, "iu") },
  { label: "旧包作用域", pattern: new RegExp(`@${OLD_NAME}/`, "iu") },
  { label: "旧环境变量前缀", pattern: new RegExp(`${OLD_NAME.toUpperCase()}_`, "u") },
  { label: "旧环境变量开关", pattern: new RegExp(["LIN", "_(MODE|HOME|CHANNEL_API_HOST)"].join(""), "u") },
];

// 隐私词：片段拼接，任何单片段都不等于原词，文件自身不会命中。
const PRIVATE_WORDS = [
  ["空", "青"].join(""),
  ["bow", "en"].join(""),
  ["kong", "qing"].join(""),
  ["今", "言"].join(""),
  ["幽兰", "黛尔"].join(""),
  ["Ho", "Yo"].join(""),
  ["ho", "yow", "ave"].join(""),
  ["mi", "ho", "yo"].join(""),
  ["米哈", "游"].join(""),
  ["ath", "enai"].join(""),
  ["域", "账号"].join(""),
  ["her", "mes"].join(""),
].map((word) => ({ label: "隐私词", pattern: new RegExp(word, "iu") }));

const EXCLUDED_DIRS = new Set(["data", ".git", "node_modules"]);
const EXCLUDED_PREFIXES = [["docs", "archive"].join("/")];
const TEXT_EXTENSIONS = /\.(js|mjs|json|md|html|css|ps1|svg|txt|yaml|yml)$/iu;
const MAX_LINES = 400;
const LINE_LIMITED_ROOTS = ["src/", "web/js/"];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(APP_ROOT, full).split(sep).join("/");
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name) && dir === APP_ROOT) continue;
      if (EXCLUDED_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

test("no trace of the old repository in Lin/", async () => {
  const files = await walk(APP_ROOT);
  const hits = [];
  for (const rel of files) {
    if (new RegExp(OLD_NAME, "iu").test(rel)) hits.push(`${rel}（文件名）`);
    if (!TEXT_EXTENSIONS.test(rel)) continue;
    const text = await readFile(join(APP_ROOT, rel), "utf8");
    for (const { label, pattern } of FORBIDDEN) {
      if (pattern.test(text)) hits.push(`${rel}：${label}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("source files stay under 400 lines", async () => {
  const files = (await walk(APP_ROOT)).filter((rel) => rel.endsWith(".js") && LINE_LIMITED_ROOTS.some((root) => rel.startsWith(root)));
  const tooLong = [];
  for (const rel of files) {
    const lines = (await readFile(join(APP_ROOT, rel), "utf8")).split("\n").length;
    if (lines > MAX_LINES) tooLong.push(`${rel}: ${lines}`);
  }
  assert.deepEqual(tooLong, []);
});

test("no private words anywhere in the repo", async () => {
  const files = await walk(APP_ROOT);
  const hits = [];
  for (const rel of files) {
    for (const { label, pattern } of PRIVATE_WORDS) {
      if (pattern.test(rel)) hits.push(`${rel}（文件名）：${label}`);
    }
    if (!TEXT_EXTENSIONS.test(rel)) continue;
    const text = await readFile(join(APP_ROOT, rel), "utf8");
    for (const { label, pattern } of PRIVATE_WORDS) {
      if (pattern.test(text)) hits.push(`${rel}：${label}`);
    }
  }
  assert.deepEqual(hits, []);
});
