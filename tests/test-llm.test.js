import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmStatus, resolveModel, suggestTreeRules, composeBundle } from '../scripts/lib/llm.js';

// 假模型响应：OpenAI 兼容 { choices:[{ message:{ content } }] }
function fakeRes(content, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content } }] })
  };
}

test('llmStatus: mock 恒可用，真 provider 无水 key 时不可用且只露指纹', () => {
  assert.equal(llmStatus('mock').available, true);
  const s = llmStatus('openrouter');
  // 当前进程未注入 key（测试不读真实环境），若无 key 则 available=false
  assert.equal(typeof s.available, 'boolean');
  assert.ok(Array.isArray(s.fingerprint));
  for (const fp of s.fingerprint) assert.match(fp, /^[0-9a-f]{8}$/);
});

test('suggestTreeRules: 真 provider 模型分组只接受合法 nodeId，其余归 n0', async () => {
  const prev = process.env.TESTLLM_API_KEY;
  process.env.TESTLLM_API_KEY = 'k';
  // 用 openrouter 走 env：临时注入
  const old = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'test-key-a';
  try {
    const fetchFn = async () => fakeRes('```json\n{"grouped":{"n1":["流量卡资费"],"hack":["移动办理"]}}\n```');
    const r = await suggestTreeRules('openrouter', ['流量卡资费', '移动办理'], { '资费': 'n1' }, { fetchFn });
    assert.equal(r.degraded, false);
    assert.equal(r.deterministic, false);
    assert.deepEqual(r.grouped.n1, ['流量卡资费']);
    assert.deepEqual(r.grouped.n0, ['移动办理'], '非法 nodeId hack 的词必须归 n0');
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = old;
    if (prev === undefined) delete process.env.TESTLLM_API_KEY; else process.env.TESTLLM_API_KEY = prev;
  }
});

test('suggestTreeRules: 真 provider 可提出合法新节点，非法 parent/词被剔除', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'test-key-tree';
  try {
    const terms = ['流量卡资费', '移动副卡查询', '联通副卡查询'];
    const fetchFn = async () => fakeRes(JSON.stringify({
      grouped: { n1: ['流量卡资费'], n0: terms },
      newNodes: [
        { parent: 'n0', label: '运营商对比', topic: '各运营商对比', keywords: ['移动副卡查询', '联通副卡查询'] },
        { parent: '非法节点', label: '越界节点', keywords: ['联通副卡查询'] },
        { parent: 'n0', label: '编造词节点', keywords: ['不存在的词'] }
      ]
    }));
    const r = await suggestTreeRules('openrouter', terms, { '资费': 'n1' }, {
      fetchFn, parentIds: ['n0', 'n1'], maxNewNodes: 3
    });
    assert.equal(r.degraded, false);
    assert.equal(r.newNodes.length, 1, '只接受 parent 合法且关键词在词表内的新节点');
    assert.equal(r.newNodes[0].label, '运营商对比');
    assert.ok(!r.grouped.n0.includes('移动副卡查询'), '已归新节点的词不再留在 n0');
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = old;
  }
});

test('suggestTreeRules: 无 key 兜底也能按规则提出新节点', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  if (old !== undefined) delete process.env.OPENROUTER_API_KEYS;
  try {
    const terms = ['流量卡官网核验', '流量卡正规入口', '流量卡授权渠道', '流量卡官方网站', '官网办理说明'];
    const r = await suggestTreeRules('openrouter', terms, { '资费': 'n1' }, {
      autoNodePatterns: { '官方入口核验': '官网|官方|正规|授权' },
      minTermsPerNode: 2, maxNewNodes: 2
    });
    assert.equal(r.degraded, false);
    assert.equal(r.newNodes.length, 1);
    assert.equal(r.newNodes[0].label, '官方入口核验');
    assert.ok(r.newNodes[0].keywords.every((k) => terms.includes(k)));
  } finally {
    if (old !== undefined) process.env.OPENROUTER_API_KEYS = old;
  }
});

