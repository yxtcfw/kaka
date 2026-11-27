// 防风控单测：robots / 限速 / 抖动 / 退避 / 超时 / UA / 并发 / 默认不联网 / 真 provider 收口。
// 全部用依赖注入的虚拟时钟与假 fetchFn，零真实网络、零真实等待。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFetchGuard, robotsAllowed, parseRobots,
  GuardDenied, GuardTimeout, GuardError
} from '../scripts/lib/fetch-guard.js';
import { searchCandidates } from '../scripts/lib/sources.js';
import { runDiscover } from '../scripts/discover-sources.js';
import { validateRepo } from '../scripts/lib/validate.js';
import { makeRoot, cleanup, readJson, writeJson } from './helper.js';

function virtualDeps(extra = {}) {
  const state = { t: 0, waits: [] };
  return {
    state,
    sleepFn: async (ms) => { state.t += ms; state.waits.push(ms); },
    nowFn: () => state.t,
    ...extra
  };
}

test('guard.request: 原生 Response 的 text() 会被 await，不再字符串化函数', async () => {
  const v = virtualDeps({
    fetchFn: async () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  });
  const guard = createFetchGuard({ schema: 'rules/collect-policy/v1', enabled: true }, v);
  const r = await guard.request('https://example.com/api');
  assert.equal(r.text, '{"ok":true}');
});

test('discover: 真 provider 失败时降级 mock 并写清 reason', async () => {
  const root = makeRoot();
  try {
    const manifest = readJson(root, 'config/manifest.json');
    manifest.providers.search = 'ddgs';
    writeJson(root, 'config/manifest.json', manifest);
    const r = await runDiscover(root, { adapterFn: async () => { throw new Error('backend down'); } });
    assert.equal(r.degraded, true);
    assert.match(r.reason, /backend down/);
  } finally { cleanup(root); }
});

test('robots: 最长前缀匹配与 Allow 优先', () => {
  const txt = 'User-agent: *\nDisallow: /private\nAllow: /private/ok\nCrawl-delay: 2\n';
  assert.equal(robotsAllowed(txt, 'https://x.com/private/x', 'bot').allowed, false);
  assert.equal(robotsAllowed(txt, 'https://x.com/private/ok/a', 'bot').allowed, true);
  assert.equal(robotsAllowed(txt, 'https://x.com/public', 'bot').allowed, true);
  assert.equal(robotsAllowed(txt, 'https://x.com/public', 'bot').crawlDelayMs, 2000);
  assert.equal(parseRobots(txt).groups[0].userAgents[0], '*');
});

test('robots: 具体 UA 组优先且不继承通配组', () => {
  const txt = 'User-agent: *\nDisallow: /private\n\nUser-agent: vertical-site-template\nDisallow: /blocked\nCrawl-delay: 1\n';
  const v = robotsAllowed(txt, 'https://x.com/private/x', 'vertical-site-template');
  assert.equal(v.allowed, true, '具体 UA 组覆盖了通配组');
  assert.equal(robotsAllowed(txt, 'https://x.com/blocked', 'vertical-site-template').allowed, false);
  assert.equal(v.crawlDelayMs, 1000);
});

test('robots: 命中 Disallow 时拒绝请求且不调用 fetchFn', async () => {
  let called = 0;
  const guard = createFetchGuard({ rpm: 60, minIntervalMs: 0 }, {
    ...virtualDeps(),
    robotsTxt: 'User-agent: *\nDisallow: /private\n',
    fetchFn: async () => { called++; return { status: 200, text: 'ok' }; }
  });
  await assert.rejects(() => guard.request('https://x.com/private/a'), (e) => e instanceof GuardDenied && e.reason === 'robots');
  assert.equal(called, 0);
  assert.equal(guard.getStats().denied, 1);
});

test('限速: rpm 窗口满时按虚拟时钟等待', async () => {
  const dep = virtualDeps({ fetchFn: async () => ({ status: 200, text: 'ok' }) });
  const guard = createFetchGuard({ rpm: 2, minIntervalMs: 0, jitterMs: 0, robotsTxt: '' }, dep);
  await guard.request('https://x.com/1');
  await guard.request('https://x.com/2');
  await guard.request('https://x.com/3');
  assert.ok(dep.state.waits.some((w) => w >= 59000), `应触发窗口等待，实际 ${dep.state.waits}`);
  assert.ok(guard.getStats().waitsMs >= 59000);
});

test('抖动: jitterMs 在 minInterval 为 0 时生效', async () => {
  const dep = virtualDeps({ randomFn: () => 0.5, fetchFn: async () => ({ status: 200, text: 'ok' }) });
  const guard = createFetchGuard({ rpm: 60, minIntervalMs: 0, jitterMs: 100, robotsTxt: '' }, dep);
  await guard.request('https://x.com/1');
  await guard.request('https://x.com/2');
  assert.deepEqual(dep.state.waits, [50]);
});

test('退避: 429 + Retry-After 优先于指数退避', async () => {
  let n = 0;
  const dep = virtualDeps({
    randomFn: () => 0,
    fetchFn: async () => (++n === 1
      ? { status: 429, headers: { 'retry-after': '1' } }
      : { status: 200, text: 'ok', headers: {} })
  });
  const guard = createFetchGuard({ rpm: 60, minIntervalMs: 0, jitterMs: 0, maxRetries: 2, backoffBaseMs: 1000, robotsTxt: '' }, dep);
  const r = await guard.request('https://x.com/a');
  assert.equal(r.attempts, 2);
  assert.equal(r.text, 'ok');
  assert.deepEqual(dep.state.waits, [1000]);
  assert.equal(guard.getStats().retries, 1);
});

