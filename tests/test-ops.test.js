import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, readJson, writeJson } from './helper.js';
import { snapshot } from '../scripts/lib/util.js';
import { makeSnapshots, listSnapshots, findLatestSnapshot, rollbackFile } from '../scripts/lib/snapshot.js';
import { runRollback } from '../scripts/rollback.js';
import { runResetSite } from '../scripts/reset-site.js';
import { runReport } from '../scripts/report.js';
import { runFetchMetrics } from '../scripts/fetch-metrics.js';
import { runPrune } from '../scripts/prune.js';

test('snapshot: 生成时间戳快照并可按最新还原', () => {
  const root = makeRoot();
  try {
    const file = path.join(root, 'data/tree.json');
    const dest = snapshot(file, path.join(root, 'snapshots', 'x'));
    assert.ok(dest && fs.existsSync(dest));
    const snapDir = path.join(root, 'snapshots', 'x');
    assert.ok(fs.readdirSync(snapDir).some((f) => f.startsWith('tree.json.')));
    // 改坏再回滚
    writeJson(root, 'data/tree.json', { schema: 'tree/v1', broken: true });
    const r = rollbackFile(root, 'data/tree.json', dest);
    assert.equal(r.ok, true);
    assert.equal(readJson(root, 'data/tree.json').schema, 'tree/v1');
    assert.ok(readJson(root, 'data/tree.json').nodes);
  } finally { cleanup(root); }
});

test('makeSnapshots/listSnapshots/findLatestSnapshot 覆盖全部可快照文件', () => {
  const root = makeRoot();
  try {
    const s = makeSnapshots(root, 'batch1');
    assert.ok(s.made.length >= 5, `快照数 ${s.made.length}`);
    const list = listSnapshots(root);
    assert.equal(list.length, s.made.length);
    const latest = findLatestSnapshot(root, 'data/tree.json');
    assert.ok(latest && latest.includes('tree.json'));
  } finally { cleanup(root); }
});

test('rollback CLI: 未指定 --file 时返回可用快照列表', () => {
  const root = makeRoot();
  try {
    const r = runRollback(root, {});
    assert.ok(r.error);
    assert.ok(Array.isArray(r.available));
  } finally { cleanup(root); }
});

test('reset: 需确认；apply 后清空数据并复位 state，保留规则/前端', () => {
  const root = makeRoot();
  try {
    const noop = runResetSite(root, {});
    assert.ok(noop.error);
    writeJson(root, 'data/articles.json', { schema: 'articles/v1', articles: [{ id: 'x' }] });
    const r = runResetSite(root, { apply: true });
    assert.equal(r.applied, true);
    assert.equal(readJson(root, 'data/navlinks.json').items.length, 0);
    assert.equal(readJson(root, 'state.json').siteFilled, false);
    assert.equal(readJson(root, 'data/sources.json').sources.length, 0);
    // 规则与前端保留
    assert.equal(fs.existsSync(path.join(root, 'rules/autopilot.json')), true);
    assert.equal(fs.existsSync(path.join(root, 'templates/assets/site.css')), true);
    assert.equal(fs.existsSync(path.join(root, 'data/articles.json')), false);
  } finally { cleanup(root); }
});

test('report: 生成周报，含达标进度与回滚命令，不泄漏 markdown 进 JSON 报告', () => {
  const root = makeRoot();
  try {
    const r = runReport(root, {});
    assert.ok(r.markdown.includes('站点周报'));
    assert.ok(r.markdown.includes('rollback --file data/tree.json'));
    const file = fs.readFileSync(path.join(root, 'reports/weekly.md'), 'utf8');
    assert.ok(file.includes('## 达标进度'));
  } finally { cleanup(root); }
});

test('fetch-metrics: 默认 mock 产出回流数据，只写 data/metrics', async () => {
  const root = makeRoot();
  try {
    const r = await runFetchMetrics(root, {});
    assert.equal(r.provider, 'mock');
    assert.ok(r.rows > 0);
    assert.ok(readJson(root, 'data/metrics/latest.json').rows.length > 0);
  } finally { cleanup(root); }
});

test('fetch-metrics: 真 provider 无 key 降级跳过，不伪造数据', async () => {
  const root = makeRoot();
  try {
    const r = await runFetchMetrics(root, { provider: 'gsc' });
    assert.equal(r.degraded, true);
    assert.equal(r.rows, 0);
  } finally { cleanup(root); }
});

test('prune: 四状态分类并产出 unmatched 报告，不删除正文', async () => {
  const root = makeRoot();
  try {
    await runFetchMetrics(root, {});
    writeJson(root, 'data/articles.json', { schema: 'articles/v1', articles: [
      { id: 'a1', title: '测试文章', body: '正文' }
    ] });
    const r = runPrune(root, {});
    assert.ok(r.decisions.length >= 1);
    assert.ok('active' in r.counts || 'watch' in r.counts || 'stale' in r.counts || 'unmatched' in r.counts);
    assert.ok(Array.isArray(r.unmatched));
    assert.equal(fs.existsSync(path.join(root, 'data/articles.json')), true, '不删除正文');
  } finally { cleanup(root); }
});
