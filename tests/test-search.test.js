// 站内搜索护栏：实时过滤、分词 AND、空分类隐藏、无结果提示、?q= 初始加载。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helper.js';

const render = fs.readFileSync(path.join(REPO, 'scripts/lib/render.js'), 'utf8');
const css = fs.readFileSync(path.join(REPO, 'templates/assets/site.css'), 'utf8');
const build = fs.readFileSync(path.join(REPO, 'scripts/build.js'), 'utf8');

test('搜索：卡片带 data-search 索引，覆盖全部客观规格字段', () => {
  assert.match(build, /data-search="\$\{esc\(searchText\)\}"/, '卡片须输出搜索索引');
  assert.match(build, /Object\.values\(specs\)/, '索引须覆盖全部规格字段');
  assert.match(build, /\[n\.title, n\.cardDesc, n\.description, n\.category, n\.isp/, '索引须含标题/描述/分类/运营商');
});

test('搜索：输入实时过滤，多词同时匹配，隐藏不匹配卡片与空分类', () => {
  assert.match(render, /input\.addEventListener\('input'/, '输入即过滤');
  assert.match(render, /terms\.every\(/, '多词须同时匹配');
  assert.match(render, /card\.hidden = !hit/, '不匹配卡片须隐藏');
  assert.match(render, /sec\.hidden =/, '空分类须隐藏');
  assert.match(render, /notice\.hidden =/, '无结果提示须受控');
});

test('搜索：?q= 初始加载，提交不刷新页面且同步 URL', () => {
  assert.match(render, /URLSearchParams\(window\.location\.search\)\.get\('q'\)/, '须读取 URL q 参数');
  assert.match(render, /form\.addEventListener\('submit'/, '须拦截表单提交');
  assert.match(render, /e\.preventDefault\(\)/, '不得刷新页面');
  assert.match(render, /history\.replaceState/, '须同步 URL 便于分享');
});

test('搜索：隐藏卡片/空分类与无结果提示均有样式', () => {
  assert.match(css, /\.card\[hidden\][^}]*display:\s*none/, '卡片隐藏须生效（覆盖 display:flex）');
  assert.match(css, /section\[hidden\][^}]*display:\s*none/, '空分类隐藏须生效');
  assert.match(css, /\.search-empty\s*\{/, '须有无结果提示样式');
});

test('搜索与筛选共用单一渲染函数，互不覆盖状态', () => {
  // 合并后只有一个 render 定义，input 与筛选按钮都调用它；不再有独立的 apply()/run()。
  assert.match(render, /function render\(\)/, '须有单一渲染函数');
  assert.match(render, /input\.addEventListener\('input', render\)/, '搜索走统一渲染');
  assert.match(render, /render\(\);\s*\}\);/, '筛选点击后走统一渲染');
  assert.doesNotMatch(render, /function apply\(/, '旧搜索专用渲染须移除');
  assert.doesNotMatch(render, /function run\(/, '旧筛选专用渲染须移除');
  // 属性名对齐：配置 field=band/isp/category，卡片输出 data-* 同名。
  assert.match(build, /data-band="/, '卡片须有 data-band');
  assert.match(build, /data-isp="/, '卡片须有 data-isp');
  assert.match(build, /data-category="/, '卡片须有 data-category');
  const present = fs.readFileSync(path.join(REPO, 'config/presentation.json'), 'utf8');
  assert.ok(!/"field": "priceBand"/.test(present), '筛选字段不得再用 priceBand（与卡片属性不匹配）');
});
