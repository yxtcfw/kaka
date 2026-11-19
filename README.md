# daily-blog · 热点驱动的自动博客

一个仓库跑完整闭环：**定时触发 → 抓源采集 → 关键词打分排序 → 模型分析选题 → 带着素材写作 → 生成整站 → 提交回 Pages**。

零第三方依赖，`docs/` 就是站点，不需要 Node、不需要 Hexo、不需要 gh-pages 分支。

## 它每天在干什么

```
每天 07:00 (BJT)
  ├─ 采集  config/sources.json 里所有 enabled 的源（RSS / Atom / JSON / 列表页）
  ├─ 过滤  时间窗（默认 48h）+ 标题去重 + URL 去重
  ├─ 打分  关键词命中×3 + 时效（6h 内 +3 / 24h +2）+ 源权重
  ├─ 选题  模型看前 24 条候选，挑 1-3 条素材，定角度、给理由（不值得写就返回空）
  ├─ 写作  模型带着素材摘要写 1600 字，事实只用素材里的
  ├─ 建站  生成全部页面（见下）
  └─ 提交  git push 回 main，Pages 自动重建
```

采集全挂、候选少于 3 条时自动降级成纯关键词写作，不会断更。

## 站点有哪些页面

| 路径 | 内容 |
|---|---|
| `index.html` | 首页，每页 12 篇，自动分页到 `page/2/`、`page/3/`… |
| `posts/{slug}.html` | 文章页：标签、选题来源、正文、参考资料、更新一篇/更早一篇 |
| `archive.html` | 按年月归档，带篇数 |
| `tags/index.html` | 标签云，按文章数排序 |
| `tags/{标签}.html` | 单个标签下的所有文章 |
| `search.html` | 站内搜索，纯前端，数据内嵌，不依赖后端 |
| `feed.xml` | RSS 2.0，最近 20 篇 |
| `sitemap.xml` | 给搜索引擎的站点地图 |

页面之间的链接全是相对路径，所以部署在 `https://user.github.io/任意仓库名/` 这种子路径下也不会坏。

## 访问地址

站点根就是首页，**不用加 `/index.html`**：

```
https://<用户名>.github.io/<仓库名>/          ← 打开就是首页
https://<用户名>.github.io/<仓库名>/page/2/   ← 第二页
https://<用户名>.github.io/<仓库名>/tags/     ← 标签总览
https://<用户名>.github.io/<仓库名>/posts/2026-11-19-xxx.html
```

仓库名叫 `<用户名>.github.io` 的话，地址就是 `https://<用户名>.github.io/`。

两个容易搞错的地方：

- **别访问 `/仓库名/docs/`**。Pages 选了 `/docs` 目录发布，发布出去的是 docs **里面的内容**作为站点根，所以 `/repo/docs/index.html` 是 404，`/repo/` 才是首页。
- **根路径 404 先看构建状态**。Settings → Pages 页面顶部如果写着 "Your site is live at ..." 就说明构建成功；没写的话多半是分支/目录选错了，或者还没构建完（推完等 1~2 分钟）。

站内导航也都指向目录而不是文件：点「首页」地址栏是 `/repo/`，不会变成 `/repo/index.html`，第 2 页是 `/repo/page/2/`。

## 文件

```
.github/workflows/daily.yml   定时任务（auto / probe / rebuild 三种模式）
scripts/sources.py            采集层：RSS / Atom / JSON / HTML 列表页
scripts/blogsite.py           渲染层：所有页面的模板与生成逻辑
scripts/generate.py           编排层：排序、选题、写作、落盘
config/sources.json           ← 采集源，主要改这里
config/keywords.txt           ← 关键词池，用来给热点打分
config/editorial.md           ← 编辑偏好：写什么、不写什么
config/persona.md             ← 你的文风
config/site.json              站名、副标题、base_url（可留空自动推）
docs/style.css                样式
docs/.topics.json             文章索引 + 选题角度，喂回模型防重复
```

## 上线五步

1. **建仓库**，把本目录所有文件传上去（`.github` 和 `.nojekyll` 是隐藏文件，别漏）。
2. **拿 Key**：openrouter.ai → Keys → Create Key。
3. **加 Secret**：Settings → Secrets and variables → Actions → New secret，名字 `OPENROUTER_API_KEY`。
4. **开 Pages**：Settings → Pages → Source 选 `Deploy from a branch` → `main` + `/docs` → Save。
5. **先自检再跑**：Actions → `daily-post` → Run workflow → mode 选 **probe**，看每个源抓到几条；
   都通了再 Run 一次 mode=auto。

