# daily-blog · 论坛式每日连载

一个仓库跑完整闭环：**挖题 → 取材 → 写作 → 建站 → 推送通知**。

站点是一个长帖，按页连载。每页由「1 楼主贴 + 若干楼层」组成，读起来像在翻一个不断更新的论坛帖，而不是一堆博客文章。

零依赖，`docs/` 就是站点。

## 每天怎么跑

```
每天 07:00 / 11:00 / 15:00 / 19:00 各触发一次（UTC 23,3,7,11）
  ├─ 挖题  扫 docs/posts/*.md，捞带「怎么/为什么/能不能/？」的句子，随机挑一条
  ├─ 取材  按信源抓最近 48h 内容，排序后取前 8 条当素材
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

每一页都是固定的四段式，写进 prompt 里当硬要求：

1. **1 楼主楼** — 直接回应上一页结尾抛出的问题，第一句就上正题，但**不把话说尽**
2. **2 楼** — 一个网友提出具体痛点问题，带场景。反例是「那到底该怎么做呢？」这种空问
3. **3~N 楼** — 围绕这个问题来回拉扯：有人给做法、有人反驳、有人追问、楼主补刀。答案在楼层之间一点点拼出来
4. **最后一层** — 必须提出一个新问题，引出下一页

所以读起来不是「一篇文章」，而是「一群人在把一件事聊清楚」。答案被拆散在几层里，每层只带一点干货，这也是为什么每层字数限制在 40~120 字。

**问题怎么传到下一页**：最后一层的问题会写进 md 的 front matter：

```yaml
next_question: 自建同步要不要专门买个小主机？
```

下一次生成时优先读它，`prompt` 里就是「上一页结尾，有人抛出了这个问题：……」。这样就形成了真正的连载，而不是每天随机找个话题。

三层兜底保证这个链条不会断：

1. 模型按格式输出 `next_question` 字段
2. 没给就从最后一层正文里抠一个带问号的句子
3. 还没有就单独补一次小请求，只要一个问题

三层都没拿到，日志会提示，下一页退回从旧帖里随机挖。

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
