# 上手：只给三样输入

v7 的最低可运行标准：人工只提供 **种子词 + 云端密钥 + 域名**，其余由脚本/AI 生成。

## 1. 三样输入

1. **种子词**：编辑 `seeds.json`（3-10 个即可）。
2. **域名**：Cloudflare Pages 域名 + DNS 指向。
3. **云端密钥**：GitHub 仓库 Settings → Secrets and variables → Actions 配置：

| Secret | 用途 | 是否必需 |
|---|---|---|
| `OPENROUTER_API_KEYS` | 模型创作（逗号分隔多 key） | 创作需要；无则用 mock |
| `TAVILY_API_KEY` | 搜索发现信源（免费 1000/月） | 信源发现需要；无则降级 mock |
| `GSC_SERVICE_ACCOUNT` | 曝光回流 | 回流需要；无则跳过 |
| `BING_API_KEY` | 曝光回流（须用 JSON 端点） | 回流需要 |
| `CLOUDFLARE_API_TOKEN` | Pages 部署 | 部署必需 |
| `CLOUDFLARE_ACCOUNT_ID` | Pages 部署 | 部署必需 |

> 变量（非 secret）：`PAGES_PROJECT`（Pages 项目名，默认 `vertical-site`）。

**密钥永不写进任何文件**，只走环境变量 / GitHub Secrets；脚本日志只打印是否设置，不打印明文。

## 2. 本地起步

```bash
node scripts/cli.js validate          # 校验数据契约
node scripts/cli.js bootstrap --domain your-domain.com --apply
node scripts/cli.js pipeline          # 采词→建树→信源→创作→构建
```

Termux（F-Droid `nodejs-lts`，Node 22+）同样命令可跑，零运行时依赖，无需 npm install。

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
