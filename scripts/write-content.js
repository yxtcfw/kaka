// Blog 文章创作：判据②达标后，按 content tree 节点 + 信源生成 bundle → 六道门禁 → 存 articles.json。
// AI 只写组织/推荐语；数字必须指回 citation；门禁至少拦下一次才算判据③达标。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { runGates } from './lib/gates.js';
import { composeBundle } from './lib/llm.js';
import { loadState, saveState, recordRun, sourcesPassed, contentPassed } from './lib/state.js';
import { makeSnapshots } from './lib/snapshot.js';
import { atomicWriteJson } from './lib/util.js';
import { loadExclusions, isBannedDomain } from './lib/exclusions.js';

// 低质产出护栏：模板式标题、无关领域措辞、过短正文一律不直接写入。
// 命中时用「节点主题 + 已登记信源」生成确定性安全正文，不编造数值。
function qualityFailure(bundle, rules) {
  const title = String(bundle?.title || '');
  const body = String(bundle?.body || '');
  if (body.length < Number(rules.minBodyChars || 120)) return 'body-too-short';
  if ((rules.bannedTitlePatterns || []).some((p) => { try { return new RegExp(p).test(title); } catch { return false; } })) return 'banned-title';
  if ((rules.bannedBodyPhrases || []).some((p) => body.includes(p))) return 'banned-body-phrase';
  return '';
}

function safeFallbackBundle(node, cite, base, displayTitle) {
  const topic = String(node.topic || '').trim();
  const label = String(node.label || '').trim();
  const title = displayTitle || topic || label || base.title;
  const keywords = (node.keywords || []).slice(0, 8).join('、');
  const key = keywords || label || title;
  const focus = title;
  const body = `${focus}（${label || title}）。围绕「${focus}」整理：${focus}的办理要点、${focus}的资费口径、${focus}的适用限制。资料来源：${cite.title}（${cite.domain}）。涉及${focus}的数值以运营商官方实时页面为准，未写明的条款不作推断。归类词：${key}。`.slice(0, 600);
  return { ...base, title, body, intro: [{ title: '', text: body }], cardDesc: `${title}的办理与选购核对要点。`, claims: [] };
}