## 三种手动模式

- **auto** — 正常流程：采集 → 选题 → 写作 → 建站（定时任务跑的就是这个）
- **probe** — 只跑采集，打印每个源抓几条、最新两条标题。加源、换源之后先跑这个
- **rebuild** — 不调模型，只按现有 `docs/posts/*.md` 重建全站。改了 CSS 或模板之后用它

## 本地怎么测

需要 Python 3.8+，不用装任何包。在仓库根目录操作。

**一、只看页面（不需要 key）**

```bash
python3 scripts/generate.py --rebuild
python3 -m http.server 8000 -d docs
```

浏览器打开 `http://localhost:8000`。想改端口就换掉 `8000`。

`-d` 参数要 Python 3.7+，老版本就 `cd docs && python3 -m http.server 8000`。

别双击 `index.html` 用 `file://` 打开——中文标签页（`tags/自动化.html`）的链接在 `file://` 下点不开，浏览器不会把 `%E8%87%AA...` 解码回文件名，起个服务就没这问题。

**二、测采集源（不需要 key）**

```bash
python3 scripts/generate.py --probe
```

只跑采集，打印每个源抓到几条、最新两条标题。加源换源之后先跑这个。

**三、跑完整流程（要 key）**

```bash
export OPENROUTER_API_KEY=sk-or-v1-xxxx      # Windows cmd: set ...／PowerShell: $env:...="..."
python3 scripts/generate.py -k 小程序测评 --force
```

`-k` 直接指定主题，跳过选题分析，只花一次调用；`--force` 是今天已经发过也照写——本地反复试不加它，第二次就会被「今天已经发过了」拦下来。

本地跑会真的往 `docs/` 和 `docs/.topics.json` 写东西。试完想丢掉：

```bash
git checkout -- docs && git clean -fd docs
```

**不想污染仓库**，就在副本里折腾：`cp -r daily-blog /tmp/try && cd /tmp/try`。

**四、不要用 act 跑整个 workflow**。它要拉 Docker 镜像、模拟整套 runner 环境，为了验证几行 shell 不值得。workflow 里的命令就是上面这些，本地跑通了，线上跑通是水到渠成的事。

## 加一个采集源

在 `config/sources.json` 的 `sources` 数组里加一条：

```jsonc
// 1) RSS / Atom —— 最稳，优先用
{ "name": "某站", "type": "rss", "url": "https://xxx.com/feed", "weight": 1.0, "enabled": true }

// 2) JSON 接口 —— 填字段映射，支持 "a.b" 点路径
{
  "name": "某站热榜", "type": "json",
  "url": "https://xxx.com/api/list",
  "items_path": "data.list",
  "fields": { "title": "title", "url": "link", "summary": "excerpt", "date": "created_at" },
  "url_template": "https://xxx.com/p/{id}", "id_field": "id",
  "weight": 1.2, "enabled": true
}

// 3) 列表页 HTML —— 抽 <a> 文本当标题，结构一变就废，慎用
{
  "name": "某站栏目", "type": "html",
  "url": "https://xxx.com/news", "base": "https://xxx.com",
  "must_include": "/news/", "limit": 30, "weight": 1.0, "enabled": true
}
```

`weight` 是采信度：权威信源 1.3~1.6，泛资讯 0.7~0.9。

**已经踩过的坑**：36 氪的 `/feed` 给爬虫返回反爬 HTML（配置里已禁用）；知乎热榜要 Referer 且海外 IP 常 403（先关着）；HN 用 `hnrss.org` 而不是官方 rss。

## 模型：只用免费

**默认就是纯免费，什么都不用配。** 每次运行先拉 OpenRouter 的模型表，筛出价格全为 0 的（当前 15 个，自动排除图像和音乐模型），按写作适配度排序，挨个试，前一个限流/下线/报错就换下一个，最后用 `openrouter/free`（OpenRouter 自己的免费路由）兜底。

想改配置，三个地方，优先级从高到低：

1. **手动运行时**：Run workflow → `model` 输入框，留空即免费轮换
2. **仓库 Variable**：`OPENROUTER_MODEL`
3. **改默认值**：`.github/workflows/daily.yml` 里 `|| 'free'` 那一行

