// 售前 agent 的 OpenRouter 调用（Vercel 函数和本地 dev 服务器共用）。
import CONTEXT, { CONTEXT_CHARS } from "./context.generated.js";

export { CONTEXT_CHARS };

const OPENROUTER = "https://openrouter.ai/api/v1";

// 单价：美元 / 百万 token（来自 OpenRouter /models，2026-11）。只用于界面展示，实际成本以 OpenRouter 返回的 usage.cost 为准。
export const MODELS = [
  { id: "openai/gpt-6-luna", label: "GPT-6 Luna", price: { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
];
export const DEFAULT_MODEL = MODELS[0].id;
export const EFFORTS = ["low", "medium", "high"];

const STAGES = ["接住", "诊断", "给价值", "给路径", "介绍课程", "异议处理", "报价抵扣", "转人工", "收尾", "边缘问题"];
const SKILLS = [
  "diagnose-needs", "recommend-course-path", "explain-course", "answer-teaching-question",
  "quote-price", "handle-objection", "handoff-to-human", "handle-edge-cases", "none",
];
const HANDOFF_TO = ["无", "教练", "课程顾问", "小助手", "班主任", "VIP客服", "项目组", "雅思工作人员", "客服", "刘校本人"];

export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    replies: { type: "array", items: { type: "string" } },
    stage: { type: "string", enum: STAGES },
    skill: { type: "string", enum: SKILLS },
    customer: {
      type: "object",
      properties: {
        identity: { type: "string" },
        goal: { type: "string" },
        child: { type: "string" },
        courses_taken: { type: "string" },
        intent: { type: "string", enum: ["冷", "温", "热"] },
      },
      required: ["identity", "goal", "child", "courses_taken", "intent"],
      additionalProperties: false,
    },
    handoff: {
      type: "object",
      properties: {
        needed: { type: "boolean" },
        to: { type: "string", enum: HANDOFF_TO },
        reason: { type: "string" },
      },
      required: ["needed", "to", "reason"],
      additionalProperties: false,
    },
    kb_refs: { type: "array", items: { type: "string" } },
  },
  required: ["replies", "stage", "skill", "customer", "handoff", "kb_refs"],
  additionalProperties: false,
};

const FALLBACK = {
  replies: ["老师，这个我看一下，稍后回你[抱拳]"],
  stage: "转人工",
  skill: "handoff-to-human",
  customer: { identity: "未知", goal: "未知", child: "未知", courses_taken: "未知", intent: "冷" },
  handoff: { needed: true, to: "刘校本人", reason: "agent 未能生成回复，请人工查看对话" },
  kb_refs: [],
};

const MAX_MESSAGES = 80;
const MAX_CHARS = 4000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 客户端传来的历史：[{role:"user"|"assistant", content, reasoning_details?, model?}]
// 只接受 user / assistant，截断超长内容，合并连续的客户消息（微信里常连发几条）。
function sanitizeHistory(history, model) {
  if (!Array.isArray(history) || history.length === 0) throw new HttpError(400, "messages 不能为空");
  if (history.length > MAX_MESSAGES) throw new HttpError(400, `一次会话最多 ${MAX_MESSAGES} 条消息，请新开会话`);
  const out = [];
  for (const m of history) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") continue;
    const content = m.content.slice(0, MAX_CHARS);
    const last = out[out.length - 1];
    if (m.role === "user" && last && last.role === "user") {
      last.content += "\n" + content;
      continue;
    }
    const msg = { role: m.role, content };
    // 同一模型的思考块原样带回（Claude 多轮对话要求）；换了模型的旧思考块不带。
    if (m.role === "assistant" && Array.isArray(m.reasoning_details) && m.model === model) {
      msg.reasoning_details = m.reasoning_details;
    }
    out.push(msg);
  }
  if (!out.length || out[out.length - 1].role !== "user") throw new HttpError(400, "最后一条必须是客户消息");
  return out;
}

function buildBody({ messages, model, effort, structured }) {
  const system = {
    role: "system",
    content: CONTEXT,
  };
  const body = {
    model,
    messages: [system, ...messages],
    reasoning: { effort },
    usage: { include: true },
    max_tokens: 8000,
  };
  if (structured) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "liuxiao_reply", strict: true, schema: REPLY_SCHEMA },
    };
    body.provider = { require_parameters: true };
  } else {
    body.messages.push({ role: "system", content: "只输出符合上面「输出格式」的一个 JSON 对象，不要输出其他文字。" });
  }
  return body;
}

