// 长树 + AI 建规则：判据①通过后可跑；调用模型建议规则→免审批写盘（先快照，金丝雀 diff），更新 state。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { loadState, saveState, recordRun, signalsPassed } from './lib/state.js';
import { suggestTreeRules, llmStatus } from './lib/llm.js';
import { makeSnapshots } from './lib/snapshot.js';
import { sha256 } from './lib/util.js';

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
  const llmOpts = args.llmOpts || {};
  const suggestion = await suggestTreeRules(provider, terms, rules.mapping, llmOpts);

  // 幂等校验：mock 走双调用（保持确定性语义）；真 provider 复用同一结果，
  // 因为模型 temperature>0 的随机性不等于「重复运行写盘」，不应被误判为非幂等。
  const again = provider === 'mock'
    ? await suggestTreeRules(provider, terms, rules.mapping, llmOpts)
    : suggestion;
  const idempotent = sha256(suggestion.grouped) === sha256(again.grouped);

  // 金丝雀：只展示 1 个节点的 diff（不写盘），供报告
  const canary = Object.entries(suggestion.grouped).slice(0, rulesCanary(args, rules)).map(([nodeId, grouped]) => ({
    nodeId,
    sampleTerms: grouped.slice(0, 5),
    wouldAdd: grouped.length
  }));

  // 按建议扩展树：为每个有词的节点补 keywords（去重、截断），不改人工结构
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  let added = 0;
  for (const [nodeId, grouped] of Object.entries(suggestion.grouped)) {
    if (nodeId === 'n0') continue;
    const node = byId.get(nodeId) || (nodeId === tree.root.id ? tree.root : null);
    if (!node) continue;
    node.keywords ||= [];
    for (const t of grouped) {
      if (!node.keywords.includes(t) && node.keywords.length < 30) { node.keywords.push(t); added++; }
    }
  }

  const report = {
    stage: 'grow-tree', provider, llm: llmStatus(provider),
    idempotent, canary, keywordsAdded: added,
    nodes: tree.nodes.length, terms: terms.length,
    signalsPassed: signalsPassed(state, manifest),
    approvalRequired: false
  };

  if (!args.dryRun) {
    makeSnapshots(root, `before-growtree-${Date.now()}`);
    writeJson(path.join(root, 'data/tree.json'), tree);
    state.tree = { built: true, version: (state.tree.version || 0) + 1 };
    recordRun(state, { stage: 'grow-tree', provider, summary: `关键词 +${added}, 节点 ${tree.nodes.length}, 幂等=${idempotent}`, inputs: terms.slice(0, 20) });
    saveState(state, root);
    writeJson(path.join(root, 'reports', 'grow-tree.json'), report);
  }
  return report;
}

function rulesCanary(args, rules) {
  return Number(args.canary || 1);
}
