# 自动化垂直站模板 · v7 最低可运行版

一仓一站一主题。人工只给 **种子词 + 密钥 + 域名**，脚本/AI 自动完成：联想词采集 → 达标建树 → 信源发现/抓取 → 内容创作 → 六道门禁 → 首次填空 → nav 补详情 → 构建 → 部署。**全程免人工审批**，人工只看周报、必要时回滚。

零运行时依赖（纯 Node 22+），clone 即可 build，Termux / 任意托管平台可跑。Hugo 仅可选后端，未安装时用内置渲染器。

## 快速开始

```bash
node scripts/cli.js validate                        # 校验数据契约
node scripts/cli.js bootstrap --domain your.com --apply   # 三样输入 → 站点初稿
node scripts/cli.js pipeline                        # 全链：采词→建树→信源→创作→构建
node scripts/cli.js build                           # 只构建（CI 用，clone 即可 build）
node scripts/cli.js guard-check                     # 防风控自检（假请求，零真实网络）
node scripts/cli.js metrics                         # 回流（site: 无 key 估算）
npm test                                            # 71 单测
```

云端部署、Secrets、复制建新站见 [`docs/setup-cloudflare.md`](docs/setup-cloudflare.md)。

## 架构与流程

```text
seeds.json (人工种子词)
  → harvest.js          采联想词（判据①：≥300 词 / ≥2 源 / 新增率<10%）
  → grow-tree.js        AI 建规则 + 长树（免审批，快照 + 金丝雀 + 幂等）
  → discover-sources.js 搜索发现候选 URL（默认 L3；ddgs 无 key / tavily|exa 用 key，均经 guard）
  → fetch-body.js       抓正文 + 判据 → 信源池（判据②：1×L1 或 2×独立 L2；真抓取经 fetch-guard）
  → fetch-metrics.js    site: 收录数估算（无 key）/ GSC|Bing（后期补 key）
  → write-content.js    创作 blog + 六道门禁（判据③：数字指回 citation，门禁至少拦一次）
  → build-nav-pages.js  预设 nav 有正文才补详情，过同一套六闸；不过闸降级列表直跳
  → fill-site.js        仅首次构建补空站点信息，之后冻结（人工值不覆盖、清空不重填）
  → build.js            纯 Node 静态站 + sitemap（显式枚举）+ JSON-LD + robots
  → drift-check.js      树/信源/规则一致性校验 → alerts/latest.json（纳入周报，不阻断）
```

## 关键约定（务必遵守）

1. **数据边界**：v7 全数据进仓库（`data/`、`state.json`、`rules/`、`snapshots/`、`reports/`）；**唯一例外是密钥**——只走环境变量 / GitHub Secrets，永不落文件。
2. **nav 与信源解耦**：nav 是站点/页面，信源是正文/正文列表。有正文进详情页，无正文列表直跳，不生成空壳页。
3. **出站口由人工控制**：`promoUrl` 只认人工填写，脚本永不覆盖；出站 `rel="sponsored nofollow noopener"`。
4. **搜索候选默认 L3**：搜索只发现 URL，不自动升 L1/L2；正文抓不到或过短即降级/reject，不进创作。
5. **门禁不豁免**：blog 文章与 nav 详情页共用六道门禁（事实/重复/违禁/结构/可引用/合规出站）。
6. **首次填空一次定稿**：`siteFilled=true` 后永久跳过，人工改值不被改回。
7. **免审批的五道安全阀**：快照（`snapshots/`）+ 金丝雀（`grow-tree` canary diff）+ 漂移告警（`drift-check` → `alerts/latest.json`，树/信源/规则一致性）+ 周报回滚命令（`reports/weekly.md`）+ 幂等键；全部已实现，只告警不阻断，供事后审计。
8. **采集防风控**：所有真实 provider 必须经 `scripts/lib/fetch-guard.js` 发请求（mock 链路零网络）。策略在 `rules/collect-policy.json`：UA、robots.txt/crawl-delay、rpm 令牌窗口、请求间隔+抖动、超时、429/5xx 指数退避（尊重 Retry-After）、并发上限、`enabled` 硬开关。`guard-check` 可一键自检；`discover`/`fetch-body` 报告带 `guard` 统计。

