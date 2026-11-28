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

// 标题候选打分：含关键词、长度、疑问句/反差句加分；站内重复或模板句扣分。
// 规则来自 config/article-prompts.json，程序自动选定最高分，候选一并保留供人工替换。
export function pickTitle(candidates, ctx = {}, rules = {}) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .filter((x) => typeof x === 'string' && x.trim()).slice(0, 5).map((x) => x.trim().slice(0, 60));
  if (!list.length) return { candidates: [], chosen: '' };
  const min = Number(rules.minChars || 15), max = Number(rules.maxChars || 22);
  const compile = (arr) => (arr || []).map((p) => { try { return new RegExp(p); } catch { return null; } }).filter(Boolean);
  const bonus = compile(rules.bonusPatterns), penalty = compile(rules.penaltyPatterns);
  const kws = (ctx.keywords || []).map(String).filter((k) => k.length >= 2);
  const existing = new Set((ctx.existingTitles || []).map(String));
  const scored = list.map((title) => {
    let score = 0;
    const len = [...title].length;
    if (len < min || len > max) score -= 3;
    if (rules.requireKeyword !== false && kws.some((k) => title.includes(k))) score += 2;
    if (bonus.some((re) => re.test(title))) score += 2;
    if (penalty.some((re) => re.test(title))) score -= 2;
    if (existing.has(title)) score -= 5;
    return { title, score };
  }).sort((a, b) => b.score - a.score);
  const chosen = scored[0].score >= Number(rules.minScore ?? 0) ? scored[0].title : '';
  return { candidates: scored, chosen };
}

// 生成内容 bundle：AI 只写组织/推荐语；数字必须来自 citations，真实模型产出的 claim
// 若无合法 citationId 会被事实闸拦下，不会绕过。失败即降级 mock，不静默伪造。
export async function composeBundle(provider, ctx, opts = {}) {
  const status = llmStatus(provider);
  const citations = (ctx.sourceIds || []).map((sourceId) => ({ sourceId }));
  // 官方详情摘录：模型只能据此客观组织，不得引入资料外数值。
  // 长度与提示词模板均由配置层注入（config/article-prompts.json），缺省保持旧值。
  const promptCfg = opts.prompts || {};
  const digestChars = Number(promptCfg.sourceDigestChars || 2000);
  const sourceDigest = String(ctx.sourceDigest || '').slice(0, digestChars);
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
  // 提示词模板来自配置层；占位符固定 {title}/{cardDesc}/{sourceIds}/{sourceDigest}，做字面替换不引入模板引擎。
  const tplVars = {
    title: String(ctx.title || ''),
    cardDesc: String(ctx.cardDesc || '无'),
    sourceIds: JSON.stringify(ctx.sourceIds || []),
    sourceDigest: sourceDigest || '无',
    brief: JSON.stringify(ctx.brief || {}),
    facts: String(ctx.facts || '无'),
    reviewNotes: String(ctx.reviewNotes || '无')
  };
  const fill = (s) => String(s).replace(/\{(title|cardDesc|sourceIds|sourceDigest|brief|facts|reviewNotes)\}/g, (m, k) => tplVars[k] ?? m);
  const systemPrompt = promptCfg.system
    ? fill(promptCfg.system)
    : '你是资料整理助手。只输出 JSON：{"intro":[{"title":"...","text":"..."}],"cardDesc":"...","claims":[{"text":"...","citationIds":["..."]}]}。intro 为 2-4 个结构化段落，title 是小标题（如「套餐包含什么」「怎么办理」「谁能办理」，可为空串），text 是正文；不得编造数值：所有含数字的表述必须给出 citationIds，且只能引用给定 sourceId；拿不准就不要写数字。不得输出「本卡片主题为」等模板占位句，不得提及银行、持卡人协议等与流量卡无关的领域。';
  const userDefault = `主题：${ctx.title}。当前卡片描述：${ctx.cardDesc || '无'}。可用引用 sourceId：${JSON.stringify(ctx.sourceIds || [])}。官方资料摘录（只能据此写，不得引入资料外数值）：\n${sourceDigest || '无'}。写 2-4 个结构化介绍段落（每段含 title 与 text，合计 150-300 字）与一句卡片描述（≤60字）；正文中的数字必须在 claims 中挂 citationIds。`;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: promptCfg.user ? fill(promptCfg.user) : userDefault }
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
  const maxParagraphs = Number(promptCfg.paragraphs || 4);
  const intro = (Array.isArray(data.intro) ? data.intro : [])
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .slice(0, maxParagraphs)
    .map((s) => ({
      title: typeof s.title === 'string' ? [...s.title].slice(0, 20).join('') : '',
      text: [...s.text].slice(0, 500).join('')
    }));
  // 空行分段：渲染层按空行切 <p>，单换行会被合并成一大段（旧版结构病的成因之一）。
  const introText = intro.map((s) => s.text).join('\n\n');
  const titlePick = pickTitle(data.titleCandidates, {
    keywords: ctx.keywords || [], existingTitles: ctx.existingTitles || []
  }, promptCfg.titleRules || {});
  return {
    ...base,
    title: titlePick.chosen || base.title,
    body: introText || (typeof data.body === 'string' && data.body.trim() ? data.body : base.body),
    intro: intro.length ? intro : base.intro,
    cardDesc,
    claims,
    titleCandidates: titlePick.candidates,
    _meta: {
      provider, degraded: false, fingerprint: r.fingerprint,
      model: r.model || '', requestedModel: r.requestedModel || '',
      promptVersion: String(promptCfg.promptVersion || ''),
      snapshotIds: ctx.snapshotIds || [],
      paragraphCount: intro.length
    }
  };
}

