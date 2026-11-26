// 信源发现/采集共享工具：搜索 provider（mock/tavily/exa）与正文判据。
// 边界（v7 附录 A）：搜索只发现候选 URL，候选默认 L3，不得自动升 L1/L2；正文抓不到降级进 reject。
// 防风控：所有真实 provider 必须经 fetch-guard 发请求；mock 分支零网络，不受 guard 影响。
import { readJson, ROOT } from './validate.js';
import path from 'node:path';
import { seededRandom, urlKey, domainOf } from './util.js';
import { createFetchGuard, DEFAULT_POLICY } from './fetch-guard.js';

const MOCK_SUFFIX = ['办理', '资费', '攻略', '对比', '怎么选', '注意事项', '2026', '官方', '价格', '避坑'];

export function loadCollectPolicy(root = ROOT) {
  try { return readJson(path.join(root, 'rules/collect-policy.json')); }
  catch { return DEFAULT_POLICY; }
}

export function createProviderGuard(root = ROOT, deps = {}) {
  return createFetchGuard(loadCollectPolicy(root), deps);
}

// 优先复用调用方注入的 guard（共享限速/并发状态），否则按策略新建一个。
function guardFor(opts) {
  if (opts.guard) return opts.guard;
  const fetchFn = typeof opts.fetchFn === 'function'
    ? opts.fetchFn
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  return createProviderGuard(opts.root || ROOT, {
    fetchFn,
    sleepFn: opts.sleepFn,
    nowFn: opts.nowFn,
    randomFn: opts.randomFn,
    robotsTxt: opts.robotsTxt,
    robotsFor: opts.robotsFor
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

// ---- 真 provider 适配器：全部经 guard.request，key 只读 env，不落文件 ----
async function tavilySearch(terms, guard, limit) {
  const key = process.env.TAVILY_API_KEY || '';
  if (!key) throw new Error('TAVILY_API_KEY 缺失，已降级不采集');
  const out = [];
  for (const term of terms.slice(0, limit)) {
    const res = await guard.request('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query: term, search_depth: 'basic', max_results: 5, include_raw_content: false })
    });
    const data = parseJson(res.text);
    for (const r of data.results || []) {
      if (!r.url) continue;
      out.push({ url: r.url, title: r.title || r.url, snippet: r.content || '', provider: 'tavily', query: term });
    }
  }
  return out;
}

async function exaSearch(terms, guard, limit) {
  const key = process.env.EXA_API_KEY || '';
  if (!key) throw new Error('EXA_API_KEY 缺失，已降级不采集');
  const out = [];
  for (const term of terms.slice(0, limit)) {
    const res = await guard.request('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ query: term, numResults: 5, contents: { text: true } })
    });
    const data = parseJson(res.text);
    for (const r of data.results || []) {
      if (!r.url) continue;
      out.push({ url: r.url, title: r.title || r.url, snippet: r.text || r.summary || '', provider: 'exa', query: term });
    }
  }
  return out;
}

async function tavilyRawBody(candidate, guard) {
  const key = process.env.TAVILY_API_KEY || '';
  if (!key) throw new Error('TAVILY_API_KEY 缺失，已降级不采集');
  const query = `${domainOf(candidate.url)} ${candidate.title || ''}`.trim() || candidate.url;
  const res = await guard.request('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, search_depth: 'advanced', max_results: 1, include_raw_content: true })
  });
  const data = parseJson(res.text);
  const hit = (data.results || [])[0] || {};
  const body = String(hit.raw_content || hit.text || '');
  return { url: candidate.url, body, chars: body.length, kind: body.length >= 300 ? 'fulltext' : 'excerpt', provider: 'tavily' };
}

