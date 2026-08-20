import { defineConfig } from "vitest/config";

// testTimeout 放宽到 15s(默认 5s)。
// 根因:maintenance runLight(含 RPE 计算 + signal flush)单独跑已 ~4.8s,接近
// 默认 5s 边界;全量并发(pnpm -r 多包)CPU 竞争下易超。15s 给 runLight + 性能/集成
// test 留 margin。单测(绝大多数 < 1s)不受影响。
//
// TZ 固定为 Asia/Shanghai:锚点调度测试(incubation-schedule.test.ts 等)硬编码
// +08:00 期望值,本地(默认 +08)与 CI(常为 UTC)时区不一致会红;固定后与
// 时区环境解耦。现有测试本地 +08 与 CI UTC 下均绿,说明它们本就 TZ 无关,
// 固定 +08 对它们无影响。
export default defineConfig({
  test: {
    testTimeout: 15_000,
    env: {
      TZ: "Asia/Shanghai",
    },
  },
});
