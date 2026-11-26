import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeRoot, cleanup, readJson, writeJson } from './helper.js';
import path from 'node:path';
import { runHarvest } from '../scripts/harvest.js';
import { runGrowTree } from '../scripts/grow-tree.js';
import { runDiscover } from '../scripts/discover-sources.js';
import { runFetchBody } from '../scripts/fetch-body.js';
import { runWriteContent } from '../scripts/write-content.js';
import { runFillSite } from '../scripts/fill-site.js';
import { runBuildNavPages } from '../scripts/build-nav-pages.js';
import { runBuild } from '../scripts/build.js';
import { sourcesPassed, signalsPassed, contentPassed } from '../scripts/lib/state.js';

test('harvest: 两轮采集收敛，判据①达标', () => {
  const root = makeRoot();
  try {
    const r1 = runHarvest(root, {});
    const r2 = runHarvest(root, {});
    assert.ok(r1.count >= 300, `词量 ${r1.count}`);
    assert.ok(r1.sources >= 2, `源数 ${r1.sources}`);
    assert.equal(r1.passed, false);
    assert.equal(r2.newRate, 0);
    assert.equal(r2.passed, true);
    const state = readJson(root, 'state.json');
    const manifest = readJson(root, 'config/manifest.json');
    assert.equal(signalsPassed(state, manifest), true);
    assert.equal(readJson(root, 'data/signals.json').items.length, r2.count);
  } finally { cleanup(root); }
});

test('harvest dry-run 零写盘', () => {
  const root = makeRoot();
  try {
    const before = readJson(root, 'state.json');
    runHarvest(root, { dryRun: true });
    assert.deepEqual(readJson(root, 'state.json'), before);
    assert.equal(fs.existsSync(path.join(root, 'data/signals.json')), false);
  } finally { cleanup(root); }
});

test('grow-tree: 幂等且按映射扩展关键词，不改节点数', async () => {
  const root = makeRoot();
  try {
    runHarvest(root, {}); runHarvest(root, {});
    const r = await runGrowTree(root, {});
    assert.equal(r.idempotent, true);
    assert.ok(r.keywordsAdded > 0);
    const beforeCount = readJson(root, 'data/tree.json').nodes.length;
    assert.equal(beforeCount, r.nodes);
  } finally { cleanup(root); }
});

test('discover→fetch-body: 搜索候选默认 L3，不自动升 L1/L2', async () => {
  const root = makeRoot();
  try {
    // 本测试验证分级语义；fixture 用 example.* 作占位域名，显式清空排除规则。
    writeJson(root, 'config/article-rules.json', { schema: 'article-rules/v1', skipNodeIds: [], bannedDomains: [] });
    runHarvest(root, {}); runHarvest(root, {});
    await runDiscover(root, { limit: 12 });
    const before = new Set(readJson(root, 'data/sources.json').sources.map((s) => s.sourceId));
    const r = await runFetchBody(root, {});
    assert.ok(r.fetched > 0);
    const sources = readJson(root, 'data/sources.json').sources;
    const fresh = sources.filter((s) => !before.has(s.sourceId) && s.discoveredBy === 'search');
    assert.ok(fresh.length > 0, '本轮应新增搜索来源');
    assert.ok(fresh.every((s) => s.grade === 'L3'), '本轮搜索候选必须 L3，不自动升级');
  } finally { cleanup(root); }
});

test('fetch-body: 判据②达标（L1 或 2 独立域 L2）', async () => {
  const root = makeRoot();
  try {
    await runDiscover(root, { limit: 10 });
    const r = await runFetchBody(root, {});
    assert.equal(r.sourcesPassed, true);
  } finally { cleanup(root); }
});

test('write-content: 判据②未达标时跳过', async () => {
  const root = makeRoot();
  try {
    const r = await runWriteContent(root, {});
    assert.equal(r.skipped, true);
  } finally { cleanup(root); }
});

test('write-content: 达标后生成并至少被门禁拦下一次（判据③）', async () => {
  const root = makeRoot();
  try {
    // 本测试验证门禁拦截语义，显式清空排除规则（fixture 用 example.com 作占位域名）。
    writeJson(root, 'config/article-rules.json', { schema: 'article-rules/v1', skipNodeIds: [], bannedDomains: [] });
    await runDiscover(root, { limit: 10 });
    await runFetchBody(root, {});
    const r = await runWriteContent(root, {});
    assert.ok(r.generated >= 1);
    assert.ok(r.gateBlockedCount >= 1, '门禁至少拦下一次');
    assert.equal(r.contentPassed, true);
    assert.ok(readJson(root, 'data/articles.json').articles.length >= 1);
  } finally { cleanup(root); }
});