async function exaRawBody(candidate, guard) {
  const key = process.env.EXA_API_KEY || '';
  if (!key) throw new Error('EXA_API_KEY 缺失，已降级不采集');
  const query = `${domainOf(candidate.url)} ${candidate.title || ''}`.trim() || candidate.url;
  const res = await guard.request('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ query, numResults: 1, contents: { text: true } })
  });
  const data = parseJson(res.text);
  const hit = (data.results || [])[0] || {};
  const body = String(hit.text || hit.summary || '');
  return { url: candidate.url, body, chars: body.length, kind: body.length >= 300 ? 'fulltext' : 'excerpt', provider: 'exa' };
}

// 抓候选 URL 自身的正文（非 SERP，符合红线）。极简去标签兜底；真精度建议外部 trafilatura 提取后注入。
async function rawFetchBody(candidate, guard) {
  const res = await guard.request(candidate.url);
  const body = String(res.text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { url: candidate.url, body, chars: body.length, kind: body.length >= 300 ? 'fulltext' : 'excerpt', provider: 'raw' };
}

// ---- 对外接口 ----
export async function searchCandidates(terms, provider = 'mock', limit = 40, opts = {}) {
  if (provider === 'mock') {
    const rand = seededRandom(terms.join('|'));
    const out = [];
    for (const term of terms.slice(0, limit)) {
      const host = rand() > 0.5 ? 'example.org' : 'example.net';
      out.push({
        url: `https://${host}/a/${encodeURIComponent(term)}`,
        title: `${term} - 资料页`,
        snippet: `${term} 的相关介绍与要点整理（模拟搜索结果，仅用于发现候选 URL）。`,
        provider
      });
    }
    return out;
  }
  const guard = guardFor(opts);
  if (provider === 'tavily') return tavilySearch(terms, guard, limit);
  if (provider === 'exa') return exaSearch(terms, guard, limit);
  if (provider === 'ddgs' || provider === 'zhihu') {
    throw new Error(`provider ${provider} 需注入 opts.adapterFn（内部须经 guard.request）；Node 零依赖不自爬 SERP`);
  }
  throw new Error(`provider ${provider} 未启用（真实请求必须经 fetch-guard）`);
}

export async function fetchBody(candidate, provider = 'mock', opts = {}) {
  if (provider === 'mock') {
    const body = `${candidate.title}：${candidate.snippet || ''} 本页整理 ${candidate.url} 的关键信息，供信源审核留档。`.repeat(8);
    return { url: candidate.url, body, chars: body.length, kind: 'fulltext', provider };
  }
  const guard = guardFor(opts);
  if (provider === 'tavily') return tavilyRawBody(candidate, guard);
  if (provider === 'exa') return exaRawBody(candidate, guard);
  if (provider === 'raw' || provider === 'ddgs' || provider === 'zhihu') return rawFetchBody(candidate, guard);
  throw new Error(`fetchBody provider ${provider} 未启用（真实请求必须经 fetch-guard）`);
}

export function gradeCandidate(candidate, body, rules) {
  const domain = domainOf(candidate.url);
  const l1 = (rules.l1Whitelist || []).some((d) => domain === d || domain.endsWith('.' + d));
  const min = rules.minBodyChars ?? 300;
  let grade = rules.searchCandidateDefault || 'L3';
  if (rules.noAutoUpgrade !== false) {
    grade = 'L3'; // 搜索发现一律 L3，不自动升级
  } else if (l1 && body && body.length >= min) {
    grade = 'L1';
  }
  const bodyKind = body && body.length >= min ? 'fulltext' : body ? 'excerpt' : 'none';
  const status = body && body.length >= min ? 'approved' : 'candidate';
  return { domain, grade, bodyKind, status, bodyOk: !!(body && body.length >= min), min };
}

export function dedupeCandidates(candidates, existing) {
  const seen = new Set(existing.map((s) => urlKey(s.url)));
  const out = [];
  for (const c of candidates) {
    const k = urlKey(c.url);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

export function nextSourceId(sources) {
  let max = 0;
  for (const s of sources) {
    const m = /^src-(\d+)$/.exec(s.sourceId || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `src-${String(max + 1).padStart(3, '0')}`;
}
