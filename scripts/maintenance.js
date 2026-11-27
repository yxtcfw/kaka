// 周期维护：信源正文复检 + 过期/失效清理 + 内容树 stale 节点回收。
// 硬边界：只清理系统自建条目；人工/API 信源、被页面引用的信源、人工节点永不删除；写前快照。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { atomicWriteJson, snapshot, sha256 } from './lib/util.js';
import { loadState, saveState, recordRun } from './lib/state.js';
import { fetchBody, createProviderGuard } from './lib/sources.js';

const DAY = 24 * 60 * 60 * 1000;

function safeJson(file, fallback) {
  try { return readJson(file); } catch { return fallback; }
}

function ageDays(now, value) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / DAY) : 0;
}

export async function runMaintenance(root = ROOT, args = {}) {
  const rules = safeJson(path.join(root, 'rules/maintenance.json'), {
    cleanupDiscoveredBy: ['search'], sourceMaxAgeDays: 30, candidateMaxAgeDays: 30,
    recheckEnabled: false, recheckLimit: 20, staleNodeCycles: 3, minKeywordsPerNode: 3, minNodes: 3
  });
  const now = args.now ? new Date(args.now) : new Date();
  const today = now.toISOString().slice(0, 10);

  const sourcesPath = path.join(root, 'data/sources.json');
  const treePath = path.join(root, 'data/tree.json');
  const discoveredPath = path.join(root, 'data/discovered.json');
  const sourcesDoc = safeJson(sourcesPath, { schema: 'sources/v1', sources: [] });
  const tree = safeJson(treePath, null);
  const discovered = safeJson(discoveredPath, { schema: 'discovered/v1', degraded: true, candidates: [] });
  const navDoc = safeJson(path.join(root, 'data/navlinks.json'), { items: [] });
  const detailsDoc = safeJson(path.join(root, 'data/nav-details.json'), { pages: [] });
  const signalsDoc = safeJson(path.join(root, 'data/signals.json'), { items: [] });

  const sources = sourcesDoc.sources || [];
  const referenced = new Set([
    ...(navDoc.items || []).flatMap((n) => n.sourceIds || []),
    ...(detailsDoc.pages || []).flatMap((p) => p.sourceIds || [])
  ]);
  const signalTerms = new Set((signalsDoc.items || []).map((i) => i.term));
  const cleanable = new Set(rules.cleanupDiscoveredBy || ['search']);

  // 1) 正文复检：只在搜索链路真实可用时联网；失败/降级时跳过并写明原因。
  const recheck = { enabled: false, reason: '', checked: 0, changed: 0, dead: 0 };
  const recheckResults = new Map();
  const manifest = safeJson(path.join(root, 'config/manifest.json'), { providers: {} });
  const provider = manifest.providers?.search || 'mock';
  if (rules.recheckEnabled !== false && provider !== 'mock' && !discovered.degraded) {
    try {
      const guard = args.guard || createProviderGuard(root, {
        ...args,
        fetchFn: args.fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
      });
      recheck.enabled = true;
      const targets = sources
        .filter((s) => cleanable.has(s.discoveredBy || '') && !referenced.has(s.sourceId))
        .sort((a, b) => String(a.fetchedAt).localeCompare(String(b.fetchedAt)))
        .slice(0, Number(rules.recheckLimit || 20));
      for (const s of targets) {
        recheck.checked++;
        try {
          const r = await fetchBody({ url: s.url, title: s.title || '', snippet: '' }, provider, { root, guard });
          const hash = sha256(r.body || '');
          if (hash !== s.bodyHash) {
            recheckResults.set(s.sourceId, {
              changed: true,
              bodyExcerpt: String(r.body || '').slice(0, 300),
              bodyChars: Number(r.chars || (r.body || '').length),
              bodyHash: hash
            });
            recheck.changed++;
          }
        } catch (e) {
          recheckResults.set(s.sourceId, { dead: true, reason: `${e.name || 'Error'}: ${e.message || e}` });
          recheck.dead++;
        }
      }
    } catch (e) {
      recheck.enabled = false;
      recheck.reason = `${e.name || 'Error'}: ${e.message || e}`;
    }
  } else {
    recheck.reason = provider === 'mock' ? 'mock-provider' : 'search-degraded';
  }

  // 2) 信源清理：只处理系统自建且未被页面引用的条目。
  const removedSources = [];
  const changedSources = [];
  const keptSources = [];
  let protectedSources = 0;
  for (const s of sources) {
    const eligible = cleanable.has(s.discoveredBy || '') && !referenced.has(s.sourceId);
    if (!eligible) { protectedSources++; keptSources.push(s); continue; }
    const rec = recheckResults.get(s.sourceId);
    if (rec?.dead) { removedSources.push({ sourceId: s.sourceId, reason: `dead: ${rec.reason}` }); continue; }
    if (rec?.changed) {
      s.bodyExcerpt = rec.bodyExcerpt;
      s.bodyChars = rec.bodyChars;
      s.bodyHash = rec.bodyHash;
      s.fetchedAt = today;
      changedSources.push(s.sourceId);
    }
    if (ageDays(now, s.fetchedAt) > Number(rules.sourceMaxAgeDays || 30)) {
      removedSources.push({ sourceId: s.sourceId, reason: 'expired' });
      continue;
    }
    keptSources.push(s);
  }
  sourcesDoc.sources = keptSources;

  // 3) 过期搜索候选清理（候选本身未成源，删除不影响已发页面）。
  const candidatesBefore = (discovered.candidates || []).length;
  discovered.candidates = (discovered.candidates || []).filter(
    (c) => ageDays(now, c.foundAt || c.discoveredAt) <= Number(rules.candidateMaxAgeDays || 30)
  );
  const removedCandidates = candidatesBefore - discovered.candidates.length;

  // 4) 内容树回收：仅 auto 节点；人工节点/根节点永不删，低于 minNodes 时停止。
  const removedNodes = [];
  const keywordDrops = [];
  let protectedNodes = 0;
  if (tree && Array.isArray(tree.nodes)) {
    const minNodes = Number(rules.minNodes || 3);
    const nextNodes = [];
    for (const n of tree.nodes) {
      // 容器节点（有子节点）即使是 auto 来源也不能回收：删掉会让整棵子树脱离分类
      const isContainer = Array.isArray(n.children) && n.children.length > 0;
      if (n.origin !== 'auto' || isContainer || tree.nodes.length - removedNodes.length <= minNodes) {
        protectedNodes++;
        nextNodes.push(n);
        continue;
      }
      const keptKeywords = (n.keywords || []).filter((k) => signalTerms.has(k));
      const dropped = (n.keywords || []).filter((k) => !signalTerms.has(k));
      if (dropped.length) keywordDrops.push({ nodeId: n.id, terms: dropped });
      n.keywords = keptKeywords;
      n.idleCycles = keptKeywords.length ? 0 : Number(n.idleCycles || 0) + 1;
      if (n.idleCycles >= Number(rules.staleNodeCycles || 3) || keptKeywords.length < Number(rules.minKeywordsPerNode || 3)) {
        removedNodes.push({ id: n.id, label: n.label, reason: keptKeywords.length ? 'low-keywords' : 'stale' });
        continue;
      }
      nextNodes.push(n);
    }
    const removedIds = new Set(removedNodes.map((n) => n.id));
    for (const n of nextNodes) {
      if (removedIds.has(n.parent)) {
        n.parent = tree.root.id;
        if (!tree.root.children.includes(n.id)) tree.root.children.push(n.id);
      }
      n.children = (n.children || []).filter((id) => !removedIds.has(id) && nextNodes.some((x) => x.id === id));
    }
    tree.root.children = (tree.root.children || []).filter((id) => nextNodes.some((n) => n.id === id));
    tree.nodes = nextNodes;
  }

  const touchedSources = removedSources.length > 0 || changedSources.length > 0;
  const touchedTree = removedNodes.length > 0 || keywordDrops.length > 0;
  const touchedCandidates = removedCandidates > 0;
  const report = {
    stage: 'maintenance', now: today,
    removedSources, changedSources, protectedSources,
    removedCandidates, removedNodes, keywordDrops,
    recheck, dryRun: !!args.dryRun
  };

  if (!args.dryRun) {
    const dir = path.join(root, 'snapshots', 'maintenance');
    const stamp = new Date().toISOString();
    if (touchedSources) { snapshot(sourcesPath, dir, stamp); atomicWriteJson(sourcesPath, sourcesDoc); }
    if (touchedCandidates) { snapshot(discoveredPath, dir, stamp); atomicWriteJson(discoveredPath, discovered); }
    if (touchedTree) { snapshot(treePath, dir, stamp); atomicWriteJson(treePath, tree); }
    const state = loadState(root);
    recordRun(state, {
      stage: 'maintenance', provider,
      summary: `信源 -${removedSources.length}/改${changedSources.length}, 候选 -${removedCandidates}, 节点 -${removedNodes.length}, 复检 ${recheck.checked}`,
      inputs: { sources: sources.length, nodes: tree ? tree.nodes.length : 0 }
    });
    saveState(state, root);
    writeJson(path.join(root, 'reports', 'maintenance.json'), report);
  }
  return report;
}
