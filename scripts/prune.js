// 四状态修剪：基于 Bing 回流把页面标为 active/watch/stale/unmatched，并产出内容树复核提案。
// 红线：只出报告，不写 tree.json / articles.json；空回流数据不下任何结论。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { slugify } from './lib/render.js';

function safeJson(file, fallback) {
  try { return readJson(file); } catch { return fallback; }
}

export function runPrune(root = ROOT, args = {}) {
  const rules = safeJson(path.join(root, 'rules/prune.json'), {
    activeMinImpressions: 100, activeMinClicks: 5, watchMinImpressions: 20,
    minPagesForNodeReview: 1, apply: false
  });
  const metrics = safeJson(path.join(root, 'data/metrics/latest.json'), { rows: [] });
  const rows = Array.isArray(metrics.rows) ? metrics.rows : [];
  const base = {
    stage: 'prune', checkedAt: new Date().toISOString(),
    provider: metrics.provider || '', rows: rows.length,
    apply: rules.apply !== false
  };

  if (!rows.length) {
    const report = { ...base, status: 'no-data', counts: {}, decisions: [], unmatched: [], treeProposals: [], note: '回流为空：不判断页面，也不修剪内容树。' };
    if (!args.dryRun) writeJson(path.join(root, 'reports/prune.json'), report);
    return report;
  }

  const rowByPage = new Map(rows.map((r) => [String(r.page || ''), r]));
  const articlesDoc = safeJson(path.join(root, 'data/articles.json'), { articles: [] });
  const articles = Array.isArray(articlesDoc.articles) ? articlesDoc.articles : [];
  const navDoc = safeJson(path.join(root, 'data/navlinks.json'), { items: [] });
  const tree = safeJson(path.join(root, 'data/tree.json'), { nodes: [] });
  const byId = new Map((tree.nodes || []).map((n) => [n.id, n]));

  const decisions = [];
  const unmatched = [];
  const stateOf = (m) => {
    if (!m) return 'unmatched';
    if (Number(m.impressions || 0) > Number(rules.activeMinImpressions || 100)
      && Number(m.clicks || 0) > Number(rules.activeMinClicks || 5)) return 'active';
    if (Number(m.impressions || 0) > Number(rules.watchMinImpressions || 20)) return 'watch';
    return 'stale';
  };
  for (const a of articles) {
    const page = `/blog/${slugify(a.id)}.html`;
    const m = rowByPage.get(page);
    const state = stateOf(m);
    decisions.push({ id: a.id, nodeId: a.nodeId || '', page, state, metrics: m || null });
    if (state === 'unmatched') unmatched.push(page);
  }
  for (const n of (navDoc.items || [])) {
    const page = `/nav/${slugify(n.navId)}.html`;
    const m = rowByPage.get(page);
    if (!m) unmatched.push(page);
  }

  // 树提案：某节点下所有文章均无流量时，建议人工复核，不自动删除节点或关键词。
  const grouped = new Map();
  for (const d of decisions.filter((d) => d.nodeId)) {
    if (!grouped.has(d.nodeId)) grouped.set(d.nodeId, []);
    grouped.get(d.nodeId).push(d);
  }
  const treeProposals = [];
  for (const [nodeId, ds] of grouped) {
    if (ds.length < Number(rules.minPagesForNodeReview || 1)) continue;
    if (!ds.every((d) => d.state === 'stale' || d.state === 'unmatched')) continue;
    const node = byId.get(nodeId);
    treeProposals.push({
      nodeId, label: node?.label || nodeId, action: 'review',
      reason: 'no-traffic-on-all-articles', pages: ds.map((d) => d.page),
      origin: node?.origin || 'unknown'
    });
  }

  const counts = decisions.reduce((acc, d) => { acc[d.state] = (acc[d.state] || 0) + 1; return acc; }, {});
  const report = {
    ...base, status: 'ready', counts, decisions, unmatched, treeProposals,
    note: '仅提案：页面状态与树节点复核均不自动写盘；人工确认后再处理。'
  };
  if (!args.dryRun) writeJson(path.join(root, 'reports/prune.json'), report);
  return report;
}
