// 信源发现：联想词/主题词 → 搜索 API → 候选 URL 列表（默认 L3），带 provider/查询词/审计。
// 红线（附录 A）：搜索只发现候选 URL，候选一律 L3，不自爬 SERP。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { searchCandidates, createProviderGuard } from './lib/sources.js';
import { urlKey } from './lib/util.js';
import { recordRun, loadState, saveState } from './lib/state.js';
import { loadExclusions, filterBannedCandidates } from './lib/exclusions.js';

export async function runDiscover(root = ROOT, args = {}) {
  const manifest = readJson(path.join(root, 'config/manifest.json'));
  const provider = manifest.providers?.search || 'mock';
  let terms = [];
  try {
    const signals = readJson(path.join(root, 'data/signals.json'));
    terms = signals.items.map((i) => i.term);
  } catch { /* 无 signals 时用种子词 */ }
  if (!terms.length) {
    terms = readJson(path.join(root, 'seeds.json')).seeds;
  }
  // 取有代表性的词（去重后按长度降序，优先信息量高的长词），限量
  const picked = [...new Set(terms)].sort((a, b) => b.length - a.length).slice(0, Number(args.limit || 30));

  let candidates = [];
  let degraded = false;
  let reason = '';
  let guard = null;
  try {
    // 真 provider 必须经 fetch-guard 发请求；mock 链路不创建 guard（零网络、零等待）。
    if (provider !== 'mock') {
      guard = createProviderGuard(root, {
        ...args,
        fetchFn: args.fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
      });
    }
    candidates = await searchCandidates(picked, provider, picked.length, { ...args, root, guard });
  } catch (e) {
    // 真 provider 失败 → 降级 mock，失败原因上屏，不静默伪造。
    degraded = true;
    reason = `${e.name || 'Error'}: ${e.message || e}`;
    guard = null;
    candidates = await searchCandidates(picked, 'mock', picked.length);
  }
  const guardStats = guard ? { enabled: true, ...guard.getStats() } : { enabled: false, reason: degraded ? 'degraded-to-mock' : 'mock-provider' };

  // 示例/占位域名在新候选入库前过滤（根因：mock 与降级链路固定产出 example.*，不清会反复入库）。
  // 只作用于本轮候选，不动既有 sources/navlinks 人工数据。
  const { bannedDomains } = loadExclusions(root);
  const { kept, dropped } = filterBannedCandidates(candidates, bannedDomains);

  // 已有源 URL 判重（归因参数归一）
  const sources = readJson(path.join(root, 'data/sources.json')).sources;
  const seen = new Set(sources.map((s) => urlKey(s.url)));
  const fresh = [];
  for (const c of kept) {
    const k = urlKey(c.url);
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push({ ...c, discoveredBy: 'search', defaultGrade: 'L3', foundAt: new Date().toISOString().slice(0, 10) });
  }

  const doc = { schema: 'discovered/v1', provider, degraded, reason, queryTerms: picked, candidates: fresh, discoveredAt: new Date().toISOString() };
  const report = { stage: 'discover', provider, degraded, reason, queries: picked.length, candidates: fresh.length, bannedFiltered: dropped.length, guard: guardStats };

  if (!args.dryRun) {
    writeJson(path.join(root, 'data/discovered.json'), doc);
    if (degraded) writeJson(path.join(root, 'reports', 'discover-degraded.json'), report);
    const state = loadState(root);
    recordRun(state, { stage: 'discover', provider, summary: `${fresh.length} 候选${degraded ? '(已降级mock)' : ''}${dropped.length ? `, 过滤示例域 ${dropped.length}` : ''}`, inputs: picked.slice(0, 10) });
    saveState(state, root);
  }
  return report;
}