async function post(apiKey, body) {
  const res = await fetch(`${OPENROUTER}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Liuxiao Presales Simulator",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: { message: text.slice(0, 300) } };
  }
  return { status: res.status, data };
}

function parseResult(content) {
  if (typeof content !== "string") return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const r = JSON.parse(content.slice(start, end + 1));
    if (!Array.isArray(r.replies)) return null;
    r.replies = r.replies.map((s) => String(s).trim()).filter(Boolean).slice(0, 4);
    return r.replies.length ? r : null;
  } catch {
    return null;
  }
}

export async function chat(apiKey, { messages: history, effort = "medium" }) {
  // 已打开的旧版客户端仍可能发送 Claude 模型名，统一使用本站当前模型。
  const model = DEFAULT_MODEL;
  if (!EFFORTS.includes(effort)) throw new HttpError(400, "不支持的 effort");
  let messages = sanitizeHistory(history, model);

  const started = Date.now();
  let { status, data } = await post(apiKey, buildBody({ messages, model, effort, structured: true }));

  // 带回的思考块被拒：去掉后重试一次。
  if (status === 400 && messages.some((m) => m.reasoning_details)) {
    messages = messages.map(({ reasoning_details, ...m }) => m);
    ({ status, data } = await post(apiKey, buildBody({ messages, model, effort, structured: true })));
  }
  // 结构化输出不被支持：退回提示词约束 JSON。
  if (status === 400 || status === 404) {
    ({ status, data } = await post(apiKey, buildBody({ messages, model, effort, structured: false })));
  }
  const latencyMs = Date.now() - started;

  if (status === 401 || status === 403) throw new HttpError(status, "OpenRouter key 无效或没有权限");
  if (status === 402) throw new HttpError(402, "OpenRouter 额度不足（这个 key 可能到了每日限额）");
  if (status >= 400) throw new HttpError(502, `OpenRouter 出错（${status}）：${data?.error?.message || "未知错误"}`);

  const choice = data.choices?.[0];
  const message = choice?.message || {};
  const parsed = choice?.finish_reason === "stop" || choice?.finish_reason === "end_turn" ? parseResult(message.content) : null;
  const result = parsed || { ...FALLBACK, error: `模型未正常返回（${choice?.finish_reason || "无结果"}）` };

  const u = data.usage || {};
  const usage = {
    cost: typeof u.cost === "number" ? u.cost : null,
    promptTokens: u.prompt_tokens || 0,
    cachedTokens: u.prompt_tokens_details?.cached_tokens || 0,
    cacheWriteTokens: u.prompt_tokens_details?.cache_write_tokens || 0,
    completionTokens: u.completion_tokens || 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens || 0,
  };

  return {
    result,
    usage,
    model: data.model || model,
    provider: data.provider || null,
    latencyMs,
    // 客户端原样存下，下一轮带回来。
    assistant: parsed
      ? { role: "assistant", content: message.content, reasoning_details: message.reasoning_details || null, model }
      : null,
  };
}

export async function keyInfo(apiKey) {
  const res = await fetch(`${OPENROUTER}/key`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new HttpError(res.status === 401 ? 401 : 502, `读取 OpenRouter 用量失败（${res.status}）`);
  const d = (await res.json()).data || {};
  return {
    usage: d.usage ?? null,
    usageDaily: d.usage_daily ?? null,
    usageWeekly: d.usage_weekly ?? null,
    usageMonthly: d.usage_monthly ?? null,
    limit: d.limit ?? null,
    limitRemaining: d.limit_remaining ?? null,
    limitReset: d.limit_reset ?? null,
    resetsAt: d.effective_budget?.resets_at ?? null,
  };
}

// 取 key：优先用服务器环境变量；没有配置时用页面上用户自己填的 key（只存在浏览器里）。
export function resolveKey(headers) {
  const key = process.env.OPENROUTER_API_KEY || headers["x-openrouter-key"];
  if (!key) throw new HttpError(401, "还没有配置 OpenRouter key：在页面「设置」里填写，或在 Vercel 环境变量里设置 OPENROUTER_API_KEY");
  return key;
}

export function checkAccess(headers) {
  const code = process.env.ACCESS_CODE;
  if (code && headers["x-access-code"] !== code) throw new HttpError(403, "访问码不正确");
}
