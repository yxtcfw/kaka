// 纯 Node 静态构建：clone 即可 build，Termux/任意平台可跑；Hugo 仅可选后端（未装则用本渲染器）。
// SEO：sitemap 显式枚举数据源（不用 collections，规避分页模板只收第一页的坑）。
import path from 'node:path';
import fs from 'node:fs';
import { readJson, ROOT } from './lib/validate.js';
import { esc, layout, slugify } from './lib/render.js';
import { loadSeoConfig, renderText, cleanText, cleanSlug, makeDescription, citationLabel } from './lib/seo.js';
import { loadStructuredConfig, navSchemas, articleSchemas, ogTags } from './lib/structured-data.js';
import { buildStatus } from './status.js';

function readSafe(file, fallback) {
  try { return readJson(file); } catch { return fallback; }
}
function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

// 展示层：把生成端的一段式客观介绍拆成可扫描的自然段。只重排原文字，不新增数值。
// 若正文已含换行（真实模型分段输出），则原样保留，不做二次拆解。
export function splitIntroParagraphs(intro) {
  const raw = String(intro || '').trim();
  if (!raw) return [];
  if (raw.includes('\n')) {
    return raw.split(/\n+/).map((s) => s.trim()).filter(Boolean).map((text) => ({ title: '', text }));
  }
  const sentences = raw.replace(/。/g, '。\n').split('\n').map((s) => s.trim()).filter(Boolean);
  let note = '';
  if (sentences.length && /^信息转录|^具体资费|^数值以/.test(sentences[sentences.length - 1])) {
    note = sentences.pop();
  }
  const pieces = [];
  for (const s of sentences) {
    for (const piece of s.replace(/。$/, '').split('，')) {
      const p = piece.trim().replace(/^(办理条件|办理方式)：/, '');
      if (p) pieces.push(p);
    }
  }
  if (!pieces.length) return note ? [{ title: '', text: note }] : [{ title: '', text: raw }];
  const overview = [], handle = [], conditions = [], areas = [];
  for (const p of pieces) {
    if (/配送|激活|上门|快递|交付/.test(p)) handle.push(p);
    else if (/省|市|地区|自治区|县|仅发|仅限/.test(p)) areas.push(p);
    else if (/年龄|合约|周岁|个月/.test(p)) conditions.push(p);
    else overview.push(p);
  }
  const para = (arr) => arr.join('，') + '。';
  const out = [];
  if (overview.length) out.push({ title: '套餐包含什么', text: para(overview) });
  if (handle.length) out.push({ title: '怎么办理', text: `办理方式：${para(handle)}` });
  if (conditions.length) out.push({ title: '谁能办理', text: `办理条件：${para(conditions)}` });
  // 地区片段是不可办理范围，单列成段，不得并入「谁能办理」。
  if (areas.length) out.push({ title: '禁发地区', text: `以下地区不办理：${para(areas)}` });
  if (note) out.push({ title: '', text: note });
  return out;
}

