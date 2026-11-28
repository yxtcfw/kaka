# 站点周报

生成时间：2026-11-28T03:33:43.091Z

## 达标进度
- 判据① 联想词：{"count":229,"sources":2,"newRate":0.0044,"passed":false}
- 判据② 信源：{"l1":69,"independentL2":0,"passed":true}
- 判据③ 内容：{"generated":3,"gateBlocked":17,"passed":true}
- 首次填空：siteFilled=true

## 本周流程报告
- harvest: 有
- grow-tree: 有
- fetch-body: 有
- write-content: 有
- fill-site: 有
- build-nav-pages: 有
- build: 有

## 漂移告警（树/信源/规则一致性）
告警数：1（critical 1 / warn 0 / info 0）
- [critical] search-source-upgraded · src-026：搜索发现源 grade=L1，应为 L3

## 规则/数据变更与回滚
快照数：952
- 快照：snapshots/signals/signals.json.2026-11-28T03-20-44-611Z
- 快照：snapshots/signals/signals.json.2026-11-28T03-20-51-236Z
- 快照：snapshots/signals/signals.json.2026-11-28T03-31-58-389Z
- 快照：snapshots/signals/signals.json.2026-11-28T03-32-05-621Z
- 快照：snapshots/sources.json.2026-11-27T15-40-23-418Z
- 快照：snapshots/sources.json.2026-11-27T15-41-01-145Z
- 快照：snapshots/sources.json.2026-11-27T15-41-01-703Z
- 快照：snapshots/sources.json.2026-11-27T15-41-27-645Z
- 快照：snapshots/sources.json.2026-11-27T15-41-39-628Z
- 快照：snapshots/sources.json.2026-11-27T15-42-07-417Z

回滚命令示例（人工决定后执行）：
```bash
node scripts/cli.js rollback --file data/tree.json
node scripts/cli.js rollback --file rules/autopilot.json
```

> 人工只做事后审计：看本报告 + 必要时按上面命令回滚，无需事前审批。
