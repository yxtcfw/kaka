// 批次 A：SEO 自指 canonical / 按页 description / h1 / 文案清洗，全部配置驱动，换主题不改渲染代码。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, writeJson } from './helper.js';
import { runBuild } from '../scripts/build.js';
import { loadSeoConfig, renderText, cleanText, cleanSlug, makeDescription, citationLabel } from '../scripts/lib/seo.js';

const SEO = {
  schema: 'seo/v1',
  descriptionMaxChars: 160,
  pages: {
    home: { h1: '{site.h1}', descriptionFields: ['site.intro'] },
    nav: { descriptionFields: ['title', 'cardDesc', 'category'] },
    blogIndex: { h1: '{site.blogTitle}', descriptionFields: ['site.blogTitle', 'site.intro'] },
    article: { descriptionFields: ['title', 'summary'] }
  },
  textHygiene: {
    stripPatterns: [
      '[（(]auto-[a-z0-9_-]+[）)]', '\\[src-api-[a-z0-9]+\\]', 'src-api-[a-z0-9]+',
      '归类词：\\s*auto-[a-z0-9_-]+\\s*', 'auto-[a-z0-9_-]+'
    ],
    slugStripPatterns: ['(?<=^|-)auto-'],
    citationFallback: '参考资料',
    sourceTitlePreferred: true
  }
};

function seed(root, seo = SEO) {
  writeJson(root, 'config/seo.json', seo);
  writeJson(root, 'data/site.json', {
    schema: 'site/v1', siteName: '测试站', tagline: '测试标签', intro: '站点简介',
    h1: '测试站首页主标题', blogTitle: '测试站文章', navCategories: [], byline: '编辑部', license: ''
  });
  writeJson(root, 'data/nav-details.json', {
    schema: 'nav-details/v1', pages: [{
      navId: 'api-1', bundleId: 'nav-001', title: '测试套餐（auto-x）',
      intro: '客观介绍（auto-x），数值以官方为准。', sourceBody: '', sourceIds: ['src-001'],
      outbound: 'https://example.com/go'
    }]
  });
  writeJson(root, 'data/sources.json', {
    schema: 'sources/v1', sources: [
      { sourceId: 'src-001', title: '官方参数页面', domain: 'example.com', status: 'approved', grade: 'L1' }
    ]
  });
  writeJson(root, 'data/articles.json', {
    schema: 'articles/v1', articles: [{
      id: 'article-auto-demo', title: '办理避坑（auto-demo）', nodeId: 'n2',
      body: '办理前先看实名要求（auto-demo），再核对官方页面。', cardDesc: '办理前先看实名要求。',
      generatedAt: '2026-11-27', links: []
    }]
  });
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('seo lib: 点路径模板、文案清洗、slug 清洗、信源显示名', () => {
  const cfg = loadSeoConfig('/nonexistent-root');
  assert.equal(cfg.schema, 'seo/v1', '缺配置时仍返回可用默认值');
  assert.equal(renderText('{site.h1} · {title}', { site: { h1: '主页' }, title: '文章' }), '主页 · 文章');
  assert.equal(cleanText('标题（auto-scene）', SEO.textHygiene), '标题');
  assert.equal(cleanSlug('article-auto-scene', SEO.textHygiene), 'article-scene');
  assert.equal(citationLabel('src-001', [{ sourceId: 'src-001', title: '官方参数页面' }], SEO.textHygiene), '官方参数页面');
  assert.equal(citationLabel('missing', [], SEO.textHygiene), '参考资料');
  assert.equal(makeDescription(SEO, SEO.pages.article, { title: '办理避坑', summary: '先看实名要求' }), '办理避坑 · 先看实名要求');
});

test('build: 四类页面 canonical 各自自指', () => {
  const root = makeRoot();
  try {
    seed(root);
    runBuild(root);
    const cases = [
      ['_site/index.html', 'https://example.com/'],
      ['_site/nav/api-1.html', 'https://example.com/nav/api-1.html'],
      ['_site/blog/index.html', 'https://example.com/blog/'],
      ['_site/blog/article-demo.html', 'https://example.com/blog/article-demo.html']
    ];
    for (const [rel, url] of cases) {
      assert.ok(read(root, rel).includes(`<link rel="canonical" href="${url}">`), `${rel} canonical 应自指`);
    }
  } finally { cleanup(root); }
});

test('build: 首页与文章列表各补唯一 h1，description 按页独立且截断', () => {
  const root = makeRoot();
  try {
    seed(root);
    runBuild(root);
    const home = read(root, '_site/index.html');
    const blog = read(root, '_site/blog/index.html');
    const article = read(root, '_site/blog/article-demo.html');
    assert.equal((home.match(/<h1>/g) || []).length, 1, '首页恰好一个 h1');
    assert.ok(home.includes('<h1>测试站首页主标题</h1>'));
    assert.equal((blog.match(/<h1>/g) || []).length, 1, 'blog 列表恰好一个 h1');
    assert.ok(blog.includes('<h1>测试站文章</h1>'));
    assert.match(article, /<h1>办理避坑<\/h1>/);
    const desc = (html) => html.match(/<meta name="description" content="([^"]*)">/)[1];
    assert.equal(desc(home), '站点简介');
    assert.ok(desc(article).includes('办理避坑'), '文章 description 来自自身数据');
    assert.ok(!desc(home).includes('办理避坑'), '页面间 description 不得复用');
  } finally { cleanup(root); }
});

test('build: 内部标识符不上屏，信源 ID 换可读标题，旧 slug 文件被清理', () => {
  const root = makeRoot();
  try {
    seed(root);
    runBuild(root);
    const nav = read(root, '_site/nav/api-1.html');
    const article = read(root, '_site/blog/article-demo.html');
    assert.ok(!nav.includes('（auto-x）'), '详情标题/正文不得带 auto 标识符');
    assert.ok(!nav.includes('src-001'), '信源内部 ID 不得暴露');
    assert.ok(nav.includes('官方参数页面'), '信源应显示可读标题');
    assert.ok(!article.includes('（auto-demo）'), '文章标题/正文不得带 auto 标识符');
    const blogDir = path.join(root, '_site/blog');
    assert.ok(fs.existsSync(path.join(blogDir, 'article-demo.html')));
    assert.ok(!fs.existsSync(path.join(blogDir, 'article-auto-demo.html')), '旧 auto- slug 文件不得残留');
    assert.ok(!read(root, '_site/index.html').includes('待人工确认'), '未确认许可文案不得上屏');
  } finally { cleanup(root); }
});

test('build: 换一份 SEO 配置即可改变 h1 与字段来源（其他主题可复用）', () => {
  const root = makeRoot();
  try {
    const other = JSON.parse(JSON.stringify(SEO));
    other.pages.home.h1 = '{site.siteName} · {site.tagline}';
    other.pages.article.descriptionFields = ['title'];
    seed(root, other);
    runBuild(root);
    assert.ok(read(root, '_site/index.html').includes('<h1>测试站 · 测试标签</h1>'));
    assert.equal(
      read(root, '_site/blog/article-demo.html').match(/<meta name="description" content="([^"]*)">/)[1],
      '办理避坑',
      '换字段列表后 description 随之改变，证明未硬编码领域字段'
    );
  } finally { cleanup(root); }
});
