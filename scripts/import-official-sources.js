// 官网信源导入：只读 config/official-sources.json，按 URL 归一化键 upsert 到 data/sources.json。
// 不含任何行业字段；换主题只需替换配置文件。写盘走快照 + 原子写，支持 dry-run。
import path from 'node:path';
import fs from 'node:fs';
import { readJson, ROOT } from './lib/validate.js';
import { atomicWriteJson, domainOf, snapshot, urlKey } from './lib/util.js';
import { nextSourceId } from './lib/sources.js';

const CONFIG_REL = 'config/official-sources.json';
const SOURCES_REL = 'data/sources.json';
const REPORT_REL = 'reports/official-sources.json';

export function planImport(root, cfg, doc) {
  const existing = Array.isArray(doc.sources) ? doc.sources : [];
  const next = JSON.parse(JSON.stringify(existing));
  const byKey = new Map(next.map((s) => [urlKey(s.url), s]));
  const actions = [];
  let cursor = null;

  for (const entry of cfg.sources || []) {
    if (!entry || !entry.url) continue;
    const key = urlKey(entry.url);
    const hit = byKey.get(key);
    if (hit) {
      const before = {};
      for (const [k, v] of Object.entries(entry)) {
        if (k === 'url') continue;
        if (JSON.stringify(hit[k]) !== JSON.stringify(v)) before[k] = hit[k];
      }
      if (Object.keys(before).length) {
        Object.assign(hit, entry);
        if (entry.bodyExcerpt !== undefined) hit.bodyChars = String(entry.bodyExcerpt).length;
        actions.push({ action: 'patch', sourceId: hit.sourceId, url: entry.url, before });
      }
      continue;
    }
    if (cursor === null) {
      const m = /^src-(\d+)$/.exec(nextSourceId(existing));
      cursor = m ? Number(m[1]) : 1;
    }
    const record = {
      sourceId: `src-${String(cursor++).padStart(3, '0')}`,
      url: entry.url,
      domain: domainOf(entry.url),
      title: entry.title || entry.url,
      grade: entry.grade || 'L3',
      status: entry.status || 'candidate',
      bodyKind: entry.bodyKind || 'none',
      bodyExcerpt: entry.bodyExcerpt || '',
      discoveredBy: 'manual',
      collectedFrom: entry.collectedFrom || 'official-site',
      fetchedAt: cfg.collectedAt || new Date().toISOString().slice(0, 10),
      bodyChars: String(entry.bodyExcerpt || '').length
    };
    next.push(record);
    byKey.set(key, record);
    actions.push({ action: 'add', sourceId: record.sourceId, url: entry.url, grade: record.grade });
  }
  return { actions, doc: { ...doc, sources: next } };
}

export function runOfficialSourcesImport(root = ROOT, args = {}) {
  const cfgPath = path.join(root, CONFIG_REL);
  const sourcesPath = path.join(root, SOURCES_REL);
  if (!fs.existsSync(cfgPath)) return { stage: 'official-sources', skipped: true, reason: 'config-missing' };
  const cfg = readJson(cfgPath);
  if (cfg.enabled === false) return { stage: 'official-sources', skipped: true, reason: 'disabled' };

  const beforeDoc = readJson(sourcesPath);
  const { actions, doc } = planImport(root, cfg, beforeDoc);
  const l1 = doc.sources.filter((s) => s.grade === 'L1' && s.status === 'approved').length;
  const report = {
    stage: 'official-sources',
    dryRun: !!args.dryRun,
    actions,
    added: actions.filter((a) => a.action === 'add').length,
    patched: actions.filter((a) => a.action === 'patch').length,
    totals: { sources: doc.sources.length, l1Approved: l1 }
  };

  if (!args.dryRun && actions.length) {
    report.snapshot = snapshot(sourcesPath, path.join(root, 'snapshots'), args.stamp);
    atomicWriteJson(sourcesPath, doc);
    atomicWriteJson(path.join(root, REPORT_REL), report);
  }
  return report;
}
