import { chat, resolveKey, checkAccess, HttpError } from "../lib/agent.js";

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "只支持 POST" });
  try {
    checkAccess(req.headers);
    const key = resolveKey(req.headers);
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const out = await chat(key, body);
    return res.status(200).json(out);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    return res.status(status).json({ error: err instanceof HttpError ? err.message : "服务器出错" });
  }
}
