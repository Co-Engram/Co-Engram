import { describe, it, expect } from "vitest";

import { isGerritRejection } from "../src/storage/git.js";

/**
 * isGerritRejection —— pushRepo 失败 fallback 触发条件的核心判定位。
 *
 * 命中 Gerrit 拒绝特征 → pushRepo 自动重试 refs/for/<branch>。
 * 误判(把非 Gerrit 错误认成 Gerrit 拒绝)会导致无谓重试 + 误导用户;
 * 漏判(没识别出真实 Gerrit 拒绝)会导致 fallback 失效,直接把错误抛给用户。
 *
 * 所以这个 regex 的正/负样本必须锁死,任何调整都需要更新这里。
 */
describe("isGerritRejection", () => {
  describe("正样本(命中 → true,触发 gerrit-review fallback)", () => {
    const positiveCases: ReadonlyArray<readonly [string, string]> = [
      [
        "Gerrit prohibition 标准句",
        "remote: ERROR: push to refs/heads/master is prohibited by Gerrit",
      ],
      [
        "Gerrit 权限不足(单引号 Push)",
        "remote: ERROR: you need 'Push' rights to push to refs/heads/master",
      ],
      [
        "Gerrit 权限不足(双引号 Push)",
        'remote: ERROR: you need "Push" rights to push to refs/heads/master',
      ],
      [
        "大小写不敏感(NEED 大写)",
        "remote: ERROR: NEED 'Push' rights",
      ],
      [
        "嵌在长 stderr 中",
        "Counting objects: 5, done.\nremote: ERROR: prohibited by Gerrit\nfatal: unable to access",
      ],
    ];

    for (const [name, stderr] of positiveCases) {
      it(name, () => {
        expect(isGerritRejection(stderr)).toBe(true);
      });
    }
  });

  describe("负样本(不命中 → false,走原 direct 错误返回)", () => {
    const negativeCases: ReadonlyArray<readonly [string, string]> = [
      ["GitHub 认证失败", "fatal: could not read Username for 'https://github.com'"],
      ["网络不通", "fatal: unable to access 'https://github.com/': Connection timed out"],
      ["SSH 拒绝", "Permission denied (publickey)."],
      ["代理中断", "fatal: Proxy CONNECT aborted"],
      ["空字符串", ""],
      ["无关 push 错误", "! [rejected] main -> main (fetch first)"],
    ];

    for (const [name, stderr] of negativeCases) {
      it(name, () => {
        expect(isGerritRejection(stderr)).toBe(false);
      });
    }
  });
});
