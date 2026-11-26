// 采集防风控统一封装。零运行时依赖；所有 I/O 通过依赖注入，默认不发真实网络请求。
// 设计纪律：mock 链路完全不经过这里；真 provider 必须经此封装发请求。
// 注入点：fetchFn(url, opts) / sleepFn(ms) / nowFn() / randomFn() / robotsFor(origin) / robotsTxt。
// 默认时钟为虚拟时钟（sleep 只推进计数），因此未注入真实 fetchFn/sleepFn 时可安全自测。

export const DEFAULT_POLICY = {
  schema: 'rules/collect-policy/v1',
  enabled: true,
  userAgent: 'vertical-site-template/1.0 (+bot; contact: webmaster@example.com)',
  userAgentToken: 'vertical-site-template',
  timeoutMs: 10000,
  rpm: 12,
  minIntervalMs: 1000,
  jitterMs: 500,
  maxRetries: 2,
  backoffBaseMs: 1000,
  backoffMaxMs: 10000,
  concurrency: 2,
  respectRobots: true,
  crawlDelayFallbackMs: 0,
  retryStatuses: [429, 500, 502, 503, 504]
};

export class GuardDenied extends Error {
  constructor(reason, detail) {
    super(`fetch guard denied: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'GuardDenied';
    this.reason = reason;
    this.detail = detail;
  }
}
export class GuardTimeout extends Error {
  constructor(detail) {
    super(`fetch guard timeout: ${detail}`);
    this.name = 'GuardTimeout';
    this.detail = detail;
  }
}
export class GuardError extends Error {
  constructor(reason, detail) {
    super(`fetch guard error: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'GuardError';
    this.reason = reason;
    this.detail = detail;
  }
}

function num(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function headerOf(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

// ---- robots.txt 解析与判定（最具体 UA 优先；Allow/Disallow 最长前缀胜出）----
export function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      const ua = val.toLowerCase();
      let g = groups.find((x) => x.userAgents.includes(ua));
      if (!g) {
        g = { userAgents: [], allow: [], disallow: [], crawlDelayMs: null };
        groups.push(g);
      }
      g.userAgents.push(ua);
      current = g;
    } else if (!current) {
      continue;
    } else if (key === 'allow') {
      current.allow.push(val);
    } else if (key === 'disallow') {
      if (val) current.disallow.push(val);
    } else if (key === 'crawl-delay') {
      const n = Number(val);
      if (Number.isFinite(n)) current.crawlDelayMs = Math.max(0, n * 1000);
    }
  }
  return { groups };
}

function matchGroup(groups, ua) {
  const lower = String(ua || '').toLowerCase();
  const token = lower.split(/[\s/]+/)[0];
  let best = null;
  let bestLen = -1;
  for (const g of groups) {
    for (const a of g.userAgents) {
      if (a === '*') {
        if (best === null) best = g;
        continue;
      }
      if (lower.includes(a) || token.includes(a) || a.includes(token)) {
        if (a.length > bestLen) { best = g; bestLen = a.length; }
      }
    }
  }
  return best;
}

function pathAllowed(group, pathname) {
  let bestLen = -1;
  let allowed = true;
  for (const rule of group.disallow) {
    if (pathname.startsWith(rule) && rule.length > bestLen) { bestLen = rule.length; allowed = false; }
  }
  for (const rule of group.allow) {
    if (pathname.startsWith(rule) && rule.length > bestLen) { bestLen = rule.length; allowed = true; }
  }
  return allowed;
}

export function robotsAllowed(text, url, ua) {
  if (!text) return { allowed: true, crawlDelayMs: 0, matched: null, checked: false };
  const groups = parseRobots(text).groups;
  const g = matchGroup(groups, ua);
  if (!g) return { allowed: true, crawlDelayMs: 0, matched: null, checked: true };
  let pathname = '/';
  try { pathname = new URL(url).pathname || '/'; } catch { /* 非 URL 按根路径处理 */ }
  const allowed = pathAllowed(g, pathname);
  return { allowed, crawlDelayMs: g.crawlDelayMs || 0, matched: g.userAgents.slice(), checked: true };
}

