// 助手直接建树：按 rules/curated-tree.json 的意图分组，把联想词一次性组织成内容树。
// 与 grow-tree 的区别：这里不使用模型，完全由人工审阅过的确定性规则驱动，适合首次建树。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { makeSnapshots } from './lib/snapshot.js';
import { loadState, saveState, recordRun } from './lib/state.js';

const MAX_KEYWORDS_DEFAULT = 60;
const MIN_KEYWORDS = 8;

export function assignTerms(terms, rules) {
  const buckets = new Map();
  const seenLabels = new Map();
  for (const node of rules.nodes) {
    const id = node.aliasOf || node.id;
    if (!buckets.has(id)) buckets.set(id, []);
    if (node.label && !seenLabels.has(id)) seenLabels.set(id, node);
  }
  for (const term of terms) {
    let target = '';
    for (const node of rules.nodes) {
      if (!node.pattern) continue;
      try {
        if (new RegExp(node.pattern).test(term)) { target = node.aliasOf || node.id; break; }
      } catch { /* 规则正则非法时跳过该条 */ }
    }
    if (!target) target = rules.fallback || 'n1';
    if (!buckets.has(target)) buckets.set(target, []);
    buckets.get(target).push(term);
  }
  return { buckets, seenLabels };
}

export function buildCuratedTree(root = ROOT, args = {}) {
  const treePath = path.join(root, 'data/tree.json');
  const tree = readJson(treePath);
  const signals = readJson(path.join(root, 'data/signals.json'));
  const rules = readJson(path.join(root, 'rules/curated-tree.json'));
  const maxKeywords = Number(rules.maxKeywordsPerNode || MAX_KEYWORDS_DEFAULT);
  const terms = signals.items.map((i) => i.term);

  const { buckets, seenLabels } = assignTerms(terms, rules);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const addedNodes = [];
  const rejected = [];
  const maxNodes = Number(readJson(path.join(root, 'rules/signals-tree.json')).maxNodes || 24);
  const maxDepth = Number(readJson(path.join(root, 'rules/signals-tree.json')).maxDepth || 3);

  const attach = (id, parent) => {
    if (byId.get(id)) return true;
    if (tree.nodes.length >= maxNodes) return false;
    const meta = seenLabels.get(id) || {};
    const node = {
      id, label: meta.label || id, topic: meta.topic || id,
      keywords: [], parent, children: [], origin: 'curated'
    };
    tree.nodes.push(node);
    byId.set(id, node);
    if (parent === tree.root.id) {
      if (!tree.root.children.includes(id)) tree.root.children.push(id);
    } else if (byId.get(parent)) {
      const p = byId.get(parent);
      if (!p.children.includes(id)) p.children.push(id);
    }
    addedNodes.push(id);
    return true;
  };

  // 先建容器节点（父级），再建分类节点；parent 必须已存在，深度不超限
  for (const p of (rules.parents || [])) {
    if (byId.has(p.id)) continue;
    if (p.parent !== tree.root.id && !byId.has(p.parent)) { rejected.push({ id: p.id, reason: 'invalid-parent' }); continue; }
    if (!attach(p.id, p.parent)) rejected.push({ id: p.id, reason: 'max-nodes' });
  }
  for (const [id, words] of buckets) {
    if (words.length < MIN_KEYWORDS) { rejected.push({ id, reason: 'too-few-terms', count: words.length }); continue; }
    const kept = [...new Set(words)].slice(0, maxKeywords);
    const meta = seenLabels.get(id) || {};
    const parent = meta.parent || tree.root.id;
    const depth = parent === tree.root.id ? 1 : (byId.get(parent)?.parent === tree.root.id ? 2 : 3);
    if (depth > maxDepth) { rejected.push({ id, reason: 'too-deep' }); continue; }
    const node = byId.get(id);
    if (node) {
      node.keywords = kept; // 我审阅过的分组结果，整组替换而非追加，避免旧词残留
      if (node.parent !== parent && byId.has(parent)) {
        const oldParent = byId.get(node.parent);
        if (oldParent?.children) oldParent.children = oldParent.children.filter((c) => c !== id);
        node.parent = parent;
        const newParent = byId.get(parent);
        if (newParent && !newParent.children.includes(id)) newParent.children.push(id);
      }
    } else {
      if (!attach(id, parent)) { rejected.push({ id, reason: 'max-nodes' }); continue; }
      byId.get(id).keywords = kept;
    }
  }

  // 规则里没有分到词的旧 auto 节点保留结构，但清空过时关键词，避免误导
  for (const node of tree.nodes) {
    if (node.origin === 'auto' && !buckets.has(node.id)) node.keywords = [];
    // 被我改造成容器的原 auto 节点升级为 curated，避免被周期维护当空壳回收
    if ((rules.parents || []).some((p) => p.id === node.id)) node.origin = 'curated';
  }

  // 一级分类严格等于 parent=n0 的节点，清掉历史上被维护提升上来的子节点
  tree.root.children = tree.nodes.filter((n) => n.parent === tree.root.id).map((n) => n.id);

  const covered = [...buckets.values()].reduce((n, arr) => n + arr.length, 0);
  const report = {
    stage: 'curate-tree', provider: 'assistant-curated',
    terms: terms.length, covered, nodes: tree.nodes.length,
    addedNodes, rejected, maxKeywords,
    buckets: Object.fromEntries([...buckets].map(([k, v]) => [k, v.length]))
  };

  if (!args.dryRun) {
    makeSnapshots(root, `before-curate-tree-${Date.now()}`);
    writeJson(treePath, tree);
    const state = loadState(root);
    state.tree = { ...(state.tree || {}), curated: true, version: (state.tree?.version || 0) + 1 };
    recordRun(state, { stage: 'curate-tree', provider: 'assistant-curated', summary: `覆盖 ${covered}/${terms.length} 词，新节点 ${addedNodes.length}`, inputs: terms.slice(0, 20) });
    saveState(state, root);
    writeJson(path.join(root, 'reports', 'curate-tree.json'), report);
  }
  return report;
}
