// 信源全文回填：只把更长的官方详情原文写进 bodyExcerpt，幂等、不缩短已有正文。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoot, cleanup, readJson, writeJson } from './helper.js';
import { runSyncSourceFulltext } from '../scripts/sync-source-fulltext.js';

test('sync-source-fulltext: 详情原文回填，重复运行幂等，已有更长正文不缩短', () => {
  const root = makeRoot();
  try {
    writeJson(root, 'data/nav-details.json', {
      schema: 'nav-details/v1',
      pages: [
        { navId: 'api-1', sourceIds: ['src-001'], sourceBody: '官方详情原文：首充一百元，合约十二个月，禁发北京。'.repeat(10) },
        { navId: 'api-2', sourceIds: ['src-002'], sourceBody: '详情原文较短。'.repeat(12) }
      ]
    });
    const s = readJson(root, 'data/sources.json');
    s.sources[0].bodyExcerpt = '旧摘录';
    s.sources[1].bodyExcerpt = '这是一段比详情原文更长的已有正文，任何同步都不应把它缩短。'.repeat(5);
    writeJson(root, 'data/sources.json', s);

    const r1 = runSyncSourceFulltext(root, {});
    assert.equal(r1.filled + r1.upgraded, 1, '短摘录被回填为全文');
    assert.equal(r1.unchanged, 1, '已有更长正文不被缩短');
    const after1 = readJson(root, 'data/sources.json').sources;
    assert.ok(after1[0].bodyExcerpt.startsWith('官方详情原文'));
    assert.equal(after1[0].bodyKind, 'fulltext');
    assert.ok(after1[1].bodyExcerpt.startsWith('这是一段比详情原文更长'));

    const r2 = runSyncSourceFulltext(root, {});
    assert.equal(r2.filled + r2.upgraded, 0, '二次运行零改动');
    assert.deepEqual(readJson(root, 'data/sources.json').sources, after1);
  } finally { cleanup(root); }
});

test('maintenance: preserveLongerBody 开启时，复检的短摘录不覆盖已有全文', async () => {
  const root = makeRoot();
  try {
    // 直接锁定规则语义：配置开关为真时，短摘录不能替换长正文。
    const { runMaintenance } = await import('../scripts/maintenance.js');
    writeJson(root, 'rules/maintenance.json', { schema: 'rules/maintenance/v1', recheckEnabled: false, cleanupDiscoveredBy: [] });
    writeJson(root, 'rules/source-grade.json', { schema: 'rules/source-grade/v1', preserveLongerBody: true });
    const s = readJson(root, 'data/sources.json');
    const long = '官方完整正文：'.repeat(100);
    s.sources[0].bodyExcerpt = long;
    writeJson(root, 'data/sources.json', s);
    await runMaintenance(root, {});
    const after = readJson(root, 'data/sources.json').sources.find((x) => x.sourceId === 'src-001');
    assert.equal(after.bodyExcerpt, long, '未被复检覆盖');
  } finally { cleanup(root); }
});