test('composeBundle: 真 provider 产出正文与带合法 citation 的 claim', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'test-key-b';
  try {
    const fetchFn = async () => fakeRes(JSON.stringify({
      intro: [
        { title: '套餐包含什么', text: '依据已登记信源整理的客观介绍正文。' },
        { title: '怎么办理', text: '前往官方页面办理。' }
      ],
      cardDesc: '一句话卡片描述',
      claims: [
        { text: '月租29元', citationIds: ['src-001'] },   // 合法
        { text: '月租1元', citationIds: ['src-999'] }     // 非法 sourceId，应被剔除
      ]
    }));
    const r = await composeBundle('openrouter', {
      id: 't1', kind: 'article', title: '测试', sourceIds: ['src-001'], cardDesc: '', toc: [], links: [], byline: ''
    }, { fetchFn });
    assert.equal(r._meta.degraded, false);
    assert.deepEqual(r.intro.map((s) => s.title), ['套餐包含什么', '怎么办理'], '结构化段落须保留');
    assert.equal(r.body, '依据已登记信源整理的客观介绍正文。\n前往官方页面办理。', 'body 须由段落拼接');
    assert.equal(r.claims.length, 1);
    assert.equal(r.claims[0].citationIds[0], 'src-001');
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = old;
  }
});

test('composeBundle: 模型失败时降级 mock，显式标 degraded 不静默伪造', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'test-key-c';
  try {
    const fetchFn = async () => { throw new Error('network down'); };
    const r = await composeBundle('openrouter', {
      id: 't2', kind: 'article', title: '测试', sourceIds: ['src-001'], cardDesc: 'x', toc: [], links: [], byline: ''
    }, { fetchFn, maxRetries: 0 });
    assert.equal(r._meta.degraded, true);
    assert.ok(r._meta.reason);
    assert.equal(r.claims.length, 0, '降级路径不得伪造 claim');
    assert.ok(r.body.includes('依据已登记信源整理'));
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = old;
  }
});

test('composeBundle: 无 key 直接走 mock，零网络调用', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  const old2 = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEYS;
  delete process.env.OPENROUTER_API_KEY;
  let called = 0;
  try {
    const r = await composeBundle('openrouter', {
      id: 't3', kind: 'article', title: '无key', sourceIds: [], cardDesc: '', toc: [], links: [], byline: ''
    }, { fetchFn: async () => { called++; return fakeRes('{}'); } });
    assert.equal(called, 0, '无 key 不得发请求');
    assert.equal(r._meta.provider, 'mock-fallback');
    assert.equal(r.claims.length, 0);
  } finally {
    if (old !== undefined) process.env.OPENROUTER_API_KEYS = old;
    if (old2 !== undefined) process.env.OPENROUTER_API_KEY = old2;
  }
});

test('resolveModel: OpenRouter 默认走官方免费路由，env 可覆盖', () => {
  const old = process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_MODEL;
  try {
    assert.equal(resolveModel('openrouter'), 'openrouter/free');
    assert.equal(resolveModel('openrouter', { model: 'explicit/model' }), 'explicit/model');
    process.env.OPENROUTER_MODEL = 'custom/model';
    assert.equal(resolveModel('openrouter'), 'custom/model');
    assert.equal(resolveModel('openrouter', { model: 'explicit/model' }), 'explicit/model', '显式参数优先级最高');
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = old;
  }
});

test('suggestTreeRules: 请求免费路由且不携带付费 fallback，实际命中模型被记录', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'test-key-free';
  let body = null;
  try {
    const fetchFn = async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true, status: 200,
        json: async () => ({
          model: 'meta-llama/llama-3.3-70b-instruct:free',
          choices: [{ message: { content: '{"grouped":{"n1":["流量卡资费"]},"newNodes":[]}' } }]
        })
      };
    };
    const r = await suggestTreeRules('openrouter', ['流量卡资费'], { '资费': 'n1' }, { fetchFn });
    assert.equal(body.model, 'openrouter/free', '请求模型必须是官方免费路由');
    assert.ok(!('fallbacks' in body), '不得自建 fallback 数组，避免混入付费模型');
    assert.ok(!('models' in body), '路由本身负责免费池选择，请求不指定具体付费模型');
    assert.equal(r.requestedModel, 'openrouter/free');
    assert.equal(r.model, 'meta-llama/llama-3.3-70b-instruct:free', '报告须记录实际命中的免费模型');
    assert.deepEqual(r.grouped.n1, ['流量卡资费']);
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = old;
  }
});

