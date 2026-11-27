import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, readJson, REPO } from './helper.js';
import { runFetchMetrics } from '../scripts/fetch-metrics.js';

const KEY = 'bing-test-key-123456';

function withKey(fn) {
  const old = process.env.BING_API_KEY;
  process.env.BING_API_KEY = KEY;
  return Promise.resolve(fn()).finally(() => {
    if (old === undefined) delete process.env.BING_API_KEY;
    else process.env.BING_API_KEY = old;
  });
}

function fakeFetch(payload, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  });
}

test('bing 回流：走官方 JSON 端点，解析 d 包装与 /Date()/ 日期，不写明文 key', async () => {
  const root = makeRoot();
  let calledUrl = '';
  const stamp = Date.parse('2026-11-27T00:00:00Z');
  try {
    await withKey(async () => {
      const r = await runFetchMetrics(root, {
        provider: 'bing',
        fetchFn: async (url) => {
          calledUrl = url;
          return fakeFetch({ d: [
            { Query: '/', Impressions: 120, Clicks: 12, AvgClickPosition: 3.45, Date: `/Date(${stamp}-0000)/` },
            { Url: 'https://example.com/nav/a.html', Impressions: 8, Clicks: 0, AvgImpressionPosition: 9, Date: '2026-11-26' },
            { Query: '零数据', Impressions: 0, Clicks: 0 }
          ] })();
        }
      });
      assert.equal(r.degraded, undefined, '成功路径不标 degraded');
      assert.equal(r.estimated, false, '真实回流不得标 estimated=true');
      assert.equal(r.rows, 2, '零行数据被过滤');
      assert.match(calledUrl, /^https:\/\/ssl\.bing\.com\/webmaster\/api\.svc\/json\/GetPageStats\?/);
      assert.ok(calledUrl.includes(`apikey=${KEY}`), '官方规范要求 key 走 query 参数');
      assert.ok(calledUrl.includes('siteUrl=https%3A%2F%2Fexample.com%2F'));
      const doc = readJson(root, 'data/metrics/latest.json');
      assert.equal(doc.provider, 'bing');
      assert.equal(doc.estimated, false);
      assert.equal(doc.rows[0].page, '/');
      assert.equal(doc.rows[0].impressions, 120);
      assert.equal(doc.rows[0].avgPosition, 3.5);
      assert.equal(doc.rows[0].collectedAt, '2026-11-27');
      assert.equal(doc.rows[1].collectedAt, '2026-11-26');
      const reportText = fs.readFileSync(path.join(root, 'reports/metrics.json'), 'utf8');
      assert.ok(!reportText.includes(KEY), '报告不得出现明文 key');
      const report = readJson(root, 'reports/metrics.json');
      assert.match(report.guard.keyFingerprint, /^[0-9a-f]{8}$/);
    });
  } finally { cleanup(root); }
});

test('bing 回流：无 key 时零网络调用、显式降级且不留假数据', async () => {
  const root = makeRoot();
  const old = process.env.BING_API_KEY;
  delete process.env.BING_API_KEY;
  let calls = 0;
  try {
    const r = await runFetchMetrics(root, {
      provider: 'bing',
      fetchFn: async () => { calls++; return fakeFetch({ d: [] })(); }
    });
    assert.equal(r.degraded, true);
    assert.equal(r.rows, 0);
    assert.equal(calls, 0);
    assert.match(r.reason, /缺少 BING_API_KEY/);
    const report = readJson(root, 'reports/metrics.json');
    assert.equal(report.rows, 0);
    assert.equal(report.keyFingerprint, 'none');
    assert.equal(fs.existsSync(path.join(root, 'data/metrics/latest.json')), false, '降级不写 latest.json');
  } finally {
    if (old !== undefined) process.env.BING_API_KEY = old;
    cleanup(root);
  }
});

test('bing 回流：ErrorCode 与 HTTP 错误中的 key 被脱敏', async () => {
  const root = makeRoot();
  try {
    await withKey(async () => {
      const r1 = await runFetchMetrics(root, {
        provider: 'bing',
        fetchFn: fakeFetch({ ErrorCode: 3, Message: `InvalidApiKey ${KEY}` })
      });
      assert.equal(r1.degraded, true);
      assert.match(r1.reason, /Bing API 3/);
      assert.ok(!r1.reason.includes(KEY), '错误原因不得出现明文 key');
      assert.ok(r1.reason.includes('***'));

      const r2 = await runFetchMetrics(root, {
        provider: 'bing',
        fetchFn: async () => ({
          ok: false, status: 401,
          text: async () => `Unauthorized apikey=${KEY}`
        })
      });
      assert.equal(r2.degraded, true);
      assert.match(r2.reason, /HTTP 401/);
      assert.ok(!r2.reason.includes(KEY), 'HTTP 错误文本也要脱敏');
    });
  } finally { cleanup(root); }
});

test('编排与调度：pipeline 汇总含 metrics，workflow 支持手动指定 provider', () => {
  const cli = fs.readFileSync(path.join(REPO, 'scripts/cli.js'), 'utf8');
  const wf = fs.readFileSync(path.join(REPO, '.github/workflows/pipeline.yml'), 'utf8');
  assert.match(cli, /metrics: \{ provider: metrics\.provider/);
  assert.match(wf, /metricsProvider:/);
  assert.match(wf, /BING_API_KEY: \$\{\{ secrets\.BING_API_KEY \}\}/);
});