test('write-content: 重复运行按 id 去重，articles 不累积', async () => {
  const root = makeRoot();
  try {
    writeJson(root, 'config/article-rules.json', { schema: 'article-rules/v1', skipNodeIds: [], bannedDomains: [] });
    await runDiscover(root, { limit: 10 });
    await runFetchBody(root, {});
    await runWriteContent(root, {});
    const first = readJson(root, 'data/articles.json').articles.length;
    const r2 = await runWriteContent(root, {});
    const second = readJson(root, 'data/articles.json').articles.length;
    assert.equal(second, first, '重复运行不应增加文章数');
    assert.ok(r2.deduped >= 1, '报告应记录去重条数');
  } finally { cleanup(root); }
});

test('write-content: skipNodeIds 排除的节点不产出文章，且示例域名信源不被引用', async () => {
  const root = makeRoot();
  try {
    // 默认规则来自 config/article-rules.json：skipNodeIds=[n1]，bannedDomains 含 example.com/net。
    await runDiscover(root, { limit: 10 });
    await runFetchBody(root, {});
    const r = await runWriteContent(root, {});
    const articles = readJson(root, 'data/articles.json').articles;
    assert.ok(r.skippedNodes.includes('n1'), '报告应记录被跳过的节点 n1');
    assert.ok(!articles.some((a) => a.id === 'article-n1'), 'n1 不应产出 article-n1');
    // 所有产出文章的引用信源域名不得是禁用域名。
    const sources = readJson(root, 'data/sources.json').sources;
    for (const a of articles) {
      const cite = sources.find((s) => s.sourceId === a.sourceId);
      if (cite) assert.ok(!['example.com', 'example.net', 'example.org'].some((b) => cite.domain === b || cite.domain.endsWith('.' + b)), `禁用域名被引用：${cite.domain}`);
    }
  } finally { cleanup(root); }
});

test('fill-site: 首次填空、保留人工值、二次冻结、清空不重填', () => {
  const root = makeRoot();
  try {
    // 人工预设 name 必须保留
    const site0 = readJson(root, 'data/site.json');
    site0.siteName = '人工站点名';
    writeJson(root, 'data/site.json', site0);

    const r1 = runFillSite(root, {});
    assert.equal(r1.skipped, false);
    assert.ok(r1.filled >= 5);
    const site1 = readJson(root, 'data/site.json');
    assert.equal(site1.siteName, '人工站点名', '人工值不被覆盖');
    assert.ok(site1.tagline, '空值被补齐');

    // 二次调用冻结跳过
    const r2 = runFillSite(root, {});
    assert.equal(r2.skipped, true);

    // 人工清空后重建也不重填
    const site2 = readJson(root, 'data/site.json');
    site2.tagline = '';
    writeJson(root, 'data/site.json', site2);
    const r3 = runFillSite(root, {});
    assert.equal(r3.skipped, true);
    assert.equal(readJson(root, 'data/site.json').tagline, '', '冻结后清空不重填');

    const audit = readJson(root, 'state/site-fill-audit.json');
    assert.ok(audit.audit.some((a) => a.field === 'siteName' && a.action === 'kept'));
  } finally { cleanup(root); }
});

test('build-nav-pages: 有关联源生成详情，数字无 citation 降级直跳', async () => {
  const root = makeRoot();
  try {
    // fixture 用 example.com 作占位域名，本测试验证门禁语义，显式清空排除规则。
    writeJson(root, 'config/article-rules.json', { schema: 'article-rules/v1', skipNodeIds: [], bannedDomains: [] });
    const nav = readJson(root, 'data/navlinks.json');
    nav.items.push({
      navId: 'nav-bad', title: '无引用测试', url: 'https://x.example/bad', category: '选购攻略',
      cardDesc: '测试', hasContent: false, sourceIds: ['src-001'],
      detailClaims: [{ text: '月租仅9.9元超长描述用于触发事实闸拦截逻辑', citationIds: [] }]
    });
    writeJson(root, 'data/navlinks.json', nav);

    const r = await runBuildNavPages(root, {});
    assert.equal(r.built, 2, '两条正常 nav 生成详情');
    assert.equal(r.downgraded, 1);
    assert.ok(r.blockedCount >= 1);
    const bad = r.downgradedDetail.find((d) => d.navId === 'nav-bad');
    assert.ok(bad && bad.blockers.some((b) => b.gate === 'fact'));

    const navAfter = readJson(root, 'data/navlinks.json');
    assert.equal(navAfter.items.find((n) => n.navId === 'nav-bad').hasContent, false, '降级后列表直跳');
    assert.equal(navAfter.items.find((n) => n.navId === 'nav-001').hasContent, true);
  } finally { cleanup(root); }
});

test('build-nav-pages: 无正文的 nav 不生成空壳页', async () => {
  const root = makeRoot();
  try {
    // 本测试验证「无正文不建页」，需先放行 fixture 的 example.com 占位域，单独验证排除语义见下例。
    writeJson(root, 'config/article-rules.json', { schema: 'article-rules/v1', skipNodeIds: [], bannedDomains: [] });
    const nav = readJson(root, 'data/navlinks.json');
    for (const it of nav.items) it.sourceIds = [];
    writeJson(root, 'data/navlinks.json', nav);
    const r = await runBuildNavPages(root, {});
    assert.equal(r.built, 0);
    assert.equal(r.downgraded, 2);
    assert.ok(r.downgradedDetail.every((d) => d.reason === 'no-body'));
  } finally { cleanup(root); }
});

