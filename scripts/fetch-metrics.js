// 曝光/收录回流：从 GSC/Bing 拉取 → 数据只写 data/metrics/（v7 全公开仓策略下可见，但不含密钥）。
// 红线：密钥只走 env/secrets，永不落文件；无 key 时默认 mock/空，不阻断流程。
import path from 'node:path';
import { writeJson, ROOT } from './lib/validate.js';
import { seededRandom } from './lib/util.js';

export function runFetchMetrics(root = ROOT, args = {}) {
  const provider = args.provider || 'mock';
  let rows = [];
  if (provider === 'mock') {
    const rand = seededRandom('metrics-' + new Date().toISOString().slice(0, 10));
    rows = ['/', '/nav/nav-001.html', '/nav/nav-002.html', '/blog/'].map((page) => ({
      page,
      impressions: Math.floor(rand() * 500) + 20,
      clicks: Math.floor(rand() * 40),
      avgPosition: Number((3 + rand() * 12).toFixed(1)),
      collectedAt: new Date().toISOString().slice(0, 10)
    }));
  } else {
    const hasKey = !!(process.env.GSC_SERVICE_ACCOUNT || process.env.BING_API_KEY);
    if (!hasKey) return { stage: 'fetch-metrics', provider, degraded: true, reason: '缺少 env 密钥，跳过真实回流', rows: 0 };
    throw new Error(`metrics provider ${provider} 需按 Secrets 注入后启用（本模板默认 mock）`);
  }
  const doc = { schema: 'metrics/v1', provider, rows };
  if (!args.dryRun) {
    writeJson(path.join(root, 'data/metrics', 'latest.json'), doc);
    writeJson(path.join(root, 'reports', 'metrics.json'), { stage: 'fetch-metrics', provider, rows: rows.length });
  }
  return { stage: 'fetch-metrics', provider, rows: rows.length, data: rows };
}
