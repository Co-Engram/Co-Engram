import { defineConfig } from "vitest/config";

// testTimeout 放宽到 15s(默认 5s)。
// 根因:maintenance runLight(含 RPE 计算 + signal flush)单独跑已 ~4.8s,接近
// 默认 5s 边界;全量并发(pnpm -r 多包)CPU 竞争下易超。15s 给 runLight + 性能/集成
// test 留 margin。单测(绝大多数 < 1s)不受影响。
export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
});
