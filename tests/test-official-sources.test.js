// 官网信源导入：配置驱动、幂等、patch 必须落到待写文档（回归覆盖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, readJson, writeJson, REPO } from './helper.js';
import { planImport, runOfficialSourcesImport } from '../scripts/import-official-sources.js';

const cfgFrom = (root) => readJson(root, 'config/official-sources.json');

function seeded(root) {
  writeJson(root, 'data/sources.json', {
    schema: 'sources/v1',
    sources: [{
      sourceId: 'src-001', url: 'https://www.10086.cn/', domain: '10086.cn',
      title: '旧标题', grade: 'L3', status: 'candidate', bodyKind: 'none',
      bodyExcerpt: '', discoveredBy: 'search'
    }]
  });
}

test('planImport：新条目补齐领域无关字段并分配数字 ID', () => {
  const root = makeRoot();
  try {
    seeded(root);
    const cfg = {
      collectedAt: '2026-11-27',
      sources: [{ url: 'https://example.org/pricing', title: '官方资费', grade: 'L1', status: 'approved', bodyKind: 'fulltext', bodyExcerpt: '正文'.repeat(160) }]
    };
    const r = planImport(root, cfg, readJson(root, 'data/sources.json'));
    assert.equal(r.doc.sources.length, 2);
    const added = r.doc.sources[1];
    assert.equal(added.sourceId, 'src-002');
    assert.equal(added.domain, 'example.org');
    assert.equal(added.discoveredBy, 'manual');
    assert.equal(added.fetchedAt, '2026-11-27');
    assert.equal(added.bodyChars, added.bodyExcerpt.length);
  } finally { cleanup(root); }
});

test('planImport：patch 修改的是待写文档本身，可被重复导入幂等消解', () => {
  const root = makeRoot();
  try {
    seeded(root);
    const cfg = {
      sources: [{ url: 'https://www.10086.cn/', title: '中国移动官方网站', grade: 'L1', status: 'approved', bodyKind: 'fulltext', bodyExcerpt: '真实官网正文'.repeat(60) }]
    };
    const first = planImport(root, cfg, readJson(root, 'data/sources.json'));
    assert.equal(first.actions[0].action, 'patch');
    const patched = first.doc.sources[0];
    assert.equal(patched.title, '中国移动官方网站');
    assert.equal(patched.grade, 'L1');
    assert.equal(patched.bodyChars, patched.bodyExcerpt.length);
    const second = planImport(root, cfg, first.doc);
    assert.equal(second.actions.length, 0, '二次导入零动作');
  } finally { cleanup(root); }
});

test('runOfficialSourcesImport：dry-run 不写盘，正式运行写盘并产出报告', () => {
  const root = makeRoot();
  try {
    seeded(root);
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config/official-sources.json'),
      JSON.stringify({ enabled: true, collectedAt: '2026-11-27', sources: [{ url: 'https://example.com/a', title: 'A', grade: 'L1', status: 'approved', bodyKind: 'fulltext', bodyExcerpt: '正文'.repeat(160) }] }), 'utf8');

    const dry = runOfficialSourcesImport(root, { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.added, 1);
    assert.equal(readJson(root, 'data/sources.json').sources.length, 1, 'dry-run 零写盘');
    assert.equal(fs.existsSync(path.join(root, 'reports/official-sources.json')), false);

    const done = runOfficialSourcesImport(root, {});
    assert.equal(done.added, 1);
    assert.ok(done.snapshot);
    assert.equal(readJson(root, 'data/sources.json').sources.length, 2);
    assert.equal(readJson(root, 'reports/official-sources.json').added, 1);
  } finally { cleanup(root); }
});

test('真实配置：所有官网信源达到规则正文门槛', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'config/official-sources.json'), 'utf8'));
  for (const s of cfg.sources) {
    if (s.bodyExcerpt) assert.ok(s.bodyExcerpt.length >= 300, `${s.url} 正文不足 300 字`);
    assert.ok(s.grade === 'L1' && s.status === 'approved', `${s.url} 应为已批准官方源`);
  }
});
