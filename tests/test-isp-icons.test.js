// 运营商图形标识：内嵌 SVG、配置驱动、按 isp 映射，取代标题首字，零图片请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, writeJson, readJson } from './helper.js';
import { runBuild } from '../scripts/build.js';
import { REPO } from './helper.js';

test('isp-icons: 四大运营商均有配置，符号与品牌色可辨识', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'config/isp-icons.json'), 'utf8'));
  for (const isp of ['移动', '联通', '电信', '广电']) {
    assert.ok(cfg.icons[isp], `${isp} 须有图形配置`);
    assert.match(cfg.icons[isp].svg, /<(path|circle|rect|polygon)/, `${isp} 须为 SVG 图形`);
    assert.match(cfg.icons[isp].color, /^#[0-9a-f]{6}$/i, `${isp} 须有品牌色`);
  }
  assert.ok(cfg.fallback?.svg, '未知运营商须有通用符号');
});

test('build: 卡片按 isp 渲染 SVG，不再取标题首字', () => {
  const root = makeRoot();
  try {
    writeJson(root, 'data/site.json', {
      schema: 'site/v1', siteName: '测试站', intro: '简介', h1: '首页标题', blogTitle: '文章', byline: '编辑部', license: ''
    });
    writeJson(root, 'config/isp-icons.json', JSON.parse(fs.readFileSync(path.join(REPO, 'config/isp-icons.json'), 'utf8')));
    const nav = readJson(root, 'data/navlinks.json');
    nav.items = [
      { ...nav.items[0], navId: 'nav-a', title: '广电示例卡', isp: '广电', category: '广电套餐', cardDesc: '摘要A' },
      { ...nav.items[0], navId: 'nav-b', title: '联通示例卡', isp: '联通', category: '联通套餐', cardDesc: '摘要B' }
    ];
    writeJson(root, 'data/navlinks.json', nav);
    writeJson(root, 'data/nav-details.json', { schema: 'nav-details/v1', pages: [] });
    writeJson(root, 'data/articles.json', { schema: 'articles/v1', articles: [] });
    writeJson(root, 'data/sources.json', { schema: 'sources/v1', sources: [] });
    runBuild(root, {});
    const html = fs.readFileSync(path.join(root, '_site/index.html'), 'utf8');
    assert.match(html, /aria-label="中国广电"/, '广电卡须渲染广电图形');
    assert.match(html, /aria-label="中国联通"/, '联通卡须渲染联通图形');
    assert.match(html, /<svg viewBox=/, '图标须为内嵌 SVG');
    assert.ok(!/<span class="card-icon" aria-hidden="true">广<\/span>/.test(html), '不得再用标题首字图标');
    assert.ok(!/<img\b/.test(html), '不得引入图片请求');
  } finally { cleanup(root); }
});
