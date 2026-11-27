// 结构化数据：Product/Offer/BreadcrumbList/FAQPage/Article，全部由 config/structured.json 驱动。
// 零依赖、缺配置回退保守默认；字段缺失就不输出该键，绝不填假价格/假评分。
import path from 'node:path';
import { readJson } from './validate.js';
import { getByPath, cleanText } from './seo.js';

const DEFAULT = {
  schema: 'structured/v1',
  enabled: true,
  og: { enabled: true, image: '' },
  nav: { product: true, faq: true, breadcrumb: true },
  article: { article: true, breadcrumb: true },
  fields: {
    price: 'specs.nowPrice',
    oldPrice: 'specs.oldPrice',
    priceUnit: 'specs.priceUnitStr',
    title: 'title',
    summary: 'cardDesc',
    name: 'title'
  },
  faqFromIntro: true,
  breadcrumbs: [
    { label: '首页', path: '/' },
    { label: '详情', path: '' }
  ]
};

export function loadStructuredConfig(root) {
  let cfg;
  try { cfg = readJson(path.join(root, 'config/structured.json')); } catch { cfg = {}; }
  return {
    ...DEFAULT, ...cfg,
    og: { ...DEFAULT.og, ...(cfg.og || {}) },
    nav: { ...DEFAULT.nav, ...(cfg.nav || {}) },
    article: { ...DEFAULT.article, ...(cfg.article || {}) },
    fields: { ...DEFAULT.fields, ...(cfg.fields || {}) }
  };
}

function abs(base, rel) {
  if (!rel) return base;
  if (/^https?:/.test(rel)) return rel;
  try { return new URL(String(rel), base).toString(); } catch { return String(rel); }
}

function safeNum(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  const n = Number(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 详情页：Product + Offer + BreadcrumbList + FAQPage（有分节问答时）。
export function navSchemas(cfg, base, pageUrl, navItem, page, hygiene = {}) {
  const out = [];
  const data = { ...(navItem || {}), ...(page || {}) };
  if (cfg.nav.product !== false) {
    const price = safeNum(getByPath(data, cfg.fields.price));
    const product = {
      '@type': 'Product',
      name: cleanText(getByPath(data, cfg.fields.name) || getByPath(data, cfg.fields.title), hygiene),
      url: pageUrl
    };
    if (price != null) {
      product.offers = {
        '@type': 'Offer',
        price,
        priceCurrency: 'CNY',
        availability: 'https://schema.org/InStock',
        url: pageUrl
      };
    }
    const desc = cleanText(getByPath(data, cfg.fields.summary), hygiene);
    if (desc) product.description = desc;
    out.push(product);
  }
  if (cfg.nav.breadcrumb !== false) {
    out.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '首页', item: `${base}/` },
        { '@type': 'ListItem', position: 2, name: cleanText(getByPath(data, cfg.fields.name), hygiene) || '详情', item: pageUrl }
      ]
    });
  }
  if (cfg.nav.faq !== false && cfg.faqFromIntro !== false && Array.isArray(page?.intro)) {
    const main = page.intro.filter((s) => s && s.title && s.text);
    if (main.length) {
      out.push({
        '@type': 'FAQPage',
        mainEntity: main.map((s) => ({
          '@type': 'Question',
          name: cleanText(s.title, hygiene),
          acceptedAnswer: { '@type': 'Answer', text: cleanText(s.text, hygiene) }
        }))
      });
    }
  }
  return out;
}

// 文章页：Article + BreadcrumbList。
export function articleSchemas(cfg, base, pageUrl, article, group, hygiene = {}) {
  const out = [];
  if (cfg.article.article !== false) {
    out.push({
      '@type': 'Article',
      headline: cleanText(article.title, hygiene),
      url: pageUrl,
      datePublished: article.generatedAt || undefined,
      author: { '@type': 'Organization', name: '编辑部' }
    });
  }
  if (cfg.article.breadcrumb !== false) {
    out.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '首页', item: `${base}/` },
        { '@type': 'ListItem', position: 2, name: '文章', item: `${base}/blog/` },
        { '@type': 'ListItem', position: 3, name: String(group || '文章'), item: pageUrl }
      ]
    });
  }
  return out.filter((x) => !x.datePublished || x.datePublished);
}

// 输出 JSON-LD 脚本数组（转义 < 防注入）。
export function ldScripts(schemas) {
  if (!schemas || !schemas.length) return '';
  const list = schemas.length === 1 ? schemas[0] : { '@context': 'https://schema.org', '@graph': schemas };
  if (!list['@context']) list['@context'] = 'https://schema.org';
  return `<script type="application/ld+json">${JSON.stringify(list).replace(/</g, '\\u003c')}</script>`;
}

// og 标签：无真实图片时不输出 og:image，避免假图。
export function ogTags(cfg, site, pageUrl, title, description) {
  if (cfg.og?.enabled === false) return '';
  const tags = [
    ['og:type', 'website'],
    ['og:site_name', site.siteName || ''],
    ['og:title', title],
    ['og:description', description],
    ['og:url', pageUrl]
  ];
  if (cfg.og.image) tags.push(['og:image', abs(pageUrl, cfg.og.image)]);
  return tags.filter(([, v]) => v).map(([k, v]) => `<meta property="${k}" content="${String(v).replace(/"/g, '&quot;')}">`).join('\n');
}
