// 数据可信门禁：纯函数、零依赖、字段路径全部来自 rules/data-quality.json。
// 换垂直主题只改规则文件的 fields/checks/thresholds，不改本模块。
// 纪律：不猜数字。口径矛盾只标记 unresolved；只做两类确定性修正（划线价倒挂、销量超阈值）。
import path from 'node:path';
import { readJson } from './validate.js';

const DEFAULT_RULES = {
  enabled: true,
  enforceOnSync: false,
  reportOnValidate: true,
  fields: {},
  checks: {},
  thresholds: {},
  excludedTitlePatterns: [],
  yearUnitPatterns: []
};

export function loadDataQualityRules(root) {
  let rules;
  try { rules = readJson(path.join(root, 'rules/data-quality.json')); } catch { rules = {}; }
  return {
    ...DEFAULT_RULES,
    ...rules,
    fields: { ...DEFAULT_RULES.fields, ...(rules.fields || {}) },
    checks: { ...DEFAULT_RULES.checks, ...(rules.checks || {}) },
    thresholds: { ...DEFAULT_RULES.thresholds, ...(rules.thresholds || {}) }
  };
}

function get(obj, pathStr) {
  let cur = obj;
  for (const part of String(pathStr || '').split('.')) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return '';
    cur = cur[part];
  }
  return cur ?? '';
}

function set(obj, pathStr, value) {
  const parts = String(pathStr || '').split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  delete cur[parts[parts.length - 1]]; // 隐藏字段 = 移除键，不写空串/0
}

