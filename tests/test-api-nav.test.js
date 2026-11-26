import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, readJson, writeJson } from './helper.js';
import { runSyncApiNav, runReclassify } from '../scripts/sync-api-nav.js';
import { fetchAll, mapProduct, descFromProduct, dedupeProducts, buildUrl, reclassify } from '../scripts/lib/api-nav.js';

const cfg = {
  schema: 'api-nav/v1', enabled: true,
  endpoint: 'https://h5api.lot-ml.com/api/ProductEn/Index2', id: 'test-id',
  query: { Province: '全国' },
  page: { start: 1, maxPages: 2, perPage: 20, rateRps: 0, timeoutMs: 1000 },
  maxItems: 100, dedupeBy: 'productID',
  categoryByIsp: { '广电': '资费套餐', '联通': '资费套餐' }, defaultCategory: '资费套餐',
  cardDescMax: 60, rel: 'sponsored nofollow noopener', hasContent: false
};

function product(over = {}) {
  return {
    productID: 1, name: '广电飞花卡3.0【29元192G】', isp: '广电', taocan: '29元192G高速流量',
    nowPrice: '29', oldPrice: '39', tyLiuliang: '192', dxLiuliang: '0', tonghua: '0',
    shareUrl: 'https://lingqu.haokalingqu.cn/pdetails?tk=abc&pro=pid1',
    words: '菜鸟上门激活', keywords: ['长期29元'], ...over
  };
}

test('buildUrl 带推广位 id/筛选参数/分页', () => {
  const u = buildUrl(cfg, 2);
  assert.ok(u.includes('Id=test-id'));
  assert.ok(u.includes('Province='));
  assert.ok(u.includes('page=2'));
  assert.ok(u.includes('limit=20'));
});

test('descFromProduct 只用客观参数，不含营销话术', () => {
  const d = descFromProduct(product(), 60);
  assert.ok(d.includes('广电') && d.includes('192'));
  assert.ok(!d.includes('菜鸟') && !d.includes('长期'));
  assert.ok([...d].length <= 60);
});

test('mapProduct 客观参数进 nav，shareUrl 落 promoUrl/url，营销话术隔离', () => {
  const m = mapProduct(product(), cfg);
  assert.equal(m.navId, 'api-1');
  assert.equal(m.productId, 1);
  assert.equal(m.url, product().shareUrl);
  assert.equal(m.promoUrl, product().shareUrl);
  assert.equal(m.category, '资费套餐');
  assert.equal(m.rel, 'sponsored nofollow noopener');
  assert.equal(m.hasContent, false);
  assert.ok(!('words' in m) && !('keywords' in m));
  assert.equal(m._marketing.words, '菜鸟上门激活');
});

test('dedupeProducts 按 productID 去重', () => {
  const { items, duplicates } = dedupeProducts([product(), product(), product({ productID: 2, shareUrl: 'https://x.cn/p2' })], cfg);
  assert.equal(items.length, 2);
  assert.equal(duplicates, 1);
});

test('fetchAll 翻页聚合，注入 httpFn 零真实网络', async () => {
  const pages = {
    1: { code: 0, count: 3, data: [product({ productID: 1 }), product({ productID: 2 })] },
    2: { code: 0, count: 3, data: [product({ productID: 3 })] }
  };
  const httpFn = async (url) => {
    const p = Number(new URL(url).searchParams.get('page'));
    return { status: 200, text: JSON.stringify(pages[p] || { code: 0, data: [] }) };
  };
  const { items, meta } = await fetchAll(cfg, { httpFn, sleep: async () => {} });
  assert.equal(items.length, 3);
  assert.equal(meta.count, 3);
  assert.equal(meta.errors.length, 0);
});

test('fetchAll 失败显式降级，不伪造数据', async () => {
  const httpFn = async () => ({ status: 500, text: '' });
  const { items, meta } = await fetchAll(cfg, { httpFn, sleep: async () => {} });
  assert.equal(items.length, 0);
  assert.ok(meta.errors.length > 0);
});

test('sync-api-nav 注入假 API：只新增、按 productId 去重、快照', async () => {
  const root = makeRoot();
  const httpFn = async (url) => {
    const p = Number(new URL(url).searchParams.get('page'));
    const data = p === 1
      ? [product({ productID: 10, shareUrl: 'https://x.cn/p10' }), product({ productID: 11, shareUrl: 'https://x.cn/p11' })]
      : [];
    return { status: 200, text: JSON.stringify({ code: 0, count: 2, data }) };
  };
  const r = await runSyncApiNav(root, { httpFn, sleep: async () => {} });
  assert.equal(r.added, 2);
  assert.equal(r.total, 4); // 原 2 条人工 + 2 条 API
  assert.ok(r.snapshot);
  const nav = JSON.parse(fs.readFileSync(path.join(root, 'data/navlinks.json'), 'utf8'));
  assert.equal(nav.items.length, 4);
  const manual = nav.items.find((i) => i.navId === 'nav-001');
  assert.equal(manual.url, 'https://example.com/plan'); // 人工条目未改
  const api = nav.items.find((i) => i.productId === 10);
  assert.ok(api);
  assert.equal(api.promoUrl, 'https://x.cn/p10');
  assert.ok(!('words' in api));
});

