// 数据可信门禁：配置驱动、纯函数、不猜数字、只做确定性修正。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, readJson, writeJson, REPO } from './helper.js';
import {
  loadDataQualityRules, checkItem, applySafeFixes, checkAll, enforceItems
} from '../scripts/lib/data-quality.js';
import { runSyncApiNav } from '../scripts/sync-api-nav.js';

const rules = () => JSON.parse(fs.readFileSync(path.join(REPO, 'rules/data-quality.json'), 'utf8'));

function item(over = {}) {
  return {
    navId: 'api-1', title: '测试卡【29元192G】', cardDesc: '测试',
    specs: {
      taocan: '29元192G高速流量', nowPrice: '29', oldPrice: '39', tyLiuliang: '192',
      priceUnitStr: '月租费用', sales: '1200'
    },
    ...over
  };
}

test('checkItem：好样本零违规', () => {
  const r = checkItem(item(), rules());
  assert.equal(r.violations.length, 0);
  assert.equal(r.unresolved.length, 0);
});

test('checkItem：标题口径=通用+定向时只标记，不猜数字', () => {
  const bad = item({
    title: '江西广电专享卡【28元350G】',
    specs: { ...item().specs, taocan: '28元350G', tyLiuliang: '320', dxLiuliang: '30' }
  });
  const r = checkItem(bad, rules());
  assert.ok(r.violations.some((v) => v.code === 'title-flow-mismatch'));
  assert.ok(r.unresolved.some((u) => u.code === 'title-flow-needs-human'));
});

test('checkItem：明细与汇总矛盾时标记待人工，不自动改数值', () => {
  const bad = item({
    title: '广电陕西专属卡【29元200G】',
    specs: { ...item().specs, taocan: '29元200G通用流量', tyLiuliang: '60' }
  });
  const r = checkItem(bad, rules());
  assert.ok(r.violations.some((v) => v.code === 'plan-summary-mismatch'));
  assert.ok(r.unresolved.some((u) => u.code === 'plan-summary-needs-human'));
  const fixed = applySafeFixes(bad, rules());
  assert.equal(fixed.item.specs.tyLiuliang, '60', '门禁不改业务数值');
});

test('checkItem：划线价倒挂与销量超阈值给确定性修正', () => {
  const bad = item({
    specs: { ...item().specs, oldPrice: '29', price: '29', sales: '3226548' }
  });
  bad.specs.nowPrice = '29';
  const r = checkItem(bad, rules());
  assert.ok(r.fixes.some((f) => f.code === 'hide-old-price'));
  assert.ok(r.fixes.some((f) => f.code === 'hide-sales'));
  const fixed = applySafeFixes(bad, rules()).item;
  assert.ok(!('oldPrice' in fixed.specs));
  assert.ok(!('sales' in fixed.specs));
  assert.equal(fixed.specs.tyLiuliang, '192', '其他字段不动');
  assert.deepEqual(applySafeFixes(fixed, rules()).fixes.length, 0, '幂等');
});

test('checkItem：年费单位与非主题 SKU 被识破', () => {
  const year = item({
    title: '联通360元包年卡【每月300G】',
    specs: { ...item().specs, taocan: '月均30元260G省内通用+40G全国通用', nowPrice: '360', oldPrice: '48', priceUnitStr: '一年费用', tyLiuliang: '300' }
  });
  const yr = checkItem(year, rules());
  assert.ok(yr.violations.some((v) => v.code === 'price-unit-year'));
  assert.ok(yr.unresolved.some((u) => u.code === 'year-plan-title-needs-human'));
  const sku = item({ title: '山东移动120元视频会员年卡', specs: { ...item().specs, tyLiuliang: '0' } });
  assert.ok(checkItem(sku, rules()).violations.some((v) => v.code === 'irrelevant-sku'));
});

test('checkAll：存量报告统计 fixable / needsHuman', () => {
  const report = checkAll([item(), item({ navId: 'api-2', specs: { ...item().specs, sales: '999999' } })], rules());
  assert.equal(report.checked, 2);
  assert.equal(report.passed, 1);
  assert.equal(report.fixable, 1);
});

test('字段路径可配：换主题改 fields 即可复用门禁', () => {
  const custom = JSON.parse(JSON.stringify(rules()));
  custom.fields = {
    title: 'name', generalFlow: 'attrs.general', planText: 'attrs.plan',
    price: 'attrs.price', oldPrice: 'attrs.was', priceUnit: 'attrs.unit', sales: 'attrs.sold'
  };
  const other = {
    name: '产品【50G】', attrs: { general: '50', plan: '50G通用', price: '10', was: '8', unit: '月租', sold: '9999' }
  };
  const r = checkItem(other, custom);
  assert.ok(r.fixes.some((f) => f.code === 'hide-old-price'));
  assert.ok(!r.violations.some((v) => v.code === 'title-flow-mismatch'));
});

test('enforceItems：不合规拒绝入库，确定性可修的先修再入', async () => {
  const root = makeRoot();
  try {
    const r = loadDataQualityRules(root); // helper 无此规则文件 → 默认 enforceOnSync=false
    assert.equal(r.enforceOnSync, false, '缺规则时不得擅自启用拦截');
    writeJson(root, 'rules/data-quality.json', { ...rules(), enforceOnSync: true });
    const strict = loadDataQualityRules(root);
    const good = item({ navId: 'api-good' });
    const bad = item({ navId: 'api-bad', title: '矛盾卡【350G】', specs: { ...item().specs, tyLiuliang: '60', dxLiuliang: '30' } });
    const fixable = item({ navId: 'api-fix', specs: { ...item().specs, sales: '888888', oldPrice: '10' } });
    const out = enforceItems([good, bad, fixable], strict);
    assert.equal(out.enforced, true);
    assert.deepEqual(out.accepted.map((x) => x.navId), ['api-good', 'api-fix']);
    assert.equal(out.rejected.length, 1);
    assert.equal(out.accepted[1].specs.sales, undefined);
  } finally { cleanup(root); }
});

test('落库门禁接入：sync-api-nav 拒绝不合规新条目、保留人工条目', async () => {
  const root = makeRoot();
  try {
    writeJson(root, 'rules/data-quality.json', { ...rules(), enforceOnSync: true });
    writeJson(root, 'config/api-nav.json', JSON.parse(fs.readFileSync(path.join(REPO, 'config/api-nav.json'), 'utf8')));
    const httpFn = async (url) => {
      const p = Number(new URL(url).searchParams.get('page'));
      const data = p === 1
        ? [
            { productID: 101, name: '好卡【29元100G】', isp: '广电', taocan: '29元100G', nowPrice: '29', oldPrice: '39', tyLiuliang: '100', shareUrl: 'https://x.cn/good' },
            { productID: 102, name: '矛盾卡【350G】', isp: '广电', taocan: '28元350G', nowPrice: '28', oldPrice: '39', tyLiuliang: '60', shareUrl: 'https://x.cn/bad' }
          ]
        : [];
      return { status: 200, text: JSON.stringify({ code: 0, count: 2, data }) };
    };
    const r = await runSyncApiNav(root, { httpFn, sleep: async () => {} });
    assert.equal(r.quality.enforced, true);
    assert.equal(r.quality.rejected, 1);
    assert.equal(r.added, 1);
    const nav = readJson(root, 'data/navlinks.json');
    assert.ok(nav.items.some((i) => i.productId === 101));
    assert.ok(!nav.items.some((i) => i.productId === 102), '口径矛盾的新条目不得入库');
    assert.equal(nav.items.find((i) => i.navId === 'nav-001').url, 'https://example.com/plan');
  } finally { cleanup(root); }
});
