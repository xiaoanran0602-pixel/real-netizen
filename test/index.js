// `node --test test/` 的入口：Node 把目录当模块解析到这里。按文件名顺序加载全部 *.test.js。
// 也可以用 `node --test "test/*.test.js"` 让每个文件在独立进程里跑。
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const name of readdirSync(here).filter((file) => file.endsWith(".test.js")).sort()) {
  await import(pathToFileURL(join(here, name)).href);
}
