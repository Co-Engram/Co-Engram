#!/usr/bin/env python3
"""
Claude Code hook → co-engram proposal engine 观察桥

用法(由 Claude Code settings.json 自动调用):
  UserPromptSubmit 事件: argv[1]='user',  stdin 含 {prompt: "..."}
  Stop             事件: argv[1]='assistant', stdin 含 {last_assistant_message: "..."}

行为:
  - 从 stdin 读 hook JSON
  - 按 role 抽出对话内容
  - POST 到本地 viewer 的 /api/observe(默认 http://127.0.0.1:18799)
  - 永远 exit 0,不写 stdout,不阻塞 Claude Code

环境变量:
  CO_ENGRAM_VIEWER_URL   覆盖 viewer URL(默认 http://127.0.0.1:18799)
  CO_ENGRAM_VIEWER_TOKEN Bearer token(viewer 启用 token 时必须)
  CO_ENGRAM_OBSERVE_DISABLED 设为 1/true 临时关闭本 hook(无侵入式开关)
"""

import json
import os
import sys
import urllib.request
import urllib.error


def _extract_content(role: str, payload):
    """根据 role 从 hook payload 抽取对话内容,失败返回空字符串。"""
    if not isinstance(payload, dict):
        return ""
    if role == "user":
        # UserPromptSubmit: {prompt: "..."}
        v = payload.get("prompt")
        return v if isinstance(v, str) else ""
    if role == "assistant":
        # Stop: {last_assistant_message: "..."}
        v = payload.get("last_assistant_message")
        return v if isinstance(v, str) else ""
    return ""


def main() -> int:
    if os.environ.get("CO_ENGRAM_OBSERVE_DISABLED", "").lower() in ("1", "true", "yes"):
        return 0

    if len(sys.argv) < 2 or sys.argv[1] not in ("user", "assistant"):
        # 不识别的事件,静默跳过
        return 0
    role = sys.argv[1]

    # stdin 可能是空(某些事件无 payload),要兜底
    try:
        raw = sys.stdin.read()
    except Exception:
        return 0
    if not raw:
        return 0

    try:
        payload = json.loads(raw)
    except Exception:
        # hook payload 不是合法 JSON,放弃
        return 0

    content = _extract_content(role, payload)
    if not content or not content.strip():
        return 0

    base_url = os.environ.get("CO_ENGRAM_VIEWER_URL", "http://127.0.0.1:18799").rstrip("/")
    url = base_url + "/api/observe"
    token = os.environ.get("CO_ENGRAM_VIEWER_TOKEN", "")

    body = json.dumps({"role": role, "content": content}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )

    try:
        # 短超时:hook 是 fire-and-forget,viewer 卡住也不能阻塞 Claude Code
        with urllib.request.urlopen(req, timeout=3) as resp:
            resp.read()
    except urllib.error.URLError:
        # viewer 没启动 / 拒绝连接 → 静默放弃
        pass
    except Exception:
        # 任何异常都不能影响 Claude Code
        pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
