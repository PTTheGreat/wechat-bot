# 刘校英语课程 · 微信售前 agent

替刘校在微信上接住英语课程（拼音师资班、三会阅读师资班、中高考专项师资班、小阶、陪学师……）的售前咨询。
目标是**循序渐进**：先接住问题、给一点实在帮助，再给学习路线，对方主动问才报价，下单交给教练/课程顾问。所有措辞尽量用刘校课程和聊天里的原话。

## 目录

```
agent/system_prompt.md      角色、循序渐进的阶段、硬规则、输出格式
skills/                     7 个场景 skill（每个都是 SKILL.md，可直接放进 Claude / 其他平台）
  diagnose-needs/             接住与诊断（谁学、目标、孩子情况、学过什么）
  recommend-course-path/      按刘校的决策树选课
  explain-course/             用原话介绍课程、方法、区别
  answer-teaching-question/   先帮解决孩子的具体问题（给价值）
  quote-price/                报价、算抵扣、转教练
  handle-objection/           太贵 / 没时间 / 怕学不会 / 家人反对 / 质疑
  handoff-to-human/           转人工与售后
kb/                         知识库（agent 每轮都会读）
  01_课程体系与选课路线.md
  02_价格与抵扣.md            ← 调价、改活动只改这一个文件
  03–06_课程_*.md             四类课程：定位、适合谁、上课形式、能说/不能说
  07_售前FAQ.md               高频问题 → 刘校原话
  08_异议处理.md
  09_教学答疑.md              孩子具体问题的"方法处方"
  10_转人工与售后.md
  11_红线与禁止承诺.md
  12_刘校说话风格.md
  reference/                  从原始数据提炼的完整报告（原话更全，默认不放进上下文）
bot/agent.py                调用 Claude 生成一轮回复（结构化输出）
bot/cli.py                  终端里试聊
eval/cases.jsonl            25 个评测用例（取自真实对话）
eval/run_eval.py            跑评测
```

## 设计思路

**为什么是 知识库 + skills + system prompt 三层**

| 层 | 放什么 | 改动频率 |
|---|---|---|
| system prompt | 刘校是谁、循序渐进的阶段表、不能破的硬规则、输出格式 | 很少改 |
| skills | 每类场景"怎么做"：步骤、该问什么、该引用哪个知识库文件、真实例子、不要做什么 | 打磨话术时改 |
| 知识库 | "说什么"：课程事实、价格、抵扣规则、刘校原话、转给谁 | 调价、开新期、补 FAQ 时改 |

**循序渐进的阶段**（来自刘校自己教学员的招生顺序："先跟后带 → 讲清问题 → 上眼药 → 留后续 → 讲清过程和配合"）：

接住 → 诊断 → 给价值 / 介绍课程 → 给路径 → （对方主动问）报价抵扣 → 转教练下单
任何阶段遇到钱款、权限、退费、投诉 → 转人工。对方说"再考虑" → 收尾，不追。

**每轮输出**（JSON，系统负责发送）：
- `replies`：1–4 条短消息，按刘校习惯拆开发
- `stage` / `skill`：本轮在哪一步、用了哪个 skill
- `customer`：客户画像（身份、目标、孩子、已学课程、意向冷/温/热），可写进 CRM
- `handoff`：要不要转人工、转给谁（教练 / 课程顾问 / 小助手 / 班主任 / VIP客服 / 项目组 / 雅思工作人员 / 客服 / 刘校本人）、给真人看的一句话
- `kb_refs`：依据了哪些知识库文件，方便核对

## 数据来源

- 2026 年首次咨询联系人的微信聊天记录（含语音转写，截至 2026-10-26）。文件头写的是 66 位，压缩包里实际有 64 个文件，其中 1 个已损坏读不出来，实际分析了 63 位。
- 61 份腾讯会议逐字稿：拼音师资班 19、三会阅读师资班 22、中高考专项 12、小阶 8（2026-09 至 11）。
- 逐字稿里的"答疑"部分已被拆到另一个目录 `腾讯会议答疑/`，这次**没有提供**，所以课上答疑只有编辑摘要（`kb/reference/transcript_qa_summaries.md`）。拿到后可以补进 FAQ。
- 已匿名化：知识库里没有客户姓名、昵称、手机号、学号；讲师只保留杨妈、科校、阿丽老师等品牌名，其他人用角色代替。**原始聊天记录不要提交到这个仓库**（`.gitignore` 里留了 `raw/`）。

