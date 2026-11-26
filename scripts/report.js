// 周报：汇总本周流程 + 规则变更 + 影响节点 + 回滚命令（人工从「事前审批」转为「事后审计」）。
import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from './lib/validate.js';
import { listSnapshots } from './lib/snapshot.js';

function readSafe(file, fb) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; } }

export function runReport(root = ROOT, args = {}) {
  const state = readSafe(path.join(root, 'state.json'), {});
  const snaps = listSnapshots(root);
  const reports = ['harvest', 'grow-tree', 'fetch-body', 'write-content', 'fill-site', 'build-nav-pages', 'build']
    .map((n) => ({ name: n, data: readSafe(path.join(root, 'reports', `${n}.json`), null) }));

  const lines = [];
  lines.push('# 站点周报');
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push('');
  lines.push('## 达标进度');
  lines.push(`- 判据① 联想词：${JSON.stringify(state.signals || {})}`);
  lines.push(`- 判据② 信源：${JSON.stringify(state.sources || {})}`);
  lines.push(`- 判据③ 内容：${JSON.stringify(state.content || {})}`);
  lines.push(`- 首次填空：siteFilled=${state.siteFilled}`);
  lines.push('');
  lines.push('## 本周流程报告');
  for (const r of reports) lines.push(`- ${r.name}: ${r.data ? '有' : '无'}`);
  lines.push('');
  lines.push('## 规则/数据变更与回滚');
  lines.push(`快照数：${snaps.length}`);
  for (const s of snaps.slice(-10)) lines.push(`- 快照：${s}`);
  lines.push('');
  lines.push('回滚命令示例（人工决定后执行）：');
  lines.push('```bash');
  lines.push('node scripts/cli.js rollback --file data/tree.json');
  lines.push('node scripts/cli.js rollback --file rules/autopilot.json');
  lines.push('```');
  lines.push('');
  lines.push('> 人工只做事后审计：看本报告 + 必要时按上面命令回滚，无需事前审批。');

  const md = lines.join('\n') + '\n';
  if (!args.dryRun) {
    fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(root, 'reports', 'weekly.md'), md, 'utf8');
  }
  return { stage: 'report', snapshots: snaps.length, length: md.length, markdown: md };
}