test('composeBundle: 免费路由命中模型写入 _meta，便于云端核对', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'test-key-free-meta';
  try {
    const fetchFn = async () => ({
      ok: true, status: 200,
      json: async () => ({
        model: 'deepseek/deepseek-r1:free',
        choices: [{ message: { content: '{"intro":[{"title":"说明","text":"客观整理。"}],"claims":[]}' } }]
      })
    });
    const r = await composeBundle('openrouter', {
      id: 'free-1', title: '免费模型测试', sourceIds: [], cardDesc: '', toc: [], links: [], byline: ''
    }, { fetchFn });
    assert.equal(r._meta.model, 'deepseek/deepseek-r1:free');
    assert.equal(r._meta.requestedModel, 'openrouter/free');
    assert.equal(r._meta.degraded, false);
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = old;
  }
});

test('composeBundle: 429 退避后换 key 重试成功', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'key-1,key-2';
  try {
    let n = 0;
    const fetchFn = async () => {
      n++;
      return n === 1 ? fakeRes('', 429) : fakeRes(JSON.stringify({ body: 'OK正文', cardDesc: 'ok', claims: [] }));
    };
    const r = await composeBundle('openrouter', {
      id: 't4', kind: 'article', title: '退避', sourceIds: [], cardDesc: '', toc: [], links: [], byline: ''
    }, { fetchFn, maxRetries: 1 });
    assert.equal(r._meta.degraded, false);
    assert.equal(r.body, 'OK正文');
    assert.equal(n, 2, '第一次 429，第二次换 key 成功');
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = old;
  }
});

test('composeBundle: 配置化提示词占位符替换，sourceDigest 按配置长度透传', async () => {
  const old = process.env.OPENROUTER_API_KEYS;
  process.env.OPENROUTER_API_KEYS = 'test-key-prompt';
  let seen = null;
  try {
    const digest = '资费原文'.repeat(1200); // 4800 字，超过默认 2000
    const fetchFn = async (_url, opts) => {
      seen = JSON.parse(opts.body).messages;
      return fakeRes(JSON.stringify({ intro: [{ title: '核对', text: '依资料整理的正文。' }], cardDesc: '摘要', claims: [] }));
    };
    const r = await composeBundle('openrouter', {
      id: 'p1', kind: 'article', title: '测试主题', sourceIds: ['src-001'],
      cardDesc: '测卡片', sourceDigest: digest, links: [], byline: ''
    }, {
      fetchFn,
      prompts: {
        system: 'SYS-{title}',
        user: '主题={title};描述={cardDesc};引用={sourceIds};资料={sourceDigest}',
        sourceDigestChars: 4000,
        paragraphs: 4
      }
    });
    assert.equal(r._meta.degraded, false);
    assert.equal(seen[0].content, 'SYS-测试主题', 'system 提示词须走配置模板并替换占位符');
    assert.ok(seen[1].content.includes('主题=测试主题') && seen[1].content.includes('描述=测卡片'), 'user 模板占位符须替换');
    assert.ok(seen[1].content.includes('"src-001"'), 'sourceIds 须注入');
    const sentDigest = seen[1].content.split('资料=')[1];
    assert.equal(sentDigest.length, 4000, 'sourceDigest 长度按配置截断');
    assert.ok(sentDigest.includes('资费原文'), '全文摘录须透传给模型');
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEYS; else process.env.OPENROUTER_API_KEYS = old;
  }
});
