import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, readJson, writeJson } from './helper.js';
import { assignTerms, buildCuratedTree } from '../scripts/curate-tree.js';

const RULES = {
  maxKeywordsPerNode: 60,
  parents: [{ id: 'auto-scene', parent: 'n0', label: '场景卡种', topic: '场景卡' }],
  nodes: [
    { id: 'auto-sub', parent: 'auto-scene', label: '副卡办理', topic: '副卡', pattern: '副卡' },
    { id: 'auto-cm', parent: 'n0', label: '移动', topic: '移动', pattern: '移动' },
    { id: 'n2', parent: 'n0', label: '办理攻略', topic: '办理', pattern: '办理|入口|官网' },
    { id: 'n1', parent: 'n0', label: '资费套餐', topic: '资费', pattern: '资费|价格|[0-9]+元|大流量' }
  ],
  fallback: 'n1'
};

test('assignTerms: 互斥分组、优先级先生效、未命中进 fallback', () => {
  const { buckets } = assignTerms(['副卡办理条件', '移动资费', '流量卡价格', '随便一个词'], RULES);
  assert.equal(buckets.get('auto-sub')[0], '副卡办理条件', '副卡规则须优先于办理规则');
  assert.equal(buckets.get('auto-cm')[0], '移动资费', '移动规则须优先于资费规则');
  assert.ok(buckets.get('n1').includes('流量卡价格'));
  assert.ok(buckets.get('n1').includes('随便一个词'), '未命中须进 fallback');
});

test('curate-tree: 助手建树写入分层节点，329 词场景全覆盖，幂等不重复建节点', () => {
  const root = makeRoot();
  try {
    writeJson(root, 'data/signals.json', {
      schema: 'signals/v1', items: Array.from({ length: 40 }, (_, i) => ({ term: `副卡办理条件${i}` }))
    });
    writeJson(root, 'rules/curated-tree.json', RULES);
    const r1 = buildCuratedTree(root, {});
    assert.equal(r1.provider, 'assistant-curated');
    assert.equal(r1.covered, 40);
    const tree1 = readJson(root, 'data/tree.json');
    const scene = tree1.nodes.find((n) => n.id === 'auto-scene');
    const sub = tree1.nodes.find((n) => n.id === 'auto-sub');
    assert.ok(scene && sub, '容器与子节点须写入');
    assert.equal(sub.parent, 'auto-scene', '子节点挂载到容器');
    assert.ok(scene.children.includes('auto-sub'), '父节点 children 须同步');
    assert.equal(sub.keywords.length, 40, '关键词须按分组写入');
    assert.ok(fs.existsSync(path.join(root, 'reports/curate-tree.json')), '报告须落盘');

    const r2 = buildCuratedTree(root, {});
    const tree2 = readJson(root, 'data/tree.json');
    assert.equal(tree2.nodes.length, tree1.nodes.length, '重复运行不新增重复节点');
    assert.deepEqual(tree2.nodes.find((n) => n.id === 'auto-sub').keywords, sub.keywords, '重复运行关键词不变');
  } finally {
    cleanup(root);
  }
});

test('curate-tree: 规则节点 parent 不存在时拒绝，不破坏树结构', () => {
  const root = makeRoot();
  try {
    writeJson(root, 'data/signals.json', { schema: 'signals/v1', items: [{ term: '副卡办理' }] });
    writeJson(root, 'rules/curated-tree.json', {
      ...RULES,
      parents: [{ id: 'auto-orphan', parent: 'nX', label: '孤儿', topic: '孤儿' }],
      nodes: []
    });
    const r = buildCuratedTree(root, {});
    assert.ok(r.rejected.some((x) => x.id === 'auto-orphan' && x.reason === 'invalid-parent'));
    const tree = readJson(root, 'data/tree.json');
    assert.ok(!tree.nodes.some((n) => n.id === 'auto-orphan'), '非法父节点不写入');
  } finally {
    cleanup(root);
  }
});
