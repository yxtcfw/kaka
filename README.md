# daily-blog · 论坛式每日连载

一个仓库跑完整闭环：**挖题 → 取材 → 写作 → 建站 → 推送通知**。

站点是一个长帖，按页连载。每页由「1 楼主贴 + 若干楼层」组成，读起来像在翻一个不断更新的论坛帖，而不是一堆博客文章。

零依赖，`docs/` 就是站点。

## 每天怎么跑

```
每天 07:00 / 11:00 / 15:00 / 19:00 各触发一次（UTC 23,3,7,11）
  ├─ 挖题  扫 docs/posts/*.md，捞带「怎么/为什么/能不能/？」的句子，随机挑一条
  ├─ 取材  抓信源最近 48h 内容 → 从选题抽检索词 → 只挑命中的（最多 6 条）
  ├─ 写作  模型带着素材，写主楼长文 + 3~5 个楼层
  ├─ 落盘  写成 docs/posts/00N.md（页码自动递增）
  └─ 建站  重新生成整站，提交回 main
```

**为什么要设四个时间点**：GitHub 的定时任务会被延迟，甚至整点直接吞掉，这是它自己的机制，改不了。所以一天试四次，脚本自带幂等——当天已经写过就直接跳过，前面几次被吞了后面还能补上。

## 站点结构

```
docs/
  index.md          帖子开头的说明，显示在首页顶部
  posts/
    001.md          第 1 页
    002.md          第 2 页
    ...
```

- **首页 `index.html`** 就是第 1 页（不另外生成 `posts/001.html`）
- 其余页是 `posts/002.html`、`posts/003.html`
- 每页底部：`共 N 页 · 第 X 页` + 首页/上一页/页码/下一页/末页
- 另外还有 `search.html`、`feed.xml`、`sitemap.xml`

## 一页 md 怎么写

```markdown
---
title: 页面标题
date: 2026-11-20
---

# 页面标题

主楼正文，可以是几段 markdown。

## 2楼 · 网友·阿强 · 10:12
楼层内容。

## 3楼 · 网友·小北 · 10:20
可以反驳、可以追问。

## 4楼 · 楼主 · 10:35
楼主回复。
```

规则很简单：

- 第一个 `#` 是页面标题
- `#` 之后、第一个 `## N楼` 之前的内容是主楼（1 楼）
- 每个 `## N楼 · 作者 · 时间` 是一层，作者和时间都可省略
- 作者名里可以带 `·`（比如「网友·阿强」），解析时会按「最后一段像不像时间」来判断

文件名按数字排：`001.md`、`002.md`…… 你手动加一页就是 `005.md`，push 上去自动重建。

## 文件

```
.github/workflows/daily.yml     定时写新的一页
.github/workflows/build.yml     你改了 md/配置/样式后自动重建
scripts/sources.py              采集层：RSS / Atom / JSON / HTML
scripts/mine.py                 从旧帖挖疑问句
scripts/blogsite.py             渲染层：楼层、分页、搜索、RSS
scripts/generate.py             编排：挖题、取材、写作、落盘
scripts/notify.py               结果推送到企业微信
config/sources.json             信源 + 搜索接口
config/keywords.txt             关键词，给素材打分用
config/editorial.md             编辑偏好：写什么、不写什么
config/persona.md               文风
config/site.json                站名、副标题、页脚
docs/style.css                  样式
```

## 上线五步

1. **建仓库**，把本目录所有文件传上去（注意：仓库根目录下要直接看到 `.github`、`config`、`docs`、`scripts`，不能多套一层文件夹）。
2. **拿 Key**：openrouter.ai → Keys。
3. **加 Secret**：`OPENROUTER_API_KEY`（可选再加 `WECOM_WEBHOOK`，企业微信群机器人的地址）。
4. **开 Pages**：Settings → Pages → Source 选 `Deploy from a branch` → `main` + `/docs`。
5. **先自检**：Actions → `daily-post` → Run workflow → mode 选 **probe**，确认信源都通。

## 手动模式

- **auto** — 正常写一页
- **probe** — 只测信源
- **rebuild** — 不调模型，只按现有 md 重建整站（改样式后用）

命令行还能：

```bash
python3 scripts/generate.py -k 某个主题     # 指定主题，跳过挖题
python3 scripts/generate.py --force         # 今天写过也再写一页
python3 scripts/mine.py docs/posts          # 看看现在能挖出哪些疑问
```

## 搜索接口（预留）

`config/sources.json` 里：

```jsonc
"search": {
  "provider": "none",         // none = 只用信源素材
  "searxng_url": "",          // 改成 "searxng" 后填实例地址
  "max_results": 8
}
```

以后部署了 SearXNG，把 `provider` 改成 `searxng`、填上地址就能用，代码不用动。目前 `none` 时只靠信源。

## 一页的结构（连载怎么接上）

没有「楼主」这个概念，所有人都是楼层，页面上也不显示「第几楼」，只显示昵称和签名。

```
1 楼        只抛出问题 / 痛点 / 话题（来自上一页的候选），不展开
2 楼起      围绕它讨论、问答、辩论，每层 40~100 字
最后 2~3 层 各自抛出一个新问题，作为下一页的候选
```

md 里长这样：

```markdown
## @阿强 · 10:12
流量卡怎么办理才划算？同事那张 19 块 100G 的，用到第三个月就被限速了。

## @小北 · 10:20
只在运营商 App 里办，第三方代理便宜十块但没售后。
```

楼层标记是 `## @昵称 · 时间`。昵称和签名来自 `config/names.json`：