export async function runWriteContent(root = ROOT, args = {}) {
  const manifest = readJson(path.join(root, 'config/manifest.json'));
  // 示例/占位内容排除规则（与 discover/fetch-body/build-nav-pages 共用，文件缺失退化为空规则）。
  const { bannedDomains, skipNodeIds } = loadExclusions(root);
  let articleRules = {};
  try { articleRules = readJson(path.join(root, 'config/article-rules.json')); } catch { /* 无规则时退化为仅门禁 */ }
  let promptCfg = {};
  try { promptCfg = readJson(path.join(root, 'config/article-prompts.json')); } catch { /* 无配置时用 llm.js 内置提示词 */ }
  const protectedOrigins = new Set(Array.isArray(articleRules.protectedOrigins) ? articleRules.protectedOrigins : ['manual']);
  const tree = readJson(path.join(root, 'data/tree.json'));
  const sourcesDoc = readJson(path.join(root, 'data/sources.json'));
  const sources = sourcesDoc.sources;
  const state = loadState(root);
  const provider = manifest.providers?.llm || 'mock';

  if (!sourcesPassed(state, manifest)) {
    return { stage: 'write-content', skipped: true, reason: '判据②未达标：信源不足（1×L1 或 2×独立 L2）' };
  }

  const approved = sources.filter((s) => {
    if (s.status !== 'approved' || (s.bodyExcerpt || '').length < 50) return false;
    // 禁用示例/占位域名信源，避免示例内容反复产出。
    return !isBannedDomain(s.domain || s.url, bannedDomains);
  });
  // 跳过规则明确排除的节点（如初始示例节点 n1）。
  const nodes = tree.nodes.filter((n) => n.children !== undefined && !skipNodeIds.has(n.id));
  let articles = [];
  try { articles = readJson(path.join(root, 'data/articles.json')).articles || []; } catch { /* ignore */ }
  // 人工文章保护：origin 命中 protectedOrigins 的文章永不覆盖、不为它重新生成。
  // 保护优先于 forceRegenerate：即使被误列入强制名单也不动人工稿。
  const protectedIds = new Set(articles.filter((a) => protectedOrigins.has(a.origin || '')).map((a) => a.id));
  const protectedNodeIds = new Set(articles.filter((a) => protectedIds.has(a.id)).map((a) => a.nodeId).filter(Boolean));
  articles = articles.filter((a) => !protectedIds.has(a.id));
  // 人工指定的低质节点：下一轮丢弃旧文章重生成（规则进 git 可审计）。
  const forceIds = new Set((articleRules.forceRegenerateNodeIds || []).map((id) => `article-${id}`));
  const regeneratedIds = articles.filter((a) => forceIds.has(a.id)).map((a) => a.id);
  // --only-force：仅重生成规则点名的低质节点，不覆盖其他已经合格的文章。
  const targetNodes = args.onlyForce && forceIds.size
    ? nodes.filter((n) => forceIds.has(`article-${n.id}`))
    : nodes;
  articles = articles.filter((a) => !forceIds.has(a.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // 容器节点可能仍以 auto-xxx 作标题，展示名改由子节点的真实标签拼出，不把内部 ID 上屏。
  const displayTitle = (node) => {
    const raw = [node.topic, node.label].filter((x) => x && !/^auto-/.test(String(x)));
    if (raw.length) return String(raw[0]);
    const kids = (node.children || []).map((id) => nodeById.get(id)?.label).filter((x) => x && !/^auto-/.test(String(x)));
    return kids.length ? `场景卡种（${kids.slice(0, 3).join('、')}）` : '相关选购专题';
  };
  const corpus = articles.map((a) => ({ id: a.id, title: a.title, body: a.body || '' }));

  const limit = Number(args.limit || Math.min(targetNodes.length, 5));
  const generated = [], blocked = [];
  const usedModels = new Set();
  const qualityFallbacks = [];
  const skippedProtected = [];
  let gateBlockedCount = 0;

  for (const node of targetNodes.slice(0, limit)) {
    // 人工文章对应节点直接跳过：不调用模型、不产出覆盖稿，旧文原样保留。
    if (protectedNodeIds.has(node.id)) { skippedProtected.push(node.id); continue; }
    // 每个节点选一篇可用信源做引用
    const cite = approved.find((s) => !generated.some((g) => g.sourceId === s.sourceId)) || approved[0];
    if (!cite) break;
    let bundle = await composeBundle(provider, {
      id: `article-${node.id}`,
      kind: 'article',
      title: node.topic || node.label,
      sourceIds: [cite.sourceId],
      cardDesc: `${node.label}相关资料整理与选购参考。`,
      links: [{ href: cite.url, rel: 'sponsored nofollow noopener', kind: 'outbound' }],
      byline: '',
      // 全文摘录透传给模型：没有资料就只能写模板，这是低质覆盖的根因。
      sourceDigest: cite.bodyExcerpt || ''
    }, { ...(args.llmOpts || {}), prompts: promptCfg });
    if (bundle._meta?.model) usedModels.add(bundle._meta.model);
    const qFail = qualityFailure(bundle, articleRules);
    if (qFail) {
      // 质量不过就跳过：宁可没有新稿，也不用兜底模板覆盖已有文章。
      // n1 是历史兼容例外（初始示例节点），保留原有回退语义。
      if (node.id === 'n1') {
        bundle = safeFallbackBundle(node, cite, bundle, displayTitle(node));
      } else {
        // 质量门禁拦截同样计入 gateBlocked（判据③语义：至少一道门禁真正拦下一次）。
        gateBlockedCount += 1;
        qualityFallbacks.push({ nodeId: node.id, reason: qFail, action: 'skipped-kept-old' });
        continue;
      }
    }
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

  // 按 id 合并去重：同一节点重复运行只保留最新一篇，避免 articles 无限累积。
  // 人工文章在此步放回，且生成物不得覆盖同名 id（双保险）。
  const byId = new Map(articles.map((a) => [a.id, a]));
  for (const g of generated) if (!protectedIds.has(g.id)) byId.set(g.id, g);
  const manualArticles = [];
  try {
    for (const a of (readJson(path.join(root, 'data/articles.json')).articles || [])) {
      if (protectedIds.has(a.id)) manualArticles.push(a);
    }
  } catch { /* ignore */ }
  const mergedArticles = [...manualArticles, ...byId.values()];
  const totalArticles = mergedArticles.length;
  state.content = {
    generated: totalArticles,
    gateBlocked: (state.content.gateBlocked || 0) + gateBlockedCount,
    passed: contentPassed({ ...state, content: { generated: totalArticles, gateBlocked: (state.content.gateBlocked || 0) + gateBlockedCount } }, manifest)
  };

  const skippedNodes = tree.nodes.filter((n) => skipNodeIds.has(n.id)).map((n) => n.id);
  const report = { stage: 'write-content', provider, generated: generated.length, blocked: blocked.length, gateBlockedCount, contentPassed: state.content.passed, models: [...usedModels], deduped: articles.length + generated.length - mergedArticles.length, skippedNodes, skippedProtected, protectedIds: [...protectedIds], bannedDomains: [...bannedDomains], blockedDetail: blocked, regeneratedIds, qualityFallbacks };

  if (!args.dryRun) {
    makeSnapshots(root, `before-writecontent-${Date.now()}`);
    atomicWriteJson(path.join(root, 'data/articles.json'), { schema: 'articles/v1', articles: mergedArticles });
    recordRun(state, { stage: 'write-content', provider, summary: `生成 ${generated.length}, 拦截 ${gateBlockedCount}`, inputs: targetNodes.map((n) => n.id).slice(0, 10) });
    saveState(state, root);
    writeJson(path.join(root, 'reports', 'write-content.json'), report);
  }
  return report;
}
