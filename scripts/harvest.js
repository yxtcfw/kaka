// 联想词采集：种子词 → 多源 suggest → 归一去重 → signals/v1 → 更新判据①进度。
// provider 来自 manifest.providers.suggest；默认 mock 确定性产出（可幂等复现）。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { loadState, saveState, recordRun, signalsPassed } from './lib/state.js';
import { seededRandom } from './lib/util.js';
import { snapshot } from './lib/util.js';

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

export function runHarvest(root = ROOT, args = {}) {
  const manifest = readJson(path.join(root, 'config/manifest.json'));
  const seedsDoc = readJson(path.join(root, 'seeds.json'));
  const provider = manifest.providers?.suggest || 'mock';

  let collected;
  if (provider === 'mock') collected = mockSuggest(seedsDoc.seeds);
  else throw new Error(`suggest provider ${provider} 需要 env key；本模板默认 mock，${provider} 未启用`);

  // 归一去重
  const seen = new Set();
  const items = [];
  for (const it of collected) {
    const key = it.term.trim();
    if (!key || seen.has(key)) continue;
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
  recordRun(state, { stage: 'harvest', provider, summary: `采集 ${items.length} 词，newRate=${state.signals.newRate}`, inputs: seedsDoc.seeds });

  const report = { stage: 'harvest', provider, count: items.length, sources: state.signals.sources, newRate: state.signals.newRate, passed: state.signals.passed, threshold: manifest.thresholds };

  if (!args.dryRun) {
    snapshot(signalsPath, path.join(root, 'snapshots', 'signals'));
    writeJson(signalsPath, doc);
    saveState(state, root);
    writeJson(path.join(root, 'reports', 'harvest.json'), report);
  }
  return report;
}

function readJsonSafe(p) {
  try { return readJson(p); } catch { return null; }
}
