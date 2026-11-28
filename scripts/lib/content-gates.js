// 内容质量门禁：在六道门禁之外独立运行，专治并列清单、模糊话、注水、L3 冒充确定报价。
// 不修改 gates.js，不碰 CI 触发链；失败只跳过该节点，保留旧文。
import path from 'node:path';
import { readJson } from './validate.js';

const DEFAULT = {
  enabled: true, fuzzyWords: [], maxFuzzyHits: 0,
  density: { windowChars: 300, minConcretePerWindow: 1, concretePatterns: ['\\d'] },
  numberAlignment: { enabled: true, pattern: '\\d+(?:\\.\\d+)?\\s*(?:元|G|GB|个月|周岁|分钟|条|%)', allowedNumbers: [], maxUnmatched: 0 },
  l3Qualifier: '据平台整理约为', l3QualifierWindow: 40,
  requireJudgement: true, judgementWords: [], parallelListPatterns: [],
  mustCoverMinRatio: 0.6
};

export function loadQualityConfig(root) {
  try { return { ...DEFAULT, ...readJson(path.join(root, 'rules/content-quality.json')) }; }
  catch { return { ...DEFAULT, enabled: false }; }
}

function re(pattern) { try { return new RegExp(pattern); } catch { return null; } }

// 正文每个资费类数字必须能在 Fact Sheet 或允许名单中找到出处，否则视为模型自造。
function unmatchedNumbers(body, facts, cfg) {
  const na = cfg.numberAlignment || DEFAULT.numberAlignment;
  if (na.enabled === false) return [];
  const rx = re(na.pattern || DEFAULT.numberAlignment.pattern);
  if (!rx) return [];
  const tokens = [...new Set((body.match(new RegExp(rx.source, 'g')) || []).map((s) => s.replace(/\s+/g, '')))];
  const allowed = new Set(na.allowedNumbers || []);
  const corpus = (facts || []).map((f) => String(f.value || '').replace(/\s+/g, ''));
  return tokens.filter((t) => {
    if (allowed.has(t)) return false;
    return !corpus.some((v) => v.includes(t));
  });
}

function densityFailures(body, cfg) {
  const d = cfg.density || DEFAULT.density;
  const window = Number(d.windowChars || 300);
  const need = Number(d.minConcretePerWindow || 1);
  const patterns = (d.concretePatterns || []).map(re).filter(Boolean);
  const out = [];
  for (let i = 0; i < body.length; i += window) {
    const chunk = body.slice(i, i + window);
    const hits = patterns.reduce((n, rx) => n + (chunk.match(new RegExp(rx.source, 'g')) || []).length, 0);
    if (hits < need) out.push({ from: i, hits });
  }
  return out;
}

export function checkContentQuality({ body = '', brief = {}, facts = [], cfg = DEFAULT }, ctx = {}) {
  if (cfg.enabled === false) return { ok: true, failures: [], skipped: true };
  const text = String(body || '');
  const failures = [];

  const fuzzy = (cfg.fuzzyWords || []).filter((w) => text.includes(w));
  if (fuzzy.length > Number(cfg.maxFuzzyHits ?? 0)) {
    failures.push({ gate: 'fuzzy', detail: `模糊词命中：${fuzzy.join('、')}` });
  }

  const dens = densityFailures(text, cfg);
  if (dens.length) {
    failures.push({ gate: 'density', detail: `${dens.length} 个 ${cfg.density?.windowChars || 300} 字窗口缺少具体信息`, sample: dens[0] });
  }

  const unmatched = unmatchedNumbers(text, facts, cfg);
  const maxUnmatched = Number(cfg.numberAlignment?.maxUnmatched ?? 0);
  if (unmatched.length > maxUnmatched) {
    failures.push({ gate: 'number-alignment', detail: `正文数字无法对应 Fact Sheet：${unmatched.slice(0, 8).join('、')}` });
  }

  // L3 字段的原文数值出现在正文时，附近必须有「据平台整理约为」等限定语。
  const l3 = (facts || []).filter((f) => f.grade === 'L3' && (f.not_for || []).includes('price') && String(f.value || '').length >= 3);
  const windowSize = Number(cfg.l3QualifierWindow || 40);
  const qualifier = String(cfg.l3Qualifier || '据平台整理约为');
  const badL3 = l3.filter((f) => {
    const at = text.indexOf(String(f.value));
    if (at < 0) return false;
    return !text.slice(Math.max(0, at - windowSize), at + String(f.value).length + windowSize).includes(qualifier);
  });
  if (badL3.length) {
    failures.push({ gate: 'grade-consistency', detail: `L3 数值未加限定语：${badL3.slice(0, 5).map((f) => f.value).join('、')}` });
  }

  if (cfg.parallelListPatterns?.length) {
    const hit = cfg.parallelListPatterns.map(re).filter(Boolean).filter((rx) => rx.test(text));
    if (hit.length) failures.push({ gate: 'parallel-list', detail: '并列清单句式未清除' });
  }

  if (cfg.requireJudgement !== false) {
    const lastPara = text.split(/\n\s*\n/).filter(Boolean).slice(-1)[0] || '';
    const has = (cfg.judgementWords || []).some((w) => lastPara.includes(w));
    if (!has) failures.push({ gate: 'judgement', detail: '文末缺少明确判断句' });
  }

  const must = (brief.must_cover || []).map(String).filter(Boolean);
  if (must.length) {
    const covered = must.filter((k) => text.includes(k) || k.split('').filter((c) => text.includes(c)).length >= Math.min(3, k.length));
    if (covered.length / must.length < Number(cfg.mustCoverMinRatio ?? 0.6)) {
      failures.push({ gate: 'must-cover', detail: `命题卡必答项覆盖不足：${covered.length}/${must.length}` });
    }
  }

  if (ctx.paragraphCount !== undefined && Number(ctx.expectedParagraphs || 0) > 0 && Number(ctx.paragraphCount) < Number(ctx.expectedParagraphs)) {
    failures.push({ gate: 'structure', detail: `段落数不足：${ctx.paragraphCount}/${ctx.expectedParagraphs}` });
  }

  return { ok: failures.length === 0, failures };
}
