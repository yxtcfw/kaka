// HTML 转义与页面模板片段（零依赖，避免注入）。
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 锚点/id 归一化：与 build.js 共用，保证分类锚点和 section id 一致。
export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

export function layout(site, manifest, title, body) {
  const domain = manifest.domain;
  const canonical = `https://${domain}/`;
  const siteName = site.siteName || title;
  const brandChar = String(siteName).trim().charAt(0) || '站';
  const cats = Array.isArray(site.navCategories) ? site.navCategories : [];
  const catNav = cats.map((c) => `<a href="/#${esc(slugify(c))}">${esc(String(c))}</a>`).join('');
  const introBrief = String(site.intro || site.tagline || '').slice(0, 90);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(site.intro || site.tagline || title).slice(0, 160)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="stylesheet" href="/assets/site.css">
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteName,
    url: canonical
  }).replace(/</g, '\\u003c')}</script>
</head>
<body>
<header class="site-header"><div class="wrap header-inner">
<a class="brand" href="/">
<span class="brand-mark" aria-hidden="true">${esc(brandChar)}</span>
<span class="brand-text"><strong>${esc(siteName)}</strong><small>${esc(site.tagline || '')}</small></span>
</a>
<form class="search" action="/" method="get" role="search">
<input type="search" name="q" placeholder="搜索分类或关键词" aria-label="站内搜索">
<button type="submit">搜索</button>
</form>
</div>
<nav class="catbar"><div class="wrap">
<a href="/">首页</a>${catNav}
</div></nav>
</header>
<main class="wrap">
${body}
</main>
<footer class="site-footer"><div class="wrap">
<div class="footer-grid">
<div class="footer-col"><h4>关于本站</h4><p>${esc(siteName)}</p><p>${esc(introBrief)}</p></div>
<div class="footer-col"><h4>站点导航</h4><a href="/">首页</a><a href="/sitemap.xml">网站地图</a></div>
<div class="footer-col"><h4>说明</h4><p>${esc(site.byline || '')}</p><p>${esc(site.license || '')}</p><p>数值以官方实时页面为准</p></div>
</div>
<div class="footer-bottom">${esc(site.byline || '')} · ${esc(site.license || '')}</div>
</div></footer>
</body>
</html>`;
}
