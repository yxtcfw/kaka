// 通用确定性工具：hash、URL 归一化、原子写、快照、余弦去重、参数解析。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function sha256(obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash('sha256').update(s).digest('hex');
}

// 归因参数不入 URL 判重键（沿用旧项目 kit/urlkey.py 语义，Node 重写）。
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'spm', 'ref', 'from', 'share_token'
]);

export function urlKey(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const parts = [...u.pathname.split('/').filter(Boolean)];
    const query = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b));
    const q = query.map(([k, v]) => `${k}=${v}`).join('&');
    return `${host}/${parts.join('/')}${q ? '?' + q : ''}`;
  } catch {
    return String(raw).trim().toLowerCase();
  }
}

export function domainOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

// 原子写：先写临时文件再 rename，避免中途崩溃写坏数据文件。
export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// 时间戳快照：把当前文件复制到 snapshots/<basename>.<stamp>。
// 用 read+write 而非 copyFile，避免受限 shim 下 copyFileSync 的 EPERM。
export function snapshot(file, snapshotsDir, stamp = new Date().toISOString()) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(snapshotsDir, { recursive: true });
  const safe = stamp.replace(/[:.]/g, '-');
  const dest = path.join(snapshotsDir, `${path.basename(file)}.${safe}`);
  fs.writeFileSync(dest, fs.readFileSync(file));
  return dest;
}

// 词袋余弦相似度，用于六道门禁的「重复」闸。
export function cosineSimilarity(a, b) {
  const tokens = (s) => {
    const out = new Map();
    for (const t of String(s || '').toLowerCase().match(/[\u4e00-\u9fa5]|[a-z0-9]+/g) || []) {
      out.set(t, (out.get(t) || 0) + 1);
    }
    return out;
  };
  const ta = tokens(a);
  const tb = tokens(b);
  let dot = 0;
  for (const [k, v] of ta) if (tb.has(k)) dot += v * tb.get(k);
  let na = 0, nb = 0;
  for (const v of ta.values()) na += v * v;
  for (const v of tb.values()) nb += v * v;
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// 提取文本中的数字（含中文量词场景的阿拉伯数字）。
export function extractNumbers(text) {
  return String(text || '').match(/\d+(?:\.\d+)?/g) || [];
}

// kebab-case → camelCase：CLI 的 --dry-run 等连字符参数，脚本统一读 dryRun。
// 同时保留原始 key，兼容直接读 kebab 名称的调用方（如 --reclassify 等单词参数不受影响）。
function camelKey(key) {
  return key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const hasValue = next !== undefined && !next.startsWith('--');
      const value = hasValue ? next : true;
      out[key] = value;
      const ck = camelKey(key);
      if (ck !== key) out[ck] = value; // --dry-run → dryRun
      if (hasValue) i++;
    } else {
      out._.push(a);
    }
  }
  return out;
}

// 伪随机数生成器：同一 seed 产出一致序列，保证 mock 可幂等复现。
export function seededRandom(seed) {
  let s = crypto.createHash('sha256').update(String(seed)).digest().readUInt32BE(0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}
