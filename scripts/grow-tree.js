// 长树 + AI 建规则：判据①通过后可跑；调用模型建议规则→免审批写盘（先快照，金丝雀 diff），更新 state。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { loadState, saveState, recordRun, signalsPassed } from './lib/state.js';
import { suggestTreeRules, llmStatus } from './lib/llm.js';
import { makeSnapshots } from './lib/snapshot.js';
import { sha256 } from './lib/util.js';

function safeJson(file, fallback) {
  try { return readJson(file); } catch { return fallback; }
}

export async function runGrowTree(root = ROOT, args = {}) {
  const manifest = readJson(path.join(root, 'config/manifest.json'));
  const tree = readJson(path.join(root, 'data/tree.json'));
  const rules = readJson(path.join(root, 'rules/signals-tree.json'));
  const signalsFile = path.join(root, 'data/signals.json');
  let signals = { items: [] };
  try { signals = readJson(signalsFile); } catch { /* 未采集时按空处理 */ }
  const state = loadState(root);
  const provider = manifest.providers?.llm || 'mock';

  const terms = signals.items.map((i) => i.term);

  // 节奏门槛：树是信息架构，不是每日变更的缓存。未达阈值时零模型调用、零写盘。
  // --force 仅供人工 dispatch 绕过（例如首次建树或阈值调整后重跑）。
  const cadence = safeJson(path.join(root, 'rules/tree-cadence.json'), {});
  const th = cadence.growThreshold || {};
  const covered = new Set(tree.nodes.flatMap((n) => n.keywords || []));
  const patterns = Object.entries(rules.mapping || {});
  const uncoveredTerms = terms.filter((t) => !covered.has(t));
  const unmappedTerms = terms.filter((t) => !patterns.some(([p]) => { try { return new RegExp(p).test(t); } catch { return false; } }));
  const signalsOk = signalsPassed(state, manifest);
  const reasons = [];
  if (uncoveredTerms.length < Number(th.minUncoveredTerms ?? 50)) reasons.push(`uncovered ${uncoveredTerms.length}<${th.minUncoveredTerms ?? 50}`);
  if (unmappedTerms.length < Number(th.minUnmappedTerms ?? 20)) reasons.push(`unmapped ${unmappedTerms.length}<${th.minUnmappedTerms ?? 20}`);
  if (th.requireSignalsPassed !== false && !signalsOk) reasons.push('signals-not-passed');
  if (!args.force && reasons.length) {
    return {
      stage: 'grow-tree', provider, skipped: true, reason: reasons.join('; '),
      terms: terms.length, uncoveredTerms: uncoveredTerms.length,
      unmappedTerms: unmappedTerms.length, signalsPassed: signalsOk,
      llm: llmStatus(provider), model: '', dryRun: !!args.dryRun
    };
  }

  const parentIds = [tree.root.id, ...tree.nodes.map((n) => n.id)];
  const llmOpts = {
    ...(args.llmOpts || {}),
    parentIds,
    nodeSummary: tree.nodes.map((n) => ({ id: n.id, label: n.label, parent: n.parent })),
    autoNodePatterns: rules.autoNodePatterns || {},
    minTermsPerNode: rules.minTermsPerNode,
    maxNewNodes: Number(args.maxNewNodes || rules.maxNewNodesPerRun || 3)
  };
  const suggestion = await suggestTreeRules(provider, terms, rules.mapping, llmOpts);

  // 幂等校验：mock 走双调用（保持确定性语义）；真 provider 复用同一结果，
  // 因为模型 temperature>0 的随机性不等于「重复运行写盘」，不应被误判为非幂等。
  const again = provider === 'mock'
    ? await suggestTreeRules(provider, terms, rules.mapping, llmOpts)
    : suggestion;
  const signature = (s) => sha256({ grouped: s.grouped, newNodes: s.newNodes || [] });
  const idempotent = signature(suggestion) === signature(again);

  // 金丝雀：展示现有节点 1 条 diff + 模型提出的首个新节点（不写盘），供报告
  const canary = Object.entries(suggestion.grouped).slice(0, rulesCanary(args, rules)).map(([nodeId, grouped]) => ({
    nodeId,
    sampleTerms: grouped.slice(0, 5),
    wouldAdd: grouped.length
  }));
  for (const n of (suggestion.newNodes || []).slice(0, 1)) {
    canary.push({ nodeId: 'auto(proposed)', label: n.label, parent: n.parent, sampleTerms: n.keywords.slice(0, 5), wouldAdd: n.keywords.length });
  }

  // 结构变更只产建议：默认不写 tree.json，人工审阅 reports/tree-proposals.json 后用 --apply 落盘。
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const byLabel = new Map(tree.nodes.map((n) => [n.label, n]));
  const depthOf = (id) => {
    let d = 0;
    let cur = id;
    while (cur && cur !== tree.root.id && d < 10) { cur = byId.get(cur)?.parent; d++; }
    return d;
  };
  const maxNodes = Number(rules.maxNodes || 24);
  const maxDepth = Number(rules.maxDepth || 3);
  const today = new Date().toISOString().slice(0, 10);
  const grouped = { ...suggestion.grouped };
  const proposedNodes = [];
  const rejectedNodes = [];
  for (const proposal of suggestion.newNodes || []) {
    const label = String(proposal.label || '').trim();
    const parent = proposal.parent === tree.root.id || byId.has(proposal.parent) ? proposal.parent : '';
    const depth = parent ? (parent === tree.root.id ? 1 : depthOf(parent) + 1) : 0;
    let reason = '';
    if (!parent) reason = 'invalid-parent';
    else if (depth > maxDepth) reason = 'too-deep';
    else if (tree.nodes.length + proposedNodes.length >= maxNodes) reason = 'max-nodes';
    else if (byLabel.has(label)) reason = 'duplicate-label';
    else if (byId.has(`auto-${sha256(label).slice(0, 8)}`)) reason = 'duplicate-id';
    if (reason) { rejectedNodes.push({ label, reason }); continue; }
    const id = `auto-${sha256(label).slice(0, 8)}`;
    const node = {
      id, label,
      topic: String(proposal.topic || `${label}相关内容`).slice(0, 60),
      parent, children: [], keywords: [],
      origin: 'auto', createdAt: today
    };
    byId.set(id, node);
    byLabel.set(label, node);
    grouped[id] = proposal.keywords.slice(0, 12);
    proposedNodes.push({ node, terms: grouped[id] });
  }

  const keywordAdditions = [];
  for (const [nodeId, terms] of Object.entries(grouped)) {
    if (nodeId === 'n0') continue;
    const node = byId.get(nodeId) || (nodeId === tree.root.id ? tree.root : null);
    if (!node) continue;
    const existing = new Set(node.keywords || []);
    const additions = terms.filter((t) => !existing.has(t)).slice(0, Math.max(0, 30 - existing.size));
    if (additions.length) keywordAdditions.push({ nodeId, terms: additions });
  }

  const proposalDoc = {
    stage: 'tree-proposals', at: new Date().toISOString(), provider,
    proposedNodes: proposedNodes.map((p) => ({ ...p.node, keywords: p.terms })),
    keywordAdditions, rejectedNodes,
    note: '仅提案，不写 tree.json；人工确认后运行 grow-tree --apply。'
  };

  let nodesAdded = 0;
  let added = 0;
  if (args.apply) {
    for (const { node, terms } of proposedNodes) {
      tree.nodes.push(node);
      if (node.parent === tree.root.id) tree.root.children.push(node.id);
      else byId.get(node.parent)?.children.push(node.id);
      nodesAdded++;
    }
    for (const { nodeId, terms } of keywordAdditions) {
      const node = byId.get(nodeId) || (nodeId === tree.root.id ? tree.root : null);
      if (!node) continue;
      node.keywords ||= [];
      for (const t of terms) {
        if (!node.keywords.includes(t) && node.keywords.length < 30) { node.keywords.push(t); added++; }
      }
    }
  }

  const proposedKeywordCount = keywordAdditions.reduce((n, x) => n + x.terms.length, 0);
  const report = {
    stage: 'grow-tree', provider, llm: llmStatus(provider),
    model: suggestion.model || '', requestedModel: suggestion.requestedModel || '',
    skipped: false, uncoveredTerms: uncoveredTerms.length, unmappedTerms: unmappedTerms.length,
    signalsPassed: signalsOk,
    idempotent, canary,
    proposalMode: !args.apply,
    proposedNodes: proposedNodes.length, proposedKeywords: proposedKeywordCount,
    keywordsAdded: added, nodesAdded, rejectedNodes,
    degraded: !!suggestion.degraded, reason: suggestion.reason || suggestion.note || '',
    nodes: tree.nodes.length, terms: terms.length,
    approvalRequired: !args.apply && (proposedNodes.length + proposedKeywordCount) > 0
  };

  if (!args.dryRun) {
    writeJson(path.join(root, 'reports', 'tree-proposals.json'), proposalDoc);
    const summary = args.apply
      ? `关键词 +${added}, 新节点 +${nodesAdded}, 节点 ${tree.nodes.length}, 幂等=${idempotent}`
      : `提案：新节点 ${proposedNodes.length}, 关键词 +${proposedKeywordCount}, 待人工确认`;
    if (args.apply) {
      makeSnapshots(root, `before-growtree-${Date.now()}`);
      writeJson(path.join(root, 'data/tree.json'), tree);
      state.tree = { built: true, version: (state.tree.version || 0) + 1 };
    }
    recordRun(state, { stage: 'grow-tree', provider, summary, inputs: terms.slice(0, 20) });
    saveState(state, root);
    writeJson(path.join(root, 'reports', 'grow-tree.json'), report);
  }
  return report;
}

function rulesCanary(args, rules) {
  return Number(args.canary || 1);
}
