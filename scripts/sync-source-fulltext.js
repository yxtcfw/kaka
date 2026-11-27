// 信源全文回填：把 nav-details.json 的 sourceBody 全文写入 sources.json 的 bodyExcerpt。
// 背景：云端模型只能看到 bodyExcerpt，摘录太短就会写模板文并覆盖人工稿。
// 本脚本幂等：只有「新全文更长」时才写；带快照与 dry-run，不改任何运营数据以外的文件。
import path from 'node:path';
import { readJson, ROOT } from './lib/validate.js';
import { snapshot, atomicWriteJson } from './lib/util.js';

export function runSyncSourceFulltext(root = ROOT, args = {}) {
  const sourcesPath = path.join(root, 'data/sources.json');
  const sourcesDoc = readJson(sourcesPath);
  const details = readJson(path.join(root, 'data/nav-details.json'));
  const pages = Array.isArray(details.pages) ? details.pages : [];

  // 按 sourceId 建全文索引：sourceBody 为官方详情原文，非空才纳入。
  const fullBySource = new Map();
  for (const p of pages) {
    const text = String(p.sourceBody || '');
    if (text.length < 50) continue;
    for (const sid of (Array.isArray(p.sourceIds) ? p.sourceIds : [])) {
      const prev = fullBySource.get(sid);
      if (!prev || text.length > prev.length) fullBySource.set(sid, text);
    }
  }

  let filled = 0, upgraded = 0, unchanged = 0, missing = 0;
  for (const s of sourcesDoc.sources) {
    const full = fullBySource.get(s.sourceId);
    if (!full) { continue; }
    const old = String(s.bodyExcerpt || '');
    if (old === full) { unchanged++; continue; }
    if (old.length > full.length) { unchanged++; continue; } // 已有的更长内容不缩短
    if (old) upgraded++; else filled++;
    s.bodyExcerpt = full;
    s.bodyKind = 'fulltext';
    s.bodyChars = full.length;
    s.bodyFullChars = full.length;
  }
  // 无全文对应的详情源计数（诊断用，不报错）。
  for (const p of pages) {
    for (const sid of (Array.isArray(p.sourceIds) ? p.sourceIds : [])) {
      if (!fullBySource.has(sid)) missing++;
    }
  }

  const report = {
    stage: 'sync-source-fulltext', sources: sourcesDoc.sources.length,
    detailPages: pages.length, withFulltext: fullBySource.size,
    filled, upgraded, unchanged, missingFulltextRefs: missing,
    maxChars: Math.max(0, ...[...fullBySource.values()].map((t) => t.length))
  };
  if (!args.dryRun) {
    snapshot(sourcesPath, path.join(root, 'snapshots'), `before-fulltext-${Date.now()}`);
    atomicWriteJson(sourcesPath, sourcesDoc);
  }
  return report;
}