## 采集防风控（接真实 provider 前必读）

默认 `providers.search=mock`，不发任何真实请求。切到 `tavily` / `exa` 后，请求统一走 `fetch-guard`，key 只从环境变量读（`TAVILY_API_KEY` / `EXA_API_KEY`），永不落文件。可用参数：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | true | false 硬拒绝所有真实请求 |
| `respectRobots` / `crawlDelayFallbackMs` | true / 1000 | 解析 robots.txt、遵守 crawl-delay |
| `rpm` / `minIntervalMs` / `jitterMs` | 12 / 1000 / 500 | 滑动窗口限速、最小间隔、随机抖动 |
| `maxRetries` / `backoffBaseMs` / `backoffMaxMs` / `retryStatuses` | 2 / 1000 / 10000 / 429,5xx | 指数退避 + Retry-After 优先 |
| `timeoutMs` / `concurrency` | 10000 / 2 | 单请求超时、并发上限 |
| `userAgent` / `userAgentToken` | 模板 UA | 每次请求注入 UA，用于 robots 匹配 |

不使用代理池/IP 轮换（除非有明确合规授权）；不爬搜索引擎结果页。ddgs 为无 key 搜索适配器（外部 Python，Node 侧经 `guard.throttleOnly()` 限速），其余真 provider 走授权 API。

## 无 key 方案（默认）与后期补 key

当前 `config/manifest.json` 默认 `providers.search="ddgs"`、`providers.metrics="site-estimate"`，**零密钥即可跑真实采集**：

```bash
# Termux / PC：ddgs 适配器（仅搜索步骤需要，Node 侧仍零依赖）
pkg install python          # Termux；PC 跳过
pip install ddgs            # 旧包名 duckduckgo-search 也兼容

node scripts/cli.js discover   # ddgs 发现候选（约 30 RPM，guard 默认 12 rpm 更保守）
node scripts/cli.js metrics    # site:<域名> 收录数估算（estimated=true，非曝光/点击真值）
```

- 未装 ddgs / 网络失败时：搜索显式降级 mock 并写 `reports/discover-degraded.json`；回流 `degraded=true` 跳过，**不静默伪造**。
- `site:` 估算只产出 `indexedEstimate`（实际返回条数下限），显式标 `estimated=true`，**不参与内容裁剪决策**。
- 后期补 key：把 `providers.search` 改 `tavily`/`exa`、`providers.metrics` 改 `gsc`/`bing`，并在仓库 Secrets 配对应密钥；脚本自动切换，无需改代码。

## 目录结构

```text
seeds.json            人工种子词（唯一新增的人工业务输入）
state.json            三道判据进度 + siteFilled 标记
config/manifest.json  站点配置初稿（domain/vertical/threshold/provider）
data/                 内容树、nav、信源、站点信息、产物（均进 git）
rules/                可改规则（signals-tree/nav-classify/source-grade/autopilot/collect-policy）
schema/               轻量 JSON Schema（零依赖校验器消费）
scripts/              全部脚本（lib 为核心库）
templates/assets/     站点 CSS（token 由 build 注入）
snapshots/            AI 写盘前的历史版本（可回滚）
reports/              流程报告 + 周报（含回滚命令）
alerts/               漂移告警
docs/                 上手与部署说明
tests/                71 单测（隔离临时 root，不碰真实仓库）
adapters/             ddgs_search.py（无 key 搜索适配器，Termux pip install ddgs 后可用）
```

## 命令一览

`validate` `bootstrap` `harvest` `grow-tree` `discover` `fetch-body` `collect-sources` `write` `fill-site` `nav-pages` `build` `metrics` `prune` `drift-check` `guard-check` `report` `rollback` `reset` `pipeline`

`adapterFn` 是代码级注入点（供测试/外部系统集成）；CLI 走内置 Python 适配器 `adapters/ddgs_search.py`。

统一入口：`node scripts/cli.js <command> [--root DIR] [--dry-run] [options]`。全部脚本默认可从任意 `--root` 派生路径，便于 Termux/测试隔离。
