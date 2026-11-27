# 上手：只给三样输入

v7 的最低可运行标准：人工只提供 **种子词 + 云端密钥 + 域名**，其余由脚本/AI 生成。

## 1. 三样输入

1. **种子词**：编辑 `seeds.json`（3-10 个即可）。
2. **域名**：Cloudflare Pages 域名 + DNS 指向。
3. **云端密钥**：默认**零密钥即可运行**（搜索 ddgs + site: 收录估算）。后期补 key 时在 GitHub 仓库 Settings → Secrets and variables → Actions 配置：

| Secret | 用途 | 是否必需 |
|---|---|---|
| `TAVILY_API_KEY` | 搜索发现信源（免费 1000/月） | 切 `providers.search=tavily` 时需要 |
| `EXA_API_KEY` | 搜索发现信源 | 切 `providers.search=exa` 时需要 |
| `OPENROUTER_API_KEYS` | 模型创作（逗号分隔多 key） | 切 `providers.llm=openrouter` 时需要 |
| `GSC_SERVICE_ACCOUNT` | 曝光回流 | 切 `providers.metrics=gsc` 时需要 |
| `BING_API_KEY` | Bing Webmaster Tools API key（非 Bing Search v7 订阅 key）；站点须先在 Bing Webmaster Tools 验证 | 切 `providers.metrics=bing` 时需要 |
| `CLOUDFLARE_API_TOKEN` | Pages 部署 | 部署必需 |
| `CLOUDFLARE_ACCOUNT_ID` | Pages 部署 | 部署必需 |

> 变量（非 secret）：`PAGES_PROJECT`（Pages 项目名，默认 `vertical-site`）。

**默认配置**：`config/manifest.json` 里 `providers.search="ddgs"`、`providers.metrics="bing"`。搜索走 Termux/PC 的 `adapters/ddgs_search.py`（`pip install ddgs`，Node 侧仍零依赖，经 guard 限速）；回流走 Bing Webmaster 真实数据（`estimated=false`），密钥从 `BING_API_KEY` 读取，缺 key/接口失败显式降级，不静默伪造。无 key 时可把 provider 临时改为 `site-estimate`（用 `site:域名` 查收录数，产出**估算值** `estimated=true`，非真实曝光/点击，不参与内容裁剪）。

**后期补 key**：只改 `config/manifest.json` 的 `providers` 目标值 + 配对应 Secret，脚本自动切换，无需改代码。`pipeline.yml` 的 env 已注入全部 7 个候选变量（`OPENROUTER_API_KEYS`/`TAVILY_API_KEY`/`EXA_API_KEY`/`DEEPSEEK_API_KEY`/`DASHSCOPE_API_KEY`/`GSC_SERVICE_ACCOUNT`/`BING_API_KEY`），切到 `exa`/`deepseek`/`dashscope` 时只需配对应 Secret，无需改 workflow。

**Bing 回流实测**：`providers.metrics=bing` 走官方 JSON/REST `https://ssl.bing.com/webmaster/api.svc/json/GetPageStats`（SOAP/POX 已于 2026-08-31 退役），API key 只从 `BING_API_KEY` 读取，报告只留 8 位指纹。也可用手动 dispatch 填 `metricsProvider=bing` 做一次性测试，不必改默认配置；若站点验证 URL 与 `https://${domain}/` 不一致，可同时填 `bingSiteUrl`。接口失败或缺 key 会显式 `degraded`，不写假数据。

**密钥永不写进任何文件**，只走环境变量 / GitHub Secrets；脚本日志只打印是否设置，不打印明文。

## 2. 本地起步

```bash
node scripts/cli.js validate          # 校验数据契约
node scripts/cli.js bootstrap --domain your-domain.com --apply
node scripts/cli.js pipeline          # 采词→建树→信源→创作→构建
```

Termux（F-Droid `nodejs-lts`，Node 22+）同样命令可跑，Node 侧零运行时依赖，无需 npm install。要用默认无 key 搜索需额外装 Python 适配器：

```bash
pkg install python && pip install ddgs
```

不装也能跑：搜索降级 mock（写 `reports/discover-degraded.json`），回流 `degraded=true` 跳过，不静默伪造。

## 3. 云端自动

- `pipeline.yml`：每天 02:00 UTC + 手动触发；达标即推进，无需人工审批。
- `deploy.yml`：由 `workflow_run` 链式触发（GITHUB_TOKEN 提交不触发其他 workflow 的坑已处理）；`build-check` job 独立验证 clone 即可 build。
- 公开仓 60 天无提交会停 cron：周报/规则变更提交保持活动。

## 4. 复制建新站

```bash
cp -r vertical-site-template my-new-site
cd my-new-site
node scripts/cli.js reset --apply      # 清空数据，保留代码/前端/规则
# 只改 seeds.json + 域名 + Secrets → 2 天上线，零改码
```

## 5. 首次填空与冻结（重要）

站点信息（`data/site.json`）**只在首次构建填充一次**，之后冻结：

- 人工预设值 → 保留，不覆盖；
- 空值 → 首次构建按内容树 + 信源补齐；
- 填充后 `state.json` 的 `siteFilled=true`，后续构建跳过；人工清空字段也不会自动重填。

需要重新填空时用 `reset --apply` 复位（会清空所有数据）。

## 6. 事后审计与回滚

无需事前审批。每周看 `reports/weekly.md`，必要时按报告里的命令回滚：

```bash
node scripts/cli.js rollback --file data/tree.json
node scripts/cli.js rollback --file rules/autopilot.json
```
