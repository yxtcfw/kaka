// Blog 文章创作：判据②达标后，按 content tree 节点 + 信源生成 bundle → 六道门禁 → 存 articles.json。
// AI 只写组织/推荐语；数字必须指回 citation；门禁至少拦下一次才算判据③达标。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { runGates } from './lib/gates.js';
import { composeBundle } from './lib/llm.js';
import { loadState, saveState, recordRun, sourcesPassed, contentPassed } from './lib/state.js';
import { makeSnapshots } from './lib/snapshot.js';
import { atomicWriteJson } from './lib/util.js';

export async function runWriteContent(root = ROOT, args = {}) {
  const manifest = readJson(path.join(root, 'config/manifest.json'));
  const tree = readJson(path.join(root, 'data/tree.json'));
  const sourcesDoc = readJson(path.join(root, 'data/sources.json'));
  const sources = sourcesDoc.sources;
  const state = loadState(root);
  const provider = manifest.providers?.llm || 'mock';

  if (!sourcesPassed(state, manifest)) {
    return { stage: 'write-content', skipped: true, reason: '判据②未达标：信源不足（1×L1 或 2×独立 L2）' };
  }

  const approved = sources.filter((s) => s.status === 'approved' && (s.bodyExcerpt || '').length >= 50);
  const nodes = tree.nodes.filter((n) => n.children !== undefined);
  let articles = [];
  try { articles = readJson(path.join(root, 'data/articles.json')).articles || []; } catch { /* ignore */ }
  const corpus = articles.map((a) => ({ id: a.id, title: a.title, body: a.body || '' }));

  const limit = Number(args.limit || Math.min(nodes.length, 5));
  const generated = [], blocked = [];
  let gateBlockedCount = 0;

  for (const node of nodes.slice(0, limit)) {
    // 每个节点选一篇可用信源做引用
    const cite = approved.find((s) => !generated.some((g) => g.sourceId === s.sourceId)) || approved[0];
    if (!cite) break;
    const bundle = await composeBundle(provider, {
      id: `article-${node.id}`,
      kind: 'article',
      title: node.topic || node.label,
      sourceIds: [cite.sourceId],
      cardDesc: `${node.label}相关资料整理与选购参考。`,
      links: [{ href: cite.url, rel: 'sponsored nofollow noopener', kind: 'outbound' }],
      byline: ''
    }, args.llmOpts || {});
    bundle.body = `${bundle.body}\n\n参考信源：${cite.title}（${cite.domain}）。具体数值以官方实时页面为准。`;
    const gate = runGates(bundle, { root, sources, corpus });
    if (gate.ok) {
      generated.push({ id: bundle.id, title: bundle.title, nodeId: node.id, body: bundle.body, sourceId: cite.sourceId, citations: bundle.citations, links: bundle.links, generatedAt: new Date().toISOString().slice(0, 10) });
      corpus.push({ id: bundle.id, title: bundle.title, body: bundle.body });
    } else {
      gateBlockedCount += gate.blockers.length;
      blocked.push({ nodeId: node.id, blockers: gate.blockers });
    }
  }

  const totalArticles = articles.length + generated.length;
  state.content = {
    generated: totalArticles,
    gateBlocked: (state.content.gateBlocked || 0) + gateBlockedCount,
    passed: contentPassed({ ...state, content: { generated: totalArticles, gateBlocked: (state.content.gateBlocked || 0) + gateBlockedCount } }, manifest)
  };

  const report = { stage: 'write-content', provider, generated: generated.length, blocked: blocked.length, gateBlockedCount, contentPassed: state.content.passed, blockedDetail: blocked };

  if (!args.dryRun) {
    makeSnapshots(root, `before-writecontent-${Date.now()}`);
    atomicWriteJson(path.join(root, 'data/articles.json'), { schema: 'articles/v1', articles: [...articles, ...generated] });
    recordRun(state, { stage: 'write-content', provider, summary: `生成 ${generated.length}, 拦截 ${gateBlockedCount}`, inputs: nodes.map((n) => n.id).slice(0, 10) });
    saveState(state, root);
    writeJson(path.join(root, 'reports', 'write-content.json'), report);
  }
  return report;
}