```json
[
  { "nick": "阿强", "sign": "十年运维，见坑就填" },
  { "nick": "小北", "sign": "在读研究生，穷但快乐" }
]
```

生成时这份名单会整个塞进 prompt，模型只能从里面选人，不能自己编名字。渲染时昵称下面自动带出签名。想加人就往 JSON 里加一条，不用改代码。

旧格式 `## 2楼 · 阿强 · 10:12` 也认，只是页面上照样不显示楼层号。

**问题怎么传到下一页**：结尾几层的问题写进 front matter：

```yaml
question: 流量卡怎么办理才划算？
next_questions: ["限速后的卡还能救吗？", "异地号码补卡要多久？"]
```

下一页从 `next_questions` 里随机挑一个，**1 楼原样提出这句话**，一个字不改。所以第 N 页的讨论会长出第 N+1 页的议题。

三层兜底：模型给数组 → 从最后三层抠问号句 → 补一次小请求。都空才退回随机挖旧帖。

## 素材是怎么挑的

不是「抓什么喂什么」，是按选题筛：

1. 抓所有信源最近 48 小时的内容
2. 把选题（比如「流量卡怎么办理才划算？」）交给模型，抽 3~5 个检索词（`流量卡 / 办理 / 运营商`）
3. 用这些词去匹配标题和摘要，命中越多排越前
4. **只把命中的最多 6 条喂给模型**，一条都不命中就明说

日志里能看到筛选过程：

```
[daily] 检索词：流量卡、办理、运营商 ｜ 命中 2 条相关素材（信源共 3 条）
[daily]    · [流量卡,运营商] 运营商上线 19 元 100G 套餐，代理商渠道收紧
[daily]    · [流量卡,办理] 流量卡办理要实名，异地补卡麻烦
```

被过滤掉的比如主机发售、徒步指南，不会混进 prompt。

**一条都没命中**时，prompt 里会写「信源里没有相关内容，可以基于已有知识回答，但不要编造具体数字、价格、时间」，而不是塞一堆无关素材让模型强行关联。

**这里的能力边界要清楚**：信源是 RSS/接口，只能拿到「最近发布的内容」，没有历史检索。选题如果超出现有信源的话题范围（比如问一个小众软件的具体用法），命中的条数会是 0。真要按任意问题去全网找资料，得等 SearXNG 部署好，`search.provider` 改成 `searxng` 之后，搜索结果的优先级会高于信源。

**关键词抽取失败**（模型挂了）时，退回 2-gram 字符切分，效果糙一些但不会断。

## 篇幅和干货程度怎么调

都在 `config/writing.json`，改完下一次运行就生效：

```json
{
  "main_words": 600,
  "floor_count": [3, 5],
  "floor_words": [40, 120],
  "extra_rules": "如果某个点在网上随便一搜就有，就别写；读者是来找你这句话的，不是来找百科的。"
}
```

| 字段 | 作用 |
|---|---|
| `main_words` | 主楼目标字数，上限是它的 1.2 倍（600 → 最多 720） |
| `floor_count` | 楼层数量区间 |
| `floor_words` | 每层字数区间 |
| `extra_rules` | 追加的写作要求，直接拼进 prompt，写多严都行 |

也可以用仓库 Variable `WORD_COUNT` 临时覆盖主楼字数，优先级高于配置文件。

生成后还有一道校验：字数低于 `main_words × 0.5`（最少 300）直接判定失败，不会把半截东西发出去。

## 关于「干货」

prompt 里有一组硬规则，不是让它"写得干货一点"这种空话：

1. 每一段必须带一个具体信息——事实、数字、做法、或明确判断，做不到就删掉这段
2. 禁止铺垫句、转场句、总结句、空洞形容，并给了具体例子
3. 不许科普常识
4. 同一件事只说一遍
5. 宁可短，不要凑字数

这些规则写在代码里，`config/editorial.md` 负责"写什么不写什么"，`writing.json` 的 `extra_rules` 负责补刀。三个地方分工，别混着写。

## 一级标题

正文不带 `#`。模型被明确要求把标题单独放在 JSON 的 `title` 字段里，脚本再兜底剥掉正文开头的一级标题——双保险，不会出现标题在页面里显示两遍。

你手写 md 时仍然可以写 `# 标题`，`blogsite.py` 解析时会把它提取成页面标题，不当作正文。

## 模型：只用免费

默认纯免费，不用配。每次运行拉 OpenRouter 模型表，筛价格全为 0 的，按写作适配度排序挨个试，`openrouter/free` 兜底。

`FREE_ONLY` 默认 `1`，硬过滤——哪怕配置里填了付费模型也会被剔除。

某个免费模型报 403（比如「only available on agentic harnesses」）会**拉黑 7 天然后换下一个**，不是 Key 问题。真 Key 失效是 401，会立刻停下。

## 定时没跑怎么办

按顺序查：

1. **仓库根目录**是不是直接就是 `.github`、`docs` 这几个目录
2. Actions 左侧有没有 `daily-post` 这个 workflow
3. Settings → Actions → General，确认 Actions 没被禁用
4. 默认分支是 `main` 还是 `master`

另外 GitHub 的 schedule 本身不可靠，延迟一小时很正常，偶尔整天跳过。这就是为什么要设四个时间点。

## 本地测试

```bash
python3 scripts/generate.py --rebuild          # 只重建页面，不需要 key
python3 -m http.server 8000 -d docs            # 打开 http://localhost:8000
```

跑完整流程：

```bash
export OPENROUTER_API_KEY=sk-or-v1-xxx
python3 scripts/generate.py --force
```

**改完 md 别忘了重建**，否则页面不会变。
