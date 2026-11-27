// B2 存量数据修正：只应用确定性修正（划线价倒挂、销量超阈值），不动任何业务数值。
// 口径矛盾/非主题 SKU 只列 needsHuman 清单，绝不猜数字、绝不删除条目。
// 写前快照 + 原子写 + 幂等；--dry-run 零写盘。通用逻辑，换主题只改规则文件。
import path from 'node:path';
import { readJson, ROOT } from './lib/validate.js';
import { atomicWriteJson, snapshot } from './lib/util.js';
import { loadDataQualityRules, applySafeFixes, checkAll } from './lib/data-quality.js';

const NAV_REL = 'data/navlinks.json';

export function runQualityFix(root = ROOT, args = {}) {
  const navPath = path.join(root, NAV_REL);
  const rules = loadDataQualityRules(root);
  const current = readJson(navPath);
  const items = current.items || [];
  const fixed = [];
  const nextItems = items.map((it) => {
    const r = applySafeFixes(it, rules);
    if (r.fixes.length) fixed.push({ navId: it.navId || '', title: it.title || '', fixes: r.fixes });
    return r.item;
  });
  const before = checkAll(items, rules);
  const afterCheck = checkAll(nextItems, rules);
  const changed = JSON.stringify(items) !== JSON.stringify(nextItems);
  const report = {
    stage: 'data-quality-fix',
    checked: items.length,
    modifiedItems: fixed.length,
    fixCount: fixed.reduce((n, x) => n + x.fixes.length, 0),
    changed,
    needsHuman: afterCheck.rows.filter((r) => r.unresolved.length).map((r) => ({
      navId: r.id, title: r.title, reasons: r.unresolved
    })),
    remainingViolations: afterCheck.rows.filter((r) => r.violations.length).map((r) => ({
      navId: r.id, title: r.title, codes: r.violations.map((v) => v.code)
    })),
    beforeFixable: before.fixable,
    afterFixable: afterCheck.fixable,
    modified: fixed,
    dryRun: !!args.dryRun
  };

  if (!args.dryRun && changed) {
    const stamp = new Date().toISOString();
    const dest = snapshot(navPath, path.join(root, 'snapshots'), stamp);
    atomicWriteJson(navPath, { ...current, items: nextItems });
    report.snapshot = path.relative(root, dest);
  }
  const reportPath = path.join(root, 'reports/data-quality-fix.json');
  if (!args.dryRun) atomicWriteJson(reportPath, report);
  return report;
}
