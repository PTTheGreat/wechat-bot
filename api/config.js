import { MODELS, DEFAULT_MODEL, EFFORTS, CONTEXT_CHARS } from "../lib/agent.js";

export default function handler(req, res) {
  res.status(200).json({
    hasServerKey: Boolean(process.env.OPENROUTER_API_KEY),
    accessCodeRequired: Boolean(process.env.ACCESS_CODE),
    models: MODELS,
    defaultModel: DEFAULT_MODEL,
    efforts: EFFORTS,
    contextChars: CONTEXT_CHARS,
  });
}