// 展示层：把官方资料的「标签：值」平铺文本解析成字段，按主题分组渲染为定义列表。
// 白名单外的行（如「综上：…」）一律并入上一个已知字段，保证原文一字不丢。
const OFFICIAL_LABELS = new Set([
  '套餐名称', '套餐资费', '优惠说明', '配送方式', '激活方式', '首充要求', '年龄要求',
  '合约期限', '禁发地区', '适用范围', '活动流量', '销户方式', '网络制式', '产品名称',
  '资费套餐', '通用流量', '定向流量', '通话时长', '月租费用'
]);
const OFFICIAL_GROUPS = [
  { title: '套餐与资费', labels: ['套餐名称', '产品名称', '套餐资费', '资费套餐', '月租费用', '通用流量', '定向流量', '通话时长', '活动流量', '优惠说明', '首充要求'] },
  { title: '使用与办理', labels: ['配送方式', '激活方式', '销户方式', '网络制式'] },
  { title: '限制与须知', labels: ['年龄要求', '合约期限', '禁发地区', '适用范围'] }
];
export function parseOfficialFields(text) {
  const fields = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([^：]{1,12})：(.*)$/.exec(line);
    if (m && OFFICIAL_LABELS.has(m[1])) fields.push({ label: m[1], value: [m[2]] });
    else if (fields.length) fields[fields.length - 1].value.push(line);
  }
  return fields.map((f) => ({ label: f.label, value: f.value.join('\n').trim() })).filter((f) => f.value);
}
function renderOfficial(text) {
  const fields = parseOfficialFields(text);
  if (!fields.length) return `<p class="body-text">${esc(text || '')}</p>`;
  const rowsHtml = (rows) => rows.map((f) => `<div class="spec-row"><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('');
  const used = new Set();
  const groups = OFFICIAL_GROUPS.map((g) => {
    const rows = fields.filter((f) => g.labels.includes(f.label));
    rows.forEach((f) => used.add(f));
    return rows.length ? `<div class="spec-group"><h3>${g.title}</h3><dl class="spec-list">${rowsHtml(rows)}</dl></div>` : '';
  }).filter(Boolean);
  const rest = fields.filter((f) => !used.has(f));
  if (rest.length) groups.push(`<div class="spec-group"><h3>其他信息</h3><dl class="spec-list">${rowsHtml(rest)}</dl></div>`);
  return groups.join('');
}

export function runBuild(root = ROOT, args = {}) {
  const outDir = args.out || '_site';
  // 陈旧页面清理：静态构建不自动清目录，删除入口/文章后旧 HTML 会残留并被 sitemap 漏收。
  // 默认关闭，只有配置显式开启才删除，避免影响主题自带的静态 HTML。
  const sitemapCfg = readSafe(path.join(root, 'config/sitemap.json'), {
    lastmodFields: ['updatedAt', 'generatedAt', 'fetchedAt', 'checkedAt'],
    includeLastmod: true,
    cleanStaleHtml: false
  });
  if (sitemapCfg.cleanStaleHtml === true && !args.dryRun) {
    const walkHtml = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walkHtml(p);
        else if (ent.isFile() && ent.name.endsWith('.html')) fs.unlinkSync(p);
      }
    };
    walkHtml(path.join(root, outDir));
  }
  const manifest = readJson(path.join(root, 'config/manifest.json'));
  const site = readJson(path.join(root, 'data/site.json'));
  // 页脚合规入口：配置里声明的链接挂到 site，由 layout 渲染；无配置则不显示。
  site.complianceLinks = readSafe(path.join(root, 'config/compliance.json'), { footerLinks: [] }).footerLinks || [];
  const nav = readJson(path.join(root, 'data/navlinks.json'));
  const navDetails = readSafe(path.join(root, 'data/nav-details.json'), { pages: [] });
  const articles = readSafe(path.join(root, 'data/articles.json'), { articles: [] }).articles;
  const tree = readSafe(path.join(root, 'data/tree.json'), { nodes: [] });
  const sources = readSafe(path.join(root, 'data/sources.json'), { sources: [] }).sources;
  const seoCfg = loadSeoConfig(root);
  const hygiene = seoCfg.textHygiene;
  const structCfg = loadStructuredConfig(root);
  const presentCfg = readSafe(path.join(root, 'config/presentation.json'), { countLabel: '个入口', filters: [] });
  const priceBands = presentCfg.priceBands || [];
  // 运营商图形标识：内嵌 SVG 配置，零图片请求；无配置时退化为通用符号。
  const iconCfg = readSafe(path.join(root, 'config/isp-icons.json'), { icons: {}, fallback: { color: '#64748b', label: '', svg: '' } });
  const priceBandOf = (specs) => {
    const p = Number(specs?.nowPrice);
    if (!Number.isFinite(p)) return '';
    const band = priceBands.find((b) => (b.min == null || p >= Number(b.min)) && (b.max == null || p < Number(b.max)));
    return band?.label || '';
  };
  const homeRules = readSafe(path.join(root, 'rules/home-articles.json'), {
    maxItems: 4, minBodyChars: 200, bannedTitlePatterns: [], bannedBodyPhrases: [],
    groups: {}, fallbackGroup: '选购专题'
  });

  // 文章分组与首页上屏门槛：只控制展示，不删数据；规则文件可审计。
  const nodeById = new Map((tree.nodes || []).map((n) => [n.id, n]));
  const articleGroup = (a) => {
    const node = nodeById.get(a.nodeId);
    const childText = (node?.children || []).map((id) => nodeById.get(id)).filter(Boolean)
      .map((c) => `${c.label || ''} ${c.topic || ''}`).join(' ');
    const hay = [node?.label, node?.topic, childText, a.title].filter(Boolean).join(' ');
    for (const [group, words] of Object.entries(homeRules.groups || {})) {
      if ((words || []).some((w) => hay.includes(w))) return group;
    }
    return homeRules.fallbackGroup || '选购专题';
  };
  const isHomeEligible = (a) => {
    const title = String(a.title || '');
    const body = String(a.body || '');
    if (body.length < Number(homeRules.minBodyChars || 200)) return false;
    if ((homeRules.bannedTitlePatterns || []).some((p) => { try { return new RegExp(p).test(title); } catch { return false; } })) return false;
    if ((homeRules.bannedBodyPhrases || []).some((p) => body.includes(p))) return false;
    return true;
  };
  const articleSummary = (a) => String(a.cardDesc || '').trim()
    || String(a.body || '').split(/[。\n]/)[0].slice(0, 60);
  // 列表摘要同样过清洗规则，避免正文里的内部标识符从摘要重新漏上屏。
  const articleSummaryClean = (a) => cleanText(articleSummary(a), hygiene);
  const articleLink = (a) => `<a href="/blog/${cleanSlug(a.id, hygiene)}.html">${esc(cleanText(a.title, hygiene))}</a>`;

  const base = `https://${manifest.domain}`;
  const urls = [];
  // lastmod：从数据自带日期读取，缺日期不写（不造时间点）。换主题只改字段路径配置。
  const lastmodOf = (...objs) => {
    if (sitemapCfg.includeLastmod === false) return '';
    for (const obj of objs) {
      for (const key of sitemapCfg.lastmodFields || []) {
        const v = obj?.[key];
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
      }
    }
    return '';
  };
  const urlDates = new Map();

  // CSS：注入 styleTokens 到 :root
  const cssSrc = fs.readFileSync(path.join(root, 'templates/assets/site.css'), 'utf8');
  const tokens = site.styleTokens || {};
  const cssVars = `:root{--primary:${esc(tokens.primary || '#2563eb')};--accent:${esc(tokens.accent || '#f59e0b')};--radius:${esc(tokens.radius || '12px')};--font:${esc(tokens.font || 'system-ui, sans-serif')};}\n`;
  // 注入放到末尾，覆盖 site.css 的 :root 默认值，保证人工 styleTokens 生效。
  writeFile(root, `${outDir}/assets/site.css`, cssSrc + '\n' + cssVars);

  // 搜索引擎站点验证文件：仓库根目录原样复制到站点根，发布后位于 /BingSiteAuth.xml。
  const bingAuth = path.join(root, 'BingSiteAuth.xml');
  if (fs.existsSync(bingAuth)) writeFile(root, `${outDir}/BingSiteAuth.xml`, fs.readFileSync(bingAuth, 'utf8'));

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
      // 运营商图形标识：配置驱动的内嵌 SVG，取代标题首字；未知运营商用通用符号。
      const icon = iconCfg.icons?.[n.isp] || iconCfg.fallback || { color: '#64748b', svg: '' };
      const iconHtml = `<span class="card-icon" style="color:${esc(icon.color || '#64748b')}" role="img" aria-label="${esc(icon.label || n.isp || '运营商')}"><svg viewBox="${esc(iconCfg.viewBox || '0 0 32 32')}" width="20" height="20" aria-hidden="true" focusable="false">${icon.svg || ''}</svg></span>`;
      const specs = n.specs || {};
      const tag = (label, value) => value ? `<span class="tag">${esc(label)}${esc(value)}</span>` : '';
      const specTags = [
        tag('', specs.taocan),
        tag('通用', specs.tyLiuliang && `${specs.tyLiuliang}G`),
        tag('定向', specs.dxLiuliang && `${specs.dxLiuliang}G`),
        tag('通话', specs.tonghua && `${specs.tonghua}分钟`),
        tag('', specs.isSelectNum),
        tag('', specs.isPhotos),
        tag('', specs.age && `${specs.age}岁`),
        tag('销量', specs.sales)
      ].filter(Boolean).join('');
      const price = specs.nowPrice
        ? `<div class="price">¥${esc(specs.nowPrice)}${specs.priceUnitStr ? `<small> ${esc(specs.priceUnitStr)}</small>` : ''}${specs.oldPrice && specs.oldPrice !== specs.nowPrice ? `<del>¥${esc(specs.oldPrice)}</del>` : ''}</div>`
        : '';
      // 搜索索引：标题/描述/分类/运营商/全部客观参数；营销话术不落盘故不进索引。
      const searchText = [n.title, n.cardDesc, n.description, n.category, n.isp, ...Object.values(specs)].filter(Boolean).join(' ');
      const filterAttrs = ` data-isp="${esc(n.isp || '')}" data-band="${esc(priceBandOf(specs))}" data-category="${esc(n.category || '')}"`;
      return `<div class="card" data-search="${esc(searchText)}"${filterAttrs}>
<div class="card-head">${iconHtml}<h3>${anchor}</h3></div>
${price}
${specTags ? `<div class="specs">${specTags}</div>` : ''}
<p>${esc(n.cardDesc || n.description || '')}</p>
<div class="out"><span>${esc(n.category)}</span></div>
</div>`;
    }).join('');
    return `<section id="${esc(slugify(cat))}">
<div class="section-head"><h2>${esc(cat)}</h2><span class="more">${items.length} ${esc(presentCfg.countLabel || '个入口')}</span></div>
<div class="grid">${cards}</div>
</section>`;
  }).join('\n');
  // 最新文章：放在运营商卡片之前，让博客成为一级可达栏目。
  // 不带 id，避免站内搜索的 section[id] 显隐逻辑把文章区误隐藏。
  const latest = articles.filter(isHomeEligible)
    .sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')))
    .slice(0, Number(homeRules.maxItems || 4));
  const latestHtml = latest.length
    ? `<section class="article-section">
<div class="section-head"><h2>最新文章</h2><a class="more" href="/blog/">查看全部 ${articles.length} 篇 →</a></div>
<div class="post-list">${latest.map((a) => `<div class="post-item"><h3>${articleLink(a)}</h3><p>${esc(articleSummaryClean(a))}</p><div class="meta">${esc(a.generatedAt || '')} · ${esc(articleGroup(a))}</div></div>`).join('')}</div>
</section>`
    : '';
  // 筛选条：纯前端渐进增强；无 JS 时卡片照常显示，筛选控件只是不可用，不影响可读性。
  const filterHtml = (presentCfg.filters || []).map((f) => {
    const values = (f.values && f.values.length)
      ? f.values
      : [...new Set(nav.items.map((n) => f.field === 'isp' ? n.isp : (f.field === 'category' ? n.category : priceBandOf(n.specs))).filter(Boolean))];
    if (!values.length) return '';
    const options = values.map((v) => `<button type="button" data-filter-field="${esc(f.field)}" data-filter-value="${esc(v)}">${esc(v)}</button>`).join('');
    return `<div class="filter-group"><span>${esc(f.label)}</span>${options}</div>`;
  }).filter(Boolean).join('');
  const filtersBar = filterHtml ? `<div class="filters" role="group" aria-label="筛选"><button type="button" data-filter-reset>全部</button>${filterHtml}</div>` : '';

  // h1 文案来自配置模板（{site.h1}），换主题只改 data/site.json，不改渲染代码。
  const homeH1 = cleanText(renderText(seoCfg.pages.home?.h1 || '{site.h1}', { site }), hygiene)
    || site.siteName || manifest.vertical || '首页';
  const homeBody = `<h1>${esc(homeH1)}</h1><div class="intro"><p>${esc(site.intro || '资料整理与选购参考。')}</p></div>${filtersBar}${latestHtml}${homeSections || '<p class="empty">暂无导航条目</p>'}`;
  const homeDesc = makeDescription(seoCfg, seoCfg.pages.home, { site }, site.intro || site.tagline);
  writeFile(root, `${outDir}/index.html`, layout(site, manifest, site.siteName || manifest.vertical || '首页', homeBody, {
    canonical: `${base}/`,
    description: homeDesc,
    og: ogTags(structCfg, site, `${base}/`, site.siteName || '', homeDesc)
  }));
  urls.push(`${base}/`);
  const homeDate = lastmodOf(site);
  if (homeDate) urlDates.set(`${base}/`, homeDate);

  // nav 详情页（只有过闸且有正文的）
  // 同 blog： Eleventy 坑——不清输出目录。详情清空时必须主动删旧产物，否则示例页残留线上。
  const navDir = path.join(root, outDir, 'nav');
  if (!navDetails.pages.length && fs.existsSync(navDir)) {
    fs.rmSync(navDir, { recursive: true, force: true });
  }
  for (const p of navDetails.pages) {
    const navItem = nav.items.find((n) => `nav-${n.navId}` === p.bundleId || n.navId === p.navId);
    const navTitle = cleanText(p.title || navItem?.title || '详情', hygiene);
    // 新数据为结构化段落数组；老数据为字符串，交给批次 A 的拆段函数兜底。
    const segments = Array.isArray(p.intro) && p.intro.length ? p.intro : splitIntroParagraphs(p.intro);
    const introHtml = segments.map((seg) => {
      const heading = seg && seg.title ? `<h3>${esc(cleanText(seg.title, hygiene))}</h3>` : '';
      return `${heading}<p class="intro-para">${esc(cleanText((seg && seg.text) || '', hygiene))}</p>`;
    }).join('') || `<p class="intro-para">${esc(cleanText(navItem?.cardDesc || '', hygiene))}</p>`;
    const toc = `<div class="toc"><strong>目录</strong> · <a href="#intro">套餐介绍</a> · <a href="#official">官方资料</a> · <a href="#checked">办理与说明</a></div>`;
    // 唯一出站口前置到首屏（id=apply 供文末站内锚点回跳），rel 固定合规值。
    const outbound = `<a class="outbound" id="apply" href="${esc(p.outbound)}" target="_blank" rel="sponsored nofollow noopener">前往办理 ↗</a>`;
    const cat = String(navItem?.category || '');
    const matchedGuides = articles.filter((a) => {
      const group = articleGroup(a);
      const words = homeRules.groups?.[group] || [];
      return cat && (group === cat || words.some((w) => cat.includes(w)) || String(a.title || '').includes(cat));
    });
    const relatedGuides = (matchedGuides.length ? matchedGuides : articles).slice(0, 2);
    const relatedHtml = relatedGuides.length
      ? `<section class="related"><div class="section-head"><h2>相关攻略</h2></div><div class="post-list">${relatedGuides.map((a) => `<div class="post-item"><h3>${articleLink(a)}</h3><p>${esc(articleSummaryClean(a))}</p></div>`).join('')}</div></section>`
      : '';
    const body = `${toc}
<article class="post" id="intro">
<h1>${esc(navTitle)}</h1>
<p class="meta">依据官方详情信源整理 · ${esc(site.byline || '')}</p>
${outbound}
<section id="intro-text">${introHtml}</section>
<section id="official"><h2>官方资料</h2>${renderOfficial(p.sourceBody)}</section>
<section id="checked"><h2>办理与说明</h2><p>数值以官方实时页面为准；本站不编造数字，不展示营销话术。</p><p class="back-to-apply"><a href="#apply">↑ 返回办理入口</a></p></section>
${relatedHtml}
<div class="citations">信源：${esc((p.sourceIds || navItem?.sourceIds || [])
      .map((id) => citationLabel(id, sources, hygiene)).join('、') || (hygiene.citationFallback || '参考资料'))}</div>
</article>`;
    const navSlug = cleanSlug(p.navId, hygiene);
    const navUrl = `${base}/nav/${navSlug}.html`;
    const navDesc = makeDescription(seoCfg, seoCfg.pages.nav, {
      title: navTitle, cardDesc: navItem?.cardDesc, category: navItem?.category
    }, navItem?.cardDesc || navTitle);
    writeFile(root, `${outDir}/nav/${navSlug}.html`, layout(site, manifest, navTitle, body, {
      canonical: navUrl,
      description: navDesc,
      og: ogTags(structCfg, site, navUrl, navTitle, navDesc),
      schemas: [
        { '@context': 'https://schema.org', '@type': 'WebSite', name: site.siteName || manifest.vertical || '', url: `${base}/` },
        ...navSchemas(structCfg, base, navUrl, navItem, p, hygiene)
      ]
    }));
    urls.push(navUrl);
    const navDate = lastmodOf(p, navItem);
    if (navDate) urlDates.set(navUrl, navDate);
  }

  // blog 文章列表 + 详情
  // Eleventy 坑：不清输出目录。文章清空时必须主动删除旧 blog 产物，否则示例文章会残留在线上。
  const blogDir = path.join(root, outDir, 'blog');
  if (!articles.length && fs.existsSync(blogDir)) {
    fs.rmSync(blogDir, { recursive: true, force: true });
  }
  if (articles.length) {
    fs.mkdirSync(blogDir, { recursive: true });
    // slug 清洗会改变文件名；先清掉旧 .html（含旧 auto- 前缀文件），避免残留产物被直接访问。
    for (const name of fs.readdirSync(blogDir)) {
      if (name.endsWith('.html')) fs.rmSync(path.join(blogDir, name), { force: true });
    }
    const groupNames = [...new Set([...Object.keys(homeRules.groups || {}), homeRules.fallbackGroup || '选购专题'])];
    const groupsHtml = groupNames.map((group) => {
      const list = articles.filter((a) => articleGroup(a) === group);
      const items = list.length
        ? list.map((a) => `<div class="post-item"><h3>${articleLink(a)}</h3><p>${esc(articleSummaryClean(a))}</p><div class="meta">${esc(a.generatedAt || '')}</div></div>`).join('')
        : '<p class="empty">该分类暂无文章，后续更新后自动展示。</p>';
      return `<section id="${esc(slugify(group))}">
<div class="section-head"><h2>${esc(group)}</h2><span class="more">${list.length} 篇</span></div>
<div class="post-list">${items}</div>
</section>`;
    }).join('\n');
    const blogH1 = cleanText(renderText(seoCfg.pages.blogIndex?.h1 || '{site.blogTitle}', { site }), hygiene) || '文章';
    const blogUrl = `${base}/blog/`;
    const blogDesc = makeDescription(seoCfg, seoCfg.pages.blogIndex, { site }, site.intro || '文章');
    writeFile(root, `${outDir}/blog/index.html`, layout(site, manifest, '文章', `<h1>${esc(blogH1)}</h1><div class="intro"><p>按主题整理的选购与办理资料，共 ${articles.length} 篇。</p></div>${groupsHtml}`, {
      canonical: blogUrl,
      description: blogDesc,
      og: ogTags(structCfg, site, blogUrl, blogH1, blogDesc)
    }));
    urls.push(blogUrl);
    for (const a of articles) {
      const group = articleGroup(a);
      const groupWords = homeRules.groups?.[group] || [];
      let relatedNav = nav.items.filter((n) => n.category === group
        || groupWords.some((w) => `${n.title || ''}${n.cardDesc || ''}`.includes(w)));
      if (!relatedNav.length) relatedNav = nav.items.filter((n) => detailByNav.has(n.navId));
      relatedNav = relatedNav.slice(0, 3);
      const related = relatedNav.map((n) => {
        const href = detailByNav.has(n.navId) ? `/nav/${slugify(n.navId)}.html` : (n.promoUrl || n.url);
        const external = !detailByNav.has(n.navId);
        return `<a class="related-link" href="${esc(href)}"${external ? ' target="_blank" rel="sponsored nofollow noopener"' : ''}>${esc(n.title)}${external ? ' ↗' : ''}</a>`;
      }).join('');
      const relatedHtml = related
        ? `<section class="related"><div class="section-head"><h2>相关办理入口</h2></div><div class="related-links">${related}</div></section>`
        : '';
      const articleTitle = cleanText(a.title, hygiene);
      const articleSummaryText = cleanText(articleSummary(a), hygiene);
      const articleSlug = cleanSlug(a.id, hygiene);
      const articleUrl = `${base}/blog/${articleSlug}.html`;
      // 空行分段：正文数据可含多段，渲染层只做通用切分，不认识任何主题字段。
      const bodyHtml = String(a.body || '').split(/\n\s*\n/)
        .map((para) => cleanText(para, hygiene)).filter(Boolean)
        .map((para) => `<p class="body-text">${esc(para)}</p>`).join('\n');
      const body = `<nav class="breadcrumb"><a href="/">首页</a> · <a href="/blog/">文章</a> · ${esc(group)}</nav>
<article class="post"><h1>${esc(articleTitle)}</h1><p class="meta">${esc(a.generatedAt || '')} · ${esc(site.byline || '')}</p>${bodyHtml}
<a class="outbound" href="${esc(a.links?.[0]?.href || '#')}" target="_blank" rel="sponsored nofollow noopener">参考来源 ↗</a></article>
${relatedHtml}
<p class="back-to-apply"><a href="/blog/">← 返回文章列表</a></p>`;
      const articleDesc = makeDescription(seoCfg, seoCfg.pages.article, {
        title: articleTitle, summary: articleSummaryText
      }, articleSummaryText || articleTitle);
      writeFile(root, `${outDir}/blog/${articleSlug}.html`, layout(site, manifest, articleTitle, body, {
        canonical: articleUrl,
        description: articleDesc,
        og: ogTags(structCfg, site, articleUrl, articleTitle, articleDesc),
        schemas: [
          { '@context': 'https://schema.org', '@type': 'WebSite', name: site.siteName || manifest.vertical || '', url: `${base}/` },
          ...articleSchemas(structCfg, base, articleUrl, { ...a, title: articleTitle }, group, hygiene)
        ]
      }));
      urls.push(articleUrl);
      const articleDate = lastmodOf(a);
      if (articleDate) urlDates.set(articleUrl, articleDate);
    }
  }

  // sitemap：显式枚举，不依赖 collections
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => {
    const date = urlDates.get(u);
    return `  <url><loc>${esc(u)}</loc>${date ? `<lastmod>${esc(date)}</lastmod>` : ''}</url>`;
  }).join('\n')}\n</urlset>\n`;
  writeFile(root, `${outDir}/sitemap.xml`, xml);
  writeFile(root, `${outDir}/robots.txt`, `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);

  const report = { stage: 'build', pages: urls.length, urls, outDir };
  writeFile(root, 'reports/build.json', JSON.stringify(report, null, 2) + '\n');

  // 运行状态：优先搬用 pipeline 写入的 reports/status.json（权威产物）；
  // 本地直接 build 尚无该文件时，用当前数据现场生成一份，保证任何路径都产出只读状态页数据。
  try {
    const statusPath = path.join(root, 'reports', 'status.json');
    const content = fs.existsSync(statusPath)
      ? fs.readFileSync(statusPath, 'utf8')
      : JSON.stringify(buildStatus(root), null, 2) + '\n';
    writeFile(root, `${outDir}/status.json`, content);
  } catch { /* status 生成失败不影响站点构建 */ }
  return report;
}
