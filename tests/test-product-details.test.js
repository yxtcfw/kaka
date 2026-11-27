import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, readJson, writeJson } from './helper.js';
import { parsePromoParams, htmlToText, buildDetailText, postJson, objectiveIntro, introToText } from '../scripts/lib/product-detail.js';
import { runSyncProductDetails } from '../scripts/sync-product-details.js';

const LONG = '优惠说明'.repeat(500); // 2000 字：验证完整保留、不截断
const OFFICIAL = {
  code: 0,
  message: 'ok',
  data: {
    priceUnit: '月',
    pack: {
      name: '29元192G',
      packageDetail: '<p>原套餐:29元包192G通用流量，超出5元/G。</p>',
      offerDetail: `<p>${LONG}</p>`,
      expressMeth: '菜鸟',
      actMeth: '快递激活',
      rechargeLink: '首次充值100元',
      ages: '18-65周岁',
      contractPeriod: '12个月',
      noCitys: '广东省,西藏自治区',
      offMeth: '<p>中国广电APP</p>',
      fgSup: '5G网速'
    },
    pud: {
      productName: '广电飞花卡3.0【29元192G】',
      taocan: '29元192G高速流量',
      tyLiuliang: '192',
      dxLiuliang: '0',
      tonghua: '0',
      nowPrice: '29'
    }
  }
};

function seedNav(root) {
  writeJson(root, 'data/navlinks.json', {
    schema: 'navlinks/v1',
    items: [{
      navId: 'api-5260', productId: 5260, isp: '广电',
      title: '广电飞花卡3.0【29元192G】',
      url: 'https://lingqu.haokalingqu.cn/pdetails?tk=tk1&pro=pro1',
      promoUrl: 'https://lingqu.haokalingqu.cn/pdetails?tk=tk1&pro=pro1',
      category: '广电套餐', cardDesc: '广电 29元192G', hasContent: false,
      sourceIds: ['src-001'], rel: 'sponsored nofollow noopener'
    }]
  });
}

test('推广链接 tk/pro 参数解析', () => {
  assert.deepEqual(parsePromoParams('https://lingqu.haokalingqu.cn/pdetails?tk=a&pro=b'), { tk: 'a', pro: 'b' });
  assert.deepEqual(parsePromoParams('not a url'), { tk: '', pro: '' });
});

test('HTML 纯文本化：去标签、还原实体、保留全部文字', () => {
  const text = htmlToText('<p>月租&nbsp;29元 &amp; 192G<br>超出5元/G</p>');
  assert.equal(text, '月租 29元 & 192G\n超出5元/G');
});

test('官方详情正文：所有客观字段完整保留，不截断', () => {
  const text = buildDetailText(OFFICIAL);
  for (const label of ['套餐资费', '优惠说明', '配送方式', '激活方式', '首充要求', '年龄要求', '合约期限', '禁发地区', '销户方式', '网络制式', '通用流量', '月租费用']) {
    assert.ok(text.includes(`${label}：`), `缺字段 ${label}`);
  }
  assert.ok(text.includes(LONG), '超长优惠说明被截断');
  assert.ok(text.includes('原套餐:29元包192G通用流量'), '资费原文丢失');
  assert.ok(!text.includes('<p>'), 'HTML 标签未剥离');
});

test('无模型 key 时的客观介绍为结构化段落，只拼接官方字段、不新增数值', () => {
  const text = buildDetailText(OFFICIAL);
  const segments = objectiveIntro('测试套餐', text);
  assert.ok(Array.isArray(segments) && segments.length >= 3, '须按主题拆成结构化段落');
  assert.deepEqual(segments.map((s) => s.title), ['套餐包含什么', '怎么办理', '谁能办理', '禁发地区', ''], '小标题须按主题分组');
  assert.ok(segments.every((s) => typeof s.text === 'string' && s.text.trim()), '每段须有正文');
  const flat = introToText(segments);
  assert.ok(flat.includes('29元/月'), '须使用官方月租字段');
  assert.ok(flat.includes('192G通用流量'), '须使用官方流量字段');
  assert.ok(flat.includes('18-65周岁'), '须使用官方年龄字段');
  assert.ok(flat.includes('以下地区不办理：广东省,西藏自治区'), '地区须明确标为不可办理');
  const who = segments.find((s) => s.title === '谁能办理');
  assert.ok(!who.text.includes('广东省'), '禁发地区不得混进「谁能办理」');
  assert.ok(flat.endsWith('具体资费以官方实时页面为准。'));
  assert.deepEqual(objectiveIntro('无资料', ''), [], '无官方资料时不硬写介绍');
});

