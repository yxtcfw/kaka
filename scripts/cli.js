#!/usr/bin/env node
// 统一 CLI：所有脚本的唯一入口。参数 --root 指定仓库根（测试半沙箱），--dry-run 零写盘。
import { parseArgs } from './lib/util.js';
import { validateRepo, ROOT } from './lib/validate.js';
import { runBootstrap } from './bootstrap.js';
import { runHarvest } from './harvest.js';
import { runGrowTree } from './grow-tree.js';
import { runDiscover } from './discover-sources.js';
import { runFetchBody } from './fetch-body.js';
import { runCollectSources } from './collect-sources.js';
import { runWriteContent } from './write-content.js';
import { runFillSite } from './fill-site.js';
import { runBuildNavPages } from './build-nav-pages.js';
import { runBuild } from './build.js';
import { runFetchMetrics } from './fetch-metrics.js';
import { runPrune } from './prune.js';
import { runReport } from './report.js';
import { runRollback } from './rollback.js';
import { runResetSite } from './reset-site.js';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const args = parseArgs(argv.slice(1));
const root = args.root ? pathResolve(args.root) : ROOT;

function pathResolve(p) {
  return p.startsWith('/') ? p : new URL(`file://${process.cwd()}/${p}`).pathname;
}

function print(label, obj) {
  console.log(`[${label}]`, JSON.stringify(obj, null, 2));
}

async function main() {
  switch (cmd) {
    case 'validate': {
      const v = validateRepo(root);
      for (const r of v.results) {
        console.log(`${r.errors.length ? 'FAIL' : 'OK  '} ${r.file}${r.errors.length ? ' :: ' + r.errors.join(' | ') : ''}`);
      }
      print('validate', { ok: v.ok });
      process.exitCode = v.ok ? 0 : 1;
      break;
    }
    case 'bootstrap': print('bootstrap', runBootstrap(root, args)); break;
    case 'harvest': print('harvest', runHarvest(root, args)); break;
    case 'grow-tree': print('grow-tree', runGrowTree(root, args)); break;
    case 'discover': print('discover', await runDiscover(root, args)); break;
    case 'fetch-body': print('fetch-body', await runFetchBody(root, args)); break;
    case 'collect-sources': print('collect-sources', await runCollectSources(root, args)); break;
    case 'write': print('write', runWriteContent(root, args)); break;
    case 'fill-site': print('fill-site', runFillSite(root, args)); break;
    case 'nav-pages': print('nav-pages', runBuildNavPages(root, args)); break;
    case 'build': print('build', runBuild(root, args)); break;
    case 'metrics': print('metrics', runFetchMetrics(root, args)); break;
    case 'prune': print('prune', runPrune(root, args)); break;
    case 'report': {
      const r = runReport(root, args);
      delete r.markdown;
      print('report', r);
      break;
    }
    case 'rollback': print('rollback', runRollback(root, args)); break;
    case 'reset': print('reset', runResetSite(root, args)); break;
    case 'pipeline': {
      const dry = !!args.dryRun;
      const o = { dryRun: dry };
      const bootstrap = runBootstrap(root, o);
      const h1 = runHarvest(root, o);
      const h2 = runHarvest(root, o); // 第二轮收敛，判据①达标
      const grow = runGrowTree(root, o);
      const discover = await runDiscover(root, { ...o, limit: Number(args.limit || 10) });
      const body = await runFetchBody(root, o);
      const write = runWriteContent(root, o);
      const fill = runFillSite(root, o);
      const nav = runBuildNavPages(root, o);
      const build = runBuild(root, o);
      print('pipeline', { bootstrap, harvest: [h1.passed, h2.passed], grow: grow.idempotent, discover: discover.candidates, body: body.sourcesPassed, write: write.contentPassed, fill: { filled: fill.filled, skipped: fill.skipped }, nav: { built: nav.built, downgraded: nav.downgraded }, build: build.pages });
      break;
    }
    case 'help':
    default:
      console.log('用法: node scripts/cli.js <command> [--root DIR] [--dry-run] [options]');
      console.log('命令: validate bootstrap harvest grow-tree discover fetch-body collect-sources write fill-site nav-pages build metrics prune report rollback reset pipeline');
      console.log('示例: npm run validate && npm run pipeline -- --apply');
  }
}

main().catch((e) => {
  console.error('[error]', e.message);
  process.exitCode = 1;
});
