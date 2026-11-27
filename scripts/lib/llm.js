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
// OpenRouter 官方 Free Models Router：只在免费模型池里自动选择/降级，
// 不自建 :free 列表、不配置付费 fallbacks，避免任何意外计费。
// 响应体 model 字段会返回实际命中的模型，报告里留痕供云端核对。
const DEFAULT_MODEL = {
  openrouter: 'openrouter/free',
  deepseek: 'deepseek-chat',
  dashscope: 'qwen-plus'
};

// 统一解析模型：显式 opts.model > provider 专属 env > 默认（免费路由）。
export function resolveModel(provider, opts = {}) {
  return opts.model || process.env[`${provider.toUpperCase()}_MODEL`] || DEFAULT_MODEL[provider];
}

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
  const model = resolveModel(provider, opts);
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
      // 免费路由会在响应里回传实际命中的模型；没有则回退到请求模型名。
      const actualModel = typeof payload?.model === 'string' && payload.model.trim() ? payload.model.trim() : model;
      return {
        ok: !!parsed, data: parsed, content, reason: parsed ? '' : 'non-json',
        fingerprint: keyFingerprint(key), model: actualModel, requestedModel: model
      };
    } catch (e) {
      lastErr = String(e?.message || e).slice(0, 120);
      if (attempt < maxRetries) continue;
    }
  }
  return { ok: false, reason: lastErr || 'request-failed' };
}

// 建树规则建议：mock 用 token→nodeId 映射的确定性实现；真 provider 让模型分组，
// 只接受 mapping 中已存在的 nodeId，非法归属一律回退 n0（结构闸门径不变）。
function normalizeNewNodes(rawNodes, seedTerms, parents, maxNewNodes) {
  const termSet = new Set(seedTerms);
  const parentSet = new Set(parents);
  const seen = new Set();
  const out = [];
  for (const n of Array.isArray(rawNodes) ? rawNodes : []) {
    if (!n || typeof n.label !== 'string') continue;
    const label = n.label.trim();
    if ([...label].length < 2 || [...label].length > 20 || seen.has(label)) continue;
    const parent = String(n.parent || 'n0');
    if (!parentSet.has(parent)) continue;
    const topic = typeof n.topic === 'string' && n.topic.trim() ? n.topic.trim().slice(0, 60) : `${label}相关内容`;
    const keywords = [...new Set((Array.isArray(n.keywords) ? n.keywords : []).filter((k) => termSet.has(k)).map(String))].slice(0, 12);
    if (!keywords.length) continue;
    seen.add(label);
    out.push({ parent, label, topic, keywords });
    if (out.length >= maxNewNodes) break;
  }
  return out;
}

function deterministicNewNodes(unmapped, opts) {
  const patterns = opts.autoNodePatterns || {};
  const min = Number(opts.minTermsPerNode || 8);
  const max = Number(opts.maxNewNodes || 3);
  const out = [];
  for (const [label, pattern] of Object.entries(patterns)) {
    let re;
    try { re = new RegExp(pattern); } catch { continue; }
    const keywords = unmapped.filter((t) => re.test(t)).slice(0, 12);
    if (keywords.length < min) continue;
    out.push({ parent: 'n0', label, topic: `${label}（自动归类）`, keywords });
    if (out.length >= max) break;
  }
  return out;
}

function applyNewNodesToGroups(grouped, newNodes) {
  const assigned = new Set(newNodes.flatMap((n) => n.keywords));
  for (const id of Object.keys(grouped)) {
    grouped[id] = (grouped[id] || []).filter((t) => !assigned.has(t));
  }
  return grouped;
}

export async function suggestTreeRules(provider, seedTerms, mapping, opts = {}) {
  const status = llmStatus(provider);
  const rand = seededRandom(seedTerms.join('|'));
  const maxNewNodes = Number(opts.maxNewNodes || 3);
  const parents = opts.parentIds || ['n0'];
  const fallback = () => {
    const grouped = {};
    for (const term of seedTerms) {
      let target = 'n0';
      for (const [pattern, nodeId] of Object.entries(mapping || {})) {
        if (new RegExp(pattern).test(term)) { target = nodeId; break; }
      }
      (grouped[target] ||= []).push(term);
    }
    const newNodes = deterministicNewNodes(grouped.n0 || [], opts);
    applyNewNodesToGroups(grouped, newNodes);
    return {
      provider: status.available || provider === 'mock' ? provider : 'mock-fallback',
      deterministic: provider === 'mock',
      degraded: false,
      model: '', requestedModel: resolveModel(provider, opts),
      grouped, newNodes,
      confidence: Number((0.7 + rand() * 0.2).toFixed(3)),
      note: 'mock 规则建议：按映射归类，未命中词按规则提出新节点。'
    };
  };

  if (provider === 'mock' || !status.available) return fallback();
  const nodeIds = [...new Set(Object.values(mapping || {}))];
  const messages = [
    { role: 'system', content: '你是内容树归类助手。只输出 JSON，不要解释。grouped 的 nodeId 只能取给定列表中的值；newNodes 用于现有节点都不贴切时提出新节点。' },
    { role: 'user', content: `把下列关键词归入最贴切的 nodeId（只能从 ${JSON.stringify(nodeIds)} 中选，拿不准用 n0）。现有节点：${JSON.stringify((opts.nodeSummary || []).slice(0, 30))}。可挂载的 parent：${JSON.stringify(parents)}。最多提出 ${maxNewNodes} 个新节点，每个新节点的 keywords 必须来自给定关键词。输出格式：{"grouped":{"nodeId":["词1"]},"newNodes":[{"parent":"n0","label":"≤20字","topic":"≤60字","keywords":["词1"]}]}。关键词：${JSON.stringify(seedTerms.slice(0, 120))}` }
  ];
  const r = await callModel(provider, messages, opts);
  if (!r.ok) return { ...fallback(), degraded: true, reason: r.reason, note: `真实模型失败(${r.reason})，降级规则归类` };
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
  const newNodes = normalizeNewNodes(r.data?.newNodes, seedTerms, parents, maxNewNodes);
  applyNewNodesToGroups(grouped, newNodes);
  return {
    provider, deterministic: false, grouped, newNodes,
    confidence: 1, degraded: false, fingerprint: r.fingerprint,
    model: r.model || '', requestedModel: r.requestedModel || '',
    note: '真实模型归类：仅接受合法 nodeId，其余归 n0；新节点须合法 parent 与词表内关键词。'
  };
}

