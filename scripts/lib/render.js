// HTML 转义与页面模板片段（零依赖，避免注入）。
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function layout(site, manifest, title, body) {
  const domain = manifest.domain;
  const canonical = `https://${domain}/`;
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
    name: site.siteName || title,
    url: canonical
  }).replace(/</g, '\\u003c')}</script>
</head>
<body>
<header class="site"><div class="wrap">
<div><div class="brand">${esc(site.siteName || title)}</div><div class="tagline">${esc(site.tagline || '')}</div></div>
<nav class="cats">${(site.navCategories || []).map((c) => `<a href="/#${esc(String(c))}">${esc(String(c))}</a>`).join('')}</nav>
</div></header>
<main class="wrap">
${body}
</main>
<footer class="site"><div class="wrap">${esc(site.byline || '')} · ${esc(site.license || '')}</div></footer>
</body>
</html>`;
}
