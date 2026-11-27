// 建树节奏：每日不调 AI、每周一次且有门槛、超期兜底、验证文件入站根。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, readJson, writeJson, REPO } from './helper.js';
import { runHarvest } from '../scripts/harvest.js';
import { runGrowTree } from '../scripts/grow-tree.js';
import { runTreeOverdue } from '../scripts/tree-overdue.js';
import { runBuild } from '../scripts/build.js';

function passSignals(root) {
  const st = readJson(root, 'state.json');
  st.signals = { count: 300, sources: 2, newRate: 0.05, passed: true };
  writeJson(root, 'state.json', st);
}
function looseThreshold(root) {
  writeJson(root, 'rules/tree-cadence.json', {
    schema: 'rules/tree-cadence/v1',
    growThreshold: { minUncoveredTerms: 0, minUnmappedTerms: 0, requireSignalsPassed: true }
  });
}
function fakeFetch(counter) {
  return async () => {
    counter.count++;
    const body = { choices: [{ message: { content: JSON.stringify({ grouped: { n1: ['月租'] }, newNodes: [] }) } }] };
    return { ok: true, status: 200, json: async () => body };
  };
}

test('grow-tree: 未达阈值时零模型调用、零写盘、不留运行记录', async () => {
  const root = makeRoot();
  const prevKey = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'test-key';
  try {
    runHarvest(root, {});
    runHarvest(root, {});
    passSignals(root);
    // mock harvest 产 326 个未覆盖词，刻意抬高阈值以验证「门槛未过」分支。
    writeJson(root, 'rules/tree-cadence.json', { schema: 'rules/tree-cadence/v1', growThreshold: { minUncoveredTerms: 99999, minUnmappedTerms: 99999, requireSignalsPassed: true } });
    const mf = readJson(root, 'config/manifest.json');
    mf.providers.llm = 'openrouter';
    writeJson(root, 'config/manifest.json', mf);
    const treeBefore = fs.readFileSync(path.join(root, 'data/tree.json'), 'utf8');
    const counter = { count: 0 };
    const r = await runGrowTree(root, { llmOpts: { fetchFn: fakeFetch(counter) } });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /uncovered|unmapped/);
    assert.equal(counter.count, 0, '门槛未过不得调用模型');
    assert.equal(fs.readFileSync(path.join(root, 'data/tree.json'), 'utf8'), treeBefore);
    assert.equal(readJson(root, 'state.json').runs.filter((x) => x.stage === 'grow-tree').length, 0);
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = prevKey;
    cleanup(root);
  }
});

test('grow-tree: 达标时才调用模型并写盘', async () => {
  const root = makeRoot();
  const prevKey = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'test-key';
  try {
    runHarvest(root, {});
    passSignals(root);
    looseThreshold(root);
    const mf = readJson(root, 'config/manifest.json');
    mf.providers.llm = 'openrouter';
    writeJson(root, 'config/manifest.json', mf);
    const counter = { count: 0 };
    const r = await runGrowTree(root, { llmOpts: { fetchFn: fakeFetch(counter) } });
    assert.equal(r.skipped, false);
    assert.ok(counter.count >= 1, '达标应调用模型');
    assert.equal(readJson(root, 'state.json').runs.filter((x) => x.stage === 'grow-tree').length, 1);
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = prevKey;
    cleanup(root);
  }
});

test('tree-overdue: 从未建树时兜底触发一次', async () => {
  const root = makeRoot();
  try {
    runHarvest(root, {});
    passSignals(root);
    looseThreshold(root);
    const r = await runTreeOverdue(root, { now: '2026-11-27T12:00:00Z' });
    assert.equal(r.action, 'triggered');
    assert.equal(r.lastGrowAt, null);
    assert.equal(readJson(root, 'reports/tree-overdue.json').action, 'triggered');
    assert.equal(readJson(root, 'state.json').runs.filter((x) => x.stage === 'grow-tree').length, 1);
  } finally { cleanup(root); }
});

