import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, readJson, writeJson } from './helper.js';
import { detectDrift, DRIFT_KINDS } from '../scripts/lib/drift.js';
import { runDriftCheck } from '../scripts/drift-check.js';
import { validateDoc } from '../scripts/lib/validate.js';

test('detectDrift: 干净基线无告警，文档符合 alerts/v1', () => {
  const root = makeRoot();
  try {
    const doc = detectDrift(root);
    assert.equal(doc.schema, 'alerts/v1');
    assert.equal(doc.checks, DRIFT_KINDS.length);
    // 基线 state.sources 全 0，实际 sources 有 L1/L2 -> 会有 source-count-drift，属预期
    const nonCount = doc.alerts.filter((a) => a.kind !== 'source-count-drift');
    assert.equal(nonCount.length, 0, JSON.stringify(nonCount));
    assert.deepEqual(validateDoc(doc, path.join(root, 'schema')), []);
  } finally { cleanup(root); }
});

test('detectDrift: tree 悬空 parent/child 被检出', () => {
  const root = makeRoot();
  try {
    const tree = readJson(root, 'data/tree.json');
    tree.nodes[0].parent = 'n-missing';
    tree.root.children.push('n-ghost');
    writeJson(root, 'data/tree.json', tree);
    const kinds = detectDrift(root).alerts.map((a) => a.kind);
    assert.ok(kinds.includes('tree-dangling-parent'));
    assert.ok(kinds.includes('tree-dangling-child'));
  } finally { cleanup(root); }
});

test('detectDrift: 规则 mapping 指向不存在节点被检出', () => {
  const root = makeRoot();
  try {
    const rules = readJson(root, 'rules/signals-tree.json');
    rules.mapping['测试'] = 'n-404';
    writeJson(root, 'rules/signals-tree.json', rules);
    const a = detectDrift(root).alerts.find((x) => x.kind === 'rule-unknown-node');
    assert.ok(a && a.subject === '测试');
  } finally { cleanup(root); }
});

test('detectDrift: 搜索源被误升 L1 被检出且为 critical', () => {
  const root = makeRoot();
  try {
    const src = readJson(root, 'data/sources.json');
    src.sources.push({ sourceId: 'src-900', url: 'https://x.example', domain: 'x.example', grade: 'L1', status: 'approved', discoveredBy: 'search' });
    writeJson(root, 'data/sources.json', src);
    const a = detectDrift(root).alerts.find((x) => x.kind === 'search-source-upgraded');
    assert.ok(a && a.severity === 'critical' && a.subject === 'src-900');
  } finally { cleanup(root); }
});

test('detectDrift: rejected 源仍被 nav 引用被检出且为 critical', () => {
  const root = makeRoot();
  try {
    const src = readJson(root, 'data/sources.json');
    src.sources[0].status = 'rejected';
    writeJson(root, 'data/sources.json', src);
    const a = detectDrift(root).alerts.find((x) => x.kind === 'rejected-source-referenced');
    assert.ok(a && a.severity === 'critical' && a.subject === 'nav-001');
  } finally { cleanup(root); }
});

test('detectDrift: 样式 token 漂移被检出', () => {
  const root = makeRoot();
  try {
    const site = readJson(root, 'data/site.json');
    site.styleTokens = { primary: '#ff0000', accent: '#f59e0b', radius: '12px', font: 'system-ui, sans-serif' };
    writeJson(root, 'data/site.json', site);
    const a = detectDrift(root).alerts.find((x) => x.kind === 'style-token-drift');
    assert.ok(a && a.subject === 'primary' && a.detail.includes('#ff0000'));
  } finally { cleanup(root); }
});

test('runDriftCheck: 写 alerts/latest.json 且不阻断；dry-run 零写盘', () => {
  const root = makeRoot();
  try {
    const dry = runDriftCheck(root, { dryRun: true });
    assert.equal(dry.blocking, false);
    assert.equal(fs.existsSync(path.join(root, 'alerts/latest.json')), false);
    const r = runDriftCheck(root, {});
    assert.equal(r.blocking, false);
    const doc = readJson(root, 'alerts/latest.json');
    assert.equal(doc.schema, 'alerts/v1');
    assert.equal(doc.alertCount, r.alertCount);
    assert.ok(Array.isArray(r.critical));
  } finally { cleanup(root); }
});

test('report: 周报纳入漂移告警段', async () => {
  const root = makeRoot();
  try {
    runDriftCheck(root, {});
    const { runReport } = await import('../scripts/report.js');
    const r = runReport(root, {});
    assert.ok(r.markdown.includes('漂移告警'));
    assert.ok(r.markdown.includes('source-count-drift') || r.markdown.includes('无漂移'));
  } finally { cleanup(root); }
});
