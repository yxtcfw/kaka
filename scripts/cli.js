#!/usr/bin/env node
// 统一 CLI：所有脚本的唯一入口。参数 --root 指定仓库根（测试半沙箱），--dry-run 零写盘。
import path from 'node:path';
import { parseArgs } from './lib/util.js';
import { validateRepo, ROOT, readJson } from './lib/validate.js';
import { loadDataQualityRules, checkAll } from './lib/data-quality.js';
import { runQualityFix } from './quality-fix.js';
import { runOfficialSourcesImport } from './import-official-sources.js';
import { runNavRepair } from './nav-repair.js';
import { runTopicPages } from './topic-pages.js';
import { runCompliancePages } from './compliance-pages.js';
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
import { runStatus } from './status.js';
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
      // 数据可信门禁：只报告存量矛盾，不阻断 validate（存量修正走 data-quality 子命令）。
      try {
        const rules = loadDataQualityRules(root);
        if (rules.reportOnValidate !== false) {
          const nav = readJson(path.join(root, 'data/navlinks.json'));
          const q = checkAll(nav.items || [], rules);
          console.log(`[data-quality] checked=${q.checked} passed=${q.passed} fixable=${q.fixable} needsHuman=${q.needsHuman}`);
        }
      } catch { /* 存量数据缺失时跳过报告，不影响 schema 校验 */ }
      process.exitCode = v.ok ? 0 : 1;
      break;
    }
    case 'data-quality-fix': {
      const r = runQualityFix(root, { dryRun: !!args.dryRun });
      if (args.out) {
        const outPath = args.out.startsWith('/') ? args.out : path.join(root, args.out);
        const { writeJson } = await import('./lib/validate.js');
        writeJson(outPath, r);
        console.log(`[data-quality-fix] wrote ${outPath}`);
      } else {
        print('data-quality-fix', { ...r, modified: r.modified.slice(0, 10), needsHuman: r.needsHuman.slice(0, 10) });
      }
      break;
    }
    case 'data-quality': {
      const rules = loadDataQualityRules(root);
      const nav = readJson(path.join(root, 'data/navlinks.json'));
      const report = checkAll(nav.items || [], rules);
      if (args.out) {
        const outPath = args.out.startsWith('/') ? args.out : path.join(root, args.out);
        const { writeJson } = await import('./lib/validate.js');
        writeJson(outPath, report);
        console.log(`[data-quality] wrote ${outPath}`);
      } else {
        print('data-quality', { ...report, rows: report.rows.slice(0, 10) });
      }
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
    case 'import-official': print('import-official', runOfficialSourcesImport(root, args)); break;
    case 'nav-repair': print('nav-repair', runNavRepair(root, args)); break;
    case 'write': print('write', await runWriteContent(root, args)); break;
    case 'fill-site': print('fill-site', runFillSite(root, args)); break;
    case 'nav-pages': print('nav-pages', await runBuildNavPages(root, args)); break;
    case 'build': {
      const b = runBuild(root, args);
      const topics = await runTopicPages(root, { ...args, out: args.out || '_site' });
      const compliance = runCompliancePages(root, { ...args, out: args.out || '_site' });
      const extraUrls = [...(topics.urls || []), ...(compliance.urls || [])];
      if (!args.dryRun) {
        // 专题页 URL 补进 sitemap，避免生成了但搜不到。
        const fsMod = await import('node:fs');
        const smPath = path.join(root, args.out || '_site', 'sitemap.xml');
        if (fsMod.existsSync(smPath) && extraUrls.length) {
          const xml = fsMod.readFileSync(smPath, 'utf8').replace('</urlset>',
            extraUrls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n') + '\n</urlset>');
          fsMod.writeFileSync(smPath, xml);
          const reportPath = path.join(root, 'reports/build.json');
          const report = JSON.parse(fsMod.readFileSync(reportPath, 'utf8'));
          report.urls.push(...topics.urls);
          report.pages = report.urls.length;
          fsMod.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
        }
      }
      print('build', { ...b, pages: b.pages + extraUrls.length, topicPages: topics.generated || 0, compliancePages: compliance.generated || 0 });
      break;
    }
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
    case 'status': {
      const r = runStatus(root, args);
      delete r.status;
      print('status', r);
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
      // 修剪提案：回流为空时下结论无意义，prune 自身会输出 no-data。
      const prune = runPrune(root, o);
      const drift = runDriftCheck(root, o);
      // 兜底：周任务漏跑/失败导致超期时，在这里补跑一次建树（仍受阈值门槛）。
      const overdue = await runTreeOverdue(root, o);
      print('pipeline', { bootstrap, harvest: [h1.passed, h2.passed], overdue: { action: overdue.action, alert: overdue.alert }, discover: discover.candidates, body: body.sourcesPassed, write: write.contentPassed, apiNav: apiNav.skipped === true ? { disabled: true } : { added: apiNav.added, duplicate: apiNav.skipped?.duplicate, degraded: apiNav.degraded, qualityRejected: apiNav.quality?.rejected || 0, qualityFixed: apiNav.quality?.fixed || 0 }, details: { created: details.created, updated: details.updated, failed: details.failed }, maintenance: { removedSources: maintenance.removedSources.length, removedNodes: maintenance.removedNodes.length, rechecked: maintenance.recheck.checked }, fill: { filled: fill.filled, skipped: fill.skipped }, nav: { built: nav.built, skipped: nav.skipped, downgraded: nav.downgraded }, build: build.pages, metrics: { provider: metrics.provider, rows: metrics.rows, degraded: !!metrics.degraded }, prune: { status: prune.status, treeProposals: prune.treeProposals.length }, drift: { alertCount: drift.alertCount, critical: drift.critical.length } });
      break;
    }
    case 'help':
    default:
      console.log('用法: node scripts/cli.js <command> [--root DIR] [--dry-run] [options]');
      console.log('命令: validate data-quality data-quality-fix import-official nav-repair bootstrap harvest grow-tree tree-overdue curate-tree discover fetch-body collect-sources sync-api-nav sync-product-details maintenance write fill-site nav-pages build metrics prune drift-check guard-check report status rollback reset pipeline');
      console.log('示例: npm run validate && npm run pipeline -- --apply');
  }
}

main().catch((e) => {
  console.error('[error]', e.message);
  process.exitCode = 1;
});
