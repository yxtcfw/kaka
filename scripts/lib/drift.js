// 漂移检测核心（纯函数，零写盘）：树 / 信源 / 规则三者一致性校验。
// 异常产出 alerts/v1 条目，写盘由 drift-check.js 负责；只告警不阻断流程（v7 §2 安全阀）。
import path from 'node:path';
import { readJson } from './validate.js';

export const DRIFT_KINDS = [
  'tree-dangling-parent',      // 节点 parent 指向不存在节点
  'tree-dangling-child',       // root/node 的 children 指向不存在节点
  'rule-unknown-node',         // 规则 mapping 的 nodeId 不在树中
  'search-source-upgraded',    // 搜索发现源被升到 L1/L2（红线）
  'rejected-source-referenced',// rejected 源仍被 nav 引用
  'style-token-drift',         // site.styleTokens 与 manifest.theme 不一致
  'source-count-drift'         // 实际 L1/独立L2 与 state.sources 记录不一致
];

function load(root, rel, fb) {
  try { return readJson(path.join(root, rel)); } catch { return fb; }
}

// 返回 alerts/v1 文档（始终合法，alerts 可为空数组）。
export function detectDrift(root) {
  const tree = load(root, 'data/tree.json', null);
  const sourcesDoc = load(root, 'data/sources.json', { sources: [] });
  const navDoc = load(root, 'data/navlinks.json', { items: [] });
  const site = load(root, 'data/site.json', {});
  const manifest = load(root, 'config/manifest.json', {});
  const state = load(root, 'state.json', {});
  const gradeRules = load(root, 'rules/source-grade.json', {});
  const treeRules = load(root, 'rules/signals-tree.json', {});

  const alerts = [];
  const add = (kind, severity, subject, detail) => alerts.push({ kind, severity, subject, detail, at: new Date().toISOString().slice(0, 10) });
  const nodeIds = new Set([...(tree?.nodes || []).map((n) => n.id), ...(tree?.root ? [tree.root.id] : [])]);

  // 1. 树引用完整性
  if (tree) {
    for (const n of tree.nodes || []) {
      if (n.parent && !nodeIds.has(n.parent)) add('tree-dangling-parent', 'warn', n.id, `parent=${n.parent} 不存在`);
      for (const c of n.children || []) {
        if (!nodeIds.has(c)) add('tree-dangling-child', 'warn', n.id, `child=${c} 不存在`);
      }
    }
    for (const c of tree.root?.children || []) {
      if (!nodeIds.has(c)) add('tree-dangling-child', 'warn', tree.root.id, `child=${c} 不存在`);
    }
  }

  // 2. 规则 mapping 指向的 nodeId 必须在树中
  for (const [pattern, nodeId] of Object.entries(treeRules.mapping || {})) {
    if (!nodeIds.has(nodeId)) add('rule-unknown-node', 'warn', pattern, `mapping 指向 nodeId=${nodeId} 不存在`);
  }

  // 3. 搜索候选被误升（noAutoUpgrade=true 时一律应 L3）
  if (gradeRules.noAutoUpgrade !== false) {
    for (const s of sourcesDoc.sources || []) {
      if (s.discoveredBy === 'search' && s.grade !== 'L3') {
        add('search-source-upgraded', 'critical', s.sourceId, `搜索发现源 grade=${s.grade}，应为 L3`);
      }
    }
  }

  // 4. rejected 源仍被 nav 引用
  const rejected = new Set((sourcesDoc.sources || []).filter((s) => s.status === 'rejected').map((s) => s.sourceId));
  for (const n of navDoc.items || []) {
    for (const sid of n.sourceIds || []) {
      if (rejected.has(sid)) add('rejected-source-referenced', 'critical', n.navId, `引用了 rejected 源 ${sid}`);
    }
  }

  // 5. 样式 token 漂移（site 已填充后应与 manifest.theme 一致）
  if (site.styleTokens && manifest.theme) {
    for (const key of ['primary', 'accent', 'radius', 'font']) {
      if (site.styleTokens[key] && manifest.theme[key] && site.styleTokens[key] !== manifest.theme[key]) {
        add('style-token-drift', 'info', key, `site=${site.styleTokens[key]} manifest=${manifest.theme[key]}`);
      }
    }
  }

  // 6. 信源判据统计漂移（实际 vs state）
  const l1 = (sourcesDoc.sources || []).filter((s) => s.grade === 'L1' && s.status === 'approved').length;
  const l2Domains = new Set((sourcesDoc.sources || []).filter((s) => s.grade === 'L2' && s.status === 'approved').map((s) => s.domain)).size;
  if (state.sources && (state.sources.l1 !== l1 || state.sources.independentL2 !== l2Domains)) {
    add('source-count-drift', 'warn', 'state.sources', `state(l1=${state.sources.l1},l2=${state.sources.independentL2}) vs 实际(l1=${l1},l2=${l2Domains})`);
  }

  return {
    schema: 'alerts/v1',
    generatedAt: new Date().toISOString(),
    checks: DRIFT_KINDS.length,
    alertCount: alerts.length,
    alerts,
    _comment: '树/信源/规则一致性校验；只告警不阻断。critical 需人工关注，info 仅提示。'
  };
}
