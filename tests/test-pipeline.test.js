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

test('grow-tree: 幂等且按映射扩展关键词，不改节点数', () => {
  const root = makeRoot();
  try {
    runHarvest(root, {}); runHarvest(root, {});
    const r = runGrowTree(root, {});
    assert.equal(r.idempotent, true);
    assert.ok(r.keywordsAdded > 0);
    const beforeCount = readJson(root, 'data/tree.json').nodes.length;
    assert.equal(beforeCount, r.nodes);
  } finally { cleanup(root); }
});

test('discover→fetch-body: 搜索候选默认 L3，不自动升 L1/L2', async () => {
  const root = makeRoot();
  try {
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

test('write-content: 判据②未达标时跳过', () => {
  const root = makeRoot();
  try {
    const r = runWriteContent(root, {});
    assert.equal(r.skipped, true);
  } finally { cleanup(root); }
});

test('write-content: 达标后生成并至少被门禁拦下一次（判据③）', async () => {
  const root = makeRoot();
  try {
    await runDiscover(root, { limit: 10 });
    await runFetchBody(root, {});
    const r = runWriteContent(root, {});
    assert.ok(r.generated >= 1);
    assert.ok(r.gateBlockedCount >= 1, '门禁至少拦下一次');
    assert.equal(r.contentPassed, true);
    assert.ok(readJson(root, 'data/articles.json').articles.length >= 1);
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

test('build-nav-pages: 有关联源生成详情，数字无 citation 降级直跳', () => {
  const root = makeRoot();
  try {
    const nav = readJson(root, 'data/navlinks.json');
    nav.items.push({
      navId: 'nav-bad', title: '无引用测试', url: 'https://x.example/bad', category: '选购攻略',
      cardDesc: '测试', hasContent: false, sourceIds: ['src-001'],
      detailClaims: [{ text: '月租仅9.9元超长描述用于触发事实闸拦截逻辑', citationIds: [] }]
    });
    writeJson(root, 'data/navlinks.json', nav);

    const r = runBuildNavPages(root, {});
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

test('build-nav-pages: 无正文的 nav 不生成空壳页', () => {
  const root = makeRoot();
  try {
    const nav = readJson(root, 'data/navlinks.json');
    for (const it of nav.items) it.sourceIds = [];
    writeJson(root, 'data/navlinks.json', nav);
    const r = runBuildNavPages(root, {});
    assert.equal(r.built, 0);
    assert.equal(r.downgraded, 2);
    assert.ok(r.downgradedDetail.every((d) => d.reason === 'no-body'));
  } finally { cleanup(root); }
});

test('build: 产物齐全 + sitemap 显式枚举，无空壳页', () => {
  const root = makeRoot();
  try {
    runFillSite(root, {});
    runBuildNavPages(root, {});
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
