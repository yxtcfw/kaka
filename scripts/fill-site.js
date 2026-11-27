// 首次构建填空（fill-on-first-build，一次定稿）：
//   - 人工值（非空）→ 保留，不覆盖
//   - 空值（null/"" /缺失）→ 仅首次构建按 tree+信源补齐
//   - 首次填充值 → 冻结；siteFilled=true 后永久跳过，人工清空也不自动重填
// 幂等：同 tree+源集，填出值一致。审计：字段→来源→值 写入 state 与 reports。
import path from 'node:path';
import fs from 'node:fs';
import { readJson, writeJson, ROOT } from './lib/validate.js';
import { loadState, saveState, recordRun } from './lib/state.js';
import { makeSnapshots } from './lib/snapshot.js';
import { atomicWriteJson } from './lib/util.js';

const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

// 从 tree 推断站点信息映射（v7 §1.4B 表）
function inferFields(tree, sources, manifest) {
  const rootTopic = tree.root?.topic || tree.root?.label || manifest.vertical || '垂直站';
  const rootLabel = tree.root?.label || manifest.vertical || '精选';
  const l1 = (tree.root?.children || []).map((id) => {
    const n = tree.nodes.find((x) => x.id === id);
    return n?.label || id;
  });
  const approved = sources.filter((s) => s.status === 'approved' && s.bodyExcerpt);
  const intro = approved[0]?.bodyExcerpt?.slice(0, 120) || `${rootTopic}相关资料整理与选购参考。`;

  return {
    values: {
      siteName: `${rootLabel}精选指南`,
      tagline: `${rootTopic} · 值得参考的整理`,
      vertical: manifest.vertical || rootLabel,
      topics: l1,
      navCategories: l1,
      intro,
      h1: `${rootLabel}选购指南`,
      blogTitle: `${rootLabel}文章`,
      styleTokens: {
        primary: manifest.theme?.primary || '#2563eb',
        accent: manifest.theme?.accent || '#f59e0b',
        radius: manifest.theme?.radius || '12px',
        font: manifest.theme?.font || 'system-ui, sans-serif'
      },
      license: '',
      byline: `${rootLabel}编辑部`
    },
    sources: {
      siteName: 'tree.root.label + manifest.vertical',
      tagline: 'tree.root.topic',
      vertical: 'manifest.vertical',
      topics: 'tree.root.children[]',
      navCategories: 'tree.root.children[]',
      intro: 'sources[].bodyExcerpt（approved 首条）',
      h1: 'tree.root.label + 选购指南（可由人工覆盖）',
      blogTitle: 'tree.root.label + 文章（可由人工覆盖）',
      styleTokens: 'manifest.theme（主题包默认值）',
      license: '留空，待人工确认后再填，不对外展示占位文案',
      byline: 'tree.root.label'
    }
  };
}

export function runFillSite(root = ROOT, args = {}) {
  const state = loadState(root);

  // 硬约束：siteFilled=true 后永久跳过，即使字段被人工清空也不重填
  if (state.siteFilled === true) {
    return { stage: 'fill-site', skipped: true, reason: 'siteFilled=true (已冻结，永久跳过)', filled: 0 };
  }

  const sitePath = path.join(root, 'data/site.json');
  const site = readJson(sitePath);
  const tree = readJson(path.join(root, 'data/tree.json'));
  const sources = readJson(path.join(root, 'data/sources.json')).sources;
  const manifest = readJson(path.join(root, 'config/manifest.json'));

  const inferred = inferFields(tree, sources, manifest);
  const audit = [];
  let filled = 0;

  for (const [field, value] of Object.entries(inferred.values)) {
    if (isEmpty(site[field])) {
      site[field] = value;
      filled++;
      audit.push({ field, action: 'filled', source: inferred.sources[field], value });
    } else {
      audit.push({ field, action: 'kept', value: site[field] });
    }
  }

  const report = { stage: 'fill-site', skipped: false, filled, kept: audit.filter((a) => a.action === 'kept').length, audit };

  if (!args.dryRun) {
    makeSnapshots(root, `before-fillsite-${Date.now()}`);
    atomicWriteJson(sitePath, site);
    state.siteFilled = true; // 冻结标记
    recordRun(state, { stage: 'fill-site', provider: 'deterministic', summary: `首次填空 ${filled} 字段并冻结`, inputs: { treeVersion: tree.version } });
    saveState(state, root);
    writeJson(path.join(root, 'reports', 'fill-site.json'), report);
    atomicWriteJson(path.join(root, 'state', 'site-fill-audit.json'), { at: new Date().toISOString(), audit });
  }
  return report;
}
