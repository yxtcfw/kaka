# 站点周报

生成时间：2026-11-27T08:35:30.543Z

## 达标进度
- 判据① 联想词：{"count":330,"sources":2,"newRate":0.003,"passed":true}
- 判据② 信源：{"l1":63,"independentL2":0,"passed":true}
- 判据③ 内容：{"generated":5,"gateBlocked":9,"passed":true}
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
快照数：697
- 快照：snapshots/signals/signals.json.2026-11-27T06-41-06-162Z
- 快照：snapshots/signals/signals.json.2026-11-27T06-54-08-367Z
- 快照：snapshots/signals/signals.json.2026-11-27T06-54-13-476Z
- 快照：snapshots/signals/signals.json.2026-11-27T07-02-15-447Z
- 快照：snapshots/signals/signals.json.2026-11-27T07-06-47-489Z
- 快照：snapshots/signals/signals.json.2026-11-27T07-06-52-594Z
- 快照：snapshots/signals/signals.json.2026-11-27T07-08-45-769Z
- 快照：snapshots/signals/signals.json.2026-11-27T07-08-50-141Z
- 快照：snapshots/signals/signals.json.2026-11-27T08-30-13-941Z
- 快照：snapshots/signals/signals.json.2026-11-27T08-30-25-162Z

回滚命令示例（人工决定后执行）：
```bash
node scripts/cli.js rollback --file data/tree.json
node scripts/cli.js rollback --file rules/autopilot.json
```

> 人工只做事后审计：看本报告 + 必要时按上面命令回滚，无需事前审批。
