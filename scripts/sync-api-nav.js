// 推广产品 API → nav 同步：拉数据→客观参数映射→按 productID 去重→合并写 navlinks。
// 幂等：已存在的 productId/url 不覆盖；人工条目（无 productId）永不改写。写前快照，支持回滚。
import path from 'node:path';
import { readJson, ROOT } from './lib/validate.js';
import { atomicWriteJson } from './lib/util.js';
import { makeSnapshots } from './lib/snapshot.js';
import { loadState, saveState, recordRun } from './lib/state.js';
import { fetchAll, dedupeProducts, reclassify } from './lib/api-nav.js';

const CONFIG_REL = 'config/api-nav.json';
const NAV_REL = 'data/navlinks.json';

function loadCfg(root) {
  return readJson(path.join(root, CONFIG_REL));
}

function mergeNav(existing, fresh) {
  // 现有条目标记：按 productId（API 来源）或原 URL 判重。人工条目不覆盖。
  const seenProd = new Set();
  const seenUrl = new Set();
  for (const it of existing) {
    if (it.productId != null) seenProd.add(String(it.productId));
    seenUrl.add(String(it.url || ''));
  }
  const added = [];
  const skipped = { duplicate: 0, noUrl: 0 };
  for (const it of fresh) {
    if (!it.url) { skipped.noUrl++; continue; }
    const pk = it.productId != null ? String(it.productId) : null;
    if ((pk && seenProd.has(pk)) || seenUrl.has(String(it.url))) { skipped.duplicate++; continue; }
    if (pk) seenProd.add(pk);
    seenUrl.add(String(it.url));
    added.push(it);
  }
  return { items: [...existing, ...added], added, skipped };
}

// 仅重分类模式：不拉接口，只读 navlinks 按新 categoryByIsp 改 API 条目分类。
// 人工条目（无 productId）永不改；写前快照；幂等（无变化不写盘）。
export async function runReclassify(root = ROOT, args = {}) {
  const cfg = loadCfg(root);
  const navPath = path.join(root, NAV_REL);
  const current = readJson(navPath);
  const { items, changed } = reclassify(current.items || [], cfg);
  const report = {
    stage: 'reclassify-api-nav',
    changed,
    total: items.length,
    dryRun: !!args.dryRun
  };
  if (!args.dryRun && changed > 0) {
    makeSnapshots(root, 'pre-reclassify-api-nav');
    atomicWriteJson(navPath, { ...current, items });
    const state = loadState(root);
    recordRun(state, { stage: 'reclassify-api-nav', provider: 'lot-ml-api', summary: `重分类 ${changed} 条` });
    saveState(state, root);
    report.snapshot = 'snapshots/pre-reclassify-api-nav';
  }
  return report;
}

export async function runSyncApiNav(root = ROOT, args = {}) {
  const cfg = loadCfg(root);
  if (cfg.enabled === false && !args.force) {
    return { stage: 'sync-api-nav', skipped: true, reason: 'config enabled=false' };
  }
  if (args.reclassify) return runReclassify(root, args);
  const deps = {};
  if (args.httpFn) deps.httpFn = args.httpFn;
  if (args.fetchFn) deps.fetchFn = args.fetchFn;
  if (args.sleep) deps.sleep = args.sleep;

  const { items: raw, meta } = await fetchAll(cfg, deps);
  const { items: fresh, duplicates } = dedupeProducts(raw, cfg);
  const navPath = path.join(root, NAV_REL);
  const current = readJson(navPath);
  const { items, added, skipped } = mergeNav(current.items || [], fresh);
  const nextDoc = { ...current, items };

  const report = {
    stage: 'sync-api-nav',
    fetched: meta.fetched,
    apiCount: meta.count,
    apiErrors: meta.errors,
    duplicates,
    added: added.length,
    skipped,
    total: items.length,
    degraded: meta.errors.length > 0 && meta.fetched === 0,
    dryRun: !!args.dryRun
  };

  if (!args.dryRun && added.length) {
    makeSnapshots(root, 'pre-sync-api-nav');
    atomicWriteJson(navPath, nextDoc);
    const state = loadState(root);
    recordRun(state, { stage: 'sync-api-nav', provider: 'lot-ml-api', summary: `+${added.length} 商品nav` });
    saveState(state, root);
    report.snapshot = 'snapshots/pre-sync-api-nav';
  }
  return report;
}
