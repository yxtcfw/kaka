import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, readJson, writeJson, REPO } from './helper.js';
import { runBuild } from '../scripts/build.js';

function seedArticles(root) {
  writeJson(root, 'data/articles.json', {
    schema: 'articles/v1',
    articles: [
      { id: 'article-good-1', title: '流量卡办理避坑', nodeId: 'n2', body: '办理前先确认实名与首充要求，再对比官方渠道的套餐说明。'.repeat(10), cardDesc: '办理前先确认实名与首充。', generatedAt: '2026-11-27', links: [] },
      { id: 'article-good-2', title: '资费套餐怎么选', nodeId: 'n1', body: '对比月租、通用流量与通话时长时，以官方实时页面为准。'.repeat(10), cardDesc: '对比月租与通用流量。', generatedAt: '2026-11-26', links: [] },
      { id: 'article-bad', title: 'auto-scene', nodeId: 'auto-scene', body: '本卡片主题为 auto-scene，资料不足。'.repeat(10), generatedAt: '2026-11-28', links: [] }
    ]
  });
}

test('layout: 分类栏与页脚均有文章入口，博客锚点不悬空', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts/lib/render.js'), 'utf8');
  assert.match(src, /<a href="\/blog\/">文章<\/a>/);
  assert.match(src, /blogAnchorCats/);
  assert.match(src, /\/blog\/#\$\{esc\(slugify\(label\)\)\}/);
  assert.match(src, /站点导航[\s\S]*<a href="\/blog\/">文章<\/a>/);
});

test('build: 首页最新文章区上屏合格文章，不参与站内搜索显隐', () => {
  const root = makeRoot();
  try {
    seedArticles(root);
    runBuild(root, {});
    const html = fs.readFileSync(path.join(root, '_site/index.html'), 'utf8');
    assert.match(html, /<h2>最新文章<\/h2>/);
    assert.match(html, /article-good-1\.html/);
    assert.ok(!html.includes('article-bad.html'), '低质文章不上首页');
    assert.match(html, /<section class="article-section">/);
    assert.ok(!html.includes('id="article-section"'), '文章区不能有 id，避免被搜索脚本隐藏');
  } finally { cleanup(root); }
});

test('build: 博客按主题分组，文章页有面包屑与相关入口，返回列表', () => {
  const root = makeRoot();
  try {
    seedArticles(root);
    runBuild(root, {});
    const index = fs.readFileSync(path.join(root, '_site/blog/index.html'), 'utf8');
    assert.match(index, /id="资费套餐"/);
    assert.match(index, /id="办理攻略"/);
    assert.match(index, /id="选购专题"/);
    const article = fs.readFileSync(path.join(root, '_site/blog/article-good-1.html'), 'utf8');
    assert.match(article, /class="breadcrumb"/);
    assert.match(article, /相关办理入口/);
    assert.match(article, /返回文章列表/);
  } finally { cleanup(root); }
});

test('build: nav 详情页反向关联同主题攻略', () => {
  const root = makeRoot();
  try {
    seedArticles(root);
    writeJson(root, 'data/nav-details.json', {
      schema: 'nav-details/v1',
      pages: [{ navId: 'nav-001', bundleId: 'nav-nav-001', title: '示例运营商官方资费页', outbound: 'https://example.com/plan', intro: [{ title: '', text: '官方资料整理。' }], sourceBody: '', sourceIds: ['src-001'] }]
    });
    runBuild(root, {});
    const html = fs.readFileSync(path.join(root, '_site/nav/nav-001.html'), 'utf8');
    assert.match(html, /相关攻略/);
    assert.match(html, /article-good-2\.html|article-good-1\.html/);
  } finally { cleanup(root); }
});