test('sync-api-nav 重跑幂等：不重复添加', async () => {
  const root = makeRoot();
  const httpFn = async (url) => {
    const p = Number(new URL(url).searchParams.get('page'));
    return { status: 200, text: JSON.stringify({ code: 0, count: 1, data: p === 1 ? [product({ productID: 20, shareUrl: 'https://x.cn/p20' })] : [] }) };
  };
  await runSyncApiNav(root, { httpFn, sleep: async () => {} });
  const r2 = await runSyncApiNav(root, { httpFn, sleep: async () => {} });
  assert.equal(r2.added, 0);
  assert.equal(r2.skipped.duplicate, 1);
  const nav = JSON.parse(fs.readFileSync(path.join(root, 'data/navlinks.json'), 'utf8'));
  assert.equal(nav.items.length, 3);
});

test('sync-api-nav dryRun 不写盘', async () => {
  const root = makeRoot();
  const httpFn = async (url) => {
    const p = Number(new URL(url).searchParams.get('page'));
    return { status: 200, text: JSON.stringify({ code: 0, count: 1, data: p === 1 ? [product({ productID: 30, shareUrl: 'https://x.cn/p30' })] : [] }) };
  };
  const r = await runSyncApiNav(root, { httpFn, sleep: async () => {}, dryRun: true });
  assert.equal(r.dryRun, true);
  const nav = JSON.parse(fs.readFileSync(path.join(root, 'data/navlinks.json'), 'utf8'));
  assert.equal(nav.items.length, 2); // 未写
});

const reCfg = {
  categoryByIsp: { '广电': '广电套餐', '联通': '联通套餐', '移动': '移动套餐', '电信': '电信套餐' },
  defaultCategory: '资费套餐'
};

test('reclassify 纯函数：只改 API 条目，人工条目不动，幂等', () => {
  const items = [
    { navId: 'nav-001', category: '资费套餐', url: 'x' }, // 人工，无 productId
    { navId: 'api-1', productId: 1, isp: '广电', category: '资费套餐' },
    { navId: 'api-2', productId: 2, isp: '联通', category: '资费套餐' },
    { navId: 'api-3', productId: 3, isp: '未知运营商', category: '资费套餐' }
  ];
  const r = reclassify(items, reCfg);
  assert.equal(r.changed, 2); // 广电/联通各改一次，未知用 fallback 但已是资费套餐不动
  assert.equal(r.items[0].category, '资费套餐'); // 人工未动
  assert.equal(r.items[1].category, '广电套餐');
  assert.equal(r.items[2].category, '联通套餐');
  assert.equal(r.items[3].category, '资费套餐');
  assert.equal(items[1].category, '资费套餐'); // 入参未被改（纯函数）
  const r2 = reclassify(r.items, reCfg);
  assert.equal(r2.changed, 0); // 幂等
});

test('runReclassify 集成：四区映射、快照、人工不动、不写人工分类', async () => {
  const root = makeRoot();
  const nav = readJson(root, 'data/navlinks.json');
  nav.items.push(
    { navId: 'api-1', productId: 1, isp: '广电', category: '资费套餐', url: 'https://x.cn/1', title: 'a', cardDesc: 'd', hasContent: false, sourceIds: [] },
    { navId: 'api-2', productId: 2, isp: '联通', category: '资费套餐', url: 'https://x.cn/2', title: 'b', cardDesc: 'd', hasContent: false, sourceIds: [] },
    { navId: 'api-3', productId: 3, isp: '电信', category: '资费套餐', url: 'https://x.cn/3', title: 'c', cardDesc: 'd', hasContent: false, sourceIds: [] }
  );
  writeJson(root, 'data/navlinks.json', nav);
  const r = await runReclassify(root, {});
  assert.equal(r.changed, 3);
  assert.ok(r.snapshot);
  const next = readJson(root, 'data/navlinks.json');
  const byId = Object.fromEntries(next.items.map((i) => [i.navId, i.category]));
  assert.equal(byId['nav-001'], '资费套餐'); // 人工保持
  assert.equal(byId['nav-002'], '办理攻略'); // 人工保持
  assert.equal(byId['api-1'], '广电套餐');
  assert.equal(byId['api-2'], '联通套餐');
  assert.equal(byId['api-3'], '电信套餐');
  const r2 = await runReclassify(root, {});
  assert.equal(r2.changed, 0); // 幂等
  assert.equal(r2.snapshot, undefined); // 无变化不写盘不快照
});

test('runReclassify dryRun 不写盘', async () => {
  const root = makeRoot();
  const nav = readJson(root, 'data/navlinks.json');
  nav.items.push({ navId: 'api-1', productId: 1, isp: '广电', category: '资费套餐', url: 'https://x.cn/1', title: 'a', cardDesc: 'd', hasContent: false, sourceIds: [] });
  writeJson(root, 'data/navlinks.json', nav);
  const r = await runReclassify(root, { dryRun: true });
  assert.equal(r.changed, 1);
  assert.equal(r.dryRun, true);
  const next = readJson(root, 'data/navlinks.json');
  assert.equal(next.items.find((i) => i.navId === 'api-1').category, '资费套餐'); // 未写
});
