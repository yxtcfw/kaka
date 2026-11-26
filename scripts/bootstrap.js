// v7 启动器：种子词 + 域名 + Secrets → 自动补 manifest/tree/rules/前端初稿 → 可 build 站点。
// 人工只给三样：seeds.json、域名（--domain）、密钥（env/Secrets，永不落文件）。
// 站点信息空字段留给首次构建 fill-site（§1.4B），这里只出初稿、不覆盖已有配置。
import path from 'node:path';
import fs from 'node:fs';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { makeSnapshots } from './lib/snapshot.js';
import { llmStatus } from './lib/llm.js';

// 从种子词推断垂直分类（简单启发式：取首个种子词作为垂直类）。
function inferVertical(seeds) {
  return seeds[0] || '综合';
}

export function runBootstrap(root = ROOT, args = {}) {
  const seedsDoc = readJson(path.join(root, 'seeds.json'));
  const domain = args.domain || readJson(path.join(root, 'config/manifest.json')).domain;
  const vertical = inferVertical(seedsDoc.seeds);
  const manifestPath = path.join(root, 'config/manifest.json');
  const manifest = readJson(manifestPath);

  // 已有值不覆盖：只补 domain/vertical 空值（bootstrap 只首次写初稿）
  const before = JSON.stringify(manifest);
  if (!manifest.domain || manifest.domain === 'example.com') manifest.domain = domain;
  if (!manifest.vertical) manifest.vertical = vertical;
  // 三样输入中的 provider 从 env 推断（密钥只作可用性判断，不写值）
  const llm = llmStatus(manifest.providers?.llm || 'mock');
  const llmProvider = llm.available ? manifest.providers.llm : 'mock';

  const plan = {
    stage: 'bootstrap', domain, vertical, seeds: seedsDoc.seeds,
    llm: { requested: manifest.providers?.llm, effective: llmProvider, available: llm.available },
    willWrite: {
      'config/manifest.json': { domain: manifest.domain, vertical: manifest.vertical, llmProvider },
      'data/site.json': '空字段保留给首次构建 fill-site（不在此覆盖）',
      'data/tree.json': '初始节点保留，grow-tree 按判据①扩展'
    },
    changed: before !== JSON.stringify(manifest)
  };

  if (!args.dryRun) {
    makeSnapshots(root, `before-bootstrap-${Date.now()}`);
    writeJson(manifestPath, manifest);
    writeJson(path.join(root, 'reports', 'bootstrap.json'), plan);
  }
  return plan;
}
