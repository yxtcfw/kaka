import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmStatus, suggestTreeRules, composeBundle } from '../scripts/lib/llm.js';

// 假模型响应：OpenAI 兼容 { choices:[{ message:{ content } }] }
function fakeRes(content, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content } }] })
  };
}

test('llmStatus: mock 恒可用，真 provider 无水 key 时不可用且只露指纹', () => {
  assert.equal(llmStatus('mock').available, true);
  const s = llmStatus('openrouter');
  // 当前进程未注入 key（测试不读真实环境），若无 key 则 available=false
  assert.equal(typeof s.available, 'boolean');
  assert.ok(Array.isArray(s.fingerprint));
  for (const fp of s.fingerprint) assert.match(fp, /^[0-9a-f]{8}$/);
});

test('suggestTreeRules: 真 provider 模型分组只接受合法 nodeId，其余归 n0', async () => {
  const prev = process.env.TESTLLM_API_KEY;
  process.env.TESTLLM_API_KEY = 'k';
  // 用 openrouter 走 env：临时注入
  const old = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'test-key-a';
  try {
    const fetchFn = async () => fakeRes('```json\n{"grouped":{"n1":["流量卡资费"],"hack":["移动办理"]}}\n```');
    const r = await suggestTreeRules('openrouter', ['流量卡资费', '移动办理'], { '资费': 'n1' }, { fetchFn });
    assert.equal(r.degraded, false);
    assert.equal(r.deterministic, false);
    assert.deepEqual(r.grouped.n1, ['流量卡资费']);
    assert.deepEqual(r.grouped.n0, ['移动办理'], '非法 nodeId hack 的词必须归 n0');
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = old;
    if (prev === undefined) delete process.env.TESTLLM_API_KEY; else process.env.TESTLLM_API_KEY = prev;
  }
});

test('composeBundle: 真 provider 产出正文与带合法 citation 的 claim', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'test-key-b';
  try {
    const fetchFn = async () => fakeRes(JSON.stringify({
      body: '依据已登记信源整理的客观介绍正文。',
      cardDesc: '一句话卡片描述',
      claims: [
        { text: '月租29元', citationIds: ['src-001'] },   // 合法
        { text: '月租1元', citationIds: ['src-999'] }     // 非法 sourceId，应被剔除
      ]
    }));
    const r = await composeBundle('openrouter', {
      id: 't1', kind: 'article', title: '测试', sourceIds: ['src-001'], cardDesc: '', toc: [], links: [], byline: ''
    }, { fetchFn });
    assert.equal(r._meta.degraded, false);
    assert.equal(r.body, '依据已登记信源整理的客观介绍正文。');
    assert.equal(r.claims.length, 1);
    assert.equal(r.claims[0].citationIds[0], 'src-001');
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = old;
  }
});

test('composeBundle: 模型失败时降级 mock，显式标 degraded 不静默伪造', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'test-key-c';
  try {
    const fetchFn = async () => { throw new Error('network down'); };
    const r = await composeBundle('openrouter', {
      id: 't2', kind: 'article', title: '测试', sourceIds: ['src-001'], cardDesc: 'x', toc: [], links: [], byline: ''
    }, { fetchFn, maxRetries: 0 });
    assert.equal(r._meta.degraded, true);
    assert.ok(r._meta.reason);
    assert.equal(r.claims.length, 0, '降级路径不得伪造 claim');
    assert.ok(r.body.includes('依据已登记信源整理'));
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = old;
  }
});

test('composeBundle: 无 key 直接走 mock，零网络调用', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  const old2 = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEYS;
  delete process.env.OPENROUTER_API_KEY;
  let called = 0;
  try {
    const r = await composeBundle('openrouter', {
      id: 't3', kind: 'article', title: '无key', sourceIds: [], cardDesc: '', toc: [], links: [], byline: ''
    }, { fetchFn: async () => { called++; return fakeRes('{}'); } });
    assert.equal(called, 0, '无 key 不得发请求');
    assert.equal(r._meta.provider, 'mock-fallback');
    assert.equal(r.claims.length, 0);
  } finally {
    if (old !== undefined) process.env.OPENROUTER_API_KEYS = old;
    if (old2 !== undefined) process.env.OPENROUTER_API_KEY = old2;
  }
});

test('composeBundle: 429 退避后换 key 重试成功', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'key-1,key-2';
  try {
    let n = 0;
    const fetchFn = async () => {
      n++;
      return n === 1 ? fakeRes('', 429) : fakeRes(JSON.stringify({ body: 'OK正文', cardDesc: 'ok', claims: [] }));
    };
    const r = await composeBundle('openrouter', {
      id: 't4', kind: 'article', title: '退避', sourceIds: [], cardDesc: '', toc: [], links: [], byline: ''
    }, { fetchFn, maxRetries: 1 });
    assert.equal(r._meta.degraded, false);
    assert.equal(r.body, 'OK正文');
    assert.equal(n, 2, '第一次 429，第二次换 key 成功');
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = old;
  }
});
