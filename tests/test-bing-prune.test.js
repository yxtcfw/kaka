import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, readJson, writeJson, REPO } from './helper.js';
import { normalizeBingPage } from '../scripts/fetch-metrics.js';
import { runPrune } from '../scripts/prune.js';

test('normalizeBingPage: Bing 完整 URL 归一到站内页面键', () => {
  const domain = 'kaka.yxtcfw.cn';
  assert.equal(normalizeBingPage('https://kaka.yxtcfw.cn/blog/article-n2.html', `https://${domain}/`, domain), '/blog/article-n2.html');
  assert.equal(normalizeBingPage('https://www.kaka.yxtcfw.cn/nav/api-5260.html?utm=x', `https://${domain}/`, domain), '/nav/api-5260.html');
  assert.equal(normalizeBingPage('/blog/article-n2.html', `https://${domain}/`, domain), '/blog/article-n2.html');
  assert.equal(normalizeBingPage('https://other.example.com/a', `https://${domain}/`, domain), '/a');
});

test('prune: 回流为空时不下结论、不写树', () => {
  const root = makeRoot();
  try {
    writeJson(root, 'data/metrics/latest.json', { schema: 'metrics/v1', provider: 'bing', rows: [] });
    const treeBefore = fs.readFileSync(path.join(root, 'data/tree.json'), 'utf8');
    const r = runPrune(root, {});
    assert.equal(r.status, 'no-data');
    assert.deepEqual(r.treeProposals, []);
    assert.equal(fs.readFileSync(path.join(root, 'data/tree.json'), 'utf8'), treeBefore);
    assert.equal(readJson(root, 'reports/prune.json').status, 'no-data');
  } finally { cleanup(root); }
});

test('prune: 有回流时产出四状态与树复核提案，但不写树', () => {
  const root = makeRoot();
  try {
    writeJson(root, 'data/metrics/latest.json', {
      schema: 'metrics/v1', provider: 'bing', estimated: false,
      rows: [
        { page: '/blog/article-n2.html', impressions: 200, clicks: 10 },
        { page: '/blog/article-auto-region.html', impressions: 30, clicks: 1 }
      ]
    });
    writeJson(root, 'data/articles.json', {
      schema: 'articles/v1',
      articles: [
        { id: 'article-n2', nodeId: 'n2', title: '办理', body: '资料', links: [] },
        { id: 'article-auto-region', nodeId: 'auto-region', title: '地区', body: '资料', links: [] },
        { id: 'article-auto-scene', nodeId: 'auto-scene', title: '场景', body: '资料', links: [] }
      ]
    });
    const tree = readJson(root, 'data/tree.json');
    tree.nodes.push({ id: 'auto-region', label: '地区专属卡', topic: '地区', keywords: [], parent: 'n0', children: [] });
    tree.nodes.push({ id: 'auto-scene', label: '场景卡种', topic: '场景', keywords: [], parent: 'n0', children: [] });
    writeJson(root, 'data/tree.json', tree);
    const treeBefore = fs.readFileSync(path.join(root, 'data/tree.json'), 'utf8');

    const r = runPrune(root, {});
    assert.equal(r.status, 'ready');
    assert.equal(r.counts.active, 1);
    assert.equal(r.counts.watch, 1);
    assert.equal(r.counts.unmatched, 1);
    assert.ok(r.treeProposals.some((p) => p.nodeId === 'auto-scene' && p.action === 'review'));
    assert.ok(!r.treeProposals.some((p) => p.nodeId === 'n2'), '活跃节点不应进复核提案');
    assert.equal(fs.readFileSync(path.join(root, 'data/tree.json'), 'utf8'), treeBefore, '修剪只出提案，不写树');
    assert.equal(readJson(root, 'reports/prune.json').apply, false);
  } finally { cleanup(root); }
});

test('pipeline: 修剪提案在回流采集之后', () => {
  const cli = fs.readFileSync(path.join(REPO, 'scripts/cli.js'), 'utf8');
  assert.ok(cli.indexOf('runPrune(root, o)') > cli.indexOf('await runFetchMetrics('));
});
