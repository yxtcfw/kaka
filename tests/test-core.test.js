import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgainst, validateDoc, validateRepo, readJson } from '../scripts/lib/validate.js';
import { urlKey, domainOf, cosineSimilarity, extractNumbers, sha256, seededRandom } from '../scripts/lib/util.js';
import { makeRoot, cleanup, writeJson } from './helper.js';
import path from 'node:path';

test('validateRepo: 基线仓库全部数据文件合法', () => {
  const root = makeRoot();
  try {
    const v = validateRepo(root);
    assert.equal(v.ok, true, JSON.stringify(v.results));
  } finally { cleanup(root); }
});

test('validateAgainst: 必填字段/类型/枚举/长度约束生效', () => {
  const schema = {
    type: 'object', required: ['a', 'b'],
    properties: {
      a: { type: 'string', minLength: 2 },
      b: { type: 'number', minimum: 0, maximum: 10 },
      c: { type: 'string', enum: ['x', 'y'] }
    }
  };
  assert.deepEqual(validateAgainst({ a: 'ok', b: 5, c: 'x' }, schema), []);
  const errs = validateAgainst({ a: '', b: 20, c: 'z' }, schema);
  assert.ok(errs.some((e) => e.includes('minLength')));
  assert.ok(errs.some((e) => e.includes('maximum')));
  assert.ok(errs.some((e) => e.includes('enum')));
  assert.ok(validateAgainst({}, schema).some((e) => e.includes('missing required field')));
});

test('validateDoc: 未知 discriminator 被拒', () => {
  assert.ok(validateDoc({ schema: 'unknown/v9' }).some((e) => e.includes('unknown schema')));
});

test('validateRepo: 破坏 cardDesc 超 60 字被 navlinks schema 拦截', () => {
  const root = makeRoot();
  try {
    const nav = readJson(path.join(root, 'data/navlinks.json'));
    nav.items[0].cardDesc = 'x'.repeat(61);
    writeJson(root, 'data/navlinks.json', nav);
    const v = validateRepo(root);
    const navResult = v.results.find((r) => r.file === 'data/navlinks.json');
    assert.equal(v.ok, false);
    assert.ok(navResult.errors.some((e) => e.includes('maxLength')));
  } finally { cleanup(root); }
});

test('urlKey: 归因参数不入键、www 归一、路径保序', () => {
  assert.equal(urlKey('https://WWW.Example.com/a/b?utm_source=x&id=7'), 'example.com/a/b?id=7');
  assert.equal(urlKey('https://example.com/a/b?id=7&utm_medium=y'), urlKey('https://example.com/a/b?utm_source=z&id=7'));
  assert.notEqual(urlKey('https://example.com/a'), urlKey('https://example.com/b'));
});

test('domainOf: 去 www 取主域', () => {
  assert.equal(domainOf('https://www.10086.cn/a'), '10086.cn');
  assert.equal(domainOf('not a url'), '');
});

test('cosineSimilarity: 相同文本为 1，无关文本低', () => {
  assert.ok(Math.abs(cosineSimilarity('流量卡资费对比', '流量卡资费对比') - 1) < 1e-9);
  assert.ok(cosineSimilarity('流量卡资费', '菜谱大全做法') < 0.3);
});

test('extractNumbers: 提取含小数的数字', () => {
  assert.deepEqual(extractNumbers('月租29.9元含100GB'), ['29.9', '100']);
});

test('sha256 稳定、seededRandom 可复现', () => {
  assert.equal(sha256({ b: 2, a: 1 }), sha256({ a: 1, b: 2 }));
  const a = seededRandom('seed'); const b = seededRandom('seed');
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});
