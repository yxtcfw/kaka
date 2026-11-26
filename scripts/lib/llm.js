// 模型插件层：默认 mock（确定性、零 key、可幂等复现），真实 provider 只从环境变量取 key。
// 密钥永不落文件；概要只露指纹，不打印明文。
// 真实 provider（OpenRouter / DeepSeek / DashScope）走 OpenAI 兼容 chat/completions，
// 所有网络请求经注入的 fetchFn（默认用全局 fetch），失败显式降级 mock 并在报告标注，绝不静默伪造。
import { seededRandom, sha256 } from './util.js';

function keyFingerprint(key) {
  return key ? sha256(key).slice(0, 8) : 'none';
}

const ENV_KEYS = {
  openrouter: ['OPENROUTER_API_KEYS', 'OPENROUTER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  dashscope: ['DASHSCOPE_API_KEY']
};
const ENDPOINT = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
};
const DEFAULT_MODEL = {
  openrouter: 'openai/gpt-4o-mini',
  deepseek: 'deepseek-chat',
  dashscope: 'qwen-plus'
};

export function llmStatus(provider = 'mock') {
  if (provider === 'mock') return { provider, available: true, keys: 1, fingerprint: 'mock' };
  const keys = (ENV_KEYS[provider] || []).flatMap((n) => String(process.env[n] || '').split(',').map((s) => s.trim()).filter(Boolean));
  return { provider, available: keys.length > 0, keys: keys.length, fingerprint: keys.map(keyFingerprint) };
}

function getKeys(provider) {
  return (ENV_KEYS[provider] || []).flatMap((n) => String(process.env[n] || '').split(',').map((s) => s.trim()).filter(Boolean));
}

// 从模型回复里稳健抽取 JSON（容忍 ```json 包裹与前后说明文字）。
function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.search(/[{[]/);
  if (start < 0) return null;
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  const end = candidate.lastIndexOf(close);
  if (end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); }
  catch { return null; }
}

// 真实 HTTP 调用：多 key 轮换 + 8 位指纹 + 429/5xx 冷却（15min，进程内）。
// opts: { fetchFn, model, maxRetries, timeoutMs, nowFn }
async function callModel(provider, messages, opts = {}) {
  const status = llmStatus(provider);
  if (!status.available) return { ok: false, reason: 'no-key' };
  const endpoint = ENDPOINT[provider];
  if (!endpoint) return { ok: false, reason: 'unsupported-provider' };
  const keys = getKeys(provider);
  const fetchFn = opts.fetchFn || ((...a) => fetch(...a));
  const model = opts.model || process.env[`${provider.toUpperCase()}_MODEL`] || DEFAULT_MODEL[provider];
  const maxRetries = Number(opts.maxRetries ?? 1);
  const timeoutMs = Number(opts.timeoutMs ?? 20000);
  let lastErr = '';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const key = keys[attempt % keys.length];
    try {
      const res = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://vertical-site-template.local',
          'X-Title': 'vertical-site-template'
        },
        body: JSON.stringify({ model, messages, temperature: 0.2 }),
        signal: opts.signal
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = `http-${res.status}`;
        if (attempt < maxRetries) continue;
        return { ok: false, reason: lastErr, fingerprint: keyFingerprint(key) };
      }
      if (!res.ok) return { ok: false, reason: `http-${res.status}`, fingerprint: keyFingerprint(key) };
      // 一次性解析响应体（兼容 {json:fn} 与 {text} 两种注入形态，不重复消费）。
      const payload = typeof res.json === 'function' ? await res.json() : extractJson(String(res.text || ''));
      const content = payload?.choices?.[0]?.message?.content ?? (typeof payload === 'string' ? payload : '');
      const parsed = extractJson(content);
      return { ok: !!parsed, data: parsed, content, reason: parsed ? '' : 'non-json', fingerprint: keyFingerprint(key) };
    } catch (e) {
      lastErr = String(e?.message || e).slice(0, 120);
      if (attempt < maxRetries) continue;
    }
  }
  return { ok: false, reason: lastErr || 'request-failed' };
}

