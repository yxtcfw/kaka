// 导航口径修正：只消费 rules/nav-repair.json 的人工定稿，快照 + 原子写，支持 dry-run。
// 脚本不认识流量卡字段；换主题只需替换规则文件。
import path from 'node:path';
import fs from 'node:fs';
import { readJson, ROOT } from './lib/validate.js';
import { atomicWriteJson, snapshot } from './lib/util.js';

const RULE_REL = 'rules/nav-repair.json';
const NAV_REL = 'data/navlinks.json';
const DETAIL_REL = 'data/nav-details.json';
const REPORT_REL = 'reports/nav-repair.json';

export function planNavRepair(rules, navDoc, detailDoc) {
  const byId = new Map((rules.actions || []).map((a) => [a.navId, a]));
  const nav = JSON.parse(JSON.stringify(navDoc));
  const detail = JSON.parse(JSON.stringify(detailDoc));
  const detailById = new Map((detail.pages || []).map((p) => [p.navId, p]));
  const actions = [];
  const unknown = [];

  for (const a of rules.actions || []) {
    if (!a.navId || !byId.has(a.navId)) continue;
    const item = (nav.items || []).find((x) => x.navId === a.navId);
    if (!item) { unknown.push(a.navId); continue; }
    const before = {};

    if (a.remove) {
      nav.items = nav.items.filter((x) => x.navId !== a.navId);
      detail.pages = (detail.pages || []).filter((p) => p.navId !== a.navId);
      actions.push({ navId: a.navId, action: 'remove', reason: a.reason || '' });
      continue;
    }

    for (const key of ['title', 'cardDesc']) {
      if (a[key] !== undefined && item[key] !== a[key]) {
        before[key] = item[key];
        item[key] = a[key];
      }
    }
    if (a.setSpecs && Object.keys(a.setSpecs).length) {
      const old = (item.specs && typeof item.specs === 'object') ? item.specs : {};
      const base = a.replaceSpecs ? {} : { ...old };
      for (const [k, v] of Object.entries(a.setSpecs)) {
        if (old[k] !== v) before[`specs.${k}`] = old[k];
        base[k] = v;
      }
      if (JSON.stringify(base) !== JSON.stringify(item.specs)) item.specs = base;
    }
    const page = detailById.get(a.navId);
    if (page && a.title && page.title !== a.title) {
      before.detailTitle = page.title;
      page.title = a.title;
    }
    if (page && a.detailIntro && Array.isArray(page.intro)) {
      const seg = page.intro.find((s) => s && s.title === '套餐包含什么') || page.intro[0];
      if (seg && seg.text !== a.detailIntro) {
        before.detailIntro = seg.text;
        seg.text = a.detailIntro;
      }
    }
    actions.push({ navId: a.navId, action: Object.keys(before).length ? 'patch' : 'noop', reason: a.reason || '', before });
  }
  return { actions, unknown, nav, detail };
}

export function runNavRepair(root = ROOT, args = {}) {
  const rulePath = path.join(root, RULE_REL);
  if (!fs.existsSync(rulePath)) return { stage: 'nav-repair', skipped: true, reason: 'rules-missing' };
  const rules = readJson(rulePath);
  if (rules.enabled === false) return { stage: 'nav-repair', skipped: true, reason: 'disabled' };

  const navPath = path.join(root, NAV_REL);
  const detailPath = path.join(root, DETAIL_REL);
  const { actions, unknown, nav, detail } = planNavRepair(rules, readJson(navPath), readJson(detailPath));
  const patched = actions.filter((a) => a.action === 'patch').length;
  const removed = actions.filter((a) => a.action === 'remove').length;
  const report = {
    stage: 'nav-repair', dryRun: !!args.dryRun,
    actions, unknown, patched, removed,
    totals: { navItems: nav.items.length, detailPages: detail.pages.length }
  };

  if (!args.dryRun && (patched || removed)) {
    report.snapshots = [
      snapshot(navPath, path.join(root, 'snapshots'), args.stamp),
      snapshot(detailPath, path.join(root, 'snapshots'), args.stamp)
    ];
    atomicWriteJson(navPath, nav);
    atomicWriteJson(detailPath, detail);
    atomicWriteJson(path.join(root, REPORT_REL), report);
  }
  return report;
}
