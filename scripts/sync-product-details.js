// 官方商品详情采集：把推广商品详情作为第一方信源自动入库，并挂到对应 nav 条目。
// 只转录客观字段、完整保留正文；不覆盖人工字段、不调用模型、不改 promoUrl。
// 失败/缺参条目保留旧值并写报告；dry-run 零写盘。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { atomicWriteJson, sha256, snapshot } from './lib/util.js';
import { loadState, saveState, recordRun, sourcesPassed } from './lib/state.js';
import { buildDetailText, mapDetailSource, parsePromoParams, postJson } from './lib/product-detail.js';

const NAV_REL = 'data/navlinks.json';
const SOURCES_REL = 'data/sources.json';

export async function runSyncProductDetails(root = ROOT, args = {}) {
  const cfg = readJson(path.join(root, 'config/api-nav.json'));
  const manifest = readJson(path.join(root, 'config/manifest.json'));
  const navDoc = readJson(path.join(root, NAV_REL));
  const sourcesDoc = readJson(path.join(root, SOURCES_REL));
  const sources = sourcesDoc.sources;
  const state = loadState(root);
  const oldCounts = JSON.stringify(state.sources);

  const all = (navDoc.items || []).filter((n) => n.productId != null && (n.promoUrl || n.url));
  const limit = args.limit ? Number(args.limit) : all.length;
  const targets = all.slice(0, limit);
  const sleep = args.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = Number(cfg.page?.timeoutMs || 15000);
  const rateMs = Number(cfg.detailRateMs || 0);
  const fetchedAt = new Date().toISOString();

  let created = 0, updated = 0, unchanged = 0, failed = 0, linked = 0;
  const failures = [];

  for (const nav of targets) {
    const { tk, pro } = parsePromoParams(nav.promoUrl || nav.url);
    if (!tk || !pro) {
      failed++; failures.push({ navId: nav.navId, reason: '推广链接缺 tk/pro 参数' });
      continue;
    }
    let resp;
    try {
      resp = await postJson(cfg.detailEndpoint, { userid: tk, pudiD: pro }, args.httpFn, timeoutMs);
    } catch (e) {
      failed++; failures.push({ navId: nav.navId, reason: `请求失败：${e.message}` });
      continue;
    }
    if (resp?.code !== 0 || !resp?.data?.pack) {
      failed++; failures.push({ navId: nav.navId, reason: `接口未返回详情：${resp?.message || 'no pack'}` });
      continue;
    }
    const text = buildDetailText(resp);
    if (text.length < 20) {
      failed++; failures.push({ navId: nav.navId, reason: '详情正文过短' });
      continue;
    }

    const hash = sha256(text);
    const sid = nav.productId != null ? `src-api-${nav.productId}` : `src-api-${nav.navId}`;
    const idx = sources.findIndex((s) => s.sourceId === sid);
    const existing = idx >= 0 ? sources[idx] : null;
    if (!existing || existing.bodyHash !== hash || args.refresh) {
      const record = mapDetailSource(nav, text, hash, fetchedAt);
      if (existing) { sources[idx] = { ...existing, ...record }; updated++; }
      else { sources.push(record); created++; }
    } else {
      unchanged++;
    }

    const ids = Array.isArray(nav.sourceIds) ? [...nav.sourceIds] : [];
    if (!ids.includes(sid)) { ids.push(sid); nav.sourceIds = ids; linked++; }
    if (rateMs > 0) await sleep(rateMs);
  }

  const l1 = sources.filter((s) => s.grade === 'L1' && s.status === 'approved').length;
  const independentL2 = new Set(sources.filter((s) => s.grade === 'L2' && s.status === 'approved').map((s) => s.domain)).size;
  state.sources = { l1, independentL2, passed: sourcesPassed(state, manifest) };
  const stateChanged = JSON.stringify(state.sources) !== oldCounts;
  const changed = created + updated + linked > 0 || stateChanged;

  const report = {
    stage: 'sync-product-details',
    endpoint: cfg.detailEndpoint,
    total: targets.length, created, updated, unchanged, failed, linked,
    sources: { l1, independentL2, passed: state.sources.passed },
    dryRun: !!args.dryRun,
    failures
  };

  if (!args.dryRun && changed) {
    const label = `before-product-details-${Date.now()}`;
    report.snapshots = [
      snapshot(path.join(root, SOURCES_REL), path.join(root, 'snapshots', label)),
      snapshot(path.join(root, NAV_REL), path.join(root, 'snapshots', label)),
      snapshot(path.join(root, 'state.json'), path.join(root, 'snapshots', label))
    ].filter(Boolean);
    atomicWriteJson(path.join(root, SOURCES_REL), sourcesDoc);
    atomicWriteJson(path.join(root, NAV_REL), navDoc);
    recordRun(state, {
      stage: 'sync-product-details', provider: 'official-api',
      summary: `详情信源 +${created} 更新 ${updated} 未变 ${unchanged} 失败 ${failed} 挂载 ${linked}`,
      inputs: targets.map((n) => n.navId).slice(0, 10)
    });
    saveState(state, root);
    writeJson(path.join(root, 'reports', 'sync-product-details.json'), report);
  }
  return report;
}
