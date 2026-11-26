// 以 Markdown 段落、问答和表格行建立服务端语料。表格行保留列名和状态。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const passages = [];

function indexFile(source, text) {
  const headings = [];
  let block = [], tableHeader = '';
  function add(body) {
    if (body.trim()) passages.push({ source, title: headings.filter(Boolean).join(' / '), body: body.trim() });
  }
  function flush() { add(block.join('\n')); block = []; }
  for (const line of text.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.+)/);
    if (heading) {
      flush(); headings.length = heading[1].length; headings[headings.length - 1] = heading[2];
      tableHeader = '';
    } else if (line.startsWith('|')) {
      flush();
      if (!tableHeader) tableHeader = line;
      else if (!/^\|[\s:|-]+$/.test(line)) add(tableHeader + '\n' + line);
    } else if (!line.trim() || line.trim() === '---') {
      flush(); tableHeader = '';
    } else {
      if (/^\*\*[A-Z]\d+\b/.test(line) || (block.join('\n').length > 450 && /^\s*[-\d]/.test(line))) flush();
      block.push(line);
    }
  }
  flush();
}

for (const name of readdirSync(new URL('kb/', root)).sort()) {
  if (/^\d+_.*\.md$/.test(name)) indexFile(name, read('kb/' + name));
}
for (const dir of readdirSync(new URL('skills/', root), { withFileTypes: true })) {
  if (dir.isDirectory()) indexFile(dir.name + '/SKILL.md', read('skills/' + dir.name + '/SKILL.md'));
}
const base = read('agent/system_prompt.md').trim();
const generated = '// 自动生成，请勿手改：npm run build\n' +
  `export const basePrompt = ${JSON.stringify(base)};\n` +
  `export const passages = ${JSON.stringify(passages, null, 2)};\n`;
writeFileSync(fileURLToPath(new URL('lib/context.generated.js', root)), generated);
console.log(`基础指令 ${base.length} 字符，已索引 ${passages.length} 个段落`);
