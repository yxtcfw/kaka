// 一次性清理：删除仓库内遗留的示例/占位域名数据（批次 2 · 示例文件根治）。
// 纪律：严格白名单——只删命中文物规则 bannedDomains 的条目，人工/API 数据一律不动；写盘前快照。
// 用法：node scripts/clean-example-data.js --apply   （不带 --apply 为 dry-run）
import path from 'node:path';
import fs from 'node:fs';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { loadExclusions, isBannedDomain } from './lib/exclusions.js';
import { atomicWriteJson, snapshot } from './lib/util.js';

function snapshotFile(root, rel, stamp) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) return;
  // 受限 shim 下 copyFileSync 会 EPERM；沿用仓库既有 snapshot()（read+write 实现）。
  snapshot(src, path.join(root, 'snapshots', `before-example-cleanup-${stamp}`), new Date().toISOString());
}

export function runCleanExampleData(root = ROOT, args = {}) {
  const { bannedDomains } = loadExclusions(root);
  if (bannedDomains.size === 0) return { stage: 'clean-example-data', error: '排除规则为空，拒绝执行（避免误删）' };
  const stamp = String(Date.now());
  const plan = {};

  // 1. sources：只删示例域信源
  const sourcesDoc = readJson(path.join(root, 'data/sources.json'));
  const beforeSources = sourcesDoc.sources;
  const keptSources = beforeSources.filter((s) => !isBannedDomain(s.domain || s.url, bannedDomains));
  plan['data/sources.json'] = { before: beforeSources.length, after: keptSources.length, removed: beforeSources.length - keptSources.length };

  // 2. navlinks：只删出站命中示例域的条目（人工 promoUrl 优先判定）
  const navDoc = readJson(path.join(root, 'data/navlinks.json'));
  const beforeNav = navDoc.items;
  const keptNav = beforeNav.filter((n) => !isBannedDomain(n.promoUrl || n.url, bannedDomains));
  plan['data/navlinks.json'] = { before: beforeNav.length, after: keptNav.length, removed: beforeNav.length - keptNav.length };

  // 3. nav-details：只删出站命中示例域、或已不属于保留 nav 的详情页
  const detailsPath = path.join(root, 'data/nav-details.json');
  let detailsDoc = { schema: 'nav-details/v1', pages: [] };
  let beforeDetails = 0;
  if (fs.existsSync(detailsPath)) {
    detailsDoc = readJson(detailsPath);
    beforeDetails = (detailsDoc.pages || []).length;
  }
  const keptNavIds = new Set(keptNav.map((n) => n.navId));
  const keptDetails = (detailsDoc.pages || []).filter((p) =>
    keptNavIds.has(p.navId) && !isBannedDomain(p.outbound, bannedDomains)
  );
  plan['data/nav-details.json'] = { before: beforeDetails, after: keptDetails.length, removed: beforeDetails - keptDetails.length };

  // 4. discovered：只删示例域候选
  const discPath = path.join(root, 'data/discovered.json');
  let discDoc = null, beforeDisc = 0;
  if (fs.existsSync(discPath)) {
    discDoc = readJson(discPath);
    beforeDisc = (discDoc.candidates || []).length;
  }
  const keptDisc = discDoc ? (discDoc.candidates || []).filter((c) => !isBannedDomain(c.url || c.domain, bannedDomains)) : [];
  if (discDoc) plan['data/discovered.json'] = { before: beforeDisc, after: keptDisc.length, removed: beforeDisc - keptDisc.length };

  // 4b. site.intro：fill-site 从示例信源摘要填入的文案，直接回填为中性介绍（只匹配示例文案）。
  const sitePath = path.join(root, 'data/site.json');
  const site = fs.existsSync(sitePath) ? readJson(sitePath) : null;
  const introChanged = !!(site && /示例摘要/.test(String(site.intro || '')));
  if (introChanged) plan['data/site.json'] = { introReset: true };

  // 5. 报告与 state：只重置由示例数据产生的计数（runs 审计历史保留）
  const statePath = path.join(root, 'state.json');
  const state = readJson(statePath);
  state.sources = { l1: 0, independentL2: 0, passed: false };
  state.content = { generated: 0, gateBlocked: 0, passed: false };
  state.navPages = { built: keptDetails.length, downgraded: keptNav.length - keptDetails.length };
  plan['state.json'] = { sourcesReset: true, contentReset: true, navPages: state.navPages };

  const reportResets = {
    'reports/build-nav-pages.json': { stage: 'build-nav-pages', built: keptDetails.length, downgraded: keptNav.length - keptDetails.length, blockedCount: 0, bannedNavCount: 0, pages: keptDetails, downgradedDetail: [] },
    'reports/write-content.json': { stage: 'write-content', generated: 0, blocked: 0, gateBlockedCount: 0, contentPassed: false, deduped: 0, skippedNodes: ['n1'], bannedDomains: [...bannedDomains], blockedDetail: [] }
  };
  for (const [rel, doc] of Object.entries(reportResets)) {
    if (fs.existsSync(path.join(root, rel))) plan[rel] = { reset: true };
  }

  if (!args.apply) return { stage: 'clean-example-data', applied: false, plan };

  for (const rel of Object.keys(plan)) snapshotFile(root, rel, stamp);
  atomicWriteJson(path.join(root, 'data/sources.json'), { ...sourcesDoc, sources: keptSources });
  atomicWriteJson(path.join(root, 'data/navlinks.json'), { ...navDoc, items: keptNav });
  atomicWriteJson(detailsPath, { ...detailsDoc, pages: keptDetails });
  if (discDoc) atomicWriteJson(discPath, { ...discDoc, candidates: keptDisc });
  atomicWriteJson(statePath, state);
  if (introChanged) {
    site.intro = '各运营商套餐与办卡渠道整理，供选购时对照参考。数值以官方实时页面为准。';
    atomicWriteJson(sitePath, site);
  }
  for (const [rel, doc] of Object.entries(reportResets)) {
    if (fs.existsSync(path.join(root, rel))) atomicWriteJson(path.join(root, rel), doc);
  }
  return { stage: 'clean-example-data', applied: true, snapshot: `snapshots/before-example-cleanup-${stamp}`, plan };
}
