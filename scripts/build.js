// 纯 Node 静态构建：clone 即可 build，Termux/任意平台可跑；Hugo 仅可选后端（未装则用本渲染器）。
// SEO：sitemap 显式枚举数据源（不用 collections，规避分页模板只收第一页的坑）。
import path from 'node:path';
import fs from 'node:fs';
import { readJson, ROOT } from './lib/validate.js';
import { esc, layout } from './lib/render.js';

function readSafe(file, fallback) {
  try { return readJson(file); } catch { return fallback; }
}
function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

export function runBuild(root = ROOT, args = {}) {
  const outDir = args.out || '_site';
  const manifest = readJson(path.join(root, 'config/manifest.json'));
  const site = readJson(path.join(root, 'data/site.json'));
  const nav = readJson(path.join(root, 'data/navlinks.json'));
  const navDetails = readSafe(path.join(root, 'data/nav-details.json'), { pages: [] });
  const articles = readSafe(path.join(root, 'data/articles.json'), { articles: [] }).articles;

  const base = `https://${manifest.domain}`;
  const urls = [];

  // CSS：注入 styleTokens 到 :root
  const cssSrc = fs.readFileSync(path.join(root, 'templates/assets/site.css'), 'utf8');
  const tokens = site.styleTokens || {};
  const cssVars = `:root{--primary:${esc(tokens.primary || '#2563eb')};--accent:${esc(tokens.accent || '#f59e0b')};--radius:${esc(tokens.radius || '12px')};--font:${esc(tokens.font || 'system-ui, sans-serif')};}\n`;
  writeFile(root, `${outDir}/assets/site.css`, cssVars + cssSrc);

  // 首页：nav 列表（按分类分组），有正文的详情页入口，无正文的列表直跳
  const byCat = new Map();
  for (const n of nav.items) {
    const c = n.category || '其他';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(n);
  }
  const detailByNav = new Map(navDetails.pages.map((p) => [p.navId, p]));
  const homeSections = [...byCat.entries()].map(([cat, items]) => {
    const cards = items.map((n) => {
      const out = n.promoUrl || n.url;
      const detail = detailByNav.get(n.navId);
      const anchor = detail
        ? `<a href="/nav/${slugify(n.navId)}.html">${esc(n.title)}</a>`
        : `<a href="${esc(out)}" target="_blank" rel="sponsored nofollow noopener">${esc(n.title)} ↗</a>`;
      return `<div class="card"><h3>${anchor}</h3><p>${esc(n.cardDesc || n.description || '')}</p><div class="out">${esc(n.category)}</div></div>`;
    }).join('');
    return `<section id="${esc(slugify(cat))}"><h2>${esc(cat)}</h2><div class="grid">${cards}</div></section>`;
  }).join('\n');
  const homeBody = `<div class="intro"><p>${esc(site.intro || '资料整理与选购参考。')}</p></div>${homeSections || '<p class="empty">暂无导航条目</p>'}`;
  writeFile(root, `${outDir}/index.html`, layout(site, manifest, site.siteName || manifest.vertical || '首页', homeBody));
  urls.push(`${base}/`);

  // nav 详情页（只有过闸且有正文的）
  for (const p of navDetails.pages) {
    const navItem = nav.items.find((n) => `nav-${n.navId}` === p.bundleId || n.navId === p.navId);
    const toc = `<div class="toc"><strong>目录</strong> · <a href="#intro">简介</a> · <a href="#checked">核对过的入口</a> · <a href="#note">说明</a></div>`;
    const body = `${toc}
<article class="post" id="intro">
<h1>${esc(p.title || navItem?.title || '详情')}</h1>
<p class="meta">依据已登记信源整理 · ${esc(site.byline || '')}</p>
<p>${esc((navItem?.cardDesc) || '')}</p>
<section id="checked"><h2>核对过的入口</h2><p>本页出站口已核对，点击前往原始页面。</p></section>
<section id="note"><h2>说明</h2><p>数值以官方实时页面为准；本站不编造数字。</p></section>
<a class="outbound" href="${esc(p.outbound)}" target="_blank" rel="sponsored nofollow noopener">前往查看 ↗</a>
<div class="citations">信源：${esc((navItem?.sourceIds || []).join(', '))}</div>
</article>`;
    const rel = `${outDir}/nav/${slugify(p.navId)}.html`;
    writeFile(root, rel, layout(site, manifest, p.title || navItem?.title || '详情', body));
    urls.push(`${base}/nav/${slugify(p.navId)}.html`);
  }

  // blog 文章列表 + 详情
  if (articles.length) {
    const list = articles.map((a) => `<div class="card"><h3><a href="/blog/${slugify(a.id)}.html">${esc(a.title)}</a></h3><p>${esc(a.cardDesc || '')}</p></div>`).join('');
    writeFile(root, `${outDir}/blog/index.html`, layout(site, manifest, '文章', `<section><h2>文章</h2><div class="grid">${list}</div></section>`));
    urls.push(`${base}/blog/`);
    for (const a of articles) {
      const body = `<article class="post"><h1>${esc(a.title)}</h1><p class="meta">${esc(a.generatedAt || '')} · ${esc(site.byline || '')}</p><p>${esc(a.body || '')}</p>
<a class="outbound" href="${esc(a.links?.[0]?.href || '#')}" target="_blank" rel="sponsored nofollow noopener">参考来源 ↗</a></article>`;
      writeFile(root, `${outDir}/blog/${slugify(a.id)}.html`, layout(site, manifest, a.title, body));
      urls.push(`${base}/blog/${slugify(a.id)}.html`);
    }
  }

  // sitemap：显式枚举，不依赖 collections
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
  writeFile(root, `${outDir}/sitemap.xml`, xml);
  writeFile(root, `${outDir}/robots.txt`, `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);

  const report = { stage: 'build', pages: urls.length, urls, outDir };
  writeFile(root, 'reports/build.json', JSON.stringify(report, null, 2) + '\n');
  return report;
}
