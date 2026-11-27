import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoot, cleanup, readJson, writeJson } from './helper.js';
import { runDiscover } from '../scripts/discover-sources.js';
import { runFetchBody } from '../scripts/fetch-body.js';
import { runWriteContent } from '../scripts/write-content.js';

function seed(root) {
  writeJson(root, 'config/article-rules.json', {
    schema: 'article-rules/v1', skipNodeIds: [], bannedDomains: [],
    forceRegenerateNodeIds: ['auto-scene', 'auto-sub-manage'],
    minBodyChars: 120, bannedTitlePatterns: ['^auto-'],
    bannedBodyPhrases: ['本卡片主题为', '银行正式版本', '持卡人协议', '以银行']
  });
  const tree = readJson(root, 'data/tree.json');
  tree.nodes.push(
    { id: 'auto-scene', label: '场景卡种', topic: '副卡与校园卡等特定场景流量卡', keywords: ['副卡'], parent: 'n0', children: [], origin: 'auto' },
    { id: 'auto-sub-manage', label: '副卡资费与管理', topic: '副卡资费规则、注销退订与主卡关系', keywords: ['副卡注销'], parent: 'n0', children: [], origin: 'auto' }
  );
  writeJson(root, 'data/tree.json', tree);
  writeJson(root, 'data/articles.json', {
    schema: 'articles/v1',
    articles: [
      { id: 'article-auto-scene', title: 'auto-scene', nodeId: 'auto-scene', body: '本卡片主题为 auto-scene。'.repeat(20), sourceId: 'src-001', links: [], generatedAt: '2026-11-26' },
      { id: 'article-auto-sub-manage', title: '副卡资费规则', nodeId: 'auto-sub-manage', body: '具体规则以银行正式版本、持卡人协议为准。'.repeat(10), sourceId: 'src-002', links: [], generatedAt: '2026-11-26' }
    ]
  });
}

test('write-content: 强制重生成丢弃低质旧文，护栏拦截模板标题与无关领域措辞', async () => {
  const root = makeRoot();
  try {
    seed(root);
    await runDiscover(root, { limit: 10 });
    await runFetchBody(root, {});
    const r = await runWriteContent(root, {});
    assert.deepEqual(r.regeneratedIds.sort(), ['article-auto-scene', 'article-auto-sub-manage']);
    assert.ok(r.qualityFallbacks.length >= 1, '至少一篇命中质量护栏并走安全回退');
    const articles = readJson(root, 'data/articles.json').articles;
    const scene = articles.find((a) => a.id === 'article-auto-scene');
    assert.ok(scene, '重生成后该节点仍有文章');
    assert.notEqual(scene.title, 'auto-scene', '标题不得是原始节点 ID');
    assert.ok(!scene.body.includes('本卡片主题为'));
    for (const a of articles) {
      assert.ok(!a.body.includes('银行正式版本'), `无关领域措辞残留：${a.id}`);
    }
  } finally { cleanup(root); }
});

test('write-content: --only-force 只重生成点名节点，不覆盖合格文章', async () => {
  const root = makeRoot();
  try {
    seed(root);
    const doc = readJson(root, 'data/articles.json');
    doc.articles.push({ id: 'article-good', title: '合格文章', nodeId: 'n1', body: '已核实的资料整理。'.repeat(30), sourceId: 'src-001', links: [], generatedAt: '2026-11-25' });
    writeJson(root, 'data/articles.json', doc);
    await runDiscover(root, { limit: 10 });
    await runFetchBody(root, {});
    const r = await runWriteContent(root, { onlyForce: true });
    assert.equal(r.generated, 2, '只处理两个点名节点');
    const kept = readJson(root, 'data/articles.json').articles.find((a) => a.id === 'article-good');
    assert.equal(kept.title, '合格文章', '合格文章不得被覆盖');
  } finally { cleanup(root); }
});
