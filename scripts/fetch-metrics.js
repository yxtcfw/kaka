// 曝光/收录回流：mock（假数据占位）/ site-estimate（零 key 收录数保守估算）/ GSC|Bing（后期补 key）。
// 红线：密钥只走 env/secrets，永不落文件；估算数据显式标 estimated=true，不与真实曝光/点击混淆。
import path from 'node:path';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { seededRandom } from './lib/util.js';
import { createProviderGuard } from './lib/sources.js';
import { ddgsSearch } from './lib/ddgs.js';

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
  } else {
    // GSC / Bing 真通道：key 只从 env 读，缺 key 显式跳过，不伪造。
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
