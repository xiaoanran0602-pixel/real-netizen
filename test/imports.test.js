// 静态检查：src/、web/js/、test/ 里所有相对 import 的名字都能在目标模块的导出里找到。
// 网页没有构建步骤，拼错一个导出名要到浏览器里才会发现，这个测试提前拦住。
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { APP_ROOT } from "../src/config/paths.js";

const ROOTS = ["src", "web/js", "web/vendor", "test"];
const IMPORT_PATTERN = /import\s*\{([^}]+)\}\s*from\s*"(\.{1,2}\/[^"]+)"/gu;
const EXPORT_PATTERN = /export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gu;
const EXPORT_LIST_PATTERN = /export\s*\{([^}]+)\}/gu;

async function listJs(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listJs(full)));
    else if (/\.(m?js)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

test("every named relative import exists in its target module", async () => {
  const files = (await Promise.all(ROOTS.map((root) => listJs(join(APP_ROOT, root))))).flat();
  const sources = new Map();
  for (const file of files) sources.set(resolve(file), await readFile(file, "utf8"));
  const exportsOf = new Map();
  for (const [file, text] of sources) {
    const names = new Set([...text.matchAll(EXPORT_PATTERN)].map((match) => match[1]));
    for (const match of text.matchAll(EXPORT_LIST_PATTERN)) {
      for (const part of match[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/u).pop();
        if (name) names.add(name);
      }
    }
    exportsOf.set(file, names);
  }
  const missing = [];
  for (const [file, text] of sources) {
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const target = resolve(dirname(file), match[2]);
      const names = exportsOf.get(target);
      if (!names) {
        missing.push(`${file} → ${match[2]}（文件不存在）`);
        continue;
      }
      for (const part of match[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/u)[0];
        if (name && !names.has(name)) missing.push(`${file} → ${match[2]}：${name}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
