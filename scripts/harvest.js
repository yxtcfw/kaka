// 联想词采集：种子词 → 多源 suggest → 归一去重 → signals/v1 → 更新判据①进度。
// provider 来自 manifest.providers.suggest；默认 mock 确定性产出（可幂等复现）。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { loadState, saveState, recordRun, signalsPassed } from './lib/state.js';
import { seededRandom } from './lib/util.js';
import { snapshot } from './lib/util.js';
import { collectSuggest, buildQueries } from './lib/suggest.js';

const SUFFIX = ['办理', '资费', '攻略', '对比', '怎么选', '注意事项', '2026', '官方', '价格', '避坑', '哪个好用', '排行榜', '怎么办', '需要多少钱', '在哪里办', '有什么坑'];
const PREFIX = ['', '移动', '联通', '电信', '低价', '大流量', '学生', '不限量'];

function mockSuggest(seeds) {
  const out = [];
  const seen = new Set();
  const rand = seededRandom(seeds.join('|'));
  const SOURCES = ['mock-suggest-a', 'mock-suggest-b'];
  let n = 0;
  const push = (term) => {
    if ([...term].length < 3 || seen.has(term)) return;
    seen.add(term);
    out.push({ term, source: SOURCES[n % SOURCES.length], collectedAt: new Date().toISOString().slice(0, 10) });
    n++;
  };
  for (const seed of seeds) {
    for (const pre of PREFIX) {
      for (const suf of SUFFIX) {
        push(`${pre}${seed}${suf}`);
      }
    }
  }
  // 目标 320 条，确定性补足（后缀再叠加数字档位）
  const EXTRA = ['19元', '29元', '39元', '100G', '200G', '长期', '无限', '测评'];
  let k = 0;
  while (out.length < 320 && k < 2000) {
    const seed = seeds[k % seeds.length];
    push(`${seed}${EXTRA[k % EXTRA.length]}${SUFFIX[Math.floor(k / EXTRA.length) % SUFFIX.length]}`);
    k++;
  }
  return out.slice(0, 320 + Math.floor(rand() * 20));
}

export async function runHarvest(root = ROOT, args = {}) {
  const manifest = readJson(path.join(root, 'config/manifest.json'));
  const seedsDoc = readJson(path.join(root, 'seeds.json'));
  const provider = manifest.providers?.suggest || 'mock';

  let collected;
  let degraded = false;
  let reason = '';
  let guardStats = { enabled: false, reason: provider === 'mock' ? 'mock-provider' : 'not-started' };
  if (provider === 'mock') {
    collected = mockSuggest(seedsDoc.seeds);
  } else {
    try {
      const r = await collectSuggest(provider, seedsDoc.seeds, {
        ...args, root,
        maxQueries: Number(args.maxQueries || 36),
        queries: args.queries || buildQueries(seedsDoc.seeds, Number(args.maxQueries || 36))
      });
      collected = r.items;
      guardStats = { enabled: true, ...r.guard };
    } catch (e) {
      // 真 provider 失败：显式降级 mock，原因上屏，不静默伪造真实采集。
      degraded = true;
      reason = `${e.name || 'Error'}: ${e.message || e}`;
      collected = mockSuggest(seedsDoc.seeds);
      guardStats = { enabled: false, reason: `degraded: ${reason}` };
    }
  }

  // 第二真实信号源：已入库 API 商品名（来自商品接口，不是编造的第二 provider）。
  // 首轮可能尚无商品，次轮起稳定计入；只取有 productId 的条目，不动人工 nav。
  let productTerms = [];
  try {
    const navDoc = readJson(path.join(root, 'data/navlinks.json'));
    productTerms = (navDoc.items || [])
      .filter((n) => n.productId != null && String(n.title || '').trim())
      .map((n) => ({ term: String(n.title).trim(), source: 'api-product', collectedAt: new Date().toISOString().slice(0, 10) }));
  } catch { /* 无 navlinks 时忽略 */ }
  collected.push(...productTerms);

  // 归一去重 + 停用词/长度过滤（只过滤真采集词，mock 保持原有确定性语义）
  let stopWords = [];
  try { stopWords = readJson(path.join(root, 'rules/signals-tree.json')).stopWords || []; } catch { /* 无规则文件则不过滤 */ }
  const seen = new Set();
  const items = [];
  for (const it of collected) {
    const key = String(it.term || '').trim();
    if (!key || seen.has(key) || stopWords.includes(key)) continue;
    if (!degraded && provider !== 'mock' && ([...key].length < 3 || [...key].length > 20)) continue;
    seen.add(key);
    items.push(it);
  }

  // 新增率：与已有 signals 对比；首次无文件时视为 100% 新增
  const signalsPath = path.join(root, 'data/signals.json');
  const prev = readJsonSafe(signalsPath);
  const prevTerms = new Set((prev?.items || []).map((i) => i.term));
  const newRate = prevTerms.size === 0 ? 1 : items.filter((i) => !prevTerms.has(i.term)).length / items.length;

  const doc = { schema: 'signals/v1', items, collectedAt: new Date().toISOString(), provider };
  const state = loadState(root);
  state.signals = {
    count: items.length,
    sources: new Set(items.map((i) => i.source)).size,
    newRate: Number(newRate.toFixed(4)),
    passed: signalsPassed({ ...state, signals: { ...state.signals, count: items.length, sources: new Set(items.map((i) => i.source)).size, newRate } }, manifest)
  };
  recordRun(state, { stage: 'harvest', provider, summary: `采集 ${items.length} 词，newRate=${state.signals.newRate}${degraded ? '（真实采集失败已降级）' : ''}`, inputs: seedsDoc.seeds });

  const report = { stage: 'harvest', provider, count: items.length, sources: state.signals.sources, newRate: state.signals.newRate, passed: state.signals.passed, degraded, reason, guard: guardStats, threshold: manifest.thresholds };

  if (!args.dryRun) {
    snapshot(signalsPath, path.join(root, 'snapshots', 'signals'));
    writeJson(signalsPath, doc);
    saveState(state, root);
    writeJson(path.join(root, 'reports', 'harvest.json'), report);
    if (degraded) writeJson(path.join(root, 'reports', 'harvest-degraded.json'), report);
  }
  return report;
}

function readJsonSafe(p) {
  try { return readJson(p); } catch { return null; }
}
