import { keyInfo, resolveKey, checkAccess, HttpError } from "../lib/agent.js";

export default async function handler(req, res) {
  try {
    checkAccess(req.headers);
    const info = await keyInfo(resolveKey(req.headers));
    return res.status(200).json(info);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    return res.status(status).json({ error: err instanceof HttpError ? err.message : "服务器出错" });
  }
}
