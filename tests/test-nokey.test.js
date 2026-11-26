// 无 key 方案专项测试：ddgs 搜索适配器 + site: 收录数估算；后期 key 通道不受影响。
// 全部用注入的 adapterFn / 虚拟时钟，零真实网络、零 spawn 依赖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ddgsSearch } from '../scripts/lib/ddgs.js';
import { searchCandidates } from '../scripts/lib/sources.js';
import { createFetchGuard } from '../scripts/lib/fetch-guard.js';
import { runFetchMetrics } from '../scripts/fetch-metrics.js';
import { validateRepo } from '../scripts/lib/validate.js';
import { makeRoot, cleanup, readJson, writeJson } from './helper.js';

test('ddgs: 注入 adapterFn 产出统一候选', async () => {
  const calls = [];
  const out = await ddgsSearch(['流量卡资费'], {
    adapterFn: async (query, limit) => {
      calls.push({ query, limit });
      return [{ url: 'https://ddg.example/1', title: '结果一', snippet: '摘要' }];
    },
    limit: 5
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].provider, 'ddgs');
  assert.equal(out[0].query, '流量卡资费');
  assert.deepEqual(calls, [{ query: '流量卡资费', limit: 5 }]);
});

test('ddgs: 经 guard 限速并记 externalCalls', async () => {
  let t = 0;
  const waits = [];
  const guard = createFetchGuard({ rpm: 60, minIntervalMs: 100, jitterMs: 0 }, {
    nowFn: () => t,
    sleepFn: async (ms) => { t += ms; waits.push(ms); },
    randomFn: () => 0
  });
  await ddgsSearch(['词A', '词B'], { guard, adapterFn: async () => [{ url: 'https://ddg.example/x' }] });
  assert.equal(guard.getStats().externalCalls, 2);
  assert.ok(waits.length > 0 && waits[0] >= 100, `waits=${waits}`);
});

test('searchCandidates: ddgs 分支真正可用（不再抛错）', async () => {
  const out = await searchCandidates(['词A', '词B'], 'ddgs', 5, {
    adapterFn: async (q) => [{ url: `https://ddg.example/${encodeURIComponent(q)}` }]
  });
  assert.equal(out.length, 2);
  assert.ok(out.every((x) => x.provider === 'ddgs'));
  assert.deepEqual(out.map((x) => x.query), ['词A', '词B']);
});

test('ddgs: 适配器不可用/失败时显式抛错，不静默伪造', async () => {
  const root = makeRoot(); // 干净基线里没有 adapters/ddgs_search.py
  try {
    await assert.rejects(() => ddgsSearch(['词'], { root }), /ddgs 适配器|ENOENT|启动失败|退出码/);
  } finally {
    cleanup(root);
  }
});

test('site-estimate: 零 key 收录数估算，显式标 estimated', async () => {
  const root = makeRoot();
  try {
    let queried = '';
    const adapterFn = async (q) => {
      queried = q;
      return Array.from({ length: 3 }, (_, i) => ({ url: `https://r.example/${i}` }));
    };
    const r = await runFetchMetrics(root, { provider: 'site-estimate', adapterFn });
    assert.equal(r.provider, 'site-estimate');
    assert.equal(r.estimated, true);
    assert.equal(queried, 'site:example.com');
    const doc = readJson(root, 'data/metrics/latest.json');
    assert.equal(doc.estimated, true);
    assert.equal(doc.rows[0].indexedEstimate, 3);
    assert.equal(doc.rows[0].method, 'ddgs-result-count-lower-bound');
    assert.ok(doc.note.includes('非 GSC'), `note=${doc.note}`);
  } finally {
    cleanup(root);
  }
});

test('site-estimate: domain 为空时降级，不伪造数据', async () => {
  const root = makeRoot();
  try {
    const m = readJson(root, 'config/manifest.json');
    writeJson(root, 'config/manifest.json', { ...m, domain: '' });
    const r = await runFetchMetrics(root, { provider: 'site-estimate', adapterFn: async () => [] });
    assert.equal(r.degraded, true);
    assert.equal(r.rows, 0);
  } finally {
    cleanup(root);
  }
});

test('site-estimate: 适配器失败时降级跳过，不写 0 条冒充估算', async () => {
  const root = makeRoot();
  try {
    const r = await runFetchMetrics(root, {
      provider: 'site-estimate',
      adapterFn: async () => { throw new Error('模拟适配器故障'); }
    });
    assert.equal(r.degraded, true);
    assert.equal(r.rows, 0);
    assert.ok(r.reason.includes('模拟适配器故障'));
    const fs = await import('node:fs');
    assert.equal(fs.existsSync(path.join(root, 'data/metrics/latest.json')), false);
  } finally {
    cleanup(root);
  }
});

test('后期 key 通道保留：GSC 无 key 仍降级跳过，不伪造', async () => {
  const root = makeRoot();
  try {
    const r = await runFetchMetrics(root, { provider: 'gsc' });
    assert.equal(r.degraded, true);
    assert.equal(r.rows, 0);
  } finally {
    cleanup(root);
  }
});

test('manifest schema 要求 metrics provider（配置化不可缺）', () => {
  const root = makeRoot();
  try {
    assert.equal(validateRepo(root).ok, true);
    const m = readJson(root, 'config/manifest.json');
    const { metrics, ...providers } = m.providers;
    writeJson(root, 'config/manifest.json', { ...m, providers });
    assert.equal(validateRepo(root).ok, false);
  } finally {
    cleanup(root);
  }
});