test('退避: 5xx 走指数退避上限', async () => {
  let n = 0;
  const dep = virtualDeps({
    randomFn: () => 0,
    fetchFn: async () => (++n <= 2 ? { status: 503, headers: {} } : { status: 200, text: 'ok', headers: {} })
  });
  const guard = createFetchGuard({ rpm: 60, minIntervalMs: 0, jitterMs: 0, maxRetries: 3, backoffBaseMs: 1000, backoffMaxMs: 2000, robotsTxt: '' }, dep);
  const r = await guard.request('https://x.com/a');
  assert.equal(r.attempts, 3);
  assert.deepEqual(dep.state.waits, [1000, 2000]);
});

test('超时: signal abort 触发 GuardTimeout（不依赖真实 timer）', async () => {
  const guard = createFetchGuard({ timeoutMs: 1000, maxRetries: 0, rpm: 60, minIntervalMs: 0, jitterMs: 0, robotsTxt: '' }, {
    sleepFn: async () => {},
    fetchFn: (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      external.abort(); // 注入式外部取消，等价于超时信号到达
    })
  });
  const external = new AbortController();
  assert.equal(guard.config.timeoutMs, 1000);
  await assert.rejects(() => guard.request('https://x.com/a', { signal: external.signal }), (e) => e instanceof GuardTimeout);
  assert.equal(guard.getStats().timeouts, 1);
});

test('User-Agent: 每次请求都注入策略指定的 UA', async () => {
  let ua = '';
  const guard = createFetchGuard({ rpm: 60, minIntervalMs: 0, robotsTxt: '' }, {
    ...virtualDeps(),
    fetchFn: async (url, opts) => { ua = opts.headers['User-Agent']; return { status: 200, text: 'ok' }; }
  });
  await guard.request('https://x.com/a');
  assert.ok(ua.includes('vertical-site-template'), `UA=${ua}`);
});

test('并发: 上限由 policy.concurrency 约束', async () => {
  const guard = createFetchGuard({ concurrency: 2, rpm: 100, minIntervalMs: 0, robotsTxt: '' }, {
    ...virtualDeps(),
    fetchFn: async () => ({ status: 200, text: 'ok' })
  });
  await Promise.all(Array.from({ length: 8 }, (_, i) => guard.request(`https://x.com/${i}`)));
  assert.ok(guard.getStats().concurrencyPeak <= 2, `peak=${guard.getStats().concurrencyPeak}`);
  assert.equal(guard.getStats().requests, 8);
});

test('默认不联网: 未注入 fetchFn 时硬拒绝', async () => {
  const guard = createFetchGuard({ robotsTxt: '' }, virtualDeps());
  await assert.rejects(() => guard.request('https://x.com/a'), (e) => e instanceof GuardError && e.reason === 'no-fetchFn');
});

test('总开关: enabled=false 硬拒绝所有请求', async () => {
  let called = 0;
  const guard = createFetchGuard({ enabled: false, robotsTxt: '' }, {
    ...virtualDeps(),
    fetchFn: async () => { called++; return { status: 200, text: 'ok' }; }
  });
  await assert.rejects(() => guard.request('https://x.com/a'), (e) => e instanceof GuardDenied && e.reason === 'disabled');
  assert.equal(called, 0);
});

test('真 provider 收口: tavily 经 guard 发请求并注入 UA，mock 链路零 guard', async () => {
  const root = makeRoot();
  const oldKey = process.env.TAVILY_API_KEY;
  try {
    process.env.TAVILY_API_KEY = 'test-key';
    const calls = [];
    const fetchFn = async (url, opts) => {
      calls.push({ url, ua: opts.headers['User-Agent'] });
      return { status: 200, text: JSON.stringify({ results: [{ url: 'https://a.example/x', title: 'A', content: '摘要' }] }), headers: {} };
    };
    const c = await searchCandidates(['流量卡资费'], 'tavily', 1, { root, fetchFn });
    assert.equal(c.length, 1);
    assert.equal(c[0].provider, 'tavily');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].ua.includes('vertical-site-template'));
    const mock = await runDiscover(root, { dryRun: true, limit: 3 });
    assert.equal(mock.guard.enabled, false);
    assert.equal(mock.degraded, false);
  } finally {
    if (oldKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = oldKey;
    cleanup(root);
  }
});

test('策略契约: collect-policy 进 validateRepo 且越界值会被拦截', () => {
  const root = makeRoot();
  try {
    assert.equal(validateRepo(root).ok, true);
    const policy = readJson(root, 'rules/collect-policy.json');
    writeJson(root, 'rules/collect-policy.json', { ...policy, rpm: 9999 });
    const v = validateRepo(root);
    assert.equal(v.ok, false);
    assert.ok(v.results.some((r) => r.file === 'rules/collect-policy.json' && r.errors.length > 0));
  } finally {
    cleanup(root);
  }
});

test('guard-check: 一键自检验证安全阀且不联网', async () => {
  const root = makeRoot();
  try {
    const { runGuardCheck } = await import('../scripts/guard-check.js');
    const r = await runGuardCheck(root, {});
    assert.equal(r.ok, true);
    assert.equal(r.selfTest.retryWorked, true);
    assert.equal(r.selfTest.robotsBlocked, true);
    assert.equal(r.selfTest.uaInjected, true);
    assert.equal(r.selfTest.realNetwork, false);
    assert.ok(r.selfTest.backoffMs > 0);
  } finally {
    cleanup(root);
  }
});
