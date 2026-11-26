# 站点周报

生成时间：2026-11-26T15:15:31.094Z

## 达标进度
- 判据① 联想词：{"count":326,"sources":2,"newRate":0,"passed":true}
- 判据② 信源：{"l1":1,"independentL2":1,"passed":true}
- 判据③ 内容：{"generated":6,"gateBlocked":6,"passed":true}
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
快照数：186
- 快照：snapshots/signals/signals.json.2026-11-26T13-39-43-906Z
- 快照：snapshots/signals/signals.json.2026-11-26T13-39-43-945Z
- 快照：snapshots/signals/signals.json.2026-11-26T13-55-23-807Z
- 快照：snapshots/signals/signals.json.2026-11-26T13-55-23-838Z
- 快照：snapshots/signals/signals.json.2026-11-26T14-55-38-445Z
- 快照：snapshots/signals/signals.json.2026-11-26T14-55-38-480Z
- 快照：snapshots/signals/signals.json.2026-11-26T15-09-52-911Z
- 快照：snapshots/signals/signals.json.2026-11-26T15-09-52-935Z
- 快照：snapshots/signals/signals.json.2026-11-26T15-15-28-955Z
- 快照：snapshots/signals/signals.json.2026-11-26T15-15-28-957Z

回滚命令示例（人工决定后执行）：
```bash
node scripts/cli.js rollback --file data/tree.json
node scripts/cli.js rollback --file rules/autopilot.json
```

> 人工只做事后审计：看本报告 + 必要时按上面命令回滚，无需事前审批。
