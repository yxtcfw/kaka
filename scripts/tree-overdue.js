// 定时兜底：周任务漏跑/失败时，由每日 pipeline 检测超期并补跑一次建树。
// 只认 state.runs 中 stage='grow-tree' 的成功记录；skipped 不记录，故阈值不足时每天只出告警、不调模型。
// 硬边界：同日只触发一次；仍走 grow-tree 同一套阈值门槛；写盘前不碰 data/tree.json（由 grow-tree 快照）。
import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from './lib/validate.js';
import { loadState } from './lib/state.js';
import { atomicWriteJson } from './lib/util.js';
import { runGrowTree } from './grow-tree.js';

function safeJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export async function runTreeOverdue(root = ROOT, args = {}) {
  const cadence = safeJson(path.join(root, 'rules/tree-cadence.json'), { overdueDays: 10 });
  const overdueDays = Number(cadence.overdueDays ?? 10);
  const now = args.now ? new Date(args.now) : new Date();
  const today = now.toISOString().slice(0, 10);
  const state = safeJson(path.join(root, 'state.json'), { runs: [] });
  const runs = state.runs || [];
  const growRuns = runs
    .filter((r) => r && r.stage === 'grow-tree' && Number.isFinite(Date.parse(r.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const lastAt = growRuns[0]?.at || null;
  const ageDays = lastAt ? Math.max(0, (now.getTime() - Date.parse(lastAt)) / 86400000) : Infinity;
  const overdue = !lastAt || ageDays > overdueDays;
  const duplicate = runs.some((r) => r && r.stage === 'grow-tree' && String(r.at || '').slice(0, 10) === today);

  let action = 'none';
  let grow = null;
  if (overdue && !duplicate) {
    grow = await runGrowTree(root, { ...args, dryRun: !!args.dryRun });
    action = grow.skipped ? 'skipped-threshold' : 'triggered';
  } else if (overdue && duplicate) {
    action = 'skipped-duplicate';
  }

  const degraded = !!(grow && grow.degraded);
  const previous = safeJson(path.join(root, 'reports/tree-overdue.json'), {});
  const consecutiveCritical = degraded && previous.alert === 'critical';
  const alert = degraded ? 'critical' : null;
  const report = {
    stage: 'tree-overdue',
    checkedAt: now.toISOString(),
    lastGrowAt: lastAt,
    overdueDays,
    ageDays: Number.isFinite(ageDays) ? Number(ageDays.toFixed(2)) : null,
    action,
    alert,
    grow: grow ? {
      skipped: !!grow.skipped, reason: grow.reason || '', degraded,
      nodesAdded: grow.nodesAdded || 0, keywordsAdded: grow.keywordsAdded || 0
    } : null,
    manualStep: consecutiveCritical ? '连续两次模型降级：手动 dispatch tree-weekly 并勾选 force；若日 cron 也停摆需先 push 唤醒' : null,
    dryRun: !!args.dryRun
  };
  if (!args.dryRun) atomicWriteJson(path.join(root, 'reports/tree-overdue.json'), report);
  return report;
}
