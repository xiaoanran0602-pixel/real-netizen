// 测试公用：临时数据目录、安静日志。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataDir } from "../src/config/paths.js";
import { invalidateAllCaches } from "../src/store/files.js";
import { setLogQuiet } from "../src/util/log.js";

setLogQuiet(true);

/** 建一个临时 data 目录并切过去；返回目录与清理函数。 */
export async function useTempData(prefix = "lin-test-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  setDataDir(dir);
  invalidateAllCaches();
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 本地时间构造：month 从 1 开始。 */
export function at(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute);
}
