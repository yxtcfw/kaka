import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeRoot, cleanup, readJson, writeJson, REPO } from './helper.js';
import path from 'node:path';
import { runHarvest } from '../scripts/harvest.js';
import { runGrowTree } from '../scripts/grow-tree.js';
import { runDiscover } from '../scripts/discover-sources.js';
import { runFetchBody } from '../scripts/fetch-body.js';
import { runWriteContent } from '../scripts/write-content.js';
import { runFillSite } from '../scripts/fill-site.js';
import { runBuildNavPages } from '../scripts/build-nav-pages.js';
import { runBuild, splitIntroParagraphs } from '../scripts/build.js';
import { sourcesPassed, signalsPassed, contentPassed } from '../scripts/lib/state.js';

test('harvest: 两轮采集收敛，判据①达标', async () => {
  const root = makeRoot();
  try {
    const r1 = await runHarvest(root, {});
    const r2 = await runHarvest(root, {});
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

test('harvest dry-run 零写盘', async () => {
  const root = makeRoot();
  try {
    const before = readJson(root, 'state.json');
    await runHarvest(root, { dryRun: true });
    assert.deepEqual(readJson(root, 'state.json'), before);
    assert.equal(fs.existsSync(path.join(root, 'data/signals.json')), false);
  } finally { cleanup(root); }
});

test('grow-tree: 幂等且按映射扩展关键词，不改节点数', async () => {
  const root = makeRoot();
  try {
    runHarvest(root, {}); runHarvest(root, {});
    // 新节奏门槛：测试 fixture 词量小，显式达标并放低阈值以保留原测试意图。
    const st = readJson(root, 'state.json');
    st.signals = { count: 300, sources: 2, newRate: 0.05, passed: true };
    writeJson(root, 'state.json', st);
    writeJson(root, 'rules/tree-cadence.json', { schema: 'rules/tree-cadence/v1', growThreshold: { minUncoveredTerms: 0, minUnmappedTerms: 0, requireSignalsPassed: true } });
    const r = await runGrowTree(root, {});
    assert.equal(r.skipped, false);
    assert.equal(r.idempotent, true);
    assert.ok(r.keywordsAdded > 0);
    const beforeCount = readJson(root, 'data/tree.json').nodes.length;
    assert.equal(beforeCount, r.nodes);
  } finally { cleanup(root); }
});

test('pipeline: 周期维护在详情信源之后、页面创作之前', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts/cli.js'), 'utf8');
  const iDetails = src.indexOf('runSyncProductDetails(root, o)');
  const iMaint = src.indexOf('runMaintenance(root, o)');
  const iFill = src.indexOf('runFillSite(root, o)');
  assert.ok(iDetails > 0 && iMaint > iDetails && iFill > iMaint);
});

test('grow-tree: 自动新增节点带 origin 标记，重复运行不新增重复节点', async () => {
  const root = makeRoot();
  try {
    await runHarvest(root, {});
    const st = readJson(root, 'state.json');
    st.signals = { count: 300, sources: 2, newRate: 0.05, passed: true };
    writeJson(root, 'state.json', st);
    writeJson(root, 'rules/tree-cadence.json', { schema: 'rules/tree-cadence/v1', growThreshold: { minUncoveredTerms: 0, minUnmappedTerms: 0, requireSignalsPassed: true } });
    writeJson(root, 'rules/signals-tree.json', {
      schema: 'rules/signals-tree/v1',
      minTermsPerNode: 8, maxNodes: 24, maxDepth: 3, maxNewNodesPerRun: 2,
      mapping: { '资费|月租|流量|套餐': 'n1', '办理|开卡|实名|首充|攻略': 'n2' },
      autoNodePatterns: { '副卡专题': '副卡' },
      stopWords: [], minTermLength: 2, maxTermLength: 20
    });
    const r1 = await runGrowTree(root, {});
    assert.ok(r1.nodesAdded >= 1, '未命中词应触发自动新节点');
    const doc = readJson(root, 'data/tree.json');
    const autos = doc.nodes.filter((n) => n.origin === 'auto');
    assert.ok(autos.length >= 1);
    for (const n of autos) {
      assert.ok(n.id.startsWith('auto-'));
      assert.ok(n.parent === doc.root.id || doc.nodes.some((x) => x.id === n.parent));
      assert.ok(n.keywords.length > 0);
      assert.ok(doc.root.children.includes(n.id) || doc.nodes.some((x) => x.children.includes(n.id)));
    }
    const r2 = await runGrowTree(root, {});
    assert.equal(r2.nodesAdded, 0, '重复运行不得新增重复节点');
    assert.equal(readJson(root, 'data/tree.json').nodes.length, doc.nodes.length);
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

test('build: 卡片展示 API 客观规格并带 data-search 索引', async () => {
  const root = makeRoot();
  try {
    runFillSite(root, {});
    const nav = readJson(root, 'data/navlinks.json');
    Object.assign(nav.items[0], {
      productId: 1, isp: '广电',
      specs: {
        taocan: '29元192G套餐', nowPrice: '29', oldPrice: '39', tyLiuliang: '192',
        tonghua: '100', priceUnitStr: '月租费用', isSelectNum: '无需选号',
        isPhotos: '无需照片', age: '18-65', sales: '12345'
      }
    });
    writeJson(root, 'data/navlinks.json', nav);
    runBuild(root, {});
    const html = fs.readFileSync(path.join(root, '_site/index.html'), 'utf8');
    assert.match(html, /class="price">¥29/, '现价须上屏');
    assert.match(html, /<del>¥39<\/del>/, '与现价不同的原价须划线');
    assert.match(html, /通用192G/, '通用流量须上屏');
    assert.match(html, /通话100分钟/, '通话时长须上屏');
    assert.match(html, /无需选号/, '选号要求须上屏');
    assert.match(html, /销量12345/, '销量须上屏');
    assert.match(html, /data-search="[^"]*广电[^"]*192[^"]*"/, '搜索索引须含运营商与规格');
  } finally { cleanup(root); }
});

test('老字符串介绍兜底：禁发地区单列，不得并入「谁能办理」', () => {
  const raw = '测试卡：19元/月，150G通用流量，京东配送，快递激活。年龄18-24周岁，合约24个月，仅限重庆地区。信息转录自官方详情，具体资费以官方实时页面为准。';
  const segs = splitIntroParagraphs(raw);
  assert.deepEqual(segs.map((s) => s.title), ['套餐包含什么', '怎么办理', '谁能办理', '禁发地区', '']);
  assert.ok(!segs.find((s) => s.title === '谁能办理').text.includes('重庆'), '地区不得出现在办理条件里');
  assert.match(segs.find((s) => s.title === '禁发地区').text, /以下地区不办理：.*重庆/);
});

test('pipeline 编排：API 商品采集先于详情信源采集，再进入详情页创作', () => {
  const cli = fs.readFileSync(path.join(REPO, 'scripts/cli.js'), 'utf8');
  const p = cli.indexOf("case 'pipeline'");
  const end = cli.indexOf("case 'help'", p);
  const seg = cli.slice(p, end);
  const api = seg.indexOf('runSyncApiNav');
  const details = seg.indexOf('runSyncProductDetails');
  const navPages = seg.indexOf('runBuildNavPages');
  assert.ok(api >= 0 && details >= 0 && navPages >= 0, '三段都须在 pipeline 内');
  assert.ok(api < details, 'API 商品采集须先于详情信源采集');
  assert.ok(details < navPages, '详情信源采集须先于详情页创作');
});

test('已有详情页跳过：二次运行不重建、原页保留、skipped 计数正确', async () => {
  const root = makeRoot();
  try {
    writeJson(root, 'config/article-rules.json', { schema: 'article-rules/v1', skipNodeIds: [], bannedDomains: [] });
    const sources = readJson(root, 'data/sources.json');
    const official = '套餐资费：原套餐29元包192G通用流量\n配送方式：菜鸟\n激活方式：快递激活\n年龄要求：18-65周岁\n合约期限：12个月\n通用流量：192G\n月租费用：29元/月\n禁发地区：广东省,西藏自治区';
    sources.sources[0].sourceId = 'src-api-5260';
    sources.sources[0].title = '广电飞花卡 · 官方详情';
    sources.sources[0].grade = 'L1';
    sources.sources[0].status = 'approved';
    sources.sources[0].bodyKind = 'fulltext';
    sources.sources[0].bodyExcerpt = official;
    sources.sources[0].discoveredBy = 'collect';
    writeJson(root, 'data/sources.json', sources);
    const nav = readJson(root, 'data/navlinks.json');
    Object.assign(nav.items[0], {
      navId: 'api-5260', productId: 5260,
      url: 'https://lingqu.haokalingqu.cn/pdetails?tk=a&pro=b',
      promoUrl: 'https://lingqu.haokalingqu.cn/pdetails?tk=a&pro=b',
      sourceIds: ['src-api-5260'], hasContent: false
    });
    nav.items.splice(1);
    writeJson(root, 'data/navlinks.json', nav);

    const first = await runBuildNavPages(root, {});
    assert.equal(first.built, 1, '首轮须新建 1 页');
    assert.equal(first.skipped, 0, '首轮无跳过');
    const before = readJson(root, 'data/nav-details.json').pages[0];

    // 篡改信源正文：若有重建，intro 会变化；跳过语义下原页必须逐字保留。
    const s2 = readJson(root, 'data/sources.json');
    s2.sources[0].bodyExcerpt = '月租费用：99元/月\n通用流量：1G\n年龄要求：99周岁';
    writeJson(root, 'data/sources.json', s2);
    const second = await runBuildNavPages(root, {});
    assert.equal(second.built, 0, '次轮不应新建');
    assert.equal(second.skipped, 1, '次轮须跳过已有页');
    const after = readJson(root, 'data/nav-details.json').pages[0];
    assert.deepEqual(after, before, '已有页须逐字保留，不得因信源变更被重写');
    assert.equal(readJson(root, 'data/navlinks.json').items[0].hasContent, true, '跳过的页仍须 hasContent=true');
  } finally { cleanup(root); }
});

test('nav 详情页：官方原文完整上屏，客观介绍与唯一出站口并存，首页卡片改链站内页', async () => {
  const root = makeRoot();
  try {
    // 本用例验证创作/渲染链路，fixture 域名放行；域名排除语义由专门用例覆盖。
    writeJson(root, 'config/article-rules.json', { schema: 'article-rules/v1', skipNodeIds: [], bannedDomains: [] });
    const sources = readJson(root, 'data/sources.json');
    const official = '套餐资费：原套餐29元包192G通用流量\n优惠说明：首充100元后次月起长期29元\n配送方式：菜鸟\n激活方式：快递激活\n年龄要求：18-65周岁\n合约期限：12个月\n通用流量：192G\n月租费用：29元/月\n禁发地区：广东省,西藏自治区';
    sources.sources[0].sourceId = 'src-api-5260';
    sources.sources[0].title = '广电飞花卡 · 官方详情';
    sources.sources[0].grade = 'L1';
    sources.sources[0].bodyKind = 'fulltext';
    sources.sources[0].bodyExcerpt = official;
    sources.sources[0].discoveredBy = 'collect';
    writeJson(root, 'data/sources.json', sources);
    const nav = readJson(root, 'data/navlinks.json');
    Object.assign(nav.items[0], {
      navId: 'api-5260', productId: 5260,
      url: 'https://lingqu.haokalingqu.cn/pdetails?tk=a&pro=b',
      promoUrl: 'https://lingqu.haokalingqu.cn/pdetails?tk=a&pro=b',
      sourceIds: ['src-api-5260'], hasContent: false
    });
    nav.items.splice(1);
    writeJson(root, 'data/navlinks.json', nav);

    const r = await runBuildNavPages(root, {});
    assert.equal(r.built, 1, '官方详情信源应让 nav 过闸建页');
    const page = readJson(root, 'data/nav-details.json').pages[0];
    assert.equal(page.sourceBody, official, '页面须留存官方原文');
    assert.ok(Array.isArray(page.intro) && page.intro.length > 0, '介绍须为结构化段落数组');
    assert.ok(page.intro.some((s) => s.title === '套餐包含什么'), '段落须带主题小标题');
    assert.deepEqual(page.sourceIds, ['src-api-5260']);

    runBuild(root, {});
    const html = fs.readFileSync(path.join(root, '_site/nav/api-5260.html'), 'utf8');
    assert.ok(html.includes('原套餐29元包192G通用流量'), '官方资费原文须上屏');
    assert.match(html, /<dt>禁发地区<\/dt><dd>广东省,西藏自治区<\/dd>/, '禁发地区须完整上屏');
    assert.ok(!html.includes('客观介绍'), '不显示「客观介绍」标题，直接呈现介绍');
    assert.ok(html.includes('class="intro-para"'), '结构化介绍须上屏');
    assert.ok(html.includes('class="spec-row"'), '官方资料须分组渲染');
    assert.equal((html.match(/class="outbound"/g) || []).length, 1, '全页只能有一个出站口');
    assert.match(html, /id="apply"[^>]*rel="sponsored nofollow noopener"/, '唯一出站口须前置且 rel 合规');
    assert.ok(html.indexOf('id="apply"') < html.indexOf('<section id="intro-text"'), '出站口须在介绍之前');
    assert.match(html, /<a href="#apply">↑ 返回办理入口<\/a>/, '文末须有站内回跳锚点（非出站口）');
    const home = fs.readFileSync(path.join(root, '_site/index.html'), 'utf8');
    assert.ok(home.includes('href="/nav/api-5260.html"'), '有详情的卡片须改链站内页');
  } finally { cleanup(root); }
});
