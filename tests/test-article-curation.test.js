// 文章整理：存量只留可核实长文，正文按空行分段渲染，模板标题永不回潮。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, writeJson, REPO } from './helper.js';
import { runBuild } from '../scripts/build.js';

test('存量文章：三篇人工长文达标，模板文与形式过关的空话文已清除', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'data/articles.json'), 'utf8'));
  const ids = doc.articles.map((a) => a.id);
  // 云端曾生成一篇 487 字「资料整理约为…」的空话稿：形式过门禁但零信息，已删除。
  assert.deepEqual(ids.sort(), ['article-auto-region', 'article-auto-sub-apply', 'article-n2']);
  for (const a of doc.articles) {
    assert.ok(a.body.length >= 600, `${a.id} 正文不足 600 字`);
    assert.ok(!/本卡片主题为|银行正式版本|持卡人协议/.test(a.body), `${a.id} 残留模板措辞`);
  }
  const rules = JSON.parse(fs.readFileSync(path.join(REPO, 'config/article-rules.json'), 'utf8'));
  assert.ok(rules.skipNodeIds.includes('auto-scene'));
  assert.ok(!rules.forceRegenerateNodeIds.includes('auto-scene'), '删除的模板节点不得被强制重生成');
});

test('build：配置开启时清理陈旧 HTML，关闭时保留（不误删主题静态页）', () => {
  const root = makeRoot();
  try {
    const writeStale = () => {
      fs.mkdirSync(path.join(root, '_site/topics'), { recursive: true });
      fs.writeFileSync(path.join(root, '_site/topics/stale.html'), '旧页', 'utf8');
    };
    const base = {
      schema: 'sitemap/v1', includeLastmod: true, lastmodFields: [], cleanStaleHtml: false
    };
    writeJson(root, 'config/sitemap.json', base);
    writeStale();
    runBuild(root, {});
    assert.ok(fs.existsSync(path.join(root, '_site/topics/stale.html')), '默认不清目录');

    writeJson(root, 'config/sitemap.json', { ...base, cleanStaleHtml: true });
    writeStale();
    runBuild(root, {});
    assert.equal(fs.existsSync(path.join(root, '_site/topics/stale.html')), false, '开启后旧页被清除');
  } finally { cleanup(root); }
});

test('build：正文空行切分为多段，不依赖任何主题字段', () => {
  const root = makeRoot();
  try {
    writeJson(root, 'data/site.json', {
      schema: 'site/v1', siteName: '测试站', intro: '简介', h1: '首页标题', blogTitle: '文章', byline: '编辑部', license: ''
    });
    writeJson(root, 'data/navlinks.json', { schema: 'navlinks/v1', items: [] });
    writeJson(root, 'data/nav-details.json', { schema: 'nav-details/v1', pages: [] });
    writeJson(root, 'data/sources.json', { schema: 'sources/v1', sources: [] });
    writeJson(root, 'data/articles.json', {
      schema: 'articles/v1',
      articles: [{
        id: 'article-demo', title: '办理避坑', nodeId: 'n2',
        body: '第一段：办理前先核对官方页面。\n\n第二段：首充与合约期也要看清。',
        cardDesc: '办理前先核对官方页面。', generatedAt: '2026-11-27', links: []
      }]
    });
    runBuild(root, {});
    const html = fs.readFileSync(path.join(root, '_site/blog/article-demo.html'), 'utf8');
    assert.equal((html.match(/<p class="body-text">/g) || []).length, 2, '两段正文各自成段');
    assert.notEqual(html.indexOf('第一段'), html.indexOf('第二段'), '段落顺序保持');
  } finally { cleanup(root); }
});
