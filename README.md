# 自动化垂直站模板 · v7 最低可运行版

一仓一站一主题。人工只给 **种子词 + 密钥 + 域名**，脚本/AI 自动完成：联想词采集 → 达标建树 → 信源发现/抓取 → 内容创作 → 六道门禁 → 首次填空 → nav 补详情 → 构建 → 部署。**全程免人工审批**，人工只看周报、必要时回滚。

零运行时依赖（纯 Node 22+），clone 即可 build，Termux / 任意托管平台可跑。Hugo 仅可选后端，未安装时用内置渲染器。

## 快速开始

```bash
node scripts/cli.js validate                        # 校验数据契约
node scripts/cli.js bootstrap --domain your.com --apply   # 三样输入 → 站点初稿
node scripts/cli.js pipeline                        # 全链：采词→建树→信源→创作→构建
node scripts/cli.js build                           # 只构建（CI 用，clone 即可 build）
npm test                                            # 39 单测
```

云端部署、Secrets、复制建新站见 [`docs/setup-cloudflare.md`](docs/setup-cloudflare.md)。

## 架构与流程

```text
seeds.json (人工种子词)
  → harvest.js          采联想词（判据①：≥300 词 / ≥2 源 / 新增率<10%）
  → grow-tree.js        AI 建规则 + 长树（免审批，快照 + 金丝雀 + 幂等）
  → discover-sources.js 搜索发现候选 URL（默认 L3，只用授权 API）
  → fetch-body.js       抓正文 + 判据 → 信源池（判据②：1×L1 或 2×独立 L2）
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

## 目录结构

```text
seeds.json            人工种子词（唯一新增的人工业务输入）
state.json            三道判据进度 + siteFilled 标记
config/manifest.json  站点配置初稿（domain/vertical/threshold/provider）
data/                 内容树、nav、信源、站点信息、产物（均进 git）
rules/                四类可改规则（signals-tree/nav-classify/source-grade/autopilot）
schema/               轻量 JSON Schema（零依赖校验器消费）
scripts/              全部脚本（lib 为核心库）
templates/assets/     站点 CSS（token 由 build 注入）
snapshots/            AI 写盘前的历史版本（可回滚）
reports/              流程报告 + 周报（含回滚命令）
alerts/               漂移告警
docs/                 上手与部署说明
tests/                39 单测（隔离临时 root，不碰真实仓库）
```

## 命令一览

`validate` `bootstrap` `harvest` `grow-tree` `discover` `fetch-body` `collect-sources` `write` `fill-site` `nav-pages` `build` `metrics` `prune` `drift-check` `report` `rollback` `reset` `pipeline`

统一入口：`node scripts/cli.js <command> [--root DIR] [--dry-run] [options]`。全部脚本默认可从任意 `--root` 派生路径，便于 Termux/测试隔离。
