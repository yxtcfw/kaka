// 合规页生成：只渲染 config/compliance.json 里已确认的文案；pending 项只写报告，不上屏。
import path from 'node:path';
import fs from 'node:fs';
import { readJson, ROOT } from './lib/validate.js';
import { atomicWriteJson } from './lib/util.js';
import { esc, layout, slugify } from './lib/render.js';
import { loadSeoConfig, cleanText, makeDescription } from './lib/seo.js';
import { loadStructuredConfig, ogTags } from './lib/structured-data.js';

export function loadComplianceConfig(root) {
  let cfg;
  try { cfg = readJson(path.join(root, 'config/compliance.json')); } catch { cfg = {}; }
  return { enabled: cfg.enabled !== false, footerLinks: cfg.footerLinks || [], pages: cfg.pages || {}, pendingHuman: cfg.pendingHuman || [] };
}

export function runCompliancePages(root = ROOT, args = {}) {
  const cfg = loadComplianceConfig(root);
  if (!cfg.enabled) return { stage: 'compliance', disabled: true };
  const site = readJson(path.join(root, 'data/site.json'));
  const manifest = readJson(path.join(root, 'config/manifest.json'));
  const seo = loadSeoConfig(root);
  const base = `https://${manifest.domain}`;
  const outDir = args.out || '_site';
  const pages = [];
  const urls = [];
  for (const [key, p] of Object.entries(cfg.pages)) {
    const slug = slugify(p.slug || key);
    const body = `<h1>${esc(p.title || key)}</h1>
<nav class="breadcrumb"><a href="/">首页</a> · ${esc(p.title || key)}</nav>
<div class="intro"><p>${esc(p.intro || '')}</p></div>
${(p.sections || []).map((s) => `<section id="${esc(slugify(s.h2 || ''))}"><h2>${esc(s.h2 || '')}</h2><p class="body-text">${esc(s.body || '')}</p></section>`).join('\n')}
<p class="back-to-apply"><a href="/">← 返回首页</a></p>`;
    const url = `${base}/${slug}.html`;
    if (!args.dryRun) {
      const file = path.join(root, outDir, `${slug}.html`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const desc = makeDescription(seo, seo.pages.home, { site: { intro: p.intro || '' } }, p.title || key);
      fs.writeFileSync(file, layout(site, manifest, p.title || key, body, {
        canonical: url,
        description: desc,
        og: ogTags(loadStructuredConfig(root), site, url, p.title || key, desc)
      }), 'utf8');
    }
    pages.push({ key, slug, url });
    urls.push(url);
  }
  const report = {
    stage: 'compliance',
    generated: pages.length,
    pages,
    urls,
    pendingHuman: cfg.pendingHuman,
    dryRun: !!args.dryRun
  };
  if (!args.dryRun) atomicWriteJson(path.join(root, 'reports/compliance.json'), report);
  return report;
}
