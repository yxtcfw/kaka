// 专题页：从已有的 nav-details 正文里抽取客观字段，聚合成可索引的长尾专题页。
// 纯聚合、零造数；换主题只改 config/topics.json 的关键词和标题。
import path from 'node:path';
import fs from 'node:fs';
import { readJson, ROOT } from './lib/validate.js';
import { atomicWriteJson } from './lib/util.js';
import { esc, layout, slugify } from './lib/render.js';
import { loadSeoConfig, cleanText, renderText, makeDescription } from './lib/seo.js';
import { loadStructuredConfig, ogTags } from './lib/structured-data.js';

const DEFAULT = {
  schema: 'topics/v1',
  enabled: true,
  topics: []
};

export function loadTopicConfig(root) {
  let cfg;
  try { cfg = readJson(path.join(root, 'config/topics.json')); } catch { cfg = {}; }
  return { ...DEFAULT, ...cfg, topics: cfg.topics || [] };
}

// 从一段正文里取匹配关键词所在句子（不改写、不推断）。
function sentencesWith(text, keywords) {
  const out = [];
  for (const part of String(text || '').split(/[。\n]/)) {
    const s = part.trim();
    if (s && keywords.some((k) => s.includes(k))) out.push(s);
  }
  return out;
}

export function runTopicPages(root = ROOT, args = {}) {
  const cfg = loadTopicConfig(root);
  if (cfg.enabled === false) return { stage: 'topic-pages', disabled: true };
  const site = readJson(path.join(root, 'data/site.json'));
  const manifest = readJson(path.join(root, 'config/manifest.json'));
  const details = readJson(path.join(root, 'data/nav-details.json')).pages || [];
  const seo = loadSeoConfig(root);
  const base = `https://${manifest.domain}`;
  const out = [];
  const urls = [];

  for (const topic of cfg.topics) {
    const blocks = [];
    for (const p of details) {
      const segments = Array.isArray(p.intro) ? p.intro : [];
      const hits = [];
      for (const seg of segments) {
        const text = sentencesWith(seg.text || '', topic.keywords || []);
        // 详情原句可能带 src-api-XXXX 等内部标记，上屏前必须过同一套清洗规则。
        if (text.length) hits.push({
          title: cleanText(seg.title || '', seo.textHygiene),
          text: cleanText(text.join('。'), seo.textHygiene)
        });
      }
      if (hits.length) {
        blocks.push({ navId: p.navId, title: cleanText(p.title || '', seo.textHygiene), hits });
      }
    }
    if (!blocks.length) continue; // 空专题不生成空壳页
    const body = `<h1>${esc(renderText(topic.h1 || '{title}', { title: topic.title || '' }))}</h1>
<div class="intro"><p>${esc(topic.intro || '依据本站已核对的官方详情整理，具体以运营商实时页面为准。')}</p></div>
<nav class="subnav"><a href="/">首页</a><a href="/blog/">文章</a></nav>
${blocks.map((b) => `<section id="${esc(slugify(b.navId))}">
<div class="section-head"><h2>${esc(b.title)}</h2></div>
${b.hits.map((h) => `<div class="topic-hit">${h.title ? `<strong>${esc(h.title)}</strong>` : ''}<p>${esc(h.text)}。</p></div>`).join('')}
</section>`).join('\n')}`;
    const rel = `${args.out || '_site'}/${slugify(topic.slug || topic.title)}.html`;
    const abs = path.join(root, rel);
    const url = `${base}/${slugify(topic.slug || topic.title)}.html`;
    const desc = makeDescription(seo, seo.pages.home, { site: { intro: topic.description || topic.intro || '' } }, topic.title || '专题');
    if (!args.dryRun) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, layout(site, manifest, topic.title || '专题', body, {
        canonical: url,
        description: desc,
        og: ogTags(loadStructuredConfig(root), site, url, topic.title || '专题', desc)
      }), 'utf8');
    }
    out.push({ slug: slugify(topic.slug || topic.title), title: topic.title, entries: blocks.length });
    urls.push(url);
  }
  const report = { stage: 'topic-pages', generated: out.length, topics: out, urls, dryRun: !!args.dryRun };
  if (!args.dryRun) atomicWriteJson(path.join(root, 'reports/topic-pages.json'), report);
  return report;
}
