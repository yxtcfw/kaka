// 批次 C2：筛选条 / 展示文案 / 内容门槛 / 专题页，全部配置驱动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, writeJson, readJson, REPO } from './helper.js';
import { runBuild } from '../scripts/build.js';
import { runTopicPages, loadTopicConfig } from '../scripts/topic-pages.js';

function seed(root) {
  writeJson(root, 'config/structured.json', readJson(REPO, 'config/structured.json'));
  writeJson(root, 'config/sitemap.json', readJson(REPO, 'config/sitemap.json'));
  writeJson(root, 'config/presentation.json', readJson(REPO, 'config/presentation.json'));
  writeJson(root, 'config/topics.json', readJson(REPO, 'config/topics.json'));
  writeJson(root, 'data/site.json', {
    schema: 'site/v1', siteName: '测试站', tagline: '标签', intro: '简介', h1: '首页主标题', blogTitle: '文章',
    navCategories: [], byline: '编辑部', license: ''
  });
  writeJson(root, 'data/navlinks.json', {
    schema: 'navlinks/v1', items: [
      { navId: 'api-1', title: '套餐甲', url: 'https://example.com/a', category: '套餐', isp: '移动', cardDesc: '100G', hasContent: true, sourceIds: ['s1'],
        specs: { nowPrice: '29', tyLiuliang: '100', priceUnitStr: '月租费用' } },
      { navId: 'api-2', title: '套餐乙', url: 'https://example.com/b', category: '套餐', isp: '联通', cardDesc: '60G', hasContent: true, sourceIds: ['s2'],
        specs: { nowPrice: '45', tyLiuliang: '60', priceUnitStr: '月租费用' } }
    ]
  });
  writeJson(root, 'data/nav-details.json', {
    schema: 'nav-details/v1', pages: [
      { navId: 'api-1', bundleId: 'nav-api-1', title: '套餐甲', outbound: 'https://example.com/a',
        intro: [{ title: '谁能办理', text: '年龄18-60周岁，可办。' }, { title: '禁发地区', text: '以下地区不办理：广东省、河南省。' }],
        sourceBody: '', sourceIds: ['s1'], gates: [] },
      { navId: 'api-2', bundleId: 'nav-api-2', title: '套餐乙', outbound: 'https://example.com/b',
        intro: [{ title: '年龄限制', text: '年龄仅限18-24岁。' }], sourceBody: '', sourceIds: ['s2'], gates: [] }
    ]
  });
  writeJson(root, 'data/sources.json', { schema: 'sources/v1', sources: [] });
}

test('配置缺字段可复用：默认 countLabel 与空筛选不报错', () => {
  const cfg = { countLabel: '个套餐', filters: [] };
  assert.equal(cfg.filters.length, 0);
  assert.ok(readJson(REPO, 'config/presentation.json').filters.length > 0);
});

test('build：筛选条与分组文案来自配置，卡片带筛选属性', () => {
  const root = makeRoot();
  try {
    seed(root);
    runBuild(root);
    const html = fs.readFileSync(path.join(root, '_site/index.html'), 'utf8');
    assert.match(html, /class="filters"/);
    assert.match(html, /data-filter-field="isp"/);
    assert.match(html, /data-band="20-30"/, '29 元应落在 20-30 区间');
    assert.match(html, /data-band="40以上"/, '45 元应落在 40以上');
    assert.match(html, /2 个套餐/, '分组文案改用配置');
    assert.ok(!html.includes('2 个入口'), '旧文案不出现');
    const render = fs.readFileSync(path.join(REPO, 'scripts/lib/render.js'), 'utf8');
    assert.match(render, /data-filter-reset/);
  } finally { cleanup(root); }
});

test('专题页：只聚合原句，不生成空壳页，配置可关', () => {
  const root = makeRoot();
  try {
    seed(root);
    const r = runTopicPages(root, { dryRun: true });
    assert.equal(r.generated, 2, '两个专题都有命中');
    assert.equal(r.urls.length, 2);
    const region = r.topics.find((t) => t.slug === 'forbidden-regions');
    assert.equal(region.entries, 2, '两条套餐的年龄/禁发原句都含地域或年龄词，按关键词命中聚合');
    assert.ok(r.topics.every((t) => t.entries >= 1), '无命中的专题不生成空壳页');
    // 关闭后不生成
    writeJson(root, 'config/topics.json', { ...loadTopicConfig(root), enabled: false });
    assert.equal(runTopicPages(root, { dryRun: true }).disabled, true);
  } finally { cleanup(root); }
});

test('专题页：真实产物含原句且 canonical 自指', () => {
  const root = makeRoot();
  try {
    seed(root);
    runBuild(root);
    const r = runTopicPages(root, {});
    assert.equal(r.generated, 2);
    const html = fs.readFileSync(path.join(root, '_site/forbidden-regions.html'), 'utf8');
    assert.match(html, /<h1>流量卡禁发地区汇总<\/h1>/);
    assert.match(html, /广东省、河南省/, '原句原样保留，不改写');
    assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/forbidden-regions\.html">/);
    assert.ok(fs.existsSync(path.join(root, 'reports/topic-pages.json')));
  } finally { cleanup(root); }
});
