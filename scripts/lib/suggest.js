// 联想词适配器：baidu-suggest（无 key，UTF-8 JSONP），全部经 fetch-guard 限速。
// 红线：真实 provider 失败必须显式抛错，由 harvest 降级 mock 并写 reason，不静默伪造。
import path from 'node:path';
import { readJson, ROOT } from './validate.js';
import { createFetchGuard } from './fetch-guard.js';

const ENDPOINT = 'https://suggestion.baidu.com/su';
const SUGGEST_POLICY = 'rules/suggest-policy.json';

// 百度返回的是 JSONP 且键无引号：cb({q:"...",p:false,s:["词1","词2"]});
// 只解析 s:[...] 字符串数组，用带引号/转义感知的扫描，避免把词里的 "]" 截断。
export function parseSuggestArray(text, key = 's') {
  const raw = String(text || '');
  const match = new RegExp(`\\b${key}\\s*:\\s*\\[`).exec(raw);
  if (!match) throw new Error('suggest 响应缺少 s 数组');
  let i = match.index + match[0].length;
  let quoted = false;
  let escaped = false;
  let depth = 1;
  const start = i;
  for (; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quoted) { escaped = true; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0 || quoted) throw new Error('suggest 响应 s 数组不完整');
  const arr = JSON.parse(`[${raw.slice(start, i)}]`);
  if (!Array.isArray(arr)) throw new Error('suggest 响应 s 不是数组');
  return arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
}

export function buildQueries(seeds, maxQueries = 36) {
  const prefix = ['', '移动', '联通', '电信', '低价', '大流量'];
  const suffix = ['办理', '资费', '攻略', '怎么选', '价格'];
  const out = [];
  const seen = new Set();
  for (const s of suffix) {
    for (const p of prefix) {
      for (const seed of seeds || []) {
        const q = `${p}${seed}${s}`.trim();
        if (q.length < 3 || q.length > 20 || seen.has(q)) continue;
        seen.add(q);
        out.push(q);
        if (out.length >= maxQueries) return out;
      }
    }
  }
  return out;
}

export async function baiduSuggest(queries, opts = {}) {
  const guard = opts.guard || createFetchGuard(
    readJson(path.join(opts.root || ROOT, SUGGEST_POLICY)),
    {
      fetchFn: opts.fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null),
      robotsTxt: opts.robotsTxt
    }
  );
  const out = [];
  const failures = [];
  for (const q of queries.slice(0, Number(opts.maxQueries || queries.length))) {
    const url = `${ENDPOINT}?wd=${encodeURIComponent(q)}&cb=vstcb&ie=utf-8`;
    try {
      const res = await guard.request(url, { headers: { Accept: 'application/javascript' } });
      for (const term of parseSuggestArray(res.text)) {
        out.push({ term, source: 'baidu-suggest', query: q, collectedAt: new Date().toISOString().slice(0, 10) });
      }
    } catch (e) {
      // 单条查询超时/失败不拖垮整轮：留痕后继续下一条；全部失败才抛错让 harvest 降级。
      failures.push({ query: q, reason: String(e?.message || e).slice(0, 160) });
    }
  }
  if (!out.length && failures.length) throw new Error(`baidu-suggest 全部查询失败：${failures[0].reason}`);
  const stats = guard.getStats ? guard.getStats() : { enabled: true };
  return { items: out, guard: { ...stats, failures: failures.slice(0, 5) } };
}

// provider 分派：mock 由 harvest 自己的确定性实现负责；未知 provider 直接抛错。
export async function collectSuggest(provider, seeds, opts = {}) {
  if (provider === 'baidu-suggest') {
    const queries = opts.queries || buildQueries(seeds, Number(opts.maxQueries || 36));
    return baiduSuggest(queries, opts);
  }
  throw new Error(`suggest provider ${provider} 未启用`);
}
