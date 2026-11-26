import assert from 'node:assert/strict';
import test from 'node:test';
import { retrieve } from '../lib/retrieval.js';
import { chat } from '../lib/agent.js';

const user = content => ({role: 'user', content});

test('报价保留权威价表中的状态，并随课程切换', () => {
  const [price] = retrieve([user('那多少钱？')], '对方正在了解三会阅读师资班');
  assert.match(price.body, /三会阅读师资班 \| 7980 元 \| 可报/);
  const hits = retrieve([user('三会多少钱？'), {role:'assistant', content:'三会阅读7980'}, user('雅思课学费呢？')]);
  assert.equal(hits.length, 1);
  assert.match(hits[0].body, /雅思课 \| 6980 元 \| 待确认/);
  assert.deepEqual(retrieve([user('在吗')]), []);
  assert.deepEqual(retrieve([user('火星课多少钱？')]), []);
});

test('旧长会话只发送近期对话、上轮记忆和本轮资料', async t => {
  let sent;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent = JSON.parse(options.body);
    const reply = {replies:['三会阅读7980'], memory:'关注三会，已报价。', kb_refs:['02_价格与抵扣.md', '其他.md']};
    return Response.json({ choices: [{finish_reason:'stop',message:{content:JSON.stringify(reply)}}], usage:{cost:0.001} });
  });
  const previous = {role:'assistant',content:JSON.stringify({replies:['您说'],memory:'旧的模型 JSON'}), reasoning_details:[{}]};
  const history = [user('很久之前的消息'), ...Array.from({length:44}, () => [previous, user('嗯')]).flat(), user('那多少钱？')];
  const res = await chat('fixture', {messages:history,memory:'当前关注三会阅读'});
  assert(sent.messages.length <= 8);
  assert(sent.messages.some(m => m.role === 'user' && m.content.includes('当前关注三会阅读')));
  assert(!sent.messages.some(m => m.content.includes('很久之前的消息') || m.content.includes('旧的模型 JSON') || m.reasoning_details));
  assert.equal(res.retrieval.count, 1);
  assert.deepEqual(res.result.kb_refs, ['02_价格与抵扣.md']);
  assert.equal(res.result.memory, '关注三会，已报价。');
  assert.equal(res.usage.cost, 0.001);
});