const num = (v) => {
  const raw = String(v ?? '').trim();
  if (!raw) return null; // 缺失字段绝不当成 0（否则隐藏后会再次被判违规，破坏幂等）
  const n = Number(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && raw.replace(/[^\d.]/g, '') !== '' ? n : null;
};

// 从标题里取「数字G」作为标题口径（第一个匹配）。
function titleFlow(title) {
  const m = /(\d+(?:\.\d+)?)\s*G/i.exec(String(title || ''));
  return m ? Number(m[1]) : null;
}

// 从明细串里取「通用\s*数字G」；取不到返回 null（不猜）。
function planGeneral(planText) {
  const text = String(planText || '');
  // 兼容两种语序：「通用200G」与「200G通用」，不猜无「通用」字样的裸数字。
  const m = /通用\s*(\d+(?:\.\d+)?)\s*G/i.exec(text) || /(\d+(?:\.\d+)?)\s*G\s*通用/i.exec(text);
  return m ? Number(m[1]) : null;
}

// 检查单条：返回 { violations, unresolved, fixes }。fixes 只含确定性修正记录。
export function checkItem(item, rules = DEFAULT_RULES) {
  const f = rules.fields;
  const title = get(item, f.title);
  const general = num(get(item, f.generalFlow));
  const directional = num(get(item, f.directionalFlow));
  const plan = get(item, f.planText);
  const price = num(get(item, f.price));
  const oldPrice = num(get(item, f.oldPrice));
  const priceUnit = String(get(item, f.priceUnit) || '');
  const sales = num(get(item, f.sales));
  const violations = [];
  const unresolved = [];
  const fixes = [];
  const add = (code, detail) => violations.push({ code, detail });
  const c = rules.checks;

  if (c.titleFlowMatchesGeneral !== false) {
    const t = titleFlow(title);
    if (t != null && general != null && t !== general) {
      const sum = t === general + (directional || 0);
      add('title-flow-mismatch', `标题 ${t}G / 通用 ${general}G${sum ? `（恰为通用+定向 ${directional}G，标题口径需改）` : ''}`);
      // 口径冲突一律交人工：即使恰好等于通用+定向，也不能自动把用户可见标题改成猜测值。
      unresolved.push({ code: 'title-flow-needs-human', detail: `${title}：${sum ? '标题把定向计入总量' : '明细与汇总不一致'}，需人工定稿` });
    }
    if (t != null && general == null) unresolved.push({ code: 'general-flow-missing', detail: `${title}：缺通用流量字段` });
  }

  if (c.planDetailMatchesSummary !== false) {
    const pg = planGeneral(plan);
    if (pg != null && general != null && pg !== general) {
      add('plan-summary-mismatch', `明细通用 ${pg}G / 汇总通用 ${general}G`);
      unresolved.push({ code: 'plan-summary-needs-human', detail: `${title}：明细与汇总字段矛盾` });
    }
  }

  if (c.priceUnitHonest !== false) {
    if ((rules.yearUnitPatterns || []).some((p) => priceUnit.includes(p))) {
      add('price-unit-year', `价格单位「${priceUnit}」不得占用月租位`);
      if (/月均\s*\d+\s*元/.test(String(plan))) {
        unresolved.push({ code: 'year-plan-title-needs-human', detail: `${title}：年费卡标题含月均口径，需人工确认表述` });
      }
    }
  }

  if (c.oldPriceHigherThanNow !== false && oldPrice != null && price != null && oldPrice <= price) {
    add('old-price-not-higher', `划线价 ${oldPrice} ≤ 现价 ${price}`);
    fixes.push({ code: 'hide-old-price', field: f.oldPrice, reason: '划线原价不高于现价，按规则隐藏' });
  }

  if (c.salesExplainable !== false && sales != null && sales > Number(rules.thresholds.salesMax || 100000)) {
    add('sales-not-explainable', `销量 ${sales} 超过合理上限 ${rules.thresholds.salesMax}`);
    fixes.push({ code: 'hide-sales', field: f.sales, reason: '销量口径不可解释，按规则隐藏' });
  }

  if (c.relevantSkuOnly !== false) {
    const excluded = (rules.excludedTitlePatterns || []).some((p) => String(title).includes(p));
    const flowMissing = general == null && !num(get(item, 'specs.tonghua'));
    if (excluded || (flowMissing && /年卡|会员/.test(String(title)))) {
      add('irrelevant-sku', `非本主题 SKU：${title}`);
      unresolved.push({ code: 'sku-needs-human', detail: `${title}：应移出本主题列表（需人工确认后删除）` });
    }
  }

  return { violations, unresolved, fixes };
}

// 确定性修正：只应用 fixes（隐藏字段），不动任何数值本身；幂等（再跑一次无变化）。
export function applySafeFixes(item, rules = DEFAULT_RULES) {
  const result = checkItem(item, rules);
  const next = JSON.parse(JSON.stringify(item));
  for (const fix of result.fixes) set(next, fix.field, null);
  return { item: next, fixes: result.fixes, violations: result.violations, unresolved: result.unresolved };
}

// 批量检查：返回报告，不改数据。供 validate 与 CI 报告消费。
export function checkAll(items, rules = DEFAULT_RULES) {
  const rows = [];
  for (const item of items || []) {
    const r = checkItem(item, rules);
    rows.push({
      id: get(item, 'navId') || get(item, 'id') || '',
      title: get(item, rules.fields.title),
      ...r
    });
  }
  const bad = rows.filter((r) => r.violations.length || r.unresolved.length);
  return {
    stage: 'data-quality',
    enabled: rules.enabled !== false,
    checked: rows.length,
    passed: rows.length - bad.length,
    failed: bad.length,
    fixable: bad.filter((r) => r.fixes.length).length,
    needsHuman: bad.filter((r) => r.unresolved.length).length,
    rows: bad
  };
}

// 落库前门禁：enforceOnSync=true 时拒绝不合规新条目（确定性可修的先修再收）。
export function enforceItems(items, rules = DEFAULT_RULES) {
  if (rules.enabled === false || rules.enforceOnSync !== true) {
    return { accepted: items || [], rejected: [], fixed: [], enforced: false };
  }
  const accepted = [];
  const rejected = [];
  const fixed = [];
  for (const item of items || []) {
    const r = checkItem(item, rules);
    const blocking = r.violations.filter((v) => !['old-price-not-higher', 'sales-not-explainable'].includes(v.code));
    if (blocking.length) {
      rejected.push({ id: get(item, 'navId') || '', title: get(item, rules.fields.title), violations: blocking });
      continue;
    }
    if (r.fixes.length) {
      const applied = applySafeFixes(item, rules);
      accepted.push(applied.item);
      fixed.push({ id: get(item, 'navId') || '', fixes: applied.fixes });
    } else {
      accepted.push(item);
    }
  }
  return { accepted, rejected, fixed, enforced: true };
}