// ---- 命题卡：树给问题，不写数字。生成后落盘复用，保证后续渲染确定性。 ----
const BRIEF_FIELDS = ['reader_situation', 'core_question', 'one_sentence_answer', 'scope_boundary', 'parent_title'];

export function deterministicBrief(ctx = {}, cfg = {}) {
  const label = String(ctx.label || ctx.node?.label || '');
  const topic = String(ctx.topic || ctx.node?.topic || label);
  const keywords = (Array.isArray(ctx.keywords) ? ctx.keywords : ctx.node?.keywords || []).map(String);
  const parentTitle = String(ctx.parentTitle || '');
  const key = keywords.slice(0, 4).join('、') || topic;
  const max = Number(cfg.maxFieldChars || 160);
  const cut = (s) => [...String(s)].slice(0, max).join('');
  return {
    reader_situation: cut(`想办「${label || topic}」的人，手上有几个入口却不确定哪一个适合自己`),
    core_question: cut(`「${topic}」到底值不值得办，办之前要先核对什么？`),
    one_sentence_answer: cut(`先核对${key}中与自己地区、年龄和预算相关的限制，再决定是否办理`),
    scope_boundary: cut(`只谈${parentTitle || label || topic}范围内有信源支撑的要点，不展开无资料的横向对比`),
    must_cover: ['办理条件与首充', '流量构成与到期资费', '禁发地区与年龄限制', '套外资费与止损办法'],
    must_avoid: ['编造办理成功率', '虚构用户评价', '无信源支撑的跨运营商对比'],
    intent: 'problem',
    parent_title: cut(parentTitle || label || topic)
  };
}

// 命题卡禁止出现资费数字（那是 Fact Sheet 的职责）；命中即丢弃该字段回退确定性值。
function hasFeeDigits(s) {
  return /\d+\s*(元|G|GB|个月|周岁|分钟|条)/i.test(String(s));
}

export async function composeBrief(provider, ctx = {}, opts = {}) {
  const status = llmStatus(provider);
  const cfg = opts.prompts || {};
  const fallback = deterministicBrief(ctx, cfg);
  const meta = (extra = {}) => ({
    provider: provider === 'mock' || !status.available ? 'mock-fallback' : provider,
    model: '', deterministic: true, degraded: false,
    promptVersion: String(cfg.promptVersion || ''), ...extra
  });
  if (provider === 'mock' || !status.available) return { brief: fallback, meta: meta() };

  const tplVars = {
    title: String(ctx.topic || ctx.node?.topic || ctx.label || ''),
    keywords: JSON.stringify(Array.isArray(ctx.keywords) ? ctx.keywords : ctx.node?.keywords || []),
    parentTitle: String(ctx.parentTitle || ''),
    sourceTitles: JSON.stringify((ctx.sourceTitles || []).slice(0, 6).map(String))
  };
  const fill = (s) => String(s).replace(/\{(title|keywords|parentTitle|sourceTitles)\}/g, (m, k) => tplVars[k] ?? m);
  const system = cfg.system ? fill(cfg.system) : '你是内容策划助手。只输出命题卡 JSON，不写资费数字。';
  const userDefault = '节点标题：{title}。关键词：{keywords}。可用信源标题：{sourceTitles}。输出命题卡 JSON。';
  const r = await callModel(provider, [
    { role: 'system', content: system },
    { role: 'user', content: cfg.user ? fill(cfg.user) : fill(userDefault) }
  ], opts);
  if (!r.ok) return { brief: fallback, meta: meta({ degraded: true, reason: r.reason, model: r.model || '' }) };

  const d = r.data || {};
  const brief = { ...fallback };
  const max = Number(cfg.maxFieldChars || 160);
  const cut = (s) => [...String(s).trim()].slice(0, max).join('');
  for (const k of BRIEF_FIELDS) {
    if (typeof d[k] === 'string' && d[k].trim() && !hasFeeDigits(d[k])) brief[k] = cut(d[k]);
  }
  const maxList = Number(cfg.maxListItems || 6);
  for (const k of ['must_cover', 'must_avoid']) {
    if (Array.isArray(d[k]) && d[k].length) {
      const list = d[k].filter((x) => typeof x === 'string' && x.trim() && !hasFeeDigits(x)).slice(0, maxList).map(cut);
      if (list.length) brief[k] = list;
    }
  }
  if (d.intent === 'problem' || d.intent === 'guide') brief.intent = d.intent;
  return {
    brief,
    meta: { provider, model: r.model || '', fingerprint: r.fingerprint, deterministic: false, degraded: false, promptVersion: String(cfg.promptVersion || '') }
  };
}
