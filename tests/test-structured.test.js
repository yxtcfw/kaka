// 批次 C1：结构化数据 / og / sitemap lastmod，配置驱动、缺字段不造假。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, writeJson, readJson, REPO } from './helper.js';
import { runBuild } from '../scripts/build.js';
import { loadStructuredConfig, navSchemas, articleSchemas, ogTags, ldScripts } from '../scripts/lib/structured-data.js';

function seed(root) {
  writeJson(root, 'config/structured.json', readJson(REPO, 'config/structured.json'));
  writeJson(root, 'config/sitemap.json', readJson(REPO, 'config/sitemap.json'));
  writeJson(root, 'data/site.json', {
    schema: 'site/v1', siteName: '测试站', tagline: '标签', intro: '简介', h1: '首页主标题', blogTitle: '文章',
    navCategories: [], byline: '编辑部', license: ''
  });
  writeJson(root, 'data/nav-details.json', {
    schema: 'nav-details/v1', pages: [{
      navId: 'api-1', bundleId: 'nav-001', title: '测试套餐', updatedAt: '2026-11-20',
      intro: [{ title: '套餐包含什么', text: '通用100G。' }, { title: '谁能办理', text: '年龄18-60岁。' }],
      sourceBody: '', sourceIds: ['src-001'], outbound: 'https://example.com/go'
    }]
  });
  writeJson(root, 'data/articles.json', {
    schema: 'articles/v1', articles: [{
      id: 'article-a', title: '办理避坑', nodeId: 'n2', generatedAt: '2026-11-19',
      body: '办理前先看实名要求，再核对官方页面。'.repeat(10), cardDesc: '先看实名要求', links: []
    }]
  });
  writeJson(root, 'data/navlinks.json', {
    schema: 'navlinks/v1', items: [{
      navId: 'api-1', productId: 1, title: '测试套餐', url: 'https://example.com/p', category: '套餐',
      cardDesc: '100G通用', hasContent: true, sourceIds: ['src-001'], rel: 'sponsored nofollow noopener',
      specs: { nowPrice: '29', tyLiuliang: '100', priceUnitStr: '月租费用' }
    }]
  });
  writeJson(root, 'data/sources.json', {
    schema: 'sources/v1', sources: [{ sourceId: 'src-001', title: '官方参数', domain: 'example.com', status: 'approved', grade: 'L1' }]
  });
}

const lds = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const typesOf = (html) => {
  const out = [];
  for (const d of lds(html)) {
    if (d['@type']) out.push(d['@type']);
    if (d['@graph']) out.push(...d['@graph'].map((x) => x['@type']));
  }
  return out;
};

test('structured lib：缺配置回退默认，缺价格不输出 Offer', () => {
  const cfg = loadStructuredConfig('/nonexistent');
  assert.equal(cfg.schema, 'structured/v1');
  const noPrice = navSchemas(cfg, 'https://x.cn', 'https://x.cn/nav/1.html', { title: '卡' }, {}, {});
  assert.ok(!typesOf(ldScripts(noPrice)).includes('Offer'));
  assert.ok(typesOf(ldScripts(noPrice)).includes('Product'));
});

test('og：无真实图片不输出 og:image，配置图片则输出绝对地址', () => {
  const cfg = loadStructuredConfig('/nonexistent');
  const html = ogTags(cfg, { siteName: '测试站' }, 'https://x.cn/a.html', '标题', '描述');
  assert.match(html, /og:title.*标题/);
  assert.ok(!html.includes('og:image'), '无图不造假');
  const withImg = ogTags({ ...cfg, og: { enabled: true, image: '/img/a.png' } }, { siteName: '测试站' }, 'https://x.cn/a.html', '标题', '描述');
  assert.match(withImg, /og:image.*https:\/\/x.cn\/img\/a.png/);
});

test('build：详情页含 Product/Offer/BreadcrumbList/FAQPage，og 齐全', () => {
  const root = makeRoot();
  try {
    seed(root);
    runBuild(root);
    const html = fs.readFileSync(path.join(root, '_site/nav/api-1.html'), 'utf8');
    const types = typesOf(html);
    for (const t of ['Product', 'BreadcrumbList', 'FAQPage']) {
      assert.ok(types.includes(t), `详情页缺 ${t}`);
    }
    const product = lds(html).flatMap((d) => d['@graph'] || [d]).find((x) => x['@type'] === 'Product');
    assert.equal(product.offers['@type'], 'Offer', 'Offer 内嵌在 Product.offers');
    assert.equal(product.offers.price, 29);
    assert.equal(product.offers.priceCurrency, 'CNY');
    assert.match(html, /<meta property="og:title"/);
    assert.ok(!html.includes('og:image'));
  } finally { cleanup(root); }
});

test('build：文章页含 Article + BreadcrumbList，列表与首页有 og', () => {
  const root = makeRoot();
  try {
    seed(root);
    runBuild(root);
    const article = fs.readFileSync(path.join(root, '_site/blog/article-a.html'), 'utf8');
    assert.ok(typesOf(article).includes('Article'));
    assert.ok(typesOf(article).includes('BreadcrumbList'));
    const home = fs.readFileSync(path.join(root, '_site/index.html'), 'utf8');
    const blog = fs.readFileSync(path.join(root, '_site/blog/index.html'), 'utf8');
    assert.match(home, /<meta property="og:title"/);
    assert.match(blog, /<meta property="og:title"/);
  } finally { cleanup(root); }
});

test('build：sitemap lastmod 只写真实日期，不伪造', () => {
  const root = makeRoot();
  try {
    seed(root);
    runBuild(root);
    const xml = fs.readFileSync(path.join(root, '_site/sitemap.xml'), 'utf8');
    assert.match(xml, /<loc>https:\/\/example\.com\/nav\/api-1\.html<\/loc><lastmod>2026-11-20<\/lastmod>/);
    assert.match(xml, /<loc>https:\/\/example\.com\/blog\/article-a\.html<\/loc><lastmod>2026-11-19<\/lastmod>/);
    assert.ok(!xml.includes('<loc>https://example.com/</loc><lastmod>'), '无日期的首页不写 lastmod');
    // 关闭配置后不输出 lastmod
    writeJson(root, 'config/sitemap.json', { includeLastmod: false, lastmodFields: ['updatedAt'] });
    runBuild(root);
    assert.ok(!fs.readFileSync(path.join(root, '_site/sitemap.xml'), 'utf8').includes('<lastmod>'));
  } finally { cleanup(root); }
});
