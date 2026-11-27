// 移动端适配护栏：防止后续改样式时丢失关键适配规则（iOS 缩放 / 触摸目标 / 锚点 / 溢出 / 小屏断点）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helper.js';

const css = fs.readFileSync(path.join(REPO, 'templates/assets/site.css'), 'utf8');

test('移动端：viewport meta 已声明（由 render.layout 注入）', () => {
  const render = fs.readFileSync(path.join(REPO, 'scripts/lib/render.js'), 'utf8');
  assert.ok(render.includes('name="viewport" content="width=device-width, initial-scale=1"'));
});

test('移动端：禁止 iOS 自动放大字号，搜索框字号 >=16px', () => {
  assert.match(css, /-webkit-text-size-adjust:\s*100%/);
  const input = css.match(/\.search input\s*\{[^}]*\}/);
  assert.ok(input, '缺 .search input 规则');
  const size = input[0].match(/font-size:\s*([\d.]+)px/);
  assert.ok(size && Number(size[1]) >= 16, `搜索框字号须 >=16px（当前 ${size?.[1]}）`);
});

test('移动端：触摸目标 >=44px（搜索按钮、分类链接）', () => {
  for (const sel of ['.search button', '.catbar a']) {
    const block = css.match(new RegExp(`${sel.replace('.', '\\.')}\\s*\\{[^}]*\\}`));
    assert.ok(block, `缺 ${sel} 规则`);
    assert.match(block[0], /min-height:\s*44px/, `${sel} 触摸目标须 >=44px`);
  }
});

test('移动端：分类栏单行横向滑动，分类项不压缩不换行', () => {
  const wrap = css.match(/\.catbar\s+\.wrap\s*\{[^}]*\}/);
  assert.ok(wrap, '缺 .catbar .wrap 规则');
  assert.match(wrap[0], /flex-wrap:\s*nowrap/, '分类栏须单行不换行');
  assert.match(wrap[0], /overflow-x:\s*auto/, '分类栏须支持横向滚动');
  const link = css.match(/\.catbar\s+a\s*\{[^}]*\}/);
  assert.ok(link, '缺 .catbar a 规则');
  assert.match(link[0], /flex:\s*0\s+0\s+auto/, '分类项须禁止 flex 压缩');
  assert.match(link[0], /white-space:\s*nowrap/, '分类名须不换行');
});

test('移动端：分类栏左右各有可点击横滑按钮，并有留位与隐藏态', () => {
  assert.match(css, /\.catbar-prev,\s*\.catbar-next\s*\{[^}]*cursor:\s*pointer/, '两个按钮须可点击');
  assert.match(css, /\.catbar-prev\[hidden\],\s*\.catbar-next\[hidden\]\s*\{[^}]*display:\s*none/, '两按钮隐藏态须生效');
  assert.match(css, /\.catbar-prev\s*\{[^}]*left:/, '左按钮须贴左');
  assert.match(css, /\.catbar-next\s*\{[^}]*right:/, '右按钮须贴右');
  const wraps = [...css.matchAll(/\.catbar\s+\.wrap\s*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(wraps.some((b) => /padding-left:\s*\d+px/.test(b) && /padding-right:\s*\d+px/.test(b)), '滚动容器须左右留位');
});

test('移动端：分类栏双按钮绑定双向平滑滚动与各自显隐', () => {
  const render = fs.readFileSync(path.join(REPO, 'scripts/lib/render.js'), 'utf8');
  for (const cls of ['catbar-prev', 'catbar-next']) {
    assert.match(render, new RegExp('class="' + cls + '"[^>]*aria-label'), `${cls} 须带无障碍标签`);
  }
  assert.equal((render.match(/addEventListener\('click'/g) || []).length, 2, '两个按钮各绑定一次点击');
  assert.equal((render.match(/\.scrollBy\(/g) || []).length, 2, '两个方向各有滚动调用');
  assert.match(render, /left:\s*-step\(\)/, '左按钮须反向滚动');
  assert.match(render, /left:\s*step\(\)/, '右按钮须正向滚动');
  assert.match(render, /behavior:\s*'smooth'/, '滚动须平滑');
  assert.match(render, /prev\.hidden\s*=\s*box\.scrollLeft\s*<=\s*2/, '左侧有隐藏内容时显示左箭头');
  assert.match(render, /next\.hidden\s*=/, '右侧显隐须由脚本控制');
});

test('移动端：锚点偏移变量化并在小屏断点覆盖', () => {
  assert.match(css, /--anchor-offset:/);
  assert.match(css, /scroll-margin-top:\s*var\(--anchor-offset\)/);
  const smallBlocks = [...css.matchAll(/@media\s*\(max-width:\s*700px\)\s*\{[\s\S]*?\n\}/g)].map((m) => m[0]);
  assert.ok(smallBlocks.some((b) => b.includes('--anchor-offset:')), '700px 断点须覆盖锚点偏移');
});

test('移动端：长文本溢出保护 + hover 效果限定真指针设备', () => {
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /@media\s*\(hover:\s*hover\)/);
});

test('移动端：网格与页脚在小屏收为单列，且 380px 极窄屏有额外收紧', () => {
  assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*?grid-template-columns:\s*1fr/);
  assert.match(css, /@media\s*\(max-width:\s*700px\)[\s\S]*?footer-grid[\s\S]*?1fr/);
  assert.match(css, /@media\s*\(max-width:\s*380px\)/);
});
