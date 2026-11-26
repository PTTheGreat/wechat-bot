// 本地预览：静态文件 + 把 /api/* 交给和 Vercel 一样的处理函数。
// NODE_USE_ENV_PROXY=1 OPENROUTER_API_KEY=... node scripts/dev.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
let mockN = 0;
const port = Number(process.env.PORT || 3000);

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (process.env.MOCK && (url.pathname === "/api/chat" || url.pathname === "/api/stats")) {
    // 界面测试用：不调 OpenRouter，返回假数据。
    for await (const _ of req);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (url.pathname === "/api/stats") return res.end(JSON.stringify({ usage: 0.31, usageDaily: 0.27, usageWeekly: 0.31, usageMonthly: 0.31, limit: 1, limitRemaining: 0.73, limitReset: "daily", resetsAt: "2026-11-27T00:00:00.000Z" }));
    mockN = (mockN || 0) + 1;
    const cold = mockN === 1;
    await new Promise((r) => setTimeout(r, 600));
    return res.end(JSON.stringify({
      result: { replies: ["没有加盟啊", "只有陪学师", "您是给孩子问还是给你自己问？[抱拳]"], stage: "诊断", skill: "diagnose-needs",
        customer: { identity: "宝妈", goal: "教自己孩子", child: "初二，50多分/120", courses_taken: "未知", intent: "温" },
        handoff: { needed: mockN % 3 === 0, to: mockN % 3 === 0 ? "教练" : "无", reason: mockN % 3 === 0 ? "要报名链接，转教练核算" : "" }, kb_refs: ["01_课程体系与选课路线.md"] },
      usage: { cost: cold ? 0.234608 : 0.0197, promptTokens: 46488, cachedTokens: cold ? 0 : 46264, cacheWriteTokens: cold ? 46264 : 0, completionTokens: 478, reasoningTokens: 224 },
      model: "anthropic/claude-opus-5.5", provider: "Mock", latencyMs: 4479,
      assistant: { role: "assistant", content: "{}", reasoning_details: null, model: "anthropic/claude-opus-5.5" } }));
  }
  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice(5).replace(/[^a-z]/g, "");
    let mod;
    try { mod = await import(join(root, "api", `${name}.js`)); } catch { res.writeHead(404).end(); return; }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    req.body = raw ? JSON.parse(raw) : {};
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); return res; };
    return mod.default(req, res);
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  try {
    const body = await readFile(join(root, "public", file));
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end("not found"); }
}).listen(port, () => console.log(`http://localhost:${port}`));
