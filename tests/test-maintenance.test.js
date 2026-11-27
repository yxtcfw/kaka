import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runMaintenance } from '../scripts/maintenance.js';
import { makeRoot, cleanup, readJson, writeJson } from './helper.js';

function seedMaintenance(root) {
  const sourcesDoc = readJson(root, 'data/sources.json');
  sourcesDoc.sources.push(
    { sourceId: 'src-100', url: 'https://old.example.net/a', domain: 'old.example.net', title: '过期搜索源', grade: 'L3', status: 'approved', bodyKind: 'fulltext', bodyExcerpt: '旧正文', discoveredBy: 'search', fetchedAt: '2026-01-01' },
    { sourceId: 'src-101', url: 'https://used.example.net/b', domain: 'used.example.net', title: '被引用搜索源', grade: 'L3', status: 'approved', bodyKind: 'fulltext', bodyExcerpt: '不可删', discoveredBy: 'search', fetchedAt: '2026-01-01' },
    { sourceId: 'src-102', url: 'https://api.example.net/c', domain: 'api.example.net', title: '接口信源', grade: 'L1', status: 'approved', bodyKind: 'fulltext', bodyExcerpt: '不可删', discoveredBy: 'collect', fetchedAt: '2026-01-01' }
  );
  writeJson(root, 'data/sources.json', sourcesDoc);

  const nav = readJson(root, 'data/navlinks.json');
  nav.items[0].sourceIds = ['src-101'];
  writeJson(root, 'data/navlinks.json', nav);

  writeJson(root, 'data/discovered.json', {
    schema: 'discovered/v1', provider: 'ddgs', degraded: true, candidates: [
      { url: 'https://old.example.net/x', foundAt: '2026-01-01' },
      { url: 'https://fresh.example.net/y', foundAt: '2026-12-30' }
    ]
  });

  const tree = readJson(root, 'data/tree.json');
  tree.nodes.push({
    id: 'auto-test001', label: '过时主题', topic: '过时主题', parent: 'n0', children: [],
    keywords: ['不存在词一', '不存在词二', '不存在词三'], origin: 'auto', createdAt: '2026-01-01'
  });
  tree.nodes.push({ id: 'n9', label: '人工主题', topic: '人工主题', parent: 'n0', children: [], keywords: ['人工词'] });
  tree.root.children.push('auto-test001', 'n9');
  writeJson(root, 'data/tree.json', tree);
}

test('maintenance: 有子节点的容器节点永不回收，避免整棵子树脱离分类', async () => {
  const root = makeRoot();
  try {
    const tree = readJson(root, 'data/tree.json');
    tree.nodes.push({
      id: 'auto-parent', label: '空壳容器', topic: '容器', parent: 'n0',
      keywords: [], children: ['n1'], origin: 'auto', idleCycles: 9, createdAt: '2026-01-01'
    });
    tree.nodes.push({
      id: 'auto-empty', label: '空叶子', topic: '空叶子', parent: 'n0',
      keywords: [], children: [], origin: 'auto', idleCycles: 9, createdAt: '2026-01-01'
    });
    tree.root.children.push('auto-parent', 'auto-empty');
    writeJson(root, 'data/tree.json', tree);

    const r = await runMaintenance(root, {});
    assert.ok(r.removedNodes.some((n) => n.id === 'auto-empty'), '空叶子应被回收');
    assert.ok(!r.removedNodes.some((n) => n.id === 'auto-parent'), '容器节点须豁免');
    const next = readJson(root, 'data/tree.json');
    assert.ok(next.nodes.some((n) => n.id === 'auto-parent'), '容器须留在树中');
  } finally {
    cleanup(root);
  }
});

test('maintenance: 只清理系统自建且未引用的条目，人工/API 数据受保护', async () => {
  const root = makeRoot();
  try {
    seedMaintenance(root);
    const before = readJson(root, 'data/sources.json');
    const dry = await runMaintenance(root, { now: '2026-12-31', dryRun: true });
    assert.deepEqual(readJson(root, 'data/sources.json'), before, 'dry-run 零写盘');
    assert.equal(dry.removedSources.length, 1);

    const r = await runMaintenance(root, { now: '2026-12-31' });
    const sources = readJson(root, 'data/sources.json').sources;
    const ids = sources.map((s) => s.sourceId);
    assert.ok(!ids.includes('src-100'), '过期且未引用的搜索源须删除');
    assert.ok(ids.includes('src-101'), '被页面引用的搜索源须保留');
    assert.ok(ids.includes('src-102'), 'API 信源永不删除');
    assert.equal(readJson(root, 'data/discovered.json').candidates.length, 1);

    const tree = readJson(root, 'data/tree.json');
    assert.ok(!tree.nodes.some((n) => n.id === 'auto-test001'), '无有效词的 auto 节点须回收');
    assert.ok(tree.nodes.some((n) => n.id === 'n9'), '人工节点须保留');
    assert.ok(!tree.root.children.includes('auto-test001'));
    assert.equal(r.removedCandidates, 1);
    assert.equal(r.recheck.enabled, false);
    assert.match(r.recheck.reason, /mock-provider|search-degraded/);
    assert.ok(fs.existsSync(path.join(root, 'snapshots/maintenance')));
    assert.ok(readJson(root, 'state.json').runs.some((x) => x.stage === 'maintenance'));
  } finally { cleanup(root); }
});

test('maintenance: 真 provider 复检正文哈希，变更只更新不删除', async () => {
  const root = makeRoot();
  try {
    seedMaintenance(root);
    const manifest = readJson(root, 'config/manifest.json');
    manifest.providers.search = 'ddgs';
    writeJson(root, 'config/manifest.json', manifest);
    writeJson(root, 'data/discovered.json', { schema: 'discovered/v1', provider: 'ddgs', degraded: false, candidates: [] });
    const r = await runMaintenance(root, {
      now: '2026-12-31',
      fetchFn: async () => new Response('新的正文内容'.repeat(60), { status: 200 })
    });
    assert.equal(r.recheck.enabled, true);
    assert.ok(r.changedSources.includes('src-100'), '正文 hash 变更须记录');
    const s = readJson(root, 'data/sources.json').sources.find((x) => x.sourceId === 'src-100');
    assert.equal(s.fetchedAt, '2026-12-31');
    assert.ok(s.bodyExcerpt.startsWith('新的正文内容'));
  } finally { cleanup(root); }
});
