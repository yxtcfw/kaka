// Fact Sheet：把已登记信源转成可核验的事实清单 + 素材包。
// 只做确定性抽取：不换算、不补全、不编造用户评价。L3 字段标记为不得作确定报价。
import path from 'node:path';
import { readJson } from './validate.js';

const DEFAULT = {
  gradePolicy: {
    L1: { not_for: [], usable_as: '可直接作确定表述，须注明信源' },
    L2: { not_for: [], usable_as: '可引用，须注明信源' },
    L3: { not_for: ['fact', 'price'], usable_as: '仅可作为「据平台整理约为」类表述，不得作为确定报价' }
  },
  fields: {
    monthly_fee: { keys: ['月租费用', '套餐资费', 'nowPrice'], label: '月租' },
    general_data: { keys: ['通用流量', 'tyLiuliang'], label: '通用流量' },
    activation_fee: { keys: ['首充要求', '优惠说明'], label: '首充要求' },
    age_range: { keys: ['年龄要求', 'age'], label: '年龄要求' },
    contract_months: { keys: ['合约期限'], label: '合约期限' },
    excluded_regions: { keys: ['禁发地区'], label: '禁发地区' },
    overage_rate: { keys: ['超出资费', '套外资费'], label: '套外资费' }
  },
  comparisonCards: 3,
  sourcesPerNode: 3,
  maxFactChars: 240,
  l3Qualifier: '据平台整理约为',
  pitfallKeys: ['首充要求', '优惠说明'],
  surprisingKeys: ['超出资费', '套外资费'],
  linkKeywordsTo: ['title', 'bodyExcerpt', 'category', 'specs']
};

export function loadFactConfig(root) {
  try { return { ...DEFAULT, ...readJson(path.join(root, 'config/fact-sheet.json')) }; }
  catch { return { ...DEFAULT }; }
}

// 从「字段：值」行与 specs 中取值；只取原文，不做换算。
function extractPairs(source, card, cfg) {
  const pairs = [];
  const text = String(source.bodyExcerpt || '');
  const specs = card?.specs || {};
  for (const [field, def] of Object.entries(cfg.fields || DEFAULT.fields)) {
    let value = '';
    for (const key of def.keys || []) {
      if (Object.prototype.hasOwnProperty.call(specs, key)) { value = String(specs[key]); break; }
      const m = text.match(new RegExp(`(?:^|\\n)${key}\\s*[：:]\\s*([^\\n]+)`));
      if (m && m[1].trim()) { value = m[1].trim(); break; }
    }
    if (!value || value.length > Number(cfg.maxFactChars || 240)) continue;
    pairs.push({ field, label: def.label || field, value });
  }
  return pairs;
}

export function buildFactSheet(root, sourcesDoc, navDoc, cfg = loadFactConfig(root)) {
  const sources = (sourcesDoc?.sources || []).filter((s) => s.status === 'approved' && (s.bodyExcerpt || '').length >= 30);
  const cards = navDoc?.items || [];
  const cardBySource = new Map();
  for (const c of cards) for (const sid of c.sourceIds || []) if (!cardBySource.has(sid)) cardBySource.set(sid, c);

  const facts = [];
  for (const s of sources) {
    const grade = String(s.grade || 'L3');
    const policy = (cfg.gradePolicy || {})[grade] || (cfg.gradePolicy || {}).L3 || DEFAULT.gradePolicy.L3;
    for (const pair of extractPairs(s, cardBySource.get(s.sourceId), cfg)) {
      facts.push({
        factId: `f-${s.sourceId}-${pair.field}`,
        field: pair.field, label: pair.label, value: pair.value,
        grade, sourceId: s.sourceId, sourceUrl: s.url || null,
        fetchedAt: s.fetchedAt || null,
        not_for: [...(policy.not_for || [])], usable_as: policy.usable_as || ''
      });
    }
  }
  return { schema: 'fact-sheet/v1', promptVersion: cfg.promptVersion || '', facts };
}

