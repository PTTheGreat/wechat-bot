import { passages } from './context.generated.js';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const stop = new Set('老师 孩子 我们 你们 可以 这个 那个 这个课 一下 怎么 什么 多少 你好 刘校 课程 学习 想要 想问 请问 有没有 现在'.split(' '));
function terms(text) {
  const words = new Set();
  for (const {segment, isWordLike} of segmenter.segment(text.toLowerCase())) {
    if (isWordLike && segment.length >= 2 && !stop.has(segment)) words.add(segment);
  }
  for (const [run] of text.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    for (let i = 1; i < run.length; i++) {
      const pair = run.slice(i - 1, i + 1);
      if (!stop.has(pair)) words.add(pair);
    }
  }
  return words;
}

const freq = new Map();
const index = passages.map(p => {
  const body = terms(p.body), title = terms(p.title);
  for (const term of new Set([...body, ...title])) freq.set(term, (freq.get(term) || 0) + 1);
  return { passage: p, body, title };
});
const course = /三会|拼音|中高考|中高阶|小阶|陪学师|口才|口语|外教|雅思/g;
const priceIntent = /多少钱|多少[块元]|价[格钱]|什么价|怎么收费|费用|学费|几块|多钱/;
const discountIntent = /抵[扣消]|能抵|补[差多]|差价|分期|优惠|折扣|打折|便宜[一点些]|便宜点/;
const greeting = /^(?:在吗|你好|您好|谢谢|好的|好嘞|再见|收到|嗯嗯|谢谢老师|辛苦了)[啊哦呢呀吗！!？?。\s]*$/;

const backReference = /刚才|前面|上面|之前那个|接着说|接着聊|你还没[回答说]|别绕|说人话|套话|官腔|像客服|别推顾问|只想跟你聊|(?:你|这).{0,8}(?:AI|机器人)/i;
const asksIdentity = /[是本]人.{0,5}(?:打字|在回)|认真问|到底是.{0,4}(?:本人|机器人)|换(?:真人|人工)|找刘校本人/;
const businessTopic = /回放|上课|怎么选|适合|便宜|打折|报名|退费|退款|投诉|发票|优惠|抵扣|学费|多少钱|补差价|分期/;

export function isToneFeedback(text) {
  const line = text.trim();
  if (line.length > 36 || asksIdentity.test(line) || /[？?吗，,；;]/.test(line) || businessTopic.test(line)) return false;
  return /(?:像|就是|真是|分明是|明明是).{0,5}(?:AI|机器人|客服)|套话|说人话|官腔|少来这套/i.test(line);
}

export function retrieve(messages, memory = '', pending) {
  let query = messages.at(-1).content.trim();
  // 回忆客户自己说过的资料时，从对话取证即可。
  if (/(?:我家|我孩子|我说过|我刚才说|我之前|还记得|我娃)/.test(query) && /几年级|哪[个一]?年级|上次考.{0,3}[几多]分|上次考几分|我学过哪门/.test(query) && !businessTopic.test(query)) return [];
  // “说人话”“那刚才的呢”承接悬着的问题。价格等事实仍重新查资料。
  if (backReference.test(query) && !asksIdentity.test(query) && !businessTopic.test(query) && !query.match(course)) {
    let subject = pending;
    if (subject == null) {
      // 老会话只有自然语言摘要和聊天记录。
      const priorQuestion = messages.slice(0, -1).findLast(m => m.role === 'user' && businessTopic.test(m.content));
      subject = priorQuestion?.content || (/待确认|未答|尚未|待回复|想知道/.test(memory) ? memory : '');
    }
    if (subject) query = subject;
  }
  if (greeting.test(query)) return [];
  const mentioned = [...new Set(query.match(course) || [])];
  // 仅在追问省略了对象时借用近邻对话。新话题不会继承旧课名。
  const lastLine = query.split('\n').at(-1).trim();
  const followUp = !mentioned.length && /^(那|这[门个]|它|要多少|多少钱|怎么收费|有回放|可以回放|能抵|能分期|有优惠)|^(学费|价格|费用|回放|适合谁|怎么上课)[呢吗啊？?。\s]*$/.test(lastLine);
  let prior = '';
  if (followUp) {
    const previous = messages.slice(0, -1).reverse().find(m => m.content.match(course));
    prior = previous?.content || memory;
  }
  const courses = mentioned.length ? mentioned : [...new Set(prior.match(course) || [])];
  const queryTerms = terms(query);
  for (const name of courses) queryTerms.add(name);
  const wantsPrice = priceIntent.test(query), wantsDiscount = discountIntent.test(query);
  const wantsHandoff = /退费|退款|投诉|开发票|联系真人/.test(query);
  const objection = /太贵|嫌贵|好贵|没时间|家人反对|家里人不同意/.test(query);
  const courseDetails = courses.length > 0 && /回放|直播|怎么上|课时|教什么|讲什么|适合谁|上课形式|怎么教|几节|包括什么/.test(query);
  const priceTable = p => p.source.startsWith('02_') && p.title.includes('课程标价') && p.body.startsWith('|');
  const score = entry => {
    const p = entry.passage;
    if (wantsPrice && !wantsDiscount) {
      // 报价只发送权威价表中命中课程的行，保留“待确认”等限制。
      if (!priceTable(p)) return 0;
      const name = p.body.split('\n')[1].split('|')[1];
      return courses.some(c => name.includes(c)) ? 100 : 0;
    }
    if (wantsDiscount && /优惠|打折|便宜|折扣/.test(query) && p.source.startsWith('02_') && /\| D8 \|/.test(p.body)) return 100;
    if (wantsPrice && wantsDiscount && priceTable(p) && courses.some(c => p.body.split('\n')[1].split('|')[1].includes(c))) return 100;
    if (!wantsDiscount && !wantsHandoff && p.source.startsWith('02_')) return 0;
    if (wantsHandoff && !/^(10_|handoff-to-human)/.test(p.source)) return 0;
    if (objection && !/^(08_|handle-objection)/.test(p.source)) return 0;
    let n = 0;
    for (const word of queryTerms) {
      if (!entry.body.has(word) && !entry.title.has(word)) continue;
      const idf = Math.log(1 + index.length / freq.get(word));
      n += idf * ((entry.body.has(word) ? 1 : 0) + (entry.title.has(word) ? 0.7 : 0));
    }
    if (wantsDiscount && p.source.startsWith('02_')) n *= p.title.includes('抵扣与补差价规则') ? 2.8 : 1.3;
    if (courseDetails && /^0[3-6]_/.test(p.source) && courses.some(c => (p.source.startsWith('06_') ? p.title.split(' / ').at(-1) : p.source).includes(c))) n *= 3;
    return n;
  };
  const ranked = index.map(entry => ({ p: entry.passage, n: score(entry) })).sort((a,b) => b.n - a.n);
  const hits = [];
  let size = 0;
  for (const { p, n } of ranked) {
    if (n < Math.max(4, ranked[0].n * 0.6) || hits.length === 4) break;
    const length = p.source.length + p.title.length + p.body.length + 12;
    if (size + length > 2000) continue;
    hits.push(p);
    size += length;
  }
  return hits;
}
