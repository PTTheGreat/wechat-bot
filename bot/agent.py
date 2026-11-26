"""刘校售前 agent。

把 agent/system_prompt.md + skills/*/SKILL.md + kb/*.md 拼成一个（可缓存的）system prompt，
每来一条微信消息就调用一次 Claude，返回结构化结果：要发的几条回复、所处阶段、是否转人工等。

用法见 bot/cli.py 和 README.md。
"""

from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass, field
from typing import Any

import anthropic

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_MODEL = "claude-opus-5-5"

STAGES = ["接住", "诊断", "给价值", "给路径", "介绍课程", "异议处理", "报价抵扣", "转人工", "收尾", "边缘问题"]
SKILLS = [
    "diagnose-needs",
    "recommend-course-path",
    "explain-course",
    "answer-teaching-question",
    "quote-price",
    "handle-objection",
    "handoff-to-human",
    "handle-edge-cases",
    "none",
]
HANDOFF_TO = ["无", "教练", "课程顾问", "小助手", "班主任", "VIP客服", "项目组", "雅思工作人员", "客服", "刘校本人"]

REPLY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "replies": {"type": "array", "items": {"type": "string"}},
        "stage": {"type": "string", "enum": STAGES},
        "skill": {"type": "string", "enum": SKILLS},
        "customer": {
            "type": "object",
            "properties": {
                "identity": {"type": "string"},
                "goal": {"type": "string"},
                "child": {"type": "string"},
                "courses_taken": {"type": "string"},
                "intent": {"type": "string", "enum": ["冷", "温", "热"]},
            },
            "required": ["identity", "goal", "child", "courses_taken", "intent"],
            "additionalProperties": False,
        },
        "handoff": {
            "type": "object",
            "properties": {
                "needed": {"type": "boolean"},
                "to": {"type": "string", "enum": HANDOFF_TO},
                "reason": {"type": "string"},
            },
            "required": ["needed", "to", "reason"],
            "additionalProperties": False,
        },
        "kb_refs": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["replies", "stage", "skill", "customer", "handoff", "kb_refs"],
    "additionalProperties": False,
}

# 模型拒答或输出异常时发出去的兜底回复：不瞎答，直接交给刘校本人。
FALLBACK_RESULT: dict[str, Any] = {
    "replies": ["老师，这个我看一下，稍后回你[抱拳]"],
    "stage": "转人工",
    "skill": "handoff-to-human",
    "customer": {"identity": "未知", "goal": "未知", "child": "未知", "courses_taken": "未知", "intent": "冷"},
    "handoff": {"needed": True, "to": "刘校本人", "reason": "agent 未能生成回复，请人工查看对话"},
    "kb_refs": [],
}


def load_context(include_reference: bool = False) -> str:
    """按固定顺序拼接 system prompt。顺序固定，提示缓存才能命中。"""
    parts = [(ROOT / "agent" / "system_prompt.md").read_text(encoding="utf-8")]

    parts.append("# Skills（每个场景的做法）")
    for path in sorted((ROOT / "skills").glob("*/SKILL.md")):
        parts.append(f'<skill name="{path.parent.name}">\n{path.read_text(encoding="utf-8")}\n</skill>')

    parts.append("# 知识库")
    for path in sorted(p for p in (ROOT / "kb").glob("*.md") if p.name != "README.md"):
        parts.append(f'<kb file="{path.name}">\n{path.read_text(encoding="utf-8")}\n</kb>')

    if include_reference:
        parts.append("# 参考资料（原始提炼，原话更全；事实以上面的知识库为准）")
        for path in sorted((ROOT / "kb" / "reference").glob("*.md")):
            parts.append(f'<kb file="reference/{path.name}">\n{path.read_text(encoding="utf-8")}\n</kb>')

    return "\n\n".join(parts)


@dataclass
class Conversation:
    """一个微信联系人的对话历史。

    assistant 轮保存的是 API 返回的完整 content（含 thinking 块），原样回传给 API——
    Claude Opus 5.5 要求同一模型的多轮对话把 thinking 块原封不动带回去。
    """

    messages: list[dict[str, Any]] = field(default_factory=list)

    def add_user(self, text: str) -> None:
        # 微信里对方常连发几条：如果上一条也是对方发的，合并成一轮。
        if self.messages and self.messages[-1]["role"] == "user":
            self.messages[-1]["content"][0]["text"] += "\n" + text
        else:
            self.messages.append({"role": "user", "content": [{"type": "text", "text": text}]})

    def add_assistant(self, content: list[dict[str, Any]]) -> None:
        self.messages.append({"role": "assistant", "content": content})

    def add_assistant_text(self, text: str) -> None:
        """导入历史聊天记录时用（没有 thinking 块的旧消息）。"""
        self.messages.append({"role": "assistant", "content": [{"type": "text", "text": text}]})

    def to_json(self) -> str:
        return json.dumps(self.messages, ensure_ascii=False)

    @classmethod
    def from_json(cls, raw: str) -> "Conversation":
        return cls(messages=json.loads(raw))


class PresalesAgent:
    def __init__(
        self,
        client: anthropic.Anthropic | None = None,
        model: str = DEFAULT_MODEL,
        effort: str = "medium",
        include_reference: bool = False,
    ) -> None:
        self.client = client or anthropic.Anthropic()
        self.model = model
        self.effort = effort
        self.system = [
            {
                "type": "text",
                "text": load_context(include_reference),
                # 知识库很长、每轮都一样：缓存 1 小时，之后每轮只按缓存价计费。
                "cache_control": {"type": "ephemeral", "ttl": "1h"},
            }
        ]

    def reply(self, conv: Conversation) -> tuple[dict[str, Any], Any]:
        """对 conv 里最后一条用户消息生成回复。成功时把 assistant 轮写回 conv。

        返回 (结构化结果, 原始 response)。拒答或解析失败时返回 FALLBACK_RESULT，且不写回 conv。
        """
        if not conv.messages or conv.messages[-1]["role"] != "user":
            raise ValueError("最后一条必须是用户消息")

        response = self.client.beta.messages.create(
            model=self.model,
            max_tokens=16000,
            # 安全分类器偶尔误拒时，由服务端自动换推荐的后备模型重答。
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=self.system,
            messages=conv.messages,
            output_config={
                "effort": self.effort,
                "format": {"type": "json_schema", "schema": REPLY_SCHEMA},
            },
        )

        if response.stop_reason != "end_turn":
            # refusal（后备模型也拒了）或 max_tokens：不发半截内容，交人工。
            return dict(FALLBACK_RESULT), response

        text = next((b.text for b in response.content if b.type == "text"), "")
        try:
            result = json.loads(text)
        except json.JSONDecodeError:
            return dict(FALLBACK_RESULT), response

        result["replies"] = [r.strip() for r in result.get("replies", []) if r.strip()][:4]
        if not result["replies"]:
            return dict(FALLBACK_RESULT), response

        conv.add_assistant(response.to_dict(exclude_none=True)["content"])
        return result, response
