// 防风控自检：用注入的假 fetchFn 验证 robots 拦截 / 429 退避 / UA 注入，零真实网络。
// 作用：接真 provider 前，运维可一键确认安全阀确实生效（不依赖外部服务可用）。
import path from 'node:path';
import { ROOT } from './lib/validate.js';
import { createFetchGuard, GuardDenied } from './lib/fetch-guard.js';
import { loadCollectPolicy } from './lib/sources.js';

export async function runGuardCheck(root = ROOT, args = {}) {
  const policy = loadCollectPolicy(root);
  const deps = {
    nowFn: () => clock.t,
    sleepFn: async (ms) => { clock.t += ms; waits.push(ms); },
    randomFn: () => 0,
    robotsTxt: 'User-agent: *\nDisallow: /private\n',
    fetchFn: async (url, opts) => {
      calls.push({ url, ua: opts.headers['User-Agent'] });
      return calls.length === 1
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200, text: 'ok', headers: {} };
    }
  };
  const clock = { t: 0 };
  const waits = [];
  const calls = [];

  // 自检固定用严格参数，避免策略里的 rpm/间隔拖慢自检；robots 仍按策略开关走。
  const guard = createFetchGuard({
    ...policy,
    rpm: 2,
    minIntervalMs: 0,
    jitterMs: 0,
    maxRetries: 2
  }, deps);

  let retried = null;
  let blocked = false;
  try {
    retried = await guard.request('https://guard-check.example/a');
  } catch (e) {
    retried = { error: e.message };
  }
  try {
    await guard.request('https://guard-check.example/private/x');
  } catch (e) {
    blocked = e instanceof GuardDenied && e.reason === 'robots';
  }

  const stats = guard.getStats();
  const retryWorked = retried?.attempts === 2 && retried?.text === 'ok';
  const uaInjected = calls.length > 0 && calls.every((c) => String(c.ua).includes(policy.userAgentToken || 'vertical-site-template'));
  const result = {
    stage: 'guard-check',
    policy: {
      enabled: policy.enabled,
      rpm: policy.rpm,
      concurrency: policy.concurrency,
      timeoutMs: policy.timeoutMs,
      maxRetries: policy.maxRetries,
      respectRobots: policy.respectRobots,
      userAgentToken: policy.userAgentToken
    },
    selfTest: {
      retryWorked,
      robotsBlocked: blocked,
      uaInjected,
      backoffMs: stats.waitsMs,
      retries: stats.retries,
      denied: stats.denied,
      realNetwork: false
    },
    ok: retryWorked && blocked && uaInjected && policy.enabled !== false
  };
  return result;
}
