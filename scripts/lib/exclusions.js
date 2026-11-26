// 示例/占位域名排除规则：全产线共用（discover / fetch-body / build-nav-pages / write-content）。
// 规则来源 config/article-rules.json（进 git 可审计）；文件缺失时退化为「不排除」，兼容旧仓库。
import path from 'node:path';
import { readJson, ROOT } from './validate.js';
import { domainOf } from './util.js';

export function loadExclusions(root = ROOT) {
  let rules = {};
  try { rules = readJson(path.join(root, 'config/article-rules.json')); } catch { /* 旧仓库无规则文件 */ }
  const bannedDomains = new Set(
    (Array.isArray(rules.bannedDomains) ? rules.bannedDomains : [])
      .map((d) => String(d).toLowerCase().replace(/^www\./, ''))
      .filter(Boolean)
  );
  const skipNodeIds = new Set(
    (Array.isArray(rules.skipNodeIds) ? rules.skipNodeIds : []).map(String)
  );
  return { bannedDomains, skipNodeIds };
}

// raw 可为完整 URL、裸域名或 nav 的 outbound；主域或子域命中都算禁用。
export function isBannedDomain(raw, bannedDomains) {
  const fromUrl = domainOf(String(raw || ''));
  const domain = (fromUrl || String(raw || '')).toLowerCase().replace(/^www\./, '');
  if (!domain || !bannedDomains || bannedDomains.size === 0) return false;
  for (const b of bannedDomains) {
    if (domain === b || domain.endsWith('.' + b)) return true;
  }
  return false;
}

// 只过滤本次新候选；不动存量 sources/navlinks（人工数据始终人工掌控）。
export function filterBannedCandidates(candidates, bannedDomains) {
  const kept = [];
  const dropped = [];
  for (const c of candidates || []) {
    if (isBannedDomain(c.url || c.domain || c.outbound, bannedDomains)) dropped.push(c);
    else kept.push(c);
  }
  return { kept, dropped };
}
