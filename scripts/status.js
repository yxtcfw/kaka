// 运行状态汇总：把一次自动运行的时间、结论与阶段摘要写成公开只读的 status.json。
// 产物同时写 reports/status.json（进 git 可审计）与 _site/status.json（Pages 可访问），
// 字段兼容中枢站 config/status/<id>.json 的既有消费（result/pages/ai_calls/last_run_at）。
import path from 'node:path';
import fs from 'node:fs';
import { atomicWriteJson } from './lib/util.js';

function readSafe(file, fb) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; }
}

function str(v, max = 300) { return String(v ?? '').slice(0, max); }

// 降级原因脱敏：去掉 URL、查询串与长十六进制串，避免外部地址/密钥回显到公开文件。
function safeReason(v) {
  return String(v ?? '')
    .replace(/https?:\/\/[^\s)"']+/g, '[url]')
    .replace(/[?&][^\s=]+=[^\s&]+/g, '[param]')
    .replace(/\b[0-9a-f]{16,}\b/gi, '[hash]')
    .slice(0, 160);
}

// 结论判定：以各阶段报告为准，不依赖 workflow 环境变量（本地与云端同构）。
// 只要关键阶段报告存在且未整体降级，就判 success；harvest 降级单独记录但不判失败。
function conclude(reports, state) {
  const required = ['build', 'write-content', 'harvest', 'fetch-body'];
  const missing = required.filter((n) => !reports[n]);
  if (missing.length) return { result: 'failed', reason: `缺少阶段报告：${missing.join(',')}` };
  if (reports['write-content']?.contentPassed === false) {
    return { result: 'failed', reason: '内容门禁未达标' };
  }
  if (reports.build?.pages === 0) return { result: 'failed', reason: '构建页数为 0' };
  const runs = Array.isArray(state.runs) ? state.runs : [];
  if (!runs.length) return { result: 'failed', reason: '无运行记录' };
  return { result: 'success', reason: '' };
}

// 运行时间：优先 state.runs 最后一条（流水线真实落点），退而取各报告 checkedAt。
function resolveRunTime(state, reports) {
  const runs = Array.isArray(state.runs) ? state.runs : [];
  if (runs.length && runs[runs.length - 1].at) return str(runs[runs.length - 1].at, 40);
  for (const name of ['prune', 'tree-overdue']) {
    if (reports[name]?.checkedAt) return str(reports[name].checkedAt, 40);
  }
  return new Date(0).toISOString();
}

// 阶段摘要：取最近 12 条运行流水，供网页显示"做了什么"。
function stageSummaries(state) {
  const runs = Array.isArray(state.runs) ? state.runs : [];
  return runs.slice(-12).map((r) => ({
    at: str(r.at, 40),
    stage: str(r.stage, 40),
    provider: str(r.provider, 40),
    summary: str(r.summary, 160)
  }));
}

export function buildStatus(root) {
  const names = ['harvest', 'harvest-degraded', 'discover', 'discover-degraded', 'fetch-body',
    'write-content', 'fill-site', 'build-nav-pages', 'build', 'metrics', 'prune', 'tree-overdue',
    'maintenance', 'grow-tree', 'drift-check'];
  const reports = {};
  for (const n of names) {
    const data = readSafe(path.join(root, 'reports', `${n}.json`), null);
    if (data) reports[n] = data;
  }
  const state = readSafe(path.join(root, 'state.json'), {});
  const site = readSafe(path.join(root, 'data/site.json'), {});
  const manifest = readSafe(path.join(root, 'config/manifest.json'), {});
  const alerts = readSafe(path.join(root, 'alerts', 'latest.json'), { alerts: [] });
  const driftCritical = Array.isArray(alerts.alerts)
    ? alerts.alerts.filter((a) => a.severity === 'critical').length : 0;
  const { result, reason } = conclude(reports, state);

  // run_url：云端用标准环境变量拼接，本地留空，绝不伪造链接。
  const runId = str(process.env.GITHUB_RUN_ID || '', 40);
  const runUrl = runId && process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`
    : '';

  // 降级清单：只记原因前缀，避免把外部 URL / 密钥回显到公开文件。
  const degradations = [];
  for (const n of ['harvest', 'harvest-degraded', 'discover', 'discover-degraded', 'grow-tree', 'build-nav-pages']) {
    const r = reports[n];
    if (r?.degraded) degradations.push({ stage: r.stage || n, reason: safeReason(r.reason) });
  }

  // 中枢站旧字段语义：ai_calls 用本轮模型数（没有就 0），pages 用构建页数。
  const models = Array.isArray(reports['write-content']?.models) ? reports['write-content'].models : [];
  const status = {
    schema_version: '2.0.0',
    site_id: str(site.id || str(manifest.domain || '').split('.')[0] || manifest.vertical || 'kaka', 40),
    last_run_at: resolveRunTime(state, reports),
    result,
    reason: str(reason, 200),
    pages: Number(reports.build?.pages || 0),
    ai_calls: models.length,
    models: models.map((m) => str(m, 80)),
    run_url: str(runUrl, 300),
    run_id: runId,
    composition: {
      modules: Array.isArray(manifest.composition?.modules) ? manifest.composition.modules.slice(0, 10) : [],
      order: Array.isArray(manifest.composition?.order) ? manifest.composition.order.slice(0, 10) : [],
      render: str(manifest.composition?.render || 'static', 20)
    },
    thresholds: {
      signals: !!state.signals?.passed,
      sources: !!state.sources?.passed,
      content: !!state.content?.passed,
      siteFilled: !!state.siteFilled
    },
    counts: {
      generated: Number(reports['write-content']?.generated || 0),
      gateBlocked: Number(reports['write-content']?.gateBlockedCount || 0),
      navBuilt: Number(reports['build-nav-pages']?.built || 0),
      navSkipped: Number(reports['build-nav-pages']?.skipped || 0),
      sourcesL1: Number(reports['fetch-body']?.l1 || state.sources?.l1 || 0),
      independentL2: Number(reports['fetch-body']?.independentL2 || state.sources?.independentL2 || 0),
      metricsRows: Number(reports.metrics?.rows || 0),
      pruneStatus: str(reports.prune?.status || 'not-run', 40),
      driftCritical: driftCritical
    },
    degradations,
    stages: stageSummaries(state)
  };
  return status;
}

export function runStatus(root, args = {}) {
  const status = buildStatus(root);
  if (!args.dryRun) {
    atomicWriteJson(path.join(root, 'reports', 'status.json'), status);
    atomicWriteJson(path.join(root, '_site', 'status.json'), status);
  }
  return {
    stage: 'status',
    result: status.result,
    reason: status.reason,
    pages: status.pages,
    stages: status.stages.length,
    degradations: status.degradations.length,
    status
  };
}
