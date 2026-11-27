import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseSuggestArray, buildQueries, baiduSuggest } from '../scripts/lib/suggest.js';
import { runHarvest } from '../scripts/harvest.js';
import { makeRoot, cleanup, readJson, writeJson } from './helper.js';

const jsonp = (words, q = '测试') => `vstcb({q:"${q}",p:false,s:${JSON.stringify(words)}});`;

test('parseSuggestArray: 解析百度 JSONP（键无引号），保留含引号/方括号的词', () => {
  const text = 'vstcb({q:"流量卡",p:false,s:["流量卡]办理","含\\"引号\\"的词","ab"]});';
  assert.deepEqual(parseSuggestArray(text), ['流量卡]办理', '含"引号"的词', 'ab']);
  assert.throws(() => parseSuggestArray('vstcb({q:"x"});'), /缺少 s 数组/);
});

test('buildQueries: 覆盖多种子且限量', () => {
  const qs = buildQueries(['流量卡', '副卡'], 8);
  assert.equal(qs.length, 8);
  assert.ok(qs.some((q) => q.includes('流量卡')));
  assert.ok(qs.some((q) => q.includes('副卡')));
  assert.equal(new Set(qs).size, qs.length);
});

test('baiduSuggest: 真 provider 走注入 fetchFn，词带 source/query', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return { status: 200, text: jsonp(['流量卡办理', '移动流量卡资费'], '流量卡办理') };
  };
  const r = await baiduSuggest(['流量卡办理'], { root: makeRoot(), fetchFn });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /suggestion\.baidu\.com\/su\?wd=/);
  assert.match(calls[0], /ie=utf-8/);
  assert.deepEqual(r.items.map((x) => x.term), ['流量卡办理', '移动流量卡资费']);
  assert.equal(r.items[0].source, 'baidu-suggest');
});

test('baiduSuggest: 单条查询超时只留痕，其余查询继续', async () => {
  const root = makeRoot();
  const fetchFn = async (url) => {
    if (String(url).includes('robots.txt')) return { status: 200, text: 'User-agent: *\nAllow: /' };
    if (decodeURIComponent(String(url)).includes('wd=流量卡办理') && !decodeURIComponent(String(url)).includes('联通')) {
      throw new Error('GuardTimeout: first query');
    }
    return { status: 200, text: jsonp(['流量卡办理入口']) };
  };
  try {
    const r = await baiduSuggest(['流量卡办理', '联通流量卡资费'], { root, fetchFn });
    assert.ok(r.items.length >= 1, '其余查询仍须产出词');
    assert.equal(r.guard.failures.length, 1);
    assert.match(r.guard.failures[0].reason, /GuardTimeout|fetch guard timeout/i);
  } finally { cleanup(root); }
});

test('harvest: API 商品名作为第二真实信号源', async () => {
  const root = makeRoot();
  try {
    const nav = readJson(root, 'data/navlinks.json');
    nav.items.push({ navId: 'api-1', title: '联通大流量卡29元套餐', productId: '5260', hasContent: true, sourceIds: [] });
    writeJson(root, 'data/navlinks.json', nav);
    const r = await runHarvest(root, {});
    assert.equal(r.degraded, false);
    assert.ok(r.sources >= 2);
    const fromApi = readJson(root, 'data/signals.json').items.filter((x) => x.source === 'api-product');
    assert.equal(fromApi.length, 1);
    assert.equal(fromApi[0].term, '联通大流量卡29元套餐');
  } finally { cleanup(root); }
});

test('harvest: 真 provider 采集结果入库；失败时降级 mock 并写 reason', async () => {
  const root = makeRoot();
  try {
    const manifest = readJson(root, 'config/manifest.json');
    manifest.providers.suggest = 'baidu-suggest';
    writeJson(root, 'config/manifest.json', manifest);
    const words = ['流量卡办理', '移动流量卡资费', '流量卡避坑指南'];
    const r = await runHarvest(root, {
      queries: ['流量卡办理'],
      fetchFn: async () => ({ status: 200, text: jsonp(words) })
    });
    assert.equal(r.degraded, false);
    assert.equal(r.reason, '');
    assert.ok(r.count >= 3);
    assert.equal(readJson(root, 'data/signals.json').items[0].source, 'baidu-suggest');

    const bad = await runHarvest(root, {
      queries: ['流量卡办理'],
      fetchFn: async () => { throw new Error('mock network down'); }
    });
    assert.equal(bad.degraded, true);
    assert.match(bad.reason, /mock network down/);
    assert.ok(fs.existsSync(path.join(root, 'reports/harvest-degraded.json')));
    assert.match(readJson(root, 'reports/harvest-degraded.json').reason, /mock network down/);
  } finally { cleanup(root); }
});
