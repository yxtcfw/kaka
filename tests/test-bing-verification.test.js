// Bing 站点验证双保险：根目录 XML + 所有页面 head 的 meta。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, writeJson, REPO } from './helper.js';
import { layout, esc } from '../scripts/lib/render.js';
import { runBuild } from '../scripts/build.js';

const SITE = {
  siteName: '测试站', tagline: '流量卡资料', intro: '资料整理',
  navCategories: ['资费套餐'], byline: '编辑部'
};

function manifest(bing) {
  return {
    schema: 'manifest/v1', domain: 'example.com', vertical: '流量卡',
    siteName: null, tagline: null, hosting: 'github-actions',
    theme: { primary: '#2563eb', accent: '#f59e0b', radius: '12px', font: 'system-ui' },
    thresholds: { signalsMin: 300, signalsSourcesMin: 2, signalsNewRateMax: 0.1, sourceL1Min: 1, sourceL2IndependentMin: 2, gateBlocksMin: 1 },
    providers: { suggest: 'mock', search: 'mock', llm: 'mock', metrics: 'mock' },
    ...(bing ? { verification: { bing } } : {})
  };
}

test('Bing 验证 token：meta 来源与 XML 文件一致', () => {
  const mf = JSON.parse(fs.readFileSync(path.join(REPO, 'config/manifest.json'), 'utf8'));
  const xml = fs.readFileSync(path.join(REPO, 'BingSiteAuth.xml'), 'utf8');
  const fromXml = xml.match(/<user>([^<]+)<\/user>/)?.[1];
  assert.ok(fromXml, 'XML 必须有 user 节点');
  assert.equal(mf.verification?.bing, fromXml);
});

test('layout: 有 token 时所有页面 head 输出 msvalidate.01 meta', () => {
  const token = 'B8B33A6B522E953CC557C211546D6CDF';
  for (const [title, body] of [['首页', '<p>首页</p>'], ['详情', '<article>详情</article>'], ['文章', '<article>文章</article>']]) {
    const html = layout(SITE, manifest(token), title, body);
    assert.ok(html.includes(`<meta name="msvalidate.01" content="${token}">`), `${title} 缺 meta`);
    const head = html.slice(0, html.indexOf('</head>'));
    assert.ok(head.indexOf('msvalidate.01') < head.indexOf('rel="canonical"') + 100, `${title} meta 应在 head`);
  }
});

test('layout: 无 token 时不输出空 meta，且 token 被转义', () => {
  assert.ok(!layout(SITE, manifest(''), '首页', '<p>x</p>').includes('msvalidate.01'));
  const evil = 'x" onload="alert(1)';
  const html = layout(SITE, manifest(evil), '首页', '<p>x</p>');
  assert.ok(html.includes(`content="${esc(evil)}"`));
  assert.ok(!html.includes('onload="alert(1)"'));
});

test('build: 实际产物首页 head 带验证 meta', () => {
  const root = makeRoot();
  try {
    writeJson(root, 'config/manifest.json', manifest('B8B33A6B522E953CC557C211546D6CDF'));
    runBuild(root, {});
    const html = fs.readFileSync(path.join(root, '_site/index.html'), 'utf8');
    assert.ok(html.includes('<meta name="msvalidate.01" content="B8B33A6B522E953CC557C211546D6CDF">'));
  } finally { cleanup(root); }
});
