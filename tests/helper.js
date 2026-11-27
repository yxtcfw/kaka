// 测试辅助：构造隔离的临时 root。
// 关键纪律（旧项目坑3）：所有写路径必须由 root 派生，绝不指向真实仓库。
// 会被 pipeline 写入的文件（state/site/tree/navlinks/sources）用内联「干净基线」，
// 不读真实仓库当前内容，避免测试被已运行过的产物污染。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BASELINE = {
  'seeds.json': { schema: 'seeds/v1', seeds: ['流量卡', '大流量卡', '副卡', '校园流量卡'] },
  'state.json': {
    schema: 'state/v1', siteFilled: false,
    signals: { count: 0, sources: 0, newRate: 1, passed: false },
    tree: { built: false, version: 0 },
    sources: { l1: 0, independentL2: 0, passed: false },
    content: { generated: 0, gateBlocked: 0, passed: false },
    navPages: { built: 0, downgraded: 0 }, runs: []
  },
  'config/manifest.json': {
    schema: 'manifest/v1', domain: 'example.com', vertical: '流量卡', siteName: null, tagline: null,
    hosting: 'cloudflare-pages',
    theme: { primary: '#2563eb', accent: '#f59e0b', radius: '12px', font: 'system-ui, sans-serif' },
    thresholds: { signalsMin: 300, signalsSourcesMin: 2, signalsNewRateMax: 0.1, sourceL1Min: 1, sourceL2IndependentMin: 2, gateBlocksMin: 1 },
    providers: { suggest: 'mock', search: 'mock', llm: 'mock', metrics: 'mock' }
  },
  'data/tree.json': {
    schema: 'tree/v1', version: 1,
    root: { id: 'n0', label: '流量卡', topic: '流量卡选购', children: ['n1', 'n2'] },
    nodes: [
      { id: 'n1', label: '资费套餐', topic: '大流量卡资费对比', keywords: ['月租', '通用流量', '定向流量'], parent: 'n0', children: [] },
      { id: 'n2', label: '办理攻略', topic: '流量卡办理避坑', keywords: ['开卡', '实名', '首充'], parent: 'n0', children: [] }
    ]
  },
  'data/navlinks.json': {
    schema: 'navlinks/v1',
    items: [
      { navId: 'nav-001', title: '示例运营商官方资费页', url: 'https://example.com/plan', promoUrl: null, category: '资费套餐', description: '审核留档：官方资费入口', cardDesc: '官方资费页，查看当前在售套餐与月租说明。', hasContent: false, sourceIds: ['src-001'] },
      { navId: 'nav-002', title: '示例办理指南', url: 'https://example.com/guide', promoUrl: null, category: '办理攻略', description: '审核留档：办理流程入口', cardDesc: '办理流程汇总，含实名与首充注意事项。', hasContent: false, sourceIds: ['src-002'] }
    ]
  },
  'data/sources.json': {
    schema: 'sources/v1',
    sources: [
      { sourceId: 'src-001', url: 'https://example.com/plan', domain: 'example.com', title: '官方资费说明（示例）', grade: 'L1', status: 'approved', bodyKind: 'fulltext', bodyExcerpt: '官方页面示例摘要：月租 29 元含 100GB 通用流量，无定向限制。具体资费以官方实时页面为准。', discoveredBy: 'seed', fetchedAt: '2026-11-26T00:00:00Z' },
      { sourceId: 'src-002', url: 'https://news.example.org/guide', domain: 'news.example.org', title: '办卡避坑指南（示例）', grade: 'L2', status: 'approved', bodyKind: 'fulltext', bodyExcerpt: '第三方媒体示例摘要：办理前需确认实名规则与首充要求，避免停卡风险。', discoveredBy: 'manual', fetchedAt: '2026-11-26T00:00:00Z' }
    ]
  },
  'data/site.json': {
    schema: 'site/v1', siteName: null, tagline: null, vertical: null, topics: [], navCategories: [],
    intro: null, styleTokens: null, license: null, byline: null
  }
};

// 从真实仓库静态读取的文件（不会被引擎改写）：rules/schema/CSS/package
const STATIC_FILES = [
  'package.json',
  'config/api-nav.json',
  'config/article-rules.json',
  'rules/signals-tree.json', 'rules/tree-cadence.json', 'rules/nav-classify.json', 'rules/source-grade.json', 'rules/autopilot.json', 'rules/collect-policy.json', 'rules/suggest-policy.json', 'rules/maintenance.json',
  'templates/assets/site.css',
  ...fs.readdirSync(path.join(REPO, 'schema')).map((f) => `schema/${f}`)
];

export function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vst-test-'));
  for (const [rel, obj] of Object.entries(BASELINE)) {
    writeRaw(dir, rel, JSON.stringify(obj, null, 2) + '\n');
  }
  for (const rel of STATIC_FILES) {
    writeRaw(dir, rel, fs.readFileSync(path.join(REPO, rel), 'utf8'));
  }
  return dir;
}

function writeRaw(root, rel, content) {
  const dst = path.join(root, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, content);
}

export function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

export function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

export function writeJson(root, rel, obj) {
  writeRaw(root, rel, JSON.stringify(obj, null, 2) + '\n');
}
