// 把 agent/system_prompt.md + skills/*/SKILL.md + kb/*.md 拼成一个字符串，写进 lib/context.generated.js。
// 拼法和 bot/agent.py 的 load_context() 完全一致（顺序固定，提示缓存才能命中）。
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const parts = [read("agent/system_prompt.md")];

parts.push("# Skills（每个场景的做法）");
for (const name of readdirSync(join(root, "skills")).sort()) {
  const p = join("skills", name, "SKILL.md");
  if (existsSync(join(root, p))) parts.push(`<skill name="${name}">\n${read(p)}\n</skill>`);
}

parts.push("# 知识库");
for (const name of readdirSync(join(root, "kb")).sort()) {
  if (!name.endsWith(".md") || name === "README.md") continue;
  parts.push(`<kb file="${name}">\n${read(join("kb", name))}\n</kb>`);
}

const text = parts.join("\n\n");
writeFileSync(
  join(root, "lib", "context.generated.js"),
  `// 自动生成，请勿手改：npm run build\nexport const CONTEXT_CHARS = ${text.length};\nexport default ${JSON.stringify(text)};\n`,
);
console.log(`context: ${text.length} chars`);
