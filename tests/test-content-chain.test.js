// 内容生产链路：树定问(命题卡) → 信源定事实(Fact Sheet) → AI 定表达 → 内容质量门禁。
// 所有写路径由 root 派生，不触碰真实仓库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, readJson, writeJson, REPO } from './helper.js';
import { composeBundle, composeBrief, deterministicBrief, pickTitle } from '../scripts/lib/llm.js';
import { buildFactSheet, rankSourcesForNode, buildMaterialPack, factSheetDigest, loadFactConfig } from '../scripts/lib/fact-sheet.js';
import { checkContentQuality, loadQualityConfig } from '../scripts/lib/content-gates.js';

function fakeRes(body) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: body } }], model: 'test-model' }) };
}

test('composeBrief: 真模型生成命题卡，含资费数字字段被丢弃并回退确定性值', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'test-key-brief';
  try {
    const fallback = deterministicBrief({ label: '广电卡', topic: '广电卡怎么办', keywords: ['广电'] }, {});
    const r = await composeBrief('openrouter', {
      label: '广电卡', topic: '广电卡怎么办', keywords: ['广电'], parentTitle: '办理攻略', sourceTitles: ['广电官方详情']
    }, {
      prompts: { maxFieldChars: 160, promptVersion: 'brief-v1' },
      fetchFn: async () => fakeRes(JSON.stringify({
        reader_situation: '湖南用户刷到29元广告想办广电卡', // 含数字 → 必须回退
        core_question: '广电卡在湖南为什么办不了？',
        one_sentence_answer: '先看禁发地区再决定',
        must_cover: ['禁发地区', '首充要求'],
        must_avoid: ['编造成功率'],
        intent: 'problem'
      }))
    });
    assert.equal(r.meta.deterministic, false);
    assert.equal(r.meta.promptVersion, 'brief-v1');
    assert.equal(r.brief.reader_situation, fallback.reader_situation, '含资费数字的字段不得进入命题卡');
    assert.equal(r.brief.core_question, '广电卡在湖南为什么办不了？', '合法字段应采用模型产出');
    assert.deepEqual(r.brief.must_cover, ['禁发地区', '首充要求']);
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = old;
  }
});

test('rankSourcesForNode: 按节点关键词相关性选信源，不再按未用顺序错配', () => {
  const root = makeRoot();
  try {
    const sourceDoc = {
      schema: 'sources/v1', sources: [
        { sourceId: 'src-a', title: '广电飞花卡3.0【29元192G】 · 官方详情', domain: 'a.cn', grade: 'L1', status: 'approved', bodyExcerpt: '首充100元，合约12个月，禁发广东。'.repeat(4) },
        { sourceId: 'src-b', title: '校园流量卡办理条件与首充要求 · 官方详情', domain: 'b.cn', grade: 'L1', status: 'approved', bodyExcerpt: '校园卡仅限在校学生办理，年龄18至28周岁。'.repeat(4) }
      ]
    };
    const navDoc = { items: [] };
    const node = { id: 'auto-campus', label: '校园卡', topic: '校园流量卡办理', keywords: ['校园卡', '校园流量卡', '学生'], parent: 'n0' };
    const ranked = rankSourcesForNode(node, sourceDoc, navDoc, loadFactConfig(root));
    assert.equal(ranked[0].sourceId, 'src-b', '校园卡节点必须优先命中校园卡信源');
  } finally { cleanup(root); }
});

test('buildFactSheet: L3 字段带 not_for，素材包含三张对比卡与具体的坑，不伪造用户原话', () => {
  const root = makeRoot();
  const long = '月租费用：29元/月\n年龄要求：18-65周岁\n合约期限：12个月\n禁发地区：广东省,河南省\n首充要求：激活时一次性充值100元\n超出资费：流量5元/G\n'.repeat(3);
  const sourceDoc = { sources: ['a', 'b', 'c', 'd'].map((k) => ({
    sourceId: `src-${k}`, title: `${k} 卡详情`, domain: `${k}.cn`, url: `https://${k}.cn`, grade: k === 'd' ? 'L3' : 'L1',
    status: 'approved', fetchedAt: '2026-11-28', bodyExcerpt: long
  })) };
  const navDoc = { items: [] };
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'config/fact-sheet.json'), 'utf8'));
  const sheet = buildFactSheet(root, sourceDoc, navDoc, cfg);
  assert.ok(sheet.facts.length >= 8);
  const l3 = sheet.facts.find((f) => f.sourceId === 'src-d' && f.field === 'monthly_fee');
  assert.ok(l3.not_for.includes('price'), 'L3 不得作确定报价');
  assert.ok(l3.usable_as.includes('据平台整理约为'));
  const ranked = rankSourcesForNode({ id: 'n2', keywords: ['月租'], topic: '资费对比' }, sourceDoc, navDoc, cfg);
  const pack = buildMaterialPack({ id: 'n2', keywords: [] }, ranked, sheet, cfg);
  assert.equal(pack.comparisons.length, 3, '三张同类卡对比');
  assert.ok(pack.pitfall && pack.pitfall.value.includes('100元'), '具体的坑来自信源原文');
  assert.ok(pack.surprisingNumber && pack.surprisingNumber.value.includes('5元/G'));
  assert.deepEqual(pack.userQuotes, [], '无真实评论时不伪造用户原话');
  const digest = factSheetDigest(sheet, pack, cfg, 4000);
  assert.ok(digest.includes('据平台整理约为') && digest.includes('src-d'), 'L3 标记须进入模型输入');
});

