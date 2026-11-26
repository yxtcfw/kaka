// 信源发现/采集共享工具：搜索 provider（mock/tavily/ddgs）与正文判据。
// 边界（v7 附录 A）：搜索只发现候选 URL，候选默认 L3，不得自动升 L1/L2；正文抓不到降级进 reject。
import { readJson } from './validate.js';
import path from 'node:path';
import { seededRandom, urlKey, domainOf, sha256 } from './util.js';

const MOCK_SUFFIX = ['办理', '资费', '攻略', '对比', '怎么选', '注意事项', '2026', '官方', '价格', '避坑'];

// 搜索发现候选 URL。mock 确定性地按词生成，真 provider 走 env key（不落文件）。
export async function searchCandidates(terms, provider = 'mock', limit = 40) {
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
  // 真 provider：只从 env 读 key；无 key 时抛错让上层降级（不静默伪造正文）。
  const key = process.env.TAVILY_API_KEY || process.env.EXA_API_KEY || '';
  if (!key) throw new Error(`provider ${provider} 缺少 env key，已降级不采集`);
  throw new Error(`provider ${provider} 的真实网络适配需按 Secrets 注入后启用（本模板默认 mock）`);
}

// 抓正文判据。mock 返回合规长度的摘要；真 provider 由 trafilatura/Tavily 直返正文。
export async function fetchBody(candidate, provider = 'mock') {
  if (provider === 'mock') {
    const body = `${candidate.title}：${candidate.snippet || ''} 本页整理 ${candidate.url} 的关键信息，供信源审核留档。`.repeat(8);
    return { url: candidate.url, body, chars: body.length, kind: 'fulltext', provider };
  }
  throw new Error(`fetchBody provider ${provider} 未启用（默认 mock）`);
}

// 依据 source-grade 规则定级：搜索候选默认 L3；L1 只认白名单；正文 <minBodyChars 降级。
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
