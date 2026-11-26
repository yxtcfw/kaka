// 预设 nav 自动补详情页（v7 §1.4A）：
//   - 只处理预设 nav（data/navlinks.json），不凭空生成
//   - 有正文才生成；无正文 → 保持 hasContent=false → 列表直跳，不生成空壳页
//   - 详情页与 blog 共用六道门禁，不豁免；不过闸 → 降级列表直跳 + 判据写 reports
//   - AI 只写推荐语/组织，正文事实来自真实信源；promoUrl 由人工填，脚本不覆盖
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { runGates } from './lib/gates.js';
import { composeBundle } from './lib/llm.js';
import { loadState, saveState, recordRun, contentPassed } from './lib/state.js';
import { makeSnapshots } from './lib/snapshot.js';
import { atomicWriteJson, extractNumbers } from './lib/util.js';

// bodyKind 判定：nav 关联的 sourceIds 中存在 approved + 有正文摘录的源才算有正文。
function hasBody(sourceIds, sources) {
  const byId = new Map(sources.map((s) => [s.sourceId, s]));
  return sourceIds.map((id) => byId.get(id)).filter(Boolean)
    .some((s) => s.status === 'approved' && s.bodyKind !== 'none' && (s.bodyExcerpt || '').length >= 20);
}

export async function runBuildNavPages(root = ROOT, args = {}) {
  const manifest = readJson(path.join(root, 'config/manifest.json'));
  const navDoc = readJson(path.join(root, 'data/navlinks.json'));
  const sourcesDoc = readJson(path.join(root, 'data/sources.json'));
  const sources = sourcesDoc.sources;
  const byId = new Map(sources.map((s) => [s.sourceId, s]));
  const provider = manifest.providers?.llm || 'mock';

  // 语料库（供重复闸）：已有文章
  let corpus = [];
  try { corpus = readJson(path.join(root, 'data/articles.json')).articles || []; } catch { /* ignore */ }

  const pages = [];
  const downgraded = [];
  let blockedCount = 0;

  for (const nav of navDoc.items) {
    const withBody = hasBody(nav.sourceIds || [], sources);
    if (!withBody) {
      // 无正文：保持列表直跳，不生成详情页
      nav.hasContent = false;
      downgraded.push({ navId: nav.navId, reason: 'no-body', detail: '无可用正文，列表直跳，不生成空壳页' });
      continue;
    }

    // 出站链接：promoUrl 优先（人工填），否则原链接；rel 固定合规值
    const outbound = nav.promoUrl || nav.url;
    const links = [{ href: outbound, rel: 'sponsored nofollow noopener', kind: nav.promoUrl ? 'promo' : 'outbound' }];

    // 引用源：必须 approved、非 rejected
    const citeIds = (nav.sourceIds || []).filter((id) => {
      const s = byId.get(id);
      return s && s.status === 'approved';
    });

    const bundle = await composeBundle(provider, {
      id: `nav-${nav.navId}`,
      kind: 'nav-detail',
      title: nav.title,
      sourceIds: citeIds,
      cardDesc: nav.cardDesc || nav.description || '',
      toc: ['简介', '核对过的入口', '说明'],
      links,
      byline: ''
    }, args.llmOpts || {});
    // 正文事实锚定真实信源：模型只写组织语，信源摘录始终作为正文主体。
    const sourceBody = citeIds.map((id) => byId.get(id)?.bodyExcerpt).filter(Boolean).join('\n\n');
    bundle.body = sourceBody ? `${bundle.body}\n\n${sourceBody}` : bundle.body;

    // 数字归属：从真实信源正文抽数字，逐条绑定 citationId（事实闸要求每个数字指回 citation）。
    // 若 nav 显式带 detailClaims（人工/上游预制主张），以其为准并保留其 citationIds——
    // 故意造「数字无 citation」的 nav 会在此被事实闸拦下并降级（v7 阶段 2.2b 验收）。
    if (Array.isArray(nav.detailClaims) && nav.detailClaims.length) {
      bundle.claims = nav.detailClaims;
    } else {
      bundle.claims = [];
      for (const src of citeIds.map((id) => byId.get(id)).filter(Boolean)) {
        for (const n of new Set(extractNumbers(src.bodyExcerpt || ''))) {
          bundle.claims.push({ text: `${src.title} 数值 ${n}`, citationIds: [src.sourceId] });
        }
      }
    }

    const gate = runGates(bundle, { root, sources, corpus });

    if (gate.ok) {
      nav.hasContent = true;
      pages.push({ navId: nav.navId, bundleId: bundle.id, title: nav.title, outbound, gates: gate.results.map((r) => r.gate) });
    } else {
      // 不过闸：降级列表直跳，判据写报告，不阻断整站
      nav.hasContent = false;
      blockedCount += gate.blockers.length;
      downgraded.push({ navId: nav.navId, reason: 'gate-blocked', blockers: gate.blockers });
    }
  }

  const state = loadState(root);
  state.content.gateBlocked = (state.content.gateBlocked || 0) + blockedCount;
  state.navPages = { built: pages.length, downgraded: downgraded.length };
  state.content.passed = contentPassed({ ...state, content: { ...state.content, generated: state.content.generated || pages.length } }, manifest);

  const report = {
    stage: 'build-nav-pages', provider, built: pages.length,
    downgraded: downgraded.length, blockedCount, pages, downgradedDetail: downgraded
  };

  if (!args.dryRun) {
    makeSnapshots(root, `before-navpages-${Date.now()}`);
    atomicWriteJson(path.join(root, 'data/navlinks.json'), navDoc);
    atomicWriteJson(path.join(root, 'data/nav-details.json'), { schema: 'nav-details/v1', pages });
    recordRun(state, { stage: 'build-nav-pages', provider, summary: `详情 ${pages.length}, 降级 ${downgraded.length}, 门禁拦截 ${blockedCount}`, inputs: navDoc.items.map((n) => n.navId) });
    saveState(state, root);
    writeJson(path.join(root, 'reports', 'build-nav-pages.json'), report);
  }
  return report;
}