test('pickTitle: 冲突疑问句胜出，模板句与站内重复被扣分，候选全部保留', () => {
  const rules = {
    minChars: 15, maxChars: 22, requireKeyword: true,
    bonusPatterns: ['[？?]', '为什么|别碰'], penaltyPatterns: ['介绍|资料整理'], minScore: 0
  };
  const r = pickTitle([
    '广电飞花卡3.0介绍',
    '29元192G的广电卡，广东人为什么办不了？',
    '广电飞花卡3.0办理条件说明'
  ], { keywords: ['广电'], existingTitles: ['广电飞花卡3.0办理条件说明'] }, rules);
  assert.equal(r.chosen, '29元192G的广电卡，广东人为什么办不了？');
  assert.equal(r.candidates.length, 3, '全部候选保留供人工替换');
});

test('内容质量门禁：并列清单、模糊词、注水、L3 冒充报价、无判断句一律拦截', () => {
  const root = makeRoot();
  // 测试基座不复制新规则（避免影响其他基于 mock 短稿的测试），本测试显式读真实配置。
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'rules/content-quality.json'), 'utf8'));
  assert.equal(cfg.enabled, true);
  const facts = [{ field: 'monthly_fee', value: '29元/月', grade: 'L1', not_for: [] }];
  const brief = { must_cover: ['禁发地区', '首充要求'] };
  const bad = '第一要看首充。通常按月租29元计算，广东禁发，未满18周岁不能办理。第二要留凭证。';
  const res = checkContentQuality({ body: bad, brief, facts, cfg }, { paragraphCount: 1, expectedParagraphs: 4 });
  const gates = res.failures.map((f) => f.gate);
  assert.ok(gates.includes('fuzzy'), '模糊词须拦截');
  assert.ok(gates.includes('parallel-list'), '并列清单须拦截');
  assert.ok(gates.includes('judgement'), '文末无判断须拦截');
  assert.ok(gates.includes('structure'), '段落不足须拦截');
  const good = [
    '广东用户刷到29元广告，办卡前先核对首充要求。',
    '首充100元才成立，不充则按39元计费，这是低价套餐的成立条件。',
    '同价位里校园卡只发学生，反例说明地区规则比价格更该先看。',
    '广东用户在列就别碰这张，优先选未禁发的同类卡。'
  ].join('\n\n');
  const ok = checkContentQuality({ body: good, brief: { must_cover: ['首充要求'] }, facts: [...facts,
    { field: 'activation_fee', value: '首充100元', grade: 'L1', not_for: [] },
    { field: 'original_price', value: '不充则按39元计费', grade: 'L1', not_for: [] }
  ], cfg }, { paragraphCount: 4, expectedParagraphs: 4 });
  assert.equal(ok.ok, true, JSON.stringify(ok.failures));
});

test('composeBundle: 门禁失败项作为审核意见回灌到 user 提示词（打回重写）', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'test-key-rewrite';
  let seen = null;
  try {
    const fetchFn = async (_url, opts) => {
      seen = JSON.parse(opts.body).messages;
      return fakeRes(JSON.stringify({ intro: [{ title: '核对', text: '据平台整理约为29元，广东用户别碰这张。' }], cardDesc: '摘要', claims: [] }));
    };
    await composeBundle('openrouter', {
      id: 'rw-1', kind: 'article', title: '测试', sourceIds: ['src-001'],
      reviewNotes: 'fuzzy: 模糊词命中「通常」；judgement: 文末缺少判断句'
    }, {
      fetchFn,
      prompts: { system: '系统要求', user: '主题={title}；审核意见={reviewNotes}', promptVersion: 'article-v2' }
    });
    assert.ok(seen[1].content.includes('模糊词命中「通常」'), '失败项须进入重写提示词');
    assert.ok(seen[1].content.includes('文末缺少判断句'));
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = old;
  }
});
