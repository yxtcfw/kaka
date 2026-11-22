# config/ 说明

本目录下的所有文件都是**运行时从主站配置物化生成的临时工作副本**，不是配置源，请勿手动编辑或提交。

## 事实来源

配置的唯一事实来源是主站仓库 `yxtcfw/yxtcfw.github.io` 的 `config/sites/kaka.json`，
发布到 `docs/config/` 后由本仓库 `.github/workflows/daily.yml` 中的
`python scripts/fetch_config.py` 拉取并物化到本目录。

## 生成的文件

| 文件 | 来源（主站站点配置的字段） |
|---|---|
| `site.json` | `site` |
| `sources.json` | `sources` / `window_hours` / `search` |
| `writing.json` | `ai.writing` |
| `keywords.txt` | `keywords.cores` + `keywords.picked` |
| `persona.md` | `ai.persona` |
| `editorial.md` | `ai.editorial` |
| `prompts/write.md` | `ai.prompts.write` |
| `prompts/terms.md` | `ai.prompts.terms` |
| `prompts/question.md` | `ai.prompts.question` |
| `names.json` / `ads.json` | 主站 `global/names.json`、`global/ads.json` |
| `theme.json` | 主站 `themes/<theme>.json` |
| `generated.json` | 本次拉取的元信息（site_id / 时间 / sha256），会提交回仓库作留痕 |

其中 `ai.persona` / `ai.editorial` / `ai.prompts` 是原仓库里 5 个手写 md 的内容，
现已收进主站 JSON，可在主站工作台「提示词配置 → 高级」里编辑。

## 本地调试

```bash
MAIN_CONFIG_BASE=https://raw.githubusercontent.com/yxtcfw/yxtcfw.github.io/master/docs/config \
  python scripts/fetch_config.py
python scripts/generate.py --probe
```

任何一步配置拉取失败都会直接退出，不会用本目录的旧文件兜底。
