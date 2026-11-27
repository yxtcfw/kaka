// 批次 D：合规页只渲染已确认文案，pending 项不伪造、不上屏。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, writeJson, readJson, REPO } from './helper.js';
import { runBuild } from '../scripts/build.js';
import { runCompliancePages, loadComplianceConfig } from '../scripts/compliance-pages.js';

function seed(root) {
  writeJson(root, 'config/structured.json', readJson(REPO, 'config/structured.json'));
  writeJson(root, 'config/compliance.json', readJson(REPO, 'config/compliance.json'));
  writeJson(root, 'config/presentation.json', readJson(REPO, 'config/presentation.json'));
  writeJson(root, 'config/topics.json', readJson(REPO, 'config/topics.json'));
  writeJson(root, 'config/sitemap.json', readJson(REPO, 'config/sitemap.json'));
  writeJson(root, 'data/site.json', {
    schema: 'site/v1', siteName: '测试站', tagline: '标签', intro: '简介', h1: '首页主标题', blogTitle: '文章',
    navCategories: [], byline: '编辑部', license: ''
  });
  writeJson(root, 'data/navlinks.json', { schema: 'navlinks/v1', items: [] });
  writeJson(root, 'data/sources.json', { schema: 'sources/v1', sources: [] });
}

test('合规配置：pending 项存在但不进页面文案', () => {
  const cfg = loadComplianceConfig(REPO);
  assert.ok(cfg.pendingHuman.length >= 3, '备案/主体/联系方式列为待人工');
  const allText = JSON.stringify(cfg.pages);
  assert.ok(!allText.includes('ICP 备'), '页面文案不得含伪造备案号');
  assert.ok(!allText.includes('营业执照编号'), '页面文案不得含伪造资质');
});

test('合规页：生成 4 页、canonical 自指、内容来自配置', () => {
  const root = makeRoot();
  try {
    seed(root);
    const r = runCompliancePages(root, { dryRun: true });
    assert.equal(r.generated, 4);
    assert.equal(r.urls.length, 4);
    assert.ok(r.pendingHuman.length >= 3);
    runCompliancePages(root, {});
    const privacy = fs.readFileSync(path.join(root, '_site/privacy.html'), 'utf8');
    assert.match(privacy, /<h1>隐私政策<\/h1>/);
    assert.match(privacy, /本站不设置账号体系/);
    assert.match(privacy, /<link rel="canonical" href="https:\/\/example\.com\/privacy\.html">/);
    const safety = fs.readFileSync(path.join(root, '_site/safety.html'), 'utf8');
    assert.match(safety, /不要向他人出租、出借电话卡/);
    assert.ok(!privacy.includes('备案号：'), '不渲染假备案');
    assert.ok(fs.existsSync(path.join(root, 'reports/compliance.json')));
  } finally { cleanup(root); }
});

test('页脚：合规入口来自配置，无配置时不渲染', () => {
  const root = makeRoot();
  try {
    seed(root);
    runBuild(root);
    const html = fs.readFileSync(path.join(root, '_site/index.html'), 'utf8');
    for (const label of ['隐私政策', '用户协议', '渠道说明', '实名与反诈提示']) {
      assert.ok(html.includes(`>${label}</a>`), `页脚缺 ${label}`);
    }
    // 清空配置后不渲染死链
    writeJson(root, 'config/compliance.json', { enabled: true, footerLinks: [], pages: {} });
    runBuild(root);
    const html2 = fs.readFileSync(path.join(root, '_site/index.html'), 'utf8');
    assert.ok(!html2.includes('>隐私政策</a>'), '无配置不留死链');
  } finally { cleanup(root); }
});