test('postJson 走注入的 httpFn 并传 POST 参数', async () => {
  let seen = null;
  const resp = await postJson('https://example.com/api', { userid: 'a', pudiD: 'b' }, (url, opts) => {
    seen = { url, opts };
    return { status: 200, text: JSON.stringify({ code: 0 }) };
  });
  assert.equal(resp.code, 0);
  assert.equal(seen.url, 'https://example.com/api');
  assert.equal(seen.opts.method, 'POST');
  assert.ok(seen.opts.body.includes('"pudiD":"b"'));
});

test('详情采集：信源入库 L1、挂到 nav、保留人工 sourceIds，dry-run 零写盘', async () => {
  const root = makeRoot();
  try {
    seedNav(root);
    const before = fs.readFileSync(path.join(root, 'data/sources.json'), 'utf8');
    const httpFn = () => ({ status: 200, text: JSON.stringify(OFFICIAL) });

    const dry = await runSyncProductDetails(root, { httpFn, sleep: async () => {}, dryRun: true });
    assert.equal(dry.created, 1);
    assert.equal(dry.linked, 1);
    assert.equal(fs.readFileSync(path.join(root, 'data/sources.json'), 'utf8'), before, 'dry-run 不得写盘');

    const report = await runSyncProductDetails(root, { httpFn, sleep: async () => {} });
    assert.equal(report.created, 1);
    assert.equal(report.failed, 0);
    const sources = readJson(root, 'data/sources.json').sources;
    const src = sources.find((s) => s.sourceId === 'src-api-5260');
    assert.ok(src, '官方详情信源未入库');
    assert.equal(src.grade, 'L1');
    assert.equal(src.status, 'approved');
    assert.equal(src.bodyKind, 'fulltext');
    assert.equal(src.discoveredBy, 'collect');
    assert.ok(src.bodyExcerpt.includes(LONG), '正文未完整保留');
    assert.equal(src.bodyChars, src.bodyExcerpt.length);

    const nav = readJson(root, 'data/navlinks.json').items[0];
    assert.deepEqual(nav.sourceIds, ['src-001', 'src-api-5260'], '人工 sourceId 不得丢失');
    assert.equal(nav.promoUrl, 'https://lingqu.haokalingqu.cn/pdetails?tk=tk1&pro=pro1');
    assert.equal(readJson(root, 'state.json').sources.l1 >= 2, true);
  } finally { cleanup(root); }
});

test('详情采集：重复运行幂等；接口失败保留旧值', async () => {
  const root = makeRoot();
  try {
    seedNav(root);
    const ok = () => ({ status: 200, text: JSON.stringify(OFFICIAL) });
    await runSyncProductDetails(root, { httpFn: ok, sleep: async () => {} });
    const first = readJson(root, 'data/sources.json').sources.find((s) => s.sourceId === 'src-api-5260');
    const second = await runSyncProductDetails(root, { httpFn: ok, sleep: async () => {} });
    assert.equal(second.created, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.unchanged, 1);
    assert.equal(second.linked, 0);

    const bad = () => ({ status: 200, text: JSON.stringify({ code: -1, message: 'err' }) });
    const failed = await runSyncProductDetails(root, { httpFn: bad, sleep: async () => {} });
    assert.equal(failed.failed, 1);
    const after = readJson(root, 'data/sources.json').sources.find((s) => s.sourceId === 'src-api-5260');
    assert.equal(after.bodyHash, first.bodyHash, '失败不得覆盖旧正文');
    assert.equal(failed.failures[0].navId, 'api-5260');
  } finally { cleanup(root); }
});
