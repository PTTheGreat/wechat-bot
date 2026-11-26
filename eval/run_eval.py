"""跑评测用例：python -m eval.run_eval [--judge] [--only 08,09]

每个用例都做两类检查：
1. 规则检查（不花额外钱）：阶段、转人工对象、回复条数和长度、是否出现手机号/链接/markdown/emoji/粗口/客服腔。
2. --judge：再用 Claude 按用例里的 must / must_not 逐条打分（每个用例多一次 API 调用）。

结果写到 eval/results/latest.jsonl，并打印汇总。
注意：每个用例至少调用一次 API，会产生费用。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from typing import Any

import anthropic

from bot.agent import DEFAULT_MODEL, Conversation, PresalesAgent

HERE = pathlib.Path(__file__).resolve().parent

PHONE = re.compile(r"1[3-9]\d{9}")
URL = re.compile(r"https?://|www\.", re.I)
MARKDOWN = re.compile(r"\*\*|^#{1,6}\s|^\s*[-*]\s", re.M)
EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿]")
PROFANITY = ["牛逼", "他妈", "滚蛋", "放屁", "傻逼", "卧槽"]
SERVICE_TONE = ["亲~", "亲，", "亲亲", "宝子", "您好呀", "感谢您的耐心"]
MAX_REPLY_CHARS = 200


def rule_checks(case: dict[str, Any], result: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    exp = case["expect"]
    if exp.get("stage_any") and result["stage"] not in exp["stage_any"]:
        problems.append(f"阶段 {result['stage']} 不在 {exp['stage_any']}")
    handoff_to = result["handoff"]["to"] if result["handoff"]["needed"] else "无"
    if exp.get("handoff_to_any") and handoff_to not in exp["handoff_to_any"]:
        problems.append(f"转人工 {handoff_to} 不在 {exp['handoff_to_any']}")

    replies = result["replies"]
    if not 1 <= len(replies) <= 4:
        problems.append(f"回复 {len(replies)} 条（应 1–4 条）")
    joined = "\n".join(replies)
    for r in replies:
        if len(r) > MAX_REPLY_CHARS:
            problems.append(f"单条回复 {len(r)} 字，超过 {MAX_REPLY_CHARS}")
    if PHONE.search(joined):
        problems.append("回复里有手机号")
    if URL.search(joined):
        problems.append("回复里有链接")
    if MARKDOWN.search(joined):
        problems.append("回复里有 markdown 格式")
    if EMOJI.search(joined):
        problems.append("回复里有 emoji（应只用 [抱拳] 这类微信表情）")
    for word in PROFANITY + SERVICE_TONE:
        if word in joined:
            problems.append(f"回复里有「{word}」")
    return problems


JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["must", "must_not"]},
                    "criterion": {"type": "string"},
                    "passed": {"type": "boolean"},
                    "why": {"type": "string"},
                },
                "required": ["kind", "criterion", "passed", "why"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


def judge(client: anthropic.Anthropic, case: dict[str, Any], result: dict[str, Any]) -> list[dict[str, Any]]:
    dialogue = "\n".join(
        f"{'客户' if t['role'] == 'user' else '刘校'}：{t['content']}" for t in case["turns"]
    )
    prompt = (
        "你在评审一个替刘校回复英语课程售前咨询的 agent。\n\n"
        f"<对话>\n{dialogue}\n</对话>\n\n"
        f"<agent本轮回复>\n" + "\n".join(result["replies"]) + "\n</agent本轮回复>\n\n"
        f"<转人工>{json.dumps(result['handoff'], ensure_ascii=False)}</转人工>\n\n"
        "逐条判断下面的标准。must：回复做到了才算通过；must_not：回复没有出现这种情况才算通过。"
        "意思到了就算，不要求逐字一致。\n\n"
        + "\n".join(f"- must: {m}" for m in case["expect"].get("must", []))
        + "\n"
        + "\n".join(f"- must_not: {m}" for m in case["expect"].get("must_not", []))
    )
    response = client.messages.create(
        model=DEFAULT_MODEL,
        max_tokens=4000,
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": JUDGE_SCHEMA}},
    )
    if response.stop_reason != "end_turn":
        return [{"kind": "must", "criterion": "评审", "passed": False, "why": f"评审未完成：{response.stop_reason}"}]
    text = next(b.text for b in response.content if b.type == "text")
    return json.loads(text)["items"]


def build_conversation(case: dict[str, Any]) -> Conversation:
    conv = Conversation()
    for turn in case["turns"]:
        if turn["role"] == "user":
            conv.add_user(turn["content"])
        else:
            conv.add_assistant_text(turn["content"])
    return conv


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--judge", action="store_true", help="用 Claude 按 must/must_not 评分（多一次调用/用例）")
    parser.add_argument("--only", default="", help="只跑这些编号前缀，逗号分隔，例如 08,09")
    parser.add_argument("--effort", default="medium")
    args = parser.parse_args()

    cases = [json.loads(line) for line in (HERE / "cases.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    if args.only:
        prefixes = tuple(p.strip() for p in args.only.split(","))
        cases = [c for c in cases if c["id"].startswith(prefixes)]

    agent = PresalesAgent(effort=args.effort)
    out_dir = HERE / "results"
    out_dir.mkdir(exist_ok=True)
    passed = 0
    records = []

    for case in cases:
        result, _ = agent.reply(build_conversation(case))
        problems = rule_checks(case, result)
        judged = judge(agent.client, case, result) if args.judge else []
        problems += [f"{j['kind']} 未通过：{j['criterion']}（{j['why']}）" for j in judged if not j["passed"]]
        ok = not problems
        passed += ok
        records.append({"id": case["id"], "ok": ok, "problems": problems, "result": result})

        print(f"{'✓' if ok else '✗'} {case['id']}")
        for line in result["replies"]:
            print(f"    刘校：{line}")
        for p in problems:
            print(f"    ! {p}")

    (out_dir / "latest.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n", encoding="utf-8"
    )
    print(f"\n通过 {passed}/{len(cases)}（{'含' if args.judge else '不含'} Claude 评审）")
    return 0 if passed == len(cases) else 1


if __name__ == "__main__":
    sys.exit(main())
