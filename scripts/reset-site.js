// 清空重置：保留代码/前端/规则/schema，清空运行时数据与状态，供复制建新站（v7 阶段 0.2/复制测试）。
import path from 'node:path';
import fs from 'node:fs';
import { writeJson, readJson, ROOT } from './lib/validate.js';

const RESET = {
  'data/tree.json': { schema: 'tree/v1', version: 0, root: { id: 'n0', label: '', topic: '', children: [] }, nodes: [] },
  'data/navlinks.json': { schema: 'navlinks/v1', items: [] },
  'data/sources.json': { schema: 'sources/v1', sources: [] },
  'data/site.json': { schema: 'site/v1', siteName: null, tagline: null, vertical: null, topics: [], navCategories: [], intro: null, styleTokens: null, license: null, byline: null }
};

export function runResetSite(root = ROOT, args = {}) {
  if (!args.confirm && !args.apply) {
    return { stage: 'reset', error: '需 --confirm（dry-run 预览）或 --apply（实际清空）', willReset: Object.keys(RESET) };
  }
  const cleared = [];
  if (args.apply) {
    for (const [rel, doc] of Object.entries(RESET)) {
      writeJson(path.join(root, rel), doc);
      cleared.push(rel);
    }
    // 清空运行时数据
    for (const rel of ['data/signals.json', 'data/discovered.json', 'data/articles.json', 'data/nav-details.json', 'state/site-fill-audit.json']) {
      const p = path.join(root, rel);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    // state 复位
    const seeds = readJson(path.join(root, 'seeds.json'));
    writeJson(path.join(root, 'state.json'), {
      schema: 'state/v1', siteFilled: false,
      signals: { count: 0, sources: 0, newRate: 1, passed: false },
      tree: { built: false, version: 0 },
      sources: { l1: 0, independentL2: 0, passed: false },
      content: { generated: 0, gateBlocked: 0, passed: false },
      navPages: { built: 0, downgraded: 0 }, runs: [],
      _seedHint: seeds.seeds
    });
  }
  return { stage: 'reset', applied: !!args.apply, cleared };
}
