// 四状态修剪：基于回流数据把内容节点标记为 active/watch/stale/prune，产出 unmatched 报告。
// 只出提案/报告，不直接删除 data/ 里的正文（人工确认后再执行），符合「事后审计」。
import path from 'node:path';
import fs from 'node:fs';
import { readJson, writeJson, ROOT } from './lib/validate.js';

export function runPrune(root = ROOT, args = {}) {
  let metrics = { rows: [] };
  try { metrics = readJson(path.join(root, 'data/metrics/latest.json')); } catch { /* 无回流数据 */ }
  const rowByPage = new Map(metrics.rows.map((r) => [r.page, r]));

  let articles = [];
  try { articles = readJson(path.join(root, 'data/articles.json')).articles || []; } catch { /* ignore */ }
  const nav = readJson(path.join(root, 'data/navlinks.json'));

  const decisions = [];
  const unmatched = [];
  for (const a of articles) {
    const page = `/blog/${a.id}.html`;
    const m = rowByPage.get(page);
    let state = 'unmatched';
    if (m && m.impressions > 100 && m.clicks > 5) state = 'active';
    else if (m && m.impressions > 20) state = 'watch';
    else if (m) state = 'stale';
    decisions.push({ id: a.id, page, state, metrics: m || null });
    if (state === 'unmatched') unmatched.push(page);
  }
  for (const n of nav.items) {
    const page = `/nav/${n.navId}.html`;
    const m = rowByPage.get(page);
    if (!m) unmatched.push(page);
  }

  const counts = decisions.reduce((acc, d) => { acc[d.state] = (acc[d.state] || 0) + 1; return acc; }, {});
  const report = { stage: 'prune', counts, decisions, unmatched, note: '仅提案，不直接删除；人工确认后处理' };
  if (!args.dryRun) {
    writeJson(path.join(root, 'reports', 'prune.json'), report);
  }
  return report;
}
