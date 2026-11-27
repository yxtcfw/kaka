#!/usr/bin/env node
// 统一 CLI：所有脚本的唯一入口。参数 --root 指定仓库根（测试半沙箱），--dry-run 零写盘。
import { parseArgs } from './lib/util.js';
import { validateRepo, ROOT } from './lib/validate.js';
import { runBootstrap } from './bootstrap.js';
import { runHarvest } from './harvest.js';
import { runGrowTree } from './grow-tree.js';
import { runTreeOverdue } from './tree-overdue.js';
import { buildCuratedTree } from './curate-tree.js';
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
import { runDriftCheck } from './drift-check.js';
import { runGuardCheck } from './guard-check.js';
import { runSyncApiNav } from './sync-api-nav.js';
import { runSyncProductDetails } from './sync-product-details.js';
import { runMaintenance } from './maintenance.js';
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
    case 'harvest': print('harvest', await runHarvest(root, args)); break;
    case 'grow-tree': print('grow-tree', await runGrowTree(root, args)); break;
    case 'tree-overdue': print('tree-overdue', await runTreeOverdue(root, args)); break;
    case 'curate-tree': print('curate-tree', buildCuratedTree(root, args)); break;
    case 'discover': print('discover', await runDiscover(root, args)); break;
    case 'fetch-body': print('fetch-body', await runFetchBody(root, args)); break;
    case 'collect-sources': print('collect-sources', await runCollectSources(root, args)); break;
    case 'write': print('write', await runWriteContent(root, args)); break;
    case 'fill-site': print('fill-site', runFillSite(root, args)); break;
    case 'nav-pages': print('nav-pages', await runBuildNavPages(root, args)); break;
    case 'build': print('build', runBuild(root, args)); break;
    case 'metrics': print('metrics', await runFetchMetrics(root, args)); break;
    case 'prune': print('prune', runPrune(root, args)); break;
    case 'drift-check': print('drift-check', runDriftCheck(root, args)); break;
    case 'guard-check': print('guard-check', await runGuardCheck(root, args)); break;
    case 'sync-api-nav': print('sync-api-nav', await runSyncApiNav(root, args)); break;
    case 'sync-product-details': print('sync-product-details', await runSyncProductDetails(root, args)); break;
    case 'maintenance': print('maintenance', await runMaintenance(root, args)); break;
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
      const h1 = await runHarvest(root, o);
      const h2 = await runHarvest(root, o); // 第二轮收敛，判据①达标
      // 建树不进每日链：每日只采集/维护/创作/构建；建树由周任务承担。
      const discover = await runDiscover(root, { ...o, limit: Number(args.limit || 10) });
      const body = await runFetchBody(root, o);
      const write = await runWriteContent(root, o);
      // API 商品 → nav 必须先于详情信源采集（详情依赖 nav 里的 productId/promoUrl）。
      // 接口失败时 sync-api-nav 返回 degraded，不抛错、不中断后续链路。
      const apiNav = await runSyncApiNav(root, o);
      const details = await runSyncProductDetails(root, o);
      // 周期维护在详情信源入库后、页面创作前跑：被页面引用的信源受保护，不会被清理。
      const maintenance = await runMaintenance(root, o);
      const fill = runFillSite(root, o);
      const nav = await runBuildNavPages(root, o);
      const build = runBuild(root, o);
      // 回流采集在构建后：可用 --provider bing / --site-url 手动指定，默认按 manifest。
      const metrics = await runFetchMetrics(root, {
        ...o, provider: args.provider, siteUrl: args.siteUrl, fetchFn: args.fetchFn
      });
      const drift = runDriftCheck(root, o);
      // 兜底：周任务漏跑/失败导致超期时，在这里补跑一次建树（仍受阈值门槛）。
      const overdue = await runTreeOverdue(root, o);
      print('pipeline', { bootstrap, harvest: [h1.passed, h2.passed], overdue: { action: overdue.action, alert: overdue.alert }, discover: discover.candidates, body: body.sourcesPassed, write: write.contentPassed, apiNav: apiNav.skipped === true ? { disabled: true } : { added: apiNav.added, duplicate: apiNav.skipped?.duplicate, degraded: apiNav.degraded }, details: { created: details.created, updated: details.updated, failed: details.failed }, maintenance: { removedSources: maintenance.removedSources.length, removedNodes: maintenance.removedNodes.length, rechecked: maintenance.recheck.checked }, fill: { filled: fill.filled, skipped: fill.skipped }, nav: { built: nav.built, skipped: nav.skipped, downgraded: nav.downgraded }, build: build.pages, metrics: { provider: metrics.provider, rows: metrics.rows, degraded: !!metrics.degraded }, drift: { alertCount: drift.alertCount, critical: drift.critical.length } });
      break;
    }
    case 'help':
    default:
      console.log('用法: node scripts/cli.js <command> [--root DIR] [--dry-run] [options]');
      console.log('命令: validate bootstrap harvest grow-tree tree-overdue curate-tree discover fetch-body collect-sources sync-api-nav sync-product-details maintenance write fill-site nav-pages build metrics prune drift-check guard-check report rollback reset pipeline');
      console.log('示例: npm run validate && npm run pipeline -- --apply');
  }
}

main().catch((e) => {
  console.error('[error]', e.message);
  process.exitCode = 1;
});
