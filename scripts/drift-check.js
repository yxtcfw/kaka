// 漂移告警入口：detectDrift → 写 alerts/latest.json（含 critical 计数），不阻断流程。
import path from 'node:path';
import { ROOT } from './lib/validate.js';
import { writeJson } from './lib/validate.js';
import { detectDrift } from './lib/drift.js';

export function runDriftCheck(root = ROOT, args = {}) {
  const doc = detectDrift(root);
  if (!args.dryRun) {
    writeJson(path.join(root, 'alerts', 'latest.json'), doc);
  }
  const bySeverity = doc.alerts.reduce((acc, a) => { acc[a.severity] = (acc[a.severity] || 0) + 1; return acc; }, {});
  return {
    stage: 'drift-check', checks: doc.checks, alertCount: doc.alertCount,
    bySeverity, critical: doc.alerts.filter((a) => a.severity === 'critical').map((a) => `${a.kind}:${a.subject}`),
    blocking: false
  };
}
