// 模型插件层：默认 mock（确定性、零 key、可幂等复现），真实 provider 只从环境变量取 key。
// 密钥永不落文件；概要只露指纹，不打印明文。
import { seededRandom, sha256 } from './util.js';

function keyFingerprint(key) {
  return key ? sha256(key).slice(0, 8) : 'none';
}

export function llmStatus(provider = 'mock') {
  const envMap = {
    openrouter: ['OPENROUTER_API_KEYS', 'OPENROUTER_API_KEY'],
    deepseek: ['DEEPSEEK_API_KEY'],
    dashscope: ['DASHSCOPE_API_KEY']
  };
  if (provider === 'mock') return { provider, available: true, keys: 1, fingerprint: 'mock' };
  const keys = (envMap[provider] || []).flatMap((n) => String(process.env[n] || '').split(',').map((s) => s.trim()).filter(Boolean));
  return { provider, available: keys.length > 0, keys: keys.length, fingerprint: keys.map(keyFingerprint) };
}

// 建树规则建议：mock 用 token→nodeId 映射的确定性实现。
export function suggestTreeRules(provider, seedTerms, mapping) {
  const status = llmStatus(provider);
  const rand = seededRandom(seedTerms.join('|'));
  const grouped = {};
  for (const term of seedTerms) {
    let target = 'n0';
    for (const [pattern, nodeId] of Object.entries(mapping || {})) {
      if (new RegExp(pattern).test(term)) { target = nodeId; break; }
    }
    (grouped[target] ||= []).push(term);
  }
  return {
    provider: status.available || provider === 'mock' ? provider : 'mock-fallback',
    deterministic: provider === 'mock',
    grouped,
    confidence: Number((0.7 + rand() * 0.2).toFixed(3)),
    note: 'mock 规则建议：按关键词映射归类；未命中进 n0。真实 provider 从 env 取 key。'
  };
}

// 生成内容 bundle 骨架（AI 只写组织/推荐语；数字必须来自 citations，mock 不编造数字）。
export function composeBundle(provider, { id, kind, title, sourceIds, cardDesc, toc, links, byline }) {
  const status = llmStatus(provider);
  const citations = (sourceIds || []).map((sourceId) => ({ sourceId }));
  return {
    schema: 'bundle/v1',
    id,
    kind: kind || 'article',
    title,
    body: `${title}：以下内容依据已登记信源整理，具体数值以官方实时页面为准。`,
    cardDesc: cardDesc || '',
    toc: toc || [],
    claims: [], // mock 不生成含数字的 claim；真实模型产出后必须挂 citationIds 才过事实闸
    citations,
    links: links || [],
    byline: byline || '',
    _meta: { provider: status.available || provider === 'mock' ? provider : 'mock-fallback' }
  };
}