test('build: 产物齐全 + sitemap 显式枚举，无空壳页', async () => {
  const root = makeRoot();
  try {
    // 同上：fixture 用 example.com 占位，本测试验证产物结构，显式放行；示例域排除见新用例。
    writeJson(root, 'config/article-rules.json', { schema: 'article-rules/v1', skipNodeIds: [], bannedDomains: [] });
    runFillSite(root, {});
    await runBuildNavPages(root, {});
    const r = runBuild(root, {});
    assert.ok(r.pages >= 1);
    for (const f of ['_site/index.html', '_site/assets/site.css', '_site/sitemap.xml', '_site/robots.txt']) {
      assert.equal(fs.existsSync(path.join(root, f)), true, `缺少 ${f}`);
    }
    const sitemap = fs.readFileSync(path.join(root, '_site/sitemap.xml'), 'utf8');
    assert.ok(sitemap.includes('https://example.com/'));
    assert.ok(sitemap.includes('/nav/nav-001.html'));
    // sitemap 条目数 == 报告页数（显式枚举，不依赖 collections）
    assert.equal((sitemap.match(/<url>/g) || []).length, r.pages);
  } finally { cleanup(root); }
});

// ---- 示例/占位域名全产线排除（批次 1 · 根治示例复活） ----

test('discover: mock 产出的 example.* 候选被挡在 discovered.json 之外', async () => {
  const root = makeRoot();
  try {
    runHarvest(root, {}); runHarvest(root, {});
    const r = await runDiscover(root, { limit: 10 });
    assert.ok(r.bannedFiltered > 0, '报告应记录被过滤的示例域候选');
    const doc = readJson(root, 'data/discovered.json');
    assert.equal(doc.candidates.length, 0, '默认规则下示例域候选不得入库');
    assert.deepEqual(doc.candidates, []);
  } finally { cleanup(root); }
});

test('fetch-body: 旧 discovered.json 里的示例域候选不会进入 sources', async () => {
  const root = makeRoot();
  try {
    // 模拟旧版本写入的 discovered.json（含 example.* 候选，无 degraded 标记）。
    writeJson(root, 'data/discovered.json', {
      schema: 'discovered/v1', provider: 'mock', degraded: false,
      queryTerms: ['流量卡'], discoveredAt: new Date().toISOString(),
      candidates: [
        { url: 'https://example.org/a/流量卡', title: '示例资料页', snippet: '示例' },
        { url: 'https://news.example.net/a/副卡', title: '示例资料页', snippet: '示例' }
      ]
    });
    const before = readJson(root, 'data/sources.json').sources.length;
    const r = await runFetchBody(root, {});
    assert.equal(r.bannedFiltered, 2);
    assert.equal(r.fetched, 0);
    assert.equal(readJson(root, 'data/sources.json').sources.length, before, 'sources 不应新增示例源');
  } finally { cleanup(root); }
});

test('build-nav-pages: 示例域 nav 不生成详情页，列表出口不受影响', async () => {
  const root = makeRoot();
  try {
    const r = await runBuildNavPages(root, {});
    assert.equal(r.built, 0, '默认规则下两条示例 nav 均不得生成详情');
    assert.equal(r.bannedNavCount, 2);
    assert.ok(r.downgradedDetail.every((d) => d.reason === 'banned-domain'));
    const nav = readJson(root, 'data/navlinks.json');
    assert.ok(nav.items.every((n) => n.hasContent === false), '仍为列表直跳');
    assert.ok(nav.items.every((n) => n.url && n.url.startsWith('https://')), '人工出口未被脚本改写');
  } finally { cleanup(root); }
});

test('build: nav 详情清空时主动删除旧 _site/nav 产物', async () => {
  const root = makeRoot();
  try {
    writeJson(root, 'config/article-rules.json', { schema: 'article-rules/v1', skipNodeIds: [], bannedDomains: [] });
    runFillSite(root, {});
    await runBuildNavPages(root, {});
    runBuild(root, {});
    assert.equal(fs.existsSync(path.join(root, '_site/nav/nav-001.html')), true, '前置：详情页已生成');

    // 清空详情数据（等同示例清理后的状态），再构建。
    writeJson(root, 'data/nav-details.json', { schema: 'nav-details/v1', pages: [] });
    runBuild(root, {});
    assert.equal(fs.existsSync(path.join(root, '_site/nav')), false, '旧详情目录必须被清除，避免示例页残留线上');
    const sitemap = fs.readFileSync(path.join(root, '_site/sitemap.xml'), 'utf8');
    assert.ok(!sitemap.includes('/nav/'), 'sitemap 不应再列出已清空的详情页');
  } finally { cleanup(root); }
});