`OPENROUTER_MODEL` 的写法：

| 写法 | 含义 |
|---|---|
| 留空 / `free` | 当前所有免费模型，自动轮换 |
| `google/gemma-4-31b-it:free,openrouter/free` | 自己写死一条链 |

**有一条硬保证**：`FREE_ONLY` 默认是 `1`，开关打开时会拿最终列表去模型表里核对，凡是价格不为 0 的全部剔除。哪怕你手滑在 Variable 里填了付费模型，也会被过滤掉，然后回落到内置的免费列表——不会偷偷花钱。拉模型表失败（断网）也一样，用内置的 7 个免费模型。

**全部免费模型都挂了怎么办**：当天不发文，workflow 标红报错，你邮箱会收到通知。不会降级去用付费模型，也不会写出半成品。

**它记得上次谁成功了**：跑通的模型名写进 `docs/.model_used`，下次排到第一位，少浪费几次失败请求。

真要用回付费模型（比如觉得免费文笔太飘）：

```yaml
FREE_ONLY: '0'
OPENROUTER_MODEL: google/gemini-3.5-flash-lite
```

两个都设，缺一不可——只设后者不关 `FREE_ONLY` 的话，还是会被过滤成免费。

本地验证当前会用到哪些模型：

```bash
python3 -c "import sys;sys.path.insert(0,'scripts');import generate as g;print(g.resolve_models(''))"
```

**某个免费模型报 403 怎么办**：这次踩到的就是——`thinkingmachines/inkling-2-small:free` 返回「only available on agentic harnesses」，意思是它只允许在编码代理这类环境里调，普通 API 请求被拒。这类限制在模型表里没有任何标记，只有调用时才知道。

脚本的处理：403/404 判定为「这个模型对我不可用」，写进 `docs/.model_badlist.json` 冷却 7 天，然后立刻换下一个模型继续写。**不是 Key 问题，不用改配置**。冷却期过了会自动重试一次。

真正的 Key 失效是 401，会立刻停下并明确报出来，不会白试十几个模型。

**文章署名**：每篇文章的作者就是实际写出它的那个模型。标题下面显示「作者 Gemma 4 31B (free)」，`<head>` 里也写了 `<meta name="author">`，md 的 front matter 里带着 `author` 字段，文章元数据存在 `.topics.json` 的 `model_name`。

名字取自 OpenRouter 模型表的展示名，去掉厂商前缀（`Google: Gemma 4 31B (free)` → `Gemma 4 31B (free)`）。历史文章没存这个字段的，构建时会按 id 自动美化（`google/gemma-4-31b-it:free` → `Gemma 4 31B（免费）`）。想手动改，编辑 `docs/.topics.json` 里那篇的 `model_name`，再跑一次 rebuild。

**免费模型的现实**：速度慢、经常 429、有的不支持 JSON 输出（脚本会自动去掉 `response_format` 重试）、上下文短的写不完 1600 字、文风也飘。它们的价值在于把每天的自动发布跑起来，而不是产出能直接发的稿子。

## 其他调优

**改篇幅**：Variable `WORD_COUNT`，默认 1600。

**改时间**：cron 是 UTC，北京时间 = UTC+8，`0 23 * * *` 就是早 7 点。

**改每页文章数**：`scripts/blogsite.py` 顶部的 `PER_PAGE`。

**换配色/字体**：只改 `docs/style.css`，然后手动跑一次 **rebuild** 模式。不用重新写作。

**选题跑偏**：多半是关键词太少或太泛。关键词是打分依据，精一点比多更好用。

## 会绊到人的地方

**定时不准点**：GitHub schedule 高峰会延迟十几分钟到一小时，正常。

**push 被拒**：main 开了分支保护的话 bot 推不上去。要么给 `github-actions[bot]` 放行，要么把 Pages 换成 Actions 部署（yml 底部有现成代码）。

**RSS 里的链接不对**：`base_url` 留空时会按 `https://<owner>.github.io/<repo>` 自动推，绑了自定义域名就加个 Variable `SITE_BASE_URL`。

**中文标签的文件名**：`tags/自动化.html` 这种，链接里是 URL 编码后的 `%E8%87%AA...`，GitHub Pages 能正常解析，不用改成拼音。

**它还是初稿机器**。素材真实、链接可查，但观点是模型给的，发公众号前自己过一遍。`docs/posts/` 里的 `.md` 就是给你拿去排版的。