// ---- guard 实例 ----
export function createFetchGuard(policy = DEFAULT_POLICY, deps = {}) {
  const cfg = { ...DEFAULT_POLICY, ...(policy || {}) };
  cfg.enabled = cfg.enabled !== false;
  cfg.timeoutMs = num(cfg.timeoutMs, 10000, 1, 120000);
  cfg.rpm = num(cfg.rpm, 12, 1, 600);
  cfg.minIntervalMs = num(cfg.minIntervalMs, 1000, 0, 600000);
  cfg.jitterMs = num(cfg.jitterMs, 500, 0, 60000);
  cfg.maxRetries = Math.floor(num(cfg.maxRetries, 2, 0, 5));
  cfg.backoffBaseMs = num(cfg.backoffBaseMs, 1000, 0, 600000);
  cfg.backoffMaxMs = num(cfg.backoffMaxMs, 10000, 0, 600000);
  cfg.concurrency = Math.floor(num(cfg.concurrency, 2, 1, 16));
  cfg.crawlDelayFallbackMs = num(cfg.crawlDelayFallbackMs, 0, 0, 600000);
  cfg.retryStatuses = Array.isArray(cfg.retryStatuses) ? cfg.retryStatuses.map(Number) : DEFAULT_POLICY.retryStatuses;

  const fetchFn = typeof deps.fetchFn === 'function' ? deps.fetchFn : null;
  const robotsFor = typeof deps.robotsFor === 'function' ? deps.robotsFor : null;
  const randomFn = typeof deps.randomFn === 'function' ? deps.randomFn : Math.random;
  const clock = { t: 0 };
  const nowFn = typeof deps.nowFn === 'function' ? deps.nowFn : () => clock.t;
  const sleepFn = typeof deps.sleepFn === 'function' ? deps.sleepFn : async (ms) => { clock.t += ms; };

  const stats = {
    requests: 0, retries: 0, waitsMs: 0, denied: 0, timeouts: 0,
    robotsChecked: 0, concurrencyPeak: 0, errors: 0, externalCalls: 0
  };
  const windowTs = [];
  let lastRequestAt = null;
  let active = 0;
  const waiters = [];
  const robotsCache = new Map();

  async function acquire() {
    if (active < cfg.concurrency) { active += 1; stats.concurrencyPeak = Math.max(stats.concurrencyPeak, active); return; }
    await new Promise((resolve) => waiters.push(resolve));
    active += 1;
    stats.concurrencyPeak = Math.max(stats.concurrencyPeak, active);
  }
  function release() {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) next();
  }

  async function throttle(extraMs = 0) {
    // 抖动/robots crawl-delay 是一次性额外等待；sleep 后清零，避免循环内重复加导致永不收敛。
    let extra = extraMs + (lastRequestAt === null ? 0 : Math.floor(randomFn() * cfg.jitterMs));
    for (let guard = 0; guard < 10; guard++) {
      const t = nowFn();
      const inWindow = windowTs.filter((x) => t - x < 60000);
      windowTs.length = 0;
      windowTs.push(...inWindow);
      let wait = 0;
      if (inWindow.length >= cfg.rpm) wait = Math.max(wait, 60000 - (t - inWindow[0]));
      if (lastRequestAt !== null) wait = Math.max(wait, cfg.minIntervalMs - (t - lastRequestAt));
      wait = Math.max(wait, extra);
      if (wait <= 0) {
        windowTs.push(t);
        lastRequestAt = t;
        return;
      }
      await sleepFn(wait);
      stats.waitsMs += wait;
      extra = 0;
    }
  }

  async function backoff(attempt, resp) {
    const retryAfter = headerOf(resp?.headers, 'retry-after');
    let ms;
    if (retryAfter !== undefined && retryAfter !== null && retryAfter !== '') {
      const seconds = Number(retryAfter);
      ms = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(String(retryAfter)) - nowFn());
    } else {
      ms = Math.min(cfg.backoffBaseMs * (2 ** attempt), cfg.backoffMaxMs);
    }
    ms += Math.floor(randomFn() * cfg.jitterMs);
    ms = Math.max(0, ms);
    if (ms > 0) { await sleepFn(ms); stats.waitsMs += ms; }
  }

  function signalFor(external) {
    const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
    try {
      return external ? AbortSignal.any([external, timeoutSignal]) : timeoutSignal;
    } catch {
      return timeoutSignal;
    }
  }

  async function robotsForUrl(url) {
    if (!cfg.respectRobots) return { allowed: true, crawlDelayMs: cfg.crawlDelayFallbackMs, matched: null, checked: false };
    let txt = null;
    if (typeof deps.robotsTxt === 'string') {
      txt = deps.robotsTxt;
    } else if (robotsFor) {
      let origin = '';
      try { origin = new URL(url).origin; } catch { origin = String(url); }
      if (!robotsCache.has(origin)) {
        try { robotsCache.set(origin, (await robotsFor(origin, api)) || ''); }
        catch { robotsCache.set(origin, ''); }
      }
      txt = robotsCache.get(origin);
    }
    const ua = cfg.userAgentToken || cfg.userAgent;
    const verdict = robotsAllowed(txt, url, ua);
    stats.robotsChecked += verdict.checked ? 1 : 0;
    const crawlDelayMs = verdict.crawlDelayMs || cfg.crawlDelayFallbackMs || 0;
    return { ...verdict, crawlDelayMs };
  }

  async function core(url, opts, skipRobots) {
    if (!cfg.enabled) throw new GuardDenied('disabled', 'collect-policy.enabled=false');
    if (!fetchFn) throw new GuardError('no-fetchFn', 'guard refuses real network by default');
    await acquire();
    try {
      const r = skipRobots
        ? { allowed: true, crawlDelayMs: 0, checked: false }
        : await robotsForUrl(url);
      if (!r.allowed) { stats.denied += 1; throw new GuardDenied('robots', url); }
      await throttle(r.crawlDelayMs);
      let lastErr = null;
      for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
        const headers = { 'User-Agent': cfg.userAgent, ...(opts.headers || {}) };
        let resp;
        try {
          resp = await fetchFn(url, {
            ...opts,
            method: opts.method || 'GET',
            headers,
            signal: signalFor(opts.signal)
          });
        } catch (e) {
          const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError' || /abort|timeout/i.test(e.message || ''));
          lastErr = timedOut ? new GuardTimeout(url) : new GuardError('network', e && e.message);
          if (timedOut) stats.timeouts += 1;
          if (attempt < cfg.maxRetries) { stats.retries += 1; await backoff(attempt, null); continue; }
          stats.errors += 1;
          throw lastErr;
        }
        const status = Number(resp?.status ?? 0);
        stats.requests += 1;
        if (cfg.retryStatuses.includes(status) && attempt < cfg.maxRetries) {
          stats.retries += 1;
          await backoff(attempt, resp);
          continue;
        }
        if (status >= 400) {
          stats.errors += 1;
          throw new GuardError(`http-${status}`, url);
        }
        return {
          ok: true, status, url,
          text: String(resp?.text ?? resp?.body ?? ''),
          headers: resp?.headers || {},
          attempts: attempt + 1,
          robots: r
        };
      }
      stats.errors += 1;
      throw lastErr || new GuardError('exhausted', url);
    } finally {
      release();
    }
  }

  const api = {
    config: { ...cfg, retryStatuses: [...cfg.retryStatuses] },
    request(url, opts = {}) { return core(url, opts, false); },
    // 取 robots.txt 自身：遵守限速/超时但不查 robots，避免递归。
    rawRequest(url, opts = {}) { return core(url, opts, true); },
    // 外部适配器（如 ddgs Python）限速入口：网络不在 Node 侧，但仍受同一 rpm/间隔/抖动约束。
    async throttleOnly() {
      if (!cfg.enabled) throw new GuardDenied('disabled', 'collect-policy.enabled=false');
      await throttle(0);
      stats.externalCalls += 1;
    },
    getStats() { return { ...stats }; },
    resetStats() { for (const k of Object.keys(stats)) stats[k] = 0; }
  };
  return api;
}
