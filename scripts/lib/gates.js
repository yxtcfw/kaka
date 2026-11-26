// 六道门禁：事实 / 重复 / 违禁合规 / 结构 / 可引用 / 合规出站。
// blog 文章与 nav 详情页共用同一套（v7 §1.4A：nav 详情页不豁免）。
import { readJson } from './validate.js';
import path from 'node:path';
import { cosineSimilarity, extractNumbers } from './util.js';

const BANNED = ['赌博', '博彩', '色情', '发票代开', '刷单', '虚假宣传', '包赚', '稳赚不赔'];

function defaultConfig(root) {
  const p = path.join(root, 'rules', 'autopilot.json');
  try {
    const rules = readJson(p);
    return rules.gate || {};
  } catch {
    return {};
  }
}

/**
 * 对单个 bundle/v1 跑六道门禁。
 * @param {object} bundle  bundle/v1 文档
 * @param {object} ctx     { root, sources, corpus }
 *   sources: sources.json 的 sources 数组（判可引用）
 *   corpus:  已有正文数组 [{id,title,body}]（判重复）
 * @returns { ok, passed, results:[{gate,ok,detail}], blockers }
 */
export function runGates(bundle, ctx = {}) {
  const root = ctx.root || process.cwd();
  const cfg = defaultConfig(root);
  const sources = ctx.sources || [];
  const corpus = ctx.corpus || [];
  const results = [];
  const add = (gate, ok, detail) => results.push({ gate, ok: !!ok, detail });

  // 1. 事实闸：每个 claim 的数字必须指回 citation；且 bundle 正文里出现的数字
  //    若来自 claims，则 claim 必须挂 citationId。
  const citations = new Set((bundle.citations || []).map((c) => c.sourceId));
  let factDetail = [];
  for (const claim of bundle.claims || []) {
    const nums = extractNumbers(claim.text);
    const missingNums = nums.length === 0 ? [] : (claim.citationIds || []).length ? [] : nums;
    if (missingNums.length) {
      factDetail.push(`claim「${claim.text}」含数字 ${missingNums.join(',')} 但无 citation`);
    }
    for (const cid of claim.citationIds || []) {
      if (!citations.has(cid)) factDetail.push(`claim 引用未登记的 citationId ${cid}`);
    }
  }
  add('fact', factDetail.length === 0, factDetail.length ? factDetail.join('；') : '所有数字均指回 citation');

  // 2. 重复闸：与语料库逐条比对余弦，超阈值即拦。
  const limit = cfg.dedupCosineMax ?? 0.7;
  const myText = `${bundle.title || ''} ${bundle.body || ''}`;
  let maxSim = 0, dupWith = '';
  for (const other of corpus) {
    if (other.id === bundle.id) continue;
    const sim = cosineSimilarity(myText, `${other.title || ''} ${other.body || ''}`);
    if (sim > maxSim) { maxSim = sim; dupWith = other.id; }
  }
  add('dedup', maxSim < limit, `max cosine=${maxSim.toFixed(3)} (limit ${limit})${dupWith ? ' with ' + dupWith : ''}`);

  // 3. 违禁词闸。
  const fullText = JSON.stringify(bundle);
  const hits = BANNED.filter((w) => fullText.includes(w));
  add('banned', hits.length === 0, hits.length ? `命中违禁词：${hits.join(',')}` : '无违禁词');

  // 4. 结构闸：cardDesc ≤60、nav 详情必须有 TOC 标记与文末唯一出站口。
  const structDetail = [];
  const cardMax = cfg.cardDescMax ?? 60;
  if (bundle.cardDesc && [...bundle.cardDesc].length > cardMax) structDetail.push(`cardDesc 超 ${cardMax} 字`);
  if (bundle.kind === 'nav-detail') {
    if (!bundle.toc || !Array.isArray(bundle.toc) || bundle.toc.length === 0) structDetail.push('nav 详情缺 TOC');
    const outs = (bundle.links || []).filter((l) => l.kind === 'outbound' || l.kind === 'promo');
    if (outs.length !== 1) structDetail.push(`nav 详情出站口须恰好 1 个，实为 ${outs.length}`);
  }
  add('structure', structDetail.length === 0, structDetail.length ? structDetail.join('；') : '结构合规');

  // 5. 可引用闸：引用的 sourceId 必须已登记且 status≠rejected。
  const byId = new Map(sources.map((s) => [s.sourceId, s]));
  const refDetail = [];
  const rejectRejected = cfg.rejectRejectedSource !== false;
  for (const cid of citations) {
    const s = byId.get(cid);
    if (!s) refDetail.push(`sourceId ${cid} 未登记`);
    else if (rejectRejected && s.status === 'rejected') refDetail.push(`sourceId ${cid} 状态为 rejected`);
  }
  add('citable', refDetail.length === 0, refDetail.length ? refDetail.join('；') : '引用源均可引用');

  // 6. 合规出站闸：所有出站链接 rel 必须含 sponsored/nofollow/noopener。
  const expectedRel = cfg.linkRel || 'sponsored nofollow noopener';
  const need = expectedRel.split(/\s+/).filter(Boolean);
  const linkDetail = [];
  for (const link of bundle.links || []) {
    if (link.kind === 'internal') continue;
    const rel = String(link.rel || '').split(/\s+/);
    const miss = need.filter((n) => !rel.includes(n));
    if (miss.length) linkDetail.push(`<${link.href}> 缺 rel: ${miss.join(',')}`);
  }
  add('compliance', linkDetail.length === 0, linkDetail.length ? linkDetail.join('；') : '出站 rel 合规');

  const blockers = results.filter((r) => !r.ok);
  return {
    ok: blockers.length === 0,
    passed: blockers.length === 0,
    results,
    blockers: blockers.map((b) => ({ gate: b.gate, detail: b.detail }))
  };
}

export const GATE_NAMES = ['fact', 'dedup', 'banned', 'structure', 'citable', 'compliance'];