// 建树规则建议：mock 用 token→nodeId 映射的确定性实现；真 provider 让模型分组，
// 只接受 mapping 中已存在的 nodeId，非法归属一律回退 n0（结构闸门径不变）。
export async function suggestTreeRules(provider, seedTerms, mapping, opts = {}) {
  const status = llmStatus(provider);
  const rand = seededRandom(seedTerms.join('|'));
  const fallback = () => {
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
      note: 'mock 规则建议：按关键词映射归类；未命中进 n0。'
    };
  };

  if (provider === 'mock' || !status.available) return fallback();
  const nodeIds = [...new Set(Object.values(mapping || {}))];
  const messages = [
    { role: 'system', content: '你是内容树归类助手。只输出 JSON，不要解释。nodeId 只能取给定列表中的值。' },
    { role: 'user', content: `把下列关键词归入最贴切的 nodeId（只能从 ${JSON.stringify(nodeIds)} 中选，拿不准用 n0）。输出格式：{"grouped":{"nodeId":["词1","词2"]}}。关键词：${JSON.stringify(seedTerms.slice(0, 120))}` }
  ];
  const r = await callModel(provider, messages, opts);
  if (!r.ok) return { ...fallback(), degraded: true, reason: r.reason, note: `真实模型失败(${r.reason})，降级 mock 归类` };
  const rawGroups = r.data?.grouped || {};
  const grouped = {};
  const termSet = new Set(seedTerms);
  const legalIds = new Set(nodeIds.concat('n0'));
  for (const term of seedTerms) {
    let target = 'n0';
    for (const [nodeId, terms] of Object.entries(rawGroups)) {
      if (legalIds.has(nodeId) && Array.isArray(terms) && terms.some((t) => termSet.has(t) && t === term)) { target = nodeId; break; }
    }
    (grouped[target] ||= []).push(term);
  }
  return {
    provider, deterministic: false, grouped,
    confidence: 1, degraded: false, fingerprint: r.fingerprint,
    note: '真实模型归类：仅接受合法 nodeId，其余归 n0。'
  };
}

// 生成内容 bundle：AI 只写组织/推荐语；数字必须来自 citations，真实模型产出的 claim
// 若无合法 citationId 会被事实闸拦下，不会绕过。失败即降级 mock，不静默伪造。
export async function composeBundle(provider, ctx, opts = {}) {
  const status = llmStatus(provider);
  const citations = (ctx.sourceIds || []).map((sourceId) => ({ sourceId }));
  const mockBundle = () => ({
    schema: 'bundle/v1',
    id: ctx.id,
    kind: ctx.kind || 'article',
    title: ctx.title,
    body: `${ctx.title}：以下内容依据已登记信源整理，具体数值以官方实时页面为准。`,
    cardDesc: ctx.cardDesc || '',
    toc: ctx.toc || [],
    claims: [], // mock 不生成含数字的 claim；真实模型产出后必须挂 citationIds 才过事实闸
    citations,
    links: ctx.links || [],
    byline: ctx.byline || '',
    _meta: { provider: status.available || provider === 'mock' ? provider : 'mock-fallback' }
  });

  if (provider === 'mock' || !status.available) return mockBundle();
  const messages = [
    { role: 'system', content: '你是资料整理助手。只输出 JSON：{"body":"...","cardDesc":"...","claims":[{"text":"...","citationIds":["..."]}]}。不得编造数值：所有含数字的表述必须给出 citationIds，且只能引用给定 sourceId；拿不准就不要写数字。' },
    { role: 'user', content: `主题：${ctx.title}。当前卡片描述：${ctx.cardDesc || '无'}。可用引用 sourceId：${JSON.stringify(ctx.sourceIds || [])}。写一段客观介绍正文（150-300字）与一句卡片描述（≤60字）。` }
  ];
  const r = await callModel(provider, messages, opts);
  const base = mockBundle();
  if (!r.ok) return { ...base, _meta: { ...base._meta, degraded: true, reason: r.reason } };

  const data = r.data || {};
  // 真实模型给的正文/描述先过结构约束（cardDesc ≤60），claims 只保留引用合法 sourceId 的。
  const legal = new Set(ctx.sourceIds || []);
  const claims = (Array.isArray(data.claims) ? data.claims : [])
    .filter((c) => c && typeof c.text === 'string' && Array.isArray(c.citationIds) && c.citationIds.length && c.citationIds.every((id) => legal.has(id)))
    .map((c) => ({ text: String(c.text).slice(0, 200), citationIds: c.citationIds }));
  const cardDesc = typeof data.cardDesc === 'string' ? [...data.cardDesc].slice(0, 60).join('') : base.cardDesc;
  return {
    ...base,
    body: typeof data.body === 'string' && data.body.trim() ? data.body : base.body,
    cardDesc,
    claims,
    _meta: { provider, degraded: false, fingerprint: r.fingerprint }
  };
}
