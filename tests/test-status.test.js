import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, readJson, writeJson } from './helper.js';
import { buildStatus, runStatus } from '../scripts/status.js';

function seedReports(root) {
  writeJson(root, 'state.json', {
    schema: 'state/v1', siteFilled: true,
    signals: { count: 400, sources: 3, newRate: 0.02, passed: true },
    sources: { l1: 64, independentL2: 3, passed: true },
    content: { generated: 5, gateBlocked: 1, passed: true },
    tree: { built: true, version: 20 }, navPages: { built: 3, downgraded: 0 },
    runs: [
      { at: '2026-11-27T10:00:00.000Z', stage: 'harvest', provider: 'baidu-suggest', summary: '联想词 400' },
      { at: '2026-11-27T10:10:00.000Z', stage: 'write-content', provider: 'openrouter', summary: '生成 5' }
    ]
  });
  writeJson(root, 'reports/harvest.json', { stage: 'harvest', count: 400, degraded: false });
  writeJson(root, 'reports/fetch-body.json', { stage: 'fetch-body', l1: 64, independentL2: 3 });
  writeJson(root, 'reports/write-content.json', {
    stage: 'write-content', generated: 5, gateBlockedCount: 1, contentPassed: true,
    models: ['nemotron:free', 'flint:free']
  });
  writeJson(root, 'reports/build.json', { stage: 'build', pages: 71 });
  writeJson(root, 'reports/build-nav-pages.json', { stage: 'build-nav-pages', built: 3, skipped: 64 });
  writeJson(root, 'reports/metrics.json', { stage: 'fetch-metrics', provider: 'bing', rows: 12 });
  writeJson(root, 'reports/prune.json', { stage: 'prune', status: 'has-data', checkedAt: '2026-11-27T10:12:00.000Z' });
  writeJson(root, 'alerts/latest.json', {
    alertCount: 1, alerts: [{ severity: 'critical', kind: 'tree', subject: 'x', detail: 'y' }]
  });
}

test('status: 字段兼容中枢站消费（result/pages/ai_calls/last_run_at/run_url）', () => {
  const root = makeRoot();
  try {
    seedReports(root);
    const s = buildStatus(root);
    assert.ok(s.site_id && typeof s.site_id === 'string');
    assert.equal(s.result, 'success');
    assert.equal(s.pages, 71);
    assert.equal(s.ai_calls, 2);
    assert.equal(s.last_run_at, '2026-11-27T10:10:00.000Z');
    assert.equal(typeof s.run_url, 'string');
    assert.equal(s.counts.driftCritical, 1);
    assert.equal(s.counts.metricsRows, 12);
    assert.equal(s.stages.length, 2);
  } finally { cleanup(root); }
});

test('status: 关键报告缺失时判失败且说明原因', () => {
  const root = makeRoot();
  try {
    writeJson(root, 'state.json', { runs: [{ at: '2026-11-27T00:00:00.000Z', stage: 'build' }] });
    const s = buildStatus(root);
    assert.equal(s.result, 'failed');
    assert.match(s.reason, /缺少阶段报告/);
  } finally { cleanup(root); }
});

test('status: 内容门禁未达标时判失败', () => {
  const root = makeRoot();
  try {
    seedReports(root);
    const w = readJson(root, 'reports/write-content.json');
    w.contentPassed = false;
    writeJson(root, 'reports/write-content.json', w);
    const s = buildStatus(root);
    assert.equal(s.result, 'failed');
    assert.match(s.reason, /门禁/);
  } finally { cleanup(root); }
});

test('status: run_url 由标准环境变量拼接，本地不伪造', () => {
  const root = makeRoot();
  try {
    seedReports(root);
    const s = buildStatus(root);
    assert.equal(s.run_url, '');
    const prev = { id: process.env.GITHUB_RUN_ID, url: process.env.GITHUB_SERVER_URL, repo: process.env.GITHUB_REPOSITORY };
    process.env.GITHUB_RUN_ID = '12345';
    process.env.GITHUB_SERVER_URL = 'https://github.com';
    process.env.GITHUB_REPOSITORY = 'yxtcfw/kaka';
    try {
      assert.equal(buildStatus(root).run_url, 'https://github.com/yxtcfw/kaka/actions/runs/12345');
    } finally {
      for (const [k, v] of [['GITHUB_RUN_ID', prev.id], ['GITHUB_SERVER_URL', prev.url], ['GITHUB_REPOSITORY', prev.repo]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  } finally { cleanup(root); }
});

test('status: 产物双写 reports 与 _site，dry-run 零写盘', () => {
  const root = makeRoot();
  try {
    const dry = runStatus(root, { dryRun: true });
    assert.equal(dry.stage, 'status');
    assert.equal(fs.existsSync(path.join(root, 'reports', 'status.json')), false);
    const r = runStatus(root, {});
    assert.equal(r.stage, 'status');
    assert.ok(fs.existsSync(path.join(root, 'reports', 'status.json')));
    assert.ok(fs.existsSync(path.join(root, '_site', 'status.json')));
    assert.equal(readJson(root, '_site/status.json').pages, readJson(root, 'reports/status.json').pages);
  } finally { cleanup(root); }
});

test('status: 降级原因被截断且不回显外部 URL', () => {
  const root = makeRoot();
  try {
    seedReports(root);
    writeJson(root, 'reports/discover-degraded.json', {
      stage: 'discover', degraded: true, reason: 'Error: https://secret.example.com/token?key=abcdef ' + 'x'.repeat(500)
    });
    const s = buildStatus(root);
    assert.equal(s.degradations.length, 1);
    assert.ok(s.degradations[0].reason.length <= 160);
    assert.ok(!s.degradations[0].reason.includes('secret.example.com'));
  } finally { cleanup(root); }
});