test('tree-overdue: 近期已有成功记录时不触发', async () => {
  const root = makeRoot();
  try {
    passSignals(root);
    const st = readJson(root, 'state.json');
    st.runs = [{ stage: 'grow-tree', at: '2026-11-25T03:00:00Z', provider: 'mock', summary: 'ok' }];
    writeJson(root, 'state.json', st);
    const r = await runTreeOverdue(root, { now: '2026-11-27T12:00:00Z' });
    assert.equal(r.action, 'none');
    assert.equal(r.overdue, undefined);
    assert.equal(fs.existsSync(path.join(root, 'reports/tree-overdue.json')), true);
  } finally { cleanup(root); }
});

test('tree-overdue: 超期触发，同日只触发一次', async () => {
  const root = makeRoot();
  try {
    runHarvest(root, {});
    passSignals(root);
    looseThreshold(root);
    const st = readJson(root, 'state.json');
    st.runs = [{ stage: 'grow-tree', at: '2026-11-10T03:00:00Z', provider: 'mock', summary: 'ok' }];
    writeJson(root, 'state.json', st);
    const r1 = await runTreeOverdue(root, { now: '2026-11-27T12:00:00Z' });
    assert.equal(r1.action, 'triggered');
    const r2 = await runTreeOverdue(root, { now: '2026-11-27T15:00:00Z' });
    assert.equal(r2.action, 'none', '刚补跑过就不再触发');
    const cadence = readJson(root, 'rules/tree-cadence.json');
    cadence.overdueDays = 0;
    writeJson(root, 'rules/tree-cadence.json', cadence);
    const st2 = readJson(root, 'state.json');
    st2.runs = [
      { stage: 'grow-tree', at: '2026-11-10T03:00:00Z', provider: 'mock', summary: 'ok' },
      { stage: 'grow-tree', at: '2026-11-27T01:00:00Z', provider: 'mock', summary: 'ok' }
    ];
    writeJson(root, 'state.json', st2);
    const r3 = await runTreeOverdue(root, { now: '2026-11-27T16:00:00Z' });
    assert.equal(r3.action, 'skipped-duplicate');
  } finally { cleanup(root); }
});

test('tree-overdue: 阈值不足时只告警，不写树', async () => {
  const root = makeRoot();
  try {
    runHarvest(root, {});
    passSignals(root);
    writeJson(root, 'rules/tree-cadence.json', { schema: 'rules/tree-cadence/v1', growThreshold: { minUncoveredTerms: 99999, minUnmappedTerms: 99999, requireSignalsPassed: true } });
    const before = fs.readFileSync(path.join(root, 'data/tree.json'), 'utf8');
    const r = await runTreeOverdue(root, { now: '2026-11-27T12:00:00Z' });
    assert.equal(r.action, 'skipped-threshold');
    assert.equal(fs.readFileSync(path.join(root, 'data/tree.json'), 'utf8'), before);
  } finally { cleanup(root); }
});

test('调度配置：每日链无建树，周任务与兜底就位', () => {
  const cli = fs.readFileSync(path.join(REPO, 'scripts/cli.js'), 'utf8');
  assert.ok(!cli.includes('runGrowTree(root, o)'), 'pipeline 不得调用建树');
  assert.ok(cli.includes('runTreeOverdue(root, o)'));
  const daily = fs.readFileSync(path.join(REPO, '.github/workflows/pipeline.yml'), 'utf8');
  assert.ok(daily.includes('tree-overdue'));
  const weekly = fs.readFileSync(path.join(REPO, '.github/workflows/tree-weekly.yml'), 'utf8');
  assert.ok(weekly.includes("cron: '0 3 * * 1'"));
  assert.ok(weekly.includes('grow-tree --force'));
  const cadence = readJson(REPO, 'rules/tree-cadence.json');
  assert.equal(cadence.overdueDays, 10);
});

test('build: BingSiteAuth.xml 原样复制到站点根目录', () => {
  const root = makeRoot();
  try {
    const xml = '<?xml version="1.0"?>\n<users>\n\t<user>TEST-TOKEN</user>\n</users>\n';
    fs.writeFileSync(path.join(root, 'BingSiteAuth.xml'), xml);
    runBuild(root, {});
    assert.equal(fs.readFileSync(path.join(root, '_site/BingSiteAuth.xml'), 'utf8'), xml);
  } finally { cleanup(root); }
});
