# 站点周报

生成时间：2026-11-27T15:57:45.577Z

## 达标进度
- 判据① 联想词：{"count":227,"sources":2,"newRate":0.0044,"passed":false}
- 判据② 信源：{"l1":69,"independentL2":0,"passed":true}
- 判据③ 内容：{"generated":4,"gateBlocked":13,"passed":true}
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
快照数：856
- 快照：snapshots/signals/signals.json.2026-11-27T11-24-33-839Z
- 快照：snapshots/signals/signals.json.2026-11-27T11-24-40-392Z
- 快照：snapshots/signals/signals.json.2026-11-27T15-55-12-096Z
- 快照：snapshots/signals/signals.json.2026-11-27T15-55-18-301Z
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
