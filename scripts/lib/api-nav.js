// 推广产品 API 拉取与客观参数映射（零依赖）。
// 设计纪律：I/O 全注入（httpFn/sleep/now），默认零真实网络；营销话术 words/keywords 隔离；
// 失败显式降级（返回已抓部分 + errors），绝不伪造数据。
import { URLSearchParams } from 'node:url';

export function buildUrl(cfg, page) {
  const q = new URLSearchParams();
  q.set('Id', String(cfg.id || ''));
  for (const [k, v] of Object.entries(cfg.query || {})) q.set(k, String(v));
  q.set('page', String(page));
  q.set('limit', String(cfg.page?.perPage || 20));
  return `${cfg.endpoint}?${q.toString()}`;
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

// 翻页拉取。deps: { httpFn(url, timeoutMs) -> {status,text}, sleep(ms), fetchFn }
export async function fetchAll(cfg, deps = {}) {
  const maxPages = Number(cfg.page?.maxPages || 4);
  const start = Number(cfg.page?.start || 1);
  const timeout = Number(cfg.page?.timeoutMs || 15000);
  const rateRps = Number(cfg.page?.rateRps || 0);
  const sleep = deps.sleep || sleepReal;
  const http = deps.httpFn || (async (url, t) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), t);
    try {
      const res = await (deps.fetchFn || globalThis.fetch)(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      return { status: res.status, text: await res.text() };
    } finally { clearTimeout(timer); }
  });

  const items = [];
  const errors = [];
  let count = null;
  const maxItems = Number(cfg.maxItems || 0);

  for (let p = start; p < start + maxPages; p++) {
    if (rateRps > 0 && p > start) await sleep(Math.ceil(1000 / rateRps));
    let status = 0, text = '';
    try {
      const res = await http(buildUrl(cfg, p), timeout);
      status = Number(res?.status || 0);
      text = String(res?.text || '');
    } catch (e) {
      errors.push(`page=${p} ${e?.name || 'Error'}`);
      continue;
    }
    if (status !== 200 || !text) {
      errors.push(`page=${p} status=${status} empty=${!text}`);
      continue;
    }
    let doc;
    try { doc = JSON.parse(text); } catch { errors.push(`page=${p} JSON 解析失败`); continue; }
    if (Number(doc.code || 0) !== 0) { errors.push(`page=${p} code=${doc.code}`); continue; }
    if (count === null) count = doc.count ?? null;
    const batch = Array.isArray(doc.data) ? doc.data : [];
    if (!batch.length) break;
    for (const item of batch) {
      items.push(item);
      if (maxItems > 0 && items.length >= maxItems) break;
    }
    if (maxItems > 0 && items.length >= maxItems) break;
  }
  return { items, meta: { count, fetched: items.length, pages: maxPages, errors } };
}

function clampDesc(s, max) {
  const chars = [...String(s || '')];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

// 客观参数 → cardDesc（≤max 字）。words/keywords 绝不入内。
export function descFromProduct(p, max = 60) {
  const isp = String(p.isp || '').trim();
  const taocan = String(p.taocan || '').trim();
  const price = p.nowPrice != null ? String(p.nowPrice) : (p.oldPrice != null ? String(p.oldPrice) : '');
  const general = p.tyLiuliang != null ? String(p.tyLiuliang) : '';
  const talk = p.tonghua != null ? String(p.tonghua) : '';
  const parts = [];
  if (isp) parts.push(isp);
  if (taocan) parts.push(taocan);
  else if (price) parts.push(`${price}元档`);
  const detail = [];
  if (general) detail.push(`通用${general}G`);
  if (talk && talk !== '0') detail.push(`通话${talk}分钟`);
  const base = parts.join(' ') + (detail.length ? '，' + detail.join('·') : '');
  return clampDesc(base || '运营商产品目录参数页', max);
}

// 单条商品 → nav 条目。来源标记 productId/isp 供审计；营销话术隔离在 _marketing 字段（写盘前剔除）。
export function mapProduct(p, cfg = {}) {
  const shareUrl = String(p.shareUrl || '').trim();
  if (!shareUrl) return null;
  const isp = String(p.isp || '').trim();
  const pid = p.productID ?? p.productIDStr ?? p.id;
  const categoryMap = cfg.categoryByIsp || {};
  const category = categoryMap[isp] || cfg.defaultCategory || '资费套餐';
  const title = String(p.name || '').trim() || `${isp} ${p.taocan || ''}`.trim() || '运营商套餐';
  const cardDesc = descFromProduct(p, Number(cfg.cardDescMax || 60));
  // 客观参数结构化落盘，供卡片上屏；营销话术/内部技术字段永不入内。0 值的流量/通话不上屏。
  const specs = {};
  const add = (k, v) => { const s = String(v ?? '').trim(); if (s) specs[k] = s; };
  const addNonZero = (k, v) => { if (String(v ?? '').trim() !== '0') add(k, v); };
  add('taocan', p.taocan);
  add('nowPrice', p.nowPrice);
  add('oldPrice', p.oldPrice);
  addNonZero('tyLiuliang', p.tyLiuliang);
  addNonZero('dxLiuliang', p.dxLiuliang);
  addNonZero('tonghua', p.tonghua);
  add('priceUnitStr', p.priceUnitStr);
  add('isSelectNum', p.isSelectNum);
  add('isPhotos', p.isPhotos);
  if (p.age1 != null || p.age2 != null) specs.age = [p.age1, p.age2].filter((x) => x != null).join('-');
  if (p.sales != null) specs.sales = String(p.sales);
  return {
    navId: `api-${pid ?? shareUrl.length}`,
    productId: pid ?? null,
    isp: isp || null,
    title,
    url: shareUrl,
    promoUrl: shareUrl,
    category,
    description: `API 同步：${isp || '运营商'}产品目录客观参数（非营销话术）`,
    cardDesc,
    specs,
    hasContent: cfg.hasContent === true,
    sourceIds: [],
    rel: cfg.rel || 'sponsored nofollow noopener',
    _marketing: { words: p.words || '', keywords: p.keywords || [] }
  };
}

// 去重：按 productID（缺失则按 shareUrl 的 urlKey 退化）。返回 {items, duplicates}。
export function dedupeProducts(rawItems, cfg = {}) {
  const by = cfg.dedupeBy || 'productID';
  const seen = new Set();
  const items = [];
  let duplicates = 0;
  for (const p of rawItems || []) {
    const mapped = mapProduct(p, cfg);
    if (!mapped) { duplicates++; continue; }
    const key = by === 'productID' && mapped.productId != null
      ? `pid:${mapped.productId}`
      : `url:${mapped.url}`;
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    const { _marketing, ...clean } = mapped; // 营销话术不落盘
    items.push(clean);
  }
  return { items, duplicates };
}

// 重分类：只对含 productId 的 API 条目按 isp 重新映射 category；人工条目（无 productId）永不改。
// 纯函数：不改入参，返回新数组；幂等（同 isp 同映射结果不变）。
export function reclassify(items, cfg = {}) {
  const categoryMap = cfg.categoryByIsp || {};
  const fallback = cfg.defaultCategory || '资费套餐';
  let changed = 0;
  const next = (items || []).map((it) => {
    if (it == null || it.productId == null) return it; // 人工条目原样返回
    const isp = String(it.isp || '').trim();
    const category = categoryMap[isp] || fallback;
    if (it.category === category) return it; // 幂等：无需改
    changed++;
    return { ...it, category };
  });
  return { items: next, changed };
}
