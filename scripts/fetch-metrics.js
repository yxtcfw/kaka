// 曝光/收录回流：mock（假数据占位）/ site-estimate（零 key 收录数估算）/ bing（Bing Webmaster 真实回流）/ gsc（待接）。
// 红线：密钥只走 env/secrets，永不落文件；估算数据显式标 estimated=true，不与真实曝光/点击混淆。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { seededRandom, sha256 } from './lib/util.js';
import { createProviderGuard } from './lib/sources.js';
import { ddgsSearch } from './lib/ddgs.js';

// Bing Webmaster Tools JSON/REST（SOAP/POX 已于 2026-08-31 退役）。
// 官方端点：https://ssl.bing.com/webmaster/api.svc/json/GetPageStats?apikey=...&siteUrl=...
// key 只从 env 读；日志/报告只露 8 位指纹，URL 里的 apikey 在错误信息中一律脱敏。
const BING_ENDPOINT = 'https://ssl.bing.com/webmaster/api.svc/json/GetPageStats';

function bingDate(value) {
  const raw = String(value || '');
  const ticks = raw.match(/\/Date\((-?\d+)(?:[+-]\d{4})?\)\//);
  if (ticks) return new Date(Number(ticks[1])).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '';
}

function redactKey(text, key) {
  let out = String(text || '').slice(0, 300);
  if (key) out = out.split(key).join('***');
  return out.replace(/([?&]apikey=)[^&\s"']+/gi, '$1***');
}

function normalizeBingRows(rawRows, today) {
  return (Array.isArray(rawRows) ? rawRows : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const impressions = Number(item.Impressions || 0);
      const clicks = Number(item.Clicks || 0);
      const position = item.AvgClickPosition ?? item.AvgImpressionPosition ?? 0;
      return {
        page: String(item.PageURL || item.Url || item.Query || '/').slice(0, 300),
        impressions,
        clicks,
        avgPosition: Number.isFinite(Number(position)) ? Number(position.toFixed(1)) : 0,
        collectedAt: bingDate(item.Date) || today
      };
    })
    .filter((row) => row.impressions > 0 || row.clicks > 0);
}

async function fetchBingMetrics(manifest, args) {
  const key = String(process.env.BING_API_KEY || '').trim();
  const fingerprint = key ? sha256(key).slice(0, 8) : 'none';
  if (!key) {
    return { degraded: true, reason: '缺少 BING_API_KEY，跳过 Bing 真实回流', fingerprint, rows: [] };
  }
  const domain = String(manifest.domain || '').trim();
  if (!domain) {
    return { degraded: true, reason: 'manifest.domain 为空，无法构造 siteUrl', fingerprint, rows: [] };
  }
  const siteUrl = String(args.siteUrl || manifest.metrics?.bingSiteUrl || `https://${domain}/`);
  const url = new URL(BING_ENDPOINT);
  url.searchParams.set('apikey', key);
  url.searchParams.set('siteUrl', siteUrl);
  const fetchFn = args.fetchFn || ((...a) => fetch(...a));
  try {
    const res = await fetchFn(url.toString(), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
    const status = Number(res?.status || 0);
    if (!res?.ok || (status && (status < 200 || status >= 300))) {
      return {
        degraded: true,
        reason: `Bing API HTTP ${status || 'error'}: ${redactKey((await res?.text?.()) || '', key)}`,
        fingerprint, rows: []
      };
    }
    const payload = typeof res.json === 'function'
      ? await res.json()
      : JSON.parse(await res.text());
    if (payload?.ErrorCode) {
      return { degraded: true, reason: `Bing API ${payload.ErrorCode}: ${redactKey(payload.Message, key)}`, fingerprint, rows: [] };
    }
    const rows = normalizeBingRows(payload?.d, new Date().toISOString().slice(0, 10))
      .slice(0, Number(args.limit || 100));
    return {
      degraded: false,
      fingerprint, rows,
      note: `Bing Webmaster 真实回流（${siteUrl}），estimated=false；站点须已在 Bing Webmaster Tools 验证。`
    };
  } catch (e) {
    return { degraded: true, reason: `Bing API 请求失败：${redactKey(e?.message || e, key)}`, fingerprint, rows: [] };
  }
}

export async function runFetchMetrics(root = ROOT, args = {}) {
  const manifest = readJson(path.join(root, 'config/manifest.json'));
  const provider = args.provider || manifest.providers?.metrics || 'mock';
  let rows = [];
  let estimated = false;
  let note = '';
  let guardStats = null;

  if (provider === 'mock') {
    // 占位假数据，仅用于跑通链路；不得用于内容裁剪决策。
    const rand = seededRandom('metrics-' + new Date().toISOString().slice(0, 10));
    rows = ['/', '/nav/nav-001.html', '/nav/nav-002.html', '/blog/'].map((page) => ({
      page,
      impressions: Math.floor(rand() * 500) + 20,
      clicks: Math.floor(rand() * 40),
      avgPosition: Number((3 + rand() * 12).toFixed(1)),
      collectedAt: new Date().toISOString().slice(0, 10)
    }));
    note = 'mock 随机假数据，非真实曝光/点击；不可用于内容裁剪。';
  } else if (provider === 'site-estimate') {
    const domain = manifest.domain || '';
    if (!domain) {
      return { stage: 'fetch-metrics', provider, degraded: true, reason: 'manifest.domain 为空，无法做 site: 估算', rows: 0 };
    }
    const guard = args.guard || createProviderGuard(root, {
      sleepFn: args.sleepFn, nowFn: args.nowFn, randomFn: args.randomFn
    });
    const query = `site:${domain}`;
    let hits;
    try {
      hits = await ddgsSearch([query], {
        root,
        guard,
        adapterFn: args.adapterFn,
        limit: Number(args.limit || 50)
      });
    } catch (e) {
      // 适配器未装/失败 → 显式降级跳过，不写 0 条估算冒充真实数据。
      return { stage: 'fetch-metrics', provider, degraded: true, reason: `ddgs 适配器不可用：${e.message}`, rows: 0 };
    }
    rows = [{
      page: query,
      indexedEstimate: hits.length,
      method: 'ddgs-result-count-lower-bound',
      collectedAt: new Date().toISOString().slice(0, 10)
    }];
    estimated = true;
    note = '零 key 的 site: 收录数保守估算（实际返回条数下限），非 GSC 曝光/点击真值；后期可切 gsc/bing。';
    guardStats = guard.getStats();
  } else if (provider === 'bing') {
    const result = await fetchBingMetrics(manifest, args);
    const report = {
      stage: 'fetch-metrics', provider, rows: result.rows.length, estimated: false,
      degraded: result.degraded, reason: result.reason || '', keyFingerprint: result.fingerprint
    };
    // 失败也要留痕，便于云端核对（不写 rows 假数据、不打印明文 key）。
    if (!args.dryRun) writeJson(path.join(root, 'reports', 'metrics.json'), report);
    if (result.degraded) {
      return { stage: 'fetch-metrics', provider, degraded: true, reason: result.reason, rows: 0, keyFingerprint: result.fingerprint };
    }
    rows = result.rows;
    note = result.note;
    guardStats = { provider: 'bing', keyFingerprint: result.fingerprint };
  } else {
    // GSC 真通道：key 只从 env 读，缺 key 显式跳过，不伪造。
    const hasKey = !!(process.env.GSC_SERVICE_ACCOUNT || process.env.BING_API_KEY);
    if (!hasKey) {
      return { stage: 'fetch-metrics', provider, degraded: true, reason: '缺少 env 密钥，跳过真实回流', rows: 0 };
    }
    throw new Error(`metrics provider ${provider} 需按 Secrets 注入后启用（本模板默认 mock/site-estimate）`);
  }

  const doc = { schema: 'metrics/v1', provider, estimated, note, rows };
  if (!args.dryRun) {
    writeJson(path.join(root, 'data/metrics', 'latest.json'), doc);
    writeJson(path.join(root, 'reports', 'metrics.json'), {
      stage: 'fetch-metrics', provider, rows: rows.length, estimated, guard: guardStats
    });
  }
  return { stage: 'fetch-metrics', provider, rows: rows.length, estimated, data: rows, guard: guardStats };
}
