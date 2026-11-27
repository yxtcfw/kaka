// 通用 SEO 与文案工具：所有站点级差异由 config/seo.json 驱动，渲染层不写死垂直领域字段。
// 保持零依赖；缺配置时回退到保守默认值，保证 clone 即可 build（自动化运行原则）。
import path from 'node:path';
import { readJson } from './validate.js';

const DEFAULT = {
  schema: 'seo/v1',
  descriptionMaxChars: 160,
  pages: {},
  textHygiene: {
    stripPatterns: [],
    slugStripPrefixes: [],
    citationFallback: '参考资料',
    sourceTitlePreferred: true
  }
};

export function loadSeoConfig(root) {
  let cfg;
  try { cfg = readJson(path.join(root, 'config/seo.json')); } catch { cfg = {}; }
  return {
    ...DEFAULT,
    ...cfg,
    pages: { ...DEFAULT.pages, ...(cfg.pages || {}) },
    textHygiene: { ...DEFAULT.textHygiene, ...(cfg.textHygiene || {}) }
  };
}

// 点路径取值：{site.h1}、{title}、{specs.taocan} 等，缺失返回空串。
export function getByPath(obj, key) {
  let cur = obj;
  for (const part of String(key || '').split('.')) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return '';
    cur = cur[part];
  }
  return cur ?? '';
}

// 模板渲染：只替换 {路径}，不做 JS 求值，避免注入。
export function renderText(template, data) {
  return String(template || '').replace(/\{([^{}]+)\}/g, (_, key) => String(getByPath(data, key) ?? ''));
}

// 文案清洗：按配置剥离内部标识符（如 （auto-scene）），不触碰业务数值。
export function cleanText(text, hygiene = {}) {
  let out = String(text ?? '');
  for (const pattern of hygiene.stripPatterns || []) {
    try { out = out.replace(new RegExp(pattern, 'gi'), ''); } catch { /* 非法规则跳过，不阻断构建 */ }
  }
  return out.replace(/\s+/g, ' ').trim();
}

// slug 清洗：按配置剥离生成逻辑段（可位于开头或中间），再归一连字符。
// 规则为空时行为与原 slugify 一致，保证老主题零配置兼容。
export function cleanSlug(slug, hygiene = {}) {
  let out = String(slug ?? '');
  for (const prefix of hygiene.slugStripPrefixes || []) {
    if (prefix && out.startsWith(prefix)) out = out.slice(prefix.length);
  }
  for (const pattern of hygiene.slugStripPatterns || []) {
    try { out = out.replace(new RegExp(pattern, 'gi'), ''); } catch { /* 非法规则跳过，不阻断构建 */ }
  }
  return out.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'item';
}

// 按配置字段列表拼 description：字段缺失自动跳过，超长截断，保证每页独立。
export function makeDescription(cfg, pageCfg, data, fallback = '') {
  const fields = pageCfg?.descriptionFields || [];
  const parts = fields.map((key) => String(getByPath(data, key) ?? '').trim()).filter(Boolean);
  const joined = cleanText(parts.join(' · '), cfg.textHygiene);
  const text = joined || cleanText(fallback, cfg.textHygiene);
  const max = Number(cfg.descriptionMaxChars || 160);
  return text.slice(0, max);
}

// 信源显示名：优先用可读 title，避免把 src-api-XXXX 这类内部 ID 暴露给访客。
export function citationLabel(sourceId, sources, hygiene = {}) {
  const found = (sources || []).find((s) => s.sourceId === sourceId);
  if (found?.title && hygiene.sourceTitlePreferred !== false) return cleanText(found.title, hygiene);
  return hygiene.citationFallback || '参考资料';
}
