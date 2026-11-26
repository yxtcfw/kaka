// 正文获取 + 判据 → 信源池：候选 URL → 抓正文 → 分级（默认 L3）→ 写 sources/v1。
// 抓不到正文或过短 → status=candidate/bodyKind=none，不进创作；status=rejected 永不被引用。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { fetchBody, gradeCandidate, dedupeCandidates, nextSourceId } from './lib/sources.js';
import { loadState, saveState, recordRun, sourcesPassed } from './lib/state.js';

export async function runFetchBody(root = ROOT, args = {}) {
  const manifest = readJson(path.join(root, 'config/manifest.json'));
  const gradeRules = readJson(path.join(root, 'rules/source-grade.json'));
  const provider = manifest.providers?.search || 'mock';

  let discovered;
  try { discovered = readJson(path.join(root, 'data/discovered.json')); }
  catch { return { stage: 'fetch-body', error: 'no data/discovered.json; run discover first', sources: 0 }; }

  const sourcesDoc = readJson(path.join(root, 'data/sources.json'));
  let sources = sourcesDoc.sources;
  const candidates = dedupeCandidates(discovered.candidates, sources);

  const results = [];
  for (const c of candidates) {
    let body = '';
    try { body = (await fetchBody(c, discovered.degraded ? 'mock' : provider)).body; }
    catch { body = ''; }
    const graded = gradeCandidate(c, body, gradeRules);
    const id = nextSourceId(sources);
    const record = {
      sourceId: id,
      url: c.url,
      domain: graded.domain,
      title: c.title || c.url,
      grade: graded.grade,
      status: graded.status,
      bodyKind: graded.bodyKind,
      bodyExcerpt: body ? body.slice(0, 300) : '',
      discoveredBy: 'search',
      fetchedAt: new Date().toISOString().slice(0, 10),
      bodyChars: body.length
    };
    sources.push(record);
    results.push({ sourceId: id, grade: graded.grade, status: graded.status, bodyOk: graded.bodyOk });
  }

  // 统计 L1 与独立域 L2（判据②）
  const l1 = sources.filter((s) => s.grade === 'L1' && s.status === 'approved').length;
  const l2Domains = new Set(sources.filter((s) => s.grade === 'L2' && s.status === 'approved').map((s) => s.domain));
  const state = loadState(root);
  state.sources = {
    l1,
    independentL2: l2Domains.size,
    passed: sourcesPassed({ ...state, sources: { l1, independentL2: l2Domains.size } }, manifest)
  };
  const report = {
    stage: 'fetch-body', provider, fetched: results.length,
    approved: results.filter((r) => r.status === 'approved').length,
    l1, independentL2: l2Domains.size, sourcesPassed: state.sources.passed
  };

  if (!args.dryRun) {
    writeJson(path.join(root, 'data/sources.json'), sourcesDoc);
    recordRun(state, { stage: 'fetch-body', provider, summary: `+${results.length} 源, L1=${l1}, L2独立域=${l2Domains.size}`, inputs: candidates.map((c) => c.url).slice(0, 10) });
    saveState(state, root);
    writeJson(path.join(root, 'reports', 'fetch-body.json'), report);
  }
  return report;
}
