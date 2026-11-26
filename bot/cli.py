"""在终端里和售前 agent 对话，用来试话术、调知识库。

    python -m bot.cli                 # 开始对话
    python -m bot.cli --show-meta     # 同时显示阶段、转人工、客户画像
    python -m bot.cli --dump-prompt   # 只打印拼好的 system prompt，不调用 API

需要 ANTHROPIC_API_KEY（或 `ant auth login`）。
"""

from __future__ import annotations

import argparse
import json
import sys

from bot.agent import Conversation, load_context


def main() -> int:
    parser = argparse.ArgumentParser(description="刘校售前 agent 终端测试")
    parser.add_argument("--effort", default="medium", choices=["low", "medium", "high", "xhigh", "max"])
    parser.add_argument("--with-reference", action="store_true", help="把 kb/reference 也放进上下文（更全，更贵）")
    parser.add_argument("--show-meta", action="store_true", help="显示阶段、skill、转人工和客户画像")
    parser.add_argument("--dump-prompt", action="store_true", help="打印 system prompt 后退出")
    args = parser.parse_args()

    if args.dump_prompt:
        text = load_context(args.with_reference)
        print(text)
        print(f"\n[共 {len(text)} 字符]", file=sys.stderr)
        return 0

    from bot.agent import PresalesAgent

    agent = PresalesAgent(effort=args.effort, include_reference=args.with_reference)
    conv = Conversation()
    print("输入客户消息，回车发送。空行结束。\n")

    while True:
        try:
            text = input("客户：").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not text:
            break
        conv.add_user(text)
        result, response = agent.reply(conv)
        for line in result["replies"]:
            print(f"刘校：{line}")
        if args.show_meta:
            meta = {k: result[k] for k in ("stage", "skill", "handoff", "customer", "kb_refs")}
            print("  ·", json.dumps(meta, ensure_ascii=False))
            u = response.usage
            print(f"  · tokens 输入 {u.input_tokens} / 缓存读 {u.cache_read_input_tokens} / 输出 {u.output_tokens}")
        if result["handoff"]["needed"]:
            print(f"  ⇢ 转人工：{result['handoff']['to']}（{result['handoff']['reason']}）")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
