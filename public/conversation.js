// 客户原话来自当前会话。滑出近期窗口后仍可按话题找回，避免只依赖改写过的摘要。
const words = new Intl.Segmenter('zh', { granularity: 'word' });
const generic = new Set(['老师', '刘校', '之前', '刚才', '一下', '已经', '那个', '这个', '怎么', '什么', '可以', '我们', '你们']);
function keywords(text) {
  return new Set(Array.from(words.segment(text.toLowerCase()), x => x.segment)
    .filter(s => s.length >= 2 && !generic.has(s)));
}

export function conversationFor(items) {
  const messages = [];
  let first = items.length;
  while (first > 0 && messages.length < 6) {
    const it = items[--first];
    if (it.kind === 'user') messages.unshift({ role: 'user', content: it.text });
    else if (it.kind === 'turn' && it.assistant) messages.unshift({ role: 'assistant', content: it.result.replies.join('\n') });
  }
  const last = items.findLast(it => it.kind === 'turn' && it.assistant)?.result;
  const memory = last?.memory || (last?.customer ? JSON.stringify({ customer: last.customer, stage: last.stage }) : '');
  const openQuestion = last?.openQuestion;
  const query = keywords([messages.at(-1)?.content, openQuestion].filter(Boolean).join(' '));
  const older = items.slice(0, first).filter(it => it.kind === 'user');
  const matches = older.map(({text}, index) => {
    const score = [...keywords(text)].filter(word => query.has(word)).length;
    return {text, index, score};
  }).filter(it => it.score > 0).sort((a,b) => b.score - a.score || b.index - a.index).slice(0, 2);
  // 保留最近表达的联系偏好，连同时间顺序一起发；客户可以在后续改主意。
  const contact = older.findLastIndex(it => /顾问|转人工|找真人|找刘校本人|别.*联系|不想.*联系/.test(it.text));
  if (contact >= 0 && !matches.some(it => it.index === contact)) matches.push({index:contact, text:older[contact].text});
  const earlier = matches.sort((a,b) => a.index - b.index).map(it => it.text.slice(0, 180));
  return { messages, memory, openQuestion, earlier };
}
