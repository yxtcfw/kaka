// Blog 文章创作：判据②达标后，按 content tree 节点 + 信源生成 bundle → 六道门禁 → 存 articles.json。
// AI 只写组织/推荐语；数字必须指回 citation；门禁至少拦下一次才算判据③达标。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { runGates } from './lib/gates.js';
import { composeBundle, composeBrief } from './lib/llm.js';
import { buildFactSheet, rankSourcesForNode, buildMaterialPack, factSheetDigest, loadFactConfig } from './lib/fact-sheet.js';
import { checkContentQuality, loadQualityConfig } from './lib/content-gates.js';
import { loadState, saveState, recordRun, sourcesPassed, contentPassed } from './lib/state.js';
import { makeSnapshots } from './lib/snapshot.js';
import { atomicWriteJson } from './lib/util.js';
import { loadExclusions, isBannedDomain } from './lib/exclusions.js';

// 低质产出护栏：模板式标题、无关领域措辞、过短正文一律不直接写入。
// 命中时用「节点主题 + 已登记信源」生成确定性安全正文，不编造数值。
function qualityFailure(bundle, rules) {
  const title = String(bundle?.title || '');
  const body = String(bundle?.body || '');
  // 字数硬下限可配置为 0：此时只由内容质量门禁的信息密度判优劣，不逼模型注水。
  const minChars = Number(rules.minBodyChars || 0);
  if (minChars > 0 && body.length < minChars) return 'body-too-short';
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
  let briefCfg = {};
  try { briefCfg = readJson(path.join(root, 'config/article-briefs.json')); } catch { /* 无配置时确定性命题卡 */ }
  const factCfg = loadFactConfig(root);
  const qualityCfg = loadQualityConfig(root);
  const protectedOrigins = new Set(Array.isArray(articleRules.protectedOrigins) ? articleRules.protectedOrigins : ['manual']);
  const tree = readJson(path.join(root, 'data/tree.json'));
  const sourcesDoc = readJson(path.join(root, 'data/sources.json'));
  const sources = sourcesDoc.sources;
  // 事实清单：信源给事实，AI 不得引入清单外的数字。
  let navDoc = { items: [] };
  try { navDoc = readJson(path.join(root, 'data/navlinks.json')); } catch { /* 无卡片时仅用信源原文 */ }
  const factSheet = buildFactSheet(root, sourcesDoc, navDoc, factCfg);
  // 命题卡落盘后复用：一次性自由、版本锁定；后续运行不再重新生成，渲染确定。
  let briefDoc = { schema: 'briefs/v1', briefs: {} };
  try { briefDoc = readJson(path.join(root, 'data/briefs.json')); } catch { /* 首次运行新建 */ }
  const briefOverrides = briefCfg.overrides || {};
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
  const briefGenerated = [], briefReused = [], qualityRejects = [], skippedNoMaterial = [];
  let gateBlockedCount = 0;

  for (const node of targetNodes.slice(0, limit)) {
    // 人工文章对应节点直接跳过：不调用模型、不产出覆盖稿，旧文原样保留。
    if (protectedNodeIds.has(node.id)) { skippedProtected.push(node.id); continue; }

    // 第一层：树出命题卡。人工 overrides > 已落盘（复用）> AI 生成（一次性自由）。
    let brief = briefOverrides[node.id] || briefDoc.briefs[node.id] || null;
    if (!brief) {
      const ranked0 = rankSourcesForNode(node, sourcesDoc, navDoc, factCfg).slice(0, Number(factCfg.sourcesPerNode || 3));
      const made = await composeBrief(provider, {
        node, label: node.label, topic: node.topic || node.label, keywords: node.keywords || [],
        parentTitle: nodeById.get(node.parent)?.label || '',
        sourceTitles: ranked0.map((s) => s.title)
      }, { ...(args.llmOpts || {}), prompts: briefCfg });
      brief = made.brief;
      briefDoc.briefs[node.id] = {
        ...brief, generatedAt: new Date().toISOString().slice(0, 10),
        _meta: made.meta, promptVersion: briefCfg.promptVersion || ''
      };
      briefGenerated.push(node.id);
      if (made.meta?.model) usedModels.add(made.meta.model);
    } else briefReused.push(node.id);

    // 第二层：信源按节点关键词相关性打分选取，取代旧的「按未用顺序取下一篇」。
    const approvedIds = new Set(approved.map((s) => s.sourceId));
    const ranked = rankSourcesForNode(node, sourcesDoc, navDoc, factCfg).filter((s) => approvedIds.has(s.sourceId));
    const cites = ranked.slice(0, Number(factCfg.sourcesPerNode || 3));
    const cite = cites[0] || approved[0];
    if (!cite) break;
    const sourceIds = [...new Set(cites.map((s) => s.sourceId))];
    const pack = buildMaterialPack(node, cites, factSheet, factCfg);
    const facts = [...new Map((factSheet.facts || [])
      .filter((f) => sourceIds.includes(f.sourceId)).map((f) => [f.factId, f])).values()];
    // 素材前置检查：节点没有可核验的具体事实时，直接跳过，不调用模型。
    // 方案原则：素材不足时放开自由，产出会从「含糊」变成「编造」，危害更大。
    const minFacts = Number(factCfg.minFactsPerNode || 0);
    if (minFacts > 0 && (facts.length < minFacts || (!pack.pitfall && !pack.surprisingNumber))) {
      skippedNoMaterial.push({ nodeId: node.id, facts: facts.length, pitfall: !!pack.pitfall, surprising: !!pack.surprisingNumber });
      qualityFallbacks.push({ nodeId: node.id, reason: 'no-material', action: 'skipped-kept-old' });
      continue;
    }
    const factText = factSheetDigest({ facts }, pack, factCfg, Number(promptCfg.sourceDigestChars || 4000));

    // 第三层：AI 只做表达。命题卡+事实清单同时注入，标题候选由程序打分选定。
    // 第四层：门禁失败先打回重写（失败项回灌），仍不过才跳过；不写兜底模板。
    let bundle, qFail, quality;
    let reviewNotes = '';
    const maxRewrites = Number(qualityCfg.maxRewrites || 0);
    for (let attempt = 0; attempt <= maxRewrites; attempt++) {
      bundle = await composeBundle(provider, {
        id: `article-${node.id}`,
        kind: 'article',
        title: node.topic || node.label,
        sourceIds,
        cardDesc: (pack.comparisons?.[0]?.title || node.label || '相关入口').slice(0, 60),
        links: [{ href: cite.url, rel: 'sponsored nofollow noopener', kind: 'outbound' }],
        byline: '',
        sourceDigest: cite.bodyExcerpt || '',
        brief, facts: factText,
        keywords: node.keywords || [],
        existingTitles: articles.map((a) => a.title),
        snapshotIds: sourceIds,
        reviewNotes
      }, { ...(args.llmOpts || {}), prompts: promptCfg });
      if (bundle._meta?.model) usedModels.add(bundle._meta.model);
      qFail = qualityFailure(bundle, articleRules);
      quality = checkContentQuality({
        body: bundle.body, brief, facts, cfg: qualityCfg
      }, {
        paragraphCount: bundle._meta?.paragraphCount,
        expectedParagraphs: promptCfg.paragraphs || 0
      });
      if (!qFail && quality.ok) break;
      if (attempt < maxRewrites) {
        const notes = [qFail, ...quality.failures.map((f) => `${f.gate}: ${f.detail}`)].filter(Boolean);
        reviewNotes = `上一稿未通过内容门禁，必须逐项修正：${notes.join('；')}。禁止并列清单、模糊词与无出处数字，文末须给明确判断。`;
      }
    }
    if (qFail || !quality.ok) {
      // n1 是历史兼容例外，其余节点质量不过一律跳过。
      if (node.id === 'n1' && qFail) {
        bundle = safeFallbackBundle(node, cite, bundle, displayTitle(node));
      } else {
        gateBlockedCount += 1;
        const reason = [qFail, ...quality.failures.map((f) => f.gate)].filter(Boolean).join('+');
        qualityFallbacks.push({ nodeId: node.id, reason, action: 'skipped-kept-old' });
        qualityRejects.push({ nodeId: node.id, reason, detail: quality.failures });
        continue;
      }
    }
    bundle.body = `${bundle.body}\n\n参考信源：${cites.map((s) => `${s.title}（${s.domain}）`).join('；')}。具体数值以官方实时页面为准。`;
    const gate = runGates(bundle, { root, sources, corpus });
    if (gate.ok) {
      generated.push({
        id: bundle.id, title: bundle.title, nodeId: node.id, body: bundle.body,
        sourceId: cite.sourceId, citationIds: sourceIds,
        citations: bundle.citations, links: bundle.links,
        titleCandidates: bundle.titleCandidates || [],
        generation: {
          promptVersion: bundle._meta?.promptVersion || '',
          modelVersion: bundle._meta?.model || '',
          snapshotIds: sourceIds,
          briefPromptVersion: brief._meta?.promptVersion || ''
        },
        generatedAt: new Date().toISOString().slice(0, 10)
      });
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
  const report = { stage: 'write-content', provider, generated: generated.length, blocked: blocked.length, gateBlockedCount, contentPassed: state.content.passed, models: [...usedModels], deduped: articles.length + generated.length - mergedArticles.length, skippedNodes, skippedProtected, protectedIds: [...protectedIds], bannedDomains: [...bannedDomains], blockedDetail: blocked, regeneratedIds, qualityFallbacks, briefGenerated, briefReused, factCount: factSheet.facts.length, qualityRejects, skippedNoMaterial };

  if (!args.dryRun) {
    makeSnapshots(root, `before-writecontent-${Date.now()}`);
    if (briefGenerated.length) atomicWriteJson(path.join(root, 'data/briefs.json'), briefDoc);
    atomicWriteJson(path.join(root, 'data/articles.json'), { schema: 'articles/v1', articles: mergedArticles });
    recordRun(state, { stage: 'write-content', provider, summary: `生成 ${generated.length}, 拦截 ${gateBlockedCount}`, inputs: targetNodes.map((n) => n.id).slice(0, 10) });
    saveState(state, root);
    writeJson(path.join(root, 'reports', 'write-content.json'), report);
  }
  return report;
}
