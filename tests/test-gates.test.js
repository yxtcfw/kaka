import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGates, GATE_NAMES } from '../scripts/lib/gates.js';
import { makeRoot, cleanup } from './helper.js';

const REL = 'sponsored nofollow noopener';
function goodBundle(over = {}) {
  return {
    schema: 'bundle/v1', id: 'b1', kind: 'nav-detail', title: '示例导航',
    body: '依据官方信源整理的正文内容。', cardDesc: '简短推荐语',
    toc: ['简介', '核对过的入口', '说明'],
    claims: [{ text: '月租 29 元', citationIds: ['src-001'] }],
    citations: [{ sourceId: 'src-001' }],
    links: [{ href: 'https://example.com', rel: REL, kind: 'outbound' }],
    byline: '编辑部',
    ...over
  };
}
const CTX = (root) => ({ root, sources: [{ sourceId: 'src-001', status: 'approved' }], corpus: [] });

test('六道门禁：合规 nav 详情页全部通过', () => {
  const root = makeRoot();
  try {
    const r = runGates(goodBundle(), CTX(root));
    assert.equal(r.ok, true, JSON.stringify(r.blockers));
    assert.deepEqual(r.results.map((x) => x.gate), GATE_NAMES);
  } finally { cleanup(root); }
});

test('事实闸：数字无 citation 被拦', () => {
  const root = makeRoot();
  try {
    const r = runGates(goodBundle({ claims: [{ text: '月租 9.9 元', citationIds: [] }] }), CTX(root));
    assert.equal(r.ok, false);
    assert.ok(r.blockers.some((b) => b.gate === 'fact'));
  } finally { cleanup(root); }
});

test('事实闸：claim 引用未登记 citationId 被拦', () => {
  const root = makeRoot();
  try {
    const r = runGates(goodBundle({ claims: [{ text: '月租 29 元', citationIds: ['src-999'] }] }), CTX(root));
    assert.ok(r.blockers.some((b) => b.gate === 'fact'));
  } finally { cleanup(root); }
});

test('可引用闸：status=rejected 的信源被拒', () => {
  const root = makeRoot();
  try {
    const ctx = { root, sources: [{ sourceId: 'src-001', status: 'rejected' }], corpus: [] };
    const r = runGates(goodBundle(), ctx);
    assert.ok(r.blockers.some((b) => b.gate === 'citable'));
  } finally { cleanup(root); }
});

test('可引用闸：未登记 sourceId 被拒', () => {
  const root = makeRoot();
  try {
    const r = runGates(goodBundle({ citations: [{ sourceId: 'src-404' }] }), CTX(root));
    assert.ok(r.blockers.some((b) => b.gate === 'citable'));
  } finally { cleanup(root); }
});

test('违禁词闸：命中违禁词被拦', () => {
  const root = makeRoot();
  try {
    const r = runGates(goodBundle({ body: '本文稳赚不赔，保证收益。' }), CTX(root));
    assert.ok(r.blockers.some((b) => b.gate === 'banned'));
  } finally { cleanup(root); }
});

test('重复闸：与语料余弦超 0.7 被拦', () => {
  const root = makeRoot();
  try {
    const b = goodBundle();
    const ctx = { root, sources: CTX(root).sources, corpus: [{ id: 'other', title: '示例导航', body: '依据官方信源整理的正文内容。' }] };
    const r = runGates(b, ctx);
    assert.ok(r.blockers.some((x) => x.gate === 'dedup'));
  } finally { cleanup(root); }
});

test('结构闸：cardDesc 超 60 字、nav 详情缺 TOC 被拦', () => {
  const root = makeRoot();
  try {
    const r1 = runGates(goodBundle({ cardDesc: 'x'.repeat(61) }), CTX(root));
    assert.ok(r1.blockers.some((b) => b.gate === 'structure'));
    const r2 = runGates(goodBundle({ toc: [] }), CTX(root));
    assert.ok(r2.blockers.some((b) => b.gate === 'structure'));
  } finally { cleanup(root); }
});

test('结构闸：nav 详情出站口必须恰好 1 个', () => {
  const root = makeRoot();
  try {
    const b = goodBundle({ links: [
      { href: 'https://a', rel: REL, kind: 'outbound' },
      { href: 'https://b', rel: REL, kind: 'promo' }
    ] });
    const r = runGates(b, CTX(root));
    assert.ok(r.blockers.some((x) => x.gate === 'structure'));
  } finally { cleanup(root); }
});

test('合规出站闸：缺 rel 属性被拦；内链豁免', () => {
  const root = makeRoot();
  try {
    const r1 = runGates(goodBundle({ links: [{ href: 'https://x', rel: 'nofollow', kind: 'outbound' }] }), CTX(root));
    assert.ok(r1.blockers.some((b) => b.gate === 'compliance'));
    // 内链豁免：保留一条合规出站口（structure 闸要求 nav 详情恰好 1 个），再加一条无 rel 的内链
    const r2 = runGates(goodBundle({ links: [
      { href: 'https://example.com', rel: REL, kind: 'outbound' },
      { href: '/about', rel: '', kind: 'internal' }
    ] }), CTX(root));
    assert.equal(r2.ok, true, JSON.stringify(r2.blockers));
  } finally { cleanup(root); }
});

test('文章(kind=article)不强制 TOC/单出站口，但仍过事实闸', () => {
  const root = makeRoot();
  try {
    const b = goodBundle({ kind: 'article', toc: [], links: [] });
    const r = runGates(b, CTX(root));
    assert.equal(r.ok, true);
  } finally { cleanup(root); }
});
