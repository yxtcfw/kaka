import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helper.js';

test('ddgs 适配器：无结果时按后端列表回退，而不是直接降级', () => {
  const src = fs.readFileSync(path.join(REPO, 'adapters/ddgs_search.py'), 'utf8');
  assert.match(src, /DDGS_BACKENDS/);
  assert.match(src, /for backend in backends:/);
  assert.match(src, /if rows:\s*break/);
  assert.match(src, /no results/);
});

test('联想词策略：超时放宽到 15s，重试收敛到 1 次', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(REPO, 'rules/suggest-policy.json'), 'utf8'));
  assert.equal(policy.timeoutMs, 15000);
  assert.equal(policy.maxRetries, 1);
  const harvest = fs.readFileSync(path.join(REPO, 'scripts/harvest.js'), 'utf8');
  assert.match(harvest, /args\.maxQueries \|\| 24/);
});

test('信源发现：搜索词优先 3–14 字，避免长尾无结果', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts/discover-sources.js'), 'utf8');
  assert.match(src, /n >= 3 && n <= 14/);
  assert.match(src, /sort\(\(a, b\) => a\.length - b\.length\)/);
});
