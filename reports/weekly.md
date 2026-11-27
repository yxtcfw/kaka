# 站点周报

生成时间：2026-11-26T18:15:39.315Z

## 达标进度
- 判据① 联想词：{"count":326,"sources":2,"newRate":0,"passed":true}
- 判据② 信源：{"l1":0,"independentL2":0,"passed":false}
- 判据③ 内容：{"generated":0,"gateBlocked":0,"passed":false}
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
告警数：0（critical 0 / warn 0 / info 0）
- 无漂移，三者一致

## 规则/数据变更与回滚
快照数：439
- 快照：snapshots/signals/signals.json.2026-11-26T17-02-36-660Z
- 快照：snapshots/signals/signals.json.2026-11-26T17-02-36-662Z
- 快照：snapshots/signals/signals.json.2026-11-26T17-17-23-598Z
- 快照：snapshots/signals/signals.json.2026-11-26T17-17-23-600Z
- 快照：snapshots/signals/signals.json.2026-11-26T17-35-03-565Z
- 快照：snapshots/signals/signals.json.2026-11-26T17-35-03-568Z
- 快照：snapshots/signals/signals.json.2026-11-26T17-44-18-764Z
- 快照：snapshots/signals/signals.json.2026-11-26T17-44-18-765Z
- 快照：snapshots/signals/signals.json.2026-11-26T18-15-30-534Z
- 快照：snapshots/signals/signals.json.2026-11-26T18-15-30-537Z

回滚命令示例（人工决定后执行）：
```bash
node scripts/cli.js rollback --file data/tree.json
node scripts/cli.js rollback --file rules/autopilot.json
```

> 人工只做事后审计：看本报告 + 必要时按上面命令回滚，无需事前审批。
