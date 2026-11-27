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
  // 博客分组锚点（资费套餐/办理攻略）落在 /blog/，避免首页出现悬空锚点。
  const blogAnchorCats = new Set(['资费套餐', '办理攻略']);
  const catNav = cats.map((c) => {
    const label = String(c);
    const href = blogAnchorCats.has(label) ? `/blog/#${esc(slugify(label))}` : `/#${esc(slugify(label))}`;
    return `<a href="${href}">${esc(label)}</a>`;
  }).join('');
  const introBrief = String(site.intro || site.tagline || '').slice(0, 90);
  // 搜索引擎站点验证：与根目录 BingSiteAuth.xml 双保险；token 只从配置读取并转义。
  const bingToken = String(manifest.verification?.bing || '');
  const bingMeta = bingToken ? `\n<meta name="msvalidate.01" content="${esc(bingToken)}">` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(site.intro || site.tagline || title).slice(0, 160)}">
<link rel="canonical" href="${esc(canonical)}">${bingMeta}
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
<a href="/">首页</a><a href="/blog/">文章</a>${catNav}
</div><button class="catbar-prev" type="button" aria-label="查看前面的分类" hidden>‹</button><button class="catbar-next" type="button" aria-label="查看更多分类" hidden>›</button></nav>
</header>
<main class="wrap">
${body}
</main>
<footer class="site-footer"><div class="wrap">
<div class="footer-grid">
<div class="footer-col"><h4>关于本站</h4><p>${esc(siteName)}</p><p>${esc(introBrief)}</p></div>
<div class="footer-col"><h4>站点导航</h4><a href="/">首页</a><a href="/blog/">文章</a><a href="/sitemap.xml">网站地图</a></div>
<div class="footer-col"><h4>说明</h4><p>${esc(site.byline || '')}</p><p>${esc(site.license || '')}</p><p>数值以官方实时页面为准</p></div>
</div>
<div class="footer-bottom">${esc(site.byline || '')} · ${esc(site.license || '')}</div>
</div></footer>
<script>
(function () {
  var nav = document.querySelector('.catbar');
  var box = nav && nav.querySelector('.wrap');
  var prev = nav && nav.querySelector('.catbar-prev');
  var next = nav && nav.querySelector('.catbar-next');
  if (!box || !prev || !next) return;
  function step() { return Math.max(160, box.clientWidth * 0.8); }
  function sync() {
    var max = box.scrollWidth - box.clientWidth;
    prev.hidden = box.scrollLeft <= 2;
    next.hidden = max <= 2 || box.scrollLeft >= max - 2;
  }
  prev.addEventListener('click', function () {
    box.scrollBy({ left: -step(), behavior: 'smooth' });
  });
  next.addEventListener('click', function () {
    box.scrollBy({ left: step(), behavior: 'smooth' });
  });
  box.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync);
  sync();
})();
// 站内搜索：实时过滤卡片（标题/描述/分类/运营商/客观规格），隐藏空分类，支持 ?q= 初始加载。
(function () {
  var form = document.querySelector('.search');
  var input = form && form.querySelector('input[name="q"]');
  var main = document.querySelector('main.wrap');
  var cards = document.querySelectorAll('.card');
  if (!input || !main || !cards.length) return;
  var sections = main.querySelectorAll('section[id]');
  var notice = document.createElement('div');
  notice.className = 'search-empty';
  notice.hidden = true;
  notice.textContent = '没有找到匹配的入口，试试其他关键词。';
  main.appendChild(notice);
  function apply(value) {
    var terms = String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    var shown = 0;
    cards.forEach(function (card) {
      var hay = ((card.getAttribute('data-search') || '') + ' ' + card.textContent).toLowerCase();
      var ok = terms.every(function (t) { return hay.indexOf(t) !== -1; });
      card.hidden = !ok;
      if (ok) shown++;
    });
    sections.forEach(function (sec) {
      sec.hidden = terms.length > 0 && !sec.querySelector('.card:not([hidden])');
    });
    notice.hidden = shown > 0 || terms.length === 0;
  }
  input.addEventListener('input', function () { apply(input.value); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    apply(input.value);
    var u = new URL(window.location.href);
    if (input.value.trim()) u.searchParams.set('q', input.value.trim());
    else u.searchParams.delete('q');
    try { history.replaceState(null, '', u.toString()); } catch (_) { /* srcdoc/file:// 等受限环境忽略 URL 同步 */ }
  });
  var initial = new URLSearchParams(window.location.search).get('q');
  if (initial) { input.value = initial; apply(initial); }
})();
</script>
</body>
</html>`;
}