// 关键词与信源的相关性打分：标题命中权重高，正文/分类/规格命中权重低。
// 这一步取代旧的「按未使用顺序取下一篇」，避免校园卡文章挂广电飞花卡。
export function rankSourcesForNode(node, sourcesDoc, navDoc, cfg = {}) {
  const weights = { title: 6, bodyExcerpt: 1, category: 3, specs: 2 };
  const keys = (node?.keywords || []).map(String).filter((k) => k.length >= 2);
  const topic = String(node?.topic || node?.label || '');
  const terms = [...new Set([topic, ...keys])];
  const cards = navDoc?.items || [];
  const cardBySource = new Map();
  for (const c of cards) for (const sid of c.sourceIds || []) if (!cardBySource.has(sid)) cardBySource.set(sid, c);
  const weightsGrade = cfg.gradeWeights || { L1: 12, L2: 4, L3: -10 };
  const excludePrimary = cfg.excludeGradesFromPrimary || ['L3'];
  return (sourcesDoc?.sources || [])
    .filter((s) => s.status === 'approved' && (s.bodyExcerpt || '').length >= 50 && !excludePrimary.includes(String(s.grade || 'L3')))
    .map((s) => {
      const card = cardBySource.get(s.sourceId) || {};
      // 官方详情优先：L3 平台文章常含网页导航垃圾，不得成为文章主信源。
      let score = Number(weightsGrade[s.grade] ?? 0);
      for (const term of terms) {
        if (String(s.title || '').includes(term)) score += weights.title;
        if (String(card.category || '').includes(term)) score += weights.category;
        if (String(s.bodyExcerpt || '').includes(term)) score += weights.bodyExcerpt;
        const specText = JSON.stringify(card.specs || {});
        if (specText.includes(term)) score += weights.specs;
      }
      // 卡标题命中节点关键词：信源与卡片同题时强相关。
      if (keys.some((k) => String(card.title || '').includes(k))) score += weights.title;
      return { source: s, score };
    })
    .sort((a, b) => b.score - a.score || a.source.sourceId.localeCompare(b.source.sourceId))
    .map((x) => x.source);
}

// 素材包：三张同类卡对比 + 一个具体的坑 + 一个反常识数字。
// 用户原话当前无真实采集数据，本模块不生成、不伪造。
export function buildMaterialPack(node, ranked, factSheet, cfg = loadFactConfig(rootFallback())) {
  const n = Number(cfg.comparisonCards || 3);
  const sameIsp = (node?.isp && ranked.filter((s) => s.domain === node.isp)) || [];
  const pool = (sameIsp.length >= n ? sameIsp : ranked).slice(0, n);
  const bySource = new Map();
  for (const f of factSheet.facts || []) {
    if (!bySource.has(f.sourceId)) bySource.set(f.sourceId, []);
    bySource.get(f.sourceId).push(f);
  }
  const comparisons = pool.map((s) => ({
    title: s.title, sourceId: s.sourceId, grade: s.grade || 'L3',
    facts: (bySource.get(s.sourceId) || []).filter((f) => ['monthly_fee', 'general_data', 'age_range', 'excluded_regions'].includes(f.field)).slice(0, 6)
  }));
  const pick = (keys) => {
    for (const s of ranked.slice(0, 8)) {
      // 配置里既可写英文字段名（monthly_fee），也可写信源原文行名（首充要求）。
      const found = (bySource.get(s.sourceId) || []).find((f) => keys.includes(f.field) || keys.includes(f.label));
      if (found) return { ...found, sourceTitle: s.title };
    }
    return null;
  };
  return {
    comparisons,
    pitfall: pick(cfg.pitfallKeys || DEFAULT.pitfallKeys),
    surprisingNumber: pick(cfg.surprisingKeys || DEFAULT.surprisingKeys),
    userQuotes: [], // 无真实评论素材，保持为空：脚本不得伪造用户原话
    _comment: '全部素材来自已登记信源原文；L3 字段须用限定语，不得作确定报价。'
  };
}

function rootFallback() { return process.cwd(); }

// 给模型看的紧凑文本：数字只来自 Fact Sheet，L3 附限定语。
export function factSheetDigest(factSheet, materialPack, cfg = DEFAULT, maxChars = 4000) {
  const lines = [];
  for (const f of (factSheet.facts || []).slice(0, 60)) {
    const limit = (f.grade === 'L3') ? ` [${cfg.l3Qualifier || DEFAULT.l3Qualifier}]` : '';
    lines.push(`${f.field}(${f.grade}): ${f.value}${limit} [${f.sourceId}]`);
  }
  const pack = materialPack || {};
  if (pack.comparisons?.length) {
    lines.push('同类卡对比：' + pack.comparisons.map((c) => `${c.title}[${c.sourceId}]`).join(' | '));
  }
  if (pack.pitfall) lines.push(`具体的坑(${pack.pitfall.sourceId}): ${pack.pitfall.label}=${pack.pitfall.value}`);
  if (pack.surprisingNumber) lines.push(`反常识数字(${pack.surprisingNumber.sourceId}): ${pack.surprisingNumber.label}=${pack.surprisingNumber.value}`);
  if (pack.userQuotes?.length) lines.push('用户原话：' + pack.userQuotes.join(' / '));
  return [...lines].join('\n').slice(0, maxChars);
}