// 生成内容 bundle：AI 只写组织/推荐语；数字必须来自 citations，真实模型产出的 claim
// 若无合法 citationId 会被事实闸拦下，不会绕过。失败即降级 mock，不静默伪造。
export async function composeBundle(provider, ctx, opts = {}) {
  const status = llmStatus(provider);
  const citations = (ctx.sourceIds || []).map((sourceId) => ({ sourceId }));
  // 官方详情摘录：模型只能据此客观组织，不得引入资料外数值。
  const sourceDigest = String(ctx.sourceDigest || '').slice(0, 2000);
  const mockText = `${ctx.title}：以下内容依据已登记信源整理，具体数值以官方实时页面为准。`;
  const mockBundle = () => ({
    schema: 'bundle/v1',
    id: ctx.id,
    kind: ctx.kind || 'article',
    title: ctx.title,
    body: mockText,
    intro: [{ title: '', text: mockText }], // 结构化段落：mock 不写数字，也不伪造小标题
    cardDesc: ctx.cardDesc || '',
    toc: ctx.toc || [],
    claims: [], // mock 不生成含数字的 claim；真实模型产出后必须挂 citationIds 才过事实闸
    citations,
    links: ctx.links || [],
    byline: ctx.byline || '',
    _meta: { provider: status.available || provider === 'mock' ? provider : 'mock-fallback', model: '', requestedModel: resolveModel(provider, opts) }
  });

  if (provider === 'mock' || !status.available) return mockBundle();
  const messages = [
    { role: 'system', content: '你是资料整理助手。只输出 JSON：{"intro":[{"title":"...","text":"..."}],"cardDesc":"...","claims":[{"text":"...","citationIds":["..."]}]}。intro 为 2-4 个结构化段落，title 是小标题（如「套餐包含什么」「怎么办理」「谁能办理」，可为空串），text 是正文；不得编造数值：所有含数字的表述必须给出 citationIds，且只能引用给定 sourceId；拿不准就不要写数字。' },
    { role: 'user', content: `主题：${ctx.title}。当前卡片描述：${ctx.cardDesc || '无'}。可用引用 sourceId：${JSON.stringify(ctx.sourceIds || [])}。官方资料摘录（只能据此写，不得引入资料外数值）：\n${sourceDigest || '无'}。写 2-4 个结构化介绍段落（每段含 title 与 text，合计 150-300 字）与一句卡片描述（≤60字）；正文中的数字必须在 claims 中挂 citationIds。` }
  ];
  const r = await callModel(provider, messages, opts);
  const base = mockBundle();
  if (!r.ok) return { ...base, _meta: { ...base._meta, degraded: true, reason: r.reason, model: r.model || '' } };

  const data = r.data || {};
  // 真实模型给的正文/描述先过结构约束（cardDesc ≤60），claims 只保留引用合法 sourceId 的。
  const legal = new Set(ctx.sourceIds || []);
  const claims = (Array.isArray(data.claims) ? data.claims : [])
    .filter((c) => c && typeof c.text === 'string' && Array.isArray(c.citationIds) && c.citationIds.length && c.citationIds.every((id) => legal.has(id)))
    .map((c) => ({ text: String(c.text).slice(0, 200), citationIds: c.citationIds }));
  const cardDesc = typeof data.cardDesc === 'string' ? [...data.cardDesc].slice(0, 60).join('') : base.cardDesc;
  // 结构化段落：最多 4 段，每段 title ≤20 / text ≤500；模型不给则退回 mock 段落，body 同步拼接。
  const intro = (Array.isArray(data.intro) ? data.intro : [])
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .slice(0, 4)
    .map((s) => ({
      title: typeof s.title === 'string' ? [...s.title].slice(0, 20).join('') : '',
      text: [...s.text].slice(0, 500).join('')
    }));
  const introText = intro.map((s) => s.text).join('\n');
  return {
    ...base,
    body: introText || (typeof data.body === 'string' && data.body.trim() ? data.body : base.body),
    intro: intro.length ? intro : base.intro,
    cardDesc,
    claims,
    _meta: { provider, degraded: false, fingerprint: r.fingerprint, model: r.model || '', requestedModel: r.requestedModel || '' }
  };
}
