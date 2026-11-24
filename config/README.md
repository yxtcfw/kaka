# config/ 说明

v3 起本目录就是**本站配置的唯一事实来源**，全部文件都随站点仓库提交、由本站前端或本地服务修改后推送；主站不再下发配置，本仓库也不再拉取主站配置。

## 配置源

| 文件 | 用途 |
|---|---|
| `site.json` | 基础信息、`composition` 模块组合、`template`、`ai`、`shared`、`gateway` |
| `keywords.json` | 关键词，`picked` 为冻结选题锚 |
| `sources.json` | 信源清单与分级字段 |
| `tree.json` | 内容树（选题层级 / 三重闸 / 剪枝） |
| `names.json` | 本站启用的虚拟人 |
| `ads.json` | 本站广告 |
| `modules/*.json` | 模块契约（blog / nav / resource / comments） |
| `persona.md` / `editorial.md` / `prompts/*.md` | 本站写作提示词 |

## 本地生成物

`python scripts/build_runtime.py` 只读取上述本地文件，校验后生成：

- `generated.json`：运行时配置（模块组合、合并内容契约、请求策略、配置指纹）
- `writing.json`：从 `site.json.ai.writing` 物化，兼容现有 `generate.py`
- `keywords.txt`：从 `keywords.json` 物化，兼容旧读取路径

构建失败直接退出，不使用旧配置兜底。日常无需手动改这三个生成物。

## 本地调试

```bash
python scripts/build_runtime.py
python scripts/generate.py --probe
python scripts/generate.py --rebuild
```

站点 Workflow 中 `daily.yml` 与 `build.yml` 都会先跑 `build_runtime.py`，再写作或重建。
