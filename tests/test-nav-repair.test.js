// 导航修正：只按人工规则改展示口径，幂等、可回滚、不猜数字。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, cleanup, readJson, writeJson, REPO } from './helper.js';
import { planNavRepair, runNavRepair } from '../scripts/nav-repair.js';
import { checkItem } from '../scripts/lib/data-quality.js';

const realRules = () => JSON.parse(fs.readFileSync(path.join(REPO, 'rules/nav-repair.json'), 'utf8'));
const qualityRules = () => JSON.parse(fs.readFileSync(path.join(REPO, 'rules/data-quality.json'), 'utf8'));

function seeded(root) {
  writeJson(root, 'data/navlinks.json', {
    schema: 'navlinks/v1',
    items: [
      { navId: 'a', title: '旧标题300G', cardDesc: '旧', specs: { taocan: '300G', tyLiuliang: '200' } },
      { navId: 'b', title: '会员年卡', specs: {} }
    ]
  });
  writeJson(root, 'data/nav-details.json', {
    schema: 'nav-details/v1',
    pages: [
      { navId: 'a', title: '旧标题300G', intro: [{ title: '套餐包含什么', text: '旧正文' }] },
      { navId: 'b', title: '会员年卡', intro: [] }
    ]
  });
}

test('planNavRepair：按规则改标题/明细并同步详情标题', () => {
  const root = makeRoot();
  try {
    seeded(root);
    const rules = {
      actions: [{ navId: 'a', title: '新标题200G通用', cardDesc: '新文案', setSpecs: { taocan: '200G通用', tyLiuliang: '200' }, detailIntro: '新正文' }]
    };
    const r = planNavRepair(rules, readJson(root, 'data/navlinks.json'), readJson(root, 'data/nav-details.json'));
    const item = r.nav.items[0];
    assert.equal(item.title, '新标题200G通用');
    assert.equal(item.specs.taocan, '200G通用');
    assert.equal(r.detail.pages[0].title, '新标题200G通用');
    assert.equal(r.detail.pages[0].intro[0].text, '新正文');
    assert.equal(planNavRepair(rules, r.nav, r.detail).actions[0].action, 'noop', '二次修正是 noop');
  } finally { cleanup(root); }
});

test('planNavRepair：replaceSpecs 二次运行必须 noop', () => {
  const root = makeRoot();
  try {
    seeded(root);
    const rules = { actions: [{ navId: 'a', replaceSpecs: true, setSpecs: { taocan: '200G通用', nowPrice: '29' } }] };
    const first = planNavRepair(rules, readJson(root, 'data/navlinks.json'), readJson(root, 'data/nav-details.json'));
    assert.equal(first.actions[0].action, 'patch');
    const second = planNavRepair(rules, first.nav, first.detail);
    assert.equal(second.actions[0].action, 'noop', '替换规格也必须幂等');
  } finally { cleanup(root); }
});

test('planNavRepair：remove 同时移出导航与详情，未知 ID 单列不误伤', () => {
  const root = makeRoot();
  try {
    seeded(root);
    const r = planNavRepair({ actions: [{ navId: 'b', remove: true }, { navId: 'zzz', title: 'x' }] },
      readJson(root, 'data/navlinks.json'), readJson(root, 'data/nav-details.json'));
    assert.deepEqual(r.nav.items.map((x) => x.navId), ['a']);
    assert.deepEqual(r.detail.pages.map((x) => x.navId), ['a']);
    assert.deepEqual(r.unknown, ['zzz']);
  } finally { cleanup(root); }
});

test('runNavRepair：dry-run 零写盘，正式运行落盘且产出报告', () => {
  const root = makeRoot();
  try {
    seeded(root);
    fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
    writeJson(root, 'rules/nav-repair.json', { enabled: true, actions: [{ navId: 'a', title: '新标题', setSpecs: { tyLiuliang: '200' } }] });

    const dry = runNavRepair(root, { dryRun: true });
    assert.equal(dry.patched, 1);
    assert.equal(readJson(root, 'data/navlinks.json').items[0].title, '旧标题300G');

    const done = runNavRepair(root, {});
    assert.equal(done.patched, 1);
    assert.equal(readJson(root, 'data/navlinks.json').items[0].title, '新标题');
    assert.ok(done.snapshots.every(Boolean));
    assert.equal(readJson(root, 'reports/nav-repair.json').patched, 1);
  } finally { cleanup(root); }
});

test('真实规则：修正后的存量卡通过数据质量门禁', () => {
  const nav = JSON.parse(fs.readFileSync(path.join(REPO, 'data/navlinks.json'), 'utf8'));
  const rules = qualityRules();
  const bad = [];
  for (const item of nav.items) {
    const r = checkItem(item, rules);
    if (r.violations.length || r.unresolved.length) bad.push(item.navId);
  }
  assert.deepEqual(bad, [], `仍有违规卡：${bad.join(',')}`);
  assert.equal(realRules().actions.length, 15, '人工定稿规则覆盖 15 张原待修卡');
});