## 本地试聊

```bash
pip install -r requirements.txt
```

```bash
export ANTHROPIC_API_KEY=你的key
```

```bash
python -m bot.cli --show-meta
```

只看拼好的提示词（不花钱）：

```bash
python -m bot.cli --dump-prompt > /tmp/prompt.txt
```

## 跑评测

每个用例调用一次 API；加 `--judge` 再让 Claude 按用例里的 must / must_not 打分（每例多一次调用）。

```bash
python -m eval.run_eval
```

```bash
python -m eval.run_eval --judge --only 08,09,10
```

改完知识库或 skill，先跑一遍评测再上线。

## 接入微信（思路）

`bot/agent.py` 不依赖任何微信框架，接入时只需要：

```python
from bot.agent import PresalesAgent, Conversation

agent = PresalesAgent()                       # 进程里只建一个，复用提示缓存
conv = load_conversation(contact_id)          # 每个联系人一份，用 Conversation.from_json 读
conv.add_user(incoming_text)                  # 对方连发几条会自动合并成一轮
result, _ = agent.reply(conv)
for text in result["replies"]:
    send_wechat(contact_id, text)             # 每条之间停 1–3 秒，像真人打字
if result["handoff"]["needed"]:
    push_name_card(contact_id, result["handoff"]["to"])   # 推对应同事的名片
    notify_staff(result["handoff"], result["customer"])   # 通知真人接手
save_conversation(contact_id, conv.to_json())
```

要点：
- **一定按联系人持久化 `Conversation`**，并原样保存 assistant 轮的 content（里面有 thinking 块，Claude Opus 5.5 要求原样带回）。
- 转给"刘校本人"时，建议这个联系人暂停自动回复，等刘校处理完再开。
- 图片、语音、文件：agent 看不到内容，会请对方打字或转人工。要支持图片（试卷）可以把图片作为 image 块加进 user 消息。
- 名片、链接、手机号由接入层推送，agent 的回复里不会出现。
- 对方认真问"你是不是机器人"时，agent 会说明是 AI 助手在先回复，并转刘校本人——这是有意的设计，请保留。

## 模型和成本

- 模型：`claude-opus-5-5`，effort 默认 `medium`（可用 `--effort` 调）；开启了服务端后备模型（偶发误拒时自动换模型重答）。
- system prompt 约 4.2 万字，开了 1 小时提示缓存：同一小时内后续每轮只按缓存价计输入。
- 大致每条回复几分钱人民币到一两毛（主要是输出和思考 token），首次写缓存另计。上线前用 `--show-meta` 看实际 token 再估。
- 想要原话更全：`--with-reference` 会把 `kb/reference/` 也放进去（约 24 万字），成本明显上升，一般不需要。

## 维护

| 要做的事 | 改哪里 |
|---|---|
| 调价、新活动、改抵扣规则 | `kb/02_价格与抵扣.md`（把"待确认"改成"可报"agent 就会报） |
| 新开一期、改上课时间 | 对应的 `kb/03–06_课程_*.md` |
| 发现 agent 答错一类问题 | 在 `kb/07_售前FAQ.md` 或 `kb/08_异议处理.md` 加一条"问法 → 刘校原话 → 要点"，再在 `eval/cases.jsonl` 加一个用例 |
| 话术不像刘校 | `kb/12_刘校说话风格.md` 的对错示范 |
| 新增转人工对象 | `kb/10_转人工与售后.md` + `bot/agent.py` 里的 `HANDOFF_TO` |

## 需要刘校确认的事（agent 目前按"不确定就转人工"处理）

1. 价格表里标"待确认"的：小阶、中高阶、科校小中高阶、口才、高中雅思的价格；中高阶"全款抵扣"福利是否还有效；哪些课能分期；特约师佣金。
2. 陪学师 29800 具体包含哪些课、当期有什么活动——需要一段标准介绍，目前全部转课程顾问。
3. 零基础家长先学口才还是先学三会：聊天里两种说法都有，agent 默认三会为主。
4. 三会、中高考专项、小阶下一期的开课时间。
5. 拼写课以后是否单独收费；拼音师资班"招不到学生全额退"的具体条件。
6. 退费规则、合同、发票、资质 / 双减的对外口径。
7. 招生收费体系、招生渠道（学员常问，刘校聊天里没有正面回答过）。
8. 缺失的 `腾讯会议答疑/` 目录，以及压缩包里损坏的 1 个联系人文件。
