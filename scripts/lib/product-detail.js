// 官方商品详情采集共用库（零依赖）。
// 数据源：推广页实际调用的官方接口 H5OrderEn/Index，返回资费/优惠/激活等第一方资料。
// 约定：只做客观字段转录，不调用模型、不编造数字、不截断正文；营销话术不入库。
import https from 'node:https';
import { domainOf } from './util.js';

export function parsePromoParams(raw) {
  try {
    const u = new URL(String(raw || ''));
    return { tk: u.searchParams.get('tk') || '', pro: u.searchParams.get('pro') || '' };
  } catch {
    return { tk: '', pro: '' };
  }
}

// HTML 纯文本化：保留全部文字，只做标签剥离与实体还原、空行压缩。
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return s.split(/\r?\n/).map((x) => x.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

// 把官方详情响应转成带字段标签的完整正文（不截断）。
export function buildDetailText(payload) {
  const data = payload?.data || {};
  const pack = data.pack || {};
  const pud = data.pud || {};
  const unit = data.priceUnit || '';
  const priceText = pud.nowPrice ? (unit === '月' ? `${pud.nowPrice}元/月` : `${pud.nowPrice}${unit}`) : '';
  const sections = [
    ['套餐名称', pack.name],
    ['套餐资费', pack.packageDetail],
    ['优惠说明', pack.offerDetail],
    ['配送方式', pack.expressMeth],
    ['激活方式', pack.actMeth],
    ['首充要求', pack.rechargeLink],
    ['年龄要求', pack.ages],
    ['合约期限', pack.contractPeriod],
    ['禁发地区', pack.noCitys],
    ['适用范围', pack.range],
    ['活动流量', pack.actFlow],
    ['销户方式', pack.offMeth],
    ['网络制式', pack.fgSup],
    ['产品名称', pud.productName],
    ['资费套餐', pud.taocan],
    ['通用流量', pud.tyLiuliang && `${pud.tyLiuliang}G`],
    ['定向流量', pud.dxLiuliang && `${pud.dxLiuliang}G`],
    ['通话时长', pud.tonghua && `${pud.tonghua}分钟`],
    ['月租费用', priceText]
  ];
  return sections
    .map(([label, raw]) => [label, htmlToText(raw)])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}：${value}`)
    .join('\n');
}

// 无模型 key 时的确定性结构化介绍：只拼接官方详情里已有的字段，不新增数值。
// 返回 [{title, text}] 段落数组，供渲染层直接上屏；数字仍全部来自官方字段。
export function objectiveIntro(title, sourceBody) {
  const text = String(sourceBody || '');
  const pick = (label) => {
    const m = new RegExp(`^${label}：(.+)$`, 'm').exec(text);
    return m ? m[1].trim().slice(0, 60) : '';
  };
  const price = pick('月租费用');
  const flow = pick('通用流量');
  const talk = pick('通话时长');
  const delivery = pick('配送方式');
  const activation = pick('激活方式');
  const age = pick('年龄要求');
  const contract = pick('合约期限');
  const area = pick('禁发地区');
  const segments = [];
  const basics = [price, flow && `${flow}通用流量`, talk && !talk.startsWith('0') && `${talk}通话`].filter(Boolean);
  if (basics.length) segments.push({ title: '套餐包含什么', text: `${title}：${basics.join('，')}。` });
  const handling = [delivery && `${delivery}配送`, activation].filter(Boolean);
  if (handling.length) segments.push({ title: '怎么办理', text: `办理方式：${handling.join('，')}。` });
  const conditions = [age && `年龄${age}`, contract && `合约${contract}`].filter(Boolean);
  if (conditions.length) segments.push({ title: '谁能办理', text: `办理条件：${conditions.join('，')}。` });
  // 禁发地区是「不可办理」范围，必须与「谁能办理」分开，避免语义反转。
  if (area) segments.push({ title: '禁发地区', text: `以下地区不办理：${area}。` });
  if (!segments.length) return [];
  segments.push({ title: '', text: '信息转录自官方详情，具体资费以官方实时页面为准。' });
  return segments;
}

// 结构化段落 → 纯文本，供门禁/报告消费；不新增任何内容。
export function introToText(segments) {
  if (Array.isArray(segments)) return segments.map((s) => (s && s.text) || '').filter(Boolean).join('\n');
  return String(segments || '');
}

// POST JSON。httpFn 可注入用于测试：httpFn(url, {method,headers,body}, timeoutMs) → {status,text}。
export function postJson(url, body, httpFn, timeoutMs = 15000) {
  const payload = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json;charset=UTF-8', 'User-Agent': 'Mozilla/5.0' };
  if (typeof httpFn === 'function') {
    return Promise.resolve(httpFn(url, { method: 'POST', headers, body: payload }, timeoutMs)).then((r) => {
      const text = typeof r === 'string' ? r : String(r?.text ?? '');
      if (!text) throw new Error('空响应');
      return JSON.parse(text);
    });
  }
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
      timeout: timeoutMs
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error(`响应不是合法 JSON: ${e.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// 官方详情信源：L1 = 第一方接口直采（不是搜索候选升级），完整正文进 bodyExcerpt。
export function mapDetailSource(nav, text, hash, fetchedAt = new Date().toISOString()) {
  const url = nav.promoUrl || nav.url || '';
  return {
    sourceId: nav.productId != null ? `src-api-${nav.productId}` : `src-api-${nav.navId}`,
    url,
    domain: domainOf(url) || 'lingqu.haokalingqu.cn',
    title: `${nav.title || '商品'} · 官方详情`,
    grade: 'L1',
    status: 'approved',
    bodyKind: 'fulltext',
    bodyExcerpt: text,
    discoveredBy: 'collect',
    fetchedAt: String(fetchedAt).slice(0, 10),
    bodyChars: text.length,
    bodyHash: hash,
    collectedFrom: 'H5OrderEn/Index'
  };
}
